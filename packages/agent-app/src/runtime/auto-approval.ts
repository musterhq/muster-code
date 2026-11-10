/**
 * #841: Auto access. Decides whether a provider's approval request is routine enough to settle itself.
 *
 * Settled: reads anywhere the chat may read; edits whose every path stays inside the chat's folder; commands whose every
 * part is on the well-known safe list (or the person's allowlist, setting `approvals.autoAllow`). Everything else returns
 * null and gets the usual card: installs, pushes, sudo, deletes or writes outside the folder, redirects, substitutions.
 * Project tool rules and the user-process guard run before this and always win.
 */
import {existsSync, realpathSync} from 'node:fs';
import {basename, dirname, isAbsolute, relative, resolve} from 'node:path';
import {homedir} from 'node:os';

export interface AutoApproval { rule: string }
export interface AutoContext { cwd: string; allowlist?: readonly string[] }

/** Commands that only read or report. `find` and `sed` are checked for their writing flags separately. */
const READ_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'rg', 'grep', 'egrep', 'fgrep', 'tree', 'file', 'stat', 'du', 'df', 'which', 'type', 'diff', 'cmp', 'uniq', 'cut', 'tr', 'jq', 'true', 'false', 'date', 'whoami', 'uname', 'basename', 'dirname', 'realpath', 'readlink', 'nl', 'column', 'md5', 'shasum', 'sha256sum', 'cd', 'test', '[']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'cat-file', 'merge-base', 'reflog', 'ls-tree', 'whatchanged']);
const TEST_RUNNERS = new Set(['pytest', 'vitest', 'jest', 'mocha', 'tsc', 'eslint', 'prettier', 'ruff', 'mypy', 'rspec']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Script names that run the person's own project checks; anything that installs or publishes is never one of them. */
const SCRIPT_SHORTHAND = new Set(['test', 't', 'lint', 'typecheck', 'build', 'check', 'format', 'fmt']);
const NOT_A_SCRIPT = /install|publish|deploy|release|^(?:add|remove|rm|up|update|upgrade|dlx|exec|x|link|unlink|prune|rebuild|import|patch|setup|env|self-update|store|ci|i|global)$/i;
/** Claude Code's own tools that only read. */
const CLAUDE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite', 'TodoRead']);

/** The script inside a `bash -lc '…'` wrapper (Codex sends a command as an argv), else the joined command. */
export function commandText(command: unknown): string {
  if (typeof command === 'string') return command.trim();
  if (!Array.isArray(command) || !command.every(part => typeof part === 'string')) return '';
  const parts = command as string[];
  if (parts.length === 3 && /(?:^|\/)(?:ba|z|da)?sh$/.test(parts[0]!) && /^-l?c$/.test(parts[1]!)) return parts[2]!.trim();
  return parts.join(' ').trim();
}

/** Splits on `&&`, `||`, `;`, `|` and newlines. Returns null when the command uses anything that could write or run hidden
 *  code: redirects to a file, `$(…)`, backticks, process substitution, background `&`, or an unclosed quote. */
function segments(script: string): string[][] | null {
  const out: string[][] = [];
  let words: string[] = [], word = '', quote: '"' | "'" | null = null, quoted = false;
  const endWord = () => { if (word || quoted) words.push(word); word = ''; quoted = false; };
  const endSegment = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!, next = script[i + 1];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (quote === '"' && (c === '`' || (c === '$' && next === '('))) return null;
      if (quote === '"' && c === '\\' && next !== undefined) { word += next; i++; continue; }
      word += c; continue;
    }
    if (c === "'" || c === '"') { quote = c; quoted = true; continue; }
    if (c === '\\' && next !== undefined) { if (next === '\n') { i++; continue; } word += next; i++; continue; }
    if (c === '`' || (c === '$' && next === '(') || ((c === '<' || c === '>') && next === '(')) return null;
    if (c === '>') {
      // Only harmless redirects: stderr to stdout, or either to /dev/null.
      const rest = script.slice(i);
      const safe = /^>&[12]\b/.exec(rest) ?? /^>>?\s*\/dev\/null\b/.exec(rest);
      if (!safe || !/^(?:|[12]|&)$/.test(word)) return null;
      word = ''; i += safe[0].length - 1; continue;
    }
    if (c === '<') return null;
    if (c === '&' && next === '&') { endSegment(); i++; continue; }
    if (c === '&') return null;
    if (c === '|') { endSegment(); if (next === '|') i++; continue; }
    if (c === ';' || c === '\n') { endSegment(); continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    word += c;
  }
  if (quote) return null;
  endSegment();
  return out;
}

const program = (word: string) => word.replace(/^.*\//, '');

/** Why one part of a command is safe, or null. */
function safeSegment(words: string[]): string | null {
  let rest = words;
  while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!)) rest = rest.slice(1);
  if (!rest.length) return null;
  const name = program(rest[0]!), args = rest.slice(1);
  if (READ_COMMANDS.has(name)) return name;
  if (name === 'sort') return args.some(arg => arg === '-o' || arg.startsWith('--output')) ? null : name;
  if (name === 'sed') return args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place')) ? null : name;
  if (name === 'find') return args.some(arg => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg)) ? null : name;
  if (name === 'git') {
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
    const sub = args[i], subArgs = args.slice(i + 1);
    if (sub && GIT_READ.has(sub)) return `git ${sub}`;
    if (sub === 'branch' && subArgs.every(arg => /^(?:-a|-r|-v|-vv|--list|--all|--remotes|--show-current|--contains|--merged|--no-merged)$/.test(arg))) return 'git branch';
    if (sub === 'remote' && subArgs.every(arg => arg === '-v' || arg === '--verbose')) return 'git remote';
    if (sub === 'stash' && subArgs[0] === 'list') return 'git stash list';
    return null;
  }
  if (TEST_RUNNERS.has(name)) return name;
  if (name === 'node' && args.includes('--test')) return 'node --test';
  if ((name === 'python' || name === 'python3') && args[0] === '-m' && (args[1] === 'pytest' || args[1] === 'unittest')) return `${name} -m ${args[1]}`;
  if ((name === 'go' || name === 'cargo') && (args[0] === 'test' || args[0] === 'vet' || args[0] === 'check' || args[0] === 'build')) return `${name} ${args[0]}`;
  if (name === 'make' && args.length === 1 && (args[0] === 'test' || args[0] === 'check' || args[0] === 'lint')) return `make ${args[0]}`;
  if (PACKAGE_MANAGERS.has(name)) {
    const positional = args.filter(arg => !arg.startsWith('-'));
    const [first, second] = positional;
    if (!first) return null;
    if ((first === 'run' || first === 'run-script') && second && !NOT_A_SCRIPT.test(second)) return `${name} run`;
    if (SCRIPT_SHORTHAND.has(first)) return `${name} ${first}`;
    if (name === 'bun' && first === 'test') return 'bun test';
    return null;
  }
  return null;
}

function allowlisted(words: string[], allowlist: readonly string[]): string | null {
  const text = words.join(' ');
  for (const entry of allowlist) {
    const prefix = entry.trim().replace(/\s+/g, ' ');
    if (prefix && (text === prefix || text.startsWith(`${prefix} `))) return prefix;
  }
  return null;
}

/** A command whose every part is safe or on the allowlist. */
export function autoApproveCommand(command: unknown, allowlist: readonly string[] = []): AutoApproval | null {
  const script = commandText(command);
  if (!script || script.length > 8192) return null;
  const parts = segments(script);
  if (!parts?.length) return null;
  const safe: string[] = [], listed: string[] = [];
  for (const words of parts) {
    const listedBy = allowlisted(words, allowlist);
    if (listedBy) { listed.push(listedBy); continue; }
    const reason = safeSegment(words);
    if (!reason) return null;
    safe.push(reason);
  }
  if (listed.length) return {rule: `On your allowlist (${[...new Set(listed)].join(', ')})`};
  return {rule: `Safe command (${[...new Set(safe)].join(', ')})`};
}

/** The real path of `path`, following links on its nearest existing ancestor (a new file's folder may not exist yet). */
function realish(path: string): string {
  let current = path;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(basename(current)); current = parent;
  }
  try { return resolve(realpathSync(current), ...tail); } catch { return path; }
}
export function insideFolder(path: string, cwd: string): boolean {
  if (!path || !cwd) return false;
  const expanded = path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
  const target = realish(resolve(cwd, expanded)), root = realish(resolve(cwd));
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Paths of a file change, from an array of `{path}` or a map keyed by path. Null when any entry has no path. */
function changePaths(changes: unknown): string[] | null {
  if (Array.isArray(changes)) {
    const paths = changes.map(change => change && typeof change === 'object' && typeof (change as Record<string, unknown>).path === 'string' ? String((change as Record<string, unknown>).path) : '');
    return paths.length && paths.every(Boolean) ? paths : null;
  }
  if (changes && typeof changes === 'object') { const keys = Object.keys(changes); return keys.length ? keys : null; }
  return null;
}

/** The decision for one approval request in Auto access, or null to show the card. */
export function autoApprove(method: string, params: Record<string, unknown>, changes: unknown, context: AutoContext): AutoApproval | null {
  if (method === 'item/commandExecution/requestApproval') return autoApproveCommand(params.command, context.allowlist);
  if (method === 'item/fileChange/requestApproval') {
    // A request to write beyond the sandbox's roots is never routine.
    if (params.grantRoot !== undefined && params.grantRoot !== null) return null;
    const paths = changePaths(changes);
    return paths && paths.every(path => insideFolder(path, context.cwd)) ? {rule: "Edit inside the chat's folder"} : null;
  }
  if (method === 'item/mcpToolCall/requestApproval') {
    const server = params.server ?? params.serverName, tool = params.tool ?? params.toolName;
    return server === 'Claude Code' && typeof tool === 'string' && CLAUDE_READ_TOOLS.has(tool) ? {rule: `Read (${tool})`} : null;
  }
  return null;
}
