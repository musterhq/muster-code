/**
 * R5: runtime protection of user-owned processes. The prompt already tells the agent never to stop the
 * user's dev servers or shells; this checker enforces it. It reads an agent command (argv or shell text),
 * finds the processes it would signal (kill/pkill/killall, `kill $(lsof -t -i:PORT)`, `lsof -ti:PORT | xargs kill`,
 * `fuser -k PORT/tcp`, `npx kill-port PORT`) and resolves them against the user's live process groups.
 * Pure: no process or filesystem access. Unresolvable targets (e.g. `kill $(cat app.pid)`) are not flagged.
 */

/** A live user-owned process group, optionally enriched with its member PIDs, listening ports and process names. */
export interface UserProcessTarget {
  pgid: number;
  label: string;
  cwd?: string;
  /** Member/listener PIDs (the group leader's PID is `pgid`). */
  pids?: readonly number[];
  /** Other process groups spawned under it (e.g. a terminal's foreground job). */
  pgids?: readonly number[];
  ports?: readonly number[];
  /** Process names (`comm` basenames) running in the group. */
  names?: readonly string[];
}
export interface KillPattern { pattern: string; full: boolean; exact: boolean }
export interface KillIntent { pids: number[]; pgids: number[]; ports: number[]; patterns: KillPattern[]; all: boolean }
export interface UserProcessThreat { groups: UserProcessTarget[]; ports: number[]; message: string }

interface Word { text: string; subs: string[] }
type Pipeline = Word[][];

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'nice', 'builtin', 'doas']);
const MAX_DEPTH = 4;

const base = (value: string) => value.slice(value.lastIndexOf('/') + 1);
const intOf = (value: string) => /^\d{1,7}$/.test(value) ? Number(value) : undefined;
const port = (value: string | undefined) => { const n = value === undefined ? undefined : intOf(value); return n !== undefined && n > 0 && n < 65536 ? n : undefined; };

/** Splits shell text into pipelines of stages of words; `$(...)`/backticks become sub-scripts on the word. */
function parse(script: string): Pipeline[] {
  const pipelines: Pipeline[] = [];
  let stages: Word[][] = [], words: Word[] = [], word: Word | undefined;
  const push = () => { if (word) { words.push(word); word = undefined; } };
  const stage = () => { push(); if (words.length) stages.push(words); words = []; };
  const pipeline = () => { stage(); if (stages.length) pipelines.push(stages); stages = []; };
  const cur = () => (word ??= { text: '', subs: [] });
  const closing = (from: number, open: string, close: string) => {
    let depth = 1, i = from, quote = '';
    for (; i < script.length; i++) {
      const c = script[i];
      if (quote) { if (c === quote) quote = ''; else if (c === '\\' && quote === '"') i++; continue; }
      if (c === '\\') { i++; continue; }
      if (c === '\'' || c === '"') { quote = c; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) break;
    }
    return i;
  };
  const substitution = (i: number): number => {
    if (script[i] === '`') { const end = script.indexOf('`', i + 1); const stop = end < 0 ? script.length : end; cur().subs.push(script.slice(i + 1, stop)); cur().text += '\0'; return stop; }
    const end = closing(i + 2, '(', ')'); cur().subs.push(script.slice(i + 2, end)); cur().text += '\0'; return end;
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i], next = script[i + 1];
    if (c === ' ' || c === '\t') { push(); continue; }
    if (c === '\n' || c === ';' || c === '(' || c === ')' || c === '{' || c === '}') { pipeline(); continue; }
    if (c === '&' && (script[i - 1] === '>' || script[i - 1] === '<')) { cur().text += c; continue; }
    if (c === '&') { if (next === '&') i++; else if (next === '>') { cur().text += c; continue; } pipeline(); continue; }
    if (c === '|') { if (next === '|') { i++; pipeline(); } else { if (next === '&') i++; stage(); } continue; }
    if (c === '#' && !word) { const end = script.indexOf('\n', i); i = end < 0 ? script.length : end - 1; continue; }
    if (c === '\\') { if (next !== undefined && next !== '\n') cur().text += next; i++; continue; }
    if (c === '\'') { const end = script.indexOf('\'', i + 1); const stop = end < 0 ? script.length : end; cur().text += script.slice(i + 1, stop); i = stop; continue; }
    if (c === '"') {
      cur();
      for (i++; i < script.length && script[i] !== '"'; i++) {
        if (script[i] === '\\' && i + 1 < script.length) { cur().text += script[++i]; continue; }
        if ((script[i] === '$' && script[i + 1] === '(') || script[i] === '`') { i = substitution(i); continue; }
        cur().text += script[i];
      }
      continue;
    }
    if ((c === '$' && next === '(') || c === '`') { i = substitution(i); continue; }
    cur().text += c;
  }
  pipeline();
  return pipelines;
}

/** Drops env assignments and wrappers (`sudo -u x`, `env FOO=1`, `timeout 5`, `xargs -r`); reports an xargs hop. */
function unwrap(stage: Word[]): { argv: Word[]; xargs: boolean } {
  let i = 0, xargs = false;
  while (i < stage.length) {
    const text = stage[i].text, name = base(text);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) { i++; continue; }
    if (WRAPPERS.has(name)) {
      i++;
      while (i < stage.length && (stage[i].text.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(stage[i].text))) { const flag = stage[i].text; i++; if (name === 'sudo' && /^-[ugpCDhrt]$/.test(flag)) i++; if (name === 'nice' && flag === '-n') i++; }
      continue;
    }
    if (name === 'timeout') { i++; while (i < stage.length && stage[i].text.startsWith('-')) i++; i++; continue; }
    if (name === 'xargs') {
      xargs = true; i++;
      while (i < stage.length && stage[i].text.startsWith('-')) { const flag = stage[i].text; i++; if (/^-[InLPdEs]$/.test(flag)) i++; }
      continue;
    }
    break;
  }
  return { argv: stage.slice(i), xargs };
}

const empty = (): KillIntent => ({ pids: [], pgids: [], ports: [], patterns: [], all: false });
function merge(into: KillIntent, from: KillIntent) { into.pids.push(...from.pids); into.pgids.push(...from.pgids); into.ports.push(...from.ports); into.patterns.push(...from.patterns); into.all ||= from.all; }

/** Ports named by `lsof -i:5173`, `lsof -i tcp:5173`, `lsof -iTCP:5173 -sTCP:LISTEN`. */
function lsofPorts(args: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const spec = arg === '-i' ? args[i + 1] ?? '' : arg.startsWith('-') && /i/.test(arg.slice(1).replace(/[^a-zA-Z].*$/, '')) ? arg.slice(arg.indexOf('i') + 1) : '';
    const n = port(/:(\d+)$/.exec(spec)?.[1]);
    if (n !== undefined) out.push(n);
  }
  return out;
}
/** `fuser -k 5173/tcp`, `fuser -k -n tcp 5173`, `fuser -k :5173`. */
function fuserPorts(args: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const n = port(/^(?::)?(\d+)\/(?:tcp|udp)$/.exec(args[i])?.[1] ?? /^:(\d+)$/.exec(args[i])?.[1] ?? (args[i - 1] === 'tcp' || args[i - 1] === 'udp' ? args[i] : undefined));
    if (n !== undefined) out.push(n);
  }
  return out;
}
/** pkill/pgrep/killall operands. `-g N` is a process-group target. */
function patternArgs(name: string, args: readonly string[], into: KillIntent) {
  const killall = name === 'killall';
  const valued = killall ? /^-[sutc]$|^--(signal|user)$/ : /^-[uUGgPstF]$|^--(signal|ns|nslist|parent|pgroup|session|terminal|pidfile|group|euid|uid)$/;
  let full = false, exact = killall;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { for (const rest of args.slice(i + 1)) into.patterns.push({ pattern: rest, full, exact }); return; }
    if (arg.startsWith('-') && arg.length > 1) {
      if (!killall && /^-[a-zA-Z]*f/.test(arg) && !/^-[A-Z0-9]/.test(arg)) full = true;
      if (!killall && /^-[a-zA-Z]*x/.test(arg) && !/^-[A-Z0-9]/.test(arg)) exact = true;
      if (!killall && (arg === '-g' || arg === '--pgroup')) { for (const g of (args[i + 1] ?? '').split(',')) { const n = intOf(g); if (n !== undefined) into.pgids.push(n); } }
      if (valued.test(arg)) i++;
      continue;
    }
    into.patterns.push({ pattern: arg, full, exact });
  }
}
/** Numeric `kill` operands: the first `-SIG`/`-9` is a signal, later negative numbers are process groups. */
function killArgs(args: readonly Word[], into: KillIntent, depth: number) {
  let signalSeen = false, operands = false;
  for (let i = 0; i < args.length; i++) {
    const { text, subs } = args[i];
    if (subs.length) { for (const sub of subs) merge(into, producers(sub, depth + 1)); continue; }
    if (!operands && text === '--') { operands = true; continue; }
    if (!operands && (text === '-l' || text === '-L')) return;
    if (!operands && (text === '-s' || text === '-n')) { i++; signalSeen = true; continue; }
    if (!operands && !signalSeen && /^-[A-Za-z0-9+]+$/.test(text)) { signalSeen = true; continue; }
    const neg = /^-(\d{1,7})$/.exec(text);
    if (neg) { const n = Number(neg[1]); if (n === 1) into.all = true; else into.pgids.push(n); continue; }
    const n = intOf(text); if (n !== undefined && n > 0) into.pids.push(n);
  }
}
/** What a stage *prints*: PIDs from `lsof -t -i:PORT`/`fuser PORT/tcp` (as ports), `pgrep pattern`, `echo 123`. */
function stageProducers(argv: Word[], into: KillIntent, depth: number) {
  const name = base(argv[0]?.text ?? ''), args = argv.slice(1).map(word => word.text);
  if (name === 'lsof') into.ports.push(...lsofPorts(args));
  else if (name === 'fuser') into.ports.push(...fuserPorts(args));
  else if (name === 'pgrep') patternArgs(name, args, into);
  else if (name === 'echo' || name === 'printf') for (const arg of args) { const n = intOf(arg); if (n) into.pids.push(n); }
  for (const word of argv) for (const sub of word.subs) merge(into, producers(sub, depth + 1));
}
function producers(script: string, depth: number): KillIntent {
  const intent = empty();
  if (depth > MAX_DEPTH) return intent;
  for (const stages of parse(script)) for (const stage of stages) stageProducers(unwrap(stage).argv, intent, depth);
  return intent;
}

/** The processes a command would signal, or null when it signals nothing. */
function analyze(script: string, depth: number): KillIntent | null {
  if (depth > MAX_DEPTH) return null;
  const intent = empty(); let kills = false;
  for (const stages of parse(script)) {
    const piped = empty();
    for (const stage of stages) {
      const { argv, xargs } = unwrap(stage);
      if (!argv.length) continue;
      const name = base(argv[0].text), args = argv.slice(1);
      const texts = args.map(word => word.text);
      // Nested shells: `bash -lc "kill ..."`.
      if (SHELLS.has(name)) { const at = texts.findIndex(text => /^-[a-z]*c[a-z]*$/.test(text)); if (at >= 0 && texts[at + 1] !== undefined) { const inner = analyze(texts[at + 1], depth + 1); if (inner) { kills = true; merge(intent, inner); } } continue; }
      if (name === 'kill') { kills = true; killArgs(args, intent, depth); if (xargs) merge(intent, piped); }
      else if (name === 'pkill' || name === 'killall') { kills = true; patternArgs(name, texts, intent); }
      else if (name === 'fuser' && texts.some(text => /^-[a-zA-Z]*k/.test(text))) { kills = true; intent.ports.push(...fuserPorts(texts)); }
      else if (name === 'kill-port' || ((name === 'npx' || name === 'pnpx' || name === 'bunx') && /^kill-port(@|$)/.test(texts.find(text => !text.startsWith('-')) ?? ''))) {
        kills = true; for (const text of texts) { const n = port(text); if (n !== undefined) intent.ports.push(n); }
      } else {
        stageProducers(argv, piped, depth);
        // `$(kill ...)` inside another command's arguments still runs.
        for (const word of argv) for (const sub of word.subs) { const inner = analyze(sub, depth + 1); if (inner) { kills = true; merge(intent, inner); } }
      }
    }
  }
  return kills ? intent : null;
}

/** Shell text for an agent command: argv from the provider (`['/bin/zsh','-lc','…']`) or a plain string. */
export function commandText(command: unknown): string {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  const argv = command.filter((part): part is string => typeof part === 'string');
  const shell = SHELLS.has(base(argv[0] ?? '')) ? argv.findIndex(part => /^-[a-z]*c[a-z]*$/.test(part)) : -1;
  if (shell > 0 && argv[shell + 1] !== undefined) return argv[shell + 1];
  return argv.map(part => /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
}

/** Parses the processes an agent command would signal; null when it is not a kill-type command. */
export function parseKillIntent(command: unknown): KillIntent | null {
  const text = commandText(command);
  if (!text || !/kill|fuser/.test(text)) return null;
  return analyze(text.slice(0, 64 * 1024), 0);
}

function patternMatches(pattern: KillPattern, group: UserProcessTarget): boolean {
  const argv0 = base(group.label.replace(/^terminal\s+/, '').trim().split(/\s+/)[0] ?? '');
  const names = [...(group.names ?? []).map(base), ...(argv0 ? [argv0] : [])];
  const subjects = pattern.full ? [group.label, ...names] : names;
  if (pattern.exact && !pattern.full) return names.includes(pattern.pattern);
  let regex: RegExp | undefined;
  try { regex = new RegExp(pattern.exact ? `^(?:${pattern.pattern})$` : pattern.pattern); } catch { /* not a valid ERE: fall back to substring */ }
  return subjects.some(subject => regex ? regex.test(subject) : subject.includes(pattern.pattern));
}

function describe(group: UserProcessTarget, ports: readonly number[]): string {
  const label = group.label.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 80) || `process group ${group.pgid}`;
  const kind = /^terminal\b/.test(label) ? 'terminal' : /\b(dev|serve|server|start|preview|watch|vite|next|nuxt|astro|webpack|storybook|rails|django|flask|uvicorn|nodemon)\b/i.test(label) ? 'dev server' : ports.length ? 'server' : 'process';
  const detail = kind === 'terminal' ? label.replace(/^terminal\s*/, '') : label;
  return `your ${kind} (${[detail, ...(ports.length ? [`port ${ports.join(', ')}`] : [])].filter(Boolean).join(', ')})`;
}

/**
 * Resolves an agent command against the user's live processes. Returns null when the command does not
 * signal any of them (killing the agent's own PID or an unrelated PID is allowed).
 */
export function userProcessThreat(command: unknown, groups: readonly UserProcessTarget[]): UserProcessThreat | null {
  if (!groups.length) return null;
  const intent = parseKillIntent(command);
  if (!intent) return null;
  const hits: Array<{ group: UserProcessTarget; ports: number[] }> = [];
  for (const group of groups) {
    const pids = new Set([group.pgid, ...(group.pids ?? [])]), pgids = new Set([group.pgid, ...(group.pgids ?? [])]);
    const ports = [...new Set(intent.ports.filter(port => group.ports?.includes(port)))];
    const hit = intent.all || ports.length > 0 || intent.pids.some(pid => pids.has(pid)) || intent.pgids.some(pgid => pgids.has(pgid)) || intent.patterns.some(pattern => patternMatches(pattern, group));
    if (hit) hits.push({ group, ports: ports.length ? ports : [...(group.ports ?? [])].slice(0, 3) });
  }
  if (!hits.length) return null;
  const [first] = hits;
  const more = hits.length > 1 ? ` and ${hits.length - 1} more of your process${hits.length > 2 ? 'es' : ''}` : '';
  return {
    groups: hits.map(hit => hit.group), ports: [...new Set(hits.flatMap(hit => hit.ports))],
    message: `This would stop ${describe(first.group, first.ports)}${more}, which you started in Muster.`,
  };
}
