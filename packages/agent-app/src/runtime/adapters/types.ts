import type {PermissionResult} from '../permission-result.ts';
import type {Chat} from '../../shared/protocol.ts';

/** One turn for a non-Codex route. Events use the Codex app-server shapes service.ts
 * already folds into the timeline: `item/started` / `item/completed` with an `item`
 * of type commandExecution, fileChange, fileRead, webSearch, todoList,
 * collabAgentToolCall, mcpToolCall or dynamicToolCall, plus `thread/tokenUsage/updated`. */
export interface McpServerSpec { command: string; args?: string[]; env?: Record<string, string> }
/** #147 phase 2: the run's CLI runs on an SSH host, in `root` there. `command` is the `muster-remote:` name spawnOwned starts
 *  over ssh (owned-process.ts); the adapter uses it instead of its local binary and `root` as the CLI's folder. */
export interface RemoteRun { host: string; root: string; command: string }
export interface AdapterRunInput {
  chat: Chat; cwd: string; prompt: string; model: string;
  images?: string[];
  /** True when the selected model reports image input; tool reads of images (read_file) are then sent to it as pictures. */
  vision?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Declared input window for direct HTTP request budgeting (including tool rounds). */
  contextWindow?: number;
  /** Mode and domain instructions, already joined. */
  instructions?: string;
  /** Muster's own tool servers for this run (in-app browser, terminal, mailbox…), from the domains' `mcp_servers.*`
   *  overrides. Adapters that can load MCP servers pass them to the model; the rest ignore them. */
  mcpServers?: Record<string, McpServerSpec>;
  /** #424: offer Muster's in-app browser as native tools (HTTP routes); they call the same bridge as the MCP server. */
  browserTools?: boolean;
  /** Extra environment for the run's process: the agent's git identity and the secrets lent to it. */
  env?: Record<string, string>;
  /** #841: 'auto' reaches only routes Muster answers approvals for (autoApprovalSupported); any other route gets 'workspace'. */
  permissionMode: 'read-only' | 'workspace' | 'auto' | 'full';
  /** #653: the chat runs in the sandbox. permissionMode is then read-only, and routes that receive the sandbox tools also
   *  deny their own host shell and edit tools (Claude Code --disallowedTools, the OpenCode plan agent, Grok's rejections). */
  sandboxed?: boolean;
  /** Asked before a tool this adapter runs itself changes anything (a command, a file change). Resolves allow to go ahead: the Project tool rules, the guard for the user's own processes and approval cards live behind it. */
  authorize?(method: string, params: Record<string, unknown>, options?: {policyOnly?: boolean}): Promise<PermissionResult>;
  /** ask_user (HTTP routes): posts the question card and resolves at once with the text for the model; it never waits for the user. */
  askUser?(args: Record<string, unknown>): Promise<string>;
  /** #842 request_secret (HTTP routes): waits for the private card. `text` is for the model and never holds the value; `env` goes into the run's next commands. */
  requestSecret?(args: Record<string, unknown>): Promise<{text: string; isError?: boolean; env?: Record<string, string>}>;
  /** The saved conversation to continue; only set when it belongs to this route and binding. */
  resumeThreadId?: string;
  /** Asked when `resumeThreadId` names a conversation the adapter no longer holds: returns a summary of the earlier messages to send ahead of the prompt. */
  onThreadReset?(previousThreadId: string): string | undefined;
  /** #147 phase 2: run the CLI on this SSH host instead of here. Routes that cannot are never given one. */
  remote?: RemoteRun;
  signal: AbortSignal;
  onThreadReady(threadId: string): void;
  onTurnAccepted(identity: {threadId: string; turnId: string}): void;
  onDelta(text: string): void;
  onReasoning(text: string): void;
  onEvent(method: string, params: Record<string, unknown>): void;
  /** Adapters that can take a message mid-turn hand back a sender; it returns false once the run can no longer accept one,
   *  or `refused` with a reason the composer shows when the run is still going but cannot take it (#839). */
  onSteerable?(send: (text: string) => boolean | {refused: string}): void;
  /** #401: set when the chat wants a suggested next prompt after this turn. Called at most once, after the run has settled;
   *  routes with no suggestion never call it. It must never hold the turn: the run resolves first. */
  onSuggestion?(text: string): void;
}
export interface AdapterRunResult {
  status: 'completed' | 'failed';
  finalMessage: string;
  threadId?: string; turnId?: string;
  errorMessage?: string;
  /** not-dispatched: the upstream refused before doing work (bad key, 4xx, missing binary). */
  dispatchState: 'not-dispatched' | 'dispatched';
  statusCode?: number;
  retryAfterMs?: number;
}
export interface RunnableAdapter {
  /** 'http' runs are stateless requests; 'cli' runs own a local child process. Neither leaves remote work behind once settled. */
  kind: 'http' | 'cli';
  run(input: AdapterRunInput): Promise<AdapterRunResult>;
}
/** Result of an asynchronous capability check (binary probe, /models request). */
export interface Validation<T> {status: 'pending' | 'ok' | 'error'; value?: T; reason?: string; checkedAt?: number}
