/** #721: writes the stdio launcher of Muster's own computer-use MCP server (muster_computer). It runs Electron as Node on
 *  computer-mcp.cjs and hands it the native helper's path; macOS only, and only when the helper was built and shipped. */
import fs from 'node:fs';
import path from 'node:path';
import {launcherFile, nodeLauncherScript} from '../../runtime/launcher-script.ts';

export const COMPUTER_MCP_LAUNCHER_ENV = 'MUSTER_COMPUTER_MCP_LAUNCHER';

export function writeComputerLauncher(options: {dir: string; execPath: string; script: string; helper: string; platform?: NodeJS.Platform}): string | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' || !fs.existsSync(options.helper) || !fs.existsSync(options.script)) return undefined;
  fs.mkdirSync(options.dir, {recursive: true, mode: 0o700});
  const launcher = launcherFile(path.join(options.dir, 'muster-computer-mcp'), platform);
  fs.writeFileSync(launcher, nodeLauncherScript(options.execPath, options.script, options.helper, platform), {mode: 0o700});
  fs.chmodSync(launcher, 0o700);
  return launcher;
}
