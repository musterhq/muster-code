/**
 * Projects domain, part two: filtered activity (PRJ-11) plus memory/environment activity logging, the team model
 * with per-member access composed by intersection (PRJ-13), and explicit chat move/copy with a scope preview (PRJ-17).
 * createProjectsDomain mounts these handlers and asks runAccess() before every task dispatch.
 */
import type { Chat, ChatPermissionMode } from '../../shared/protocol.ts';
import {
  ACTIVITY_CATEGORIES, activityWindowStart, composeAccess, DEFAULT_AGENT_ID, LOCAL_OWNER_ID, MEMBER_ROLES, memberAccess, ROLE_LABEL,
  type AccessPolicy, type ActivityCategory, type ActivityPage, type ActivityWindow, type ChatTransferMode, type ChatTransferPreview, type MemberAccess, type MemberKind, type MemberRole, type ProjectMember,
} from '../../shared/domains/project-team-protocol.ts';
import type { ProjectDetails, TaskOwner } from '../../shared/domains/projects-protocol.ts';
import { plural } from '../../shared/wording.ts';
import { redactSecrets } from '../secret-redaction.ts';
import { ProjectTeamStore, type MemberPatch } from '../project-team.ts';
import type { Actor, ProjectTaskStore } from '../project-tasks.ts';
import type { DomainContext, DomainHandler } from './types.ts';

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const id = (value: unknown, field = 'id'): string => { if (typeof value !== 'string' || !ID.test(value)) throw new Error(`Invalid ${field}.`); return value; };
const MODES: readonly ChatPermissionMode[] = ['read-only', 'workspace', 'full'];
const MODE_LABEL: Record<ChatPermissionMode, string> = { 'read-only': 'Read-only', workspace: 'Workspace', full: 'Full access' };
const CATEGORY_IDS = new Set(ACTIVITY_CATEGORIES.map(c => c.id));
const WINDOWS: readonly ActivityWindow[] = ['any', '24h', '7d', '30d'];
const ACTIVE = new Set(['running', 'stopping']);
const clip = (s: string, n: number) => { const flat = s.replace(/\s+/g, ' ').trim(); return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat; };
const quote = (s: string) => `“${clip(redactSecrets(s), 80)}”`;

export interface ProjectTeamDeps {
  tasks: () => ProjectTaskStore;
  /** Throws 'Project not found.' for an unknown id. */
  details: (projectId: string) => ProjectDetails;
  exists: (projectId: string) => boolean;
  changed: (projectId: string, taskId?: string, snapshot?: boolean) => void;
}

export function createProjectTeam(ctx: DomainContext, deps: ProjectTeamDeps) {
  let team: ProjectTeamStore | undefined, disposed = false;
  const members = () => team ??= new ProjectTeamStore(ctx.dataDir);
  const policy = (projectId: string): AccessPolicy => ({ permissionMode: deps.tasks().schedule(projectId).permissionMode, folderIds: deps.details(projectId).folderIds });
  const record = (projectId: string, kind: string, summary: string, refId: string | null = null, actor: Actor = 'user') => { deps.tasks().record(projectId, kind, summary, refId, actor); deps.changed(projectId); };

  // ── PRJ-13: access for a task run ─────────────────────────────────────────
  /**
   * Who a run acts for: the local person when they start it, otherwise the task's human owner (a delegating coordinator
   * or scheduler never substitutes its own grants). The agent that runs it is the task's agent member, else the default
   * agent. The result is the intersection of both inside the Project policy.
   */
  function runAccess(projectId: string, owner: TaskOwner, trigger: 'user' | 'scheduler' | 'coordinator'): MemberAccess {
    const all = members().list(projectId), byId = new Map(all.map(m => [m.id, m])), local = byId.get(LOCAL_OWNER_ID)!, p = policy(projectId);
    const requester = trigger === 'user' || owner.kind !== 'user' ? local : byId.get(owner.id) ?? local;
    const runner = (owner.kind === 'agent' ? byId.get(owner.id) : undefined) ?? byId.get(DEFAULT_AGENT_ID)!;
    return composeAccess([memberAccess(requester, p), memberAccess(runner.kind === 'agent' ? runner : byId.get(DEFAULT_AGENT_ID)!, p)]);
  }
  /** Tasks whose live run this member requested or runs. */
  function liveRunsOf(projectId: string, member: ProjectMember): string[] {
    const known = new Set(members().list(projectId).map(m => m.id));
    return deps.tasks().listTasks(projectId).items.filter(t => (t.state === 'running' || t.state === 'needs-input') && t.runChatId && (
      t.owner.id === member.id || (member.id === DEFAULT_AGENT_ID && t.owner.kind === 'agent' && !known.has(t.owner.id)) || (member.id === DEFAULT_AGENT_ID && t.owner.kind === 'user')
    )).map(t => t.runChatId!);
  }

  const grantList = (value: unknown, field: string): string[] | null | undefined => value === undefined ? undefined : value === null ? null : Array.isArray(value) ? value.map(v => id(v, field)) : (() => { throw new Error(`Invalid ${field}.`); })();
  const patchFrom = (input: Record<string, unknown>): MemberPatch => {
    const out: MemberPatch = {};
    if (input.name !== undefined) { if (typeof input.name !== 'string') throw new Error('Invalid name.'); out.name = input.name; }
    if (input.role !== undefined) { if (!MEMBER_ROLES.includes(input.role as MemberRole)) throw new Error('Invalid role.'); out.role = input.role as MemberRole; }
    if (input.maxPermission !== undefined) { if (input.maxPermission !== null && !MODES.includes(input.maxPermission as ChatPermissionMode)) throw new Error('Invalid permission cap.'); out.maxPermission = input.maxPermission as ChatPermissionMode | null; }
    const folders = grantList(input.folderIds, 'folder id'); if (folders !== undefined) out.folderIds = folders;
    if (input.secrets !== undefined) { if (!Array.isArray(input.secrets) || input.secrets.some(s => typeof s !== 'string')) throw new Error('Invalid secret grants.'); out.secrets = input.secrets as string[]; }
    return out;
  };
  const project = (input: Record<string, unknown>) => { const projectId = id(input.projectId, 'project id'); deps.details(projectId); return projectId; };
  const describeChanges = (before: ProjectMember, after: ProjectMember, projectId: string): string[] => {
    const out: string[] = [], total = deps.details(projectId).folderIds.length;
    if (before.name !== after.name) out.push(`renamed to ${after.name}`);
    if (before.role !== after.role) out.push(`role ${ROLE_LABEL[before.role]} → ${ROLE_LABEL[after.role]}`);
    if (before.maxPermission !== after.maxPermission) out.push(after.maxPermission ? `capped at ${MODE_LABEL[after.maxPermission]}` : 'no personal access cap');
    if (JSON.stringify(before.folderIds) !== JSON.stringify(after.folderIds)) out.push(after.folderIds === null ? 'every Project folder' : `${after.folderIds.length} of ${plural(total, 'folder')}`);
    if (JSON.stringify(before.secrets) !== JSON.stringify(after.secrets)) out.push(after.secrets.length ? `lends ${plural(after.secrets.length, 'secret')}` : 'lends no secrets');
    return out;
  };
  function listMembers(projectId: string) {
    const p = policy(projectId), all = members().list(projectId);
    return { members: all, access: Object.fromEntries(all.map(m => [m.id, memberAccess(m, p)])), policy: p };
  }

  // ── PRJ-11: filtered activity ─────────────────────────────────────────────
  function queryActivity(input: Record<string, unknown>): ActivityPage {
    const projectId = project(input);
    const categories = input.categories === undefined ? [] : Array.isArray(input.categories) && input.categories.length <= CATEGORY_IDS.size && input.categories.every(c => CATEGORY_IDS.has(c as ActivityCategory)) ? input.categories as ActivityCategory[] : (() => { throw new Error('Invalid activity types.'); })();
    const actors = input.actors === undefined ? [] : Array.isArray(input.actors) && input.actors.length <= 50 && input.actors.every(a => typeof a === 'string' && a.length > 0 && a.length <= 128) ? input.actors as string[] : (() => { throw new Error('Invalid actors.'); })();
    const window = input.window === undefined ? 'any' : WINDOWS.includes(input.window as ActivityWindow) ? input.window as ActivityWindow : (() => { throw new Error('Invalid time window.'); })();
    const limit = input.limit === undefined ? 50 : Number(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid limit.');
    let before: { createdAt: string; id: string } | null = null;
    if (input.before !== undefined) {
      const raw = typeof input.before === 'string' ? input.before : '', at = raw.lastIndexOf('|');
      if (at < 1 || !Number.isFinite(Date.parse(raw.slice(0, at))) || !ID.test(raw.slice(at + 1))) throw new Error('Invalid activity cursor.');
      before = { createdAt: raw.slice(0, at), id: raw.slice(at + 1) };
    }
    const page = deps.tasks().queryActivity(projectId, { categories, actors, since: activityWindowStart(window), before, limit });
    const last = page.items[page.items.length - 1];
    return { items: page.items, truncated: page.truncated, nextCursor: page.truncated && last ? `${last.createdAt}|${last.id}` : null, actors: page.actors };
  }

  // ── Memory and environment events (PRJ-11) ────────────────────────────────
  const chatOf = (value: unknown): Chat | undefined => typeof value === 'string' ? ctx.store.chat(value) : undefined;
  const projectOfScope = (folderId: unknown): string | null => typeof folderId === 'string' && folderId.startsWith('project:') && deps.exists(folderId.slice(8)) ? folderId.slice(8) : null;
  const folderName = (folderId?: string) => (folderId && ctx.store.folder(folderId)?.name) || 'Personal';
  const title = (chat: Chat) => quote(chat.title || 'Untitled chat');
  const saved = (out: unknown) => { const o = out as { local?: unknown; hindsight?: string } | undefined; return Boolean(o && (o.local || o.hindsight === 'saved' || o.hindsight === 'queued')); };
  const inProject = (chat: Chat | undefined) => chat?.projectId && deps.exists(chat.projectId) ? chat.projectId : null;
  function observe(command: string, input: Record<string, unknown>, output: unknown) {
    if (disposed) return;
    switch (command) {
      case 'memory.rememberText': {
        if (!saved(output)) return;
        const scoped = projectOfScope(input.folderId), chat = chatOf(input.chatId), text = typeof input.text === 'string' ? input.text : '';
        if (scoped) return record(scoped, 'memory.saved', `Saved a note to Project memory: ${quote(text)}`, chat?.id ?? null);
        const pid = inProject(chat);
        if (pid && chat) record(pid, 'memory.saved', `Saved a note from ${title(chat)} to ${folderName(typeof input.folderId === 'string' ? input.folderId : chat.folderId)} memory`, chat.id);
        return;
      }
      case 'memory.retainFromRun': { const chat = chatOf(input.chatId), pid = inProject(chat); if (pid && chat && saved(output)) record(pid, 'memory.retained', `Kept a run lesson from ${title(chat)}`, chat.id); return; }
      case 'memory.share': { const pid = typeof input.projectId === 'string' && deps.exists(input.projectId) ? input.projectId : null; if (pid && saved(output)) record(pid, 'memory.shared', `Shared a note into Project memory: ${quote(typeof input.text === 'string' ? input.text : '')}`); return; }
      case 'memory.correct': { const pid = projectOfScope(input.folderId); if (pid && saved(output)) record(pid, 'memory.corrected', 'Corrected a Project memory'); return; }
      case 'memory.delete': { const pid = projectOfScope(input.folderId); if (pid && (output as { deleted?: boolean } | undefined)?.deleted) record(pid, 'memory.deleted', 'Deleted a Project memory'); return; }
      case 'memory.document.delete': { const pid = projectOfScope(input.folderId); if (pid) record(pid, 'memory.deleted', 'Deleted a Project memory document'); return; }
      case 'memory.bank.delete': { const pid = projectOfScope(input.folderId); if (pid) record(pid, 'memory.bank-deleted', 'Deleted the Project memory bank (a backup was written first)'); return; }
      case 'sandbox.chatEnvironment.set': {
        const chat = chatOf(input.chatId), pid = inProject(chat); if (!pid || !chat) return;
        const env = input.env === 'sandbox' ? `a sandbox${input.mode === 'copy' ? ' (copy)' : input.mode === 'mount' ? ' (mounted)' : ''}` : 'the host folder';
        return record(pid, 'environment.set', `${title(chat)} now runs in ${env}`, chat.id);
      }
      case 'sandbox.syncFromHost': { const chat = chatOf(input.chatId), pid = inProject(chat); if (pid && chat) record(pid, 'environment.synced', `Synced ${title(chat)}’s sandbox from the host folder`, chat.id); return; }
      case 'sandbox.applyToHost': {
        const chat = chatOf(input.chatId), pid = inProject(chat), applied = (output as { applied?: unknown[] } | undefined)?.applied?.length ?? 0;
        if (pid && chat && applied) record(pid, 'environment.applied', `Applied ${plural(applied, 'file')} from ${title(chat)}’s sandbox to the host folder`, chat.id);
        return;
      }
      case 'git.worktree.create': case 'git.worktree.remove': {
        const folderId = typeof input.folderId === 'string' ? input.folderId : '', name = folderName(folderId);
        const projects = (ctx.db().prepare('SELECT id, folder_ids FROM projects').all() as { id: string; folder_ids: string }[]).filter(r => { try { return (JSON.parse(r.folder_ids) as unknown[]).includes(folderId); } catch { return false; } });
        const branch = command === 'git.worktree.create' ? (output as { branch?: string } | undefined)?.branch ?? String(input.branch ?? '') : '';
        for (const r of projects) record(r.id, command === 'git.worktree.create' ? 'environment.worktree-created' : 'environment.worktree-removed', command === 'git.worktree.create' ? `Created a worktree for ${clip(branch, 80)} in ${name}` : `Removed a worktree from ${name}`, folderId);
        return;
      }
    }
  }
  const unsubscribe = ctx.hooks.onCommand?.(({ command, input, output }) => observe(command, input, output));

  // ── PRJ-17: explicit chat move/copy ───────────────────────────────────────
  const userMessages = (chatId: string) => Number((ctx.db().prepare("SELECT COUNT(*) AS n FROM timeline WHERE chat_id = ? AND kind = 'user'").get(chatId) as { n: number }).n);
  const contextOf = (projectId: string): string[] => {
    const d = deps.details(projectId), store = deps.tasks(), rules = store.instructions(projectId).version, decisions = store.listDecisions(projectId).items.filter(x => x.status === 'active').length;
    return [d.goal.trim() ? `${d.name}’s shared goal` : `${d.name}’s shared goal (not set yet)`, ...(rules ? [`Project instructions v${rules}`] : []), ...(decisions ? [plural(decisions, 'active decision')] : [])];
  };
  function preview(chatId: string, projectId: string | null, mode: ChatTransferMode): ChatTransferPreview {
    const chat = ctx.store.chat(chatId);
    if (!chat) throw new Error('Chat not found.');
    const from = chat.projectId && deps.exists(chat.projectId) ? deps.details(chat.projectId) : null, to = projectId ? deps.details(projectId) : null;
    const messages = userMessages(chatId), running = ACTIVE.has(chat.status), folder = chat.folderId ? ctx.store.folder(chat.folderId) : undefined;
    let blocked: string | null = null;
    if (running) blocked = `Wait for this run to finish before ${mode === 'copy' ? 'copying' : 'moving'} the chat.`;
    else if (to?.archived) blocked = `Restore ${to.name} before adding chats to it.`;
    else if (mode === 'move' && (from?.id ?? null) === (to?.id ?? null)) blocked = to ? `This chat is already in ${to.name}.` : 'This chat is not in a Project.';
    else if (mode === 'copy' && !to && !from) blocked = 'This chat is not in a Project. Use Fork to duplicate it.';
    else if (to && messages > 0 && !chat.folderId && to.folderIds.length) blocked = 'This chat has messages but no folder, so it cannot join a Project that works in folders. Start a new chat in the Project instead.';
    // Mirrors the runtime rule: a chat with history keeps its folder (linked to the Project); a new one adopts the Project's.
    const keepsFolder = !to || messages > 0 || Boolean(chat.folderId && to.folderIds.includes(chat.folderId));
    const nextFolderId = keepsFolder ? chat.folderId : to?.folderIds[0];
    const nextFolder = nextFolderId ? ctx.store.folder(nextFolderId) : undefined;
    const linksFolder = Boolean(to && nextFolderId && !to.folderIds.includes(nextFolderId));
    const origin = mode === 'copy' ? null : from;
    const gains = to && to.id !== from?.id ? contextOf(to.id) : mode === 'copy' && to ? contextOf(to.id) : [];
    const loses = origin && origin.id !== to?.id ? contextOf(origin.id) : mode === 'copy' && from && !to ? contextOf(from.id) : [];
    const banks = (folderId: string | undefined, p: ProjectDetails | null) => [`${folderName(folderId)} memory`, ...(p ? [`${p.name} Project memory`] : [])];
    const notes = [
      mode === 'copy' ? `The original stays ${from ? `in ${from.name}` : 'where it is'}; the copy starts from the same history${to ? ` inside ${to.name}` : ' outside any Project'}.` : '',
      to ? `Everyone with access to ${to.name} can open this chat. Other private chats are never added automatically.` : '',
      linksFolder && nextFolder ? `${nextFolder.name} will be linked to ${to!.name} so the chat keeps working where it is.` : '',
      !keepsFolder && nextFolder ? `The chat will open in ${nextFolder.name}.` : '',
      'Saved memories stay in the bank they were saved to. Nothing is copied or shared automatically.',
    ].filter(Boolean);
    return {
      chatId, title: chat.title || 'Untitled chat', mode, from: from ? { id: from.id, name: from.name } : null, to: to ? { id: to.id, name: to.name } : null, blocked, messages, running,
      folder: nextFolder ? { id: nextFolder.id, name: nextFolder.name } : null, linksFolder,
      context: { gains, loses, keeps: ['Message history', 'Model, mode and access settings', ...(nextFolder ? [`Folder: ${nextFolder.name}`] : [])] },
      memory: { before: banks(chat.folderId, from), after: banks(nextFolderId, to) },
      notes,
    };
  }
  async function transfer(input: Record<string, unknown>): Promise<{ chatId: string; projectId: string | null }> {
    if (input.confirm !== true) throw new Error('Review the preview and confirm the transfer.');
    const chatId = id(input.chatId, 'chat id'), projectId = input.projectId === null ? null : id(input.projectId, 'project id'), mode = input.mode === 'copy' ? 'copy' : input.mode === 'move' ? 'move' : (() => { throw new Error('Invalid transfer mode.'); })();
    const p = preview(chatId, projectId, mode);
    if (p.blocked) throw new Error(p.blocked);
    let targetId = chatId;
    if (mode === 'move') await ctx.invoke('chat.update', { id: chatId, projectId });
    else {
      const copy = await ctx.invoke('chat.fork', { id: chatId });
      targetId = copy.id;
      try { if ((copy.projectId ?? null) !== projectId) await ctx.invoke('chat.update', { id: copy.id, projectId }); }
      catch (err) { await ctx.invoke('chat.delete', { id: copy.id, force: true }).catch(() => undefined); throw err; }
    }
    const name = quote(p.title);
    if (p.to) record(p.to.id, mode === 'copy' ? 'chat.copied-in' : 'chat.moved-in', `${mode === 'copy' ? 'Copied' : 'Moved'} ${name} into the Project${p.from && p.from.id !== p.to.id ? ` from ${p.from.name}` : ''}`, targetId);
    if (p.from && mode === 'move' && p.from.id !== p.to?.id) record(p.from.id, 'chat.moved-out', `Moved ${name} out of the Project${p.to ? ` to ${p.to.name}` : ''}`, chatId);
    if (p.from && mode === 'copy' && !p.to) record(p.from.id, 'chat.copied-out', `Copied ${name} out of the Project`, chatId);
    if (p.to) deps.changed(p.to.id, '', true); else if (p.from) deps.changed(p.from.id, '', true);
    return { chatId: targetId, projectId };
  }

  const handlers: Record<string, DomainHandler> = {
    'project.activity.query': input => queryActivity(input),
    'project.members.list': input => listMembers(project(input)),
    'project.members.add': input => {
      const projectId = project(input), kind = input.kind as MemberKind, role = input.role as MemberRole;
      if (typeof input.name !== 'string') throw new Error('Name the member.');
      const m = members().add(projectId, { ...patchFrom(input), name: input.name, kind, role });
      record(projectId, 'member.added', `Added ${m.name} as ${ROLE_LABEL[m.role]}`, m.id);
      return m;
    },
    'project.members.update': input => {
      const projectId = project(input), { before, after } = members().update(projectId, id(input.id, 'member id'), patchFrom(input)), said = describeChanges(before, after, projectId);
      if (said.length) record(projectId, before.role !== after.role ? 'member.role' : 'member.access', `${before.name}: ${said.join(', ')}`, after.id);
      return after;
    },
    'project.members.revoke': async input => {
      const projectId = project(input), member = members().setRevoked(projectId, id(input.id, 'member id'), true);
      let stoppedRuns = 0;
      for (const chatId of liveRunsOf(projectId, member)) { try { await ctx.invoke('chat.stop', { id: chatId }); stoppedRuns++; } catch { /* already settled */ } }
      record(projectId, 'member.revoked', `Revoked ${member.name}’s access${stoppedRuns ? `; stopped ${plural(stoppedRuns, 'running task')}` : ''}`, member.id);
      return { member, stoppedRuns };
    },
    'project.members.restore': input => { const projectId = project(input), m = members().setRevoked(projectId, id(input.id, 'member id'), false); record(projectId, 'member.restored', `Restored ${m.name}’s access`, m.id); return m; },
    'project.chats.preview': input => preview(id(input.chatId, 'chat id'), input.projectId === null ? null : id(input.projectId, 'project id'), input.mode === 'copy' ? 'copy' : input.mode === 'move' ? 'move' : (() => { throw new Error('Invalid transfer mode.'); })()),
    'project.chats.transfer': input => transfer(input),
  };
  return {
    handlers, runAccess,
    purge(projectId: string) { members().purge(projectId); },
    dispose() { disposed = true; unsubscribe?.(); team?.close(); team = undefined; },
  };
}
