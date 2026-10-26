import { applyPendingRestore } from './backups.ts';
import { APPROVAL_SHOWN_EVENT } from './turn-ledger.ts';
import { addMemory, listMemory, searchMemory, inspectMemoryStore, isVisibleInScopes, projectMemoryScope } from './memory-adapter.ts';
import { createMemoryIdentity } from './memory-identity.ts';
import { createSnapshotCoalescer } from './snapshot-coalescer.ts';
import { HindsightService } from './hindsight-service.ts';
import { MemoryConfigStore, MemoryTombstones, electronSecretBox } from './memory-context.ts';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { rescanProviderListings, setProviderListingStore } from './provider-instances.ts';
import type { AgentEvent, ApprovalData, ApprovalDecision, Chat, ChatRecovery, Commands, PendingQuestion, PendingQuestionData, ProviderInfo, QueuedMessage, ChatFallback, TimelineItem, WakeReason } from '../shared/protocol.ts';
import { CONTEXT_OVERFLOW, musterCompactAt, withUserWindow } from '../shared/context-window.ts';
import type { PendingAttentionSummary, AttentionRequest } from '../shared/attention-protocol.ts';
import { discoverLocalProviders } from './provider-discovery.ts';
import { homedir } from 'node:os';
import { absentCliAgentRows } from './adapters/cli-agents.ts';
import { CustomProviders } from './custom-providers.ts';
import { AgentStore } from './store.ts';
import { applyFolderAliases, canonicalFolderPath } from './folder-merge.ts';
import { WorkspaceWatchService } from './workspace-watch.ts';
import {claudeChildRow,claudeChildThread} from './subagent-rows.ts';
import {asksForSubagents,subagentSupport,subagentsUnavailableText} from './subagent-routes.ts';
import {appendCommandOutput,finishCommandOutput,stripAnsi} from './command-output-buffer.ts';
import {OutputLog} from './output-log.ts';
import {ProjectEventLog} from './project-event-log.ts';
import { toolEventDetails } from './tool-event-details.ts';
import { applyProviderEvent, COMPACTION_TEXT, isForeignThreadEvent } from './context-telemetry.ts';
import { forgetQuickOpen, listFiles, readFile, searchFiles } from './files.ts';
import { readAsset, readChatImage } from './file-assets.ts';
import {readDocument} from './document-preview.ts';
import {readWorkbook} from './workbook-preview.ts';
import {FileAnnotations} from './file-annotations.ts';
import {resolveInside} from './paths.ts';
import { AgentModeReviewHost } from './review.ts';
import {dirtyFileCount, gitStatus, mutateGit, pushGit, listPullRequests, compareUrl} from './git-local.ts';
import {createEntry, moveFile} from './file-operations.ts';
import { isElicitationRequest, elicitationPolicy, elicitationResult, elicitationText, elicitationServer } from '../shared/computer-use.ts';
import { isCompactCommand } from '../shared/compact-command.ts';
import { createProviderAdapter, NO_LIVE_SESSION, ProviderPreDispatchError, type ProviderAdapter, type ProviderResult } from './provider.ts';
import { discoverPlugins, discoverSkills, invokedPluginContext, resolveAttachedSkill, resolveInvokedPlugins } from './plugin-library.ts';
import {providerAccessPolicy} from './provider-run-lifecycle.ts';
import {parseKillIntent, userProcessThreat, type UserProcessTarget, type UserProcessThreat} from './user-process-guard.ts';
import {reconcileProviderTurn, type ReconciliationInput, type ReconciliationResult} from './provider-reconciliation.ts';
import { ProjectTaskStore, type TaskStatus } from './project-tasks.ts';
import { ChatQueue, QueueChangedError, queueActionAfter } from './chat-queue.ts';
import { AutoResumeStore, LIMIT_MAX_ATTEMPTS, limitClass, NATIVE_CONTINUATION, RESTART_CONTINUATION, autoResumeTiming, autoResumeView, hasNativeSession, isChatFallback, isUsageLimit, MAX_CHAT_FALLBACKS, limitResumeAt, resetClock, type AutoResumeRow } from './auto-resume.ts';
import { liveProviderUsage } from './provider-usage.ts';
import type { ProviderUsage } from '../shared/domains/providers-protocol.ts';
import { PluginReloads, installedPlugin, lastTurn, pluginReloadNotice, turnAbout, turnMentions, type InstalledPlugin } from './plugin-reload.ts';
import { createNativeThreadBridge } from './codex-native.ts';
import { createNativeTurnObserver } from './native-turns.ts';
import { createNativeQueueMirror } from './native-queue.ts';
import { ChatAttachments, attachedFileLines } from './attachments.ts';
import { admissionRetryText, asSentence, retryClock, withAdmissionRetry } from './admission-retry.ts';
import { ContextLedger, HISTORY_WINDOW_EVENT, TOOLS_UNAVAILABLE_EVENT, requestsConnectors, type ContextBlock } from './context-budget.ts';
import { createDomainHooks } from './domains/hooks.ts';
import { createDomains } from './domains/index.ts';
import type { DomainFactory } from './domains/types.ts';
import { createPowerEvents, isPowerState, type PowerOutcome, type PowerState } from './power-events.ts';
import { ARCHIVE_RUNNING_WARNING, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, MAX_QUEUED_MESSAGES, MAX_QUEUED_TEXT, REASONING_EFFORTS, type ReasoningEffort } from '../shared/protocol.ts';
import type { ChatGoal } from '../shared/domains/goals-protocol.ts';
import { firstReadyModel } from '../shared/domains/settings-protocol.ts';
import { attentionDeadline, pendingStatusAtRead } from '../shared/attention-expiry.ts';
import { isAdapterProvider } from './adapters/index.ts';
import { CLAUDE_LANE_DRIVER, effectiveDriver } from '../shared/provider-lanes.ts';
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
import { ToolHost, toolText } from './governance/tool-host.ts';
import { ASK_MCP, ASK_USER_METHOD, ASK_USER_SPEC, ASK_QUESTION_ID, askUserAnswerMessage, askUserCard, askUserReply, askUserRunOverrides, isNonBlockingQuestion, parseAskUser } from './ask-user.ts';
import { plural } from '../shared/wording.ts';
import { device } from '../shared/device-noun.ts';

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
interface ActiveRun { cwd: string; stopped: boolean; prompt?: string; promise?: Promise<void>; retry: AbortController; seal?(): void; /** #448: the run ended on a provider usage limit. */ limit?: {text: string; retryAfterMs?: number; notDispatched: boolean; prompt: string; attachmentIds: string[]}; /** #449: Muster quit under this run (not a user Stop); `shutdown` when it continues after the next start. */ quit?: boolean; shutdown?: boolean }
interface PendingApproval { chatId: string; createdAt: string; expiresAt: number; resolve(decision: ApprovalDecision): void; timer: ReturnType<typeof setTimeout> }
/** `null` answers mean the question was dismissed, expired or interrupted: the provider gets a cancel, never empty answers. */
type QuestionAnswers = Record<string, {answers: string[]}> | null;
interface PendingQuestionRequest { chatId: string; createdAt: string; expiresAt: number; providerKey: string; itemId: string; questions: PendingQuestion[]; resolve(answers: QuestionAnswers): void; waiters: Array<(answers: QuestionAnswers) => void>; timer: ReturnType<typeof setTimeout> }
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
  return ['User-owned local processes (started by the user in Muster, not by you). Never signal, kill or restart the process groups listed below or their children, and do not free ports they hold; if a local port is taken, use another port or ask. This applies to nothing else: remote hosts (ssh, servers), systemd or launchd services, and anything the user explicitly asks for are allowed:',
    ...relevant.map(group => `- process group ${group.pgid}: ${group.label.replace(/[\x00-\x1f]/g, ' ').slice(0, 80)}${group.cwd ? ` (cwd ${group.cwd.slice(0, 200)})` : ''}`)].join('\n');
}
const PROVIDER_LISTING_WAIT_MS = 15_000;
export function createAgentService(options: { dataDir: string; onEvent(event: AgentEvent): void; userProcesses?: () => readonly UserProcessGroup[]; userProcessTargets?: () => Promise<readonly UserProcessTarget[]>; provider?: ProviderAdapter; reconcileProvider?: (input: ReconciliationInput) => Promise<ReconciliationResult>; domains?: readonly DomainFactory[];
  /** Serve the ask_user MCP server to CLI routes (default: on outside tests). */ askUserTools?: boolean }) {
  applyPendingRestore(options.dataDir);
  setProviderListingStore(join(options.dataDir, 'provider-listings'));
  const store = new AgentStore(options.dataDir);
  // M4 (#319): ids merged by the duplicate-folder migration are remapped in the stores that keep their own database files.
  try { const aliases = store.pendingFolderAliases(); if (Object.keys(aliases).length && applyFolderAliases(options.dataDir, aliases)) store.clearFolderAliases(); } catch { /* retried on the next start */ }
  const queue = new ChatQueue(store);
  /** #450: chats whose queue head is being sent right now (its row stays queued until the receipt is recorded). */
  const dispatching = new Set<string>();
  const pluginReloads = new PluginReloads();
  const attachments = new ChatAttachments(store.database(), options.dataDir);
  const domainHooks = createDomainHooks();
  const steered = new Map<string, string>();
  const steerChains = new Map<string, Promise<void>>();
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
  const memoryIdentity = createMemoryIdentity();
  // Fill the identity caches off the event loop so the sync lookups below rarely spawn git themselves.
  void memoryIdentity.warm(store.snapshot().folders);
  // Legacy hindsight.* commands honour the in-app Memory settings too, not only environment variables.
  let secretBox: ReturnType<typeof electronSecretBox> | null = null;
  const memoryConfig = new MemoryConfigStore(options.dataDir, () => secretBox === null ? secretBox = electronSecretBox() : secretBox);
  const hindsightClient = () => hindsight ??= new HindsightService({readConfig: () => memoryConfig.hindsight(), resolveFolderScope(folderId) {
    // Same banks as the memory domain (memory-identity.ts): per person, per repository, private otherwise.
    if (folderId === 'personal') return memoryIdentity.personal();
    return memoryIdentity.folder(folderFor(folderId));
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
  // #448/#449: pending automatic continuations live in SQLite, so they are re-armed after a restart.
  const autoResume = new AutoResumeStore(store.database());
  /** #449: chats that were working when Muster closed and may continue after this start. Never one that was waiting on an
   *  approval or a question (that decision is the user's), never one being stopped, never a continuation cut short again. */
  const restartCandidates: string[] = [];
  for (const chat of store.snapshot().chats) {
    const prior = autoResume.get(chat.id);
    // A clean quit settled the run already and left a 'shutdown' row (with its prompt) to continue from.
    if (prior?.state === 'shutdown') {
      if (chat.archived) { autoResume.delete(chat.id); continue; }
      restartCandidates.push(chat.id);
      if (store.queue(chat.id).length && !queue.paused(chat.id)) queue.pause(chat.id, 'interrupted');
      continue;
    }
    if (chat.status !== 'running' && chat.status !== 'stopping') {
      if (prior?.state === 'running') {
        autoResume.delete(chat.id);
        // Its continuation was cut short by the quit (the quit settled it as interrupted): never continue it a second time.
        if (prior.kind === 'restart' && chat.status === 'interrupted') store.appendItem(chat.id, 'notice', 'Muster closed again before the automatic continuation finished, so it was not continued again. Send a message to continue.', 'completed', {kind:'auto-resume', reason:'restart-again'});
      }
      continue;
    }
    if (prior?.state === 'running') {
      autoResume.delete(chat.id);
      if (prior.kind === 'restart') { store.appendItem(chat.id, 'notice', 'Muster closed again before the automatic continuation finished, so it was not continued again. Send a message to continue.', 'completed', {kind:'auto-resume', reason:'restart-again'}); continue; }
    }
    if (chat.status !== 'running' || chat.archived) continue;
    if (store.timeline(chat.id).some(item => (item.kind === 'approval' || item.kind === 'question') && item.status === 'pending')) continue;
    restartCandidates.push(chat.id);
  }
  // Adapter routes and the Messages lane (#688) run inside Muster: their work died with the process.
  const orphaned = store.recoverOrphanedRuns(chat => chat.providerThreadDriver === CLAUDE_LANE_DRIVER || isAdapterProvider(chat.providerThreadProviderId ?? chat.providerId ?? ''));
  // #450: rows already sent are dropped and natively held rows come back; an orphaned chat's queue waits for it to continue.
  queue.recoverAtBoot();
  for (const chatId of orphaned) if (store.queue(chatId).length && !queue.paused(chatId)) queue.pause(chatId, 'interrupted');
  for (const chat of store.snapshot().chats) {
    for (const item of store.timeline(chat.id)) {
      // The provider request ended with the previous process; the card stays readable but cannot be reopened.
      // No handler survives a restart. The same read-time rule decides: past its stored deadline it expired, otherwise it was lost.
      // An ask_user question never had a waiting handler: it stays answerable, and its answer becomes the next turn.
      if ((item.kind === 'question' || item.kind === 'approval') && item.status === 'pending' && !isNonBlockingQuestion(item.data)) { const settled = pendingStatusAtRead(item, Date.now(), false); store.updateItem(item.id, item.text, settled.status, {...item.data, expiredReason:settled.reason}); }
      // A manual compaction request in flight when the app closed: no new process will ever settle this row.
      if (item.kind === 'notice' && item.data?.kind === 'compaction' && item.status === 'running') store.updateItem(item.id, 'Compaction status unknown: Muster restarted while it was in progress. History is unchanged. Retry, or continue in a fresh thread with a summary.', 'failed', {...item.data, status: 'failed', actions: ['retry', 'fresh']});
    }
  }
  // PRJ-07: every Project change carries a durable per-Project sequence so clients detect and replay missed events.
  const projectFeed = new ProjectEventLog(store.database());
  const emit = (event: AgentEvent) => {
    if (disposed) return;
    if (event.type === 'workspaceChanged') forgetQuickOpen();
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
  /** Queue chips and pause, the goal strip and a usage limit's resume (#448) ride on the snapshot's chats. */
  function decorateChat(chat: Chat, goal: ChatGoal | undefined, resume: AutoResumeRow | undefined, fallbacks: ChatFallback[] | undefined = autoResume.fallbacks(chat.id)): Chat {
    const decorated = queue.decorate(chat), view = autoResumeView(resume);
    return {...decorated, ...(goal ? {goal} : {}), ...(view ? {autoResume: view} : {}), ...(fallbacks?.length ? {fallbacks} : {})};
  }
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
    const stored = store.snapshot(), goals = goalsByChat(), resumes = new Map(autoResume.all().map(row => [row.chatId, row])), fallbacks = autoResume.allFallbacks();
    const current = {...stored, folders: stored.folders.map(folder => folderMissing(folder.path) ? {...folder, missing: true} : folder), chats: stored.chats.map(chat => decorateChat(chat, goals.get(chat.id), resumes.get(chat.id), fallbacks.get(chat.id)))};
    const requests = new Map<string, AttentionRequest[]>();
    const add = (chatId: string, request: AttentionRequest) => {
      const group = requests.get(chatId) ?? []; group.push(request); requests.set(chatId, group);
    };
    // Only an owned live resolver makes a persisted request actionable. Never
    // copy provider payloads, question options, commands, or answers here.
    for (const [itemId, pending] of approvals) add(pending.chatId, {itemId, kind:'approval', createdAt:pending.createdAt, expiresAt:new Date(pending.expiresAt).toISOString(), sourceLabel:'Provider approval'});
    for (const [itemId, pending] of questions) add(pending.chatId, {itemId, kind:'question', createdAt:pending.createdAt, expiresAt:new Date(pending.expiresAt).toISOString(), sourceLabel:'Provider question'});
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
  /** F3: `state()` is called from ~56 places and each full snapshot is a SQLite read plus an IPC clone and a
   *  renderer re-render; bursts collapse (snapshot-coalescer.ts). A command's reply flushes a pending one first. */
  const snapshots = createSnapshotCoalescer(() => emit({ type: 'snapshot', snapshot: snapshot() }));
  const state = (): void => snapshots.request();
  const publishedTimelineRevisions = new Map<string, number>();
  /** The last assistant message of the latest turn (after the last user message), or '' when the turn said nothing. */
  const finalAssistantText = (chatId: string): string => { const items = store.timeline(chatId); for (let i = items.length - 1; i >= 0; i--) { const it = items[i]!; if (it.kind === 'user') return ''; if (it.kind === 'assistant' && it.text.trim()) return it.text; } return ''; };
  /** The streaming reply of each running chat, written to the store at most once per timeline publish (not once per delta). */
  const segmentFlushes = new Map<string, () => void>();
  const timeline = (chatId: string) => {
    segmentFlushes.get(chatId)?.();
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
    if(linked.status==='completed'||linked.status==='failed'||linked.status==='interrupted')projectTasks.settleRunForChat(linked.id,linked.status,linked.error,finalAssistantText(linked.id));
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
  /** The end of the user's notification mute, if one is active: a request raised or still open then is not allowed to lapse unseen. */
  async function mutedUntilMs(): Promise<number | null> {
    try {
      const settings = await domains.handlers.get('settings.get')?.({}) as {values?: Record<string, unknown>} | undefined;
      const value = settings?.values?.['notifications.mutedUntil'];
      const at = typeof value === 'string' ? Date.parse(value) : NaN;
      return Number.isFinite(at) && at > Date.now() ? at : null;
    } catch { return null; }
  }
  /** Arms the expiry timer from the stored deadline. If a mute window now outlasts it, the deadline moves instead of expiring. */
  /** Fires one request's expiry from its stored deadline. If a mute window now outlasts it, the deadline moves (and the timer re-arms) instead of expiring. */
  async function expireDue(itemId: string, pending: {expiresAt: number; timer: ReturnType<typeof setTimeout>}, live: () => boolean, expire: () => void): Promise<void> {
    if (!live()) return;
    const muted = await mutedUntilMs(), extended = muted === null ? 0 : attentionDeadline(Date.now(), muted);
    if (live() && extended > pending.expiresAt + 1000) {
      pending.expiresAt = extended;
      const item = store.item(itemId);
      if (item) store.updateItem(itemId, item.text, item.status, {...item.data, expiresAt:new Date(extended).toISOString()});
      armExpiry(itemId, pending, live, expire); state(); return;
    }
    if (live()) expire();
  }
  /** Arms the expiry timer from the stored deadline. */
  function armExpiry(itemId: string, pending: {expiresAt: number; timer: ReturnType<typeof setTimeout>}, live: () => boolean, expire: () => void): void {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => { void expireDue(itemId, pending, live, expire); }, Math.max(0, pending.expiresAt - Date.now()));
    pending.timer.unref?.();
  }
  /** Expires every pending approval/question whose stored deadline has passed, through the same path the timer takes. Timers can run late after a sleep, so main calls this on wake and from its attention interval. */
  async function sweepExpired(): Promise<number> {
    const now = Date.now(), due: Array<Promise<void>> = [];
    for (const [itemId, pending] of [...approvals]) if (pending.expiresAt <= now) due.push(expireDue(itemId, pending, () => approvals.get(itemId) === pending, () => finishApproval(itemId, pending, 'decline', 'expired')));
    for (const [itemId, pending] of [...questions]) if (pending.expiresAt <= now) due.push(expireDue(itemId, pending, () => questions.get(itemId) === pending, () => finishQuestion(itemId, pending, null, 'expired')));
    await Promise.all(due); return due.length;
  }
  /** Why an approval or question can no longer be answered, or null while it still applies. A live handler means the provider is still waiting; the step it was for must also still be unfinished. */
  function staleAttention(chatId: string, itemId: string): string | null {
    const chat = store.chat(chatId);
    // Background sub-agents can ask after the turn ended, so a settled chat is fine; a missing or archived one is not.
    if (!chat || chat.archived) return 'This chat is no longer available, so the request no longer applies.';
    const item = store.item(itemId), toolItemId = typeof item?.data?.toolItemId === 'string' ? item.data.toolItemId : undefined, tool = toolItemId ? store.item(toolItemId) : undefined;
    if (tool && ['completed', 'failed', 'interrupted'].includes(tool.status ?? '')) return 'The step this request was for has already finished. Use Ask again if you still need it.';
    return null;
  }
  function finishApproval(itemId: string, pending: PendingApproval, decision: ApprovalDecision, status: string, reason?: 'stale') {
    if (approvals.get(itemId) !== pending) return;
    clearTimeout(pending.timer); approvals.delete(itemId);
    const item = store.item(itemId);
    if (item) store.updateItem(itemId, item.text, status, status === 'expired' ? {...item.data, expiredReason:'timeout'} : reason ? {...item.data, expiredReason:reason} : item.data);
    if (status === 'expired') store.appendItem(pending.chatId, 'notice', 'An approval request timed out before you answered, so the agent was told it was not approved. Use Ask again to have it re-ask.', 'completed', {kind:'attention-expired', itemId});
    const toolItemId = typeof item?.data?.toolItemId === 'string' ? item.data.toolItemId : undefined, tool = toolItemId ? store.item(toolItemId) : undefined;
    if (tool?.data?.awaitingApproval === itemId) { const {awaitingApproval: _cleared, ...rest} = tool.data; store.updateItem(tool.id, tool.text, tool.status, {...rest, ...(status === 'declined' ? {executionDenied:true} : status === 'expired' ? {executionDenied:true, deniedReason:'timeout'} : {})}); }
    timeline(pending.chatId); state(); pending.resolve(decision);
  }
  function finishQuestion(itemId: string, pending: PendingQuestionRequest, answers: QuestionAnswers, status: string, receiptAnswers?: Record<string, {answers:string[]}>, reason?: 'stale') {
    if (questions.get(itemId) !== pending) return;
    clearTimeout(pending.timer); questions.delete(itemId);
    if (questionsByProviderKey.get(pending.providerKey) === itemId) questionsByProviderKey.delete(pending.providerKey);
    const item = store.item(itemId);
    if (item) store.updateItem(itemId, item.text, status, {...item.data, ...(receiptAnswers ? {answers:receiptAnswers} : {}), ...(status === 'expired' ? {expiredReason:'timeout'} : reason ? {expiredReason:reason} : {})});
    if (status === 'expired') store.appendItem(pending.chatId, 'notice', 'A question timed out before you answered, so the agent was told it was cancelled. Use Ask again to have it re-ask.', 'completed', {kind:'attention-expired', itemId});
    timeline(pending.chatId); state();
    pending.resolve(answers); pending.waiters.splice(0).forEach(resolve => resolve(answers));
  }
  // ── ask_user: non-blocking questions ─────────────────────────────────────
  /** Posts the question card and answers the tool at once with the default. Never waits, in any access mode. */
  function askUser(chatId: string, args: Record<string, unknown>): {content: Array<{type: 'text'; text: string}>; isError?: true; text: string} {
    const reply = (text: string, isError = false) => ({...toolText(text, isError), text} as {content: Array<{type: 'text'; text: string}>; isError?: true; text: string});
    const chat = store.chat(chatId);
    if (disposed || closing || !chat) return reply('This chat is not available.', true);
    const input = parseAskUser(args);
    if (typeof input === 'string') return reply(input, true);
    store.appendItem(chatId, 'question', input.question, 'pending', {...askUserCard(input)});
    timeline(chatId); state();
    return reply(askUserReply(input));
  }
  let askHost: ToolHost | undefined, askLauncher: string | undefined;
  if (options.askUserTools ?? !process.env.NODE_TEST_CONTEXT) {
    askHost = new ToolHost({dir: join(options.dataDir, 'agent-tools', 'ask'), name: ASK_MCP, title: 'Muster questions', specs: [ASK_USER_SPEC], execPath: process.execPath, timeoutMs: 30_000,
      run: (chatId, _tool, args) => { const {text: _text, ...result} = askUser(chatId, args); return result; }});
    void askHost.start().then(launcher => { askLauncher = launcher; }, error => console.warn(`Agent question tool unavailable: ${error instanceof Error ? error.message : String(error)}`));
  }
  /** Adds the muster_ask MCP server to a run (CLI routes load it; HTTP routes offer ask_user natively instead). */
  function withAskUser<T extends {configOverrides?: Record<string, unknown>}>(chatId: string, runOptions: T): T {
    const extra = askHost && askLauncher ? askUserRunOverrides(chatId, askLauncher, askHost.chatToken(chatId)) : {};
    return Object.keys(extra).length ? {...runOptions, configOverrides: {...runOptions.configOverrides, ...extra}} : runOptions;
  }
  /** A later answer: recorded on the card at once (so a second answer is a no-op), then delivered as a steer while the
   *  run is going and the route takes one, or as the next turn through the chat queue. */
  async function answerAsked(itemId: string, raw: unknown): Promise<void> {
    const item = store.item(itemId);
    if (!item || item.kind !== 'question') throw new Error('This question no longer exists.');
    if (item.status === 'answered') return;
    if (item.status !== 'pending') throw new Error('This question was already closed.');
    const chat = chatFor(item.chatId);
    if (chat.archived) throw new Error('Restore this chat before answering.');
    const values = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)[ASK_QUESTION_ID] : undefined;
    const list = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>).answers : undefined;
    if (!Array.isArray(list) || list.length !== 1 || typeof list[0] !== 'string' || !list[0].trim() || list[0].length > 4096) throw new Error('Invalid question answers.');
    const answer = list[0].trim();
    const question = Array.isArray(item.data?.questions) ? String((item.data.questions[0] as {question?: unknown} | undefined)?.question ?? item.text) : item.text;
    store.updateItem(itemId, item.text, 'answered', {...item.data, answers: {[ASK_QUESTION_ID]: {answers: [answer]}}});
    timeline(chat.id); state();
    const message = askUserAnswerMessage(question, answer), requestId = `ask-${itemId}`;
    let delivered: 'steered' | 'queued' = 'queued';
    if (runs.has(chat.id) && (await steerRun(chat, message, requestId, {})).steered) delivered = 'steered';
    else await dispatch('chat.queue.add', {id: chat.id, text: message, requestId});
    const latest = store.item(itemId);
    if (latest) { store.updateItem(itemId, latest.text, latest.status, {...latest.data, delivered}); timeline(chat.id); }
  }
  function dismissAsked(itemId: string): void {
    const item = store.item(itemId);
    if (!item || item.status !== 'pending') return;
    store.updateItem(itemId, item.text, 'dismissed', item.data); timeline(item.chatId); state();
  }
  function settleApprovals(chatId: string) {
    for (const [itemId, pending] of approvals) if (pending.chatId === chatId) finishApproval(itemId, pending, 'decline', 'interrupted');
  }
  const compactions = new Map<string, string>();
  /** #426: a compaction the provider started on its own (Codex `contextCompaction` item) shows "Compacting context…" until it settles. */
  const nativeCompacting = new Map<string, string>();
  /** Settles a manual compaction row, or appends the automatic one. The source transcript here is never trimmed. */
  function compactionCompleted(chatId: string) {
    // A compacted thread summarises earlier messages: static context goes out again on the next turn.
    contextLedger.forget(chatId);
    const manual = compactions.get(chatId); compactions.delete(chatId);
    const native = nativeCompacting.get(chatId); nativeCompacting.delete(chatId);
    const data = {kind:'compaction', status:'completed', ...(manual ? {manual:true} : {})};
    if (manual) { store.updateItem(manual, 'Context compacted', 'completed', data); if (native) store.updateItem(native, COMPACTION_TEXT, 'completed', {kind:'compaction', status:'completed'}); }
    else if (native) store.updateItem(native, COMPACTION_TEXT, 'completed', data);
    else store.appendItem(chatId, 'notice', COMPACTION_TEXT, 'completed', data);
    timeline(chatId);
  }
  /** #583: a manual compaction the provider accepted is settled at once; Codex reports that same compaction (its
   *  contextCompaction item, then thread/compacted) only afterwards. Those reports must not add an automatic row. */
  const acceptedCompactions = new Map<string, number>();
  const ACCEPTED_REPORT_MS = 120_000;
  function acceptedReport(chatId: string): boolean {
    const at = acceptedCompactions.get(chatId);
    if (at === undefined) return false;
    if (Date.now() - at <= ACCEPTED_REPORT_MS) return true;
    acceptedCompactions.delete(chatId); return false;
  }
  /** Consumes the provider's report of an accepted manual compaction: the thread was compacted, and its row already says so. */
  function absorbAcceptedReport(chatId: string): boolean {
    if (!acceptedReport(chatId)) return false;
    acceptedCompactions.delete(chatId); contextLedger.forget(chatId); return true;
  }
  /** #426: failure rows say why and offer Retry and "Continue in a fresh thread with a summary". */
  const COMPACTION_ACTIONS = ['retry', 'fresh'] as const;
  /** A /compact or "Compact now" while a turn runs: compacts as soon as that turn settles (row id, fresh). */
  const deferredCompactions = new Map<string, {rowId: string; fresh: boolean}>();
  /** In-flight compactions: a send waits for one to settle instead of racing it. */
  const compactionRuns = new Map<string, Promise<void>>();
  /** Drops the provider thread and seeds the next turn with a digest of the stored transcript (the provider-switch digest). */
  async function compactFromTranscript(chatId: string, rowId: string, text: string, data: Record<string, unknown>) {
    await provider.release?.(chatId).catch(() => undefined);
    store.requireDigest(chatId);
    store.updateChat(chatId, {providerThreadId: null, providerTurnId: null, providerThreadProviderId: null, providerThreadBindingId: null, providerThreadDriver: null});
    contextLedger.forget(chatId);
    const telemetry = {...store.contextTelemetry(chatId), compacted: true, updatedAt: new Date().toISOString()};
    store.setContextTelemetry(chatId, telemetry); emit({type: 'contextTelemetry', chatId, telemetry});
    store.updateItem(rowId, text, 'completed', {kind:'compaction', status:'completed', ...data});
    timeline(chatId); state();
  }
  const FROM_TRANSCRIPT = 'Context compacted from the saved transcript. The next message starts a fresh provider conversation with a summary of the earlier messages.';
  /** Manual compaction. A live provider session compacts its own thread. With none (a project chat after a restart, a thread retired by a
   *  stopped turn, a provider switch, an imported chat, a route without native compaction) Muster compacts from the stored transcript: the
   *  thread is dropped and the next message starts a fresh provider conversation seeded with the same summary digest a provider switch uses.
   *  `fresh` skips the provider. While a turn runs, compaction waits for it (#426) instead of refusing. */
  async function compactChat(chatId: string, options: {fresh?: boolean; rowId?: string} = {}): Promise<void> {
    const chat = chatFor(chatId);
    if (compactions.has(chatId)) throw new Error('Compaction is already in progress.');
    if (runs.has(chatId) || busy(chat)) {
      const waiting = deferredCompactions.get(chatId);
      if (waiting) { if (options.fresh) waiting.fresh = true; return; }
      const row = store.appendItem(chatId, 'notice', 'Compacting after the current turn finishes…', 'running', {kind:'compaction', status:'running', manual:true, deferred:true});
      deferredCompactions.set(chatId, {rowId: row.id, fresh: !!options.fresh}); timeline(chatId); return;
    }
    const existing = options.rowId ? store.item(options.rowId) : undefined;
    const row = existing ?? store.appendItem(chatId, 'notice', 'Compacting context…', 'running', {kind:'compaction', status:'running', manual:true});
    if (existing) store.updateItem(row.id, 'Compacting context…', 'running', {kind:'compaction', status:'running', manual:true});
    compactions.set(chatId, row.id); acceptedCompactions.delete(chatId); timeline(chatId);
    let settle!: () => void;
    compactionRuns.set(chatId, new Promise<void>(resolve => { settle = resolve; }));
    const fail = (reason: string) => {
      if (compactions.get(chatId) === row.id) compactions.delete(chatId);
      store.updateItem(row.id, `Compaction failed: ${reason.replace(/[.\s]+$/, '')}. History is unchanged. Retry, or continue in a fresh thread with a summary.`, 'failed', {kind:'compaction', status:'failed', manual:true, reason, actions:[...COMPACTION_ACTIONS]});
      timeline(chatId);
    };
    try {
      const history = store.timeline(chatId).some(item => item.kind === 'user');
      if (options.fresh || !provider.compact) {
        compactions.delete(chatId);
        if (!history) { fail('there is no conversation to compact yet'); throw new Error('There is no conversation to compact yet.'); }
        await compactFromTranscript(chatId, row.id, FROM_TRANSCRIPT, {manual:true, fresh:true}); return;
      }
      try { await provider.compact(chatId); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.startsWith(NO_LIVE_SESSION.slice(0, 40)) && history) {
          compactions.delete(chatId);
          await compactFromTranscript(chatId, row.id, FROM_TRANSCRIPT, {manual:true}); return;
        }
        fail(message || 'the provider refused the request');
        throw error;
      }
      // The provider confirms with thread/compacted; a quiet provider still settles the row once the request was accepted.
      if (compactions.get(chatId) === row.id) { compactionCompleted(chatId); acceptedCompactions.set(chatId, Date.now()); }
    } finally {
      compactionRuns.delete(chatId); settle();
      if (!runs.has(chatId) && store.queue(chatId).length) dispatchQueued(chatId);
    }
  }
  /** #426: before a turn, a chat at or over its model's compaction point is compacted first (Muster's own trigger), on every route.
   *  The point follows the model's own window (catalog, router listing, provider report, then a default) and its catalog
   *  auto_compact_token_limit; routes that compact natively get a late safety net instead. Never a silent stop at 100%. */
  async function autoCompactBeforeTurn(chat: Chat, route: ProviderInfo): Promise<boolean> {
    const telemetry = store.contextTelemetry(chat.id);
    if (telemetry.compacted || telemetry.usedTokens === null || compactions.has(chat.id)) return false;
    const model = withUserWindow(route.models.find(entry => entry.id === chat.model), domainHooks.contextWindowOverride(route.id, chat.model));
    const {at, window} = musterCompactAt(effectiveDriver(route.driver, chat), model, telemetry.windowTokens, telemetry.usedTokens);
    if (telemetry.usedTokens < at || !store.timeline(chat.id).some(item => item.kind === 'user')) return false;
    const used = `${Math.round(telemetry.usedTokens / 1000)}K of ${Math.round(window.tokens / 1000)}K tokens`;
    const row = store.appendItem(chat.id, 'notice', `Compacting context before this message (${used} in use)…`, 'running', {kind:'compaction', status:'running', auto:true});
    timeline(chat.id);
    await compactFromTranscript(chat.id, row.id, `Context compacted automatically at ${used}. This message starts a fresh provider conversation with a summary of the earlier messages; the chat history here is unchanged.`, {auto:true, at, window:window.tokens, windowSource:window.source});
    return true;
  }
  function settleQuestions(chatId: string) {
    for (const [itemId, pending] of questions) if (pending.chatId === chatId) finishQuestion(itemId, pending, null, 'interrupted');
  }
  function validateRunnableModel(model: string, providerId: string | undefined) {
    if (!providerId) throw new Error('No model is connected yet. Connect a model (Settings › Providers), then pick it in the composer.');
    const listed = provider.info().filter(candidate => candidate.id === providerId);
    if (!listed.length) throw new Error(`The provider “${providerId}” is not available on ${device().lower}. Pick another model for this chat.`);
    // A provider that reports no model list runs whatever model the chat names; the provider checks it at dispatch.
    const entry = listed.find(candidate => candidate.available && (candidate.models.some(candidateModel => candidateModel.id === model) || candidate.models.length === 0));
    if (!entry) {
      const row = listed[0]!;
      // A gateway without a model catalog lists its models live; say exactly what state that listing is in.
      if (row.listing === 'loading') throw new Error(`Still loading models from ${row.name}. Try again in a moment.`);
      if (row.listing === 'failed' || (row.listing === 'stale' && row.listingError)) throw new Error(row.listingError ?? `${row.name} didn’t answer. Retry.`);
      if (row.listing === 'live' || row.listing === 'stale') throw new Error(`${model || '(none)'} isn’t offered by ${row.name} any more. Pick another model.`);
      throw new Error(`Model ${model || '(none)'} is unavailable through the configured provider. Choose an available model.`);
    }
    return entry;
  }
  /** Provider and model for a chat nobody chose one for: Project → folder → user default, else the first ready provider. */
  function newChatModel(input: { folderId?: string; projectId?: string }): { providerId: string; model: string; effort?: ReasoningEffort } {
    const defaults = domainHooks.chatDefaults(input);
    if (defaults.providerId && defaults.model?.trim()) return { providerId: defaults.providerId, model: defaults.model.trim(), ...(defaults.effort ? { effort: defaults.effort } : {}) };
    return firstReadyModel(provider.info());
  }
  async function send(chatId: string, prompt: string, requestId: string, skill?: string | string[], attachmentIds: string[] = [], invoked: {pluginIds?: string[]; effort?: ReasoningEffort; reuseUserItemId?: string; queued?: QueuedMessage; userData?: Record<string, unknown>} = {}) {
    // /compact is Muster's command in every chat type and provider: never a message for the model.
    if (isCompactCommand(prompt) && attachmentIds.length === 0 && skill === undefined) { await compactChat(chatId); return {runId: ''}; }
    // A compaction in flight settles first: the next turn goes to the compacted (or fresh) thread.
    await compactionRuns.get(chatId)?.catch(() => undefined);
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
    // A gateway's live model listing may still be loading (app just started) or have failed once: wait for it, bounded, then validate.
    if (chat.providerId) { await provider.awaitListing?.(chat.providerId, PROVIDER_LISTING_WAIT_MS).catch(() => undefined); chat = chatFor(chatId); }
    validateRunnableModel(chat.model,chat.providerId);
    const project = chat.projectId ? store.snapshot().projects.find(p => p.id === chat.projectId) : undefined;
    const context = project ? `Project: ${project.name}\nShared goal: ${project.goal || '(not set)'}` : '';
    const skillContext = [...attachedSkills.map(entry => `Selected skill: ${entry.name} (${entry.provenance})\n\nApply these user-selected skill instructions to the current request:\n<skill-instructions>\n${entry.content}\n</skill-instructions>`), invokedPluginContext(plugins)].filter(Boolean).join('\n\n');
    const defaultCwd = folder ? canonicalFolderPath(folder.path) : join(options.dataDir, 'scratch', chatId);
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
    // #319: a chat-only model in an Agent chat answers as chat, and the chat says so. Moving it to another provider or account is the
    // user's choice (the composer's "Switch to…" button), never done here: that would send the conversation to a different vendor.
    if (chat.mode === 'agent' && selectedProvider.models.find(entry => entry.id === chat.model)?.tools === false && !store.timeline(chatId).some(item => item.data?.kind === 'tools-unavailable' && item.data?.model === chat.model && item.data?.providerId === selectedProvider.id)) {
      store.appendItem(chatId, 'notice', `${selectedProvider.models.find(entry => entry.id === chat.model)?.name ?? chat.model} can’t run commands or edit files through ${selectedProvider.name}, so this chat answers without tools. Use “Switch to…” in the composer to pick a model with tools.`, 'completed', {kind: 'tools-unavailable', model: chat.model, providerId: selectedProvider.id});
    }
    // #427: a route with no sub-agent tool says so once, in one plain line, when the request asks for sub-agents (every chat type).
    if (subagentSupport(effectiveDriver(selectedProvider.driver, chat)) === 'none' && asksForSubagents(prompt) && !store.timeline(chatId).some(item => item.data?.kind === 'subagents-unavailable' && item.data?.providerId === selectedProvider.id)) {
      store.appendItem(chatId, 'notice', subagentsUnavailableText(selectedProvider.name), 'completed', {kind: 'subagents-unavailable', providerId: selectedProvider.id});
    }
    if (await autoCompactBeforeTurn(chat, selectedProvider)) chat = chatFor(chatId);
    const bindingId=selectedProvider.bindingId??selectedProvider.id;
    if (chat.providerBindingId && chat.providerBindingId!==bindingId) throw new Error('The selected provider account or profile changed. Select it again before sending. Your draft is retained.');
    const nativeMatches=chat.providerThreadProviderId===selectedProvider.id && chat.providerThreadBindingId===bindingId;
    if (!chat.providerBindingId || (chat.providerThreadId && !nativeMatches)) {
      if (chat.providerThreadId && !nativeMatches) { store.appendItem(chatId,'notice','This provider will start a fresh conversation with a summary of the earlier messages. The displayed chat history is retained.','completed'); store.requireDigest(chatId); contextLedger.forget(chatId); }
      chat=store.updateChat(chatId,{providerId:selectedProvider.id,providerBindingId:bindingId,...(!nativeMatches?{providerThreadId:null,providerTurnId:null,providerThreadProviderId:null,providerThreadBindingId:null,providerThreadDriver:null}:{})});
    }
    const access = providerAccessPolicy(chat);
    // A fork (or a replaced turn) starts a fresh provider conversation: carry the visible history once, bounded.
    const digest = store.needsDigest(chatId) ? transcriptDigest(store.timeline(chatId), cwd) : '';
    const files = attachments.resolve(chatId, attachmentIds);
    // #450: a queued message leaves the queue in the same transaction that records its receipt.
    const queued = invoked.queued;
    const userData = {...(invoked.userData ?? {}), ...(files.length ? {attachments: files.map(({path: _path, ...ref}) => ({...ref, state: 'sent'}))} : {})};
    const accepted = store.recordSend(chatId, requestId, prompt, fingerprint, {...(Object.keys(userData).length ? {userData} : {}), ...(files.length || queued ? {within: () => { if (files.length) attachments.markSent(attachmentIds); if (queued) queue.consume(chatId, queued); }} : {}), ...(invoked.reuseUserItemId ? {reuseUserItemId: invoked.reuseUserItemId} : {})});
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
    const run: ActiveRun = {cwd, stopped: false, retry: new AbortController(), prompt}; runs.set(chatId, run); state(); timeline(chatId);
    let segment: TimelineItem | undefined;
    let producedAssistant = false;
    const toolIds = new Map<string, string>();
    /** Local start time per provider tool item, for a measured duration. */
    const toolStarted = new Map<string, number>();
    /** Provider reasoning items whose text arrived as deltas; their completion must not repeat it. */
    const reasoningStreamed = new Set<string>();
    /** Assistant message items whose text arrived as deltas. One that completes without any is written whole, so a
     *  final answer the provider never streamed is not lost behind an earlier streamed message. */
    const messageStreamed = new Set<string>();
    let anonymousMessageDelta = false;
    /** "Reconnecting…" while the provider retries its model connection (Codex `error` with willRetry). */
    let reconnectNotice: TimelineItem | undefined;
    const reconnected = (status: 'completed' | 'failed' = 'completed') => {
      if (!reconnectNotice) return;
      store.updateItem(reconnectNotice.id, status === 'completed' ? 'Reconnected.' : reconnectNotice.text, status, reconnectNotice.data);
      reconnectNotice = undefined; scheduleTimeline(chatId);
    };
    const append = (kind: 'assistant' | 'reasoning', delta: string) => {
      if (disposed || !runs.has(chatId) || !delta) return;
      if (reconnectNotice) reconnected();
      if (kind === 'assistant') producedAssistant = true;
      if (segment && segment.kind !== kind) seal();
      if (!segment) segment = store.appendItem(chatId, kind, '', 'running');
      // Rewriting the whole growing text on every delta made a long reply O(n²) in SQLite writes; the text is
      // written when the next timeline patch goes out (≤33 ms later) and when the segment is sealed.
      segment = {...segment, text: segment.text + delta}; segmentDirty = true; scheduleTimeline(chatId);
    };
    let segmentDirty = false;
    const flushSegment = () => { if (segment && segmentDirty && !disposed) store.updateItem(segment.id, segment.text, 'running'); segmentDirty = false; };
    segmentFlushes.set(chatId, flushSegment);
    const seal = () => { if (segment) store.updateItem(segment.id, segment.text, 'completed'); segment = undefined; segmentDirty = false; };
    run.seal = seal;
    run.promise = (async () => {
      try {
        const persistIdentity = (threadId: string, turnId?: string, driver?: string) => {
          if (disposed || runs.get(chatId) !== run) return;
          if (!threadId || threadId.length > 256 || /[\x00-\x1f]/.test(threadId) || (turnId !== undefined && (!turnId || turnId.length > 256 || /[\x00-\x1f]/.test(turnId)))) throw new Error('The provider returned an invalid attempt identity.');
          const current=store.chat(chatId);
          // The new provider thread now holds the digest; later sends continue it natively.
          if (digest) store.clearDigest(chatId);
          store.updateChat(chatId,{providerThreadId:threadId,providerThreadProviderId:chat.providerId,providerThreadBindingId:chat.providerBindingId??null,providerThreadDriver:driver??null,...(turnId ? {providerTurnId:turnId} : current?.providerThreadId !== threadId ? {providerTurnId:null} : {})}); state();
        };
        // No registered hooks: dispatch in the same tick, exactly as before the seam existed.
        const hooked = domainHooks.hasRunHooks();
        const contributed = hooked ? await domainHooks.contributePrompt({chat, ...(folder ? {folder} : {}), ...(project ? {project} : {}), prompt}) : {text:'', sources:[] as string[], blocks:[] as ContextBlock[]};
        const runOptions = withAskUser(chat.id, hooked ? await domainHooks.resolveRunOptions(chat) : {});
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
        let settledByItem = false;
        /** HTTP routes: how many user turns Muster's trimmed history still holds after this turn. */
        let retainedTurns: number | undefined;
        const sentSources = contributed.blocks.filter(block => pendingBlocks.has(block)).map(block => block.label);
        if (sentSources.length) { store.appendItem(chatId,'notice',`Context from ${sentSources.join(', ')}`,'completed',{kind:'context-sources',sources:sentSources}); scheduleTimeline(chatId); }
        const sent = (block: ContextBlock | undefined) => block && pendingBlocks.has(block) ? block.text : '';
        // Per-turn notes (a goal's token budget) ride in the message, never in the developer instructions: those key the
        // warm app-server, so a line that changes every turn would restart it every turn.
        const preamble = [sent(projectBlock), digest, skillContext, ...contributed.blocks.map(sent), sent(ownershipBlock), runOptions.turnContext].filter(Boolean).join('\n\n');
        let threadReset = false;
        const request = [prompt, fileLines].filter(Boolean).join('\n\n');
        const contextualPrompt = preamble ? `${preamble}\n\nCurrent user request:\n${request}` : request;
        let retryNotice: TimelineItem | undefined;
        let retryReason = 'admission' as 'admission' | 'transient';
        let retryDetail: string | undefined;
        const stoppedBeforeDispatch: ProviderResult = {status:'failed',finalMessage:'',dispatchState:'not-dispatched',recovery:{kind:'cancelled',retryable:false,reason:'Stopped before the request was sent.'}};
        const attempt = () => run.stopped ? Promise.resolve(stoppedBeforeDispatch) : provider.run({ chat: {...chat,providerTurnId:undefined,recovery:undefined}, cwd, prompt: contextualPrompt,
          ...(images.length ? {images} : {}), ...(effort ?? runOptions.reasoningEffort ? {reasoningEffort: effort ?? runOptions.reasoningEffort} : {}), ...(requestsConnectors(prompt) || pluginReloads.wantsConnectors(chatId) ? {connectorsRequested: true} : {}),
          ...(runOptions.configOverrides ? {configOverrides: runOptions.configOverrides as Record<string, string | number | boolean | string[]>} : {}), ...(runOptions.developerInstructions ? {developerInstructions: runOptions.developerInstructions} : {}),
          onDelta: delta => append('assistant', delta), onReasoning: delta => append('reasoning', delta),
          onThreadReady: (threadId, driver) => { persistIdentity(threadId, undefined, driver); void nativeQueue.flushStranded(chatId); },
          // The saved provider thread is gone (pruned or deleted): the fresh one gets the earlier conversation and the
          // context blocks the old thread already held, and the user is told.
          onThreadReset(_previousThreadId, reason) {
            if (disposed || runs.get(chatId) !== run) return undefined;
            threadReset = true;
            const items = store.timeline(chatId);
            let last = items.length - 1;
            while (last >= 0 && items[last]!.kind !== 'user') last--;
            store.appendItem(chatId, 'notice', reason === 'lane' ? 'This message runs a different way than the earlier ones (models that need it run over the router’s Messages API), so a fresh conversation started with a summary of the earlier messages. The displayed chat history is retained.' : 'The saved provider conversation could not be resumed, so a fresh one started with a summary of the earlier messages. The displayed chat history is retained.', 'completed', {kind: 'thread-reset'});
            scheduleTimeline(chatId);
            return [transcriptDigest(items.slice(0, Math.max(0, last)), cwd), ...staticBlocks.filter(block => !pendingBlocks.has(block)).map(block => block.text)].filter(Boolean).join('\n\n') || undefined;
          },
          onTurnAccepted: identity => persistIdentity(identity.threadId,identity.turnId,identity.driver),
          onEvent(method, params) {
            if (disposed) return;
            const telemetry = isForeignThreadEvent(params, store.chat(chatId)?.providerThreadId) ? null : applyProviderEvent(store.contextTelemetry(chatId), method, params);
            if (telemetry) { store.setContextTelemetry(chatId, telemetry); emit({ type: 'contextTelemetry', chatId, telemetry }); }
            domainHooks.providerEvent({ chat, method, params });
            // A subagent inside a CLI provider (Claude Code Task): its rows live in its own transcript, never in the parent's.
            const ownThread = store.chat(chatId)?.providerThreadId, child = claudeChildThread(params, ownThread);
            if (child) { const row = claudeChildRow(method, params); if (row) store.upsertSubagentItem(chatId, child, row); return; }
            if (method === TOOLS_UNAVAILABLE_EVENT) { store.appendItem(chatId, 'notice', `${chat.model} can’t run commands or edit files through this route, so it answered without tools. Use “Switch to…” in the composer to pick a model with tools.`, 'completed', {kind: 'tools-unavailable', model: chat.model}); scheduleTimeline(chatId); return; }
            if (method === HISTORY_WINDOW_EVENT) { if (typeof params.retainedUserTurns === 'number') retainedTurns = params.retainedUserTurns; return; }
            const compactionItem = params.item && typeof params.item === 'object' && (params.item as Record<string, unknown>).type === 'contextCompaction';
            if (method === 'item/started' && compactionItem && !compactions.has(chatId) && !nativeCompacting.has(chatId) && !acceptedReport(chatId)) { seal(); nativeCompacting.set(chatId, store.appendItem(chatId, 'notice', 'Compacting context…', 'running', {kind:'compaction', status:'running', auto:true}).id); scheduleTimeline(chatId); return; }
            // The compaction item and thread/compacted report the same compaction: whichever comes first settles it once.
            if (method === 'item/completed' && compactionItem) {
              if (nativeCompacting.has(chatId) || compactions.has(chatId)) { seal(); compactionCompleted(chatId); compactedInRun = true; settledByItem = true; }
              else if (absorbAcceptedReport(chatId)) { seal(); compactedInRun = true; settledByItem = true; }
              return;
            }
            if (method === 'thread/compacted') { seal(); if (settledByItem) settledByItem = false; else if (!absorbAcceptedReport(chatId)) compactionCompleted(chatId); compactedInRun = true; }
            const ownRun = runs.get(chatId) === run, parentThread0 = store.chat(chatId)?.providerThreadId, parentEvent = !(typeof params.threadId === 'string' && parentThread0 && params.threadId !== parentThread0);
            if (method === 'error') {
              // Codex retries a dropped model connection itself (willRetry): say so instead of looking stuck.
              if (!ownRun || !parentEvent || params.willRetry !== true) return;
              const error = params.error && typeof params.error === 'object' ? params.error as Record<string, unknown> : {};
              // Shown in the transcript: a proxy URL's user:password or a token in the provider's text is masked.
              const why = typeof error.message === 'string' ? redactSecrets(error.message.replace(/\s+/g, ' ').trim().slice(0, 300)) : '';
              const text = why ? `Reconnecting… ${why}` : 'Reconnecting…';
              seal();
              if (reconnectNotice) { reconnectNotice = {...reconnectNotice, text}; store.updateItem(reconnectNotice.id, text, 'running', reconnectNotice.data); }
              else reconnectNotice = store.appendItem(chatId, 'notice', text, 'running', {kind: 'reconnecting'});
              scheduleTimeline(chatId); return;
            }
            if (reconnectNotice && ownRun && method.startsWith('item/')) reconnected();
            if (method === 'item/agentMessage/delta' && parentEvent) { if (typeof params.itemId === 'string' && params.itemId) messageStreamed.add(params.itemId); else anonymousMessageDelta = true; }
            if (method === 'item/completed' && ownRun && parentEvent && !anonymousMessageDelta) {
              const message = params.item && typeof params.item === 'object' ? params.item as Record<string, unknown> : undefined;
              if (message?.type === 'agentMessage' && typeof message.id === 'string' && message.id && !messageStreamed.has(message.id) && typeof message.text === 'string' && message.text.trim()) {
                messageStreamed.add(message.id); seal(); append('assistant', message.text); seal(); return;
              }
            }
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
          async onRequest(method, params, options) {
            // After this turn ended, the warm app-server still asks for approvals: background sub-agents (the provider
            // still reports active work) or a native goal continuation or queued turn (adopted as the chat's run). They
            // get a card like any other request. A stopped run, or a late callback with no work behind it, declines.
            const current = runs.get(chatId);
            const background = current ? current !== run && !current.stopped : provider.hasActiveWork?.(chatId) === true;
            if (disposed || closing || run.stopped || (current !== run && !background) || !store.chat(chatId)) return undefined;
            seal();
            // ask_user from an HTTP route: the card is posted and the run continues with the default, in every access mode.
            if (method === ASK_USER_METHOD) return askUser(chatId, params);
            // Muster's own ask_user MCP server never needs a card: calling it only posts a question.
            if ((/^item\/mcpToolCall\/requestApproval$/.test(method) || isElicitationRequest(method)) && (params.server === ASK_MCP || params.serverName === ASK_MCP || elicitationServer(params) === ASK_MCP)) return isElicitationRequest(method) ? elicitationResult(true) : {decision: 'accept'};
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
              const expiresAt = attentionDeadline(Date.now(), await mutedUntilMs());
              const item = store.appendItem(chatId, 'question', 'The provider needs your input.', 'pending', { method, questions: parsed, expiresAt: new Date(expiresAt).toISOString() } satisfies PendingQuestionData);
              timeline(chatId);
              return await new Promise<Record<string, unknown>>(resolve => {
                let pending!: PendingQuestionRequest;
                pending = { chatId, createdAt:item.createdAt, expiresAt, providerKey, itemId: item.id, questions: parsed, resolve: answers => resolve(answers ? { answers } : CANCELLED_REQUEST), waiters: [], timer: undefined as never };
                armExpiry(item.id, pending, () => questions.get(item.id) === pending, () => finishQuestion(item.id, pending, null, 'expired'));
                questions.set(item.id, pending); questionsByProviderKey.set(providerKey, item.id); wakeForAttention(chatId); state();
              });
            }
            if (isElicitationRequest(method)) {
              const server = elicitationServer(params);
              const policy = elicitationPolicy(access.permissionMode, server);
              if (policy !== 'ask') return elicitationResult(policy === 'accept');
              const text = elicitationText(params);
              const expiresAt = attentionDeadline(Date.now(), await mutedUntilMs());
              domainHooks.providerEvent({ chat, method: APPROVAL_SHOWN_EVENT, params: {} });
              const item = store.appendItem(chatId, 'approval', `${server || 'Computer use'} asks: ${text}`, 'pending', { method, kind: 'mcp', elicitation: true, reason: text, expiresAt: new Date(expiresAt).toISOString(), ...(server ? { server } : {}) });
              const approvalId = item.id;
              timeline(chatId);
              const decision = await new Promise<ApprovalDecision>(resolve => {
                let pending!: PendingApproval;
                pending = { chatId, createdAt: item.createdAt, expiresAt, resolve, timer: undefined as never };
                armExpiry(approvalId, pending, () => approvals.get(approvalId) === pending, () => finishApproval(approvalId, pending, 'decline', 'expired'));
                approvals.set(approvalId, pending); wakeForAttention(chatId); state();
              });
              return elicitationResult(decision !== 'decline');
            }
            if ((access.permissionMode !== 'workspace' && access.permissionMode !== 'full') || !/^item\/(commandExecution|fileChange|mcpToolCall)\/requestApproval$/.test(method)) return undefined;
            // R5: a command that would signal the user's own processes always becomes a card. Full access asks the
            // provider about every non-trusted command (approvalPolicy 'untrusted') so it can be stopped here; the rest is accepted at once.
            const threat = method === 'item/commandExecution/requestApproval' ? await guardUserProcesses(params.command) : null;
            // G13: the agent's own tool rules. Deny refuses with a visible notice; allow answers the card (never for a stop-the-user's-process request); ask shows it even in full access.
            const toolPolicy = (() => { const chat = store.chat(chatId); return chat ? domainHooks.toolPolicy(chat, method, params) : null; })();
            if (toolPolicy?.effect === 'deny') {
              // #580: the refused tool's row must not read "Ran …" when the provider closes it.
              const refused = typeof params.itemId === 'string' ? toolIds.get(params.itemId) : undefined, row = refused ? store.item(refused) : undefined;
              if (row) store.updateItem(row.id, row.text, row.status, {...row.data, executionDenied: true});
              store.appendItem(chatId, 'notice', toolPolicy.message, 'failed', {kind: 'tool-policy', method});
              timeline(chatId);
              return {decision: 'decline'};
            }
            if (toolPolicy?.effect === 'allow' && !threat) return {decision: 'accept'};
            // options.policyOnly (set by the adapter, never read from the provider's params): an adapter that runs its own tools (HTTP routes) only wants the rules, the guard and a card for a threat or an ask; workspace edits inside the folder do not need a card.
            if ((access.permissionMode === 'full' || options?.policyOnly === true) && !threat && toolPolicy?.effect !== 'ask') return {decision: 'accept'};
            const change = typeof params.itemId === 'string' && toolIds.has(params.itemId) ? store.item(toolIds.get(params.itemId)!)?.data?.changes : params.changes;
            const data: ApprovalData = {...approvalData(method, params, change), ...(threat ? {reason: threat.message, protectsUserProcess: true} : {})};
            const toolItemId = typeof params.itemId === 'string' ? toolIds.get(params.itemId) : undefined;
            const expiresAt = attentionDeadline(Date.now(), await mutedUntilMs());
            domainHooks.providerEvent({chat, method: APPROVAL_SHOWN_EVENT, params: {}});
            const item = store.appendItem(chatId, 'approval', detail(params.command ?? params.reason ?? params.changes ?? data.tool ?? data.kind), 'pending', {...data, expiresAt: new Date(expiresAt).toISOString(), ...(toolItemId ? {toolItemId} : {})});
            const approvalId = item.id;
            // F60: the tool row the provider already started is blocked on this card, not running. Flag it so the
            // row reads "Waiting for approval"; finishApproval (or the item's completion) clears the flag.
            const blocked = toolItemId ? store.item(toolItemId) : undefined;
            if (blocked?.status === 'running') store.updateItem(blocked.id, blocked.text, blocked.status, {...blocked.data, awaitingApproval: approvalId});
            timeline(chatId);
            const decision = await new Promise<ApprovalDecision>(resolve => {
              let pending!: PendingApproval;
              pending = {chatId, createdAt:item.createdAt, expiresAt, resolve, timer: undefined as never};
              armExpiry(approvalId, pending, () => approvals.get(approvalId) === pending, () => finishApproval(approvalId, pending, 'decline', 'expired'));
              approvals.set(approvalId, pending); wakeForAttention(chatId); state();
            });
            // Never let the provider remember a stop-the-user's-process approval for the rest of the session.
            return {decision: threat && decision === 'acceptForSession' ? 'accept' : decision};
          },
        });
        const retried = await withAdmissionRetry(attempt, {signal: run.retry.signal, onWait(wait) {
          if (disposed) return;
          retryReason = wait.reason ?? 'admission';
          retryDetail = wait.detail;
          const data = {kind:'admission-retry', reason: retryReason, attempt: wait.attempt, max: wait.max, retryAt: wait.retryAt};
          if (retryNotice) store.updateItem(retryNotice.id, admissionRetryText(wait), 'running', data);
          else retryNotice = store.appendItem(chatId, 'notice', admissionRetryText(wait), 'running', data);
          timeline(chatId);
        }});
        let result = retried.result;
        if (retryNotice && !disposed) {
          const sent = !retried.cancelled && result.recovery?.kind !== 'admission-rejected' && result.recovery?.kind !== 'failed';
          const lead = retryReason === 'transient' ? 'Provider attempt did not start.' : retryDetail ? asSentence(retryDetail) : 'The provider is temporarily unavailable.';
          store.updateItem(retryNotice.id, retried.cancelled ? 'Stopped while waiting to retry the provider.' : sent ? `${lead} Sent after ${retried.retries} ${retried.retries === 1 ? 'retry' : 'retries'}.` : `${lead} Gave up after ${retried.retries} automatic ${retried.retries === 1 ? 'retry' : 'retries'}.`, retried.cancelled ? 'cancelled' : sent ? 'completed' : 'failed', {...store.item(retryNotice.id)?.data, retryAt: null});
        }
        if (retried.cancelled) result = {...result, recovery: {kind:'cancelled',retryable:false,reason:'Stopped while waiting to retry the provider. The request was not accepted.'}};
        else if (retried.retries && result.recovery?.kind === 'failed') result = {...result, recovery: {...result.recovery, reason: `${result.recovery.reason} (after ${retried.retries} automatic ${retried.retries === 1 ? 'retry' : 'retries'})`}};
        else if (retried.retries && result.recovery?.kind === 'admission-rejected') {
          result = {...result, recovery: {...result.recovery, reason: `${result.recovery.reason} Stopped after ${retried.retries} automatic ${retried.retries === 1 ? 'retry' : 'retries'}.`}};
        }
        // The provider asked for a longer wait than a run is held open: say when, rather than retrying early.
        if (retried.retryAt && result.recovery?.kind === 'admission-rejected') result = {...result, recovery: {...result.recovery, reason: `${result.recovery.reason} The provider asked to wait until ${retryClock(retried.retryAt)}.`}};
        if (disposed) return;
        seal();
        reconnected(result.status === 'completed' ? 'completed' : 'failed');
        if (!producedAssistant && result.finalMessage) store.appendItem(chatId, 'assistant', result.finalMessage, 'completed');
        // The provider's own words are kept (S36): an adapter that reports a failure with a message (rate_limited, auth…)
        // settled that attempt as failed, which Inbox and Pulse explain in a plain sentence and which may be run again.
        // A failure with no message at all stays unconfirmed (recovery-needed).
        const said = (result.errorMessage ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
        // A quit is not a Stop (#449), but a provider that may still be running the turn keeps that state for the check.
        let recovery: ChatRecovery | undefined = run.quit && result.recovery?.kind !== 'recovery-needed' ? shutdownRecovery(!!run.shutdown) : result.recovery ?? (run.stopped ? {kind:'cancelled',retryable:false,reason:'Stopped.'}
          : result.status === 'failed' ? (said && result.dispatchState !== 'unknown' ? {kind:'failed',retryable:false,reason:`The provider attempt failed: ${said}`} : {kind:'recovery-needed',retryable:false,reason:'The provider attempt did not settle with confirmed outcome. Check its saved turn before continuing; the prompt was not resent.'}) : undefined);
        // #426: the provider refused the turn because the conversation no longer fits the model's window. That is a settled
        // refusal, never an unconfirmed attempt: say so, and offer compaction or a fresh thread with a summary.
        if (recovery && recovery.kind !== 'cancelled' && !run.stopped && CONTEXT_OVERFLOW.test(`${said} ${recovery.reason}`)) {
          const modelName = selectedProvider.models.find(entry => entry.id === chat.model)?.name ?? chat.model;
          recovery = {kind:'failed', retryable:false, reason:`${modelName} refused this turn: the conversation no longer fits its context window.`};
          store.appendItem(chatId, 'notice', `The conversation no longer fits ${modelName}’s context window. Compact it and send again, or continue in a fresh thread with a summary.`, 'failed', {kind:'compaction', status:'failed', reason:'context-overflow', actions:['retry','fresh']});
        }
        // #448: a provider usage or rate limit. Its own refusal ended the turn, so it is settled (never "may still be running"),
        // and the chat waits for the reset to continue.
        if (recovery && recovery.kind !== 'cancelled' && !run.stopped && isUsageLimit(`${said} ${recovery.kind === 'recovery-needed' ? '' : recovery.reason}`)) {
          if (recovery.kind === 'recovery-needed') recovery = {kind:'failed', retryable:false, reason:`The provider attempt failed: ${said}`};
          run.limit = {text:`${said} ${recovery.reason}`, ...(result.failure?.retryAfterMs ? {retryAfterMs:result.failure.retryAfterMs} : {}), notDispatched: result.dispatchState === 'not-dispatched', prompt, attachmentIds};
        }
        if (result.threadId) persistIdentity(result.threadId,result.turnId,result.driver);
        // Only a turn the provider actually took delivered its context blocks to the thread.
        if (result.status === 'completed' && result.dispatchState !== 'not-dispatched' && !compactedInRun) contextLedger.delivered(chatId, store.chat(chatId)?.providerThreadId, threadReset ? staticBlocks : [...pendingBlocks], retainedTurns);
        else if (result.dispatchState !== 'not-dispatched') contextLedger.forget(chatId);
        if (recovery) store.appendItem(chatId,'notice',recovery.reason,recovery.kind,{recovery,providerThreadId:store.chat(chatId)?.providerThreadId,providerTurnId:store.chat(chatId)?.providerTurnId});
        // #448: a limited turn that never started re-runs its own prompt at reset, so it is not also handed back as a draft (sent twice).
        const restoreDraft=result.status==='failed' && result.dispatchState==='not-dispatched' && recovery?.kind!=='recovery-needed' && store.chat(chatId)?.draft==='' && !(run.limit && settingOn('chats.resumeAfterLimit'));
        if (restoreDraft && attachmentIds.length) attachments.restage(attachmentIds);
        store.updateChat(chatId, {status:recovery?.kind === 'recovery-needed' ? 'failed' : run.stopped ? 'interrupted' : result.status,recovery:recovery ?? null,error:recovery?.reason ?? result.errorMessage ?? null,...(restoreDraft?{draft:prompt}:{})});
      } catch (error) {
        if (!disposed) {
          seal();
          const recovery: ChatRecovery = run.quit ? shutdownRecovery(!!run.shutdown) : error instanceof ProviderPreDispatchError
            ? {kind:'failed',retryable:true,reason:error.message}
            : run.stopped ? {kind:'cancelled',retryable:false,reason:'Stopped.'}
            : {kind:'recovery-needed',retryable:false,reason:'The provider attempt ended without a confirmed outcome. Check its saved turn before continuing; the prompt was not resent.'};
          store.appendItem(chatId,'notice',recovery.reason,recovery.kind,{recovery});
          const restore = error instanceof ProviderPreDispatchError && store.chat(chatId)?.draft==='';
          if (restore && attachmentIds.length) attachments.restage(attachmentIds);
          store.updateChat(chatId,{status:recovery.kind==='cancelled'?'interrupted':'failed',error:recovery.reason,recovery,...(restore?{draft:prompt}:{})});
        }
      } finally {
        // Background sub-agents can still be waiting on a card after the parent turn ended: keep it answerable.
        const settled = run.stopped || disposed || !provider.hasActiveWork?.(chatId);
        if (settled) { settleApprovals(chatId); settleQuestions(chatId); seal(); }
        flushSegment(); if (segmentFlushes.get(chatId) === flushSegment) segmentFlushes.delete(chatId);
        // Stop can close the provider before it sends item/completed, and a completed or failed turn can end with a tool the
        // provider never closed (#387). Persist the terminal state once, keeping completed tools and partial output intact.
        // Background sub-agents still working after the turn keep their rows live until they report back.
        if (settled) {
          const startedById = new Map([...toolIds].map(([providerId, localId]) => [localId, toolStarted.get(providerId)]));
          store.settleToolItems(chatId, item => startedById.get(item.id));
        }
        // #449: any tool row still running once the run's work has ended settles as interrupted.
        if (settled) store.settleRunningTools(chatId);
        runs.delete(chatId);
        // #426: a compaction asked for during the turn runs now (before any queued message is dispatched).
        const deferred = deferredCompactions.get(chatId);
        if (deferred && !disposed) { deferredCompactions.delete(chatId); void compactChat(chatId, {fresh: deferred.fresh, rowId: deferred.rowId}).catch(() => undefined); }
        if (!disposed) { const timer = timers.get(chatId); if (timer) clearTimeout(timer); timers.delete(chatId); timeline(chatId); let finalChat=store.chat(chatId);
          // A result the user has not seen yet: marked unread until the chat is opened again.
          if(finalChat&&(finalChat.status==='completed'||finalChat.status==='failed')&&store.activeChatId()!==chatId&&store.setUnread(chatId,true))finalChat=store.chat(chatId);
          // First completed exchange: a chat still on its default name gets a summary title (renamed chats never do).
          if(finalChat?.status==='completed'&&store.settleTitle(chatId))finalChat=store.chat(chatId);
          // CHAT-15: "until new activity" wakes when a run settles (one transition, unread + one notification).
          if(finalChat?.snoozeUntilActivity&&wake(chatId,'activity'))finalChat=store.chat(chatId);
          if(finalChat&&(finalChat.status==='completed'||finalChat.status==='failed'||finalChat.status==='interrupted')){const task=projectTasks.settleRunForChat(chatId,finalChat.status,finalChat.error,finalAssistantText(chatId));if(task)emit({type:'projectChanged',projectId:task.projectId,taskId:task.id});}state();
          if (finalChat) { domainHooks.runSettled({chat:finalChat,runId:accepted.runId,status:finalChat.status}); settleAutoResume(chatId, run, finalChat); afterRun(chatId, finalChat.status); }
          // A turn the app-server started itself (native goal or queue) while this run settled is adopted now.
          nativeTurns.drain(chatId); }
      }
    })();
    return {runId: accepted.runId};
  }
  /** A completed run hands the queue head to chat.send; any other ending pauses the queue until the user resumes it (Codex). */
  function afterRun(chatId: string, status: Chat['status']) {
    // A turn stopped because a plugin was installed mid-run: the re-sent message goes next, on a fresh session.
    if (pluginReloads.settled(chatId) && !closing && !disposed) { queue.resume(chatId); provider.markStale?.(); dispatchQueued(chatId); state(); return; }
    if (!store.queue(chatId).length || closing || disposed) return;
    if (queueActionAfter(status) === 'dispatch') { dispatchQueued(chatId); return; }
    // #448: behind a usage limit the queue waits for the continuation, then sends in order.
    const waiting = autoResume.get(chatId);
    queue.pause(chatId, waiting?.kind === 'limit' && waiting.state === 'armed' ? 'limited' : status === 'interrupted' ? 'interrupted' : 'failed'); state();
  }
  // --- #448 / #449: automatic continuation after a usage limit resets, and after a restart ---
  /** A run Muster's own quit interrupted: a neutral ending (never "Stopped", never "will not resume"). */
 const shutdownRecovery = (continues: boolean): ChatRecovery => ({kind:'cancelled', retryable:false, reason: continues && settingOn('chats.resumeAfterRestart') ? 'Muster quit while this was working. It continues when Muster starts again.' : 'Muster quit while this was working. Send a message to continue.'});
  const resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Settings are read live (sync handler); anything unreadable keeps the default, on. */
  const settingOn = (key: 'chats.resumeAfterLimit' | 'chats.resumeAfterRestart'): boolean => {
    try { const result = domains.handlers.get('settings.get')?.({}) as {values?: Record<string, unknown>} | undefined; return result?.values?.[key] !== false; } catch { return true; }
  };
  /** Codex usage windows for this chat's route (live, else its session logs). */
  function usageFor(chat: Chat): ProviderUsage[] {
    const rows: ProviderUsage[] = [];
    const id = chat.providerThreadProviderId ?? chat.providerId;
    if (!id) return rows;
    const live = liveProviderUsage(id); if (live) rows.push(live);
    try { const listed = domains.handlers.get('providers.usage')?.({id}); if (Array.isArray(listed)) rows.push(...(listed as ProviderUsage[])); } catch { /* no usage source for this route */ }
    return rows;
  }
  function cancelResumeTimer(chatId: string) { const timer = resumeTimers.get(chatId); if (timer) clearTimeout(timer); resumeTimers.delete(chatId); }
  function clearAutoResume(chatId: string) { cancelResumeTimer(chatId); autoResume.delete(chatId); }
  /** Timers wake at most hourly to re-read the stored time, so a long wait survives clock changes and sleep. */
  function armResume(chatId: string) {
    cancelResumeTimer(chatId);
    const row = autoResume.get(chatId);
    if (!row || row.state !== 'armed' || disposed || closing) return;
    const wait = Math.min(Math.max((row.resumeAt ? Date.parse(row.resumeAt) : Date.now()) - Date.now(), 0), 60 * 60_000);
    const timer = setTimeout(() => {
      resumeTimers.delete(chatId);
      const current = autoResume.get(chatId);
      if (current?.state === 'armed' && current.resumeAt && Date.parse(current.resumeAt) > Date.now() + 250) { armResume(chatId); return; }
      void fireResume(chatId);
    }, wait);
    timer.unref?.();
    resumeTimers.set(chatId, timer);
  }
  function autoResumeNotice(row: AutoResumeRow, text: string): string {
    const item = row.noticeId ? store.item(row.noticeId) : undefined;
    if (item && item.chatId === row.chatId) { store.updateItem(item.id, text, 'completed', {...item.data, kind:'auto-resume'}); return item.id; }
    return store.appendItem(row.chatId, 'notice', text, 'completed', {kind:'auto-resume', reason:row.kind}).id;
  }
  /** The next model in this chat's opt-in fallback list (after the current one), available and listing the model. */
  function nextFallback(chat: Chat): {providerId: string; model: string; bindingId: string; name: string} | undefined {
    const list = autoResume.fallbacks(chat.id);
    if (!list.length) return undefined;
    const current = list.findIndex(entry => entry.providerId === chat.providerId && entry.model === chat.model);
    for (const entry of list.slice(current + 1)) {
      if (entry.providerId === chat.providerId && entry.model === chat.model) continue;
      const route = provider.info().find(candidate => candidate.id === entry.providerId && candidate.available && (candidate.models.length === 0 || candidate.models.some(model => model.id === entry.model)));
      if (route) return {providerId: route.id, model: entry.model, bindingId: route.bindingId ?? route.id, name: route.models.find(model => model.id === entry.model)?.name ?? entry.model};
    }
    return undefined;
  }
  /** Moves a limited chat to its next fallback and continues at once. False when there is none to use. */
  function useFallback(chatId: string): boolean {
    const chat = store.chat(chatId), row = autoResume.get(chatId);
    if (!chat || !row || row.kind !== 'limit' || busy(chat) || runs.has(chatId) || providerSelections.has(chatId)) return false;
    const next = nextFallback(chat);
    if (!next) return false;
    const was = provider.info().find(entry => entry.id === chat.providerId)?.models.find(model => model.id === chat.model)?.name ?? chat.model;
    store.updateChat(chatId, {providerId: next.providerId, providerBindingId: next.bindingId, model: next.model});
    store.appendItem(chatId, 'notice', `${was} is limited, so this chat continues with ${next.name}, its fallback model.`, 'completed', {kind:'auto-resume', reason:'fallback', providerId: next.providerId, model: next.model});
    // A fresh conversation on the fallback: never "the limit has reset".
    autoResume.update(chatId, {state:'armed', resumeAt:new Date().toISOString(), native:false});
    timeline(chatId); state();
    queueMicrotask(() => { void fireResume(chatId); });
    return true;
  }
  /** A run settled: a usage limit arms (or backs off) the resume; anything else ends the automatic continuation it was. */
  function settleAutoResume(chatId: string, run: ActiveRun, chat: Chat) {
    const row = autoResume.get(chatId);
    // A quit leaves the row for the next launch (a 'shutdown' row, or a continuation that must not run twice).
    if (run.quit) return;
    if (!run.limit || run.stopped) { if (row && (row.state === 'running' || run.stopped || chat.status === 'completed')) clearAutoResume(chatId); return; }
    const again = row?.kind === 'limit' && row.state === 'running';
    const attempts = again ? row.attempts + 1 : 0, kind = limitClass(run.limit.text) ?? 'quota';
    // A refused turn that never started re-runs its own prompt; one that did work continues from where it stopped.
    const reuse = run.limit.notDispatched ? [...store.timeline(chatId)].reverse().find(item => item.kind === 'user' && item.data?.steered !== true && item.data?.autoResume === undefined) : undefined;
    const base: Omit<AutoResumeRow, 'createdAt' | 'state' | 'resumeAt' | 'attempts' | 'noticeId'> = again && row.prompt !== undefined
      ? {...row, limitClass: kind}
      : {chatId, kind:'limit', limitClass: kind, prompt: reuse ? reuse.text : null, reuseItemId: reuse?.id ?? null, attachmentIds: reuse ? run.limit.attachmentIds : [], native: hasNativeSession(chat)};
    const noticeId = again ? row.noticeId : null;
    if (attempts >= LIMIT_MAX_ATTEMPTS[kind]) {
      const stopped = autoResume.set({...base, state:'gave-up', resumeAt:null, attempts, noticeId});
      autoResume.update(chatId, {noticeId: autoResumeNotice(stopped, `Still limited after ${attempts} automatic tries, so Muster stopped continuing this chat. Send a message once the limit resets.`)});
      cancelResumeTimer(chatId);
      useFallback(chatId);
      return;
    }
    const {at} = limitResumeAt({text: run.limit.text, usage: usageFor(chat), ...(run.limit.retryAfterMs ? {retryAfterMs: run.limit.retryAfterMs} : {}), attempts});
    let next = autoResume.set({...base, state: again || settingOn('chats.resumeAfterLimit') ? 'armed' : 'off', resumeAt: new Date(at).toISOString(), attempts, noticeId});
    // An opt-in fallback model continues at once instead of waiting for the reset.
    if (next.state === 'armed' && useFallback(chatId)) return;
    // Said once: the first refusal after a reset adds one line; later ones update it.
    if (again) next = autoResume.update(chatId, {noticeId: autoResumeNotice(next, `The provider still refused at reset. Muster tries again at ${resetClock(at)}${attempts + 1 < LIMIT_MAX_ATTEMPTS[kind] ? '' : ', for the last time'}.`)})!;
    armResume(chatId);
  }
  /** Continues a chat at its stored time: the limited turn's own prompt (never dispatched), or a short continuation. */
  async function fireResume(chatId: string): Promise<void> {
    cancelResumeTimer(chatId);
    const row = autoResume.get(chatId);
    if (!row || row.state !== 'armed' || disposed || closing) return;
    const chat = store.chat(chatId);
    if (!chat || chat.archived) { clearAutoResume(chatId); state(); return; }
    // The user (or another run) already took over; nothing to continue.
    if (runs.has(chatId) || busy(chat) || dispatching.has(chatId) || compactions.has(chatId) || chat.recovery?.kind === 'recovery-needed') { if (row.kind === 'restart' || busy(chat)) clearAutoResume(chatId); state(); return; }
    if (!settingOn(row.kind === 'limit' ? 'chats.resumeAfterLimit' : 'chats.resumeAfterRestart')) { if (row.kind === 'limit') autoResume.update(chatId, {state:'off'}); else autoResume.delete(chatId); state(); return; }
    autoResume.update(chatId, {state:'running'});
    // Queued messages wait for this continuation, then send in order once it completes.
    if (queue.paused(chatId)) queue.resume(chatId);
    const draft = chat.draft, requestId = `auto-${row.kind}-${randomUUID()}`;
    const rerun = row.kind === 'limit' && row.reuseItemId && row.prompt && store.item(row.reuseItemId)?.chatId === chatId;
    const native = row.native && hasNativeSession(chat);
    // After a restart a route without a session is told what happened; after a limit the short line is enough.
    const text = rerun ? row.prompt! : row.kind === 'restart' && !native ? RESTART_CONTINUATION : NATIVE_CONTINUATION;
    try {
      await send(chatId, text, requestId, undefined, rerun ? row.attachmentIds : [], rerun ? {reuseUserItemId: row.reuseItemId!} : {userData: {autoResume: row.kind}});
      // The send took the composer's text with it; a draft the user was writing (not the limited prompt) is kept.
      if (draft && draft !== row.prompt) store.updateChat(chatId, {draft});
    } catch (error) {
      if (disposed) return;
      const reason = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, '');
      const current = autoResume.get(chatId);
      if (row.kind === 'limit' && current) {
        // Treated as one more refusal: back off, never retry at once.
        const attempts = current.attempts + 1, kind = current.limitClass ?? 'quota';
        if (attempts >= LIMIT_MAX_ATTEMPTS[kind]) { autoResume.update(chatId, {state:'gave-up', attempts, resumeAt:null}); autoResume.update(chatId, {noticeId: autoResumeNotice(autoResume.get(chatId)!, `Muster could not continue this chat after the limit: ${reason}. It stopped trying; send a message to continue.`)}); }
        else { autoResume.update(chatId, {state:'armed', attempts, resumeAt: new Date(limitResumeAt({text: kind === 'rate' ? '429' : 'usage limit', attempts}).at).toISOString()}); armResume(chatId); }
      } else {
        clearAutoResume(chatId);
        store.appendItem(chatId, 'notice', `Muster could not continue this chat after the restart: ${reason}. Send a message to continue.`, 'completed', {kind:'auto-resume', reason:'restart-failed'});
      }
      timeline(chatId);
    }
    state();
  }
  /** #449, after launch: re-arm stored limit resumes, and continue the chats that were working when Muster closed. */
  async function bootAutoResume(): Promise<void> {
    for (const row of autoResume.all()) if (row.kind === 'limit' && row.state === 'armed') armResume(row.chatId);
    // #450: a queue head whose dispatch was cut short by the quit is still queued (no receipt): an idle chat whose queue
    // is not paused sends it now, instead of holding it until the user acts.
    for (const chat of store.snapshot().chats) if (!chat.archived && !restartCandidates.includes(chat.id) && store.queue(chat.id).length && !queue.paused(chat.id) && !busy(chat) && !runs.has(chat.id) && !autoResume.get(chat.id)) dispatchQueued(chat.id);
    if (!restartCandidates.length) return;
    if (!settingOn('chats.resumeAfterRestart')) { for (const chatId of restartCandidates) if (autoResume.get(chatId)?.kind === 'restart') autoResume.delete(chatId); return; }
    await firstProviderProbe();
    await new Promise(resolve => { const timer = setTimeout(resolve, autoResumeTiming.restartDelayMs); timer.unref?.(); });
    if (disposed || closing) return;
    for (const chatId of restartCandidates) {
      const chat = store.chat(chatId);
      const prior = autoResume.get(chatId);
      if (!chat || chat.archived || busy(chat) || (prior && prior.state !== 'shutdown')) continue;
      const native = hasNativeSession(chat);
      const row = {chatId, kind:'restart' as const, attempts:0, prompt: prior?.prompt ?? null, reuseItemId:null, attachmentIds:[], noticeId:null, native};
      // A provider-side attempt is checked first (RecoveryNotice, "Continue anyway"); a check that finds it interrupted continues it.
      if (chat.recovery?.kind === 'recovery-needed') { autoResume.set({...row, state:'check', resumeAt:null}); continue; }
      autoResume.set({...row, state:'armed', resumeAt:new Date().toISOString()});
      await fireResume(chatId);
    }
  }
  function dispatchQueued(chatId: string) {
    if (runs.has(chatId) || closing || disposed || queue.paused(chatId) || compactions.has(chatId)) return;
    const chat = store.chat(chatId);
    if (!chat || chat.archived || chat.recovery?.kind === 'recovery-needed' || chat.status === 'running' || chat.status === 'stopping') return;
    // A refused head waits for Retry, Edit or Delete instead of being skipped.
    if (queue.list(chatId)[0]?.error) return;
    // A native turn is about to be adopted, or the app-server holds (or is taking) the head: it dispatches, not Muster.
    if (nativeTurns.pendingTurn(chatId)) return;
    const head = queue.list(chatId)[0];
    if (head && nativeQueue.pending(head.id)) return;
    if (nativeQueue.owns(chatId)) { void nativeQueue.start(chatId).then(started => { if (!started) dispatchQueued(chatId); }); return; }
    // #450: one dispatch per chat at a time; the head stays queued (and survives a quit) until its send is recorded.
    if (dispatching.has(chatId)) return;
    const item = queue.head(chatId);
    if (!item) return;
    // Already sent under this request id (a replay, or steered into a run): drop the row instead of sending it again.
    if (store.receipt(item.requestId) || steered.get(item.requestId) === chatId) { queue.dropSent(chatId, item.id); state(); dispatchQueued(chatId); return; }
    dispatching.add(chatId);
    const pending = send(chatId, item.text, item.requestId, item.skillIds?.length ? item.skillIds : undefined, item.attachmentIds, {pluginIds: item.pluginIds ?? [], ...(item.effort ? {effort: item.effort} : {}), queued: item}).then(() => {
      dispatching.delete(chatId);
      // Handled without a turn (an edited row that became /compact): it never leaves the queue on its own.
      if (!disposed && queue.list(chatId).some(entry => entry.id === item.id) && !store.receipt(item.requestId) && !runs.has(chatId)) queue.dropSent(chatId, item.id);
      state();
    }, error => {
      dispatching.delete(chatId);
      if (disposed) return;
      // Edited or removed while the send was being prepared: nothing was sent; the queue as it is now goes next.
      if (error instanceof QueueChangedError) { state(); if (!runs.has(chatId)) dispatchQueued(chatId); return; }
      const reason = error instanceof Error ? error.message : String(error);
      if (!store.receipt(item.requestId) && queue.list(chatId).some(entry => entry.id === item.id)) queue.fail(item.id, reason);
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
    // Steers go one at a time per chat, so several in a row reach the agent (and the transcript) in the order they were sent.
    const turn = (steerChains.get(chat.id) ?? Promise.resolve()).then(() => steerNow(chat, message, requestId, chips));
    const tail = turn.then(() => undefined, () => undefined);
    steerChains.set(chat.id, tail); void tail.then(() => { if (steerChains.get(chat.id) === tail) steerChains.delete(chat.id); });
    return turn;
  }
  async function steerNow(chat: Chat, message: string, requestId: string, chips: {skillIds?: string[]; pluginIds?: string[]; effort?: ReasoningEffort}): Promise<{steered: boolean; reason?: string}> {
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
    clearAutoResume(chatId);
    pluginReloads.forget(chatId);
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
    // #654: what the chat owns outside the store (its sandbox) goes first; a failure keeps the chat so nothing leaks.
    const doomed = store.chat(chatId);
    if (doomed) await domainHooks.chatRemoval({chat: doomed, kind: 'delete'});
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
    try { const result = await pending as Commands[K]['output']; snapshots.flush(); return result; }
    finally { invocations.delete(pending); }
  }
  async function dispatch(command: string, input: unknown): Promise<unknown> {
    if (command === 'app.snapshot') return snapshot();
    if (command === 'providers.list') {
      if ((input as {rescan?: boolean} | undefined)?.rescan) { rescanProviderListings(); await Promise.race([Promise.resolve(provider.ready?.()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, PROVIDER_LISTING_WAIT_MS).unref())]); }
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
        // A Codex gateway already listed as a route (its id may be prefixed, e.g. codex-<id>) is not listed again as a dead discovery row.
        ...detected.filter(entry=>!runtime.some(runnable=>runnable.id===entry.id||(runnable.codex?.kind==='gateway'&&runnable.codex.modelProvider===entry.id&&!runnable.codex.account))&&shown(entry)).map(({identity,credentialPresent,...entry})=>({...entry,available:false,models:[],canReveal:Boolean(identity),source:'Local configuration discovery',detail:`${entry.detail}. No runnable adapter is enabled for this entry.`})),
        // Agent CLIs that are not installed: listed (with How to install) but never offered in the model picker.
        ...(process.env.NODE_TEST_CONTEXT && process.env.MUSTER_PROVIDER_ADAPTERS !== '1' ? [] : absentCliAgentRows(process.env, homedir()).filter(row => !runtime.some(entry => entry.id === row.id))),
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
        // #591: a chat opened from another chat (a new worktree) continues with that chat's model, effort and access.
        // An id that names no chat inherits nothing; the new chat takes the usual defaults.
        const parent = p.inheritFrom === undefined ? undefined : store.chat(id(p.inheritFrom));
        const defaults = {...domainHooks.chatDefaults({...(folderId ? {folderId} : {}), ...(projectId ? {projectId} : {})})};
        // Folder, Project and user defaults never grant Full access: only a chat where the user confirmed it passes it on.
        if (defaults.permissionMode === 'full') delete defaults.permissionMode;
        if (parent) {
          // The parent's model only when it can still run; an unbound or signed-out parent keeps the defaults' model.
          let runnable = false;
          if (parent.providerId && parent.model?.trim()) { try { validateRunnableModel(parent.model, parent.providerId); runnable = true; } catch { /* unavailable now */ } }
          if (runnable) {
            defaults.providerId = parent.providerId; defaults.model = parent.model; delete defaults.effort;
            const parentEffort = efforts.get(parent.id); if (parentEffort) defaults.effort = parentEffort;
          }
          if (parent.permissionMode) defaults.permissionMode = parent.permissionMode;
        }
        // UR-SR-a: there is no Ask mode picker any more; a legacy 'ask' default means Agent with read-only access.
        const legacyAsk = defaults.mode === 'ask';
        const mode = defaults.mode === 'plan' ? 'plan' : 'agent';
        const permissionMode = defaults.permissionMode && ['read-only','workspace','full'].includes(defaults.permissionMode) ? defaults.permissionMode : legacyAsk ? 'read-only' : undefined;
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
        // #654: an archived chat's sandbox stops (kept, not destroyed) in the background; archiving never waits on Docker.
        if (patch.archived && !chat.archived) void domainHooks.chatRemoval({chat: result, kind: 'archive'});
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
          const updated=store.updateChat(chatId,{providerId,providerBindingId:bindingId,model,...(changed?{providerThreadId:null,providerTurnId:null,providerThreadProviderId:null,providerThreadBindingId:null,providerThreadDriver:null,recovery:null,error:null}:{})});
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
        // #448/#449: the user took over; a pending automatic continuation is dropped.
        if (autoResume.get(chatId)) { clearAutoResume(chatId); state(); }
        return send(chatId, text(p.text, 'message', MAX_QUEUED_TEXT), requestId, skillIds.length ? skillIds : undefined, attachmentIds, {pluginIds, ...(p.effort !== undefined ? {effort: p.effort as ReasoningEffort} : {})});
      }
      case 'chat.queue.add': {
        const chatId = id(p.id), chat = chatFor(chatId), attachmentIds = ids(p.attachmentIds, MAX_ATTACHMENTS_PER_MESSAGE);
        if (isCompactCommand(p.text)) throw new Error('/compact runs when the current run finishes. It is not queued as a message.');
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
        if (isCompactCommand(message)) throw new Error('/compact runs when the current run finishes. It is not sent to the running agent.');
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
        if (autoResume.get(chatId)) clearAutoResume(chatId);
        // F46: re-run the original prompt without appending a second copy of it to the transcript.
        const result = await send(chatId, prompt.text, requestId, undefined, [], {reuseUserItemId: prompt.id});
        return {runId: result.runId, requestId};
      }
      case 'chat.stop': { const chatId = id(p.id); chatFor(chatId); const run = runs.get(chatId); if (!run) return;
        // Codex pauses an active goal before interrupting, so the stop never triggers a continuation.
        if (goalsByChat().get(chatId)?.status === 'active') { try { await domains.handlers.get('goals.pause')?.({chatId}); } catch { /* the goal was cleared meanwhile */ } }
        await interruptRun(chatId, run); return; }
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
          const result=await (options.reconcileProvider ?? reconcileProviderTurn)({threadId:chat.providerThreadId,turnId:chat.providerTurnId,cwd,providerId:chat.providerThreadProviderId??chat.providerId,providerBindingId:chat.providerThreadBindingId,...(chat.providerThreadDriver ? {providerThreadDriver:chat.providerThreadDriver} : {})});
          if (disposed) throw new Error('Agent runtime is closed.');
          const current=chatFor(chatId);
          if (runs.has(chatId) || current.providerThreadId !== chat.providerThreadId || current.providerTurnId !== chat.providerTurnId || current.recovery?.kind !== 'recovery-needed') return {chat:current,resolved:current.recovery?.kind !== 'recovery-needed',reason:'The attempt state changed while checking. Review its current status.'};
          if (!result.resolved || !result.terminalStatus) return {chat:current,resolved:false,reason:result.reason,...(/still active/i.test(result.reason) ? {stillRunning:true} : {})};
          const updated=store.updateChat(chatId,{recovery:null,error:null,status:result.terminalStatus === 'completed' ? 'completed' : result.terminalStatus === 'interrupted' ? 'interrupted' : 'failed'});
          store.appendItem(chatId,'notice',result.reason,'completed',{providerThreadId:chat.providerThreadId,providerTurnId:chat.providerTurnId,reconciledStatus:result.terminalStatus});
          timeline(chatId);state();
          // #449: the check found the restart-interrupted turn ended: continue it in the same thread (or drop the wait when it completed).
          const waiting = autoResume.get(chatId);
          if (waiting?.kind === 'restart' && waiting.state === 'check') {
            if (result.terminalStatus === 'completed' || !settingOn('chats.resumeAfterRestart')) clearAutoResume(chatId);
            else { autoResume.update(chatId, {state:'armed', resumeAt:new Date().toISOString(), native: hasNativeSession(updated)}); void fireResume(chatId); }
          }
          return {chat:updated,resolved:true,reason:result.reason};
        } finally {reconciliations.delete(chatId);}
      }
      case 'approval.respond': { const approvalId = id(p.id); if (typeof p.approved !== 'boolean') throw new Error('Invalid approval decision.');
        if (p.decision !== undefined && !['accept','acceptForSession','decline'].includes(p.decision as string)) throw new Error('Invalid approval decision.');
        const decision: ApprovalDecision = !p.approved ? 'decline' : p.decision === 'acceptForSession' ? 'acceptForSession' : 'accept';
        const pending = approvals.get(approvalId); if (!pending) throw new Error('This approval is no longer pending.');
        // Expiry is decided from the stored deadline, so a click that lands after it (or after a sleep) is never treated as consent.
        if (Date.now() >= pending.expiresAt) { finishApproval(approvalId, pending, 'decline', 'expired'); if (decision === 'decline') return; throw new Error('This approval timed out before it was answered. Use Ask again.'); }
        // A late yes is re-checked: the run must still be going and the step it was for must still be waiting.
        if (decision !== 'decline') { const stale = staleAttention(pending.chatId, approvalId); if (stale) { finishApproval(approvalId, pending, 'decline', 'interrupted', 'stale'); throw new Error(stale); } }
        finishApproval(approvalId, pending, decision, decision === 'decline' ? 'declined' : decision === 'acceptForSession' ? 'approved-session' : 'approved'); return; }
      case 'attention.sweep': return {expired: await sweepExpired()};
      case 'approval.reask': {
        const itemId = id(p.id), item = store.item(itemId);
        if (!item || (item.kind !== 'approval' && item.kind !== 'question')) throw new Error('This request no longer exists.');
        if (item.status !== 'expired' && item.status !== 'unavailable' && !(item.status === 'interrupted' && item.data?.expiredReason === 'stale')) throw new Error('This request is still open or was already answered.');
        if (item.data?.reaskedAt) throw new Error('The agent was already asked again.');
        const chatId = item.chatId, chat = chatFor(chatId);
        if (chat.archived) throw new Error('Restore this chat before asking again.');
        if (runs.has(chatId) || chat.status === 'running' || chat.status === 'stopping') throw new Error('Wait for the agent to finish, then ask again.');
        const subject = item.kind === 'approval' ? detail(item.data?.command ?? item.data?.reason ?? item.data?.tool ?? item.text).slice(0, 300) : 'the question you asked me';
        const message = item.kind === 'approval'
          ? `The approval request timed out before I could answer (${subject}). Please ask again if you still need it.`
          : `I did not get to answer ${subject} in time. Please ask again.`;
        const requestId = randomUUID();
        store.updateItem(item.id, item.text, item.status, {...item.data, reaskedAt: new Date().toISOString()}); timeline(chatId);
        return send(chatId, message, requestId);
      }
      case 'chat.autoResume': {
        const chatId = id(p.id); chatFor(chatId);
        if (typeof p.resume !== 'boolean') throw new Error('Invalid resume choice.');
        const row = autoResume.get(chatId);
        if (!row || row.kind !== 'limit' || row.state === 'running') throw new Error('This chat is not waiting for a usage limit.');
        if (p.resume) {
          const at = Math.max(row.resumeAt ? Date.parse(row.resumeAt) : 0, Date.now() + autoResumeTiming.minWaitMs);
          autoResume.update(chatId, {state:'armed', resumeAt: new Date(at).toISOString(), ...(row.state === 'gave-up' ? {attempts: 0} : {})});
          armResume(chatId);
        } else { cancelResumeTimer(chatId); autoResume.update(chatId, {state:'off'}); }
        if (queue.paused(chatId) && store.queue(chatId).length) queue.pause(chatId, p.resume ? 'limited' : 'failed');
        state();
        return decorateChat(chatFor(chatId), goalsByChat().get(chatId), autoResume.get(chatId));
      }
      case 'chat.fallbacks': {
        const chatId = id(p.id); chatFor(chatId);
        if (!Array.isArray(p.fallbacks) || p.fallbacks.length > MAX_CHAT_FALLBACKS || !p.fallbacks.every(isChatFallback)) throw new Error(`Choose at most ${MAX_CHAT_FALLBACKS} fallback models.`);
        const list = p.fallbacks.filter((entry, index, all) => all.findIndex(other => other.providerId === entry.providerId && other.model === entry.model) === index);
        autoResume.setFallbacks(chatId, list);
        // Chosen while the chat waits on a limit: it continues on the fallback now.
        const waiting = autoResume.get(chatId);
        if (waiting?.kind === 'limit' && (waiting.state === 'armed' || waiting.state === 'off' || waiting.state === 'gave-up') && list.length) { cancelResumeTimer(chatId); useFallback(chatId); }
        state();
        return decorateChat(chatFor(chatId), goalsByChat().get(chatId), autoResume.get(chatId));
      }
      case 'chat.continueAnyway': {
        const chatId = id(p.id), chat = chatFor(chatId);
        if (runs.has(chatId) || chat.status === 'running' || chat.status === 'stopping') throw new Error('This attempt is still running here. Stop it or wait first.');
        if (chat.recovery?.kind !== 'recovery-needed') return chat;
        // The user's own call: the earlier attempt stays unconfirmed and is recorded as such, but it no longer blocks the chat.
        const updated = store.updateChat(chatId, {recovery: null, error: null, status: 'interrupted'});
        // The user's call replaces the automatic continuation that waited for this check.
        if (autoResume.get(chatId)?.state === 'check') clearAutoResume(chatId);
        store.appendItem(chatId, 'notice', 'Continued without confirming the earlier attempt. It may still have been working at the provider; nothing was resent.', 'completed', {kind: 'continue-anyway', providerThreadId: chat.providerThreadId, providerTurnId: chat.providerTurnId});
        timeline(chatId); state(); return updated;
      }
      case 'question.dismiss': { const questionId = id(p.id); if (!questions.has(questionId) && isNonBlockingQuestion(store.item(questionId)?.data)) return dismissAsked(questionId); const pending = questions.get(questionId); if (!pending) throw new Error('This question is no longer pending.'); finishQuestion(questionId, pending, null, 'dismissed'); return; }
      case 'chat.compact': await compactChat(id(p.id), {fresh: p.fresh === true}); return;
      case 'question.respond': {
        const questionId = id(p.id);
        if (!questions.has(questionId) && isNonBlockingQuestion(store.item(questionId)?.data)) return answerAsked(questionId, p.answers);
        const pending = questions.get(questionId); if (!pending) throw new Error('This question is no longer pending.');
        if (Date.now() >= pending.expiresAt) { finishQuestion(questionId, pending, null, 'expired'); throw new Error('This question timed out before it was answered. Use Ask again.'); }
        { const stale = staleAttention(pending.chatId, questionId); if (stale) { finishQuestion(questionId, pending, null, 'interrupted', undefined, 'stale'); throw new Error(stale); } }
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
      case 'project.create': { const name = text(p.name,'project name',256).trim(); if (!name) throw new Error('Name the Project.'); if (!Array.isArray(p.folderIds) || p.folderIds.length > 100) throw new Error('Invalid Project folders.'); const primary = p.primaryFolderId === undefined || p.primaryFolderId === null ? null : id(p.primaryFolderId); const result = store.createProject(name, text(p.goal,'goal',32768), [...new Set(p.folderIds.map(id))], primary); state(); return result; }
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
      case 'files.chatImage': {
        const chatId = id(p.chatId), path = text(p.path, 'path', 4096);
        chatFor(chatId);
        if (!store.chatMentionsPath(chatId, path)) throw new Error('That image is not part of this chat.');
        return readChatImage(path);
      }
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
  async function interruptRun(chatId: string, run: ActiveRun) {
    run.stopped = true; run.retry.abort(); store.updateChat(chatId, {status: 'stopping'}); settleApprovals(chatId); settleQuestions(chatId); state(); await provider.stop(chatId);
    // A turn the app-server started itself settles on its own turn/completed; if its session is gone, settle it here.
    nativeTurns.stopped(chatId, !!provider.nativeThread?.(chatId));
  }
  /** A plugin or MCP server installed while chats work: the provider's tool list is fixed per session, so chats whose
   *  current or recent turn was about it restart on a fresh session that resumes their thread and re-send their
   *  last message through the queue. Once per install and chat. */
  function reloadForInstall(plugin: InstalledPlugin) {
    if (closing || disposed) return;
    // Idle warm sessions re-launch (resuming the same thread) before their next send, so every chat sees the new tools.
    provider.markStale?.();
    for (const chat of store.snapshot().chats) {
      if (chat.archived || chat.recovery?.kind === 'recovery-needed' || compactions.has(chat.id)) continue;
      const run = runs.get(chat.id), running = !!run && !run.stopped;
      if (!running && (run || chat.status === 'running' || chat.status === 'stopping')) continue;
      const turn = lastTurn(store.timeline(chat.id));
      if (!turn.prompt?.text.trim()) continue;
      // Only chats whose turn is about this plugin: other running work is never interrupted and re-sent.
      if (running ? !turnMentions(plugin, turn) : !turnAbout(plugin, turn, chat.updatedAt)) continue;
      if (!pluginReloads.claim(plugin, chat.id)) continue;
      let item: QueuedMessage;
      try { item = queue.add(chat.id, {text: turn.prompt.text, requestId: randomUUID(), attachmentIds: []}); queue.promote(chat.id, item.id); }
      catch { continue; }
      store.appendItem(chat.id, 'notice', pluginReloadNotice(plugin.name), 'completed', {kind: 'plugin-reloaded', plugin: plugin.name});
      timeline(chat.id);
      if (running) { pluginReloads.await(chat.id); void interruptRun(chat.id, run!).catch(() => undefined); }
      else { queue.resume(chat.id); dispatchQueued(chat.id); }
    }
    state();
  }
  const offInstalls = domainHooks.hooks.onCommand?.(({command, output}) => { const plugin = installedPlugin(command, output); if (plugin) reloadForInstall(plugin); });
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
    providersSettled: () => Promise.resolve(provider.ready?.()).catch(() => undefined),
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
    for (const chatId of archived) { const chat = store.chat(chatId); if (chat) void domainHooks.chatRemoval({chat, kind: 'archive'}); }
    state();
    emit({type:'notice', message:`Archived ${plural(archived.length, 'chat')} idle for over ${days} days. Find ${archived.length === 1 ? 'it' : 'them'} under Archived.`});
  }
  scheduleSnoozes();
  queueMicrotask(() => { void sweepIdleChats(); });
  queueMicrotask(() => { void bootAutoResume().catch(() => undefined); });
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
    for (const timer of resumeTimers.values()) clearTimeout(timer); resumeTimers.clear();
    disposal = (async () => {
      watcher.dispose(); watchedFolders.clear();
      for (const [chatId, run] of runs) {
        // #449: a quit is not a Stop. The live turn is kept as interrupted by shutdown (its thread and turn ids are already
        // on the chat; the prompt goes in the row) and continues after the next start. Never one waiting on an approval or
        // question, one the user was already stopping, or a continuation that was itself cut short.
        const prior = autoResume.get(chatId), chat = store.chat(chatId);
        if (!run.stopped) run.quit = true;
        if (chat && !run.stopped && !approvalsFor(chatId) && !(prior?.kind === 'restart' && prior.state === 'running')) {
          run.shutdown = true;
          autoResume.set({chatId, kind:'restart', state:'shutdown', resumeAt:null, attempts:0, prompt: run.prompt ?? null, reuseItemId:null, attachmentIds:[], noticeId:null, native: hasNativeSession(chat)});
        }
        run.stopped = true; run.retry.abort(); settleApprovals(chatId); settleQuestions(chatId);
      }
      offIdleEvents?.(); offQueueEvents(); offInstalls?.(); nativeTurns.dispose(); askHost?.dispose();
      provider.dispose();
      // Main owns the user-visible deadline. Keep the database open until all
      // tracked callbacks settle, even if main times out and keeps the app open.
      hindsight?.dispose();
      await Promise.allSettled([...invocations,...[...runs.values()].flatMap(run => run.promise ? [run.promise] : [])]);
      await domains.dispose();
      await toolOutputLog.flush().catch(() => {});
      disposed = true; snapshots.dispose(); for (const timer of timers.values()) clearTimeout(timer); timers.clear(); customProviders.close(); annotations.close(); projectTasks.close(); store.close();
    })();
    return disposal;
  }};
}
