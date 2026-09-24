import type {PendingAttentionSummary} from './attention-protocol.ts';
import type {ScopedComputerCommands, ScopedComputerEvent} from './scoped-computer-protocol.ts';
import type {ProcessCommands,ProcessEvent} from './process-protocol.ts';
export const MAX_ATTACHED_SKILL_BYTES = 48 * 1024;
import type {BrowserCommands, BrowserEvent} from './browser-protocol.ts';
import type {DomainCommands, DomainEvent} from './domains/index.ts';
import type {ChatGoal} from './domains/goals-protocol.ts';
import type {ExcludedModel, ModelPricing} from './model-catalog.ts';
/** The only renderer capability surface. Main validates every command and sender. */
export type ChatPermissionMode = 'read-only' | 'workspace' | 'full';
/** 'waiting' (approval or question open), 'queued' and 'reconnecting' are display states derived in the renderer; the runtime never persists them. */
export type ChatStatus = 'idle' | 'running' | 'stopping' | 'completed' | 'failed' | 'interrupted' | 'waiting' | 'queued' | 'reconnecting';
/** `missing` is set when the folder path was not a directory at snapshot time (cached ~10s); the sidebar offers Relink. */
export interface Folder { id: string; path: string; name: string; missing?: boolean }
export interface ChatRecovery { kind: 'admission-rejected' | 'recovery-needed' | 'failed' | 'cancelled'; retryable: boolean; reason: string }
/** A follow-up waiting for the current run to complete. Dispatched in order through chat.send with its own requestId. */
export interface QueuedMessage {id:string; text:string; requestId:string; attachmentIds:string[]; createdAt:string; skillIds?:string[]; pluginIds?:string[]; effort?:ReasoningEffort; /** Set when a dispatch was refused; the row offers Retry. */ error?:string}
/** Codex limits: 100 queued items per thread, 1 MiB of text per item. */
export const MAX_QUEUED_MESSAGES = 100;
export const MAX_QUEUED_TEXT = 1024 * 1024;
/** Why a chat's queue is not dispatching: the user interrupted the run, or the run failed. */
export type QueuePause = 'interrupted' | 'failed';
/** While a turn runs, a follow-up queues or steers; the invert shortcut does the other for one message. */
export type FollowUpMode = 'queue' | 'steer';
/** A file staged in a chat's composer ('staged') or delivered with a message ('sent'). Bytes stay in main. */
export interface AttachmentRef {id:string; chatId:string; name:string; mime:string; size:number; kind:'image'|'file'; width?:number; height?:number; state:'staged'|'sent'}
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const ATTACHMENT_IMAGE_MIMES = ['image/png','image/jpeg','image/gif','image/webp'] as const;
export interface Chat { id: string; folderId?: string; projectId?: string; title: string; pinned: boolean; pinOrder?: number; archived: boolean; draft: string; status: ChatStatus; updatedAt: string; providerId?: string; providerBindingId?: string; providerThreadProviderId?: string; providerThreadBindingId?: string; providerThreadId?: string; providerTurnId?: string; recovery?: ChatRecovery; model: string; unread?: boolean; lastViewedAt?: string; mode: 'ask' | 'plan' | 'agent'; permissionMode?: ChatPermissionMode; error?: string; queue?: QueuedMessage[]; queuePaused?: QueuePause; goal?: ChatGoal;
  /** 'default' until the first exchange names it, 'generated' after, 'user' once renamed (never overwritten). */
  titleSource?: ChatTitleSource;
  /** Set on a fork: the chat and item it branched from. */
  originChatId?: string; originItemId?: string;
  /** CHAT-15: an absolute instant (ISO) the chat sleeps until; hidden in the sidebar's Snoozed group meanwhile. */
  snoozedUntil?: string;
  /** CHAT-15: snoozed until the chat has new activity (a run settles or asks for input) instead of a time. */
  snoozeUntilActivity?: boolean }
export type ChatTitleSource = 'default' | 'generated' | 'user';
/** What Edit can do with an earlier prompt. Forking is always offered; replacing only when nothing after it touched files. */
export interface EditResendOptions { canReplace: boolean; replaceBlockedReason?: string; dirtyFiles: number }
/** CHAT-18: what "Replace and restore files" would put back. `files` are the Muster-owned paths (touched by agent turns after the
 *  edited message) that differ from the turn's pre-run snapshot; `left` are later changes Muster did not make and never touches.
 *  `external` counts commands that ran after that point: their effects are never described as undone. */
export interface EditRestorePreview { available: boolean; reason?: string; runId?: string; files: EditRestoreFile[]; left: string[]; external: number }
export interface EditRestoreFile { path: string; action: 'restore' | 'delete'; afterHash: string; adds: number; dels: number }
export type EditResendMode = 'fork' | 'replace' | 'restore';
export type ChatMenuAction = 'rename'|'activity'|'files'|'terminal'|'pin'|'archive'|'fork'|'snooze'|'share';
/** CHAT-15: how a chat wakes. Timed and activity wakes carry one OS notification; a manual wake never does. */
export type WakeReason = 'time' | 'activity' | 'manual';
/** Shown before archiving a chat that is working or waiting for input, and noted in its timeline. */
export const ARCHIVE_RUNNING_WARNING = 'Archiving stops nothing; the agent keeps working in the background.';
/** A shareable transcript. `omitted` names what was left out or redacted, so nothing disappears silently. */
export interface ChatExport { text: string; omitted: string[]; fileName: string }
export interface PendingQuestionOption { label: string; description?: string; value?: string }
export interface PendingQuestion { id: string; header: string; question: string; options: PendingQuestionOption[]; allowCustomAnswer: boolean; multiSelect: boolean; isSecret?: boolean; isOther?: boolean }
export interface PendingQuestionData { method: 'item/tool/requestUserInput'; questions: PendingQuestion[] }
export interface TimelineItem { id: string; chatId: string; kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'approval' | 'question' | 'notice'; text: string; status?: string; createdAt: string; data?: Record<string, unknown> }
/** `data` of an approval item. `kind` picks the card body; every field is optional because providers omit them. */
export interface ApprovalData { method: string; kind: 'command' | 'fileChange' | 'mcp'; command?: string; cwd?: string; reason?: string; diff?: Array<{path: string; diff?: string; kind?: string}>; server?: string; tool?: string; args?: string; expiredReason?: 'restart'; /** R5: the command would stop a process the user started; never approvable for the whole session. */ protectsUserProcess?: boolean }
/** `acceptForSession` maps to the codex app-server decision of the same name: later identical requests in this session are not asked again. */
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline';
export interface TimelineSnapshot { items: TimelineItem[]; revision: number }
export interface TimelinePatch extends TimelineSnapshot { after: number }
export interface Project { id: string; name: string; goal: string; folderIds: string[]; primaryFolderId?: string | null; archived?: boolean }
export type TaskStatus = 'todo' | 'running' | 'blocked' | 'implemented' | 'verified';
export interface ProjectTask { id:string; projectId:string; title:string; status:TaskStatus; dependencies:string[]; acceptance:string; evidence:string[]; runChatId?:string; runRequestId?:string; runError?:string; revision:number; createdAt:string; updatedAt:string }
export interface ProjectDecision { id:string; projectId:string; title:string; rationale:string; author:string; scope:string; relatedTaskIds:string[]; status:'active'|'superseded'; supersededById:string|null; createdAt:string; updatedAt:string }
export interface ProjectActivity { id:string; projectId:string; actor:string; kind:string; summary:string; refId:string|null; createdAt:string }
export interface BoundedList<T> { items:T[]; truncated:boolean }
export interface ProjectChatReference { id:string; title:string; folderId?:string; providerId:string; model:string; mode:Chat['mode']; permissionMode?:ChatPermissionMode; status:ChatStatus; updatedAt:string; recovery?:ChatRecovery }
export interface ProjectExport { schemaVersion:2; exportedAt:string; project:Project; folders:Folder[]; chats:BoundedList<ProjectChatReference>; tasks:BoundedList<ProjectTask>; decisions:BoundedList<ProjectDecision>; activity:BoundedList<ProjectActivity> }
export interface Snapshot { folders: Folder[]; chats: Chat[]; projects: Project[]; activeChatId?: string; version: number; attention?: PendingAttentionSummary }
export interface FileEntry { name: string; path: string; kind: 'file' | 'directory' }
export interface DocumentPreview {base64:string;revision:string;sourceFormat:string;converted:boolean;size:number}
export type WorkbookCellType = 'text'|'number'|'date'|'boolean'|'error';
export interface WorkbookCellStyle {bold?:boolean;italic?:boolean;underline?:boolean;fontSize?:number;fontFamily?:string;fontColor?:string;fillColor?:string;alignment?:'left'|'center'|'right'}
export interface WorkbookPreview {revision:string;sheets:{name:string;rows:string[][];types?:WorkbookCellType[][];styles?:Array<Array<WorkbookCellStyle|null>>;formulas:Record<string,string>;limited:boolean}[];limited:boolean}
export interface FileAnnotation {id:string;folderId:string;path:string;revision:string;location:string;quote:string;note:string;createdAt:string}
/** `untrackedRoot`: for an untracked file inside a fully-untracked directory, that directory (git's `?? dir/` row, trailing '/'). */
export interface ChangedFile { path: string; previousPath?: string; status: string; adds?: number; dels?: number; untrackedRoot?: string }
export interface GitLocalFile {path:string;previousPath?:string;index:string;worktree:string;staged:boolean;untracked:boolean;conflict:boolean}
/** `upstream`/`ahead`/`behind`/`remoteUrl` are best-effort: absent when unknown, never a reason for status to fail.
 *  `remoteUrl` is the normalized https://github.com/owner/repo web URL of the branch's remote (or 'origin'); absent for non-GitHub remotes. */
export interface GitLocalStatus {branch:string;detached:boolean;unborn:boolean;revision:string;files:GitLocalFile[];truncated:boolean;stagedCount:number;conflicted:boolean;upstream?:string;upstreamGone?:boolean;ahead?:number;behind?:number;remoteUrl?:string;pushRemote?:string}
export interface GitPullRequest {number:number;title:string;url:string;state:string;headRefName:string;isDraft:boolean}
/** `available:false` carries a short human `reason` (gh missing, signed out, no GitHub remote). Never an error. */
export interface GitPullRequestList {available:boolean;reason?:string;items:GitPullRequest[]}
export interface GitCompareUrl {url:string|null;reason?:string}
/** Reasoning effort a run may request; the Codex app-server core accepts these values. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
/** A plugin/skill icon: a sanitized, size-capped data URL read from its manifest, or a deterministic monogram. */
/** `monochrome`: a black-only mark (inverted on dark surfaces); `monochromeLight`: a white-only mark (inverted on light surfaces);
 *  `darkDataUrl`: the manifest's own dark-theme logo (`interface.logoDark`), preferred over inversion in dark theme (CS-C3-2). */
export type ItemIcon = { kind: 'image'; dataUrl: string; monochrome?: boolean; monochromeLight?: boolean; darkDataUrl?: string } | { kind: 'monogram'; text: string; hue: number };
export interface ProviderInfo { id: string; driver?: string; bindingId?: string; name: string; available: boolean; identityMasked: string; models: { id: string; name: string; efforts?: ReasoningEffort[]; defaultEffort?: ReasoningEffort; /** Catalog context window (Codex `context_window`); the meter's estimate before the first report. */ contextWindow?: number; /** False when the model cannot take image input (Codex catalog `input_modalities` without "image", or a CLI without file attachments). Attached images are then withheld and the chat is told so. */ images?: boolean; /** Codex catalog `supports_search_tool`: true when the model can defer connector/MCP tools behind `tool_search` instead of receiving every schema inline. */ toolSearch?: boolean; /** Dollars per million tokens when the catalog declares a price; absent means unknown (cost shows "—"). */ pricing?: ModelPricing }[]; /** Catalog entries Muster will not offer, each with the reason (PRO-04: nothing is dropped silently). */ excludedModels?: ExcludedModel[]; error?: string; status?: 'ready' | 'configured' | 'installed' | 'not-detected' | 'error'; source?: string; detail?: string; canReveal?: boolean; custom?: boolean; endpoint?: string; apiKeyEnv?: string; checkedAt?: string }
/** Read-only local skill inventory. Skills are inspected, never installed or executed here. */
export interface SkillEntry { id: string; name: string; provenance: string; path: string; readme: string | null; readError: string | null;
  /** From agents/openai.yaml `interface` or SKILL.md front matter; absent on older runtimes. */
  displayName?: string; shortDescription?: string; icon?: ItemIcon; pluginId?: string }
/** Metadata-only installed plugin inventory. Executable config and secrets never cross into the renderer. */
export interface PluginEntry { id:string; name:string; version:string; provenance:string; path:string; skills:string[]; mcpServers:Array<{name:string;transport:'local'|'remote'|'unknown'}>; apps:Array<{name:string;id:string;required:boolean;category?:string;/** EXT-10: plugin-relative .html entry rendered in a sandboxed frame. */ui?:string}>; readError:string|null;
  /** From `.codex-plugin/plugin.json` `interface`; icon is the composerIcon/logo (sanitized) or a monogram. */
  displayName?:string; shortDescription?:string; category?:string; brandColor?:string; icon?:ItemIcon; defaultPrompts?:string[]; format?:'codex'|'claude' }
/** 'live' = from a provider event this session; 'restored' = loaded from SQLite after restart. */
export type ContextSource = 'live' | 'restored';
/** Context-window occupancy telemetry. Unknown values are null ("Unavailable"), never zero. */
export interface ContextBreakdownEntry { label: string; tokens: number }
export interface ContextTelemetry { usedTokens: number | null; windowTokens: number | null; source: ContextSource | null; compacted: boolean; updatedAt: string | null; /** Only when the provider reports one; never estimated. */ breakdown?: ContextBreakdownEntry[] }
export type AgentEvent = DomainEvent | ProcessEvent | BrowserEvent | ScopedComputerEvent | {type:'fileMoved';folderId:string;from:string;to:string} | {type:'workspaceChanged';folderId:string} | {type:'projectChanged';projectId:string;taskId:string;seq?:number} | {type:'chatSelected'; chatId:string} | {type:'chatWoke'; chatId:string; title:string; reason:WakeReason} | { type: 'snapshot'; snapshot: Snapshot } | { type: 'timeline'; chatId: string; items: TimelineItem[] } | { type: 'timelinePatch'; chatId: string; patch: TimelinePatch } | { type: 'notice'; message: string } | { type: 'contextTelemetry'; chatId: string; telemetry: ContextTelemetry };
export interface MemoryEntry { id: string; kind: string; summary: string; sourceUri?: string; observedAt: string; confidence: number; provenance: string[]; scopes: Array<{kind: string; id: string}>; redactionState: 'none' | 'redacted' | 'hashed' | 'blocked'; links?: string[] }
export interface HindsightStatus { configured: boolean; endpoint?: string; bankId?: string; error?: string; revision?: number; connection?: 'unchecked' | 'verified' | 'failed'; checkedAt?: string; connectionError?: string }
export interface Commands extends DomainCommands, BrowserCommands, ScopedComputerCommands, ProcessCommands {
 'memory.list': { input: {folderId?: string}; output: MemoryEntry[] };
 'memory.search': { input: {folderId?: string; query: string; limit?: number}; output: MemoryEntry[] };
 'memory.add': { input: {folderId?: string; summary: string; kind?: string; provenance: string[]; scopes: Array<{kind: string; id: string}>}; output: MemoryEntry };
 'memory.inspect': { input: {folderId?: string}; output: {available: boolean; objectCount: number; checks: Array<{label: string; status: string; detail: string}>; error?: string} };
 'hindsight.status': {input: {folderId?: string}; output: HindsightStatus};
 'hindsight.retain': {input: {folderId?: string; content: string; source: string}; output: {bankId: string; success: boolean; itemsCount: number; isAsync: boolean; operationId?: string}};
 'hindsight.recall': {input: {folderId?: string; query: string; budget?: 'low' | 'mid' | 'high'; maxTokens?: number; types?: Array<'world' | 'experience' | 'observation'>; tags?: string[]}; output: {bankId: string; results: readonly {id?: string; text: string; type?: string; score?: number}[]}};
 'hindsight.reflect': {input: {folderId?: string; query: string; context?: string; budget?: 'low' | 'mid' | 'high'; maxTokens?: number}; output: {bankId: string; text: string}};
 'clipboard.write': {input:{text:string};output:void};
 'link.open': {input:{url:string};output:void};
 'app.snapshot': { input: undefined; output: Snapshot };
 'folder.add': { input: {path: string}; output: Folder };
 'folder.pick': { input: undefined; output: Folder | null };
 'chat.create': { input: {folderId?: string; projectId?: string}; output: Chat };
 'chat.select': { input: {id: string}; output: TimelineItem[] };
 /** Native chat menu (sidebar row and header ⋯). Main performs data actions itself (pin, unread, archive, delete, move, copy, export)
  *  and returns only the actions the renderer owns. `surface:'header'` adds the header-only entries. */
 'chat.contextMenu': {input:{id:string;x:number;y:number;surface?:'sidebar'|'header'};output:ChatMenuAction|null};
 /** `run:'relink'` skips the menu and goes straight to the Relink dialog (the sidebar's missing-folder action). */
 'folder.contextMenu': {input:{id:string;x:number;y:number;run?:'relink'};output:'new-chat'|'rename'|'files'|'default-model'|null};
 /** UR-135: the native right-click menu for a sidebar Project row; every action runs in the renderer. */
 'project.contextMenu': {input:{id:string;x:number;y:number};output:'new-chat'|'open'|'rename'|'edit'|'export'|'archive'|'restore'|null};
 'folder.remove': {input:{id:string;archiveChats?:boolean};output:{archived:number}};
 'folder.rename': {input:{id:string;name:string};output:Folder};
 'folder.relink': {input:{id:string;path:string};output:Folder};
 'chat.delete': {input:{id:string;force?:boolean};output:void};
 /** Mark as unread (default) or read again. Never reorders the sidebar. */
 'chat.markUnread': {input:{id:string;unread?:boolean};output:Chat};
 'chat.export': {input:{id:string;format:'markdown'|'html'|'json';redact?:boolean};output:ChatExport};
 /** Share sheet: saves an export through a save dialog (main process). */
 'chat.export.file': {input:{id:string;format:'markdown'|'html'|'json';redact?:boolean};output:{saved:boolean;fileName?:string}};
 'chat.timeline': { input: {id: string; select?: boolean}; output: TimelineSnapshot };
 /** NAV-11 global search over message content (runtime full-text index of every non-archived chat's user and
  *  assistant messages). Every whitespace-separated term must appear in one message; one hit per chat (its best
  *  message), phrase matches first, then recency. Paged by `offset`/`limit` (default 20, max 50): a full page means
  *  more may follow. `ranges` are [start, end) highlight spans inside `snippet`. */
 'chat.search': { input: {query: string; offset?: number; limit?: number}; output: Array<{chatId: string; snippet: string; itemId?: string; ranges?: Array<[number, number]>; matches?: number}> };
 /** CHAT-06: which chats edited which files in a folder (folder-relative paths, from each chat's file-change
  *  items), so Changes can say who owns each pending edit and a second run can warn about overlap. */
 'chat.editOwners': { input: {folderId: string}; output: Array<{path: string; chatId: string; title: string; status: ChatStatus}> };
 /** `projectId` moves an idle chat into a Project (null leaves it); a chat with history keeps its folder, which is linked to the Project. The UI goes through project.chats.preview/transfer so the scope change is reviewed first (PRJ-17). `folderId` attaches a folder while the chat is idle;
  *  the provider thread is cleared so the next send starts fresh in the new folder. */
 'chat.update': { input: {id: string; title?: string; pinned?: boolean; archived?: boolean; /** Batch archive already confirmed running chats once: skip main's per-chat dialog. */ acknowledgeRunning?: boolean; draft?: string; mode?: Chat['mode']; model?: string; projectId?: string | null; folderId?: string}; output: Chat };
 'chat.selectProvider': {input: {id: string; providerId: string; model: string}; output: Chat};
 'chat.setPermissionMode': {input: {id: string; permissionMode: ChatPermissionMode; acknowledgeFullAccess?: boolean}; output: Chat};
 'chat.movePin': { input: {id: string; direction: 'up' | 'down'}; output: void };
 /** UX-12/UX-23 drag reorder: every pinned, unarchived chat id in its new order (a partial list is refused). */
 'chat.reorderPins': { input: {chatIds: string[]}; output: void };
 /** CHAT-15: sleep until an absolute instant (`until`, ISO, in the future) or until the chat has new activity. Never stops a run. */
 'chat.snooze': { input: {id: string; until?: string; untilActivity?: boolean}; output: Chat };
 /** CHAT-15: wake early from the row. Clears the snooze; no unread mark, no notification. */
 'chat.wake': { input: {id: string}; output: Chat };
 /** NAV-05: sidebar folder order, persisted. `folder.reorder` takes every folder id in its new order. */
 'folder.move': { input: {id: string; direction: 'up' | 'down'}; output: void };
 'folder.reorder': { input: {folderIds: string[]}; output: void };
 /** skillIds/pluginIds come from composer chips; effort overrides the run's reasoning effort for this chat. */
 'chat.send': { input: {id: string; text: string; requestId: string; skillId?: string; skillIds?: string[]; pluginIds?: string[]; effort?: ReasoningEffort; attachmentIds?: string[]}; output: {runId: string} };
 /** Chips travel with the queued message and apply when it is dispatched. */
 'chat.queue.add': {input:{id:string;text:string;requestId:string;attachmentIds?:string[];skillIds?:string[];pluginIds?:string[];effort?:ReasoningEffort};output:QueuedMessage};
 'chat.queue.update': {input:{id:string;queueId:string;text:string};output:QueuedMessage};
 'chat.queue.remove': {input:{id:string;queueId:string};output:void};
 'chat.queue.move': {input:{id:string;queueId:string;direction:'up'|'down'};output:void};
 /** Drag-to-reorder: every queued id, in the new order. */
 'chat.queue.reorder': {input:{id:string;queueIds:string[]};output:void};
 /** Clears the paused state and sends the head when the chat is idle. */
 'chat.queue.resume': {input:{id:string};output:void};
 /** Removes every queued message (and its files). */
 'chat.queue.clear': {input:{id:string};output:{removed:number}};
 /** Codex row "Steer": joins the running turn without interrupting, or sends now when idle. Retry is the same for a failed row. */
 'chat.queue.steer': {input:{id:string;queueId:string};output:{steered:boolean;started:boolean;reason?:string}};
 /** Joins the live turn. {steered:false} means no turn is running; queue the message instead. */
 /** Skill and plugin chips join the steer as instructions; effort applies from the next turn. Attachments cannot steer ({steered:false}). */
 /** `reason` explains a refusal the user should see (a review or compact turn cannot be steered). */
 'chat.steer': {input:{id:string;text:string;requestId:string;skillIds?:string[];pluginIds?:string[];effort?:ReasoningEffort;attachmentIds?:string[]};output:{steered:boolean;reason?:string}};
 'attachments.stage': {input:{chatId:string;name:string;mime:string;dataBase64:string};output:AttachmentRef};
 'attachments.discard': {input:{chatId:string;id:string};output:void};
 'attachments.list': {input:{chatId:string};output:AttachmentRef[]};
 'attachments.preview': {input:{chatId:string;id:string};output:{dataUrl:string}};
 /** Metadata (no bytes) for a batch of attachment ids in one chat, staged or already sent; unknown ids are silently dropped. */
 'attachments.info': {input:{chatId:string;ids:string[]};output:AttachmentRef[]};
 /** The resource pane opening a staged/sent attachment: same readers as files.read/asset/document/workbook, confined to the chat's attachment directory. */
 'attachments.read': {input:{chatId:string;id:string};output:{path:string;text:string;truncated:boolean}};
 'attachments.asset': {input:{chatId:string;id:string};output:{mime:string;dataUrl:string;size:number;width:number;height:number}};
 'attachments.document': {input:{chatId:string;id:string};output:DocumentPreview};
 'attachments.workbook': {input:{chatId:string;id:string};output:WorkbookPreview};
 /** Branch into a new chat with the same folder, project, model, mode and access. History up to and including `fromItemId`
  *  (all of it when absent) is copied read-only; the fork starts a fresh provider conversation seeded with a digest of it. */
 'chat.fork': {input:{id:string;fromItemId?:string};output:Chat};
 'chat.editOptions': {input:{id:string;itemId:string};output:EditResendOptions};
 /** Resend an edited earlier prompt. 'fork' (default) branches from the item before it; 'replace' drops it and everything after
  *  in this chat, which is refused while a run is active or when later work edited files (files are never rewound). */
 'chat.editResend': {input:{id:string;itemId:string;text:string;requestId:string;mode?:EditResendMode;
  /** With mode 'restore': the files the preview showed, so nothing that changed since is silently overwritten. */
  restoreFiles?:Array<{path:string;afterHash:string}>};output:{chatId:string;runId:string;forked:boolean;restored?:string[]}};
 /** CHAT-18: preview of the third edit option. Blocked (available:false with a reason) while the chat is busy, when the
  *  folder is not a Git repository, when another chat is working in the same folder, or when no turn baseline exists. */
 'chat.editRestorePreview': {input:{id:string;itemId:string};output:EditRestorePreview};
 /** Sends the latest turn's prompt again with a new requestId. `itemId` is any item of that turn. */
 'chat.retry': {input:{id:string;itemId:string;requestId?:string};output:{runId:string;requestId:string}};
 'chat.stop': { input: {id: string}; output: void };
 /** `stillRunning` means the provider reports the saved turn as active; check again later. */
 'chat.reconcile': {input: {id: string}; output: {chat: Chat; resolved: boolean; reason: string; stillRunning?: boolean}};
 /** Codex `thread/compact/start` on the chat's live provider session; a timeline row tracks intent, completion and failure. */
 'chat.compact': {input: {id: string}; output: void};
 'approval.respond': { input: {id: string; approved: boolean; decision?: ApprovalDecision}; output: void };
 /** Declines the provider request (a cancel, never empty answers). */
 'question.dismiss': { input: {id: string}; output: void };
 'question.respond': { input: {id: string; answers: Record<string, {answers: string[]}>}; output: void };
 'project.create': { input: {name: string; goal: string; folderIds: string[]}; output: Project };
 'project.tasks.list': {input:{projectId:string};output:BoundedList<ProjectTask>};
 'project.tasks.create': {input:{projectId:string;title:string;acceptance:string;dependencies:string[]};output:ProjectTask};
 'project.tasks.start': {input:{projectId:string;id:string;revision:number;requestId:string;folderId?:string};output:{task:ProjectTask;chatId:string;runId:string}};
 'project.tasks.updateStatus': {input:{projectId:string;id:string;status:TaskStatus;evidence?:string[];revision:number};output:ProjectTask};
 'project.tasks.addEvidence': {input:{projectId:string;id:string;entries:string[];revision:number};output:ProjectTask};
 'project.decisions.list': {input:{projectId:string};output:BoundedList<ProjectDecision>};
 'project.decisions.create': {input:{projectId:string;title:string;rationale:string;scope:string;relatedTaskIds:string[]};output:ProjectDecision};
 'project.decisions.supersede': {input:{projectId:string;id:string;replacementId:string};output:ProjectDecision};
 'project.activity.list': {input:{projectId:string;limit?:number};output:BoundedList<ProjectActivity>};
 'project.export': {input:{projectId:string};output:ProjectExport};
 'project.export.file': {input:{projectId:string};output:{saved:boolean;fileName?:string;truncated?:boolean}};
 'workspace.watch': { input: {folderIds:string[]}; output: void };
 'files.list': { input: {folderId: string; path?: string; /** Include `.git`, `.DS_Store` and the other default-hidden names (the Files tab's "Show .git and system files"). */ showHidden?: boolean}; output: FileEntry[] };
 'files.create': {input:{folderId:string;path:string;kind:'file'|'directory'};output:void};
 'files.move': {input:{folderId:string;from:string;to:string};output:void};
 'files.trash': {input:{folderId:string;path:string};output:void};
 'files.reveal': {input:{folderId:string;path:string};output:void};
 /** W6-D: "Save a copy…" — main shows a save dialog and copies the (folder-confined) file there. */
 'files.saveCopy': {input:{folderId:string;path:string};output:{saved:boolean;fileName?:string}};
 'files.search': { input: {folderId: string; path?: string; query: string}; output: {entries: FileEntry[]; truncated: boolean} };
 'files.read': { input: {folderId: string; path: string}; output: {path: string; text: string; truncated: boolean} };
 'files.asset': { input: {folderId: string; path: string}; output: {mime: string; dataUrl: string; size: number; width: number; height: number} };
 'files.nativeAvailable': {input:undefined;output:boolean};
 'files.nativeShow': {input:{owner:string;folderId:string;path:string;bounds:{x:number;y:number;width:number;height:number}};output:void};
 'files.nativePosition': {input:{owner:string;bounds:{x:number;y:number;width:number;height:number}};output:void};
 'files.nativeHide': {input:{owner:string};output:void};
 'files.document': {input:{folderId:string;path:string};output:DocumentPreview};
 'files.workbook': {input:{folderId:string;path:string};output:WorkbookPreview};
 'files.annotations.list': {input:{folderId:string;path:string};output:FileAnnotation[]};
 'files.annotations.add': {input:Omit<FileAnnotation,'id'|'createdAt'>;output:FileAnnotation};
 'files.annotations.remove': {input:{folderId:string;path:string;id:string};output:void};
 'git.changes': { input: {folderId: string}; output: ChangedFile[] };
 'git.status': {input:{folderId:string};output:GitLocalStatus};
 'git.mutate': {input:{folderId:string;operation:'stage'|'unstage'|'commit';revision:string;paths?:string[];message?:string};output:GitLocalStatus};
 'git.push': {input:{folderId:string;revision:string};output:GitLocalStatus};
 'git.pullRequests': {input:{folderId:string};output:GitPullRequestList};
 'git.compareUrl': {input:{folderId:string};output:GitCompareUrl};
 'git.diff': { input: {folderId: string; path: string}; output: {path: string; before: string; after: string; truncated: boolean} };
 'providers.list': { input: undefined; output: ProviderInfo[] };
 'providers.save': { input: {id?:string;name: string; endpoint: string; apiKeyEnv?: string}; output: ProviderInfo };
 'providers.cancelCheck': {input:{id:string};output:void};
 'providers.remove': { input: {id: string}; output: void };
 'providers.check': { input: {id: string}; output: ProviderInfo };
 'providers.reveal': { input: {id: string}; output: {identity: string} };
  'chat.contextTelemetry': { input: {id: string}; output: ContextTelemetry };
  'plugins.list': { input: { folderPaths?: string[] }; output: SkillEntry[] };
  'plugins.inventory': { input: undefined; output: PluginEntry[] };
  /** Writes ~/.codex/skills/<slug>/SKILL.md (+ agents/openai.yaml). Refuses to replace an existing skill unless `overwrite`. */
  'skills.create': { input: { name: string; description: string; body: string; overwrite?: boolean }; output: { id: string; slug: string; path: string; replaced: boolean } };
}
export interface AgentBridge {
 invoke<K extends keyof Commands>(command: K, input: Commands[K]['input']): Promise<Commands[K]['output']>;
 subscribe(listener: (event: AgentEvent) => void): () => void;
}
declare global { interface Window { muster: AgentBridge } }
