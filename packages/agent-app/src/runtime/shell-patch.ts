import {isAbsolute, join} from 'node:path';
import {parseApplyPatch} from './conversation-import.ts';

type Change = ReturnType<typeof parseApplyPatch>[number];

/** The script a `/bin/zsh -lc "…"` (or bash/sh) wrapper runs, with its double-quote escapes undone. */
function innerScript(command: string): string {
  const wrapped = /^\S*\/(?:zsh|bash|sh)\s+-l?c\s+"([\s\S]*)"\s*$/.exec(command.trim());
  if (wrapped) return wrapped[1]!.replace(/\\(["\\$`])/g, '$1');
  const single = /^\S*\/(?:zsh|bash|sh)\s+-l?c\s+'([\s\S]*)'\s*$/.exec(command.trim());
  return single ? single[1]!.replace(/'\\''/g, "'") : command;
}

/** Patches a script hands to `apply_patch`, as a heredoc or a quoted argument. Printed patches (`cat <<EOF`) are ignored. */
function patchesIn(script: string): string[] {
  const patches: string[] = [];
  const heredoc = /\bapply_patch\s*<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?:\n|$)/g;
  for (const match of script.matchAll(heredoc)) patches.push(match[3]!);
  if (!patches.length) {
    const argument = /\bapply_patch\s+(['"])(\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch\s*)\1/g;
    for (const match of script.matchAll(argument)) patches.push(match[2]!);
  }
  return patches;
}

/**
 * The file changes a successful shell `apply_patch` made, in app-server `changes` shape, or none.
 * Models without the native patch tool run it through the shell; without this the edit shows as a
 * plain command, with no inline diff and no files-changed pill.
 */
export function shellPatchChanges(item: Record<string, unknown>): Change[] {
  if (item.type !== 'commandExecution' || (typeof item.exitCode === 'number' && item.exitCode !== 0)) return [];
  const output = String(item.aggregatedOutput ?? item.output ?? '');
  if (!/Success\. Updated the following files/.test(output)) return [];
  const scripts = Array.isArray(item.commandActions) ? item.commandActions.map(action => action && typeof action === 'object' ? String((action as {command?: unknown}).command ?? '') : '').filter(Boolean) : [];
  if (typeof item.command === 'string') scripts.push(innerScript(item.command));
  const cwd = typeof item.cwd === 'string' ? item.cwd : '';
  for (const script of scripts) {
    const changes = patchesIn(script).flatMap(parseApplyPatch);
    if (!changes.length) continue;
    const resolve = (path: string) => cwd && !isAbsolute(path) ? join(cwd, path) : path;
    return changes.map(change => ({...change, path: resolve(change.path), kind: change.kind.move_path ? {...change.kind, move_path: resolve(change.kind.move_path)} : change.kind}));
  }
  return [];
}
