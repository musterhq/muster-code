/**
 * #841: Auto access. Decides whether a provider's approval request is routine enough to settle itself.
 *
 * Settled: reads anywhere the chat may read; edits whose every path stays inside the chat's folder; commands whose every
 * part is on the well-known safe list (or the person's allowlist, setting `approvals.autoAllow`). Everything else returns
 * null and gets the usual card: installs, pushes, sudo, deletes or writes outside the folder, redirects, substitutions.
 * Commands that run the project's own code (tests, package scripts, linters, builds) settle only on routes that run inside
 * Muster's workspace sandbox (Codex); elsewhere they ask unless they are on the allowlist.
 * Project tool rules and the user-process guard run before this and always win.
 */
import {existsSync, realpathSync} from 'node:fs';
import {basename, dirname, isAbsolute, relative, resolve} from 'node:path';
import {homedir} from 'node:os';

export interface AutoApproval { rule: string }
export interface AutoContext {
  cwd: string; allowlist?: readonly string[];
  /** The route runs commands inside Muster's workspace sandbox (Codex). Only then do commands that run the project's own code
   *  (tests, package scripts, linters, builds) settle; without it they could run anything an earlier edit put in the folder. */
  sandboxed: boolean;
}

/** Commands that only read or report, with no option that runs a program or writes a file. Commands with such options are
 *  checked separately below (rg, sed, sort, find, tree, uniq, file, cd, git). */
const READ_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'grep', 'egrep', 'fgrep', 'stat', 'du', 'df', 'which', 'type', 'diff', 'cmp', 'cut', 'tr', 'jq', 'true', 'false', 'date', 'whoami', 'uname', 'basename', 'dirname', 'realpath', 'readlink', 'nl', 'column', 'md5', 'shasum', 'sha256sum', 'test', '[']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'cat-file', 'merge-base', 'reflog', 'ls-tree', 'whatchanged']);
/** git options that run a program, write a file or open a pager. */
const GIT_UNSAFE_OPTION = /^(?:--output(?:=|$)|--ext-diff$|--textconv$|--filters$|--open-files-in-pager(?:=|$)|-O)/;
/** Test runners that run the project's code; settled only inside the sandbox. */
const TEST_RUNNERS = new Set(['pytest', 'vitest', 'jest', 'mocha', 'rspec', 'mypy']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Script names that run the person's own project checks; anything that installs or publishes is never one of them. */
const SCRIPT_SHORTHAND = new Set(['test', 't', 'lint', 'typecheck', 'build', 'check']);
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

/** sed: only -n/-E/-r/-s/-u/-z and -e, and every script made of commands that neither write (w, W, the s///w flag) nor
 *  execute (e, the s///e flag). Anything not understood asks. */
function safeSed(args: string[]): boolean {
  const scripts: string[] = [], files: string[] = [];
  let explicit = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-e' || arg === '--expression') { const next = args[++i]; if (next === undefined) return false; scripts.push(next); explicit = true; continue; }
    if (arg.startsWith('--expression=')) { scripts.push(arg.slice(13)); explicit = true; continue; }
    if (/^-[nErsuz]+$/.test(arg) || arg === '--quiet' || arg === '--silent' || arg === '--regexp-extended' || arg === '--separate' || arg === '--unbuffered' || arg === '--null-data' || arg === '--posix') continue;
    if (arg.startsWith('-') && arg !== '-') return false;
    files.push(arg);
  }
  if (!explicit) { const first = files.shift(); if (first === undefined) return false; scripts.push(first); }
  return scripts.every(safeSedScript);
}
function safeSedScript(script: string): boolean {
  let i = 0;
  const at = () => script[i];
  const skipBlank = () => { while (i < script.length && /[\s;]/.test(script[i]!)) i++; };
  const regex = (): boolean => { // at a delimiter: skip to its closing twin
    const d = script[i++]; if (!d || d === '\n' || d === '\\') return false;
    while (i < script.length && script[i] !== d) { if (script[i] === '\\') i++; if (script[i] === '\n') return false; i++; }
    if (i >= script.length) return false; i++; return true;
  };
  const address = (): boolean => {
    if (/[0-9]/.test(at() ?? '')) { while (/[0-9~]/.test(at() ?? '')) i++; return true; }
    if (at() === '$') { i++; return true; }
    if (at() === '/') return regex();
    if (at() === '\\') { i++; return regex(); }
    return true;
  };
  while (i < script.length) {
    skipBlank(); if (i >= script.length) break;
    if (!address()) return false;
    if (at() === ',') { i++; if (at() === '+' || at() === '~') i++; if (!address()) return false; }
    while (at() === ' ' || at() === '!') i++;
    const command = script[i++];
    if (command === undefined) return false;
    if (command === '{' || command === '}') continue;
    if ('pdqQnNlPDhHgGx='.includes(command)) { while (/[0-9]/.test(at() ?? '')) i++; continue; }
    if (command === ':' || command === 'b' || command === 't' || command === 'T') { while (i < script.length && !/[;\n}]/.test(script[i]!)) i++; continue; }
    if (command === 'y') { if (!regex()) return false; i--; if (!regex()) return false; continue; }
    if (command === 's') {
      const d = at(); if (!regex()) return false; i--; if (script[i] !== d || !regex()) return false;
      const flags = /^[gpiImM0-9]*/.exec(script.slice(i))![0]; i += flags.length;
      if (i < script.length && !/[\s;}]/.test(script[i]!)) return false; // w, e or anything unknown
      continue;
    }
    return false; // w, W, e, r, R, a, i, c, F, z and anything unknown
  }
  return true;
}

/** Why one part of a command is safe, or null. `runsProjectCode` marks commands that run code from the folder. */
function safeSegment(words: string[], context: AutoContext): {reason: string; runsProjectCode?: true} | null {
  // Any NAME=value prefix asks: GIT_EXTERNAL_DIFF, GIT_PAGER, DYLD_INSERT_LIBRARIES, LD_PRELOAD and friends run programs.
  if (!words.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return null;
  const name = program(words[0]!), args = words.slice(1);
  const inside = (path: string | undefined) => path !== undefined && insideFolder(path, context.cwd);
  const has = (pattern: RegExp) => args.some(arg => pattern.test(arg));
  if (READ_COMMANDS.has(name)) return {reason: name};
  if (name === 'cd') return args.length === 0 || (args.length === 1 && inside(args[0])) ? {reason: 'cd'} : null;
  if (name === 'rg') return has(/^--pre(?:-glob)?(?:=|$)/) ? null : {reason: 'rg'};
  if (name === 'sort') return has(/^(?:-o|--output|--compress-program)/) ? null : {reason: 'sort'};
  if (name === 'tree') return has(/^(?:-o|--output)/) ? null : {reason: 'tree'};
  if (name === 'uniq') return args.filter(arg => !arg.startsWith('-')).length > 1 ? null : {reason: 'uniq'};
  if (name === 'file') return has(/^-[a-zA-Z]*C|^--compile/) ? null : {reason: 'file'};
  if (name === 'sed') return safeSed(args) ? {reason: 'sed'} : null;
  if (name === 'find') return has(/^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/) ? null : {reason: 'find'};
  if (name === 'git') {
    // Global options: only -C into the chat's folder, and the pager switches. -c, --config-env, --exec-path, --git-dir and
    // --work-tree (and anything else) ask.
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-')) {
      const option = args[i]!;
      if (option === '-C') { if (!inside(args[i + 1])) return null; i += 2; continue; }
      if (option === '--no-pager' || option === '-P' || option === '--no-optional-locks' || option === '--literal-pathspecs') { i++; continue; }
      return null;
    }
    const sub = args[i], subArgs = args.slice(i + 1);
    if (subArgs.some(arg => GIT_UNSAFE_OPTION.test(arg))) return null;
    if (sub && GIT_READ.has(sub)) return {reason: `git ${sub}`};
    if (sub === 'branch' && subArgs.every(arg => /^(?:-a|-r|-v|-vv|--list|--all|--remotes|--show-current|--contains|--merged|--no-merged)$/.test(arg))) return {reason: 'git branch'};
    if (sub === 'remote' && subArgs.every(arg => arg === '-v' || arg === '--verbose')) return {reason: 'git remote'};
    if (sub === 'stash' && subArgs[0] === 'list' && subArgs.length === 1) return {reason: 'git stash list'};
    return null;
  }
  // Everything below runs the project's own code or tools configured by it (test files, package scripts, eslint and
  // prettier configs are code); the caller settles these only inside the sandbox.
  const project = (reason: string) => ({reason, runsProjectCode: true as const});
  if (name === 'tsc') return args.includes('--noEmit') ? project('tsc --noEmit') : null;
  if (name === 'eslint') return has(/^(?:--fix|-o$|--output-file)/) ? null : project('eslint');
  if (name === 'prettier') return has(/^(?:--write|-w$)/) || !has(/^(?:--check|-c|--list-different|-l)$/) ? null : project('prettier --check');
  if (name === 'ruff') return args[0] === 'check' && !has(/^--fix|^--output-file|^-o$/) ? project('ruff check') : null;
  if (TEST_RUNNERS.has(name)) return project(name);
  if (name === 'node' && args.includes('--test')) return project('node --test');
  if ((name === 'python' || name === 'python3') && args[0] === '-m' && (args[1] === 'pytest' || args[1] === 'unittest')) return project(`${name} -m ${args[1]}`);
  if ((name === 'go' || name === 'cargo') && (args[0] === 'test' || args[0] === 'vet' || args[0] === 'check' || args[0] === 'build')) return project(`${name} ${args[0]}`);
  if (name === 'make' && args.length === 1 && (args[0] === 'test' || args[0] === 'check' || args[0] === 'lint')) return project(`make ${args[0]}`);
  if (PACKAGE_MANAGERS.has(name)) {
    const positional = args.filter(arg => !arg.startsWith('-'));
    const [first, second] = positional;
    if (!first) return null;
    if ((first === 'run' || first === 'run-script') && second && !NOT_A_SCRIPT.test(second)) return project(`${name} run`);
    if (SCRIPT_SHORTHAND.has(first)) return project(`${name} ${first}`);
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
export function autoApproveCommand(command: unknown, context: AutoContext): AutoApproval | null {
  const script = commandText(command);
  if (!script || script.length > 8192) return null;
  const parts = segments(script);
  if (!parts?.length) return null;
  const safe: string[] = [], listed: string[] = [];
  for (const words of parts) {
    const listedBy = allowlisted(words, context.allowlist ?? []);
    if (listedBy) { listed.push(listedBy); continue; }
    const verdict = safeSegment(words, context);
    if (!verdict || (verdict.runsProjectCode && !context.sandboxed)) return null;
    safe.push(verdict.reason);
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

function gitInternal(path: string, cwd: string): boolean {
  const target = realish(resolve(cwd, path)), root = realish(resolve(cwd));
  return relative(root, target).split(/[\\/]/).some(part => part.toLowerCase() === '.git');
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
  if (method === 'item/commandExecution/requestApproval') return autoApproveCommand(params.command, context);
  if (method === 'item/fileChange/requestApproval') {
    // A request to write beyond the sandbox's roots is never routine.
    if (params.grantRoot !== undefined && params.grantRoot !== null) return null;
    const paths = changePaths(changes);
    // An edit inside .git (config, hooks) could make a later git command run a program: it asks.
    return paths && paths.every(path => insideFolder(path, context.cwd) && !gitInternal(path, context.cwd)) ? {rule: "Edit inside the chat's folder"} : null;
  }
  if (method === 'item/mcpToolCall/requestApproval') {
    const server = params.server ?? params.serverName, tool = params.tool ?? params.toolName;
    return server === 'Claude Code' && typeof tool === 'string' && CLAUDE_READ_TOOLS.has(tool) ? {rule: `Read (${tool})`} : null;
  }
  return null;
}
