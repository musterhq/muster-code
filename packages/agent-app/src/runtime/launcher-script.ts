/** Launchers Muster hands to Codex and Claude Code as an MCP server `command` (config overrides carry only scalars, so
 *  the command must be one runnable file). macOS/Linux: a `#!/bin/sh` script. Windows cannot execute a shebang
 *  script or an extensionless file, so it gets a `.cmd` batch file that runs the same command line. */
export type LauncherPlatform = NodeJS.Platform;

const posixQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** cmd.exe quoting: paths cannot contain `"`; `%` is doubled so a path like `C:\100%\x` is not expanded. */
const cmdQuote = (value: string) => `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`;

/** The launcher's file name for a platform: unchanged on macOS/Linux, `.cmd` appended on Windows. */
export const launcherFile = (base: string, platform: LauncherPlatform = process.platform) => platform === 'win32' ? `${base}.cmd` : base;

/** Runs `execPath script endpoint` with ELECTRON_RUN_AS_NODE=1, i.e. Electron itself as Node. */
export function nodeLauncherScript(execPath: string, script: string, endpoint: string, platform: LauncherPlatform = process.platform): string {
  if (platform === 'win32') return `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n${cmdQuote(execPath)} ${cmdQuote(script)} ${cmdQuote(endpoint)}\r\n`;
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${posixQuote(execPath)} ${posixQuote(script)} ${posixQuote(endpoint)}\n`;
}

/** A user's stdio MCP server that has arguments: `exec command args... "$@"`. */
export function commandLauncherScript(argv: readonly string[], platform: LauncherPlatform = process.platform): string {
  if (platform === 'win32') return `@echo off\r\n${argv.map(cmdQuote).join(' ')} %*\r\n`;
  return `#!/bin/sh\nexec ${argv.map(posixQuote).join(' ')} "$@"\n`;
}

/** The MCP server spec for a launcher. Node-based clients (Claude Code) cannot spawn a `.cmd` directly, so on Windows it runs through cmd.exe. */
export function launcherSpec(command: string, platform: LauncherPlatform = process.platform, comspec: string = process.env.ComSpec || 'cmd.exe'): {command: string; args?: string[]} {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) return {command: comspec, args: ['/d', '/c', command]};
  return {command};
}
