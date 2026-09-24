/**
 * Plain-language errors for the resource pane. IPC failures arrive as
 * "git.changes: Error invoking remote method 'muster:invoke': Error: …";
 * nothing in the pane may show that wrapper to a person.
 */
/** Namespaces of the runtime's IPC command names (`git.status`, `files.read`, `memory.import.apply`…).
 *  Only a prefix in one of these is a command label to peel; `package.json: Unexpected token` is a file
 *  name and part of the message. Keep in step with src/main/commands.ts (tests/resource-errors checks). */
export const COMMAND_NAMESPACES: ReadonlySet<string> = new Set([
  'app', 'approval', 'artifacts', 'attachments', 'automations', 'browser', 'chat', 'ci', 'clipboard', 'computer', 'extensions', 'files', 'folder',
  'git', 'github', 'goals', 'hindsight', 'import', 'link', 'mailbox', 'mcp', 'memory', 'models', 'plugins', 'processes', 'project', 'providers', 'question',
  'review', 'sandbox', 'settings', 'setup', 'skills', 'stashes', 'subagents', 'terminal', 'terminalAccess', 'workspace',
]);
const COMMAND_PREFIX = /^([a-z][a-zA-Z]*)(?:\.[a-zA-Z][\w-]*)+:\s*/;

export function cleanIpcError(error: unknown): string {
  let text = (error instanceof Error ? error.message : String(error ?? '')).trim();
  // Peel wrappers until none match: command prefix, Electron's remote-method wrapper, Error/BridgeError tags.
  for (let pass = 0; pass < 4; pass++) {
    const next = text
      .replace(COMMAND_PREFIX, (prefix, namespace: string) => COMMAND_NAMESPACES.has(namespace) ? '' : prefix)
      .replace(/^Error invoking remote method '[^']*':\s*/i, '')
      .replace(/^(?:Bridge|Type|Range)?Error:\s*/i, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

/** True when a Git read failed only because the folder is not a repository. */
export function isNotGitRepository(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return /not a git repository/i.test(text);
}

/** A calm one-line message for a failed Git read, or undefined when the folder simply has no repository. */
export function gitErrorMessage(error: unknown): string | undefined {
  if (isNotGitRepository(error)) return undefined;
  const text = cleanIpcError(error);
  if (/ENOENT|no such file|cannot find the path/i.test(text)) return 'This folder is no longer available.';
  if (/spawn git|git: command not found|git not found/i.test(text)) return 'Git is not installed, so changes cannot be read.';
  return text ? `Changes could not be read. ${text.replace(/\s+/g, ' ').slice(0, 160)}` : 'Changes could not be read.';
}
