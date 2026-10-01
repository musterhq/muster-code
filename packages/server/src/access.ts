/**
 * Per-project access on a shared server. Owners and admins see everything. Members and viewers see:
 *  - projects they were granted (project_access: owner | editor | viewer, mirrored into the project's Roster as a person), and
 *  - chats in those projects, plus chats they started outside any project;
 *  - folders linked to a visible project or used by one of their visible chats.
 * Writing needs an org role of member or higher AND (project owner/editor, or being the chat's owner).
 */
import type { AgentEvent, Snapshot } from '../../agent-app/src/shared/protocol.ts';
import type { ProjectRole, UserRecord } from './store/types.ts';
import { PolicyError, ROLE_RANK, type CommandClass } from './policy.ts';

export interface AccessView {
  all: boolean;
  /** projectId -> effective project role */
  projects: Map<string, ProjectRole>;
  /** chats this user owns (started) */
  ownedChats: Set<string>;
  canWrite: boolean;
}

export function accessView(user: UserRecord, grants: ReadonlyArray<{ projectId: string; role: ProjectRole }>, owners: Map<string, string>): AccessView {
  const all = ROLE_RANK[user.role] >= ROLE_RANK.admin;
  const projects = new Map<string, ProjectRole>();
  for (const g of grants) projects.set(g.projectId, user.role === 'viewer' ? 'viewer' : g.role);
  const ownedChats = new Set<string>();
  for (const [chatId, userId] of owners) if (userId === user.id) ownedChats.add(chatId);
  return { all, projects, ownedChats, canWrite: ROLE_RANK[user.role] >= ROLE_RANK.member };
}

type ChatLike = { id: string; projectId?: string; folderId?: string };
export function canSeeProject(v: AccessView, projectId: string | null | undefined): boolean { return v.all || (!!projectId && v.projects.has(projectId)); }
export function canWriteProject(v: AccessView, projectId: string | null | undefined): boolean {
  if (v.all) return true;
  const role = projectId ? v.projects.get(projectId) : undefined;
  return v.canWrite && (role === 'owner' || role === 'editor');
}
export function canSeeChat(v: AccessView, chat: ChatLike | undefined): boolean {
  if (!chat) return v.all;
  return v.all || v.ownedChats.has(chat.id) || canSeeProject(v, chat.projectId);
}
export function canWriteChat(v: AccessView, chat: ChatLike | undefined): boolean {
  if (!chat) return v.all;
  return v.all || canWriteProject(v, chat.projectId) || (v.canWrite && !chat.projectId && v.ownedChats.has(chat.id));
}
export function visibleFolderIds(v: AccessView, snapshot: Snapshot): Set<string> | null {
  if (v.all) return null;
  const ids = new Set<string>();
  for (const p of snapshot.projects) if (canSeeProject(v, p.id)) for (const f of p.folderIds) ids.add(f);
  for (const c of snapshot.chats) if (canSeeChat(v, c) && c.folderId) ids.add(c.folderId);
  return ids;
}
export function writableFolderIds(v: AccessView, snapshot: Snapshot): Set<string> | null {
  if (v.all) return null;
  const ids = new Set<string>();
  for (const p of snapshot.projects) if (canWriteProject(v, p.id)) for (const f of p.folderIds) ids.add(f);
  for (const c of snapshot.chats) if (c.folderId && canWriteChat(v, c)) ids.add(c.folderId);
  return ids;
}

/** The snapshot this user may see. `activeChatId` is per browser, never another user's selection. */
export function filterSnapshot(v: AccessView, snapshot: Snapshot): Snapshot {
  if (v.all) return { ...snapshot, activeChatId: undefined };
  const chats = snapshot.chats.filter(c => canSeeChat(v, c));
  const chatIds = new Set(chats.map(c => c.id));
  const folders = visibleFolderIds(v, snapshot)!;
  return {
    ...snapshot, activeChatId: undefined, chats,
    projects: snapshot.projects.filter(p => canSeeProject(v, p.id)),
    folders: snapshot.folders.filter(f => folders.has(f.id)),
    ...(snapshot.attention ? { attention: { ...snapshot.attention, chats: snapshot.attention.chats.filter(a => chatIds.has(a.chatId)),
      totalRequests: snapshot.attention.chats.filter(a => chatIds.has(a.chatId)).reduce((n, a) => n + a.requests.length, 0) } } : {}),
  };
}

/** Events this user may receive. Anything carrying a chat or project they cannot see is dropped. */
export function filterEvent(v: AccessView, event: AgentEvent, snapshot: Snapshot): AgentEvent | null {
  if (event.type === 'chatSelected') return null; // a desktop-window concern; never steer another user's browser
  if (event.type === 'snapshot') return { type: 'snapshot', snapshot: filterSnapshot(v, event.snapshot) };
  if (v.all) return event;
  const e = event as unknown as Record<string, unknown>;
  if (typeof e.chatId === 'string' && !canSeeChat(v, snapshot.chats.find(c => c.id === e.chatId))) return null;
  if (typeof e.projectId === 'string' && !canSeeProject(v, e.projectId)) return null;
  if (typeof e.folderId === 'string') { const f = visibleFolderIds(v, snapshot)!; if (!f.has(e.folderId)) return null; }
  return event;
}

const PROJECT_ID_COMMANDS = /^project\.(update|linkFolder|unlinkFolder|preview|archive|restore|delete|instructions\.set|scheduler\.set)$/;
const CHAT_ID_COMMANDS = /^(chat\.|goals\.|subagents\.)/;
const OWNER_ONLY_PROJECT = new Set(['project.delete', 'project.archive', 'project.restore', 'project.members.add', 'project.members.update', 'project.members.revoke',
  'project.members.restore', 'project.members.decide', 'project.team.settings.set', 'project.update', 'project.linkFolder', 'project.unlinkFolder',
  // Governance: run policy, agent permissions and tool rules, instruction bundles, execution policies and the secret vault.
  'project.gov.settings.set', 'project.agent.gov.set', 'project.agent.files.save', 'project.agent.files.remove', 'project.agent.revisions.restore', 'project.tasks.policy.set',
  'project.secrets.list', 'project.secrets.audit', 'project.secrets.save', 'project.secrets.rollback', 'project.secrets.remove', 'project.secrets.grant', 'project.secrets.decide',
  // Work layer: a project's status and target date.
  'work.project.meta.set',
  // Wave 3: a reflection changes an agent's instructions; the setup interview starts the coordinator.
  'insight.reflect.run', 'insight.reflect.accept', 'insight.reflect.settings.set', 'insight.setup.interview',
  // Applying a coordinator proposal can change the shared mission (its goal operation), which project.update reserves for owners.
  'project.coordinator.apply']);
const AUTOMATION_BY_ID = /^automations\.(update|delete|pause|resume|runNow|runs|list)$/;
/** Commands whose result is server-wide and not filterable per project: admins only for everyone else. */
const ADMIN_READS = /^(work\.(overlay|inbox\.state)|search\.workspace|insight\.(costs|profile|reflect\.inbox)|automations\.gate\.list|paperclip\.(snapshot|dashboard|list|badge|memory|task|config\.get|inbox\.dismissed|import\.plan|watch)|settings\.(export|diagnostics|storage|storage\.preview)|providers\.diagnose|import\.|memory\.(export|archives|bank\.preview|import\.preview))/;

/**
 * Throws unless the user may run `command` on the resources named in `input`. `snapshot` is the runtime's current (unfiltered) state.
 */
export function authorizeResource(v: AccessView, command: string, cls: CommandClass, input: unknown, snapshot: Snapshot): void {
  if (v.all) return;
  if (ADMIN_READS.test(command)) throw new PolicyError('Only owners and admins can see server-wide data.', 403, 'forbidden');
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const write = cls !== 'read';
  const deny = (what: string) => { throw new PolicyError(`You do not have ${write ? 'write' : 'read'} access to this ${what}.`, 403, 'forbidden'); };

  // A workspace goal belongs to every project: only owners and admins edit it.
  if ((command === 'work.goals.save' && i.level === 'workspace') || (command === 'work.goals.remove' && i.workspace === true)) throw new PolicyError('Only owners and admins can edit workspace goals.', 403, 'forbidden');
  // Star and hide fold things away for everyone on a server, so they need the same write access as the thing they mark: a project by its id,
  // an agent by the project it belongs to.
  if (command === 'work.star.set') {
    const project = i.kind === 'project' ? (typeof i.id === 'string' ? i.id : undefined) : typeof i.projectId === 'string' ? i.projectId : undefined;
    if (!project || !canWriteProject(v, project)) throw new PolicyError('You do not have write access to the project this belongs to.', 403, 'forbidden');
  }
  // Automations act on a project, folder or chat named inside their target and schedule, so each of those is a write on its own. Managing
  // one by id would need its stored target resolved, which only the runtime knows: that, and listing them, is for owners and admins.
  if (command.startsWith('automations.')) {
    if (AUTOMATION_BY_ID.test(command)) throw new PolicyError('Only owners and admins can manage, run or list automations on a server.', 403, 'forbidden');
    const target = (i.target && typeof i.target === 'object' ? i.target : {}) as Record<string, unknown>, schedule = (i.schedule && typeof i.schedule === 'object' ? i.schedule : {}) as Record<string, unknown>;
    const asStr = (x: unknown) => typeof x === 'string' ? x : undefined;
    const projects = [asStr(target.projectId)].filter((x): x is string => Boolean(x)), folders = [asStr(target.folderId), asStr(schedule.folderId)].filter((x): x is string => Boolean(x)), chats = [asStr(target.chatId)].filter((x): x is string => Boolean(x));
    for (const p of projects) if (!canWriteProject(v, p)) throw new PolicyError('You do not have write access to the project this automation acts in.', 403, 'forbidden');
    if (folders.length) { const allowed = writableFolderIds(v, snapshot)!; if (folders.some(f => !allowed.has(f))) throw new PolicyError('You do not have write access to the folder this automation acts in.', 403, 'forbidden'); }
    for (const id of chats) { const chat = snapshot.chats.find(c => c.id === id); if (!chat || !canWriteChat(v, chat)) throw new PolicyError('You do not have write access to the chat this automation continues.', 403, 'forbidden'); }
  }
  let projectId = typeof i.projectId === 'string' ? i.projectId : undefined;
  if (!projectId && PROJECT_ID_COMMANDS.test(command) && typeof i.id === 'string') projectId = i.id;
  if (projectId !== undefined) {
    if (OWNER_ONLY_PROJECT.has(command) && v.projects.get(projectId) !== 'owner') deny('project (needs project owner)');
    if (write ? !canWriteProject(v, projectId) : !canSeeProject(v, projectId)) deny('project');
  }
  let chatId = typeof i.chatId === 'string' ? i.chatId : undefined;
  if (!chatId && CHAT_ID_COMMANDS.test(command) && typeof i.id === 'string' && command !== 'chat.create') chatId = i.id;
  if ((command === 'approval.respond' || command.startsWith('question.')) && typeof i.id === 'string') {
    chatId = snapshot.attention?.chats.find(a => a.requests.some(r => r.itemId === i.id))?.chatId;
    if (!chatId) deny('request');
  }
  if (chatId !== undefined) {
    const chat = snapshot.chats.find(c => c.id === chatId);
    if (!chat) deny('chat');
    if (write ? !canWriteChat(v, chat) : !canSeeChat(v, chat)) deny('chat');
  }
  if (command === 'chat.update' && typeof i.projectId === 'string' && !canWriteProject(v, i.projectId)) deny('destination project');
  const folderIds = [i.folderId, ...(Array.isArray(i.folderIds) ? i.folderIds : [])].filter((f): f is string => typeof f === 'string');
  if (folderIds.length) {
    const allowed = write ? writableFolderIds(v, snapshot)! : visibleFolderIds(v, snapshot)!;
    if (command === 'project.create') { if (folderIds.some(f => !allowed.has(f))) deny('folder'); }
    else if (folderIds.some(f => !allowed.has(f))) deny('folder');
  }
  // Anything left that names no resource is per-user data (personal chats, search) or runtime-wide reads the output filter narrows.
}

/** Narrows results that list chats or projects. */
export function filterOutput(v: AccessView, command: string, output: unknown, snapshot: Snapshot): unknown {
  if (v.all && command !== 'app.snapshot') return output;
  if (command === 'app.snapshot') return filterSnapshot(v, output as Snapshot);
  if (command === 'project.list' && Array.isArray(output)) return output.filter(p => canSeeProject(v, (p as { id: string }).id));
  if (command === 'chat.search' && Array.isArray(output)) return output.filter(r => canSeeChat(v, snapshot.chats.find(c => c.id === (r as { chatId: string }).chatId)));
  // Skill Studio test runs carry the reply of a read-only run in one project's folder: a member sees only the runs of projects they can see.
  if (command === 'studio.skill.inputs.list' && output && typeof output === 'object') {
    const list = output as { runs?: Array<{ projectId: string }> };
    return { ...list, runs: (list.runs ?? []).filter(r => canSeeProject(v, r.projectId)) };
  }
  if (command === 'paperclip.ledger' && output && typeof output === 'object') {
    const view = output as { entries: Array<{ chatId: string | null; projectId: string | null }> };
    return { ...view, entries: view.entries.filter(e => (e.projectId && canSeeProject(v, e.projectId)) || (e.chatId && canSeeChat(v, snapshot.chats.find(c => c.id === e.chatId)))) };
  }
  return output;
}
