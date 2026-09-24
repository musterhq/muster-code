import { addMemory, listMemory, searchMemory, inspectMemoryStore, isVisibleInScopes, projectMemoryScope } from './memory-adapter.ts';
import { HindsightService } from './hindsight-service.ts';
import { MemoryConfigStore, MemoryTombstones, electronSecretBox } from './memory-context.ts';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentEvent, ApprovalData, ApprovalDecision, Chat, ChatRecovery, Commands, PendingQuestion, PendingQuestionData, TimelineItem, WakeReason } from '../shared/protocol.ts';
import type { PendingAttentionSummary, AttentionRequest } from '../shared/attention-protocol.ts';
import { discoverLocalProviders } from './provider-discovery.ts';
import { CustomProviders } from './custom-providers.ts';
import { AgentStore } from './store.ts';
import { WorkspaceWatchService } from './workspace-watch.ts';
import {appendCommandOutput,finishCommandOutput,stripAnsi} from './command-output-buffer.ts';
import {OutputLog} from './output-log.ts';
import {ProjectEventLog} from './project-event-log.ts';
import { toolEventDetails } from './tool-event-details.ts';
import { applyProviderEvent, COMPACTION_TEXT, isForeignThreadEvent } from './context-telemetry.ts';
import { listFiles, readFile, searchFiles } from './files.ts';
import { readAsset } from './file-assets.ts';
import {readDocument} from './document-preview.ts';
import {readWorkbook} from './workbook-preview.ts';
import {FileAnnotations} from './file-annotations.ts';
import {resolveInside} from './paths.ts';
import { AgentModeReviewHost } from './review.ts';
import {dirtyFileCount, gitStatus, mutateGit, pushGit, listPullRequests, compareUrl} from './git-local.ts';
import {createEntry, moveFile} from './file-operations.ts';
import { isElicitationRequest, elicitationPolicy, elicitationResult, elicitationText, elicitationServer } from '../shared/computer-use.ts';
import { createProviderAdapter, ProviderPreDispatchError, type ProviderAdapter, type ProviderResult } from './provider.ts';
import { discoverPlugins, discoverSkills, invokedPluginContext, resolveAttachedSkill, resolveInvokedPlugins } from './plugin-library.ts';
import {providerAccessPolicy} from './provider-run-lifecycle.ts';
import {parseKillIntent, userProcessThreat, type UserProcessTarget, type UserProcessThreat} from './user-process-guard.ts';
import {reconcileProviderTurn, type ReconciliationInput, type ReconciliationResult} from './provider-reconciliation.ts';
import { ProjectTaskStore, type TaskStatus } from './project-tasks.ts';
import { ChatQueue, queueActionAfter } from './chat-queue.ts';
import { createNativeThreadBridge } from './codex-native.ts';
import { createNativeTurnObserver } from './native-turns.ts';
import { createNativeQueueMirror } from './native-queue.ts';
import { ChatAttachments, attachedFileLines } from './attachments.ts';
import { admissionRetryText, withAdmissionRetry } from './admission-retry.ts';
import { ContextLedger, HISTORY_WINDOW_EVENT, requestsConnectors, type ContextBlock } from './context-budget.ts';
import { createDomainHooks } from './domains/hooks.ts';
import { createDomains } from './domains/index.ts';
import type { DomainFactory } from './domains/types.ts';
import { createPowerEvents, isPowerState, type PowerOutcome, type PowerState } from './power-events.ts';
import { ARCHIVE_RUNNING_WARNING, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, MAX_QUEUED_MESSAGES, MAX_QUEUED_TEXT, REASONING_EFFORTS, type ReasoningEffort } from '../shared/protocol.ts';
import type { ChatGoal } from '../shared/domains/goals-protocol.ts';
import { firstReadyModel } from '../shared/domains/settings-protocol.ts';
import { createSkill } from './skill-authoring.ts';
import { exportChat, isChatExportFormat } from './chat-export.ts';
import { redactSecrets } from './secret-redaction.ts';
import { transcriptDigest } from './chat-fork.ts';
import { applyRestore, externalActions, ownedPaths, planRestore, resolveOwnedPaths } from './edit-restore.ts';
import { ChatSearchIndex } from './chat-search.ts';
import { isGitWorkTree } from './review-baseline.ts';
import type { ReviewBaselineInfo } from '../shared/domains/review-protocol.ts';
import type { EditRestorePreview } from '../shared/protocol.ts';
import { randomUUID } from 'node:crypto';
import { plural } from '../shared/wording.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid command input.');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max) throw new Error(`Invalid ${field}.`);
  return value;
}
function id(value: unknown): string {
  const result = text(value, 'id', 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error('Invalid id.');
  return result;
}
function ids(value: unknown, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`Attach at most ${max} files to one message.`);
  return value.map(id);
}
/** A full reorder list (pins, folders): every id, each once. */
function order(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Invalid order.');
  return value.map(id);
}
function detail(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 65536);
  try { return JSON.stringify(value ?? {}).slice(0, 65536); } catch { return 'Details unavailable'; }
}
interface ActiveRun { cwd: string; stopped: boolean; promise?: Promise<void>; retry: AbortController; seal?(): void }
interface PendingApproval { chatId: string; createdAt: string; resolve(decision: ApprovalDecision): void; timer: ReturnType<typeof setTimeout> }
/** `null` answers mean the question was dismissed, expired or interrupted: the provider gets a cancel, never empty answers. */
type QuestionAnswers = Record<string, {answers: string[]}> | null;
interface PendingQuestionRequest { chatId: string; createdAt: string; providerKey: string; itemId: string; questions: PendingQuestion[]; resolve(answers: QuestionAnswers): void; waiters: Array<(answers: QuestionAnswers) => void>; timer: ReturnType<typeof setTimeout> }
/** The codex app-server's own decline envelope; a question without `answers` is cancelled at the provider. */
const CANCELLED_REQUEST = {decision:'decline', action:'cancel', content:null, _meta:null};
/** How long a chat created right after launch waits for the first provider probe before resolving defaults. */
const PROVIDER_PROBE_GRACE_MS = 1_500;
const clip = (value: unknown, max = 8192) => typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;
/** Card data captured from a codex `…/requestApproval` request; the diff comes from the provider's own fileChange item. */
export function approvalData(method: string, params: Record<string, unknown>, changes?: unknown): ApprovalData {
  const kind: ApprovalData['kind'] = method.includes('fileChange') ? 'fileChange' : /mcp/i.test(method) ? 'mcp' : 'command';
  const command = Array.isArray(params.command) ? params.command.filter(part => typeof part === 'string').join(' ') : clip(params.command);
  const diff = Array.isArray(changes) ? changes.slice(0, 32).flatMap(change => change && typeof change === 'object' && typeof (change as Record<string, unknown>).path === 'string' ? [{path: String((change as Record<string, unknown>).path), ...(clip((change as Record<string, unknown>).diff, 200_000) ? {diff: clip((change as Record<string, unknown>).diff, 200_000)} : {}), ...(clip((change as Record<string, unknown>).kind, 32) ? {kind: clip((change as Record<string, unknown>).kind, 32)} : {})}] : []) : undefined;
  const args = params.arguments ?? params.args;
  return {method, kind, ...(command ? {command} : {}), ...(clip(params.cwd, 4096) ? {cwd: clip(params.cwd, 4096)} : {}), ...(clip(params.reason, 4096) ? {reason: clip(params.reason, 4096)} : {}), ...(diff?.length ? {diff} : {}),
    ...(clip(params.server ?? params.serverName, 256) ? {server: clip(params.server ?? params.serverName, 256)} : {}), ...(clip(params.tool ?? params.toolName, 256) ? {tool: clip(params.tool ?? params.toolName, 256)} : {}),
    ...(args != null ? {args: (typeof args === 'string' ? args : JSON.stringify(args, null, 2)).slice(0, 16_384)} : {})};
}

/** A live process group the user owns (in-app terminal or Commands-tab command). */
export interface UserProcessGroup { pgid: number; label: string; chatId: string; cwd?: string }
/** Tells the agent which live processes belong to the user so it never stops them as "orphans" (F41/F50). */
export function userProcessNote(groups: readonly UserProcessGroup[], cwd: string): string {
  // Ports are machine-wide, so every live user group matters; the ones in this folder come first.
  const inFolder = (group: UserProcessGroup) => !!group.cwd && (group.cwd === cwd || group.cwd.startsWith(`${cwd}/`));
  const relevant = [...groups].sort((a, b) => Number(inFolder(b)) - Number(inFolder(a))).slice(0, 16);
  if (!relevant.length) return '';
  return ['User-owned processes (started by the user in Muster, not by you). Never signal, kill or restart these process groups or their children, and do not free ports they hold; if a port is taken, use another port or ask:',
    ...relevant.map(group => `- process group ${group.pgid}: ${group.label.replace(/[\x00-\x1f]/g, ' ').slice(0, 80)}${group.cwd ? ` (cwd ${group.cwd.slice(0, 200)})` : ''}`)].join('\n');
}
export function createAgentService(options: { dataDir: string; onEvent(event: AgentEvent): void; userProcesses?: () => readonly UserProcessGroup[]; userProcessTargets?: () => Promise<readonly UserProcessTarget[]>; provider?: ProviderAdapter; reconcileProvider?: (input: ReconciliationInput) => Promise<ReconciliationResult>; domains?: readonly DomainFactory[] }) {
  const store = new AgentStore(options.dataDir);
  const queue = new ChatQueue(store);
  const attachments = new ChatAttachments(store.database(), options.dataDir);
  const domainHooks = createDomainHooks();
  const steered = new Map<string, string>();
  const folderNotices = new Set<string>();
  /** Static context blocks each provider thread already holds; unchanged blocks are not re-sent every turn. */
  const contextLedger = new ContextLedger();
  const projectTasks = new ProjectTaskStore(options.dataDir);
  const customProviders = new CustomProviders(options.dataDir);
  const annotations = new FileAnnotations(options.dataDir);
  const provider = options.provider ?? createProviderAdapter();
  /** R5: whether an agent command would stop a process the user started in Muster (terminal shell or Commands-tab command). */
  async function guardUserProcesses(command: unknown): Promise<UserProcessThreat | null> {
    try {
      if (!parseKillIntent(command)) return null;
      let groups: readonly UserProcessTarget[] = [];
      try { groups = await (options.userProcessTargets?.() ?? Promise.resolve(options.userProcesses?.() ?? [])); }
      catch { try { groups = options.userProcesses?.() ?? []; } catch { /* process registry unavailable */ } }
      return userProcessThreat(command, groups);
    } catch { return null; }
  }
  let hindsight: HindsightService | undefined;
  // Legacy hindsight.* commands honour the in-app Memory settings too, not only environment variables.
  let secretBox: ReturnType<typeof electronSecretBox> | null = null;
  const memoryConfig = new MemoryConfigStore(options.dataDir, () => secretBox === null ? secretBox = electronSecretBox() : secretBox);
  const hindsightClient = () => hindsight ??= new HindsightService({readConfig: () => memoryConfig.hindsight(), resolveFolderScope(folderId) {
    if (folderId === 'personal') return {kind: 'user', id: 'local'};
    const folder = folderFor(folderId);
    return {kind: 'workspace', id: folder.id};
  }});
  const runs = new Map<string, ActiveRun>();
  const reconciliations = new Set<string>();
  const providerSelections = new Set<string>();
  /** Reasoning effort last chosen in the composer, per chat; applied to queued follow-ups too. */
  const efforts = new Map<string, ReasoningEffort>();
  const approvals = new Map<string, PendingApproval>();
  const questions = new Map<string, PendingQuestionRequest>();
  const questionsByProviderKey = new Map<string, string>();
  let questionSequence = 0;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let closing = false;
  let disposal: Promise<void> | undefined;
  const invocations = new Set<Promise<unknown>>();
  store.recoverOrphanedRuns();
  for (const chat of store.snapshot().chats) {
    for (const item of store.timeline(chat.id)) {
      // The provider request ended with the previous process; the card stays readable but cannot be reopened.
      if ((item.kind === 'question' || item.kind === 'approval') && item.status === 'pending') store.updateItem(item.id, item.text, 'unavailable', {...item.data, expiredReason:'restart'});
      // A manual compaction request in flight when the app closed: no new process will ever settle this row.
      if (item.kind === 'notice' && item.data?.kind === 'compaction' && item.status === 'running') store.updateItem(item.id, 'Compaction status unknown: Muster restarted while it was in progress. History is unchanged.', 'failed', {...item.data, status: 'failed'});
    }
  }
  // PRJ-07: every Project change carries a durable per-Project sequence so clients detect and replay missed events.
  const projectFeed = new ProjectEventLog(store.database());
  const emit = (event: AgentEvent) => {
    if (disposed) return;
    if (event.type === 'projectChanged' && event.seq === undefined) { try { event = {...event, seq: projectFeed.append(event.projectId, event.taskId)}; } catch { /* An unsequenced event still reloads; the next replay resets. */ } }
    options.onEvent(event);
  };
  /** PER-05: agent tool output beyond the in-memory tail, pageable through processes.outputPage({itemId}). */
  const toolOutputLog = new OutputLog(join(options.dataDir, 'output-logs'));
  const toolOutputLogged = new Set<string>();
  const watchedFolders = new Set<string>();
  const watcher = new WorkspaceWatchService(
    folderId => emit({type:'workspaceChanged',folderId}),
    (folderId,error) => { watchedFolders.delete(folderId); emit({type:'notice',message:`Live file updates stopped: ${error.message}`}); },
  );
  /** Goals live in the goals domain table; chats carry them so the composer strip survives restarts. */
  const goalsByChat = (): Map<string, ChatGoal> => {
    // Before the domains exist (during construction) there are simply no goals to show.
    try { return new Map(((domains.handlers.get('goals.list')?.({}) ?? []) as ChatGoal[]).map(goal => [goal.chatId, goal])); } catch { return new Map(); }
  };
  /** A folder moved or deleted outside Muster shows as missing (with Relink) before a send fails. Stat results live 10s. */
  const folderStats = new Map<string, {at: number; missing: boolean}>();
  const folderMissing = (path: string) => {
    const at = Date.now(), cached = folderStats.get(path);
    if (cached && at - cached.at < 10_000) return cached.missing;
    let missing = true; try { missing = !statSync(path).isDirectory(); } catch { /* unreadable counts as missing */ }
    if (folderStats.size > 256) folderStats.clear();
    folderStats.set(path, {at, missing}); return missing;
  };
  const snapshot = () => {
    const stored = store.snapshot(), goals = goalsByChat();
    const current = {...stored, folders: stored.folders.map(folder => folderMissing(folder.path) ? {...folder, missing: true} : folder), chats: stored.chats.map(chat => { const decorated = queue.decorate(chat), goal = goals.get(chat.id); return goal ? {...decorated, goal} : decorated; })};
    const requests = new Map<string, AttentionRequest[]>();
    const add = (chatId: string, request: AttentionRequest) => {
      const group = requests.get(chatId) ?? []; group.push(request); requests.set(chatId, group);
    };
    // Only an owned live resolver makes a persisted request actionable. Never
    // copy provider payloads, question options, commands, or answers here.
    for (const [itemId, pending] of approvals) add(pending.chatId, {itemId, kind:'approval', createdAt:pending.createdAt, sourceLabel:'Provider approval'});
    for (const [itemId, pending] of questions) add(pending.chatId, {itemId, kind:'question', createdAt:pending.createdAt, sourceLabel:'Provider question'});
    const attention: PendingAttentionSummary = {totalRequests:0, chats:[]};
    for (const chat of current.chats) {
      const items = requests.get(chat.id); if (!items?.length) continue;
      items.sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.itemId.localeCompare(b.itemId));
      attention.chats.push({chatId:chat.id, chatTitle:chat.title, approvalCount:items.filter(item => item.kind === 'approval').length, questionCount:items.filter(item => item.kind === 'question').length, requests:items});
      attention.totalRequests += items.length;
    }
    attention.chats.sort((a,b) => a.requests[0]!.createdAt.localeCompare(b.requests[0]!.createdAt) || a.chatId.localeCompare(b.chatId));
    return {...current, attention};
  };
  const state = () => emit({ type: 'snapshot', snapshot: snapshot() });
  const publishedTimelineRevisions = new Map<string, number>();
  const timeline = (chatId: string) => {
    const after = publishedTimelineRevisions.get(chatId) ?? 0;
    const patch = store.timelineChanges(chatId, after);
    if (patch.revision > after) {
      publishedTimelineRevisions.set(chatId, patch.revision);
      emit({type: 'timelinePatch', chatId, patch: {...patch, after}});
    }
  };
  const scheduleTimeline = (chatId: string) => {
    if (!timers.has(chatId)) timers.set(chatId, setTimeout(() => { timers.delete(chatId); if (!disposed) timeline(chatId); }, 33));
  };
  const searchIndex = new ChatSearchIndex({
    chats: () => store.snapshot().chats,
    revision: chatId => store.timelineRevision(chatId),
    items: chatId => store.timeline(chatId),
  });
  const chatFor = (chatId: string): Chat => { const chat = store.chat(chatId); if (!chat) throw new Error('Chat does not exist.'); return chat; };
  projectTasks.recoverUnlinkedRuns();
  for(const task of projectTasks.listRunningTasks()){
    if(!task.runRequestId)continue;
    if(!task.runChatId){projectTasks.failTaskStart({projectId:task.projectId,id:task.id,requestId:task.runRequestId,chatId:'',reason:'The saved Project task run has no linked chat. Reopen it before starting new work.'});continue;}
    const linked=store.chat(task.runChatId);
    if(!linked){projectTasks.failTaskStart({projectId:task.projectId,id:task.id,requestId:task.runRequestId,chatId:task.runChatId,reason:'The linked agent chat is missing. Reopen the task and inspect Project activity before retrying.'});continue;}
    if(linked.status==='completed'||linked.status==='failed'||linked.status==='interrupted')projectTasks.settleRunForChat(linked.id,linked.status,linked.error);
    else if(linked.status==='idle')projectTasks.failTaskStart({projectId:task.projectId,id:task.id,requestId:task.runRequestId,chatId:task.runChatId,reason:'The app stopped before the linked agent chat accepted its request. Open the chat to review the saved draft.'});
  }
  const folderFor = (folderId: unknown) => { const folder = store.folder(id(folderId)); if (!folder) throw new Error('Folder does not exist.'); return folder; };
  const workspaceMemoryRoot = (folder: {id: string; path: string}) => {
    const root = join(options.dataDir, 'workspace-memory', folder.id);
    // One-time move of memory written by earlier builds into <repo>/.muster/data.
    const legacy = join(folder.path, '.muster', 'data', 'memory.jsonl');
    const target = join(root, '.muster', 'data', 'memory.jsonl');
    try {
      if (existsSync(legacy) && !existsSync(target)) { mkdirSync(join(root, '.muster', 'data'), {recursive: true}); copyFileSync(legacy, target); }
    } catch { /* keep going with the private root; the legacy file is left untouched */ }
    return root;
  };
  const memoryContext = (folderId: unknown) => {
    if (folderId === undefined || folderId === null) return {cwd: options.dataDir, scopes: [{kind:'user',id:'local'}]};
    // PRJ-X5: a Project's own bank, addressed as domains/memory.ts's virtual `project:<id>` folderId
    // (same format as its own scopeOf/resolveScope). This keeps memoryContext total instead of
    // throwing so legacy-store fallbacks (e.g. generateModelText) work for a Project scope too; it
    // does not by itself make Project-shared facts (held in memory.ts's own memory_shared table)
    // visible through this legacy listMemory/addMemory path.
    if (typeof folderId === 'string' && folderId.startsWith('project:')) {
      const projectId = folderId.slice(8), project = store.project(projectId);
      if (!project) throw new Error('Project does not exist.');
      // The memory core knows no 'project' scope kind ("Invalid memory scope kind: project"): a Project bank is its own
      // store (its own cwd) addressed with a core workspace scope, so list/search/add/inspect all work for it.
      return {cwd: join(options.dataDir, 'project-memory', project.id), scopes: [projectMemoryScope(project.id)]};
    }
    const folder = folderFor(folderId);
    // Private memory never lives inside the user's repository (a commit or PR could publish it).
    return {cwd: workspaceMemoryRoot(folder), scopes: [{kind:'workspace',id: folder.id}]};
  };
  const requestedMemoryScopes = (value: unknown, expected: Array<{kind:string; id:string}>) => {
    if (!Array.isArray(value) || value.length !== expected.length) throw new Error('Memory scopes must match the selected context.');
    const actual = value.map((entry) => {
      const candidate = object(entry);
      const scope = {kind: text(candidate.kind, 'scope kind', 32), id: text(candidate.id, 'scope id', 128)};
      return scope.kind === 'project' ? projectMemoryScope(scope.id) : scope;
    });
    if (actual.some((scope, index) => scope.kind !== expected[index]!.kind || scope.id !== expected[index]!.id)) throw new Error('Memory scopes must match the selected context.');
    return actual;
  };
  function finishApproval(itemId: string, pending: PendingApproval, decision: ApprovalDecision, status: string) {
    if (approvals.get(itemId) !== pending) return;
    clearTimeout(pending.timer); approvals.delete(itemId);
    const item = store.item(itemId);
    if (item) store.updateItem(itemId, item.text, status, item.data);
    const toolItemId = typeof item?.data?.toolItemId === 'string' ? item.data.toolItemId : undefined, tool = toolItemId ? store.item(toolItemId) : undefined;
    if (tool?.data?.awaitingApproval === itemId) { const {awaitingApproval: _cleared, ...rest} = tool.data; store.updateItem(tool.id, tool.text, tool.status, rest); }
    timeline(pending.chatId); state(); pending.resolve(decision);
  }
  function finishQuestion(itemId: string, pending: PendingQuestionRequest, answers: QuestionAnswers, status: string, receiptAnswers?: Record<string, {answers:string[]}>) {
    if (questions.get(itemId) !== pending) return;
    clearTimeout(pending.timer); questions.delete(itemId);
    if (questionsByProviderKey.get(pending.providerKey) === itemId) questionsByProviderKey.delete(pending.providerKey);
    const item = store.item(itemId);
    if (item) store.updateItem(itemId, item.text, status, receiptAnswers ? {...item.data, answers:receiptAnswers} : item.data);
    timeline(pending.chatId); state();
    pending.resolve(answers); pending.waiters.splice(0).forEach(resolve => resolve(answers));
  }
  function settleApprovals(chatId: string) {
    for (const [itemId, pending] of approvals) if (pending.chatId === chatId) finishApproval(itemId, pending, 'decline', 'interrupted');
  }
  const compactions = new Map<string, string>();
  /** Settles a manual compaction row, or appends the automatic one. The source transcript here is never trimmed. */
  function compactionCompleted(chatId: string) {
    // A compacted thread summarises earlier messages: static context goes out again on the next turn.
    contextLedger.forget(chatId);
    const manual = compactions.get(chatId); compactions.delete(chatId);
    const data = {kind:'compaction', status:'completed', ...(manual ? {manual:true} : {})};
    if (manual) store.updateItem(manual, 'Context compacted', 'completed', data);
    else store.appendItem(chatId, 'notice', COMPACTION_TEXT, 'completed', data);
    timeline(chatId);
  }
  function settleQuestions(chatId: string) {
    for (const [itemId, pending] of questions) if (pending.chatId === chatId) finishQuestion(itemId, pending, null, 'interrupted');
  }
  function validateRunnableModel(model: string, providerId: string | undefined) {
    if (!providerId) throw new Error('No model is connected yet. Connect a model (Settings › Providers), then pick it in the composer.');
    const listed = provider.info().filter(candidate => candidate.id === providerId);
    if (!listed.length) throw new Error(`The provider “${providerId}” is not available on this Mac. Pick another model for this chat.`);
    // A provider that reports no model list runs whatever model the chat names; the provider checks it at dispatch.
    const entry = listed.find(candidate => candidate.available && (candidate.models.some(candidateModel => candidateModel.id === model) || candidate.models.length === 0));
    if (!entry) throw new Error(`Model ${model || '(none)'} is unavailable through the configured provider. Choose an available model.`);
    return entry;
  }
  /** Provider and model for a chat nobody chose one for: Project → folder → user default, else the first ready provider. */
  function newChatModel(input: { folderId?: string; projectId?: string }): { providerId: string; model: string; effort?: ReasoningEffort } {
    const defaults = domainHooks.chatDefaults(input);
    if (defaults.providerId && defaults.model?.trim()) return { providerId: defaults.providerId, model: defaults.model.trim(), ...(defaults.effort ? { effort: defaults.effort } : {}) };
    return firstReadyModel(provider.info());
  }
  async function send(chatId: string, prompt: string, requestId: string, skill?: string | string[], attachmentIds: string[] = [], invoked: {pluginIds?: string[]; effort?: ReasoningEffort; reuseUserItemId?: string} = {}) {
    let chat = chatFor(chatId);
    const folder = chat.folderId ? folderFor(chat.folderId) : undefined;
    const skillIds = [...new Set(skill === undefined ? [] : Array.isArray(skill) ? skill : [skill])];
    const attachedSkills = [];
    for (const skillId of skillIds) {
      const attachedSkill = await resolveAttachedSkill(skillId, folder ? [folder.path] : []);
      if (!attachedSkill) throw new Error('The selected skill is unavailable or outside this chat’s allowed skill roots. Refresh the skill list and try again.');
      attachedSkills.push(attachedSkill);
    }
    const attachedSkill = attachedSkills[0];
    const plugins = await resolveInvokedPlugins(invoked.pluginIds ?? []);
    const effort = invoked.effort ?? efforts.get(chatId);
    const fingerprint = attachedSkills.length > 1 || plugins.length
      ? createHash('sha256').update(JSON.stringify({ text: prompt, skills: attachedSkills.map(entry => [entry.id, entry.digest]), plugins: plugins.map(entry => [entry.id, entry.digest]), ...(attachmentIds.length ? {attachmentIds} : {}) })).digest('hex')
      : attachedSkill || attachmentIds.length
      ? createHash('sha256').update(JSON.stringify({ text: prompt, ...(attachedSkill ? {skillId: attachedSkill.id, skillDigest: attachedSkill.digest} : {}), ...(attachmentIds.length ? {attachmentIds} : {}) })).digest('hex')
      : createHash('sha256').update(prompt).digest('hex');
    const receipt = store.receipt(requestId);
    if (receipt) { if (receipt.chatId !== chatId || receipt.fingerprint !== fingerprint) throw new Error('Request identity conflicts with its original message.'); return {runId: receipt.runId}; }
    if (chat.recovery?.kind === 'recovery-needed') throw new Error('This attempt may still be running at the provider. Check its status before sending another message. Your draft is retained.');
    if (!prompt.trim() && attachmentIds.length === 0) throw new Error('Write a message first.');
    if (chat.archived) throw new Error('Restore this chat before sending.');
    if (providerSelections.has(chatId)) throw new Error('Wait for the provider selection to finish.');
    validateRunnableModel(chat.model,chat.providerId);
    const project = chat.projectId ? store.snapshot().projects.find(p => p.id === chat.projectId) : undefined;
    const context = project ? `Project: ${project.name}\nShared goal: ${project.goal || '(not set)'}` : '';
    const skillContext = [...attachedSkills.map(entry => `Selected skill: ${entry.name} (${entry.provenance})\n\nApply these user-selected skill instructions to the current request:\n<skill-instructions>\n${entry.content}\n</skill-instructions>`), invokedPluginContext(plugins)].filter(Boolean).join('\n\n');
    const defaultCwd = folder?.path ?? join(options.dataDir, 'scratch', chatId);
    const cwd = await domainHooks.runEnvironment(chat, defaultCwd);
    if (folder || cwd !== defaultCwd) { if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Selected folder is unavailable.'); }
    else await fs.mkdir(cwd, {recursive: true, mode: 0o700});
    if (closing || disposed) throw new Error('Agent runtime is stopping. No new attempt was dispatched.');
    // File preflight awaits can overlap a future-run access/mode change. Use
    // the latest policy at the atomic receipt boundary, then keep it immutable.
    chat = chatFor(chatId);
    if (chat.archived) throw new Error('Restore this chat before sending.');
    if (chat.recovery?.kind === 'recovery-needed') throw new Error('Check the unresolved provider attempt before sending. Your draft is retained.');
    if (providerSelections.has(chatId)) throw new Error('Wait for the provider selection to finish.');
    const selectedProvider=validateRunnableModel(chat.model,chat.providerId);
    const bindingId=selectedProvider.bindingId??selectedProvider.id;
    if (chat.providerBindingId && chat.providerBindingId!==bindingId) throw new Error('The selected provider account or profile changed. Select it again before sending. Your draft is retained.');
    const nativeMatches=chat.providerThreadProviderId===selectedProvider.id && chat.providerThreadBindingId===bindingId;
    if (!chat.providerBindingId || (chat.providerThreadId && !nativeMatches)) {
      if (chat.providerThreadId && !nativeMatches) store.appendItem(chatId,'notice','This provider will start a fresh conversation. The displayed chat history is retained.','completed');
      chat=store.updateChat(chatId,{providerId:selectedProvider.id,providerBindingId:bindingId,...(!nativeMatches?{providerThreadId:null,providerTurnId:null,providerThreadProviderId:null,providerThreadBindingId:null}:{})});
    }
    const access = providerAccessPolicy(chat);
    // A fork (or a replaced turn) starts a fresh provider conversation: carry the visible history once, bounded.
    const digest = store.needsDigest(chatId) ? transcriptDigest(store.timeline(chatId)) : '';
    const files = attachments.resolve(chatId, attachmentIds);
    const accepted = store.recordSend(chatId, requestId, prompt, fingerprint, {...(files.length ? {userData: {attachments: files.map(({path: _path, ...ref}) => ({...ref, state: 'sent'}))}, within: () => attachments.markSent(attachmentIds)} : {}), ...(invoked.reuseUserItemId ? {reuseUserItemId: invoked.reuseUserItemId} : {})});
    if (accepted.replay) return {runId: accepted.runId};
    if (!digest) store.clearDigest(chatId);
    // Several chats may work in one folder (as in Codex). Warn once per chat
    // when a sibling's earlier attempt was never confirmed; it may still edit here.
    if (folder) for (const other of store.snapshot().chats) {
      if (other.id === chatId || other.folderId !== folder.id || other.recovery?.kind !== 'recovery-needed' || folderNotices.has(`${chatId}:${other.id}`)) continue;
      folderNotices.add(`${chatId}:${other.id}`);
      store.appendItem(chatId,'notice',`“${other.title}” in this folder has an unconfirmed provider attempt that may still change files here.`,'completed',{kind:'folder-unresolved',chatId:other.id});
    }
    const attachedImages = files.filter(file => file.kind === 'image');
    // A model that cannot take image input must not receive them silently stripped
    // (Codex replaces them with a placeholder and the model guesses). Say so, visibly.
    const blind = attachedImages.length > 0 && selectedProvider.models.find(entry => entry.id === chat.model)?.images === false;
    const images = blind ? [] : attachedImages.map(file => file.path);
    if (blind) {
      const modelName = selectedProvider.models.find(entry => entry.id === chat.model)?.name ?? chat.model;
      store.appendItem(chatId, 'notice', `${modelName} (${selectedProvider.name}) can’t view images, so ${attachedImages.length === 1 ? `“${attachedImages[0]!.name}” was` : `${attachedImages.length} images were`} not sent to the model. Switch to a vision model to include ${attachedImages.length === 1 ? 'it' : 'them'}.`, 'completed', {kind: 'images-unsupported', names: attachedImages.map(file => file.name)});
    }
    const fileLines = [attachedFileLines(files), blind ? `The user attached ${attachedImages.length === 1 ? 'an image' : `${attachedImages.length} images`} (${attachedImages.map(file => file.name).join(', ')}) that this model cannot view. Do not guess or describe ${attachedImages.length === 1 ? 'its' : 'their'} contents; tell the user you cannot see ${attachedImages.length === 1 ? 'it' : 'them'} if it matters.` : ''].filter(Boolean).join('\n');
    const run: ActiveRun = {cwd, stopped: false, retry: new AbortController()}; runs.set(chatId, run); state(); timeline(chatId);
    let segment: TimelineItem | undefined;
    let producedAssistant = false;
    const toolIds = new Map<string, string>();
    /** Local start time per provider tool item, for a measured duration. */
    const toolStarted = new Map<string, number>();
    /** Provider reasoning items whose text arrived as deltas; their completion must not repeat it. */
    const reasoningStreamed = new Set<string>();
    const append = (kind: 'assistant' | 'reasoning', delta: string) => {
      if (disposed || !runs.has(chatId) || !delta) return;
      if (kind === 'assistant') producedAssistant = true;
      if (segment && segment.kind !== kind) seal();
      if (!segment) segment = store.appendItem(chatId, kind, '', 'running');
      segment = {...segment, text: segment.text + delta}; store.updateItem(segment.id, segment.text, 'running'); scheduleTimeline(chatId);
    };
    const seal = () => { if (segment) store.updateItem(segment.id, segment.text, 'completed'); segment = undefined; };
    run.seal = seal;
    run.promise = (async () => {
      try {
        const persistIdentity = (threadId: string, turnId?: string) => {
          if (disposed || runs.get(chatId) !== run) return;
          if (!threadId || threadId.length > 256 || /[\x00-\x1f]/.test(threadId) || (turnId !== undefined && (!turnId || turnId.length > 256 || /[\x00-\x1f]/.test(turnId)))) throw new Error('The provider returned an invalid attempt identity.');
          const current=store.chat(chatId);
          // The new provider thread now holds the digest; later sends continue it natively.
          if (digest) store.clearDigest(chatId);
          store.updateChat(chatId,{providerThreadId:threadId,providerThreadProviderId:chat.providerId,providerThreadBindingId:chat.providerBindingId??null,...(turnId ? {providerTurnId:turnId} : current?.providerThreadId !== threadId ? {providerTurnId:null} : {})}); state();
        };
        // No registered hooks: dispatch in the same tick, exactly as before the seam existed.
        const hooked = domainHooks.hasRunHooks();
        const contributed = hooked ? await domainHooks.contributePrompt({chat, ...(folder ? {folder} : {}), ...(project ? {project} : {}), prompt}) : {text:'', sources:[] as string[], blocks:[] as ContextBlock[]};
        const runOptions = hooked ? await domainHooks.resolveRunOptions(chat) : {};
        if (hooked) await domainHooks.runStarted({chat, runId: accepted.runId, cwd});
        if (disposed) return;
        let ownership = '';
        try { ownership = userProcessNote(options.userProcesses?.() ?? [], cwd); } catch { /* process registry unavailable */ }
        // Static context (project packet, directives, recalled notes, the process note) rides in the user message, which
        // the provider keeps in its thread. Send each unchanged block once per provider thread, not on every turn.
        // Attached skills and a fork digest are per-request and always sent.
        const projectBlock: ContextBlock | undefined = context ? {label:'project', text:context} : undefined;
        const ownershipBlock: ContextBlock | undefined = ownership ? {label:'processes', text:ownership} : undefined;
        const staticBlocks = [projectBlock, ...contributed.blocks, ownershipBlock].filter((block): block is ContextBlock => !!block);
        const dispatchThread = digest ? null : chat.providerThreadId ?? null;
        const pendingBlocks = new Set(contextLedger.pending(chatId, dispatchThread, staticBlocks));
        let compactedInRun = false;
        /** HTTP routes: how many user turns Muster's trimmed history still holds after this turn. */
        let retainedTurns: number | undefined;
        const sentSources = contributed.blocks.filter(block => pendingBlocks.has(block)).map(block => block.label);
        if (sentSources.length) { store.appendItem(chatId,'notice',`Context from ${sentSources.join(', ')}`,'completed',{kind:'context-sources',sources:sentSources}); scheduleTimeline(chatId); }
        const sent = (block: ContextBlock | undefined) => block && pendingBlocks.has(block) ? block.text : '';
        const preamble = [sent(projectBlock), digest, skillContext, ...contributed.blocks.map(sent), sent(ownershipBlock)].filter(Boolean).join('\n\n');
        const request = [prompt, fileLines].filter(Boolean).join('\n\n');
        const contextualPrompt = preamble ? `${preamble}\n\nCurrent user request:\n${request}` : request;
        let retryNotice: TimelineItem | undefined;
        let retryReason = 'admission' as 'admission' | 'transient';
        const stoppedBeforeDispatch: ProviderResult = {status:'failed',finalMessage:'',dispatchState:'not-dispatched',recovery:{kind:'cancelled',retryable:false,reason:'Stopped before the request was sent.'}};
        const attempt = () => run.stopped ? Promise.resolve(stoppedBeforeDispatch) : provider.run({ chat: {...chat,providerTurnId:undefined,recovery:undefined}, cwd, prompt: contextualPrompt,
          ...(images.length ? {images} : {}), ...(effort ?? runOptions.reasoningEffort ? {reasoningEffort: effort ?? runOptions.reasoningEffort} : {}), ...(requestsConnectors(prompt) ? {connectorsRequested: true} : {}),
          ...(runOptions.configOverrides ? {configOverrides: runOptions.configOverrides as Record<string, string | number | boolean | string[]>} : {}), ...(runOptions.developerInstructions ? {developerInstructions: runOptions.developerInstructions} : {}),
          onDelta: delta => append('assistant', delta), onReasoning: delta => append('reasoning', delta),
          onThreadReady: threadId => persistIdentity(threadId),
          onTurnAccepted: identity => persistIdentity(identity.threadId,identity.turnId),
          onEvent(method, params) {
            if (disposed) return;
            const telemetry = isForeignThreadEvent(params, store.chat(chatId)?.providerThreadId) ? null : applyProviderEvent(store.contextTelemetry(chatId), method, params);
            if (telemetry) { store.setContextTelemetry(chatId, telemetry); emit({ type: 'contextTelemetry', chatId, telemetry }); }
            domainHooks.providerEvent({ chat, method, params });
            if (method === HISTORY_WINDOW_EVENT) { if (typeof params.retainedUserTurns === 'number') retainedTurns = params.retainedUserTurns; return; }
            if (method === 'thread/compacted') { seal(); compactionCompleted(chatId); compactedInRun = true; }
            const item = params.item && typeof params.item === 'object' ? params.item as Record<string, unknown> : params;
            const type = String(item.type ?? '');
            // Reasoning text streams through onReasoning (summary deltas). These events only frame it:
            // each reasoning item is its own row, summary parts are separated, and a summary the
            // provider only reported on completion (no deltas) still reaches the transcript.
            if (method.startsWith('item/reasoning/') || type === 'reasoning') {
              const parentThread = store.chat(chatId)?.providerThreadId;
              if (typeof params.threadId === 'string' && parentThread && params.threadId !== parentThread) return;
              const reasoningId = String(item.id ?? params.itemId ?? '');
              if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') { if (reasoningId) reasoningStreamed.add(reasoningId); return; }
              if (method === 'item/reasoning/summaryPartAdded') { if (Number(params.summaryIndex) > 0 && segment?.kind === 'reasoning' && segment.text) append('reasoning', '\n\n'); return; }
              if (method === 'item/started' && segment?.kind === 'reasoning') { seal(); return; }
              if (method === 'item/completed' && reasoningId && !reasoningStreamed.has(reasoningId)) {
                const parts = (value: unknown) => Array.isArray(value) ? value.map(part => typeof part === 'string' ? part : part && typeof part === 'object' && typeof (part as {text?: unknown}).text === 'string' ? (part as {text: string}).text : '').filter(Boolean) : [];
                const summary = parts(item.summary), content = parts(item.content);
                const reported = (summary.length ? summary : content).join('\n\n');
                if (reported) { if (segment?.kind === 'reasoning' && segment.text) seal(); append('reasoning', reported); seal(); }
              }
              return;
            }
            if (type === 'agentMessage' || type === 'userMessage' || !method.startsWith('item/')) return;
            const itemId = String(item.id ?? params.itemId ?? '');
            if (!itemId) return;
            if (method === 'item/started' || method === 'item/completed') {
              if (!toolIds.has(itemId)) seal();
              const finished = method.endsWith('completed');
              const status = !finished ? 'running' : item.status === 'failed' || item.error != null || item.success === false || (typeof item.exitCode === 'number' && item.exitCode !== 0) ? 'failed' : item.status === 'interrupted' ? 'interrupted' : item.status === 'cancelled' || item.status === 'declined' ? 'cancelled' : 'completed';
              let local = toolIds.get(itemId);
              const previous = local ? store.item(local) : undefined;
              const label = detail(item.command ?? item.title ?? item.name ?? item.tool ?? item.query ?? previous?.data?.name ?? item.type);
              const streamed = typeof previous?.data?.output === 'string' ? previous.data.output : '';
              const supplied = item.aggregatedOutput ?? item.output;
              const finalOutput = supplied == null ? null : stripAnsi(typeof supplied === 'string' ? supplied : detail(supplied));
              // Some harnesses finish with only the last output chunk. Preserve an
              // already received stream when it contains that final suffix.
              const buffered=finishCommandOutput({output:streamed,truncated:previous?.data?.outputTruncated===true},finalOutput);
              const output=buffered.output;
              const body = label + (output ? '\n' + output : '');
              // Child-thread (subagent) items arrive on the parent connection; tag them so they can be told apart.
              const parentThread = store.chat(chatId)?.providerThreadId, childThread = typeof params.threadId === 'string' && parentThread && params.threadId !== parentThread ? params.threadId : undefined;
              // Providers report durationMs 0 (or nothing) for many items; measure it here instead (F11/F27).
              if (!finished) { if (!toolStarted.has(itemId)) toolStarted.set(itemId, Date.now()); }
              const details = toolEventDetails(item), startedAt = toolStarted.get(itemId);
              if (finished && startedAt !== undefined) { toolStarted.delete(itemId); if (!(typeof details.durationMs === 'number' && details.durationMs > 0)) details.durationMs = Date.now() - startedAt; }
              else if (finished && !(typeof details.durationMs === 'number' && details.durationMs > 0) && typeof previous?.data?.durationMs === 'number') details.durationMs = previous.data.durationMs;
              const metadata = {...details,providerItemId:itemId,type:type || previous?.data?.type,name:label,output,outputTruncated:buffered.truncated,...(childThread ? {threadId:childThread} : {}),...(finished ? {awaitingApproval:undefined} : {})};
              if (!local) { local = store.appendItem(chatId, 'tool', body, status, metadata).id; toolIds.set(itemId, local); }
              else store.updateItem(local, body, status, {...store.item(local)?.data,...metadata});
              // A tool that streamed no deltas logs its full final output once.
              if (finished) { if (finalOutput && !toolOutputLogged.has(local)) toolOutputLog.append(chatId, `item:${local}`, finalOutput); toolOutputLogged.delete(local); }
              scheduleTimeline(chatId);
            } else if (method.endsWith('/outputDelta')) {
              const local = toolIds.get(itemId); const previous = local ? store.item(local) : undefined;
              if (previous?.status === 'running') {
                if (params.delta) { toolOutputLog.append(chatId, `item:${previous.id}`, stripAnsi(String(params.delta))); toolOutputLogged.add(previous.id); }
                const buffered=appendCommandOutput({output:String(previous.data?.output??''),truncated:previous.data?.outputTruncated===true},String(params.delta??''));
                const output=stripAnsi(buffered.output);
                store.updateItem(previous.id, String(previous.data?.name ?? '') + '\n' + output, 'running', {...previous.data, output,outputTruncated:buffered.truncated});
                scheduleTimeline(chatId);
              }
            }
          },
          async onRequest(method, params) {
            if (disposed || closing || run.stopped || runs.get(chatId) !== run) return undefined;
            seal();
            if (method === 'item/tool/requestUserInput') {
              const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
              if (rawQuestions.length === 0 || rawQuestions.length > 32) throw new Error('Invalid provider questions.');
              const parsed = rawQuestions.flatMap((raw): PendingQuestion[] => {
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid provider question.');
                const value = raw as Record<string, unknown>;
                const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim().slice(0, 128) : '';
                const question = typeof value.question === 'string' ? value.question.slice(0, 4096) : '';
                if (!id || !question) throw new Error('Invalid provider question.');
                const rawOptions = value.options == null ? [] : value.options;
                if (!Array.isArray(rawOptions) || rawOptions.length > 32) throw new Error('Invalid provider question options.');
                const options = rawOptions.flatMap((option): PendingQuestion['options'] => {
                  if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error('Invalid provider question option.');
                  const candidate = option as Record<string, unknown>;
                  if (typeof candidate.label !== 'string' || !candidate.label.trim()) throw new Error('Invalid provider question option.');
                  return [{ label: candidate.label.trim().slice(0, 512), ...(typeof candidate.description === 'string' ? { description: candidate.description.slice(0, 2048) } : {}), ...(typeof candidate.value === 'string' ? { value: candidate.value.slice(0, 512) } : {}) }];
                });
                const isOther = typeof value.isOther === 'boolean' ? value.isOther : undefined;
                const isSecret = value.isSecret === true;
                return [{ id, header: typeof value.header === 'string' && value.header.trim() ? value.header.slice(0, 256) : id, question, options, allowCustomAnswer: options.length === 0 || (isOther ?? (value.allowCustomAnswer !== false)), multiSelect: value.multiSelect === true, ...(isOther !== undefined ? {isOther} : {}), ...(isSecret ? {isSecret:true} : {}) }];
              });
              const ids = new Set<string>();
              for (const question of parsed) { if (ids.has(question.id)) throw new Error('Provider question IDs must be unique.'); ids.add(question.id); if (!question.allowCustomAnswer && question.options.length === 0) throw new Error('Provider question has no selectable answer.'); }
              // Codex itemId is the request identity. turnId is only a parent
              // turn and may carry multiple identical questions, so it cannot
              // be used to coalesce requests when itemId is absent.
              const identity = typeof params.itemId === 'string' && params.itemId ? params.itemId : `fallback-${++questionSequence}`;
              const providerKey = `${chatId}:${identity}:${JSON.stringify(parsed)}`;
              const existingId = questionsByProviderKey.get(providerKey);
              const existing = existingId ? questions.get(existingId) : undefined;
              if (existing) {
                if (existing.waiters.length >= 8) throw new Error('Too many duplicate provider question requests.');
                return await new Promise<Record<string, unknown>>(resolve => existing.waiters.push(answers => resolve(answers ? { answers } : CANCELLED_REQUEST)));
              }
              const item = store.appendItem(chatId, 'question', 'The provider needs your input.', 'pending', { method, questions: parsed } satisfies PendingQuestionData);
              timeline(chatId);
              return await new Promise<Record<string, unknown>>(resolve => {
                let pending!: PendingQuestionRequest;
                const timer = setTimeout(() => {
                  finishQuestion(item.id, pending, null, 'expired');
                }, 10 * 60_000);
                pending = { chatId, createdAt:item.createdAt, providerKey, itemId: item.id, questions: parsed, resolve: answers => resolve(answers ? { answers } : CANCELLED_REQUEST), waiters: [], timer };
                questions.set(item.id, pending); questionsByProviderKey.set(providerKey, item.id); wakeForAttention(chatId); state();
              });
            }
            if (isElicitationRequest(method)) {
              const policy = elicitationPolicy(access.permissionMode);
              if (policy !== 'ask') return elicitationResult(policy === 'accept');
              const server = elicitationServer(params);
              const text = elicitationText(params);
              const item = store.appendItem(chatId, 'approval', `${server || 'Computer use'} asks: ${text}`, 'pending', { method, kind: 'mcp', elicitation: true, reason: text, ...(server ? { server } : {}) });
              const approvalId = item.id;
              timeline(chatId);
              const decision = await new Promise<ApprovalDecision>(resolve => {
                let pending!: PendingApproval;
                const timer = setTimeout(() => finishApproval(approvalId, pending, 'decline', 'expired'), 10 * 60_000);
                pending = { chatId, createdAt: item.createdAt, resolve, timer };
                approvals.set(approvalId, pending); wakeForAttention(chatId); state();
              });
              return elicitationResult(decision !== 'decline');
            }
            if ((access.permissionMode !== 'workspace' && access.permissionMode !== 'full') || !/^item\/(commandExecution|fileChange|mcpToolCall)\/requestApproval$/.test(method)) return undefined;
            // R5: a command that would signal the user's own processes always becomes a card. Full access asks the
            // provider about every non-trusted command (approvalPolicy 'untrusted') so it can be stopped here; the rest is accepted at once.
            const threat = method === 'item/commandExecution/requestApproval' ? await guardUserProcesses(params.command) : null;
            if (access.permissionMode === 'full' && !threat) return {decision: 'accept'};
            const change = typeof params.itemId === 'string' && toolIds.has(params.itemId) ? store.item(toolIds.get(params.itemId)!)?.data?.changes : params.changes;
            const data: ApprovalData = {...approvalData(method, params, change), ...(threat ? {reason: threat.message, protectsUserProcess: true} : {})};
            const toolItemId = typeof params.itemId === 'string' ? toolIds.get(params.itemId) : undefined;
            const item = store.appendItem(chatId, 'approval', detail(params.command ?? params.reason ?? params.changes ?? data.tool ?? data.kind), 'pending', {...data, ...(toolItemId ? {toolItemId} : {})});
            const approvalId = item.id;
            // F60: the tool row the provider already started is blocked on this card, not running. Flag it so the
            // row reads "Waiting for approval"; finishApproval (or the item's completion) clears the flag.
            const blocked = toolItemId ? store.item(toolItemId) : undefined;
            if (blocked?.status === 'running') store.updateItem(blocked.id, blocked.text, blocked.status, {...blocked.data, awaitingApproval: approvalId});
            timeline(chatId);
            const decision = await new Promise<ApprovalDecision>(resolve => {
              let pending!: PendingApproval;
              const timer = setTimeout(() => finishApproval(approvalId, pending, 'decline', 'expired'), 10 * 60_000);
              pending = {chatId, createdAt:item.createdAt, resolve, timer};
              approvals.set(approvalId, pending); wakeForAttention(chatId); state();
            });
            // Never let the provider remember a stop-the-user's-process approval for the rest of the session.
            return {decision: threat && decision === 'acceptForSession' ? 'accept' : decision};
          },
        });
        const retried = await withAdmissionRetry(attempt, {signal: run.retry.signal, onWait(wait) {
          if (disposed) return;
          retryReason = wait.reason ?? 'admission';
          const data = {kind:'admission-retry', reason: retryReason, attempt: wait.attempt, max: wait.max, retryAt: wait.retryAt};
          if (retryNotice) store.updateItem(retryNotice.id, admissionRetryText(wait), 'running', data);
          else retryNotice = store.appendItem(chatId, 'notice', admissionRetryText(wait), 'running', data);
          timeline(chatId);
        }});
        let result = retried.result;
        if (retryNotice && !disposed) {
          const sent = !retried.cancelled && result.recovery?.kind !== 'admission-rejected' && result.recovery?.kind !== 'failed';
          const lead = retryReason === 'transient' ? 'Provider attempt did not start.' : 'Provider at capacity.';
          store.updateItem(retryNotice.id, retried.cancelled ? 'Stopped while waiting to retry the provider.' : sent ? `${lead} Sent after ${retried.retries} ${retried.retries === 1 ? 'retry' : 'retries'}.` : `${lead} Gave up after ${retried.retries} automatic retries.`, retried.cancelled ? 'cancelled' : sent ? 'completed' : 'failed', {...store.item(retryNotice.id)?.data, retryAt: null});
        }
        if (retried.cancelled) result = {...result, recovery: {kind:'cancelled',retryable:false,reason:'Stopped while waiting to retry the provider. No turn was dispatched.'}};
        else if (retried.retries && result.recovery?.kind === 'failed') result = {...result, recovery: {...result.recovery, reason: `${result.recovery.reason} (after ${retried.retries} automatic ${retried.retries === 1 ? 'retry' : 'retries'})`}};
        else if (retried.retries && result.recovery?.kind === 'admission-rejected') {
          // Carry the trailing "Resets in N min." sentence (if any) from the pre-retry reason
          // instead of dropping it when the message is rebuilt for the gave-up-after-N-retries case.
          const eta = / Resets [^.]*\.$/.exec(result.recovery.reason)?.[0] ?? '';
          result = {...result, recovery: {...result.recovery, reason: `Provider admission stayed unavailable after ${retried.retries} automatic retries. No turn was dispatched; your message is back in the composer.${eta}`}};
        }
        if (disposed) return;
        seal();
        if (!producedAssistant && result.finalMessage) store.appendItem(chatId, 'assistant', result.finalMessage, 'completed');
        const recovery: ChatRecovery | undefined = result.recovery ?? (run.stopped ? {kind:'cancelled',retryable:false,reason:'Stopped.'} : result.status === 'failed' ? {kind:'recovery-needed',retryable:false,reason:'The provider attempt did not settle with confirmed outcome. Check its saved turn before continuing; the prompt was not resent.'} : undefined);
        if (result.threadId) persistIdentity(result.threadId,result.turnId);
        // Only a turn the provider actually took delivered its context blocks to the thread.
        if (result.status === 'completed' && result.dispatchState !== 'not-dispatched' && !compactedInRun) contextLedger.delivered(chatId, store.chat(chatId)?.providerThreadId, [...pendingBlocks], retainedTurns);
        else if (result.dispatchState !== 'not-dispatched') contextLedger.forget(chatId);
        if (recovery) store.appendItem(chatId,'notice',recovery.reason,recovery.kind,{recovery,providerThreadId:store.chat(chatId)?.providerThreadId,providerTurnId:store.chat(chatId)?.providerTurnId});
        const restoreDraft=result.status==='failed' && result.dispatchState==='not-dispatched' && recovery?.kind!=='recovery-needed' && store.chat(chatId)?.draft==='';
        if (restoreDraft && attachmentIds.length) attachments.restage(attachmentIds);
        store.updateChat(chatId, {status:recovery?.kind === 'recovery-needed' ? 'failed' : run.stopped ? 'interrupted' : result.status,recovery:recovery ?? null,error:recovery?.reason ?? result.errorMessage ?? null,...(restoreDraft?{draft:prompt}:{})});
      } catch (error) {
        if (!disposed) {
          seal();
          const recovery: ChatRecovery = error instanceof ProviderPreDispatchError
            ? {kind:'failed',retryable:true,reason:error.message}
            : run.stopped ? {kind:'cancelled',retryable:false,reason:'Stopped.'}
            : {kind:'recovery-needed',retryable:false,reason:'The provider attempt ended without a confirmed outcome. Check its saved turn before continuing; the prompt was not resent.'};
          store.appendItem(chatId,'notice',recovery.reason,recovery.kind,{recovery});
          const restore = error instanceof ProviderPreDispatchError && store.chat(chatId)?.draft==='';
          if (restore && attachmentIds.length) attachments.restage(attachmentIds);
          store.updateChat(chatId,{status:recovery.kind==='cancelled'?'interrupted':'failed',error:recovery.reason,recovery,...(restore?{draft:prompt}:{})});
        }
      } finally {
        settleApprovals(chatId); settleQuestions(chatId); runs.delete(chatId);
        if (!disposed) { const timer = timers.get(chatId); if (timer) clearTimeout(timer); timers.delete(chatId); timeline(chatId); let finalChat=store.chat(chatId);
          // A result the user has not seen yet: marked unread until the chat is opened again.
          if(finalChat&&(finalChat.status==='completed'||finalChat.status==='failed')&&store.activeChatId()!==chatId&&store.setUnread(chatId,true))finalChat=store.chat(chatId);
          // First completed exchange: a chat still on its default name gets a summary title (renamed chats never do).
          if(finalChat?.status==='completed'&&store.settleTitle(chatId))finalChat=store.chat(chatId);
          // CHAT-15: "until new activity" wakes when a run settles (one transition, unread + one notification).
          if(finalChat?.snoozeUntilActivity&&wake(chatId,'activity'))finalChat=store.chat(chatId);
          if(finalChat&&(finalChat.status==='completed'||finalChat.status==='failed'||finalChat.status==='interrupted')){const task=projectTasks.settleRunForChat(chatId,finalChat.status,finalChat.error);if(task)emit({type:'projectChanged',projectId:task.projectId,taskId:task.id});}state();
          if (finalChat) { domainHooks.runSettled({chat:finalChat,runId:accepted.runId,status:finalChat.status}); afterRun(chatId, finalChat.status); }
          // A turn the app-server started itself (native goal or queue) while this run settled is adopted now.
          nativeTurns.drain(chatId); }
      }
    })();
    return {runId: accepted.runId};
  }
  /** A completed run hands the queue head to chat.send; any other ending pauses the queue until the user resumes it (Codex). */
  function afterRun(chatId: string, status: Chat['status']) {
    if (!store.queue(chatId).length || closing || disposed) return;
    if (queueActionAfter(status) === 'dispatch') { dispatchQueued(chatId); return; }
    queue.pause(chatId, status === 'interrupted' ? 'interrupted' : 'failed'); state();
  }
  function dispatchQueued(chatId: string) {
    if (runs.has(chatId) || closing || disposed || queue.paused(chatId)) return;
    const chat = store.chat(chatId);
    if (!chat || chat.archived || chat.recovery?.kind === 'recovery-needed' || chat.status === 'running' || chat.status === 'stopping') return;
    // A refused head waits for Retry, Edit or Delete instead of being skipped.
    if (queue.list(chatId)[0]?.error) return;
    // A native turn is about to be adopted, or the app-server holds (or is taking) the head: it dispatches, not Muster.
    if (nativeTurns.pendingTurn(chatId)) return;
    const head = queue.list(chatId)[0];
    if (head && nativeQueue.pending(head.id)) return;
    if (nativeQueue.owns(chatId)) { void nativeQueue.start(chatId).then(started => { if (!started) dispatchQueued(chatId); }); return; }
    const item = queue.take(chatId);
    if (!item) return;
    state();
    const pending = send(chatId, item.text, item.requestId, item.skillIds?.length ? item.skillIds : undefined, item.attachmentIds, {pluginIds: item.pluginIds ?? [], ...(item.effort ? {effort: item.effort} : {})}).catch(error => {
      if (disposed) return;
      const reason = error instanceof Error ? error.message : String(error);
      if (!store.receipt(item.requestId)) queue.restore(chatId, item, reason);
      store.appendItem(chatId, 'notice', `Queued message was not sent: ${reason}`, 'failed', {kind:'queue-failed', queueId:item.id});
      timeline(chatId); state();
    });
    invocations.add(pending); void pending.finally(() => invocations.delete(pending));
  }
  /** Validates queued/steered chips now, so a stale chip fails while the user is still looking. */
  async function queueChips(chat: Chat, p: Record<string, unknown>): Promise<{skillIds?: string[]; pluginIds?: string[]; effort?: ReasoningEffort}> {
    const list = (value: unknown, field: string) => { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 8) throw new Error(`Attach at most 8 ${field}s to one message.`); return [...new Set(value.map(entry => text(entry, `${field} id`, 4096)))]; };
    const skillIds = list(p.skillIds, 'skill'), pluginIds = list(p.pluginIds, 'plugin');
    if (p.effort !== undefined && !REASONING_EFFORTS.includes(p.effort as ReasoningEffort)) throw new Error('Invalid reasoning effort.');
    const folder = chat.folderId ? store.folder(chat.folderId) : undefined;
    for (const skillId of skillIds) if (!(await resolveAttachedSkill(skillId, folder ? [folder.path] : []))) throw new Error('The selected skill is unavailable or outside this chat’s allowed skill roots. Refresh the skill list and try again.');
    await resolveInvokedPlugins(pluginIds);
    return {...(skillIds.length ? {skillIds} : {}), ...(pluginIds.length ? {pluginIds} : {}), ...(p.effort !== undefined ? {effort: p.effort as ReasoningEffort} : {})};
  }
  /** Joins the live turn. Codex refusals (review/compact turns) come back as `reason`; anything else means "queue it". */
  async function steerRun(chat: Chat, message: string, requestId: string, chips: {skillIds?: string[]; pluginIds?: string[]; effort?: ReasoningEffort}): Promise<{steered: boolean; reason?: string}> {
    const chatId = chat.id, run = runs.get(chatId);
    if (!run || run.stopped || !provider.steer) return {steered:false};
    const instructions = await chipInstructions(chat, chips);
    const outcome = await provider.steer(chatId, instructions ? `${instructions}\n\nCurrent user request:\n${message}` : message);
    if (outcome !== true) return typeof outcome === 'object' ? {steered:false, reason:outcome.refused} : {steered:false};
    // Effort cannot change inside a live turn; it applies from the next one.
    if (chips.effort) efforts.set(chatId, chips.effort);
    if (steered.size >= 256) steered.delete(steered.keys().next().value!);
    steered.set(requestId, chatId);
    if (disposed) return {steered:true};
    run.seal?.();
    store.appendItem(chatId, 'user', message, undefined, {steered:true, requestId, ...(chips.skillIds?.length ? {skillIds:chips.skillIds} : {}), ...(chips.pluginIds?.length ? {pluginIds:chips.pluginIds} : {})});
    timeline(chatId);
    return {steered:true};
  }
  async function chipInstructions(chat: Chat, chips: {skillIds?: string[]; pluginIds?: string[]}): Promise<string> {
    const folder = chat.folderId ? store.folder(chat.folderId) : undefined;
    const skills = (await Promise.all((chips.skillIds ?? []).map(skillId => resolveAttachedSkill(skillId, folder ? [folder.path] : [])))).filter(entry => entry !== null);
    return [...skills.map(entry => `Selected skill: ${entry.name} (${entry.provenance})\n\nApply these user-selected skill instructions to the current request:\n<skill-instructions>\n${entry.content}\n</skill-instructions>`), invokedPluginContext(await resolveInvokedPlugins(chips.pluginIds ?? []))].filter(Boolean).join('\n\n');
  }
  const touchesFiles = (item: TimelineItem) => item.kind === 'tool' && (item.data?.type === 'fileChange' || (Array.isArray(item.data?.changes) && item.data.changes.length > 0));
  /** Replace-in-place is offered only when nothing is running and no later work edited files: files are never rewound. */
  async function editOptions(chat: Chat, itemId: string): Promise<Commands['chat.editOptions']['output']> {
    const items = store.timeline(chat.id), index = items.findIndex(item => item.id === itemId);
    if (index < 0) throw new Error('That message is no longer in this chat.');
    if (items[index]!.kind !== 'user') throw new Error('Only your own messages can be edited.');
    const reason = busy(chat) || approvalsFor(chat.id) || providerSelections.has(chat.id) ? 'Stop the current run to replace messages in this chat.'
      : chat.recovery?.kind === 'recovery-needed' ? 'Check the unconfirmed provider attempt before replacing messages.'
      : items.slice(index + 1).some(touchesFiles) ? 'Files were edited after this message and would not be rewound.' : undefined;
    let dirtyFiles = 0;
    // Every file, including each one inside a new folder (a status row counts a whole untracked folder as one).
    if (chat.folderId) { try { dirtyFiles = await dirtyFileCount(folderFor(chat.folderId).path); } catch { /* not a repository, or git unavailable */ } }
    return {canReplace: !reason, ...(reason ? {replaceBlockedReason: reason} : {}), dirtyFiles};
  }
  /** CHAT-18: what "Replace and restore files" would put back, and why it cannot when it cannot. `baseline` is the tree to restore from. */
  async function restorePreview(chat: Chat, itemId: string): Promise<EditRestorePreview & {baseline?: string; root?: string}> {
    const items = store.timeline(chat.id), index = items.findIndex(item => item.id === itemId);
    if (index < 0) throw new Error('That message is no longer in this chat.');
    const edited = items[index]!;
    if (edited.kind !== 'user') throw new Error('Only your own messages can be edited.');
    const later = items.slice(index + 1), external = externalActions(later);
    const blocked = (reason: string): EditRestorePreview => ({available: false, reason, files: [], left: [], external});
    if (busy(chat) || approvalsFor(chat.id) || providerSelections.has(chat.id)) return blocked('Stop the current run before restoring files.');
    if (chat.recovery?.kind === 'recovery-needed') return blocked('Check the unconfirmed provider attempt before restoring files.');
    if (!chat.folderId) return blocked('This chat has no folder, so there are no files to restore.');
    const folder = store.folder(chat.folderId);
    if (!folder || folderMissing(folder.path)) return blocked('The chat’s folder is missing. Relink it before restoring files.');
    const sharing = store.snapshot().chats.find(other => other.id !== chat.id && other.folderId === folder.id && busy(other));
    if (sharing) return blocked(`“${sharing.title}” is working in this folder. Wait for it to finish before restoring files.`);
    if (!(await isGitWorkTree(folder.path))) return blocked('This folder is not a Git repository, so no file snapshots were taken.');
    // The snapshot taken when this message's own turn started: after the message, before the next prompt.
    const nextPrompt = later.find(item => item.kind === 'user' && item.data?.steered !== true && item.data?.forked !== true);
    // Through the review domain, so a capture still in flight is awaited instead of read as missing.
    const list = await domains.handlers.get('review.baselines')?.({chatId: chat.id}) as ReviewBaselineInfo[] | undefined;
    const baseline = edited.data?.forked === true ? undefined : (list ?? []).find(entry => entry.folderId === folder.id && entry.at >= edited.createdAt && (!nextPrompt || entry.at < nextPrompt.createdAt));
    if (!baseline) return blocked('No file snapshot was taken before this message’s turn.');
    if (!baseline.treeSha) return blocked(baseline.reason ?? 'No file snapshot was taken before this message’s turn.');
    let real = folder.path; try { real = await fs.realpath(folder.path); } catch { /* keep the stored path */ }
    const roots = [...new Set([folder.path, real])];
    // A path another chat also changed since this message is shared work: it is left alone, never restored.
    const shared = new Set(store.snapshot().chats.filter(other => other.id !== chat.id && other.folderId === folder.id && other.updatedAt >= edited.createdAt)
      .flatMap(other => ownedPaths(store.timeline(other.id).filter(item => item.createdAt >= edited.createdAt), roots)));
    const owned = (await resolveOwnedPaths(later, roots)).filter(path => !shared.has(path));
    if (!owned.length) return blocked('Muster did not change any files after this message.');
    const plan = await planRestore(folder.path, baseline.treeSha, owned);
    return {available: true, runId: baseline.runId, files: plan.files, left: plan.left, external, baseline: baseline.treeSha, root: folder.path};
  }
  function fork(chatId: string, fromItemId?: string | null): Chat {
    const chat = store.forkChat(chatId, fromItemId);
    state(); timeline(chat.id); return chatFor(chat.id);
  }
  /** Waits (once, at most PROVIDER_PROBE_GRACE_MS) for the provider catalog's first probe to settle. */
  let providerProbe: Promise<void> | undefined;
  function firstProviderProbe(): Promise<void> {
    return providerProbe ??= new Promise<void>(resolve => {
      const timer = setTimeout(resolve, PROVIDER_PROBE_GRACE_MS); timer.unref?.();
      Promise.resolve(provider.ready?.()).catch(() => undefined).then(() => { clearTimeout(timer); resolve(); });
    });
  }
  const busy = (chat: Chat) => runs.has(chat.id) || chat.status === 'running' || chat.status === 'stopping';
  const approvalsFor = (chatId: string) => [...approvals.values(), ...questions.values()].some(pending => pending.chatId === chatId);
  /** Attach a folder to an idle chat. The provider thread ran in the old directory, so the next send starts fresh here. */
  function attachFolder(chat: Chat, folderId: string): void {
    if (chat.folderId === folderId) return;
    if (busy(chat) || providerSelections.has(chat.id)) throw new Error('Wait for this run before changing the chat’s folder.');
    if (chat.recovery?.kind === 'recovery-needed') throw new Error('Resolve the unconfirmed provider attempt before changing the chat’s folder.');
    const folder = folderFor(folderId);
    const project = chat.projectId ? store.project(chat.projectId) : undefined;
    if (project && !project.folderIds.includes(folder.id)) throw new Error('This folder is not part of the chat’s Project. Add it to the Project first.');
    const hadThread = Boolean(chat.providerThreadId);
    store.rebindChat(chat.id, {folderId: folder.id});
    store.appendItem(chat.id, 'notice', `Now working in ${folder.name}.${hadThread ? ' The next message starts a fresh provider conversation there; the history above is kept.' : ''}`, 'completed', {kind:'folder-attached', folderId: folder.id});
    timeline(chat.id);
  }
  async function deleteChat(chatId: string): Promise<void> {
    for (const item of queue.list(chatId)) queue.remove(chatId, item.id);
    const run = runs.get(chatId);
    if (run) {
      run.stopped = true; run.retry.abort(); settleApprovals(chatId); settleQuestions(chatId);
      await provider.stop(chatId).catch(() => undefined);
      // Never delete under a run that can still write: it would recreate rows for a chat that no longer exists.
      const settled = await Promise.race([run.promise?.then(() => true, () => true) ?? Promise.resolve(true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10_000))]);
      if (!settled || runs.has(chatId)) throw new Error('The run did not stop in time, so the chat was kept. Try deleting it again.');
    }
    settleApprovals(chatId); settleQuestions(chatId);
    try { domains.handlers.get('goals.clear')?.({chatId}); } catch { /* no goal */ }
    const timer = timers.get(chatId); if (timer) clearTimeout(timer); timers.delete(chatId);
    store.deleteChat(chatId);
    publishedTimelineRevisions.delete(chatId); efforts.delete(chatId);
    await fs.rm(join(options.dataDir, 'attachments', chatId), {recursive: true, force: true});
    await provider.release?.(chatId).catch(() => undefined);
    state();
  }
  /** Moves a chat into (or out of) a Project. A new chat adopts the Project's folder; one with history keeps its folder, which is linked to the Project (PRJ-17). */
  function moveToProject(chat: Chat, projectId: string | null): void {
    if ((chat.projectId ?? null) === projectId) return;
    if (runs.has(chat.id) || chat.status === 'running' || chat.status === 'stopping') throw new Error('Wait for this run before moving the chat.');
    const project = projectId ? store.project(projectId) : undefined;
    if (projectId && !project) throw new Error('Project not found.');
    const history = store.timeline(chat.id).some(item => item.kind === 'user');
    if (project && history && !chat.folderId && project.folderIds.length) throw new Error('This chat has messages but no folder. Start a new chat in the Project instead.');
    const folderId = !project ? chat.folderId ?? null : chat.folderId && (history || project.folderIds.includes(chat.folderId)) ? chat.folderId : project.folderIds[0] ?? null;
    if (project && folderId && !project.folderIds.includes(folderId)) store.database().prepare('UPDATE projects SET folder_ids = ? WHERE id = ?').run(JSON.stringify([...project.folderIds, folderId]), project.id);
    store.database().prepare('UPDATE chats SET project_id = ?, folder_id = ? WHERE id = ?').run(projectId, folderId, chat.id);
  }
  const startingProjectTasks=new Map<string,Promise<Commands['project.tasks.start']['output']>>();
  async function startProjectTask(input:Commands['project.tasks.start']['input']):Promise<Commands['project.tasks.start']['output']>{
    const projectId=id(input?.projectId),taskId=id(input?.id),requestId=id(input?.requestId),project=store.snapshot().projects.find(item=>item.id===projectId);
    if(!project)throw new Error('Project not found.');
    const task=projectTasks.assertTaskProject(projectId,taskId);
    if(!Number.isSafeInteger(input.revision)||input.revision<0)throw new Error('Invalid revision.');
    const inFlightKey=`${projectId}:${taskId}:${requestId}`,inFlight=startingProjectTasks.get(inFlightKey);
    if(inFlight)return inFlight;
    if(task.runRequestId===requestId&&task.runChatId){const receipt=store.receipt(requestId);if(!receipt)throw new Error('This task start has no confirmed provider receipt. Open its linked chat and inspect it before retrying.');return {task,chatId:task.runChatId,runId:receipt.runId};}
    if(task.status==='running')throw new Error('This task already has an active run. Open its linked chat.');
    if(task.runChatId&&task.runRequestId){const previous=store.chat(task.runChatId);if(previous&&(previous.status==='running'||previous.status==='stopping'||previous.recovery?.kind==='recovery-needed'))throw new Error('The prior agent attempt may still be active. Open its linked chat and resolve its status before running this task again.');}
    if(project.folderIds.length===0)throw new Error('Attach a folder to this Project before starting an agent task.');
    let folderId=input.folderId===undefined?undefined:id(input.folderId);
    if(folderId&&!project.folderIds.includes(folderId))throw new Error('Choose a folder attached to this Project.');
    if(!folderId&&project.folderIds.length===1)folderId=project.folderIds[0];
    if(!folderId&&project.folderIds.length>1)throw new Error('Choose the folder this task should work in.');
    const run=startProjectTaskOnce({projectId,taskId,revision:input.revision,requestId,folderId});
    startingProjectTasks.set(inFlightKey,run);
    try{return await run;}finally{if(startingProjectTasks.get(inFlightKey)===run)startingProjectTasks.delete(inFlightKey);}
  }
  async function startProjectTaskOnce(input:{projectId:string;taskId:string;revision:number;requestId:string;folderId?:string}):Promise<Commands['project.tasks.start']['output']>{
    const project=store.snapshot().projects.find(item=>item.id===input.projectId)!;
    const task=projectTasks.assertTaskProject(input.projectId,input.taskId);
    projectTasks.assertCanStartTask({projectId:input.projectId,id:input.taskId,revision:input.revision});
    const folder=input.folderId?store.folder(input.folderId):undefined;
    const prompt=`Project task: ${task.title}\nTask ID: ${task.id}\nAcceptance criteria:\n${task.acceptance||'(not specified)'}\n\nWork only within the selected Project folder. Implement the task, report concrete changes and relevant verification, and do not claim the task is verified. Ask before expanding scope or taking an irreversible action.`;
    const initial=newChatModel({...(folder?{folderId:folder.id}:{}),projectId:project.id});
    const chat=store.createChat({folderId:folder?.id,projectId:project.id,model:initial.model,providerId:initial.providerId,mode:'agent'});
    store.updateChat(chat.id,{title:`Task · ${task.title}`.slice(0,256),draft:prompt});
    let claimed:import('./project-tasks.ts').ProjectTask;
    try{claimed=projectTasks.startTask({projectId:input.projectId,id:input.taskId,revision:input.revision,requestId:input.requestId,chatId:chat.id});}
    catch(error){store.updateChat(chat.id,{archived:true});state();throw error;}
    if(claimed.runChatId!==chat.id){store.updateChat(chat.id,{archived:true});state();const receipt=store.receipt(input.requestId);if(receipt&&claimed.runChatId)return {task:claimed,chatId:claimed.runChatId,runId:receipt.runId};throw new Error('This task start is already being reconciled. Open its linked chat before trying again.');}
    emit({type:'projectChanged',projectId:input.projectId,taskId:input.taskId});state();
    try{const result=await send(chat.id,prompt,input.requestId);return {task:claimed,chatId:chat.id,runId:result.runId};}
    catch(error){
      const receipt=store.receipt(input.requestId);
      if(receipt)return {task:claimed,chatId:chat.id,runId:receipt.runId};
      const reason=error instanceof Error?error.message:'The agent run could not be dispatched.';
      projectTasks.failTaskStart({projectId:input.projectId,id:input.taskId,requestId:input.requestId,chatId:chat.id,reason});
      emit({type:'projectChanged',projectId:input.projectId,taskId:input.taskId});state();throw error;
    }
  }
  async function invoke<K extends keyof Commands>(command: K, input: Commands[K]['input']): Promise<Commands[K]['output']> {
    if (disposed || closing) throw new Error('Agent runtime is stopping or closed.');
    const pending = dispatch(command, input);
    invocations.add(pending);
    try { return await pending as Commands[K]['output']; }
    finally { invocations.delete(pending); }
  }
  async function dispatch(command: string, input: unknown): Promise<unknown> {
    if (command === 'app.snapshot') return snapshot();
    if (command === 'providers.list') {
      const detected = await discoverLocalProviders();
      const runtime = provider.info();
      // OpenAI Direct signs in with the same ~/.codex/auth.json the Codex CLI entry reads: show that account
      // masked and revealable, exactly like Claude Code, instead of a generic "hidden" label.
      const account = (entry: (typeof runtime)[number]) => { const shared = entry.id === 'openai-direct' ? detected.find(row => row.id === 'codex' && row.identity) : undefined; return shared ? {identityMasked: shared.identityMasked, canReveal: true} : {canReveal: false}; };
      // Keep the list to what the user actually has: an environment-key route without its key is an "add a key" option,
      // not a provider; and the Codex CLI discovery row is redundant once OpenAI (ChatGPT sign-in) runs on the same auth.
      const chatgptReady = runtime.some(entry => entry.id === 'openai-direct' && entry.available);
      const shown = (entry: {id: string; available?: boolean}) => !(entry.id.startsWith('env-') && !entry.available) && !(entry.id === 'codex' && chatgptReady);
      return [...runtime.filter(shown).map(entry=>({...entry,...account(entry),source:entry.codex&&entry.source?entry.source:'Existing local provider profile'})),
        ...detected.filter(entry=>!runtime.some(runnable=>runnable.id===entry.id)&&shown(entry)).map(({identity,credentialPresent,...entry})=>({...entry,available:false,models:[],canReveal:Boolean(identity),source:'Local configuration discovery',detail:`${entry.detail}. No runnable adapter is enabled for this entry.`})),
        ...customProviders.list()];
    }
    if (command === 'plugins.inventory') return discoverPlugins();
    const p = input === undefined && domains.handlers.has(command) ? {} : object(input);
    switch (command) {
      case 'folder.add': { const path = await fs.realpath(text(p.path, 'folder path')); if (!(await fs.stat(path)).isDirectory()) throw new Error('Choose a folder.'); const result = store.addFolder(path, basename(path)); state(); return result; }
      case 'chat.create': {
        const folderId = p.folderId === undefined ? undefined : id(p.folderId), projectId = p.projectId === undefined ? undefined : id(p.projectId);
        // A chat created before the first provider probe settles would otherwise skip every default (no provider reads as available yet).
        await firstProviderProbe();
        const defaults = domainHooks.chatDefaults({...(folderId ? {folderId} : {}), ...(projectId ? {projectId} : {})});
        // UR-SR-a: there is no Ask mode picker any more; a legacy 'ask' default means Agent with read-only access.
        const legacyAsk = defaults.mode === 'ask';
        const mode = defaults.mode === 'plan' ? 'plan' : 'agent';
        const permissionMode = defaults.permissionMode && ['read-only','workspace'].includes(defaults.permissionMode) ? defaults.permissionMode : legacyAsk ? 'read-only' : undefined;
        // Nothing chosen anywhere: the first ready provider. Nothing ready: an unbound chat that shows "Connect a model".
        const initial = defaults.providerId && defaults.model?.trim() ? {providerId: defaults.providerId, model: defaults.model.trim()} : firstReadyModel(provider.info());
        let result = store.createChat({folderId, projectId, model: initial.model, ...(initial.providerId ? {providerId: initial.providerId} : {}), mode, ...(permissionMode ? {permissionMode} : {})});
        if (initial.providerId && /^[a-zA-Z0-9_-]{1,128}$/.test(initial.providerId)) {
          // Bind the default provider exactly as chat.selectProvider would, so the first send needs no reselection.
          let bindingId: string | undefined;
          try { const selected = validateRunnableModel(result.model, initial.providerId); bindingId = selected.bindingId ?? selected.id; } catch { /* resolver already checked readiness; keep the id only */ }
          if (bindingId) result = store.updateChat(result.id, {providerBindingId: bindingId});
        }
        // The default's reasoning effort applies until the composer picks another one for this chat.
        if (defaults.effort && REASONING_EFFORTS.includes(defaults.effort)) efforts.set(result.id, defaults.effort);
        state(); return result;
      }
      case 'chat.select': { const chatId = id(p.id); chatFor(chatId); store.setActiveChat(chatId); if (store.setUnread(chatId, false)) state(); return store.timeline(chatId); }
      case 'chat.timeline': {
        const chatId = id(p.id); chatFor(chatId);
        if (p.select !== undefined && typeof p.select !== 'boolean') throw new Error('Invalid selection.');
        if (p.select) { store.setActiveChat(chatId); if (store.setUnread(chatId, false)) state(); }
        return store.timelineSnapshot(chatId);
      }
      // NAV-11: titles are matched client-side already (the snapshot has them); this reaches message content through
      // the runtime full-text index, so remembering what was SAID finds the chat. Paged; unchanged chats are never re-read.
      case 'chat.search': {
        const query = text(p.query, 'query', 256).trim();
        if (!query) return [];
        for (const field of ['offset', 'limit'] as const) if (p[field] !== undefined && (typeof p[field] !== 'number' || !Number.isFinite(p[field]) || p[field] < 0)) throw new Error(`Invalid ${field}.`);
        return searchIndex.search(query, {offset: p.offset as number | undefined, limit: p.limit as number | undefined});
      }
      // CHAT-06: who edited what in one folder, for Changes ownership and the same-checkout run warning.
      case 'chat.editOwners': {
        const folderId = id(p.folderId), folder = store.folder(folderId);
        if (!folder) throw new Error('Folder does not exist.');
        let real = folder.path; try { real = await fs.realpath(folder.path); } catch { /* keep the stored path */ }
        const roots = [...new Set([folder.path, real])];
        const owners: Array<{path: string; chatId: string; title: string; status: Chat['status']}> = [];
        const chats = store.snapshot().chats.filter(chat => chat.folderId === folderId && !chat.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        for (const chat of chats) for (const path of await resolveOwnedPaths(store.timeline(chat.id), roots)) owners.push({path, chatId: chat.id, title: chat.title, status: chat.status});
        return owners;
      }
      case 'chat.update': {
        const chatId = id(p.id); const chat = chatFor(chatId); const patch: Parameters<AgentStore['updateChat']>[1] = {};
        if (p.title !== undefined) { patch.title = text(p.title, 'title', 256).trim(); if (!patch.title) throw new Error('Title cannot be empty.'); }
        if (p.draft !== undefined) patch.draft = text(p.draft, 'draft', 262144);
        for (const flag of ['pinned', 'archived'] as const) if (p[flag] !== undefined) { if (typeof p[flag] !== 'boolean') throw new Error(`Invalid ${flag}.`); patch[flag] = p[flag]; }
        if (p.mode !== undefined) { if (!['ask','plan','agent'].includes(String(p.mode))) throw new Error('Invalid mode.'); if (chat.status === 'running' || chat.status === 'stopping') throw new Error('Stop this run before changing mode.'); if (p.mode === 'ask') { patch.mode = 'agent'; if (!chat.permissionMode) patch.permissionMode = 'read-only'; } else patch.mode = p.mode as Chat['mode']; }
        // Mid-run model changes are allowed: the in-flight turn keeps the model it was dispatched with; the next turn uses this one.
        if (p.model !== undefined) { const model = text(p.model, 'model', 256).trim(); if (!model) throw new Error('Choose a model.'); if (providerSelections.has(chatId)) throw new Error('Wait for the provider selection to finish.'); validateRunnableModel(model,chat.providerId); patch.model = model; }
        if (p.folderId !== undefined) attachFolder(chat, id(p.folderId));
        if (p.projectId !== undefined) moveToProject(chat, p.projectId === null ? null : id(p.projectId));
        // An archived chat never wakes into the sidebar later: archiving clears its snooze without a notification.
        if (patch.archived && (chat.snoozedUntil || chat.snoozeUntilActivity)) store.wakeChat(chatId, false);
        const result = store.updateChat(chatId, patch);
        // Archiving is only a filing action: say so in the chat when work is still going.
        if (patch.archived && !chat.archived && (busy(chat) || approvalsFor(chatId))) { store.appendItem(chatId, 'notice', ARCHIVE_RUNNING_WARNING, 'completed', {kind:'archived-running'}); timeline(chatId); }
        state(); return result;
      }
      case 'chat.markUnread': {
        const chatId = id(p.id); chatFor(chatId);
        if (p.unread !== undefined && typeof p.unread !== 'boolean') throw new Error('Invalid unread state.');
        if (store.setUnread(chatId, p.unread !== false)) state(); return chatFor(chatId);
      }
      case 'chat.delete': {
        const chatId = id(p.id), chat = chatFor(chatId);
        if (p.force !== undefined && typeof p.force !== 'boolean') throw new Error('Invalid delete request.');
        if ((busy(chat) || approvalsFor(chatId)) && p.force !== true) throw new Error('This chat is still working. Stop it first, or confirm deleting it while it runs.');
        await deleteChat(chatId); return;
      }
      case 'chat.export': {
        const chatId = id(p.id), chat = chatFor(chatId);
        if (!isChatExportFormat(p.format)) throw new Error('Choose Markdown, HTML or JSON.');
        if (p.redact !== undefined && typeof p.redact !== 'boolean') throw new Error('Invalid export request.');
        const folder = chat.folderId ? store.folder(chat.folderId) : undefined, project = chat.projectId ? store.project(chat.projectId) : undefined;
        return exportChat({chat, items: store.timeline(chatId), ...(folder ? {folder} : {}), ...(project ? {project} : {})}, p.format, {redact: p.redact !== false});
      }
      case 'folder.rename': { const folder = folderFor(p.id), name = text(p.name, 'folder name', 256).trim(); if (!name) throw new Error('Name the folder.'); const result = store.renameFolder(folder.id, name); state(); return result; }
      case 'folder.relink': {
        const folder = folderFor(p.id), path = await fs.realpath(text(p.path, 'folder path')).catch(() => { throw new Error('That folder does not exist.'); });
        if (!(await fs.stat(path)).isDirectory()) throw new Error('Choose a folder.');
        if (store.snapshot().chats.some(chat => chat.folderId === folder.id && busy(chat))) throw new Error('Wait for the chats working in this folder before relinking it.');
        const result = store.relinkFolder(folder.id, path); folderStats.delete(folder.path); folderStats.delete(path);
        if (watchedFolders.has(folder.id)) { watcher.unwatch(folder.id); watchedFolders.delete(folder.id); }
        state(); emit({type:'workspaceChanged',folderId:folder.id}); return result;
      }
      case 'folder.remove': {
        const folder = folderFor(p.id);
        if (p.archiveChats !== undefined && typeof p.archiveChats !== 'boolean') throw new Error('Invalid folder removal.');
        if (store.snapshot().chats.some(chat => chat.folderId === folder.id && busy(chat))) throw new Error('A chat is still working in this folder. Stop it before removing the folder.');
        const archived = store.removeFolder(folder.id, p.archiveChats === true);
        if (watchedFolders.has(folder.id)) { watcher.unwatch(folder.id); watchedFolders.delete(folder.id); }
        folderStats.delete(folder.path); state(); return {archived};
      }
      case 'chat.selectProvider': {
        const chatId=id(p.id),providerId=id(p.providerId),model=text(p.model,'model',256).trim(),chat=chatFor(chatId);
        // Another model on the same provider account applies to the next turn without touching the live one.
        if ((chat.providerId)===providerId && !providerSelections.has(chatId) && chat.recovery?.kind!=='recovery-needed') {
          const selected=validateRunnableModel(model,providerId);
          if (!chat.providerBindingId || chat.providerBindingId===(selected.bindingId??selected.id)) { const updated=chat.model===model?chat:store.updateChat(chatId,{model}); state(); return updated; }
        }
        if (providerSelections.has(chatId) || reconciliations.has(chatId) || runs.has(chatId) || chat.status==='running' || chat.status==='stopping' || provider.hasActiveWork?.(chatId)) throw new Error('Wait for this chat and its background work before changing providers.');
        if (chat.recovery?.kind==='recovery-needed') throw new Error('Resolve the existing provider attempt before switching providers.');
        const selected=validateRunnableModel(model,providerId),bindingId=selected.bindingId??selected.id;
        const changed=(chat.providerId)!==providerId || chat.providerBindingId!==bindingId;
        providerSelections.add(chatId);
        try {
          if (changed) await provider.release?.(chatId);
          if (disposed || closing) throw new Error('Agent runtime is stopping. Provider selection was not changed.');
          const updated=store.updateChat(chatId,{providerId,providerBindingId:bindingId,model,...(changed?{providerThreadId:null,providerTurnId:null,providerThreadProviderId:null,providerThreadBindingId:null,recovery:null,error:null}:{})});
          if(changed && chat.providerThreadId) {store.appendItem(chatId,'notice','Provider selection changed. The next run starts a fresh provider conversation; displayed history is retained.','completed');timeline(chatId);}
          state();return updated;
        } finally {providerSelections.delete(chatId);}
      }
      case 'chat.setPermissionMode': {
        const chatId = id(p.id), chat = chatFor(chatId);
        if (typeof p.permissionMode !== 'string' || !['read-only','workspace','full'].includes(p.permissionMode)) throw new Error('Invalid access policy.');
        if (p.acknowledgeFullAccess !== undefined && typeof p.acknowledgeFullAccess !== 'boolean') throw new Error('Invalid full-access acknowledgement.');
        // Allowed mid-run: the live turn keeps the access policy it was dispatched with (captured in send); the next turn uses this one.
        if (providerSelections.has(chatId)) throw new Error('Wait for the provider selection to finish.');
        if (p.permissionMode === 'full' && p.acknowledgeFullAccess !== true) throw new Error('Confirm unrestricted filesystem, command execution and network access before selecting Full access.');
        const result = store.updateChat(chatId, {permissionMode:p.permissionMode as NonNullable<Chat['permissionMode']>}); state(); return result;
      }
      case 'chat.reorderPins': {
        store.reorderPins(order(p.chatIds)); state(); return;
      }
      case 'chat.snooze': {
        const chatId = id(p.id), chat = chatFor(chatId);
        if (chat.archived) throw new Error('Restore this chat before snoozing it.');
        if (p.untilActivity !== undefined && typeof p.untilActivity !== 'boolean') throw new Error('Invalid snooze.');
        let until: string | null = null;
        if (p.until !== undefined) {
          const at = Date.parse(text(p.until, 'snooze time', 64));
          if (!Number.isFinite(at)) throw new Error('Choose when this chat should wake.');
          if (at <= Date.now()) throw new Error('Choose a time in the future.');
          if (at - Date.now() > 366 * 86_400_000) throw new Error('Snooze for at most a year.');
          until = new Date(at).toISOString();
        }
        if (!until && p.untilActivity !== true) throw new Error('Choose when this chat should wake.');
        // Never stops a run and never touches the draft: snoozing only files the chat away.
        const result = store.snoozeChat(chatId, until, p.untilActivity === true);
        scheduleSnoozes(); state(); return result;
      }
      case 'chat.wake': {
        const chatId = id(p.id); chatFor(chatId);
        if (wake(chatId, 'manual')) { scheduleSnoozes(); state(); }
        return chatFor(chatId);
      }
      case 'folder.move': {
        const folder = folderFor(p.id);
        if (p.direction !== 'up' && p.direction !== 'down') throw new Error('Invalid direction.');
        store.moveFolder(folder.id, p.direction); state(); return;
      }
      case 'folder.reorder': {
        store.reorderFolders(order(p.folderIds)); state(); return;
      }
      case 'chat.movePin': {
        const chatId = id(p.id); chatFor(chatId);
        if (p.direction !== 'up' && p.direction !== 'down') throw new Error('Invalid direction.');
        store.movePin(chatId, p.direction); state(); return;
      }
      case 'chat.send': {
        const chatId = id(p.id), attachmentIds = ids(p.attachmentIds, MAX_ATTACHMENTS_PER_MESSAGE), owned = queue.attachmentIds(chatId);
        if (attachmentIds.some(value => owned.has(value))) throw new Error('A file is already attached to a queued message. Remove it from the queue first.');
        const list = (value: unknown, field: string) => { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 8) throw new Error(`Attach at most 8 ${field}s to one message.`); return value.map(entry => text(entry, `${field} id`, 4096)); };
        const skillIds = [...(p.skillId === undefined ? [] : [text(p.skillId, 'skill id', 4096)]), ...list(p.skillIds, 'skill')], pluginIds = list(p.pluginIds, 'plugin');
        if (p.effort !== undefined && !REASONING_EFFORTS.includes(p.effort as ReasoningEffort)) throw new Error('Invalid reasoning effort.');
        // The chosen effort also applies to follow-ups dispatched from the queue.
        if (p.effort !== undefined) efforts.set(chatId, p.effort as ReasoningEffort);
        // A message the user sends by hand resumes a paused queue once its turn completes (Codex); goal turns do not.
        const requestId = id(p.requestId);
        if (!requestId.startsWith('goal-') && queue.paused(chatId)) { queue.resume(chatId); state(); }
        return send(chatId, text(p.text, 'message', MAX_QUEUED_TEXT), requestId, skillIds.length ? skillIds : undefined, attachmentIds, {pluginIds, ...(p.effort !== undefined ? {effort: p.effort as ReasoningEffort} : {})});
      }
      case 'chat.queue.add': {
        const chatId = id(p.id), chat = chatFor(chatId), attachmentIds = ids(p.attachmentIds, MAX_ATTACHMENTS_PER_MESSAGE);
        if (chat.archived) throw new Error('Restore this chat before sending.');
        attachments.resolve(chatId, attachmentIds);
        const owned = queue.attachmentIds(chatId);
        if (attachmentIds.some(value => owned.has(value))) throw new Error('A file is already attached to another queued message.');
        const chips = await queueChips(chat, p);
        const result = queue.add(chatId, {text: text(p.text, 'message', MAX_QUEUED_TEXT), requestId: id(p.requestId), attachmentIds, ...chips});
        state();
        // A run that settled while the user was typing: send now rather than wait for a run that never comes.
        const current = chatFor(chatId);
        if (!busy(current)) {
          if (current.status === 'idle' || queueActionAfter(current.status) === 'dispatch') dispatchQueued(chatId);
          // It ended without completing: show the paused banner (with Resume) instead of holding the item silently.
          else if (!queue.paused(chatId)) { queue.pause(chatId, current.status === 'interrupted' ? 'interrupted' : 'failed'); state(); }
        } else if (!queue.paused(chatId)) {
          // Codex-backed chats hand the follow-up to the app-server's own queue (thread/queue/*) when it supports it.
          void nativeQueue.mirror(chatId, result).then(mirrored => {
            const latest = store.chat(chatId);
            if (disposed || closing || !latest || busy(latest) || queue.paused(chatId)) return;
            if (mirrored) void nativeQueue.start(chatId).then(started => { if (!started) dispatchQueued(chatId); });
            else dispatchQueued(chatId);
          });
        }
        return result;
      }
      case 'chat.queue.update': { const chatId = id(p.id); chatFor(chatId); const result = queue.update(chatId, id(p.queueId), text(p.text, 'message', MAX_QUEUED_TEXT)); await nativeQueue.update(chatId, result.id, result.text); state(); return result; }
      case 'chat.queue.remove': {
        const chatId = id(p.id); chatFor(chatId);
        await nativeQueue.remove(chatId, id(p.queueId));
        const removed = queue.remove(chatId, id(p.queueId));
        if (removed) { for (const attachmentId of removed.attachmentIds) await attachments.discard(chatId, attachmentId).catch(() => undefined); state(); }
        return;
      }
      case 'chat.queue.move': {
        const chatId = id(p.id); chatFor(chatId);
        if (p.direction !== 'up' && p.direction !== 'down') throw new Error('Invalid direction.');
        queue.move(chatId, id(p.queueId), p.direction); await nativeQueue.reorder(chatId); state(); return;
      }
      case 'chat.steer': {
        const chatId = id(p.id), message = text(p.text, 'message', MAX_QUEUED_TEXT), requestId = id(p.requestId), chat = chatFor(chatId);
        if (!message.trim()) throw new Error('Write a message first.');
        const previous = steered.get(requestId);
        if (previous) { if (previous !== chatId) throw new Error('Request identity conflicts with its original message.'); return {steered:true}; }
        // A live turn cannot take files; the composer queues them instead.
        if (ids(p.attachmentIds, MAX_ATTACHMENTS_PER_MESSAGE).length) return {steered:false};
        return steerRun(chat, message, requestId, await queueChips(chat, p));
      }
      case 'chat.queue.steer': {
        const chatId = id(p.id), chat = chatFor(chatId), queueId = id(p.queueId);
        const item = queue.list(chatId).find(entry => entry.id === queueId);
        if (!item) throw new Error('This queued message was already sent or removed.');
        if (runs.has(chatId) || busy(chat)) {
          if (item.attachmentIds.length) return {steered:false, started:false, reason:'Files can’t join a running turn. It stays queued.'};
          const result = await steerRun(chat, item.text, item.requestId, item);
          if (result.steered) { await nativeQueue.remove(chatId, item.id); queue.remove(chatId, item.id); state(); }
          return {...result, started:false};
        }
        // Idle: this row goes next, now (Codex `thread/queue/start`).
        queue.clearError(item.id); queue.promote(chatId, item.id); queue.resume(chatId); await nativeQueue.reorder(chatId); state();
        dispatchQueued(chatId);
        return {steered:false, started:true};
      }
      case 'chat.queue.reorder': {
        const chatId = id(p.id); chatFor(chatId);
        if (!Array.isArray(p.queueIds) || p.queueIds.length > MAX_QUEUED_MESSAGES) throw new Error('Invalid queue order.');
        queue.reorder(chatId, p.queueIds.map(id)); await nativeQueue.reorder(chatId); state(); return;
      }
      case 'chat.queue.resume': {
        const chatId = id(p.id), chat = chatFor(chatId);
        queue.resume(chatId);
        const head = queue.list(chatId)[0];
        if (head?.error) queue.clearError(head.id);
        state();
        if (!runs.has(chatId) && !busy(chat)) dispatchQueued(chatId);
        return;
      }
      case 'chat.queue.clear': {
        const chatId = id(p.id); chatFor(chatId);
        await nativeQueue.unmirrorAll(chatId);
        let removed = 0;
        for (const item of queue.list(chatId)) {
          const gone = queue.remove(chatId, item.id);
          if (!gone) continue;
          removed++;
          for (const attachmentId of gone.attachmentIds) await attachments.discard(chatId, attachmentId).catch(() => undefined);
        }
        queue.resume(chatId); state();
        return {removed};
      }
      case 'attachments.stage': {
        const chatId = id(p.chatId), chat = chatFor(chatId);
        if (chat.archived) throw new Error('Restore this chat before attaching files.');
        return attachments.stage({chatId, name: text(p.name, 'file name', 1024), mime: text(p.mime ?? '', 'file type', 256), dataBase64: text(p.dataBase64, 'file data', Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4)}, queue.attachmentIds(chatId));
      }
      case 'attachments.discard': {
        const chatId = id(p.chatId), attachmentId = id(p.id); chatFor(chatId);
        if (queue.attachmentIds(chatId).has(attachmentId)) throw new Error('This file belongs to a queued message. Remove that message instead.');
        return attachments.discard(chatId, attachmentId);
      }
      case 'attachments.list': { const chatId = id(p.chatId); chatFor(chatId); return attachments.list(chatId, queue.attachmentIds(chatId)); }
      case 'attachments.preview': { const chatId = id(p.chatId); chatFor(chatId); return attachments.preview(chatId, id(p.id)); }
      case 'attachments.info': { const chatId = id(p.chatId); chatFor(chatId); return attachments.info(chatId, ids(p.ids, 50)); }
      case 'attachments.read': {
        const chatId = id(p.chatId); chatFor(chatId);
        const loc = attachments.location(chatId, id(p.id));
        if (!loc) throw new Error('This file is no longer available.');
        return readFile(loc.root, loc.rel);
      }
      case 'attachments.asset': {
        const chatId = id(p.chatId); chatFor(chatId);
        const loc = attachments.location(chatId, id(p.id));
        if (!loc) throw new Error('This file is no longer available.');
        return readAsset(loc.root, loc.rel);
      }
      case 'attachments.document': {
        const chatId = id(p.chatId); chatFor(chatId);
        const loc = attachments.location(chatId, id(p.id));
        if (!loc) throw new Error('This file is no longer available.');
        return readDocument(loc.root, loc.rel);
      }
      case 'attachments.workbook': {
        const chatId = id(p.chatId); chatFor(chatId);
        const loc = attachments.location(chatId, id(p.id));
        if (!loc) throw new Error('This file is no longer available.');
        return readWorkbook(loc.root, loc.rel);
      }
      case 'chat.contextTelemetry': { const chatId = id(p.id); chatFor(chatId); return store.contextTelemetry(chatId); }
      case 'chat.fork': {
        const chatId = id(p.id); chatFor(chatId);
        return fork(chatId, p.fromItemId === undefined ? undefined : id(p.fromItemId));
      }
      case 'chat.editOptions': { const chatId = id(p.id); return editOptions(chatFor(chatId), id(p.itemId)); }
      case 'chat.editRestorePreview': { const chatId = id(p.id); const {baseline: _baseline, root: _root, ...preview} = await restorePreview(chatFor(chatId), id(p.itemId)); return preview; }
      case 'chat.editResend': {
        const chatId = id(p.id), chat = chatFor(chatId), itemId = id(p.itemId), message = text(p.text, 'message', MAX_QUEUED_TEXT), requestId = id(p.requestId);
        if (p.mode !== undefined && p.mode !== 'fork' && p.mode !== 'replace' && p.mode !== 'restore') throw new Error('Invalid edit mode.');
        if (!message.trim()) throw new Error('Write a message first.');
        // Same requestId again (a double click, an ambiguous IPC failure): return the original outcome.
        const receipt = store.receipt(requestId);
        if (receipt) return {chatId: receipt.chatId, runId: receipt.runId, forked: receipt.chatId !== chatId};
        const items = store.timeline(chatId), index = items.findIndex(item => item.id === itemId);
        if (index < 0) throw new Error('That message is no longer in this chat.');
        if (items[index]!.kind !== 'user') throw new Error('Only your own messages can be edited.');
        if (p.mode === 'restore') {
          const expected = Array.isArray(p.restoreFiles) ? p.restoreFiles : null;
          if (!expected || expected.length > 1000 || !expected.every(file => file && typeof file.path === 'string' && typeof file.afterHash === 'string')) throw new Error('Invalid restore list.');
          const preview = await restorePreview(chat, itemId);
          if (!preview.available || !preview.baseline || !preview.root) throw new Error(`${preview.reason ?? 'Files cannot be restored.'} Resend it as a fork instead.`);
          const wanted = new Map(expected.map(file => [file.path, file.afterHash]));
          if (wanted.size !== preview.files.length || preview.files.some(file => wanted.get(file.path) !== file.afterHash)) throw new Error('Files changed since the preview. Nothing was restored; review the list again.');
          const restored = await applyRestore(preview.root, preview.baseline, preview.files);
          store.truncateFrom(chatId, itemId);
          const commands = preview.external ? ` ${preview.external === 1 ? '1 command or tool call' : `${preview.external} commands or tool calls`} that ran after it ${preview.external === 1 ? 'was' : 'were'} not undone.` : '';
          store.appendItem(chatId, 'notice', `Restored ${restored.length === 1 ? '1 file' : `${restored.length} files`} Muster changed after this point.${commands}`, 'completed', {kind: 'files-restored', paths: restored.slice(0, 200), external: preview.external});
          const snapshot = store.timelineSnapshot(chatId);
          publishedTimelineRevisions.set(chatId, snapshot.revision);
          emit({type: 'timeline', chatId, items: snapshot.items});
          emit({type: 'workspaceChanged', folderId: chat.folderId!});
          const result = await send(chatId, message, requestId).catch(error => {
            if (!store.receipt(requestId) && store.chat(chatId)) { store.updateChat(chatId, {draft: message}); state(); }
            throw error;
          });
          return {chatId, runId: result.runId, forked: false, restored};
        }
        if (p.mode === 'replace') {
          const options = await editOptions(chat, itemId);
          if (!options.canReplace) throw new Error(`${options.replaceBlockedReason} Resend it as a fork instead.`);
          store.truncateFrom(chatId, itemId);
          const snapshot = store.timelineSnapshot(chatId);
          publishedTimelineRevisions.set(chatId, snapshot.revision);
          emit({type: 'timeline', chatId, items: snapshot.items});
          // The prompt row is gone now; a refused send leaves the edit in this chat's composer instead.
          const result = await send(chatId, message, requestId).catch(error => {
            if (!store.receipt(requestId) && store.chat(chatId)) { store.updateChat(chatId, {draft: message}); state(); }
            throw error;
          });
          return {chatId, runId: result.runId, forked: false};
        }
        // Editing the very first message forks with no history at all.
        const forked = fork(chatId, index > 0 ? items[index - 1]!.id : null);
        const result = await send(forked.id, message, requestId).catch(async error => {
          // Refused before dispatch: drop the empty fork so Resend again (the editor keeps the text) never leaves duplicates.
          if (!store.receipt(requestId) && store.chat(forked.id)) await deleteChat(forked.id).catch(() => undefined);
          throw error;
        });
        return {chatId: forked.id, runId: result.runId, forked: true};
      }
      case 'chat.retry': {
        const chatId = id(p.id), chat = chatFor(chatId), itemId = id(p.itemId), requestId = p.requestId === undefined ? randomUUID() : id(p.requestId);
        if (store.receipt(requestId)) return {runId: store.receipt(requestId)!.runId, requestId};
        if (busy(chat)) throw new Error('Wait for this run to finish before retrying.');
        const items = store.timeline(chatId), index = items.findIndex(item => item.id === itemId);
        if (index < 0) throw new Error('That message is no longer in this chat.');
        const prompts = items.flatMap((item, at) => item.kind === 'user' && item.data?.steered !== true ? [at] : []);
        const last = prompts.at(-1);
        if (last === undefined || index < last) throw new Error('Only the latest turn can be retried.');
        const prompt = items[last]!;
        if (!prompt.text.trim()) throw new Error('This turn only sent files. Attach them again to retry.');
        // F46: re-run the original prompt without appending a second copy of it to the transcript.
        const result = await send(chatId, prompt.text, requestId, undefined, [], {reuseUserItemId: prompt.id});
        return {runId: result.runId, requestId};
      }
      case 'chat.stop': { const chatId = id(p.id); chatFor(chatId); const run = runs.get(chatId); if (!run) return;
        // Codex pauses an active goal before interrupting, so the stop never triggers a continuation.
        if (goalsByChat().get(chatId)?.status === 'active') { try { await domains.handlers.get('goals.pause')?.({chatId}); } catch { /* the goal was cleared meanwhile */ } }
        run.stopped = true; run.retry.abort(); store.updateChat(chatId, {status: 'stopping'}); settleApprovals(chatId); settleQuestions(chatId); state(); await provider.stop(chatId);
        // A turn the app-server started itself settles on its own turn/completed; if its session is gone, settle it here.
        nativeTurns.stopped(chatId, !!provider.nativeThread?.(chatId)); return; }
      case 'chat.reconcile': {
        const chatId=id(p.id),chat=chatFor(chatId);
        if (runs.has(chatId) || chat.status === 'running' || chat.status === 'stopping') return {chat,resolved:false,reason:'This attempt is still running locally. Stop it or wait before checking recovery.'};
        if (chat.recovery?.kind !== 'recovery-needed') return {chat,resolved:true,reason:'This chat has no unresolved provider attempt.'};
        if (!chat.providerThreadId || !chat.providerTurnId) return {chat,resolved:false,reason:'Muster did not receive the provider turn identity. Automatic verification is unavailable; inspect the existing provider work before continuing.'};
        if (reconciliations.has(chatId)) throw new Error('This chat’s provider status is already being checked.');
        if (reconciliations.size >= 3) throw new Error('Wait for another provider status check to finish.');
        const cwd=chat.folderId ? folderFor(chat.folderId).path : join(options.dataDir,'scratch',chatId);
        reconciliations.add(chatId);
        try {
          const result=await (options.reconcileProvider ?? reconcileProviderTurn)({threadId:chat.providerThreadId,turnId:chat.providerTurnId,cwd,providerId:chat.providerThreadProviderId??chat.providerId,providerBindingId:chat.providerThreadBindingId});
          if (disposed) throw new Error('Agent runtime is closed.');
          const current=chatFor(chatId);
          if (runs.has(chatId) || current.providerThreadId !== chat.providerThreadId || current.providerTurnId !== chat.providerTurnId || current.recovery?.kind !== 'recovery-needed') return {chat:current,resolved:current.recovery?.kind !== 'recovery-needed',reason:'The attempt state changed while checking. Review its current status.'};
          if (!result.resolved || !result.terminalStatus) return {chat:current,resolved:false,reason:result.reason,...(/still active/i.test(result.reason) ? {stillRunning:true} : {})};
          const updated=store.updateChat(chatId,{recovery:null,error:null,status:result.terminalStatus === 'completed' ? 'completed' : result.terminalStatus === 'interrupted' ? 'interrupted' : 'failed'});
          store.appendItem(chatId,'notice',result.reason,'completed',{providerThreadId:chat.providerThreadId,providerTurnId:chat.providerTurnId,reconciledStatus:result.terminalStatus});
          timeline(chatId);state();return {chat:updated,resolved:true,reason:result.reason};
        } finally {reconciliations.delete(chatId);}
      }
      case 'approval.respond': { const approvalId = id(p.id); if (typeof p.approved !== 'boolean') throw new Error('Invalid approval decision.');
        if (p.decision !== undefined && !['accept','acceptForSession','decline'].includes(p.decision as string)) throw new Error('Invalid approval decision.');
        const decision: ApprovalDecision = !p.approved ? 'decline' : p.decision === 'acceptForSession' ? 'acceptForSession' : 'accept';
        const pending = approvals.get(approvalId); if (!pending) throw new Error('This approval is no longer pending.'); finishApproval(approvalId, pending, decision, decision === 'decline' ? 'declined' : decision === 'acceptForSession' ? 'approved-session' : 'approved'); return; }
      case 'question.dismiss': { const questionId = id(p.id); const pending = questions.get(questionId); if (!pending) throw new Error('This question is no longer pending.'); finishQuestion(questionId, pending, null, 'dismissed'); return; }
      case 'chat.compact': {
        const chatId = id(p.id), chat = chatFor(chatId);
        if (runs.has(chatId) || busy(chat)) throw new Error('Wait for the current run to finish before compacting.');
        if (!provider.compact) throw new Error('This provider cannot compact context.');
        if (compactions.has(chatId)) throw new Error('Compaction is already in progress.');
        const row = store.appendItem(chatId, 'notice', 'Compacting context…', 'running', {kind:'compaction', status:'running', manual:true});
        compactions.set(chatId, row.id); timeline(chatId);
        try { await provider.compact(chatId); }
        catch (error) {
          if (compactions.get(chatId) === row.id) { compactions.delete(chatId); store.updateItem(row.id, `Compaction failed: ${error instanceof Error ? error.message : 'the provider refused the request.'} History is unchanged.`, 'failed', {kind:'compaction', status:'failed', manual:true}); timeline(chatId); }
          throw error;
        }
        // The provider confirms with thread/compacted; a quiet provider still settles the row once the request was accepted.
        compactionCompleted(chatId); return;
      }
      case 'question.respond': {
        const questionId = id(p.id); const pending = questions.get(questionId); if (!pending) throw new Error('This question is no longer pending.');
        if (!p.answers || typeof p.answers !== 'object' || Array.isArray(p.answers)) throw new Error('Invalid question answers.');
        const answers: Record<string, {answers: string[]}> = Object.create(null) as Record<string, {answers: string[]}>;
        const suppliedKeys = Object.getOwnPropertyNames(p.answers as object);
        if (suppliedKeys.some(key => !pending.questions.some(question => question.id === key))) throw new Error('Invalid question answers.');
        for (const question of pending.questions) {
          const answer = (p.answers as Record<string, unknown>)[question.id];
          const values = answer && typeof answer === 'object' && !Array.isArray(answer) ? (answer as Record<string, unknown>).answers : undefined;
          if (!Array.isArray(values) || values.length === 0 || values.length > 16 || values.some(value => typeof value !== 'string' || value.trim().length === 0 || value.length > 4096)) throw new Error('Invalid question answers.');
          if (!question.multiSelect && values.length !== 1) throw new Error('This question accepts one answer.');
          if (!question.allowCustomAnswer && values.some(value => !question.options.some(option => (option.value ?? option.label) === value))) throw new Error('Custom answers are not allowed for this question.');
          answers[question.id] = { answers: values.map(value => question.isSecret ? value : value.trim()) };
        }
        const receiptAnswers: Record<string, {answers: string[]}> = Object.create(null) as Record<string, {answers: string[]}>;
        for (const question of pending.questions) receiptAnswers[question.id] = question.isSecret ? {answers: ['[redacted]']} : answers[question.id];
        finishQuestion(questionId, pending, {...answers}, 'answered', receiptAnswers); return;
      }
      case 'project.create': { const name = text(p.name,'project name',256).trim(); if (!name) throw new Error('Name the Project.'); if (!Array.isArray(p.folderIds) || p.folderIds.length > 100) throw new Error('Invalid Project folders.'); const result = store.createProject(name, text(p.goal,'goal',32768), [...new Set(p.folderIds.map(id))]); state(); return result; }
      case 'project.tasks.list': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); return projectTasks.listTasks(projectId); }
      case 'project.tasks.create': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); if(!Array.isArray(p.dependencies)||p.dependencies.length>50) throw new Error('Invalid dependencies.'); return projectTasks.createTask({projectId,title:text(p.title,'task title',500),acceptance:text(p.acceptance,'acceptance criteria',4000),dependencies:[...new Set(p.dependencies.map(id))]}); }
      case 'project.tasks.start': return startProjectTask({projectId:id(p.projectId),id:id(p.id),revision:Number(p.revision),requestId:id(p.requestId),...(p.folderId===undefined?{}:{folderId:id(p.folderId)})});
      case 'project.tasks.updateStatus': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); const taskId=id(p.id); if(!['todo','running','blocked','implemented','verified'].includes(String(p.status))) throw new Error('Invalid task status.'); if(!Number.isSafeInteger(p.revision)||Number(p.revision)<0) throw new Error('Invalid revision.'); const evidence=p.evidence===undefined?undefined:Array.isArray(p.evidence)&&p.evidence.length<=50?p.evidence.map(e=>text(e,'evidence',2000)):(()=>{throw new Error('Invalid evidence.');})(); return projectTasks.updateTaskStatus({projectId,id:taskId,status:p.status as TaskStatus,evidence,revision:Number(p.revision)}); }
      case 'project.tasks.addEvidence': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); if(!Array.isArray(p.entries)||p.entries.length<1||p.entries.length>50) throw new Error('Provide 1–50 evidence entries.'); if(!Number.isSafeInteger(p.revision)||Number(p.revision)<0) throw new Error('Invalid revision.'); return projectTasks.addEvidence({projectId,id:id(p.id),entries:p.entries.map(e=>text(e,'evidence',2000)),revision:Number(p.revision)}); }
      case 'project.decisions.list': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); return projectTasks.listDecisions(projectId); }
      case 'project.decisions.create': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); if(!Array.isArray(p.relatedTaskIds)||p.relatedTaskIds.length>50) throw new Error('Invalid related tasks.'); return projectTasks.createDecision({projectId,title:text(p.title,'decision title',500),rationale:text(p.rationale,'rationale',8000),scope:text(p.scope,'scope',500),relatedTaskIds:[...new Set(p.relatedTaskIds.map(id))]}); }
      case 'project.decisions.supersede': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); return projectTasks.supersedeDecision({projectId,id:id(p.id),replacementId:id(p.replacementId)}); }
      case 'project.activity.list': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); const limit=p.limit===undefined?100:Number(p.limit); if(!Number.isSafeInteger(limit)||limit<1||limit>200) throw new Error('Invalid limit.'); return projectTasks.listActivity(projectId,limit); }
      case 'project.export': { const projectId=id(p.projectId), project=store.project(projectId); if(!project) throw new Error('Project not found.'); const folders=project.folderIds.map(folderId=>store.folder(folderId)).filter((folder):folder is NonNullable<typeof folder>=>Boolean(folder)); const chats=store.projectChats(projectId).map(({id,title,folderId,providerId,model,mode,permissionMode,status,updatedAt,recovery})=>({id,title,...(folderId?{folderId}:{}),providerId:providerId??'',model,mode,...(permissionMode?{permissionMode}:{}),status,updatedAt,...(recovery?{recovery}:{} )})); return projectTasks.exportProject(project,folders,chats); }
      case 'workspace.watch': {
        if (!Array.isArray(p.folderIds) || p.folderIds.length > 32) throw new Error('Invalid watched folders.');
        const folders = [...new Set(p.folderIds.map(id))].map(folderFor);
        const desired = new Set(folders.map(folder=>folder.id));
        for (const folderId of watchedFolders) if (!desired.has(folderId)) { watcher.unwatch(folderId); watchedFolders.delete(folderId); }
        await Promise.all(folders.map(async folder => {
          if (watchedFolders.has(folder.id)) return;
          watchedFolders.add(folder.id);
          try { await watcher.watch(folder.id,folder.path); }
          catch (error) { if (watchedFolders.has(folder.id)) { watchedFolders.delete(folder.id); emit({type:'notice',message:`Live file updates unavailable for ${folder.name}: ${(error as Error).message}`}); } }
        }));
        return;
      }
      case 'files.list': return listFiles(folderFor(p.folderId).path, text(p.path ?? '', 'path'), {showHidden: p.showHidden === true});
      case 'files.create': {
        const folder = folderFor(p.folderId);
        if (p.kind !== 'file' && p.kind !== 'directory') throw new Error('Invalid file type.');
        await createEntry(folder.path, text(p.path, 'path'), p.kind);
        emit({type:'workspaceChanged',folderId:folder.id}); return;
      }
      case 'files.move': {
        const folder = folderFor(p.folderId), from = text(p.from, 'source'), to = text(p.to, 'destination');
        await moveFile(folder.path, from, to);
        try { annotations.move(folder.id, from, to); }
        catch { emit({type:'notice',message:'File moved. Its notes remain associated with the original path.'}); }
        emit({type:'fileMoved',folderId:folder.id,from,to});
        emit({type:'workspaceChanged',folderId:folder.id}); return;
      }
      case 'files.search': return searchFiles(folderFor(p.folderId).path, text(p.path ?? '', 'path'), text(p.query,'query',256));
      case 'files.read': return readFile(folderFor(p.folderId).path, text(p.path,'path'));
      case 'files.document': return readDocument(folderFor(p.folderId).path,text(p.path,'path'));
      case 'files.workbook': return readWorkbook(folderFor(p.folderId).path,text(p.path,'path'));
      case 'files.annotations.list':
      case 'files.annotations.add':
      case 'files.annotations.remove': {
        const folder=folderFor(p.folderId),path=text(p.path,'path');
        await resolveInside(folder.path,path);
        if(command==='files.annotations.list')return annotations.list(folder.id,path);
        if(command==='files.annotations.remove')return annotations.remove(folder.id,path,id(p.id));
        return annotations.add({folderId:folder.id,path,revision:text(p.revision,'revision',64),location:text(p.location,'location',256),quote:text(p.quote,'quote',2000),note:text(p.note,'note',4000)});
      }
      case 'files.asset': return readAsset(folderFor(p.folderId).path, text(p.path,'path'));
      case 'git.changes': { const root = folderFor(p.folderId).path; const result = await new AgentModeReviewHost(() => root).listChanges(); if (result.error) throw new Error(result.error); return result.files; }
      case 'git.status': return gitStatus(folderFor(p.folderId).path);
      case 'git.mutate': {
        if (!['stage','unstage','commit'].includes(String(p.operation))) throw new Error('Invalid Git operation.');
        const folder = folderFor(p.folderId);
        const result = await mutateGit(folder.path, p.operation as 'stage'|'unstage'|'commit', text(p.revision,'revision',64), p.paths, p.message === undefined ? undefined : text(p.message,'message',32768));
        emit({type:'workspaceChanged',folderId:folder.id}); return result;
      }
      case 'git.push': {
        const folder = folderFor(p.folderId);
        const result = await pushGit(folder.path, text(p.revision,'revision',64));
        emit({type:'workspaceChanged',folderId:folder.id}); return result;
      }
      case 'git.pullRequests': return listPullRequests(folderFor(p.folderId).path);
      case 'git.compareUrl': return compareUrl(folderFor(p.folderId).path);
      case 'git.diff': { const root = folderFor(p.folderId).path; const result = await new AgentModeReviewHost(() => root).readChange(text(p.path,'path')); if (result.error) throw new Error(result.error); return {path: result.path, before: result.before, after: result.after, truncated: result.truncated}; }
      case 'providers.save': return customProviders.save({id:p.id,name:p.name,endpoint:p.endpoint,apiKeyEnv:p.apiKeyEnv});
      case 'providers.cancelCheck': customProviders.cancel(id(p.id)); return;
      case 'providers.remove': { const key=id(p.id); if(!key.startsWith('custom_')) throw new Error('Discovered connections are managed in their original app.'); customProviders.remove(key); return; }
      case 'providers.check': return customProviders.check(id(p.id));
      case 'providers.reveal': { const key=id(p.id), source=key==='openai-direct'?'codex':key; const info=(await discoverLocalProviders()).find(row=>row.id===source); if(!info?.identity) throw new Error('This connection has no account label to reveal.'); return {identity:info.identity}; }
      case 'memory.list': { const context = memoryContext(p.folderId); const objects = await listMemory(context.cwd); return new MemoryTombstones(options.dataDir).filter(objects.filter(object => isVisibleInScopes(object, context.scopes))); }
      case 'memory.search': { const context = memoryContext(p.folderId); const q = text(p.query,'query',256); const limit = typeof p.limit==='number' && Number.isFinite(p.limit) ? Math.min(200,Math.max(1,Math.floor(p.limit))) : 50; return new MemoryTombstones(options.dataDir).filter(await searchMemory({query:q,limit,scopes:context.scopes},context.cwd)); }
      case 'memory.add': { const context = memoryContext(p.folderId); const summary = redactSecrets(text(p.summary,'summary',8192)); const kind = typeof p.kind==='string' ? text(p.kind,'kind',64) : 'fact'; if (!Array.isArray(p.provenance) || p.provenance.length < 1 || p.provenance.length > 16) throw new Error('Supply between 1 and 16 provenance entries.'); const provenance = (p.provenance as unknown[]).map(v=>redactSecrets(text(v,'provenance item',256))); const scopes = requestedMemoryScopes(p.scopes, context.scopes); try { const result = await addMemory({summary,kind,provenance,scopes,explicitUserRequest:true},context.cwd); return result; } catch(e) { if(e instanceof Error && e.name === 'MemoryPolicyError') throw new Error(`Memory policy (${String((e as {policy?: unknown}).policy)}): ${e.message}`); throw e; } }
      case 'memory.inspect': { const context = memoryContext(p.folderId); try { const r = await inspectMemoryStore(context.cwd); return {available:true,objectCount:r.jsonl.objectCount,checks:r.checks}; } catch(e) { return {available:false,objectCount:0,checks:[],error:e instanceof Error?e.message:String(e)}; } }
      case 'hindsight.status': return hindsightClient().status(p.folderId === undefined ? 'personal' : id(p.folderId));
      case 'hindsight.retain': return hindsightClient().retain({folderId: p.folderId === undefined ? 'personal' : id(p.folderId), items: [{content: redactSecrets(text(p.content, 'content', 32768))}], provenance: [redactSecrets(text(p.source, 'source', 512))], async: false}); // MEM-08: no raw secrets reach Hindsight
      case 'hindsight.recall': return hindsightClient().recall({folderId: p.folderId === undefined ? 'personal' : id(p.folderId), query: text(p.query, 'query', 8192), budget: p.budget as 'low'|'mid'|'high'|undefined ?? 'low', maxTokens: typeof p.maxTokens === 'number' ? p.maxTokens : 2048, types: p.types as ('world'|'experience'|'observation')[]|undefined, tags: p.tags as string[]|undefined});
      case 'hindsight.reflect': return hindsightClient().reflect({folderId: p.folderId === undefined ? 'personal' : id(p.folderId), query: text(p.query, 'query', 8192), context: p.context === undefined ? undefined : text(p.context, 'context', 32768), budget: p.budget as 'low'|'mid'|'high'|undefined ?? 'low', maxTokens: typeof p.maxTokens === 'number' ? p.maxTokens : 2048});
      case 'skills.create': return createSkill({name: text(p.name, 'skill name', 256), description: text(p.description, 'skill description', 2048), body: text(p.body, 'skill instructions', 65536), ...(p.overwrite === true ? {overwrite: true} : {})});
      case 'plugins.list': {
        const allowedFolders = new Set(store.snapshot().folders.map(folder => folder.path));
        const folderPaths = Array.isArray(p.folderPaths)
          ? (p.folderPaths as unknown[]).filter((value): value is string => typeof value === 'string' && value.length <= 4096)
            .filter(value => allowedFolders.has(value))
          : [];
        return discoverSkills(folderPaths);
      }
      default: {
        const handler = domains.handlers.get(command);
        if (handler) {
          const result = await handler(p);
          domainHooks.commandCompleted({command, input: p, output: result});
          // CHAT-16: turning auto-archive on (or shortening it) applies now, not an hour later.
          if (command === 'settings.set' || command === 'settings.reset' || command === 'settings.import') void sweepIdleChats();
          return result;
        }
        throw new Error('Unsupported command.');
      }
    }
  }
  // --- S3-B Codex native thread APIs: goals, queue and projects delegate to the app-server where it supports them ---
  const native = provider.nativeThread && provider.nativeCall ? createNativeThreadBridge({
    thread: chatId => provider.nativeThread!(chatId),
    call: (chatId, method, params, timeoutMs) => provider.nativeCall!(chatId, method, params, timeoutMs),
    ...(provider.nativeQuery ? {query: (method: string, params: Record<string, unknown>, timeoutMs?: number) => provider.nativeQuery!(method, params, timeoutMs)} : {}),
  }) : undefined;
  const nativeTurns = createNativeTurnObserver({store, runs, state: () => state(), timeline: chatId => timeline(chatId),
    runStarted: (chat, runId) => { void domainHooks.runStarted({chat, runId, cwd: ''}).catch(() => undefined); },
    runSettled: (chat, runId, status) => domainHooks.runSettled({chat, runId, status}),
    afterRun: (chatId, status) => afterRun(chatId, status)});
  const nativeQueue = createNativeQueueMirror({queue, native, changed: () => state()});
  const offIdleEvents = provider.onIdleEvent?.((chatId, method, params) => { if (!disposed && !closing) nativeTurns.event(chatId, method, params); });
  const offQueueEvents = domainHooks.hooks.onProviderEvent(({chat, method}) => { if (method === 'thread/queue/changed' && !disposed) void nativeQueue.reconcile(chat.id); });
  const domains = createDomains({
    dataDir: options.dataDir, store, db: () => store.database(), emit, emitSnapshot: state,
    folderFor: folderId => folderFor(folderId), invoke, hooks: domainHooks.hooks,
    modelCatalog: () => { const providers = provider.info(); return {providers, builtin: firstReadyModel(providers)}; },
    modelCatalogReady: firstProviderProbe,
    ...(native ? {native} : {}),
  }, options.domains);
  // --- CHAT-15 snooze and wake · CHAT-16 auto-archive ------------------------------------------------
  let snoozeTimer: ReturnType<typeof setTimeout> | undefined;
  // --- SBX-13 sleep/wake: main forwards Electron powerMonitor events through power() below -------------
  const power = createPowerEvents({log: message => console.warn(message), participants: [
    // Snoozes are absolute instants: pause the timer in sleep, wake every due one once on resume.
    {name: 'snoozes', suspend() { if (snoozeTimer) clearTimeout(snoozeTimer); snoozeTimer = undefined; }, resume() { scheduleSnoozes(); }},
    // Automations (cursor-coalesced catch-up), repo-trigger baselines, goal continuations, project ticks.
    {name: 'domains', suspend: ({at}) => domains.power({state: 'suspend', at}), resume: ({at, sleptMs, suspendedAt}) => domains.power({state: 'resume', at, sleptMs, suspendedAt})},
    // Warm app-servers may hold sockets that died in sleep: the next send re-checks them. Running turns are left alone.
    {name: 'providers', resume() { provider.markStale?.(); }},
    // A fresh snapshot lets the renderer resync views instead of guessing from the silence that spanned the sleep.
    {name: 'views', resume() { if (!disposed && !closing) state(); }},
  ]});
  /** One state transition per wake however timer, activity, restart and manual wake race: store.wakeChat is conditional.
   *  Timed and activity wakes mark the chat unread (unless it is on screen) and carry one notification; manual wakes neither. */
  function wake(chatId: string, reason: WakeReason): boolean {
    if (!store.wakeChat(chatId, reason !== 'manual' && store.activeChatId() !== chatId)) return false;
    const chat = store.chat(chatId);
    if (reason !== 'manual' && chat) emit({type:'chatWoke', chatId, title: chat.title, reason});
    return true;
  }
  /** A question or approval never waits behind a snooze: any snoozed chat that needs the user wakes. */
  function wakeForAttention(chatId: string): void {
    const chat = store.chat(chatId);
    if (chat && (chat.snoozedUntil || chat.snoozeUntilActivity) && wake(chatId, 'activity')) scheduleSnoozes();
  }
  /** Wakes every due snooze (also those that fell due while Muster was closed) and arms one timer for the next.
   *  Instants are absolute, so DST changes cannot double-fire; the timer re-checks at least hourly (sleep, clock changes). */
  function scheduleSnoozes(): void {
    if (snoozeTimer) clearTimeout(snoozeTimer);
    snoozeTimer = undefined;
    if (disposed || closing || power.suspended()) return;
    const {due, next} = store.dueSnoozes(new Date());
    let woke = false;
    for (const chatId of due) woke = wake(chatId, 'time') || woke;
    if (woke) state();
    if (!next) return;
    snoozeTimer = setTimeout(scheduleSnoozes, Math.min(Math.max(Date.parse(next) - Date.now(), 250), 60 * 60_000));
    snoozeTimer.unref?.();
  }
  let archiveTimer: ReturnType<typeof setInterval> | undefined;
  /** CHAT-16: opt-in. Pinned, snoozed, running, queued, unread, recovery-needed, on-screen and needs-attention chats stay. */
  async function sweepIdleChats(): Promise<void> {
    if (disposed || closing) return;
    let days = 0;
    try {
      const settings = await domains.handlers.get('settings.get')?.({}) as {values?: Record<string, unknown>} | undefined;
      const value = settings?.values?.['chats.autoArchiveDays'];
      if (typeof value === 'number' && value > 0) days = value;
    } catch { return; }
    if (!days || disposed || closing) return;
    const keep = new Set<string>([...runs.keys(), ...[...approvals.values()].map(entry => entry.chatId), ...[...questions.values()].map(entry => entry.chatId)]);
    const active = store.activeChatId(); if (active) keep.add(active);
    for (const chat of store.snapshot().chats) if (chat.unread || chat.recovery?.kind === 'recovery-needed' || provider.hasActiveWork?.(chat.id)) keep.add(chat.id);
    const archived = store.autoArchiveIdle(new Date(Date.now() - days * 86_400_000).toISOString(), keep);
    if (!archived.length) return;
    state();
    emit({type:'notice', message:`Archived ${plural(archived.length, 'chat')} idle for over ${days} days. Find ${archived.length === 1 ? 'it' : 'them'} under Archived.`});
  }
  scheduleSnoozes();
  queueMicrotask(() => { void sweepIdleChats(); });
  archiveTimer = setInterval(() => { void sweepIdleChats(); }, 60 * 60_000); archiveTimer.unref?.();
  /** SBX-13: lock-screen / unlock-screen are accepted and ignored. */
  function powerEvent(input: {state: PowerState}): Promise<PowerOutcome> {
    if (!isPowerState(input?.state)) return Promise.reject(new Error('Unknown power state.'));
    if (disposed || closing) return Promise.resolve({state: input.state, handled: false, failures: []});
    return power.handle(input.state);
  }
  return {invoke, power: powerEvent, dispose(): Promise<void> {
    if (disposal) return disposal;
    closing = true;
    if (snoozeTimer) clearTimeout(snoozeTimer);
    if (archiveTimer) clearInterval(archiveTimer);
    disposal = (async () => {
      watcher.dispose(); watchedFolders.clear();
      for (const [chatId, run] of runs) { run.stopped = true; run.retry.abort(); settleApprovals(chatId); settleQuestions(chatId); }
      offIdleEvents?.(); offQueueEvents(); nativeTurns.dispose();
      provider.dispose();
      // Main owns the user-visible deadline. Keep the database open until all
      // tracked callbacks settle, even if main times out and keeps the app open.
      hindsight?.dispose();
      await Promise.allSettled([...invocations,...[...runs.values()].flatMap(run => run.promise ? [run.promise] : [])]);
      await domains.dispose();
      await toolOutputLog.flush().catch(() => {});
      disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); customProviders.close(); annotations.close(); projectTasks.close(); store.close();
    })();
    return disposal;
  }};
}
