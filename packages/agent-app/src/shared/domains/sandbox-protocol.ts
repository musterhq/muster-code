/** Sandbox domain contract: which environment a chat's agent runs in. Add commands here; the allowlist and service dispatch pick them up. */

/** 'host' runs the agent in the folder on this Mac. 'sandbox' runs its commands and edits inside the chat's Linux container. */
export type ChatEnvironmentKind = 'host' | 'sandbox';
/**
 * 'copy': the folder is copied into the container's workspace (an isolated copy; changes come back through Apply to host).
 * 'mount': the folder itself would be bound at /workspace. The bundled container core only mounts its own app-data workspace,
 * so 'mount' is refused with that reason until the core accepts a caller-supplied bind source.
 */
export type ChatEnvironmentMode = 'mount' | 'copy';
/** SBX-11: where the agent's browser runs. 'sandbox' is only available to a chat that runs in the sandbox. */
export type ChatBrowserPlacement = 'host' | 'sandbox';
export interface ChatEnvironment {chatId: string; env: ChatEnvironmentKind; mode: ChatEnvironmentMode}
export interface ChatEnvironmentStatus extends ChatEnvironment {
  /** For 'sandbox': the container is running and can take a turn now. Always true for 'host'. */
  ready: boolean;
  reason?: string;
  /** Where the agent browser runs: on this Mac (default) or as a supervised service inside the chat's container. */
  browser: ChatBrowserPlacement;
  /** For browser 'sandbox': the in-container service's state; its DevTools endpoint is reachable only inside the container. */
  browserService?: {state: string; reason?: string; endpoint: string};
  /** Host path of the isolated copy (bind-mounted at /workspace), once seeded. */
  workspacePath?: string;
  seededAt?: string;
}
export type SandboxChangeStatus = 'added' | 'modified' | 'deleted';
export interface SandboxChange {path: string; status: SandboxChangeStatus; bytes: number}
export interface SandboxChanges {chatId: string; folderId: string; files: SandboxChange[]; truncated: boolean}
export interface SandboxFileDiff {path: string; status: SandboxChangeStatus; patch: string; truncated: boolean}

export interface SandboxCommands {
  'sandbox.chatEnvironment.get': {input: {chatId: string}; output: ChatEnvironmentStatus};
  /** Refused while the chat is running. Selecting 'sandbox' sets the chat's host access to read-only. */
  'sandbox.chatEnvironment.set': {input: {chatId: string; env: ChatEnvironmentKind; mode?: ChatEnvironmentMode}; output: ChatEnvironmentStatus};
  /** Re-copies the folder into the isolated copy, discarding the copy's own changes. Refused while running. */
  'sandbox.syncFromHost': {input: {chatId: string}; output: ChatEnvironmentStatus};
  /** Files that differ between the isolated copy and the folder on this Mac. */
  'sandbox.changes': {input: {chatId: string}; output: SandboxChanges};
  'sandbox.fileDiff': {input: {chatId: string; path: string}; output: SandboxFileDiff};
  /** Copies the chosen files from the isolated copy onto this Mac (deletions remove the host file). */
  'sandbox.applyToHost': {input: {chatId: string; paths: string[]}; output: {applied: string[]}};
  /** SBX-11: runs the agent browser on this Mac or inside the chat's sandbox. Refused while the chat is running. */
  'sandbox.browserPlacement.set': {input: {chatId: string; browser: ChatBrowserPlacement}; output: ChatEnvironmentStatus};
}
export type SandboxEvent = {type: 'sandboxEnvironment'; chatId: string; environment: ChatEnvironmentStatus};
export const SANDBOX_COMMANDS = {
  'sandbox.chatEnvironment.get': true, 'sandbox.chatEnvironment.set': true, 'sandbox.syncFromHost': true,
  'sandbox.changes': true, 'sandbox.fileDiff': true, 'sandbox.applyToHost': true, 'sandbox.browserPlacement.set': true,
} as const satisfies Record<keyof SandboxCommands, true>;
