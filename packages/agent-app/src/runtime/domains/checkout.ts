/** Orgs and Check out (#117): the handlers of `orgs.*` and `checkout.*`. The pure rules and the orchestration live in shared/org-work.ts and runtime/checkout/. */
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import type { MyWork } from '../../shared/domains/checkout-protocol.ts';
import { createWorktree } from '../git-local.ts';
import { sameOrigin } from '../../shared/task-link.ts';
import { normalizeRemote } from '../memory-identity.ts';
import { CheckoutService, type LocalProviderInfo, type TurnFacts } from '../checkout/service.ts';
import { CheckoutStore } from '../checkout/store.ts';
import { realGit } from '../checkout/git-port.ts';
import { badgeOf } from '../checkout/lease.ts';
import { TurnLedger } from '../turn-ledger.ts';
import { connectionFor } from '../server/connection.ts';
import { serverHubFor } from '../server/orgs.ts';
import type { DomainContext, DomainModule } from './types.ts';

const gitRemote = (cwd: string) => new Promise<string | undefined>(resolve => execFile('git', ['config', '--get', 'remote.origin.url'], { cwd, timeout: 1500, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined)));
const text = (v: unknown, max = 4000): string => { if (typeof v !== 'string' || v.length > max) throw new Error('Invalid input.'); return v; };
const id = (v: unknown): string => { if (typeof v !== 'string' || !/^[\w:.\-/]{1,160}$/.test(v)) throw new Error('Unknown item.'); return v; };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createCheckoutDomain(ctx: DomainContext): DomainModule {
  const hub = serverHubFor(ctx);
  const conn = connectionFor(ctx);
  const store = new CheckoutStore(() => ctx.db());
  let service: CheckoutService | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const server = () => { const origin = conn.config.baseUrl; try { return new URL(origin).host; } catch { return origin; } };
  const providers = (): LocalProviderInfo[] => (ctx.modelCatalog?.().providers ?? []).map(p => ({
    id: p.id, name: p.name, driver: p.driver, available: p.available, models: p.models.map(m => ({ id: m.id, name: m.name })),
    subscription: p.id === 'claude-code' || p.codex?.kind === 'chatgpt',
  }));
  const svc = (): CheckoutService => service ??= new CheckoutService({
    store, backend: () => hub.backend?.() ?? null, get reader() { if (!hub.reader) throw new Error('Muster Server is not connected. Connect it in Settings › Integrations.'); return hub.reader; },
    git: realGit, serverLabel: server, deviceNameDefault: () => hostname().replace(/\.local$/, ''), now: () => Date.now(),
    worktrees: { create: (root, branch, base) => createWorktree(root, ctx.dataDir, { branch, base }) },
    providers,
    detectFolder: async repo => {
      if (!repo) return null;
      for (const folder of ctx.store.snapshot().folders) { try { if (normalizeRemote(await gitRemote(folder.path) ?? '') === repo) return folder.path; } catch { /* not a repository */ } }
      return null;
    },
    chats: {
      addFolder: async path => ctx.invoke('folder.add', { path }),
      create: async folderId => ctx.invoke('chat.create', { folderId }),
      select: async (chatId, providerId, model) => { await ctx.invoke('chat.selectProvider', { id: chatId, providerId, model }); },
      rename: async (chatId, title) => { await ctx.invoke('chat.update', { id: chatId, title }); },
      transcript: async chatId => (await ctx.invoke('chat.timeline', { id: chatId })).items.filter(i => i.kind === 'tool' || i.kind === 'assistant').map(i => i.text),
    },
    turnFacts: async (chatId, runId): Promise<TurnFacts | null> => {
      // The Receipt is written by the Ledger as the run settles; give it a moment.
      for (let n = 0; n < 8; n++) {
        const entry = new TurnLedger(ctx.db()).list({ chatIds: [chatId], limit: 5 }).find(e => e.runId === runId);
        if (entry) return { tokens: entry.tokens ? { input: entry.tokens.input, cached: entry.tokens.cached, output: entry.tokens.output } : null, tests: entry.tests, model: entry.model, provider: entry.provider, costUsd: entry.costUsd, durationMs: entry.durationMs, outcome: entry.outcome };
        await wait(150);
      }
      return null;
    },
    emit: taskId => { ctx.emit({ type: 'checkoutChanged', taskId }); ctx.emit({ type: 'projectsWorkspaceChanged', scopes: ['tasks'], taskIds: taskId ? [taskId] : [] }); schedule(); },
  });
  /** Posts that could not go (offline) are tried again every half minute, only while some are waiting. */
  const schedule = () => {
    if (retry || !store.pendingCount()) return;
    retry = setTimeout(() => { retry = null; void svc().flush().finally(schedule); }, 30_000);
    retry.unref?.();
  };
  hub.badge = taskId => { const l = store.openLeases().find(x => x.taskId === taskId); return l ? badgeOf(l, store.deviceId(), Date.now(), store.staleHours()) : null; };
  hub.onOnline = () => { if (store.pendingCount()) void svc().flush(); };
  const offPrompt = ctx.hooks.addPromptContributor(async ({ chat }) => {
    if (!store.leaseForChat(chat.id)) return null;
    const brief = await svc().brief(chat.id);
    return brief ? { label: 'Server task', text: brief } : null;
  });
  const offSettled = ctx.hooks.onRunSettled(run => { if (store.leaseForChat(run.chat.id)) return svc().onTurn(run.chat.id, run.runId, run.status); });

  const work = async (fresh: boolean): Promise<MyWork> => {
    if (!hub.reader || !hub.backend?.()) return { connected: false, me: null, orgs: [], fetchedAt: new Date().toISOString() };
    const { me, orgs } = await hub.reader.work(fresh);
    return { connected: true, me: me ? { id: me.id, name: me.name } : null, orgs, fetchedAt: new Date().toISOString() };
  };
  const reader = () => { if (!hub.reader) throw new Error('Muster Server is not connected. Connect it in Settings › Integrations.'); return hub.reader; };

  return {
    handlers: {
      'orgs.list': () => hub.reader && hub.backend?.() ? hub.reader.list() : { connected: false, server: null, me: null, orgs: [] },
      'orgs.set': async input => {
        const sidebar = input.sidebar === 'mine' || input.sidebar === 'team' || input.sidebar === 'none' ? input.sidebar : undefined;
        conn.setOrg(id(input.companyId), { ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}), ...(sidebar ? { sidebar } : {}) });
        ctx.emit({ type: 'projectsWorkspaceChanged', scopes: ['config', 'tasks', 'inbox'], taskIds: [] });
        return reader().list();
      },
      'orgs.work': input => work(input.refresh === true),
      'orgs.link': async input => {
        // Only a server this Mac is already connected to: the person connects first, never the link.
        const connected = conn.config.mode !== 'off' && sameOrigin(conn.baseUrl(), text(input.host, 2048));
        if (!connected || !hub.reader || !hub.backend?.()) return { status: 'connect-first' as const, host: text(input.host, 2048) };
        const companies = await hub.reader.orgs(), company = companies.find(c => c.id === id(input.companyId));
        if (!company) return { status: 'not-found' as const, identifier: typeof input.identifier === 'string' ? input.identifier : null };
        const part = await hub.reader.part(company, true), task = part.tasks.find(t => t.id === id(input.issueId) || (typeof input.identifier === 'string' && t.key === input.identifier));
        if (!task) return { status: 'not-found' as const, identifier: typeof input.identifier === 'string' ? input.identifier : null };
        const me = await hub.reader.me();
        return { status: 'ok' as const, taskId: task.id, orgName: company.name, mine: Boolean(me && task.assigneeUserId === me.id) };
      },
      'orgs.open': input => { conn.configure({ mode: conn.config.mode, baseUrl: conn.config.baseUrl, companyId: id(input.companyId) }); return { ok: true }; },
      'checkout.settings': input => {
        if (typeof input.staleHours === 'number') store.setStaleHours(input.staleHours);
        if (typeof input.deviceName === 'string') store.setDeviceName(text(input.deviceName, 80));
        return { staleHours: store.staleHours(), deviceName: store.deviceName(hostname().replace(/\.local$/, '')) };
      },
      'checkout.bindings': async () => {
        const orgs = hub.reader && hub.backend?.() ? await hub.reader.list().then(l => l.orgs.filter(o => o.enabled).map(o => ({ id: o.id, name: o.name, projects: (hub.reader!.cached(o.id)?.projects ?? []).map(p => ({ id: p.id, name: p.name })) }))).catch(() => []) : [];
        return { bindings: store.bindings(server()), orgs };
      },
      'checkout.bind': input => svc().bind(id(input.orgId), id(input.projectId), text(input.path, 4096), typeof input.devBranch === 'string' ? text(input.devBranch, 200) : undefined),
      'checkout.unbind': input => { store.unbind(server(), id(input.orgId), id(input.projectId)); return { ok: true }; },
      'checkout.plan': input => svc().plan(id(input.taskId)),
      'checkout.start': input => svc().start({ taskId: id(input.taskId), take: input.take === true, confirm: input.confirm as true, model: input.model as never, ...(typeof input.folder === 'string' ? { folder: text(input.folder, 4096) } : {}), ...(typeof input.devBranch === 'string' ? { devBranch: text(input.devBranch, 200) } : {}) }),
      'checkout.get': input => ({ lease: svc().get(id(input.taskId)) }),
      'checkout.org': async input => ({ copy: input.refresh === true ? await svc().copyOrg(id(input.taskId)) : svc().orgCopy(id(input.taskId)) }),
      'checkout.engine': input => svc().setEngine(id(input.taskId), { ...(input.model ? { model: input.model as never } : {}), ...(typeof input.reviewLocally === 'boolean' ? { reviewLocally: input.reviewLocally } : {}) }),
      'checkout.review': input => svc().startReview(id(input.taskId), typeof input.agentId === 'string' ? id(input.agentId) : undefined),
      'checkout.leases': () => ({ leases: svc().leases() }),
      'checkout.decision': input => svc().decision(id(input.taskId), text(input.text)),
      'checkout.handback.preview': input => svc().handBackPreview(id(input.taskId)),
      'checkout.handback': input => svc().handBack({ taskId: id(input.taskId), reviewer: { kind: (input.reviewer as { kind?: string })?.kind === 'user' ? 'user' : 'agent', id: id((input.reviewer as { id?: unknown })?.id) },
        ...(typeof input.testsNote === 'string' ? { testsNote: text(input.testsNote, 2000) } : {}), ...(typeof input.summary === 'string' ? { summary: text(input.summary, 8000) } : {}), ...(typeof input.openQuestions === 'string' ? { openQuestions: text(input.openQuestions, 4000) } : {}),
        ...(typeof input.prUrl === 'string' ? { prUrl: text(input.prUrl, 2000) } : {}), ...(typeof input.push === 'boolean' ? { push: input.push } : {}) }),
      'checkout.release': input => svc().release(id(input.taskId), typeof input.note === 'string' ? text(input.note, 2000) : undefined),
      'checkout.runOnServer': input => svc().runOnServer(id(input.taskId), input.on === true),
      'checkout.sync': () => svc().sync(),
      'checkout.outbox': () => svc().outbox(),
      'checkout.offline': input => svc().setOffline(id(input.taskId), input.on === true),
      'checkout.pending': input => svc().pending(id(input.taskId)),
      'checkout.pending.edit': input => { svc().editPending(Number(input.id), text(input.body, 8000)); return { ok: true }; },
      'checkout.resolve': input => svc().resolve(id(input.taskId), input.choice === 'discard' ? 'discard' : 'send'),
      'checkout.remind': input => { svc().remind(id(input.taskId)); return { ok: true }; },
    },
    power(event) { if (event.state === 'resume' && store.pendingCount()) void svc().flush(); },
    dispose() { offPrompt(); offSettled(); if (retry) clearTimeout(retry); hub.badge = undefined; hub.onOnline = undefined; },
  };
}
