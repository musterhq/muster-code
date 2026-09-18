/** The only renderer capability surface. Main validates every command and sender. */
export type ChatStatus = 'idle' | 'running' | 'stopping' | 'completed' | 'failed' | 'interrupted';
export interface Folder { id: string; path: string; name: string }
export interface Chat { id: string; folderId?: string; projectId?: string; title: string; pinned: boolean; archived: boolean; draft: string; status: ChatStatus; updatedAt: string; providerThreadId?: string; model: string; mode: 'ask' | 'plan' | 'agent'; error?: string }
export interface TimelineItem { id: string; chatId: string; kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'approval' | 'notice'; text: string; status?: string; createdAt: string; data?: Record<string, unknown> }
export interface Project { id: string; name: string; goal: string; folderIds: string[] }
export interface Snapshot { folders: Folder[]; chats: Chat[]; projects: Project[]; activeChatId?: string; version: number }
export interface FileEntry { name: string; path: string; kind: 'file' | 'directory' }
export interface ChangedFile { path: string; previousPath?: string; status: string; adds?: number; dels?: number }
export interface ProviderInfo { id: string; name: string; available: boolean; identityMasked: string; models: { id: string; name: string }[]; error?: string; status?: 'ready' | 'configured' | 'installed' | 'not-detected' | 'error'; source?: string; detail?: string; canReveal?: boolean; custom?: boolean; endpoint?: string; apiKeyEnv?: string; checkedAt?: string }
export type AgentEvent = {type:'workspaceChanged';folderId:string} | {type:'chatSelected'; chatId:string} | { type: 'snapshot'; snapshot: Snapshot } | { type: 'timeline'; chatId: string; items: TimelineItem[] } | { type: 'notice'; message: string };
export interface Commands {
 'clipboard.write': {input:{text:string};output:void};
 'link.open': {input:{url:string};output:void};
 'app.snapshot': { input: undefined; output: Snapshot };
 'folder.add': { input: {path: string}; output: Folder };
 'folder.pick': { input: undefined; output: Folder | null };
 'chat.create': { input: {folderId?: string; projectId?: string}; output: Chat };
 'chat.select': { input: {id: string}; output: TimelineItem[] };
 'chat.update': { input: {id: string; title?: string; pinned?: boolean; archived?: boolean; draft?: string; mode?: Chat['mode']}; output: Chat };
 'chat.send': { input: {id: string; text: string; requestId: string}; output: {runId: string} };
 'chat.stop': { input: {id: string}; output: void };
 'approval.respond': { input: {id: string; approved: boolean}; output: void };
 'project.create': { input: {name: string; goal: string; folderIds: string[]}; output: Project };
 'workspace.watch': { input: {folderIds:string[]}; output: void };
 'files.list': { input: {folderId: string; path?: string}; output: FileEntry[] };
 'files.read': { input: {folderId: string; path: string}; output: {path: string; text: string; truncated: boolean} };
 'git.changes': { input: {folderId: string}; output: ChangedFile[] };
 'git.diff': { input: {folderId: string; path: string}; output: {path: string; before: string; after: string; truncated: boolean} };
 'providers.list': { input: undefined; output: ProviderInfo[] };
 'providers.save': { input: {name: string; endpoint: string; apiKeyEnv?: string}; output: ProviderInfo };
 'providers.remove': { input: {id: string}; output: void };
 'providers.check': { input: {id: string}; output: ProviderInfo };
 'providers.reveal': { input: {id: string}; output: {identity: string} };
}
export interface AgentBridge {
 invoke<K extends keyof Commands>(command: K, input: Commands[K]['input']): Promise<Commands[K]['output']>;
 subscribe(listener: (event: AgentEvent) => void): () => void;
}
declare global { interface Window { muster: AgentBridge } }
