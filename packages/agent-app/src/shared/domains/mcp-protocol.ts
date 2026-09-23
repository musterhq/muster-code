/** Mcp domain contract: user-added MCP servers (stdio and Streamable HTTP), handshake tests, tool inspection, health, revocation and plugin hook review. */
export type McpTransport = 'stdio' | 'http';
export type McpScope = 'user' | 'folder' | 'project';
/** `env` delivers the token to a stdio server as that environment variable; `bearer` sends it as an Authorization header. Tokens live in the secret store only. */
export type McpAuthInput = { kind: 'none' } | { kind: 'bearer'; token?: string } | { kind: 'env'; name: string; token?: string };
export interface McpServerInput {
  name: string; transport: McpTransport; command?: string; args?: string[]; env?: Record<string, string>; url?: string;
  /** Omitted `token` keeps the stored one. */
  auth?: McpAuthInput; scope?: McpScope; scopeId?: string; enabled?: boolean;
}
export type McpStage = 'spawn' | 'initialize' | 'tools';
export interface McpTool { name: string; title?: string; description?: string; inputSchema: unknown }
export interface McpServerInfo { name: string; version?: string; protocolVersion?: string }
export interface McpTestResult { stage: McpStage; ok: boolean; error?: string; tools?: McpTool[]; latencyMs: number; serverInfo?: McpServerInfo }
/** Health drives the run config: a server whose last test failed is passed to the provider disabled until a test succeeds. */
export interface McpHealth { lastTestAt?: string; ok?: boolean; stage?: McpStage; error?: string; latencyMs?: number; consecutiveFailures: number; toolCount?: number; serverInfo?: McpServerInfo }
/** Where a server's config came from: typed in by the user, or found in an existing Codex/Claude config on disk. */
export type McpSource = 'user' | 'codex' | 'claude';
export interface McpServer {
  id: string; name: string; transport: McpTransport; command?: string; args: string[]; env: Record<string, string>; url?: string;
  auth: { kind: 'none' } | { kind: 'bearer'; stored: boolean } | { kind: 'env'; name: string; stored: boolean };
  scope: McpScope; scopeId: string; enabled: boolean; createdAt: string; updatedAt: string; health: McpHealth;
  /** The key under `mcp_servers.` the provider sees (prefixed when it collides with a plugin server). */
  configKey: string; healthy: boolean;
  /** Running chats whose current turn loaded this server. */
  loadedBy: Array<{ chatId: string; title: string }>;
  /** Absent (or 'user') for a server the user added by hand; 'codex'/'claude' for one detected from that tool's own config,
   * whose `command`/`url`/`args`/`env` values below are masked (only the enable toggle and Test/Tools/Logs are user-controlled). */
  source?: McpSource;
}
export interface McpLogLine { at: string; stream: 'stdout' | 'stderr' | 'client' | 'hook'; text: string }
export interface McpRevokeResult { server: McpServer; chats: Array<{ chatId: string; title: string }>; stopped: string[] }
/** Events Muster has a lifecycle point for. Others are listed for review and cannot be enabled. */
export const MCP_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'] as const;
export interface McpHookRun { at: string; exitCode: number | null; durationMs: number; timedOut: boolean; truncated: boolean; output: string }
export interface McpHook {
  /** Stable for one exact command: an updated command needs a fresh enable. */
  id: string; extensionId: string; extensionName: string; event: string; matcher?: string; type: string; command: string;
  supported: boolean; reason?: string; enabled: boolean; timeoutSec: number; maxOutputKb: number; lastRun?: McpHookRun;
}
export const MCP_HOOK_LIMITS = { timeoutSec: { min: 1, max: 60, default: 10 }, maxOutputKb: { min: 1, max: 256, default: 16 } } as const;

export interface McpCommands {
  'mcp.servers.list': { input: undefined; output: McpServer[] };
  /** Re-reads Codex's config.toml and any Claude mcpServers config (~/.claude.json, each open folder's .mcp.json), upserts
   * them as read-only "Detected" servers (existing ones keep their enable toggle and health), then returns the full list. */
  'mcp.servers.detect': { input: undefined; output: McpServer[] };
  'mcp.servers.add': { input: McpServerInput; output: McpServer };
  'mcp.servers.update': { input: Partial<McpServerInput> & { id: string }; output: McpServer };
  'mcp.servers.remove': { input: { id: string }; output: void };
  /** Spawn or connect, `initialize`, then `tools/list`, within 10 seconds. The result updates health. */
  'mcp.servers.test': { input: { id: string }; output: McpTestResult };
  /** Tools from the last successful test; `refresh` runs a test first. */
  'mcp.servers.tools': { input: { id: string; refresh?: boolean }; output: McpTool[] };
  'mcp.servers.logs': { input: { id: string }; output: McpLogLine[] };
  /** Disables the server and lists running chats that loaded it; `stopChats` also stops them. */
  'mcp.revoke': { input: { id: string; stopChats?: boolean }; output: McpRevokeResult };
  'mcp.hooks.list': { input: undefined; output: McpHook[] };
  'mcp.hooks.set': { input: { id: string; enabled?: boolean; timeoutSec?: number; maxOutputKb?: number }; output: McpHook[] };
}
export type McpEvent = never;
export const MCP_COMMANDS = {
  'mcp.servers.list': true, 'mcp.servers.detect': true, 'mcp.servers.add': true, 'mcp.servers.update': true, 'mcp.servers.remove': true, 'mcp.servers.test': true,
  'mcp.servers.tools': true, 'mcp.servers.logs': true, 'mcp.revoke': true, 'mcp.hooks.list': true, 'mcp.hooks.set': true,
} as const satisfies Record<keyof McpCommands, true>;
