import type {Chat} from '../../shared/protocol.ts';

/** One turn for a non-Codex route. Events use the Codex app-server shapes service.ts
 * already folds into the timeline: `item/started` / `item/completed` with an `item`
 * of type commandExecution, fileChange, fileRead, webSearch, todoList,
 * collabAgentToolCall, mcpToolCall or dynamicToolCall, plus `thread/tokenUsage/updated`. */
export interface McpServerSpec { command: string; args?: string[]; env?: Record<string, string> }
export interface AdapterRunInput {
  chat: Chat; cwd: string; prompt: string; model: string;
  images?: string[];
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Mode and domain instructions, already joined. */
  instructions?: string;
  /** Muster's own tool servers for this run (in-app browser, terminal, mailbox…), from the domains' `mcp_servers.*`
   *  overrides. Adapters that can load MCP servers pass them to the model; the rest ignore them. */
  mcpServers?: Record<string, McpServerSpec>;
  permissionMode: 'read-only' | 'workspace' | 'full';
  /** The saved conversation to continue; only set when it belongs to this route and binding. */
  resumeThreadId?: string;
  signal: AbortSignal;
  onThreadReady(threadId: string): void;
  onTurnAccepted(identity: {threadId: string; turnId: string}): void;
  onDelta(text: string): void;
  onReasoning(text: string): void;
  onEvent(method: string, params: Record<string, unknown>): void;
}
export interface AdapterRunResult {
  status: 'completed' | 'failed';
  finalMessage: string;
  threadId?: string; turnId?: string;
  errorMessage?: string;
  /** not-dispatched: the upstream refused before doing work (bad key, 4xx, missing binary). */
  dispatchState: 'not-dispatched' | 'dispatched';
  statusCode?: number;
}
export interface RunnableAdapter {
  /** 'http' runs are stateless requests; 'cli' runs own a local child process. Neither leaves remote work behind once settled. */
  kind: 'http' | 'cli';
  run(input: AdapterRunInput): Promise<AdapterRunResult>;
}
/** Result of an asynchronous capability check (binary probe, /models request). */
export interface Validation<T> {status: 'pending' | 'ok' | 'error'; value?: T; reason?: string; checkedAt?: number}
