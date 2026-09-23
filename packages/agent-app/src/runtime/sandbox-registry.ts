import type {ScopedComputerRef} from '../shared/scoped-computer-protocol.ts';

/** Text-only MCP tool result, as Codex expects it from a stdio server. */
export interface McpToolResult {content: {type: 'text'; text: string}[]; isError?: boolean}
/** One chat's sandbox as the agent tools see it: commands in the container, files on the bind-mounted workspace. */
export interface SandboxAgentTarget {
  exec(command: string, timeoutMs: number): Promise<{state: string; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; reason?: string}>;
  read(path: string): Promise<{text: string; truncated: boolean}>;
  write(path: string, content: string): Promise<void>;
  list(path: string): Promise<{name: string; kind: string; size: number}[]>;
}
/** What the sandbox domain needs from the scoped computer manager main owns. */
export interface AgentSandboxHost {
  /** Host path of the scope's workspace (bind-mounted at /workspace) and whether its container can take a command now. */
  agentWorkspace(scope: ScopedComputerRef): Promise<{hostPath: string; running: boolean; reason?: string}>;
  /** Launcher script Codex runs as the muster_sandbox MCP server; `resolve` maps a chat id to its sandbox scope. */
  agentToolsLauncher(resolve: (chatId: string) => Promise<ScopedComputerRef>): Promise<string>;
  /** SBX-11: registers and starts (or stops and removes) the headless browser service inside the scope's container. */
  browserService?(scope: ScopedComputerRef, enabled: boolean): Promise<{state: string; reason?: string}>;
  browserServiceStatus?(scope: ScopedComputerRef): Promise<{state: string; reason?: string}>;
}

/**
 * Main constructs ScopedComputers; the runtime's sandbox domain lives in a separately bundled module of the same
 * process, so the instance is handed over through a process-global slot instead of a module singleton.
 */
const SLOT = Symbol.for('muster.scopedComputers');
export function registerAgentSandboxHost(host: AgentSandboxHost | undefined): void { (globalThis as Record<symbol, unknown>)[SLOT] = host; }
export function currentAgentSandboxHost(): AgentSandboxHost | undefined { return (globalThis as Record<symbol, unknown>)[SLOT] as AgentSandboxHost | undefined; }
