/**
 * Project activity filters (PRJ-11), the team model (PRJ-13) and explicit chat move/copy (PRJ-17).
 * Merged into ProjectsCommands; the projects domain serves every command here.
 */
import type { ChatPermissionMode, ProjectActivity } from '../protocol.ts';

// ── PRJ-11: activity filters ─────────────────────────────────────────────────
export type ActivityCategory = 'tasks' | 'runs' | 'decisions' | 'coordinator' | 'memory' | 'environment' | 'chats' | 'members' | 'project';
export const ACTIVITY_CATEGORIES: readonly { id: ActivityCategory; label: string }[] = [
  { id: 'tasks', label: 'Tasks' }, { id: 'runs', label: 'Agent runs' }, { id: 'decisions', label: 'Decisions' }, { id: 'coordinator', label: 'Coordinator' },
  { id: 'memory', label: 'Memory' }, { id: 'environment', label: 'Environments' }, { id: 'chats', label: 'Chats' }, { id: 'members', label: 'Members' }, { id: 'project', label: 'Project settings' },
];
const RUN_KINDS = new Set(['task.budget-exceeded', 'task.needs-input']);
/** Category of a stored activity kind. Mirrors ACTIVITY_CATEGORY_SQL in the task store; tests keep them in step. */
export function activityCategory(kind: string): ActivityCategory {
  if (kind.startsWith('task.run-') || RUN_KINDS.has(kind)) return 'runs';
  if (kind.startsWith('task.')) return 'tasks';
  if (kind.startsWith('decision.')) return 'decisions';
  if (kind.startsWith('coordinator.') || kind === 'project.coordinator') return 'coordinator';
  if (kind.startsWith('memory.')) return 'memory';
  if (kind.startsWith('environment.')) return 'environment';
  if (kind.startsWith('chat.')) return 'chats';
  if (kind.startsWith('member.')) return 'members';
  return 'project';
}
export type ActivityWindow = 'any' | '24h' | '7d' | '30d';
export const ACTIVITY_WINDOWS: readonly { id: ActivityWindow; label: string }[] = [{ id: 'any', label: 'Any time' }, { id: '24h', label: 'Last 24 hours' }, { id: '7d', label: 'Last 7 days' }, { id: '30d', label: 'Last 30 days' }];
const WINDOW_MS: Record<Exclude<ActivityWindow, 'any'>, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
/** ISO lower bound for a time window, or null for any time. */
export function activityWindowStart(window: ActivityWindow, now = Date.now()): string | null { return window === 'any' ? null : new Date(now - WINDOW_MS[window]).toISOString(); }
/** A page of filtered activity. `nextCursor` continues strictly older rows; `actors` lists every actor this Project has recorded, for the filter menu. */
export interface ActivityPage { items: ProjectActivity[]; truncated: boolean; nextCursor: string | null; actors: string[] }
export interface ActivityQuery { projectId: string; categories?: ActivityCategory[]; actors?: string[]; window?: ActivityWindow; before?: string; limit?: number }

// ── PRJ-13: team model ───────────────────────────────────────────────────────
export type MemberRole = 'owner' | 'editor' | 'viewer' | 'agent';
export type MemberKind = 'person' | 'agent';
export const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'editor', 'viewer', 'agent'];
export const ROLE_LABEL: Record<MemberRole, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer', agent: 'Agent' };
export const ROLE_HELP: Record<MemberRole, string> = {
  owner: 'Manages members and settings; runs up to Full access.',
  editor: 'Edits tasks and decisions; runs up to Workspace access.',
  viewer: 'Reads the Project; cannot edit or start runs.',
  agent: 'Runs delegated tasks; never gains access its requester lacks.',
};
/** The most a role may ever get. A member's own cap and the Project's access policy can only lower it. */
export const ROLE_CAP: Record<MemberRole, ChatPermissionMode> = { owner: 'full', editor: 'workspace', viewer: 'read-only', agent: 'full' };
/**
 * A Project member. Local-first: every Project starts with the local owner ("You") and the default agent; more members
 * are records ready for sync. `folderIds: null` means every folder the Project links; `secrets` names the secrets this
 * member lends to runs they request.
 */
export interface ProjectMember {
  id: string; projectId: string; name: string; kind: MemberKind; role: MemberRole;
  maxPermission: ChatPermissionMode | null; folderIds: string[] | null; secrets: string[];
  revokedAt: string | null; local: boolean; createdAt: string; updatedAt: string;
}
/** What a member (or a composition of members) may do right now inside the Project's access policy. */
export interface MemberAccess {
  memberIds: string[]; active: boolean; canEdit: boolean; canDispatch: boolean; canAdmin: boolean;
  permissionMode: ChatPermissionMode | null; folderIds: string[]; secrets: string[]; reason: string | null;
}
export interface AccessPolicy { permissionMode: ChatPermissionMode; folderIds: string[] }
export const LOCAL_OWNER_ID = 'local';
export const DEFAULT_AGENT_ID = 'agent';

const RANK: Record<ChatPermissionMode, number> = { 'read-only': 0, workspace: 1, full: 2 };
const lowest = (modes: (ChatPermissionMode | null | undefined)[]): ChatPermissionMode | null => {
  let out: ChatPermissionMode | null = null;
  for (const mode of modes) { if (mode === null) return null; if (mode && (out === null || RANK[mode] < RANK[out])) out = mode; }
  return out;
};
const none = (memberIds: string[], reason: string): MemberAccess => ({ memberIds, active: false, canEdit: false, canDispatch: false, canAdmin: false, permissionMode: null, folderIds: [], secrets: [], reason });

/** One member inside the Project policy: role cap ∩ member cap ∩ Project access; member folders ∩ Project folders. Revoked means nothing. */
export function memberAccess(member: ProjectMember, policy: AccessPolicy): MemberAccess {
  if (member.revokedAt) return none([member.id], `${member.name}’s access was revoked.`);
  const permissionMode = lowest([ROLE_CAP[member.role], member.maxPermission ?? undefined, policy.permissionMode]);
  const folderIds = member.folderIds === null ? [...policy.folderIds] : policy.folderIds.filter(id => member.folderIds!.includes(id));
  const viewer = member.role === 'viewer';
  return { memberIds: [member.id], active: true, canEdit: !viewer, canDispatch: !viewer, canAdmin: member.role === 'owner', permissionMode, folderIds, secrets: [...member.secrets], reason: viewer ? 'Viewers cannot start runs.' : null };
}

/**
 * Access for work several parties share — a requester, the agent that runs it, a coordinator that delegated it — is the
 * intersection of each: the lowest permission, only folders and secrets every party holds. Nobody lends what they lack.
 */
export function composeAccess(parts: readonly MemberAccess[]): MemberAccess {
  const memberIds = parts.flatMap(p => p.memberIds);
  if (!parts.length) return none(memberIds, 'No member requested this work.');
  const blocked = parts.find(p => !p.active);
  if (blocked) return none(memberIds, blocked.reason ?? 'A member’s access was revoked.');
  const refusal = parts.find(p => !p.canDispatch);
  const intersect = (lists: string[][]) => lists.reduce((acc, list) => acc.filter(id => list.includes(id)));
  return {
    memberIds, active: true, canEdit: parts.every(p => p.canEdit), canDispatch: !refusal, canAdmin: parts.every(p => p.canAdmin),
    permissionMode: lowest(parts.map(p => p.permissionMode)), folderIds: intersect(parts.map(p => p.folderIds)), secrets: intersect(parts.map(p => p.secrets)),
    reason: refusal?.reason ?? null,
  };
}

// ── PRJ-17: explicit chat move/copy ─────────────────────────────────────────
export type ChatTransferMode = 'move' | 'copy';
export interface ChatTransferPreview {
  chatId: string; title: string; mode: ChatTransferMode;
  from: { id: string; name: string } | null; to: { id: string; name: string } | null;
  /** Why the transfer cannot happen now, or null. */
  blocked: string | null;
  messages: number; running: boolean;
  folder: { id: string; name: string } | null;
  /** True when the chat's folder will be linked to the target Project so the chat keeps working where it is. */
  linksFolder: boolean;
  /** Project context the chat's next turn gains, loses and keeps. */
  context: { gains: string[]; loses: string[]; keeps: string[] };
  /** Memory banks the chat recalls from before and after. Saved memories never move with a chat. */
  memory: { before: string[]; after: string[] };
  notes: string[];
}

export interface ProjectTeamCommands {
  /** Filtered, paged Project activity: by category, actor and time window. Reads stored events only. */
  'project.activity.query': { input: ActivityQuery; output: ActivityPage };
  'project.members.list': { input: { projectId: string }; output: { members: ProjectMember[]; access: Record<string, MemberAccess>; policy: AccessPolicy } };
  'project.members.add': { input: { projectId: string; name: string; kind: MemberKind; role: MemberRole; maxPermission?: ChatPermissionMode | null; folderIds?: string[] | null; secrets?: string[] }; output: ProjectMember };
  /** The last active owner cannot be demoted, and the local owner stays an owner. */
  'project.members.update': { input: { projectId: string; id: string; name?: string; role?: MemberRole; maxPermission?: ChatPermissionMode | null; folderIds?: string[] | null; secrets?: string[] }; output: ProjectMember };
  /** Revocation takes effect at once: new runs are refused and running task runs this member requested or runs are stopped. */
  'project.members.revoke': { input: { projectId: string; id: string }; output: { member: ProjectMember; stoppedRuns: number } };
  'project.members.restore': { input: { projectId: string; id: string }; output: ProjectMember };
  /** Read-only preview of moving or copying a chat into (projectId) or out of (null) a Project. */
  'project.chats.preview': { input: { chatId: string; projectId: string | null; mode: ChatTransferMode }; output: ChatTransferPreview };
  /** Applies a previewed transfer. `confirm` must be true; a copy leaves the original where it was. */
  'project.chats.transfer': { input: { chatId: string; projectId: string | null; mode: ChatTransferMode; confirm: true }; output: { chatId: string; projectId: string | null } };
}
export const PROJECT_TEAM_COMMANDS = {
  'project.activity.query': true, 'project.members.list': true, 'project.members.add': true, 'project.members.update': true, 'project.members.revoke': true, 'project.members.restore': true,
  'project.chats.preview': true, 'project.chats.transfer': true,
} as const satisfies Record<keyof ProjectTeamCommands, true>;
