/**
 * #652: which model routes can run a chat in the sandbox. Only the `muster_sandbox` MCP tools (sandbox_exec, sandbox_read,
 * sandbox_write, sandbox_list) run in the container, so a route can be sandboxed only when it receives those tools and
 * Muster can deny its own host shell and edit tools (#653). Codex, Claude Code, OpenCode and Grok load Muster's MCP
 * servers; the HTTP, Gemini and Cursor routes never read them.
 */
export const SANDBOX_MCP_SERVER = 'muster_sandbox';
export const SANDBOX_TOOLS = ['sandbox_exec', 'sandbox_read', 'sandbox_write', 'sandbox_list'] as const;
/** Shown wherever the Sandbox environment is unavailable because of the chat's model. */
export const SANDBOX_ROUTE_UNSUPPORTED = 'This model’s tools can’t run in the sandbox yet';

/** True when a route with this driver receives the sandbox tools and has its host exec and write tools denied. */
export function sandboxToolsReach(driver: string | undefined): boolean {
  switch (driver) {
    case undefined: case 'codex-app-server': case 'claude-code-cli': case 'opencode-cli': case 'grok-acp': return true;
    default: return false;
  }
}

/** Renderer helper: an unknown provider (not listed yet) is not refused; the runtime still keeps such a run read-only. */
export function sandboxRouteSupported(providers: readonly {id: string; driver?: string}[] | undefined, providerId: string | undefined | null): boolean {
  if (!providerId) return true;
  const provider = providers?.find(entry => entry.id === providerId);
  return !provider || sandboxToolsReach(provider.driver);
}
