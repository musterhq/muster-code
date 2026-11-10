/**
 * Delegation domain (#44): an agent starts a child chat on any provider and model the user has set up, and controls it.
 *
 * - Tools: the `muster_delegation` MCP server (delegate_task, message_task, wait_task, read_task, interrupt_task,
 *   list_tasks), offered to agent chats with more than read-only access. The chat id in each call is the caller,
 *   bound to its run by the host's per-chat token (governance/tool-host.ts), so one chat cannot act as another.
 * - A child is a real Muster chat. `delegated_tasks` links it to its parent, so the link survives a restart. Only the
 *   parent or one of its ancestors may control a child. Depth and per-parent concurrency are bounded, and a child's access
 *   is the parent's effective access, never more. Its model must be one a configured provider offers: no new credentials.
 * - Waking: when a child's turn completes or fails and its parent is not blocked on it (delegate_task wait or wait_task),
 *   the report goes to the parent through its queue: an idle parent starts a turn at once, a busy one after its turn.
 *   Reading the result first (read_task, wait_task) withdraws a report that is still queued.
 * - Approvals and questions a child opens are copied onto its parent and every ancestor (`data.delegated` names the
 *   child's card); answering any copy answers the child's card, and closing the child's card closes every copy.
 */
import { randomUUID } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';
import type { Chat, ChatStatus, Folder, ProviderInfo, TimelineItem } from '../../shared/protocol.ts';
import {
  DELEGATION_DEFAULT_WAIT_MS, DELEGATION_MAX_ACTIVE, DELEGATION_MAX_DEPTH, DELEGATION_MAX_WAIT_MS,
  type DelegatedAttention, type DelegatedFromNotice, type DelegationReportData, type DelegatedTask, type DelegatedTaskNotice,
} from '../../shared/domains/delegation-protocol.ts';
import { ToolHost, toolText, type ToolSpec } from '../governance/tool-host.ts';
import type { McpToolResult } from '../sandbox-registry.ts';
import { effectiveAccess } from './automations.ts';
import type { DomainContext, DomainModule } from './types.ts';

export const DELEGATION_MCP = 'muster_delegation';
/** The provider's own wait for one tool call: the longest wait plus a margin, so a bounded wait answers before it. */
export const DELEGATION_TOOL_TIMEOUT_MS = DELEGATION_MAX_WAIT_MS + 60_000;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_PROMPT = 32_768, MAX_REPLY = 6_000;
/** Kept terse: every schema rides in each agent turn. */
export const DELEGATION_TOOL_SPECS: readonly ToolSpec[] = [
  { name: 'delegate_task', description: 'Start a child chat (any configured provider/model; default yours) on a task in your folder. Returns its id; wait=true blocks until it finishes and returns its reply. Otherwise Muster sends you its result when it finishes.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, folder: { type: 'string', description: 'Folder name, path or id you can access' }, title: { type: 'string' }, wait: { type: 'boolean' }, timeout_seconds: { type: 'number' } }, required: ['prompt'] } },
  { name: 'message_task', description: 'Send a child more work; steers it if it is working.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
  { name: 'wait_task', description: 'Wait for a child to finish (bounded) and return its reply.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, timeout_seconds: { type: 'number' } }, required: ['id'] } },
  { name: 'read_task', description: 'A child\'s status, last replies and changed files.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, last: { type: 'number', description: 'Replies to return (1-5)' } }, required: ['id'] } },
  { name: 'interrupt_task', description: 'Stop a child (and the chats it started).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_tasks', description: 'The child chats you started, with their status.', inputSchema: { type: 'object', properties: {} } },
];

interface Row { child_chat_id: string; parent_chat_id: string; root_chat_id: string; depth: number; title: string; provider_id: string | null; model: string; created_at: string; settles: number; reported: number; last_status: string | null; finished_at: string | null; report_queue_id: string | null }
const BUSY: ReadonlySet<ChatStatus> = new Set<ChatStatus>(['running', 'stopping', 'waiting', 'queued', 'reconnecting']);
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const str = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0') ? value.trim() : undefined;

export interface DelegationDeps { /** false: no MCP host (bare tests that call runTool directly). */ toolHost?: false }

export function createDelegation(ctx: DomainContext, deps: DelegationDeps = {}) {
  const db = ctx.db();
  db.exec(`CREATE TABLE IF NOT EXISTS delegated_tasks (
    child_chat_id TEXT PRIMARY KEY, parent_chat_id TEXT NOT NULL, root_chat_id TEXT NOT NULL, depth INTEGER NOT NULL,
    title TEXT NOT NULL, provider_id TEXT, model TEXT NOT NULL, created_at TEXT NOT NULL,
    settles INTEGER NOT NULL DEFAULT 0, reported INTEGER NOT NULL DEFAULT 0, last_status TEXT, finished_at TEXT, report_queue_id TEXT);
  CREATE INDEX IF NOT EXISTS delegated_tasks_parent ON delegated_tasks(parent_chat_id, created_at);
  CREATE TABLE IF NOT EXISTS delegated_attention (source_item_id TEXT NOT NULL, mirror_item_id TEXT NOT NULL PRIMARY KEY, chat_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS delegated_attention_source ON delegated_attention(source_item_id);`);

  const row = (childId: string) => db.prepare('SELECT * FROM delegated_tasks WHERE child_chat_id = ?').get(childId) as Row | undefined;
  const childrenOf = (parentId: string) => db.prepare('SELECT * FROM delegated_tasks WHERE parent_chat_id = ? ORDER BY created_at, rowid').all(parentId) as unknown as Row[];
  /** The chats above `chatId`, nearest first (bounded by the depth limit). */
  function ancestors(chatId: string): string[] {
    const out: string[] = [];
    for (let at = row(chatId); at && out.length <= DELEGATION_MAX_DEPTH; at = row(at.parent_chat_id)) out.push(at.parent_chat_id);
    return out;
  }
  const depthOf = (chatId: string) => row(chatId)?.depth ?? 0;
  /** Every chat below `chatId`, breadth first. */
  function descendants(chatId: string): Row[] {
    const out: Row[] = [];
    for (let level = childrenOf(chatId), guard = 0; level.length && guard <= DELEGATION_MAX_DEPTH; guard++) { out.push(...level); level = level.flatMap(entry => childrenOf(entry.child_chat_id)); }
    return out;
  }
  const busy = (chat: Chat | undefined) => !!chat && (BUSY.has(chat.status) || ctx.store.queue(chat.id).length > 0);
  const offered = (chat: Chat) => !chat.archived && chat.mode === 'agent' && effectiveAccess(chat) !== 'read-only';
  const label = (chat: Chat | undefined) => clip(oneLine(chat?.title || 'Untitled chat'), 80);
  const providers = (): ProviderInfo[] => (ctx.modelCatalog?.().providers ?? []).filter(provider => provider.available);
  const modelName = (providerId: string | undefined, model: string) => providers().find(p => p.id === providerId)?.models.find(m => m.id === model)?.name ?? model;

  /** Rows the domain appends are published from the replica's last revision (the service publishes its own). */
  function append(chatId: string, kind: TimelineItem['kind'], text: string, status: string, data: Record<string, unknown>): TimelineItem {
    const before = ctx.store.timelineRevision(chatId);
    const item = ctx.store.appendItem(chatId, kind, text, status, data);
    publish(chatId, before);
    return item;
  }
  function publish(chatId: string, before: number) {
    const patch = ctx.store.timelineChanges(chatId, before);
    if (patch.revision > before) ctx.emit({ type: 'timelinePatch', chatId, patch: { ...patch, after: before } });
  }
  const notice = (r: Row, state: DelegatedTaskNotice['state'], text: string) =>
    ctx.store.chat(r.parent_chat_id) && append(r.parent_chat_id, 'notice', text, 'completed', { kind: 'delegated-task', childChatId: r.child_chat_id, title: r.title, model: modelName(r.provider_id ?? undefined, r.model), ...(r.provider_id ? { providerId: r.provider_id } : {}), state } satisfies DelegatedTaskNotice);

  // ---- reading a child ---------------------------------------------------------------------------------------------
  const replies = (childId: string, last: number) => (db.prepare("SELECT text FROM timeline WHERE chat_id = ? AND kind = 'assistant' AND length(trim(text)) > 0 ORDER BY seq DESC LIMIT ?").all(childId, last) as { text: string }[]).map(r => r.text).reverse();
  function changedFiles(child: Chat): string[] {
    const root = child.folderId ? ctx.store.folder(child.folderId)?.path : undefined, out = new Set<string>();
    for (const item of ctx.store.editItems(child.id)) {
      if (item.kind !== 'tool' || !Array.isArray(item.data?.changes)) continue;
      for (const change of item.data.changes as unknown[]) {
        const path = change && typeof change === 'object' ? (change as { path?: unknown }).path : undefined;
        if (typeof path !== 'string' || !path) continue;
        const shown = root && isAbsolute(path) && !relative(root, path).startsWith('..') ? relative(root, path) : path;
        out.add(shown);
      }
    }
    return [...out].sort().slice(0, 50);
  }
  const statusWord = (chat: Chat) => chat.status === 'completed' ? 'finished' : chat.status === 'interrupted' ? 'stopped' : chat.status === 'idle' ? 'not started' : chat.status;
  function describe(r: Row, chat: Chat | undefined): string {
    if (!chat) return `${r.child_chat_id} "${r.title}": deleted`;
    return `${chat.id} "${label(chat)}" on ${modelName(chat.providerId, chat.model)}: ${statusWord(chat)}${chat.error && chat.status === 'failed' ? ` (${clip(oneLine(chat.error), 200)})` : ''}`;
  }
  function report(r: Row, chat: Chat, last = 1): string {
    const said = replies(chat.id, last), files = changedFiles(chat);
    return [describe(r, chat), said.length ? `${last > 1 ? 'Last replies' : 'Final reply'}:\n${said.map(text => clip(text, MAX_REPLY)).join('\n---\n')}` : 'No reply yet.',
      files.length ? `Changed files: ${files.join(', ')}` : ''].filter(Boolean).join('\n');
  }

  // ---- waiting and waking ------------------------------------------------------------------------------------------
  interface Waiter { caller: string; done(settled: boolean): void }
  const waiters = new Map<string, Set<Waiter>>();
  /** Resolves true when the child settles, false on timeout. An idle child answers at once. */
  function waitFor(childId: string, caller: string, ms: number): Promise<boolean> {
    if (!busy(ctx.store.chat(childId))) return Promise.resolve(true);
    return new Promise(resolve => {
      const set = waiters.get(childId) ?? new Set<Waiter>(); waiters.set(childId, set);
      const timer = setTimeout(() => finish(false), ms);
      const waiter: Waiter = { caller, done: settled => finish(settled) };
      function finish(settled: boolean) { clearTimeout(timer); set.delete(waiter); if (!set.size && waiters.get(childId) === set) waiters.delete(childId); resolve(settled); }
      set.add(waiter);
    });
  }
  /** The parent read this child's latest result itself: no report needs to wake it, and a queued one is withdrawn. */
  async function consumed(r: Row): Promise<void> {
    const fresh = row(r.child_chat_id); if (!fresh) return;
    db.prepare('UPDATE delegated_tasks SET reported = settles, report_queue_id = NULL WHERE child_chat_id = ?').run(r.child_chat_id);
    if (fresh.report_queue_id && ctx.store.queued(fresh.parent_chat_id, fresh.report_queue_id)) await ctx.invoke('chat.queue.remove', { id: fresh.parent_chat_id, queueId: fresh.report_queue_id }).catch(() => undefined);
  }
  async function settled(chat: Chat, status: ChatStatus): Promise<void> {
    const r = row(chat.id); if (!r) return;
    const at = new Date().toISOString();
    db.prepare('UPDATE delegated_tasks SET settles = settles + 1, last_status = ?, finished_at = ? WHERE child_chat_id = ?').run(status, at, chat.id);
    const state: DelegatedTaskNotice['state'] = status === 'completed' ? 'finished' : status === 'interrupted' ? 'stopped' : 'failed';
    notice(r, state, state === 'finished' ? `${r.title} finished` : state === 'stopped' ? `${r.title} was stopped` : `${r.title} failed`);
    const lineage = new Set(ancestors(chat.id)), blocked = [...(waiters.get(chat.id) ?? [])].filter(waiter => lineage.has(waiter.caller));
    for (const waiter of [...(waiters.get(chat.id) ?? [])]) waiter.done(true);
    if (blocked.length) { await consumed(r); return; }
    // A stop is the parent's or the user's own act; only a finished or failed turn reports back.
    if (status !== 'completed' && status !== 'failed') { db.prepare('UPDATE delegated_tasks SET reported = settles WHERE child_chat_id = ?').run(chat.id); return; }
    const parent = ctx.store.chat(r.parent_chat_id), latest = row(chat.id)!;
    if (!parent || parent.archived) return;
    const text = `Muster: a chat you delegated ${status === 'completed' ? 'finished' : 'failed'}. This is its report, not a message from the user.\n${report(latest, ctx.store.chat(chat.id) ?? chat)}\nUse read_task or message_task with id ${chat.id} to follow up.`;
    try {
      const queued = await ctx.invoke('chat.queue.add', { id: parent.id, text: clip(text, 16_000), requestId: `delegation-${chat.id}-${latest.settles}` });
      db.prepare('UPDATE delegated_tasks SET reported = settles, report_queue_id = ? WHERE child_chat_id = ?').run(queued.id, chat.id);
    } catch { /* the parent is gone or cannot take messages; list_tasks and read_task still show the result */ }
  }

  // ---- approvals and questions ------------------------------------------------------------------------------------
  function attention(chatId: string, itemId: string, state: 'pending' | 'settled') {
    const item = ctx.store.item(itemId);
    if (!item || (item.kind !== 'approval' && item.kind !== 'question')) return;
    if (state === 'pending') {
      if (item.data?.delegated) return;
      const r = row(chatId); if (!r) return;
      const delegated: DelegatedAttention = { chatId, itemId, title: r.title };
      for (const ancestor of ancestors(chatId)) {
        if (!ctx.store.chat(ancestor)) continue;
        const copy = append(ancestor, item.kind, item.text, 'pending', { ...item.data, delegated });
        db.prepare('INSERT OR IGNORE INTO delegated_attention (source_item_id, mirror_item_id, chat_id) VALUES (?, ?, ?)').run(itemId, copy.id, ancestor);
      }
      return;
    }
    for (const copy of db.prepare('SELECT mirror_item_id, chat_id FROM delegated_attention WHERE source_item_id = ?').all(itemId) as { mirror_item_id: string; chat_id: string }[]) {
      const mirror = ctx.store.item(copy.mirror_item_id); if (!mirror) continue;
      const before = ctx.store.timelineRevision(copy.chat_id);
      ctx.store.updateItem(mirror.id, mirror.text, item.status, { ...item.data, delegated: mirror.data?.delegated });
      publish(copy.chat_id, before);
    }
  }

  // ---- starting a child --------------------------------------------------------------------------------------------
  function accessibleFolders(parent: Chat): Folder[] {
    const ids = new Set<string>([...(parent.folderId ? [parent.folderId] : []), ...(parent.projectId ? ctx.store.project(parent.projectId)?.folderIds ?? [] : [])]);
    return [...ids].flatMap(id => { const folder = ctx.store.folder(id); return folder ? [folder] : []; });
  }
  function resolveFolder(parent: Chat, wanted: unknown): string | undefined {
    if (wanted === undefined || wanted === null || wanted === '') return parent.folderId;
    const name = str(wanted, 4096); if (!name) throw new Error('folder must be a folder name, path or id.');
    const list = accessibleFolders(parent), lower = name.toLowerCase();
    const hit = list.find(f => f.id === name || f.path === name) ?? list.find(f => f.name.toLowerCase() === lower);
    if (!hit) throw new Error(list.length ? `You can only delegate into a folder this chat can use: ${list.map(f => `"${f.name}"`).join(', ')}.` : 'This chat has no folder, so a child can only work without one.');
    return hit.id;
  }
  function resolveRoute(parent: Chat, providerArg: unknown, modelArg: unknown): { providerId: string; model: string } {
    const providerName = str(providerArg, 256), modelArg_ = str(modelArg, 256);
    if (!providerName && !modelArg_) {
      if (!parent.providerId) throw new Error('This chat has no model to hand on. Name a provider and model you have set up.');
      return { providerId: parent.providerId, model: parent.model };
    }
    const ready = providers(), lower = (value: string) => value.toLowerCase();
    const candidates = providerName ? ready.filter(p => lower(p.id) === lower(providerName) || lower(p.name) === lower(providerName)) : ready;
    const offer = () => ready.slice(0, 12).map(p => `${p.name} (${p.id}): ${p.models.slice(0, 8).map(m => m.id).join(', ') || 'any model'}`).join('; ');
    if (providerName && !candidates.length) throw new Error(`"${providerName}" is not a provider you have set up. Set up: ${offer() || 'none'}.`);
    if (!modelArg_) {
      const only = candidates[0]!;
      const model = only.id === parent.providerId ? parent.model : only.models[0]?.id;
      if (!model) throw new Error(`Name a model for ${only.name}.`);
      return { providerId: only.id, model };
    }
    for (const p of candidates) {
      const hit = p.models.find(m => m.id === modelArg_ || lower(m.name) === lower(modelArg_));
      if (hit) return { providerId: p.id, model: hit.id };
    }
    const open = candidates.find(p => p.models.length === 0);
    if (open) return { providerId: open.id, model: modelArg_ };
    throw new Error(`"${modelArg_}" is not a model you have set up${providerName ? ` on ${providerName}` : ''}. Set up: ${offer() || 'none'}.`);
  }
  async function delegate(parent: Chat, args: Record<string, unknown>): Promise<McpToolResult> {
    const prompt = str(args.prompt, MAX_PROMPT);
    if (!prompt) return toolText('Give the child a prompt (at most 32,768 characters).', true);
    const depth = depthOf(parent.id) + 1;
    if (depth > DELEGATION_MAX_DEPTH) return toolText(`Delegation goes at most ${DELEGATION_MAX_DEPTH} chats deep, and this chat is already ${depth - 1} deep. Do this part yourself.`, true);
    const active = childrenOf(parent.id).filter(r => busy(ctx.store.chat(r.child_chat_id))).length;
    if (active >= DELEGATION_MAX_ACTIVE) return toolText(`${active} chats you started are still working (at most ${DELEGATION_MAX_ACTIVE} at once). Wait for one with wait_task, or interrupt one.`, true);
    let folderId: string | undefined, route: { providerId: string; model: string };
    try { folderId = resolveFolder(parent, args.folder); route = resolveRoute(parent, args.provider, args.model); }
    catch (error) { return toolText(error instanceof Error ? error.message : String(error), true); }
    const title = clip(oneLine(str(args.title, 200) ?? prompt.split('\n').find(line => line.trim()) ?? 'Delegated task'), 60);
    const inProject = parent.projectId && folderId && ctx.store.project(parent.projectId)?.folderIds.includes(folderId) ? parent.projectId : !folderId ? parent.projectId : undefined;
    let child = await ctx.invoke('chat.create', { ...(folderId ? { folderId } : {}), ...(inProject ? { projectId: inProject } : {}), inheritFrom: parent.id });
    try {
      await ctx.invoke('chat.update', { id: child.id, title, mode: 'agent' });
      if (child.providerId !== route.providerId || child.model !== route.model) await ctx.invoke('chat.selectProvider', { id: child.id, providerId: route.providerId, model: route.model });
      // Never more access than the parent: exactly its effective access.
      const access = effectiveAccess(parent);
      if (effectiveAccess(ctx.store.chat(child.id)!) !== access) await ctx.invoke('chat.setPermissionMode', { id: child.id, permissionMode: access, ...(access === 'full' ? { acknowledgeFullAccess: true } : {}) });
      child = ctx.store.chat(child.id)!;
    } catch (error) {
      await ctx.invoke('chat.delete', { id: child.id, force: true }).catch(() => undefined);
      return toolText(`Could not start the child: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    const root = row(parent.id)?.root_chat_id ?? parent.id, createdAt = new Date().toISOString();
    db.prepare('INSERT INTO delegated_tasks (child_chat_id, parent_chat_id, root_chat_id, depth, title, provider_id, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(child.id, parent.id, root, depth, title, child.providerId ?? null, child.model, createdAt);
    const r = row(child.id)!;
    append(child.id, 'notice', `Started by ${label(parent)}`, 'completed', { kind: 'delegated-from', parentChatId: parent.id, parentTitle: label(parent) } satisfies DelegatedFromNotice);
    notice(r, 'started', `Started ${title} on ${modelName(child.providerId, child.model)}`);
    try { await ctx.invoke('chat.send', { id: child.id, text: prompt, requestId: `delegate-${randomUUID()}` }); }
    catch (error) { return toolText(`Started chat ${child.id} but could not send it the task: ${error instanceof Error ? error.message : String(error)}. Use message_task to try again.`, true); }
    if (args.wait !== true) return toolText(`Started ${describe(r, ctx.store.chat(child.id))}. Muster sends you its result when it finishes; or use wait_task / read_task with id ${child.id}.`);
    return waitResult(parent.id, r, args.timeout_seconds);
  }
  const waitMs = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value * 1000, DELEGATION_MAX_WAIT_MS) : DELEGATION_DEFAULT_WAIT_MS;
  async function waitResult(caller: string, r: Row, timeout: unknown): Promise<McpToolResult> {
    const ms = waitMs(timeout), done = await waitFor(r.child_chat_id, caller, ms), chat = ctx.store.chat(r.child_chat_id);
    if (!chat) return toolText(`${r.child_chat_id} was deleted.`, true);
    if (!done) return toolText(`${describe(r, chat)} after waiting ${Math.round(ms / 1000)} s. Muster sends you its result when it finishes; or wait again.`);
    await consumed(r);
    return toolText(report(row(r.child_chat_id) ?? r, chat));
  }

  // ---- the tools ---------------------------------------------------------------------------------------------------
  /** The child row `caller` may control: its own child or a descendant of one. */
  function controlled(caller: string, value: unknown): Row {
    const id = typeof value === 'string' ? value.trim() : '';
    const r = ID.test(id) ? row(id) : undefined;
    if (!r || !ancestors(id).includes(caller)) throw new Error(`${id || 'That id'} is not a chat you started. list_tasks shows yours.`);
    return r;
  }
  async function runTool(chatId: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const caller = ctx.store.chat(chatId);
    if (!caller) return toolText('This chat no longer exists.', true);
    try {
      switch (tool) {
        case 'delegate_task':
          if (!offered(caller)) return toolText('Delegation needs an agent chat with more than read-only access.', true);
          return await delegate(caller, args);
        case 'list_tasks': {
          const mine = descendants(chatId);
          return toolText(mine.length ? mine.map(r => `${'  '.repeat(r.depth - depthOf(chatId) - 1)}${describe(r, ctx.store.chat(r.child_chat_id))}`).join('\n') : 'You have not started any chats.');
        }
        case 'read_task': {
          const r = controlled(chatId, args.id), chat = ctx.store.chat(r.child_chat_id);
          if (!chat) return toolText(`${r.child_chat_id} was deleted.`, true);
          const last = Math.min(Math.max(Math.floor(Number(args.last) || 1), 1), 5);
          if (!busy(chat)) await consumed(r);
          return toolText(report(r, chat, last));
        }
        case 'wait_task': return await waitResult(chatId, controlled(chatId, args.id), args.timeout_seconds);
        case 'message_task': {
          const r = controlled(chatId, args.id), chat = ctx.store.chat(r.child_chat_id), text = str(args.text, MAX_PROMPT);
          if (!chat) return toolText(`${r.child_chat_id} was deleted.`, true);
          if (!text) return toolText('Write the message first.', true);
          if (chat.archived) return toolText(`${label(chat)} is archived.`, true);
          const requestId = `delegate-msg-${randomUUID()}`;
          if (chat.status === 'running' || chat.status === 'stopping') {
            const steered = await ctx.invoke('chat.steer', { id: chat.id, text, requestId }).catch(() => ({ steered: false }));
            if (steered.steered) return toolText(`Steered ${label(chat)}: it reads this in its current turn.`);
            await ctx.invoke('chat.queue.add', { id: chat.id, text, requestId });
            return toolText(`Queued for ${label(chat)}: it reads this after its current turn.`);
          }
          if (busy(chat)) { await ctx.invoke('chat.queue.add', { id: chat.id, text, requestId }); return toolText(`Queued for ${label(chat)}.`); }
          await ctx.invoke('chat.send', { id: chat.id, text, requestId });
          return toolText(`Sent to ${label(chat)}; it is working on it. Muster sends you its result when it finishes.`);
        }
        case 'interrupt_task': {
          const r = controlled(chatId, args.id);
          const stopped = await stopTree([r, ...descendants(r.child_chat_id)]);
          return toolText(stopped ? `Stopped ${stopped} chat${stopped === 1 ? '' : 's'} (${r.title}${stopped > 1 ? ' and the chats it started' : ''}).` : `${r.title} was not working.`);
        }
        default: return toolText(`Unknown delegation tool ${tool}.`, true);
      }
    } catch (error) { return toolText(error instanceof Error ? error.message : String(error), true); }
  }
  async function stopTree(rows: Row[]): Promise<number> {
    let stopped = 0;
    for (const r of rows) {
      const chat = ctx.store.chat(r.child_chat_id);
      if (!chat || !(chat.status === 'running' || chat.status === 'stopping' || chat.status === 'waiting' || chat.status === 'reconnecting')) continue;
      await ctx.invoke('chat.stop', { id: chat.id }).then(() => { stopped++; }, () => undefined);
    }
    return stopped;
  }

  let host: ToolHost | undefined;
  const toolHost = () => host ??= new ToolHost({ dir: join(ctx.dataDir, 'agent-tools', 'delegation'), name: DELEGATION_MCP, title: 'Muster delegation', specs: DELEGATION_TOOL_SPECS, execPath: process.execPath, run: runTool, timeoutMs: DELEGATION_TOOL_TIMEOUT_MS });
  const offOptions = ctx.hooks.addRunOptionsContributor(async chat => {
    if (deps.toolHost === false || !offered(chat)) return null;
    const tools = toolHost(), launcher = await tools.start();
    return { configOverrides: { [`mcp_servers.${DELEGATION_MCP}.command`]: launcher, [`mcp_servers.${DELEGATION_MCP}.env.MUSTER_CHAT_ID`]: chat.id, [`mcp_servers.${DELEGATION_MCP}.env.MUSTER_CHAT_TOKEN`]: tools.chatToken(chat.id), [`mcp_servers.${DELEGATION_MCP}.tool_timeout_sec`]: Math.ceil(DELEGATION_TOOL_TIMEOUT_MS / 1000) } };
  });
  const offSettled = ctx.hooks.onRunSettled(run => settled(run.chat, run.status));
  const offAttention = ctx.hooks.onAttention?.(event => attention(event.chatId, event.itemId, event.state));
  // The report a child's finish queued for its parent is shown as a notice in the parent, not as the user's words.
  ctx.hooks.setSendData?.((chatId, requestId) => {
    const match = /^delegation-([a-zA-Z0-9_-]+)-(\d+)$/.exec(requestId), r = match ? row(match[1]!) : undefined;
    if (!r || r.parent_chat_id !== chatId) return undefined;
    const summary = clip(oneLine(replies(r.child_chat_id, 1)[0]?.split('\n').find(line => line.trim()) ?? ''), 160);
    return { kind: 'delegation-report', childChatId: r.child_chat_id, title: r.title, state: r.last_status === 'completed' ? 'finished' : 'failed', ...(summary ? { summary } : {}) } satisfies DelegationReportData;
  });

  const toTask = (r: Row): DelegatedTask => {
    const chat = ctx.store.chat(r.child_chat_id);
    return { id: r.child_chat_id, parentChatId: r.parent_chat_id, rootChatId: r.root_chat_id, depth: r.depth, title: chat ? label(chat) : r.title, ...(chat?.providerId ?? r.provider_id ? { providerId: chat?.providerId ?? r.provider_id! } : {}), model: chat?.model ?? r.model, status: chat?.status ?? 'idle', createdAt: r.created_at, ...(r.finished_at ? { finishedAt: r.finished_at } : {}) };
  };
  const chatIdOf = (input: Record<string, unknown>) => { const id = input.chatId; if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid chat id.'); return id; };
  const module: DomainModule = {
    handlers: {
      'delegation.children': input => childrenOf(chatIdOf(input)).filter(r => ctx.store.chat(r.child_chat_id)).map(toTask),
      'delegation.stopChildren': async input => ({ stopped: await stopTree(descendants(chatIdOf(input))) }),
    },
    dispose() {
      offOptions(); offSettled(); offAttention?.(); ctx.hooks.setSendData?.(undefined); host?.dispose(); host = undefined;
      for (const set of waiters.values()) for (const waiter of [...set]) waiter.done(false);
      waiters.clear();
    },
  };
  return { module, runTool, toolHost };
}

/** Delegation domain. Handlers are keyed by the command names in shared/domains/delegation-protocol.ts. */
export function createDelegationDomain(context: DomainContext): DomainModule {
  return createDelegation(context).module;
}
