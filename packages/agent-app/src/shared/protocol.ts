import type {PendingAttentionSummary} from './attention-protocol.ts';
import type {ScopedComputerCommands} from './scoped-computer-protocol.ts';
import type {ProcessCommands,ProcessEvent} from './process-protocol.ts';
import type {BrowserCommands, BrowserEvent} from './browser-protocol.ts';
/** The only renderer capability surface. Main validates every command and sender. */
export type ChatPermissionMode = 'read-only' | 'workspace' | 'full';
export type ChatStatus = 'idle' | 'running' | 'stopping' | 'completed' | 'failed' | 'interrupted';
export interface Folder { id: string; path: string; name: string }
export interface ChatRecovery { kind: 'admission-rejected' | 'recovery-needed' | 'failed' | 'cancelled'; retryable: boolean; reason: string }
export interface Chat { id: string; folderId?: string; projectId?: string; title: string; pinned: boolean; pinOrder?: number; archived: boolean; draft: string; status: ChatStatus; updatedAt: string; providerId?: string; providerBindingId?: string; providerThreadProviderId?: string; providerThreadBindingId?: string; providerThreadId?: string; providerTurnId?: string; recovery?: ChatRecovery; model: string; mode: 'ask' | 'plan' | 'agent'; permissionMode?: ChatPermissionMode; error?: string }
export interface PendingQuestionOption { label: string; description?: string; value?: string }
export interface PendingQuestion { id: string; header: string; question: string; options: PendingQuestionOption[]; allowCustomAnswer: boolean; multiSelect: boolean; isSecret?: boolean; isOther?: boolean }
export interface PendingQuestionData { method: 'item/tool/requestUserInput'; questions: PendingQuestion[] }
export interface TimelineItem { id: string; chatId: string; kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'approval' | 'question' | 'notice'; text: string; status?: string; createdAt: string; data?: Record<string, unknown> }
export interface TimelineSnapshot { items: TimelineItem[]; revision: number }
export interface TimelinePatch extends TimelineSnapshot { after: number }
export interface Project { id: string; name: string; goal: string; folderIds: string[] }
export interface Snapshot { folders: Folder[]; chats: Chat[]; projects: Project[]; activeChatId?: string; version: number; attention?: PendingAttentionSummary }
export interface FileEntry { name: string; path: string; kind: 'file' | 'directory' }
export interface DocumentPreview {base64:string;revision:string;sourceFormat:string;converted:boolean;size:number}
export type WorkbookCellType = 'text'|'number'|'date'|'boolean'|'error';
export interface WorkbookPreview {revision:string;sheets:{name:string;rows:string[][];types?:WorkbookCellType[][];formulas:Record<string,string>;limited:boolean}[];limited:boolean}
export interface FileAnnotation {id:string;folderId:string;path:string;revision:string;location:string;quote:string;note:string;createdAt:string}
export interface ChangedFile { path: string; previousPath?: string; status: string; adds?: number; dels?: number }
export interface GitLocalFile {path:string;previousPath?:string;index:string;worktree:string;staged:boolean;untracked:boolean;conflict:boolean}
export interface GitLocalStatus {branch:string;detached:boolean;unborn:boolean;revision:string;files:GitLocalFile[];truncated:boolean;stagedCount:number;conflicted:boolean}
export interface ProviderInfo { id: string; driver?: string; bindingId?: string; name: string; available: boolean; identityMasked: string; models: { id: string; name: string }[]; error?: string; status?: 'ready' | 'configured' | 'installed' | 'not-detected' | 'error'; source?: string; detail?: string; canReveal?: boolean; custom?: boolean; endpoint?: string; apiKeyEnv?: string; checkedAt?: string }
/** Read-only local skill inventory. Skills are inspected, never installed or executed here. */
export interface SkillEntry { id: string; name: string; provenance: string; path: string; readme: string | null; readError: string | null }
/** 'live' = from a provider event this session; 'restored' = loaded from SQLite after restart. */
export type ContextSource = 'live' | 'restored';
/** Context-window occupancy telemetry. Unknown values are null ("Unavailable"), never zero. */
export interface ContextTelemetry { usedTokens: number | null; windowTokens: number | null; source: ContextSource | null; compacted: boolean; updatedAt: string | null }
export type AgentEvent = ProcessEvent | BrowserEvent | {type:'fileMoved';folderId:string;from:string;to:string} | {type:'workspaceChanged';folderId:string} | {type:'chatSelected'; chatId:string} | { type: 'snapshot'; snapshot: Snapshot } | { type: 'timeline'; chatId: string; items: TimelineItem[] } | { type: 'timelinePatch'; chatId: string; patch: TimelinePatch } | { type: 'notice'; message: string } | { type: 'contextTelemetry'; chatId: string; telemetry: ContextTelemetry };
export interface MemoryEntry { id: string; kind: string; summary: string; sourceUri?: string; observedAt: string; confidence: number; provenance: string[]; scopes: Array<{kind: string; id: string}>; redactionState: 'none' | 'redacted' | 'hashed' | 'blocked'; links?: string[] }
export interface HindsightStatus { configured: boolean; endpoint?: string; bankId?: string; error?: string; revision?: number; connection?: 'unchecked' | 'verified' | 'failed'; checkedAt?: string; connectionError?: string }
export interface Commands extends BrowserCommands, ScopedComputerCommands, ProcessCommands {
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
 'chat.timeline': { input: {id: string; select?: boolean}; output: TimelineSnapshot };
 'chat.update': { input: {id: string; title?: string; pinned?: boolean; archived?: boolean; draft?: string; mode?: Chat['mode']; model?: string}; output: Chat };
 'chat.selectProvider': {input: {id: string; providerId: string; model: string}; output: Chat};
 'chat.setPermissionMode': {input: {id: string; permissionMode: ChatPermissionMode; acknowledgeFullAccess?: boolean}; output: Chat};
 'chat.movePin': { input: {id: string; direction: 'up' | 'down'}; output: void };
 'chat.send': { input: {id: string; text: string; requestId: string}; output: {runId: string} };
 'chat.stop': { input: {id: string}; output: void };
 'chat.reconcile': {input: {id: string}; output: {chat: Chat; resolved: boolean; reason: string}};
 'approval.respond': { input: {id: string; approved: boolean}; output: void };
 'question.respond': { input: {id: string; answers: Record<string, {answers: string[]}>}; output: void };
 'project.create': { input: {name: string; goal: string; folderIds: string[]}; output: Project };
 'workspace.watch': { input: {folderIds:string[]}; output: void };
 'files.list': { input: {folderId: string; path?: string}; output: FileEntry[] };
 'files.create': {input:{folderId:string;path:string;kind:'file'|'directory'};output:void};
 'files.move': {input:{folderId:string;from:string;to:string};output:void};
 'files.trash': {input:{folderId:string;path:string};output:void};
 'files.reveal': {input:{folderId:string;path:string};output:void};
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
 'git.diff': { input: {folderId: string; path: string}; output: {path: string; before: string; after: string; truncated: boolean} };
 'providers.list': { input: undefined; output: ProviderInfo[] };
 'providers.save': { input: {id?:string;name: string; endpoint: string; apiKeyEnv?: string}; output: ProviderInfo };
 'providers.cancelCheck': {input:{id:string};output:void};
 'providers.remove': { input: {id: string}; output: void };
 'providers.check': { input: {id: string}; output: ProviderInfo };
 'providers.reveal': { input: {id: string}; output: {identity: string} };
  'chat.contextTelemetry': { input: {id: string}; output: ContextTelemetry };
  'plugins.list': { input: { folderPaths?: string[] }; output: SkillEntry[] };
}
export interface AgentBridge {
 invoke<K extends keyof Commands>(command: K, input: Commands[K]['input']): Promise<Commands[K]['output']>;
 subscribe(listener: (event: AgentEvent) => void): () => void;
}
declare global { interface Window { muster: AgentBridge } }
