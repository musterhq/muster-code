/**
 * The connector registry: many instances per type (two Slack workspaces, five Telegram bots …), each with a name, owner, scope,
 * secret references into the server secret store, live health and first-match routing to a project and agent.
 *
 * Inbound flow: adapter → refusal checks (guest policy, identity link, route, project access) → chat or task in Muster →
 * wait for the turn → reply posted back to the same conversation/thread. Every step is recorded in connector_events and the turn is
 * attributed in the audit chain, so it shows in the Ledger and in cost per person.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AuditLog } from '../audit.ts';
import type { ServerSecrets } from '../secret-box.ts';
import { ROLE_RANK } from '../policy.ts';
import type { ConnectorHealthRecord, ConnectorRecord, ConnectorScope, ConnectorState, RouteAction, RouteMatch, RoutingRuleRecord, ServerStore, UserRecord } from '../store/types.ts';
import { newId } from '../auth/tokens.ts';
import { connectorType, CONNECTOR_TYPES } from './catalog.ts';
import { route } from './router.ts';
import type { AdapterContext, ConnectorAdapter, InboundMessage, WebhookRequest, WebhookResponse } from './types.ts';

export interface TurnRunner {
  /** Starts (or continues) a chat turn in the project. `chatId` continues an existing thread's chat. */
  reply(input: { projectId: string; agentId?: string | null; chatId: string | null; text: string; actor: string; provider?: string; model?: string }): Promise<{ chatId: string; runId: string }>;
  /** Creates a project task from the message and starts it. */
  task(input: { projectId: string; agentId?: string | null; title: string; text: string; actor: string; provider?: string; model?: string }): Promise<{ chatId: string; runId: string; taskId: string }>;
  /** Resolves with the assistant's final text once the run settles. */
  wait(chatId: string, timeoutMs: number): Promise<{ ok: boolean; text: string; error?: string }>;
  projectExists(projectId: string): Promise<boolean>;
  /** The project a chat belongs to (null when it has none or is gone). */
  chatProject(chatId: string): Promise<string | null>;
}
export interface ConnectorView extends Omit<ConnectorRecord, 'secretRefs'> { secrets: Record<string, boolean>; health: ConnectorHealthRecord | null; rules: RoutingRuleRecord[]; label: string; available: boolean; note?: string; webhookPath: string | null }

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
const nowIso = () => new Date().toISOString();

export class ConnectorRegistry {
  private adapters = new Map<string, ConnectorAdapter>();
  private healthState = new Map<string, ConnectorHealthRecord>();
  private lanes = new Map<string, Promise<unknown>>();
  private stopped = false;
  replyTimeoutMs = 10 * 60_000;
  constructor(private readonly deps: { store: ServerStore; secrets: ServerSecrets; audit: AuditLog; runner: TurnRunner | null; publicUrl: () => string | null; log: (line: string) => void }) {}

  // ---------------------------------------------------------------- CRUD
  async add(actor: UserRecord, input: { type: string; name: string; mode?: string; scope?: ConnectorScope; projectId?: string | null; config?: Record<string, unknown>; secrets?: Record<string, string>; enabled?: boolean }): Promise<ConnectorView> {
    const type = connectorType(input.type);
    if (!type) throw new Error(`Unknown connector type "${input.type}". Known: ${Object.keys(CONNECTOR_TYPES).join(', ')}.`);
    if (!NAME.test(input.name ?? '')) throw new Error('Connector names are 1 to 63 letters, digits, dots, dashes or underscores.');
    if (await this.deps.store.connectorByName(input.name)) throw new Error(`A connector named "${input.name}" already exists.`);
    const mode = input.mode ?? type.modes[0]!;
    if (!type.modes.includes(mode)) throw new Error(`${type.label} supports mode ${type.modes.join(' or ')}.`);
    const scope = input.scope ?? 'org';
    if (!['org', 'project', 'user'].includes(scope)) throw new Error('Scope must be org, project or user.');
    if (scope === 'org' && ROLE_RANK[actor.role] < ROLE_RANK.admin) throw new Error('Only owners and admins can add org-wide connectors.');
    if (scope === 'project' && !input.projectId) throw new Error('A project-scoped connector needs --project.');
    const config = this.cleanConfig(type.configKeys, input.config ?? {});
    if (scope === 'project') await this.assertProjectAccess(actor, input.projectId!);
    if (typeof config.notifyProject === 'string') await this.assertProjectAccess(actor, config.notifyProject);
    const id = newId();
    const secretRefs: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.secrets ?? {})) {
      if (!value) continue;
      secretRefs[name] = await this.deps.secrets.put(`connector:${id}:${name}`, value);
    }
    const missing = type.status === 'available' ? type.secrets(mode).filter(s => !secretRefs[s] && !(s === 'webhookSecret')) : [];
    const at = nowIso();
    const record: ConnectorRecord = { id, type: type.type, name: input.name, ownerUserId: actor.id, scope, projectId: input.projectId ?? null, enabled: input.enabled ?? true,
      mode, secretRefs, config, webhookPublicId: randomBytes(12).toString('base64url'), createdAt: at, updatedAt: at };
    await this.deps.store.createConnector(record);
    await this.deps.audit.append({ actor: `user:${actor.id}`, action: 'connector.added', target: `connector:${id}`, detail: { type: type.type, name: input.name, scope, mode, secrets: Object.keys(secretRefs) } });
    if (missing.length) await this.setHealth(id, 'unauth', `Missing secret${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
    else if (record.enabled) await this.startOne(record);
    return this.view(record);
  }
  private cleanConfig(keys: readonly string[], raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!keys.includes(k)) throw new Error(`Unknown config key "${k}". Known: ${keys.join(', ')}.`);
      if (/token|secret|password/i.test(k)) throw new Error(`"${k}" looks like a secret; pass it with --secret so it is encrypted.`);
      out[k] = v;
    }
    if (out.url !== undefined && !/^https?:\/\//.test(String(out.url))) throw new Error('url must start with http:// or https://');
    if (out.apiBase !== undefined && !/^https?:\/\//.test(String(out.apiBase))) throw new Error('apiBase must start with http:// or https://');
    if (out.guestPolicy !== undefined && !['refuse', 'allow'].includes(String(out.guestPolicy))) throw new Error('guestPolicy must be refuse or allow.');
    if (out.defaultMode !== undefined && !['reply', 'task'].includes(String(out.defaultMode))) throw new Error('defaultMode must be reply or task.');
    return out;
  }
  async find(idOrName: string): Promise<ConnectorRecord> {
    const c = (await this.deps.store.connector(idOrName)) ?? (await this.deps.store.connectorByName(idOrName));
    if (!c) throw new Error(`No connector "${idOrName}".`);
    return c;
  }
  async remove(actor: UserRecord, idOrName: string): Promise<void> {
    const c = await this.find(idOrName);
    this.assertManage(actor, c);
    await this.stopOne(c.id);
    for (const ref of Object.values(c.secretRefs)) await this.deps.secrets.delete(ref);
    await this.deps.store.deleteConnector(c.id);
    this.healthState.delete(c.id);
    await this.deps.audit.append({ actor: `user:${actor.id}`, action: 'connector.removed', target: `connector:${c.id}`, detail: { name: c.name, type: c.type } });
  }
  async setEnabled(actor: UserRecord, idOrName: string, enabled: boolean): Promise<ConnectorView> {
    const c = await this.find(idOrName);
    this.assertManage(actor, c);
    await this.deps.store.updateConnector(c.id, { enabled });
    await this.deps.audit.append({ actor: `user:${actor.id}`, action: enabled ? 'connector.enabled' : 'connector.disabled', target: `connector:${c.id}` });
    const next = (await this.deps.store.connector(c.id))!;
    if (enabled) await this.startOne(next); else { await this.stopOne(c.id); await this.setHealth(c.id, 'disabled', null); }
    return this.view(next);
  }
  async setSecret(actor: UserRecord, idOrName: string, name: string, value: string): Promise<void> {
    const c = await this.find(idOrName);
    this.assertManage(actor, c);
    const ref = await this.deps.secrets.put(`connector:${c.id}:${name}`, value);
    await this.deps.store.updateConnector(c.id, { secretRefs: { ...c.secretRefs, [name]: ref } });
    await this.deps.audit.append({ actor: `user:${actor.id}`, action: 'connector.secret.set', target: `connector:${c.id}`, detail: { name } });
    if (c.enabled) { await this.stopOne(c.id); await this.startOne((await this.deps.store.connector(c.id))!); }
  }
  /** A connector posts about a project into a channel anyone there can read, so saving that project needs the saver's own access to it. */
  private async assertProjectAccess(actor: UserRecord, projectId: string): Promise<void> {
    if (ROLE_RANK[actor.role] >= ROLE_RANK.admin) return;
    if ((await this.deps.store.projectAccessFor(actor.id)).some(a => a.projectId === projectId)) return;
    throw new Error('You do not have access to that project.');
  }
  private assertManage(actor: UserRecord, c: ConnectorRecord) {
    if (ROLE_RANK[actor.role] >= ROLE_RANK.admin || (c.scope !== 'org' && c.ownerUserId === actor.id)) return;
    throw new Error('Only the connector owner or an admin can change it.');
  }
  async addRule(actor: UserRecord, idOrName: string, input: { match: RouteMatch; action: RouteAction; priority?: number }): Promise<RoutingRuleRecord> {
    const c = await this.find(idOrName);
    this.assertManage(actor, c);
    if (!input.action?.projectId) throw new Error('A route needs --project.');
    if (this.deps.runner && !(await this.deps.runner.projectExists(input.action.projectId))) throw new Error(`No project "${input.action.projectId}".`);
    if (input.action.mode !== 'reply' && input.action.mode !== 'task') throw new Error('Route mode must be reply or task.');
    const rule: RoutingRuleRecord = { id: newId(), connectorId: c.id, priority: input.priority ?? ((await this.deps.store.rules(c.id)).length + 1) * 10, match: input.match, action: input.action, createdAt: nowIso() };
    await this.deps.store.addRule(rule);
    await this.deps.audit.append({ actor: `user:${actor.id}`, action: 'connector.route.added', target: `connector:${c.id}`, detail: { ruleId: rule.id, match: rule.match, action: rule.action } });
    return rule;
  }
  async removeRule(actor: UserRecord, ruleId: string): Promise<void> {
    for (const c of await this.deps.store.listConnectors()) if ((await this.deps.store.rules(c.id)).some(r => r.id === ruleId)) {
      this.assertManage(actor, c);
      await this.deps.store.removeRule(ruleId);
      await this.deps.audit.append({ actor: `user:${actor.id}`, action: 'connector.route.removed', target: `connector:${c.id}`, detail: { ruleId } });
      return;
    }
    throw new Error(`No route ${ruleId}.`);
  }
  async link(actor: UserRecord, idOrName: string, externalId: string, userId: string): Promise<void> {
    const c = await this.find(idOrName);
    this.assertManage(actor, c);
    const user = (await this.deps.store.userById(userId)) ?? (await this.deps.store.userByName(userId));
    if (!user) throw new Error(`No user "${userId}".`);
    await this.deps.store.link({ connectorId: c.id, externalId, userId: user.id, verifiedBy: 'admin', createdAt: nowIso() });
    await this.deps.audit.append({ actor: `user:${actor.id}`, action: 'connector.identity.linked', target: `connector:${c.id}`, detail: { externalId, userId: user.id } });
  }

  /** One-way post to the connector's notify channel (G27). Recorded like every other outbound message. */
  async notify(idOrName: string, text: string, key: string | null = null): Promise<void> {
    const c = await this.find(idOrName), channel = typeof c.config.notifyChannel === 'string' ? c.config.notifyChannel : '';
    if (!channel) throw new Error(`${c.name} has no notify channel. Set one first.`);
    const adapter = this.adapters.get(c.id); if (!adapter) throw new Error(`${c.name} is not running.`);
    await adapter.send({ conversation: { kind: 'channel', id: channel }, text });
    await this.deps.store.addConnectorEvent({ id: newId(), connectorId: c.id, ts: nowIso(), direction: 'out', externalId: null, conversation: channel, chatId: null, runId: null, status: 'notified', detail: key });
  }
  async setConfig(actor: UserRecord, idOrName: string, config: Record<string, unknown>): Promise<ConnectorView> {
    const c = await this.find(idOrName); this.assertManage(actor, c);
    const type = connectorType(c.type)!, clean = this.cleanConfig(type.configKeys, config), next = { ...c.config, ...clean };
    if (typeof clean.notifyProject === 'string' && clean.notifyProject !== c.config.notifyProject) await this.assertProjectAccess(actor, clean.notifyProject);
    for (const k of Object.keys(next)) if (next[k] === null || next[k] === '') delete next[k];
    await this.deps.store.updateConnector(c.id, { config: next });
    await this.deps.audit.append({ actor: `user:${actor.id}`, action: 'connector.config.changed', target: `connector:${c.id}`, detail: { keys: Object.keys(config) } });
    return this.view((await this.deps.store.connector(c.id))!);
  }
  async list(): Promise<ConnectorView[]> { return Promise.all((await this.deps.store.listConnectors()).map(c => this.view(c))); }
  async view(c: ConnectorRecord): Promise<ConnectorView> {
    const type = connectorType(c.type);
    const { secretRefs, ...rest } = c;
    const needed = type?.secrets(c.mode) ?? [];
    return { ...rest, label: type?.label ?? c.type, available: type?.status === 'available', ...(type?.note ? { note: type.note } : {}),
      secrets: Object.fromEntries([...new Set([...needed, ...Object.keys(secretRefs)])].map(s => [s, Boolean(secretRefs[s])])),
      health: this.healthState.get(c.id) ?? await this.deps.store.health(c.id), rules: await this.deps.store.rules(c.id),
      webhookPath: c.mode === 'webhook' || c.mode === 'events' ? `/hooks/${c.type}/${c.webhookPublicId}` : null };
  }

  async test(idOrName: string): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const c = await this.find(idOrName);
    const type = connectorType(c.type);
    if (!type?.create) return { ok: false, detail: type?.note ?? 'Not supported yet.', latencyMs: 0 };
    const adapter = this.adapters.get(c.id) ?? type.create(this.context(c));
    const result = await adapter.test();
    // A passing probe does not mark a down socket healthy; it only records latency. A failing one is surfaced.
    const current = this.healthState.get(c.id)?.state;
    await this.setHealth(c.id, !result.ok ? 'unauth' : current && current !== 'unauth' ? current : c.enabled ? 'ok' : 'disabled', result.ok ? null : result.detail, { latencyMs: result.latencyMs });
    return result;
  }

  // ---------------------------------------------------------------- lifecycle
  async startAll(): Promise<void> {
    for (const c of await this.deps.store.listConnectors()) {
      if (!c.enabled) { await this.setHealth(c.id, 'disabled', null); continue; }
      await this.startOne(c).catch(error => this.deps.log(`connector ${c.name} failed to start: ${(error as Error).message}`));
    }
  }
  private async startOne(c: ConnectorRecord): Promise<void> {
    const type = connectorType(c.type);
    if (!type?.create) { await this.setHealth(c.id, 'unsupported', type?.note ?? `Unknown type ${c.type}.`); return; }
    await this.stopOne(c.id);
    const adapter = type.create(this.context(c));
    this.adapters.set(c.id, adapter);
    await adapter.start();
  }
  private async stopOne(id: string) { const a = this.adapters.get(id); this.adapters.delete(id); await a?.stop().catch(() => undefined); }
  async stopAll(): Promise<void> { this.stopped = true; await Promise.all([...this.adapters.keys()].map(id => this.stopOne(id))); }

  private context(c: ConnectorRecord): AdapterContext {
    return {
      connector: c, publicUrl: this.deps.publicUrl(),
      secret: async name => { const ref = c.secretRefs[name]; return ref ? this.deps.secrets.get(ref) : null; },
      onMessage: message => { void this.inbound(c.id, message); },
      health: (state, error, extra) => { void this.setHealth(c.id, state, error ?? null, extra); },
      log: line => this.deps.log(`[${c.type}:${c.name}] ${line}`),
    };
  }
  async setHealth(id: string, state: ConnectorState, error: string | null, extra: { latencyMs?: number; reconnect?: boolean; event?: boolean } = {}): Promise<void> {
    const prev = this.healthState.get(id) ?? await this.deps.store.health(id);
    const at = nowIso();
    const next: ConnectorHealthRecord = { connectorId: id, state, lastEventAt: extra.event ? at : prev?.lastEventAt ?? null, lastError: state === 'ok' ? prev?.lastError ?? null : error,
      latencyMs: extra.latencyMs ?? prev?.latencyMs ?? null, reconnects: (prev?.reconnects ?? 0) + (extra.reconnect ? 1 : 0), checkedAt: at };
    this.healthState.set(id, next);
    // Persist state changes, not every heartbeat.
    if (!prev || prev.state !== state || extra.reconnect || (extra.event && (!prev.lastEventAt || Date.parse(at) - Date.parse(prev.lastEventAt) > 60_000))) {
      if (await this.deps.store.connector(id)) await this.deps.store.setHealth(next);
      if (prev?.state !== state) this.deps.log(`connector ${id} ${prev?.state ?? 'new'} → ${state}${error ? `: ${error}` : ''}`);
    }
  }

  async webhook(type: string, publicId: string, request: WebhookRequest): Promise<WebhookResponse> {
    const c = await this.deps.store.connectorByWebhook(publicId);
    if (!c || c.type !== type || !c.enabled) return { status: 404, body: 'not found' };
    const adapter = this.adapters.get(c.id);
    if (!adapter?.webhook) return { status: 409, body: 'connector is not in webhook mode' };
    return adapter.webhook(request);
  }

  // ---------------------------------------------------------------- inbound
  private async event(c: string, direction: 'in' | 'out' | 'refusal' | 'error', m: InboundMessage | null, status: string, detail: string | null, chatId: string | null = null, runId: string | null = null) {
    await this.deps.store.addConnectorEvent({ id: newId(), connectorId: c, ts: nowIso(), direction, externalId: m?.externalUserId ?? null, conversation: m ? `${m.conversation.id}${m.conversation.threadId ? `/${m.conversation.threadId}` : ''}` : null, chatId, runId, status, detail: detail?.slice(0, 500) ?? null });
  }
  private async refuse(c: ConnectorRecord, m: InboundMessage, reason: string, text: string) {
    await this.event(c.id, 'refusal', m, reason, text);
    await this.deps.audit.append({ actor: `connector:${c.id}`, action: 'connector.refused', target: `connector:${c.id}`, detail: { reason, externalId: m.externalUserId } });
    try { await this.adapters.get(c.id)?.send({ conversation: m.conversation, text }); }
    catch (error) { await this.event(c.id, 'error', m, 'refusal-send-failed', (error as Error).message); }
  }

  /** Messages from one conversation run in order; different conversations run in parallel. */
  inbound(connectorId: string, m: InboundMessage): Promise<void> {
    const key = `${connectorId}|${m.conversation.id}|${m.conversation.threadId ?? ''}`;
    const run = (this.lanes.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.handle(connectorId, m));
    this.lanes.set(key, run);
    void run.finally(() => { if (this.lanes.get(key) === run) this.lanes.delete(key); });
    return run.catch(error => this.deps.log(`connector ${connectorId} inbound failed: ${(error as Error).message}`));
  }

  private async handle(connectorId: string, m: InboundMessage): Promise<void> {
    if (this.stopped) return;
    const c = await this.deps.store.connector(connectorId);
    if (!c) return;
    await this.event(c.id, 'in', m, 'received', null);
    // Channels: only messages addressed to the bot (mention or reply in its thread), so the bot is not a firehose.
    const existing = await this.deps.store.thread(c.id, conversationKey(m));
    if (m.conversation.kind !== 'dm' && !m.mentioned && !existing) { await this.event(c.id, 'in', m, 'ignored-no-mention', null); return; }
    if (m.guest && c.config.guestPolicy !== 'allow') {
      return this.refuse(c, m, 'guest', `Sorry ${m.userName}, Muster does not take requests from guest accounts in this workspace. Ask a team member to raise it.`);
    }
    const link = await this.deps.store.linkFor(c.id, m.externalUserId);
    const user = link ? await this.deps.store.userById(link.userId) : null;
    if (link && (!user || user.status !== 'active')) return this.refuse(c, m, 'revoked-user', 'Your Muster access was revoked, so this request was not run.');
    if (!link && c.config.requireLink === true) {
      return this.refuse(c, m, 'unlinked', `This connector only answers linked Muster accounts. An admin can link you with: muster-server connectors link ${c.name} ${m.externalUserId} <username>`);
    }
    const rules = await this.deps.store.rules(c.id);
    const threadProject = existing && this.deps.runner ? await this.deps.runner.chatProject(existing.chatId) : null;
    const routed = existing && threadProject ? { action: { projectId: threadProject, mode: existing.taskId ? 'task' as const : 'reply' as const }, ruleId: null } : route(c, rules, m);
    if (!routed?.action.projectId) return this.refuse(c, m, 'no-route', `No Muster project is routed for ${m.conversation.kind === 'dm' ? 'direct messages' : m.conversation.name ?? 'this channel'} on "${c.name}". An admin can add one with: muster-server connectors route ${c.name} --match "channel=${m.conversation.name ?? m.conversation.id}" --project <project>`);
    if (user && ROLE_RANK[user.role] < ROLE_RANK.member) return this.refuse(c, m, 'viewer', `Your Muster role (${user.role}) is read-only, so this request was not run.`);
    if (user && ROLE_RANK[user.role] < ROLE_RANK.admin) {
      const grants = await this.deps.store.projectAccessFor(user.id);
      const g = grants.find(x => x.projectId === routed.action.projectId);
      if (!g || g.role === 'viewer') return this.refuse(c, m, 'no-project-access', 'You do not have write access to the Muster project this channel is routed to.');
    }
    if (!this.deps.runner) return this.refuse(c, m, 'runtime-unavailable', 'Muster Server is not running its agent runtime right now.');
    const actor = user ? user.id : `connector:${c.id}`;
    const text = framed(c, m, user);
    try {
      let chatId: string, runId: string, taskId: string | null = existing?.taskId ?? null;
      const provider = typeof c.config.provider === 'string' ? c.config.provider : undefined, model = typeof c.config.model === 'string' ? c.config.model : undefined;
      if (!existing && routed.action.mode === 'task') {
        const r = await this.deps.runner.task({ projectId: routed.action.projectId, agentId: routed.action.agentId, title: m.text.split('\n')[0]!.slice(0, 120) || 'Request from chat', text, actor, provider, model });
        ({ chatId, runId } = r); taskId = r.taskId;
      } else {
        ({ chatId, runId } = await this.deps.runner.reply({ projectId: routed.action.projectId, agentId: routed.action.agentId, chatId: existing?.chatId ?? null, text, actor, provider, model }));
      }
      if (!existing) await this.deps.store.setThread({ connectorId: c.id, conversationKey: conversationKey(m), chatId, taskId, createdAt: nowIso() });
      await this.event(c.id, 'in', m, 'routed', routed.ruleId ? `rule ${routed.ruleId}` : 'default route', chatId, runId);
      const result = await this.deps.runner.wait(chatId, this.replyTimeoutMs);
      const reply = result.ok ? (result.text || '(The agent finished without a text reply.)') : `The agent could not finish this request: ${result.error ?? 'unknown error'}`;
      await this.adapters.get(c.id)?.send({ conversation: m.conversation, text: reply });
      await this.event(c.id, 'out', m, result.ok ? 'replied' : 'replied-failure', null, chatId, runId);
    } catch (error) {
      const message = (error as Error).message;
      await this.event(c.id, 'error', m, 'failed', message);
      try { await this.adapters.get(c.id)?.send({ conversation: m.conversation, text: `Muster could not run this request: ${message}` }); } catch { /* recorded above */ }
    }
  }
  // ---------------------------------------------------------------- import
  /** Imports a Muster CLI `.muster/gateway.json`. Each configured channel becomes one connector named default-<type> (suffix -2… when taken). */
  async importGateway(actor: UserRecord, file: string, options: { dryRun?: boolean } = {}): Promise<Array<{ type: string; name: string; status: 'imported' | 'coming-soon' | 'skipped'; detail: string }>> {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown> | undefined>;
    const out: Array<{ type: string; name: string; status: 'imported' | 'coming-soon' | 'skipped'; detail: string }> = [];
    const plan: Array<{ type: string; mode?: string; secrets: Record<string, string>; config?: Record<string, unknown> }> = [];
    const str = (v: unknown) => typeof v === 'string' && v ? v : undefined;
    const pick = (o: Record<string, unknown>, map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([from, to]) => [to, str(o[from])]).filter(([, v]) => v)) as Record<string, string>;
    if (raw.telegram) plan.push({ type: 'telegram', mode: str(raw.telegram.secretToken) ? 'webhook' : 'poll', secrets: pick(raw.telegram, { botToken: 'botToken', secretToken: 'webhookSecret' }) });
    if (raw.slack) plan.push({ type: 'slack', mode: raw.slack.mode === 'http' ? 'events' : 'socket', secrets: pick(raw.slack, { botToken: 'botToken', appToken: 'appToken', signingSecret: 'signingSecret' }) });
    if (raw.discord) plan.push({ type: 'discord', secrets: pick(raw.discord, { botToken: 'botToken', publicKey: 'publicKey' }) });
    if (raw['whatsapp-cloud']) plan.push({ type: 'whatsapp', secrets: pick(raw['whatsapp-cloud'], { accessToken: 'accessToken', verifyToken: 'verifyToken', appSecret: 'appSecret' }), config: {} });
    else if (raw.whatsapp) plan.push({ type: 'whatsapp', secrets: {} });
    if (raw.gchat) plan.push({ type: 'gchat', secrets: pick(raw.gchat, { verificationToken: 'verificationToken' }) });
    if (raw.teams) plan.push({ type: 'teams', secrets: pick(raw.teams, { hmacSecret: 'hmacSecret' }) });
    for (const p of plan) {
      let name = `default-${p.type}`, n = 2;
      while (await this.deps.store.connectorByName(name)) name = `default-${p.type}-${n++}`;
      const type = connectorType(p.type)!;
      if (options.dryRun) { out.push({ type: p.type, name, status: type.status === 'available' ? 'imported' : 'coming-soon', detail: `dry run; secrets: ${Object.keys(p.secrets).join(', ') || 'none'}` }); continue; }
      const view = await this.add(actor, { type: p.type, name, mode: type.modes.includes(p.mode ?? '') ? p.mode : undefined, secrets: p.secrets, config: p.config ?? {} });
      out.push({ type: p.type, name, status: type.status === 'available' ? 'imported' : 'coming-soon', detail: type.status === 'available' ? `mode ${view.mode}; add a route with: muster-server connectors route ${name} --project <project>` : type.note ?? '' });
    }
    if (!plan.length) out.push({ type: '-', name: '-', status: 'skipped', detail: 'No channels configured in that gateway.json.' });
    await this.deps.audit.append({ actor: `user:${actor.id}`, action: 'connector.gateway.imported', target: null, detail: { count: plan.length, dryRun: Boolean(options.dryRun) } });
    return out;
  }
}

export const conversationKey = (m: InboundMessage) => `${m.conversation.id}:${m.conversation.threadId ?? ''}`;

/** What the agent sees: the request plus who is asking and who will read the reply. */
export function framed(c: ConnectorRecord, m: InboundMessage, user: UserRecord | null): string {
  const where = m.conversation.kind === 'dm' ? `a direct message on ${c.type}` : `${m.conversation.name ?? m.conversation.id} on ${c.type}`;
  const audience = m.conversation.kind === 'dm' ? 'Only the sender reads the reply.'
    : `Everyone in this ${m.conversation.kind} reads the reply${m.audience?.members ? ` (${m.audience.members} members${m.audience.guests ? `, including ${m.audience.guests} guest${m.audience.guests === 1 ? '' : 's'}` : ''})` : ''}; do not include anything only the sender should see.`;
  const who = user ? `${m.userName} (Muster user @${user.username})` : `${m.userName} (not linked to a Muster account)`;
  return `[Request from ${who} via ${where} (connector "${c.name}"). ${audience}]\n\n${m.text}`;
}
