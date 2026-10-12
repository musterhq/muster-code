/** Routes whose own tools can spawn sub-agents (Codex app-server, Claude Code). HTTP and other CLI routes cannot. */
export const canSpawnSubagents = (driver: string | undefined): boolean => driver === 'codex-app-server' || driver === 'claude-code-cli';
