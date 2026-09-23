/**
 * Read-only readers for other agents' conversation stores (CHAT-01):
 *  - Codex CLI / desktop rollouts: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl` (+ `archived_sessions/`),
 *    `session_index.jsonl` (thread names) and, when present, the `state_*.sqlite` thread index;
 *  - Claude Code transcripts: `<CLAUDE_CONFIG_DIR>/projects/<slug>/<sessionId>.jsonl`;
 *  - OpenCode sessions: `<XDG_DATA_HOME>/opencode/storage/{session,message,part}/…json`;
 *  - ChatGPT data exports: a zip holding `conversations.json`, or that file on its own.
 *
 * Every file is streamed line by line and discovery reads only a bounded head (and tail) of each
 * transcript, because a session store can hold tens of gigabytes. Nothing here writes to a source.
 */
import { closeSync, createReadStream, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { importTitle, type ImportSource } from '../shared/domains/import-protocol.ts';

export type ImportedKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice';
/** A normalized transcript row; `ref` (a tool call id) lets a later result update it in place. */
export interface ImportedItem { kind: ImportedKind; text: string; status?: string; createdAt: string; data?: Record<string, unknown>; ref?: string }
export interface SessionMeta { sessionId?: string; cwd?: string; startedAt?: string; model?: string; title?: string; source?: string; provider?: string }
export type ImportedEvent = { type: 'meta'; meta: SessionMeta } | { type: 'item'; item: ImportedItem } | { type: 'result'; ref: string; output: string; status?: string; data?: Record<string, unknown>; createdAt: string };
export interface DiscoveredSession { source: ImportSource; sessionId: string; path: string; cwd?: string; title: string; updatedAt: string; sizeBytes: number; archived?: boolean; model?: string; messageCount: number | null; originator?: string }

/** How much of a transcript discovery reads to find its metadata and first prompt. */
export const DISCOVERY_HEAD_BYTES = 512 * 1024;
const DISCOVERY_TAIL_BYTES = 64 * 1024;
export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
export const MAX_MESSAGE_TEXT = 64 * 1024;
export const MAX_TOOL_OUTPUT = 16 * 1024;
export const MAX_REASONING_TEXT = 16 * 1024;
export const MAX_ITEMS_PER_SESSION = 20_000;

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const parseJson = (value: unknown): unknown => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return undefined; } };
export const clipText = (text: string, max: number): { text: string; truncated: boolean } => text.length > max ? { text: `${text.slice(0, max)}\n… [truncated]`, truncated: true } : { text, truncated: false };
const isoAt = (value: unknown, fallback: string): string => {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  return fallback;
};
/** The mtime as ISO, or the epoch when the file is gone. */
const mtimeIso = (path: string): string => { try { return statSync(path).mtime.toISOString(); } catch { return new Date(0).toISOString(); } };

/** Longest transcript line kept (UTF-16 code units). A rollout line can carry a whole inline image or a huge tool
 *  output; one such line must not be buffered whole (readline would), so longer lines are skipped without being held. */
export const MAX_LINE_CHARS = 16 * 1024 * 1024;
/** Lines of a file, streamed; `maxBytes` stops after a bounded prefix (its last line may be cut and is skipped by the JSON
 *  parse). Memory stays bounded by MAX_LINE_CHARS plus one read chunk whatever the file holds. */
export async function* fileLines(path: string, maxBytes?: number, maxLine = MAX_LINE_CHARS): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 256 * 1024, ...(maxBytes ? { start: 0, end: maxBytes - 1 } : {}) });
  let parts: string[] = [], length = 0, skipping = false;
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      let from = 0;
      for (let newline = chunk.indexOf('\n', from); ; newline = chunk.indexOf('\n', from)) {
        const end = newline < 0 ? chunk.length : newline;
        if (!skipping) {
          if (length + (end - from) > maxLine) { skipping = true; parts = []; length = 0; }
          else if (end > from) { parts.push(chunk.slice(from, end)); length += end - from; }
        }
        if (newline < 0) break;
        if (!skipping) { const line = parts.join('').replace(/\r$/, ''); if (line) yield line; }
        parts = []; length = 0; skipping = false; from = newline + 1;
      }
    }
    if (!skipping) { const line = parts.join('').replace(/\r$/, ''); if (line) yield line; }
  } finally { stream.destroy(); }
}
export async function* jsonLines(path: string, maxBytes?: number): AsyncGenerator<Record<string, unknown>> {
  for await (const line of fileLines(path, maxBytes)) {
    let parsed: unknown; try { parsed = JSON.parse(line); } catch { continue; }
    const row = record(parsed); if (row) yield row;
  }
}
function tailText(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size, length = Math.min(size, bytes), buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, read).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

// ---------------------------------------------------------------------------------------------
// Codex rollouts
// ---------------------------------------------------------------------------------------------

/** Context Codex injects as user-role messages (environment, instructions, permissions); never a prompt the user typed. */
const CODEX_INJECTED = /^\s*(?:<(?:environment_context|user_instructions|permissions_instructions|turn_aborted|app_context|apps_instructions|skills_instructions|skills|collaboration_mode|system_message|memory|memories|host_skills|plugins_instructions|turn_context|INSTRUCTIONS|user_shell_command|thread_settings)[\s>]|#\s*AGENTS\.md)/i;
/**
 * The user's own words from a user-role message that may lead with injected context: XML-ish blocks the agent host
 * adds (`<environment_context>`, `<recommended_plugins>`, `<apps_instructions>`, `<skills…>`, `<system-reminder>`, …),
 * Codex's `# AGENTS.md instructions for …` preamble, and Muster's own preamble (project packet, recalled notes,
 * digest) that ends in "Current user request:". Returns '' when nothing but injected context is left.
 * Only tag names agent hosts use are stripped (a known list plus their naming families), so a prompt that starts
 * with the user's own markup — `<div>`, `<context>`, `<task>` — is kept as typed.
 */
const INJECTED_TAG = /^<([A-Za-z][\w.:-]*)(?:\s[^>]*)?\/?>/;
const KNOWN_INJECTED_TAGS = new Set(['environment_context', 'user_instructions', 'permissions_instructions', 'turn_aborted', 'app_context', 'apps_instructions',
  'skills_instructions', 'skills', 'collaboration_mode', 'system_message', 'memory', 'memories', 'host_skills', 'plugins_instructions', 'turn_context',
  'instructions', 'user_shell_command', 'thread_settings', 'recommended_plugins', 'available_plugins', 'apps', 'plugins', 'permissions', 'system-reminder',
  'user-prompt-submit-hook', 'task-notification', 'bash-input', 'bash-stdout', 'bash-stderr']);
const INJECTED_TAG_FAMILY = /^(?:[a-z]+_(?:instructions|context|settings|mode)|recommended_[a-z_]+|permissions[_-][a-z_-]+|skills?[_-][a-z_-]+|system[_-][a-z_-]+|(?:local-)?command-[a-z-]+|ide_[a-z_]+)$/;
const injectedTagName = (name: string) => KNOWN_INJECTED_TAGS.has(name.toLowerCase()) || INJECTED_TAG_FAMILY.test(name.toLowerCase());
const MUSTER_REQUEST_MARKER = '\n\nCurrent user request:\n';
export function stripInjectedContext(text: string): string {
  let rest = text;
  const marker = rest.indexOf(MUSTER_REQUEST_MARKER);
  if (marker >= 0) rest = rest.slice(marker + MUSTER_REQUEST_MARKER.length);
  else if (rest.startsWith('Current user request:\n')) rest = rest.slice('Current user request:\n'.length);
  for (let guard = 0; guard < 64; guard++) {
    rest = rest.replace(/^\s+/, '');
    const agents = /^#\s*AGENTS\.md\b[^\n]*(?:\n|$)/i.exec(rest);
    if (agents) {
      rest = rest.slice(agents[0].length).replace(/^\s+/, '');
      // The preamble's body is its <INSTRUCTIONS> block; an older untagged preamble is the whole message.
      if (!INJECTED_TAG.test(rest)) return '';
      continue;
    }
    const open = INJECTED_TAG.exec(rest);
    if (!open || !injectedTagName(open[1]!)) break;
    if (open[0].endsWith('/>')) { rest = rest.slice(open[0].length); continue; }
    // Codex closes `<permissions instructions>` with `</permissions instructions>`: the close may carry words too.
    const close = new RegExp(`</${open[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s[^>]*)?>`, 'i').exec(rest.slice(open[0].length));
    // An injected block that never closes runs to the end of the message.
    if (!close) return '';
    rest = rest.slice(open[0].length + close.index + close[0].length);
  }
  return rest.trim();
}
const CODEX_ITEM_TYPES = new Set(['message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'local_shell_call_output', 'web_search_call', 'tool_search_call', 'tool_search_output']);
const COMMAND_TOOLS = new Set(['exec_command', 'shell', 'shell_command', 'container.exec', 'local_shell', 'exec']);

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    const row = record(part); if (!row) return typeof part === 'string' ? part : '';
    if (typeof row.text === 'string') return row.text;
    if (row.type === 'input_image' || row.type === 'image' || typeof row.image_url === 'string') return '[image]';
    return '';
  }).filter(Boolean).join('\n');
}
/** Codex `apply_patch` text → app-server style `changes`: adds carry the whole file, updates a bare `+`/`-`/` ` patch. */
export function parseApplyPatch(patch: string): Array<{ path: string; kind: { type: 'add' | 'delete' | 'update'; move_path?: string }; diff: string }> {
  const changes: Array<{ path: string; kind: { type: 'add' | 'delete' | 'update'; move_path?: string }; diff: string }> = [];
  let current: { path: string; kind: { type: 'add' | 'delete' | 'update'; move_path?: string }; lines: string[] } | undefined;
  const flush = () => { if (!current) return; const body = current.lines.join('\n'); changes.push({ path: current.path, kind: current.kind, diff: current.kind.type === 'add' ? body.replace(/^\+/gm, '') : body }); current = undefined; };
  for (const line of patch.split(/\r?\n/)) {
    if (/^\*\*\* (?:Begin|End) Patch\s*$/.test(line)) { flush(); continue; }
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line);
    if (header) { flush(); current = { path: header[2]!.trim(), kind: { type: header[1] === 'Add' ? 'add' : header[1] === 'Delete' ? 'delete' : 'update' }, lines: [] }; continue; }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current) { current.kind.move_path = move[1]!.trim(); continue; }
    if (!current) continue;
    if (line.startsWith('@@')) continue; // context markers carry no line numbers; the bare patch below is enough for counts and rendering
    if (line === '*** End of File') continue;
    if (/^[+\- ]/.test(line) || line === '') current.lines.push(line === '' ? ' ' : line);
  }
  flush();
  return changes;
}
/** Exit code and payload of a Codex tool result, whichever of its shapes the CLI version wrote. */
function commandResult(raw: string): { output: string; exitCode?: number } {
  const parsed = record(parseJson(raw.trimStart().startsWith('{') ? raw : undefined));
  if (parsed && (typeof parsed.output === 'string' || record(parsed.metadata))) {
    const meta = record(parsed.metadata);
    const code = meta && typeof meta.exit_code === 'number' ? meta.exit_code : undefined;
    return { output: str(parsed.output), ...(code !== undefined ? { exitCode: code } : {}) };
  }
  const exit = /^Process exited with code (-?\d+)\s*$/m.exec(raw);
  const marker = raw.indexOf('\nOutput:\n');
  const output = marker >= 0 && exit ? raw.slice(marker + '\nOutput:\n'.length) : raw;
  return { output, ...(exit ? { exitCode: Number(exit[1]) } : {}) };
}
function codexToolItem(name: string, args: unknown, namespace: string | undefined, callId: string, createdAt: string): ImportedItem {
  const parsed = record(parseJson(args)) ?? {};
  const rawText = typeof args === 'string' ? args : '';
  const label = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 240);
  if (name === 'apply_patch') {
    const patch = str(parsed.input) || str(parsed.patch) || rawText;
    const changes = parseApplyPatch(patch);
    return { kind: 'tool', text: changes.map(change => change.path).join(', ') || 'apply_patch', status: 'running', createdAt, ref: callId, data: { type: 'fileChange', name: changes.map(change => change.path).join(', ') || 'apply_patch', changes } };
  }
  if (COMMAND_TOOLS.has(name)) {
    const cmd = str(parsed.cmd) || (Array.isArray(parsed.command) ? parsed.command.map(String).join(' ') : str(parsed.command)) || rawText;
    const workdir = str(parsed.workdir) || str(parsed.cwd);
    return { kind: 'tool', text: label(cmd) || name, status: 'running', createdAt, ref: callId, data: { type: 'commandExecution', name: label(cmd) || name, command: cmd, ...(workdir ? { cwd: workdir } : {}) } };
  }
  if (name === 'write_stdin') return { kind: 'tool', text: 'write_stdin', status: 'running', createdAt, ref: callId, data: { type: 'functionCall', name: 'write_stdin', arguments: parsed } };
  if (name === 'update_plan') return { kind: 'tool', text: 'update_plan', status: 'running', createdAt, ref: callId, data: { type: 'plan', tool: 'update_plan', name: 'update_plan', arguments: rawText || JSON.stringify(parsed), ...(Array.isArray(parsed.plan) ? { plan: parsed.plan } : {}) } };
  if (name === 'request_user_input') {
    const questions = Array.isArray(parsed.questions) ? parsed.questions.map(question => str(record(question)?.question) || str(record(question)?.header)).filter(Boolean) : [];
    return { kind: 'tool', text: 'Asked the user', status: 'running', createdAt, ref: callId, data: { type: 'functionCall', name: questions.length ? `Asked: ${label(questions.join(' · '))}` : 'Asked the user', arguments: parsed } };
  }
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (mcp || namespace) {
    const server = mcp ? mcp[1]! : namespace!, tool = mcp ? mcp[2]! : name;
    return { kind: 'tool', text: `${server} / ${tool}`, status: 'running', createdAt, ref: callId, data: { type: 'mcpToolCall', name: `${server} / ${tool}`, server, tool, arguments: parsed } };
  }
  return { kind: 'tool', text: name, status: 'running', createdAt, ref: callId, data: { type: 'functionCall', name, arguments: parsed } };
}

/** Streams a Codex rollout (current `{type,payload}` lines or the pre-2025 flat layout) as normalized events. */
export async function* readCodexRollout(path: string, maxBytes?: number): AsyncGenerator<ImportedEvent> {
  let at = mtimeIso(path);
  let announced = false;
  const meta: SessionMeta = {};
  const announce = () => { if (!announced) { announced = true; return true; } return false; };
  let calls = 0;
  for await (const row of jsonLines(path, maxBytes)) {
    if (typeof row.timestamp === 'string') at = isoAt(row.timestamp, at);
    const type = str(row.type);
    let payload: Record<string, unknown> | undefined;
    if (type === 'session_meta') {
      const p = record(row.payload) ?? {};
      meta.sessionId = str(p.id) || str(p.session_id) || meta.sessionId;
      meta.cwd = str(p.cwd) || meta.cwd; meta.startedAt = isoAt(p.timestamp, at);
      meta.source = typeof p.source === 'string' ? p.source : p.source && typeof p.source === 'object' ? 'subagent' : meta.source;
      meta.provider = str(p.model_provider) || meta.provider;
      const instructions = record(p.base_instructions); const provenance = record(instructions?.provenance);
      if (provenance && typeof provenance.model === 'string') meta.model = provenance.model;
      if (announce()) yield { type: 'meta', meta };
      continue;
    }
    if (!type && typeof row.id === 'string' && typeof row.timestamp === 'string' && !('payload' in row)) {
      // Pre-session_meta rollouts: a flat header line, then bare response items.
      meta.sessionId = row.id; meta.startedAt = isoAt(row.timestamp, at); meta.cwd = str(row.cwd) || meta.cwd;
      if (announce()) yield { type: 'meta', meta };
      continue;
    }
    if (type === 'turn_context') { const p = record(row.payload); if (p) { meta.cwd = str(p.cwd) || meta.cwd; meta.model = str(p.model) || meta.model; } continue; }
    if (type === 'event_msg') {
      const p = record(row.payload);
      if (p?.type === 'turn_aborted') yield { type: 'item', item: { kind: 'notice', text: 'Turn interrupted', status: 'completed', createdAt: at, data: { kind: 'interrupted' } } };
      continue;
    }
    if (type === 'compacted') { yield { type: 'item', item: { kind: 'notice', text: 'Context compacted', status: 'completed', createdAt: at, data: { kind: 'context-compacted' } } }; continue; }
    if (type === 'response_item') payload = record(row.payload);
    else if (CODEX_ITEM_TYPES.has(type)) payload = row;
    if (!payload) continue;
    if (!announced) { announce(); yield { type: 'meta', meta }; }
    const itemType = str(payload.type);
    if (itemType === 'message') {
      const role = str(payload.role), text = contentText(payload.content);
      if (!text.trim()) continue;
      if (role === 'user') {
        const typed = stripInjectedContext(text); if (!typed || CODEX_INJECTED.test(typed)) continue;
        yield { type: 'item', item: { kind: 'user', text: typed, createdAt: at } };
      }
      else if (role === 'assistant') yield { type: 'item', item: { kind: 'assistant', text, status: 'completed', createdAt: at, ...(str(payload.phase) === 'commentary' ? { data: { phase: 'commentary' } } : {}) } };
      continue;
    }
    if (itemType === 'reasoning') {
      const summary = Array.isArray(payload.summary) ? payload.summary.map(part => str(record(part)?.text)).filter(Boolean).join('\n\n') : '';
      const content = summary || (Array.isArray(payload.content) ? payload.content.map(part => str(record(part)?.text)).filter(Boolean).join('\n\n') : '');
      if (content.trim()) yield { type: 'item', item: { kind: 'reasoning', text: content, status: 'completed', createdAt: at } };
      continue;
    }
    if (itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'local_shell_call') {
      const callId = str(payload.call_id) || str(payload.id) || `call-${++calls}`;
      const name = itemType === 'local_shell_call' ? 'local_shell' : str(payload.name) || itemType;
      const args = itemType === 'local_shell_call' ? { command: record(payload.action)?.command } : itemType === 'custom_tool_call' ? payload.input : payload.arguments;
      yield { type: 'item', item: codexToolItem(name, args, str(payload.namespace) || undefined, callId, at) };
      continue;
    }
    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output' || itemType === 'local_shell_call_output') {
      const callId = str(payload.call_id) || str(payload.id); if (!callId) continue;
      const result = commandResult(typeof payload.output === 'string' ? payload.output : contentText(payload.output) || JSON.stringify(payload.output ?? ''));
      yield { type: 'result', ref: callId, output: result.output, createdAt: at, ...(result.exitCode !== undefined ? { status: result.exitCode === 0 ? 'completed' : 'failed', data: { exitCode: result.exitCode } } : { status: 'completed' }) };
      continue;
    }
    if (itemType === 'web_search_call') {
      const action = record(payload.action); const query = str(action?.query) || (Array.isArray(action?.queries) ? action!.queries.map(String).join(', ') : '');
      yield { type: 'item', item: { kind: 'tool', text: query || 'Web search', status: 'completed', createdAt: at, data: { type: 'webSearch', name: query || 'Web search', query } } };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Claude Code transcripts
// ---------------------------------------------------------------------------------------------

const CLAUDE_INJECTED = /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|ide_opened_file|ide_selection|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|task-notification|system-reminder|antml|policy_spec)[\s>]/i;
const stripReminders = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
function claudeToolItem(id: string, name: string, input: Record<string, unknown>, createdAt: string): ImportedItem {
  const tool = (data: Record<string, unknown>, text: string): ImportedItem => ({ kind: 'tool', text, status: 'running', createdAt, ref: id, data: { name: text, ...data } });
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path);
  switch (name) {
    case 'Bash': return tool({ type: 'commandExecution', command: str(input.command), ...(str(input.description) ? { description: str(input.description) } : {}) }, str(input.command).replace(/\s+/g, ' ').slice(0, 240) || 'Bash');
    case 'Read': return tool({ type: 'fileRead', path }, path || 'Read');
    case 'Write': return tool({ type: 'fileChange', changes: [{ path, kind: { type: 'add' }, diff: str(input.content) }] }, path || 'Write');
    case 'Edit': return tool({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, oldContent: str(input.old_string), newContent: str(input.new_string) }] }, path || 'Edit');
    case 'MultiEdit': return tool({ type: 'fileChange', changes: (Array.isArray(input.edits) ? input.edits : []).map(edit => ({ path, kind: { type: 'update' }, oldContent: str(record(edit)?.old_string), newContent: str(record(edit)?.new_string) })) }, path || 'MultiEdit');
    case 'Grep': return tool({ type: 'commandExecution', command: `grep ${str(input.pattern)}`, commandActions: [{ type: 'search', query: str(input.pattern), path: str(input.path) }] }, `grep ${str(input.pattern)}`.slice(0, 240));
    case 'Glob': return tool({ type: 'commandExecution', command: `glob ${str(input.pattern)}`, commandActions: [{ type: 'listFiles', path: [str(input.pattern), str(input.path)].filter(Boolean).join(' in ') }] }, `glob ${str(input.pattern)}`.slice(0, 240));
    case 'LS': return tool({ type: 'commandExecution', command: `ls ${path}`, commandActions: [{ type: 'listFiles', path }] }, `ls ${path}`.slice(0, 240));
    case 'WebSearch': return tool({ type: 'webSearch', query: str(input.query) }, str(input.query) || 'Web search');
    case 'WebFetch': return tool({ type: 'functionCall', tool: 'WebFetch', arguments: input }, `WebFetch ${str(input.url)}`.slice(0, 240));
    case 'TodoWrite': return tool({ type: 'todoList', tool: 'TodoWrite', todos: Array.isArray(input.todos) ? input.todos : [], arguments: JSON.stringify(input) }, 'TodoWrite');
    case 'Task': case 'Agent': return tool({ type: 'functionCall', tool: name, arguments: input }, `Agent: ${str(input.description) || str(input.subagent_type) || name}`.slice(0, 240));
    default: {
      const mcp = /^mcp__([^_].*?)__(.+)$/.exec(name);
      if (mcp) return tool({ type: 'mcpToolCall', server: mcp[1], tool: mcp[2], arguments: input }, `${mcp[1]} / ${mcp[2]}`);
      return tool({ type: 'functionCall', tool: name, arguments: input }, name);
    }
  }
}
/** Streams a Claude Code session transcript. Sidechain (subagent) lines and injected context are skipped. */
export async function* readClaudeTranscript(path: string, maxBytes?: number): AsyncGenerator<ImportedEvent> {
  const meta: SessionMeta = { sessionId: basename(path, '.jsonl') };
  let announced = false, at = mtimeIso(path);
  for await (const row of jsonLines(path, maxBytes)) {
    if (typeof row.timestamp === 'string') at = isoAt(row.timestamp, at);
    const type = str(row.type);
    if (type === 'ai-title' && typeof row.aiTitle === 'string') { meta.title = row.aiTitle; continue; }
    if (type === 'summary' && typeof row.summary === 'string') { meta.title ??= row.summary; continue; }
    if (type === 'system') { if (row.subtype === 'compact_boundary') yield { type: 'item', item: { kind: 'notice', text: 'Context compacted', status: 'completed', createdAt: at, data: { kind: 'context-compacted' } } }; continue; }
    if (type !== 'user' && type !== 'assistant') continue;
    if (row.isSidechain === true) continue;
    if (typeof row.cwd === 'string' && row.cwd) meta.cwd ??= row.cwd;
    if (typeof row.sessionId === 'string' && row.sessionId) meta.sessionId = row.sessionId;
    if (!announced) { announced = true; meta.startedAt = at; yield { type: 'meta', meta }; }
    const message = record(row.message); if (!message) continue;
    if (typeof message.model === 'string') meta.model = message.model;
    const content = message.content;
    if (type === 'user') {
      const blocks = Array.isArray(content) ? content.map(record).filter((b): b is Record<string, unknown> => !!b) : [];
      for (const block of blocks) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const extra = record(row.toolUseResult);
        const stdout = str(extra?.stdout), stderr = str(extra?.stderr);
        const text = typeof block.content === 'string' ? block.content : contentText(block.content);
        const output = [text || stdout, stderr && stderr !== text ? `stderr:\n${stderr}` : ''].filter(Boolean).join('\n');
        const status = block.is_error === true ? 'failed' : extra?.interrupted === true ? 'interrupted' : 'completed';
        yield { type: 'result', ref: block.tool_use_id, output, status, createdAt: at, ...(stderr ? { data: { stderr } } : {}) };
      }
      if (row.isMeta === true) continue;
      const raw = stripReminders(typeof content === 'string' ? content : blocks.filter(block => block.type === 'text' || block.type === 'image').map(block => block.type === 'image' ? '[image]' : str(block.text)).join('\n'));
      if (!raw) continue;
      if (/^\[Request interrupted by user/i.test(raw)) { yield { type: 'item', item: { kind: 'notice', text: 'Interrupted by the user', status: 'completed', createdAt: at, data: { kind: 'interrupted' } } }; continue; }
      const text = stripInjectedContext(raw);
      if (!text || CLAUDE_INJECTED.test(text)) continue;
      yield { type: 'item', item: { kind: 'user', text, createdAt: at } };
      continue;
    }
    const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
    for (const raw of blocks) {
      const block = record(raw); if (!block) continue;
      if (block.type === 'text' && str(block.text).trim()) yield { type: 'item', item: { kind: 'assistant', text: str(block.text), status: 'completed', createdAt: at } };
      else if (block.type === 'thinking' && str(block.thinking).trim()) yield { type: 'item', item: { kind: 'reasoning', text: str(block.thinking), status: 'completed', createdAt: at } };
      else if (block.type === 'tool_use' && typeof block.id === 'string') yield { type: 'item', item: claudeToolItem(block.id, str(block.name), record(block.input) ?? {}, at) };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// ChatGPT data export
// ---------------------------------------------------------------------------------------------

export interface ChatGptConversation { id: string; title: string; createdAt: string; updatedAt: string; messages: Array<{ role: string; name?: string; text: string; at: string }> }

/** Reads one member of a zip archive (stored or deflated; no zip64), bounded by MAX_EXPORT_BYTES. */
export function readZipMember(path: string, match: (name: string) => boolean): Buffer | undefined {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const tailLength = Math.min(size, 65_557), tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This is not a zip archive.');
    const entries = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize > 64 * 1024 * 1024) throw new Error('This archive is too large to read (zip64 is not supported).');
    const directory = Buffer.alloc(cdSize); readSync(fd, directory, 0, cdSize, cdOffset);
    let offset = 0;
    for (let index = 0; index < entries && offset + 46 <= directory.length; index++) {
      if (directory.readUInt32LE(offset) !== 0x02014b50) break;
      const method = directory.readUInt16LE(offset + 10), compressed = directory.readUInt32LE(offset + 20), uncompressed = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28), extraLength = directory.readUInt16LE(offset + 30), commentLength = directory.readUInt16LE(offset + 32), local = directory.readUInt32LE(offset + 42);
      const name = directory.toString('utf8', offset + 46, offset + 46 + nameLength);
      offset += 46 + nameLength + extraLength + commentLength;
      if (!match(name)) continue;
      if (compressed > MAX_EXPORT_BYTES || uncompressed > MAX_EXPORT_BYTES) throw new Error(`${name} is larger than ${MAX_EXPORT_BYTES / 1024 / 1024} MB; split the export first.`);
      const header = Buffer.alloc(30); readSync(fd, header, 0, 30, local);
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('The archive is damaged.');
      const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const data = Buffer.alloc(compressed); readSync(fd, data, 0, compressed, start);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_EXPORT_BYTES });
      throw new Error(`${name} uses an unsupported compression method.`);
    }
    return undefined;
  } finally { closeSync(fd); }
}
function chatGptText(content: Record<string, unknown> | undefined): string {
  if (!content) return '';
  const type = str(content.content_type);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  if (type === 'text' || type === 'multimodal_text') return parts.map(part => typeof part === 'string' ? part : record(part)?.content_type === 'audio_transcription' ? str(record(part)?.text) : '[image]').filter(Boolean).join('\n');
  if (type === 'code') return `\`\`\`${str(content.language) || ''}\n${str(content.text)}\n\`\`\``;
  if (type === 'execution_output' || type === 'tether_quote' || type === 'tether_browsing_display') return str(content.text) || str(content.result);
  return str(content.text) || parts.filter(part => typeof part === 'string').join('\n');
}
/** Parses a ChatGPT `conversations.json` (or the zip that holds it) into per-conversation active branches. */
export async function readChatGptExport(path: string): Promise<ChatGptConversation[]> {
  const size = (await fs.stat(path)).size;
  let text: string;
  if (/\.zip$/i.test(path)) {
    const member = readZipMember(path, name => /(?:^|\/)conversations\.json$/.test(name));
    if (!member) throw new Error('conversations.json was not found in this archive.');
    text = member.toString('utf8');
  } else {
    if (size > MAX_EXPORT_BYTES) throw new Error(`This file is larger than ${MAX_EXPORT_BYTES / 1024 / 1024} MB; split the export first.`);
    text = await fs.readFile(path, 'utf8');
  }
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(record(parsed)?.conversations) ? (record(parsed)!.conversations as unknown[]) : [];
  const conversations: ChatGptConversation[] = [];
  for (const raw of list) {
    const conversation = record(raw); if (!conversation) continue;
    const id = str(conversation.conversation_id) || str(conversation.id); if (!id) continue;
    const mapping = record(conversation.mapping) ?? {};
    const createdAt = isoAt(conversation.create_time, new Date(0).toISOString()), updatedAt = isoAt(conversation.update_time, createdAt);
    // The active branch: walk parents from current_node (falling back to the deepest node), then reverse.
    let node = str(conversation.current_node);
    if (!node || !mapping[node]) { for (const [key, value] of Object.entries(mapping)) if (!(record(value)?.children as unknown[] | undefined)?.length) { node = key; break; } }
    const chain: Record<string, unknown>[] = []; const seen = new Set<string>();
    while (node && mapping[node] && !seen.has(node) && chain.length < 10_000) { seen.add(node); const entry = record(mapping[node])!; chain.push(entry); node = str(entry.parent); }
    chain.reverse();
    const messages: ChatGptConversation['messages'] = [];
    for (const entry of chain) {
      const message = record(entry.message); if (!message) continue;
      const author = record(message.author), role = str(author?.role), metadata = record(message.metadata);
      if (!role || role === 'system' || metadata?.is_visually_hidden_from_conversation === true) continue;
      const body = chatGptText(record(message.content)); if (!body.trim()) continue;
      messages.push({ role, ...(str(author?.name) ? { name: str(author?.name) } : {}), text: body, at: isoAt(message.create_time, createdAt) });
    }
    conversations.push({ id, title: str(conversation.title) || importTitle(messages.find(message => message.role === 'user')?.text ?? '', 'ChatGPT conversation'), createdAt, updatedAt, messages });
  }
  return conversations;
}
export function* chatGptEvents(conversation: ChatGptConversation): Generator<ImportedEvent> {
  yield { type: 'meta', meta: { sessionId: conversation.id, title: conversation.title, startedAt: conversation.createdAt } };
  for (const message of conversation.messages) {
    if (message.role === 'user') yield { type: 'item', item: { kind: 'user', text: message.text, createdAt: message.at } };
    else if (message.role === 'assistant') yield { type: 'item', item: { kind: 'assistant', text: message.text, status: 'completed', createdAt: message.at } };
    else yield { type: 'item', item: { kind: 'tool', text: message.name ?? message.role, status: 'completed', createdAt: message.at, data: { type: 'functionCall', name: message.name ?? message.role, output: message.text } } };
  }
}

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

export interface DiscoveryCache { entries: Map<string, { mtimeMs: number; size: number; session: DiscoveredSession }> }
export const createDiscoveryCache = (): DiscoveryCache => ({ entries: new Map() });
const numericDirs = async (path: string) => { try { return (await fs.readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(entry => entry.name).sort().reverse(); } catch { return []; } };
const ROLLOUT_ID = /rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Every Codex rollout file under sessions/ (YYYY/MM/DD) and archived_sessions/. */
export async function listCodexRollouts(codexHome: string): Promise<Array<{ path: string; archived: boolean }>> {
  const files: Array<{ path: string; archived: boolean }> = [];
  const sessions = join(codexHome, 'sessions');
  for (const year of await numericDirs(sessions)) for (const month of await numericDirs(join(sessions, year))) for (const day of await numericDirs(join(sessions, year, month))) {
    const folder = join(sessions, year, month, day);
    try { for (const name of await fs.readdir(folder)) if (/^rollout-.*\.jsonl$/.test(name)) files.push({ path: join(folder, name), archived: false }); } catch { /* raced away */ }
  }
  try { for (const name of await fs.readdir(join(codexHome, 'archived_sessions'))) if (/^rollout-.*\.jsonl$/.test(name)) files.push({ path: join(codexHome, 'archived_sessions', name), archived: true }); } catch { /* none archived */ }
  return files;
}
/** `session_index.jsonl`: user-given thread names, last write wins. */
async function codexThreadNames(codexHome: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try { for await (const row of jsonLines(join(codexHome, 'session_index.jsonl'))) if (typeof row.id === 'string' && typeof row.thread_name === 'string' && row.thread_name.trim()) names.set(row.id, row.thread_name.trim()); } catch { /* no index */ }
  return names;
}
interface CodexThreadRow { id: string; cwd: string; title: string; first_user_message: string; updated_at_ms: number | null; updated_at: number | null; archived: number; model: string | null; source: string; rollout_path: string }
/** The Codex thread index, opened read-only only when SQLite would not need to create its shared-memory file. */
function codexThreadIndex(codexHome: string): Map<string, CodexThreadRow> {
  const rows = new Map<string, CodexThreadRow>();
  let file: string | undefined;
  try {
    const candidates = statSync(codexHome).isDirectory() ? readdirSync(codexHome).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0])) : [];
    file = candidates[0] ? join(codexHome, candidates[0]) : undefined;
  } catch { return rows; }
  if (!file) return rows;
  try {
    // A WAL database opened read-only needs its -shm; never create one inside the user's store.
    const header = Buffer.alloc(20); const fd = openSync(file, 'r'); try { readSync(fd, header, 0, 20, 0); } finally { closeSync(fd); }
    const wal = header[18] === 2 || header[19] === 2;
    if (wal && !statSync(`${file}-shm`, { throwIfNoEntry: false })) return rows;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const row of db.prepare("SELECT id, cwd, title, first_user_message, updated_at_ms, updated_at, archived, model, source, rollout_path FROM threads WHERE source IN ('cli', 'vscode', 'exec')").all() as unknown as CodexThreadRow[]) rows.set(row.id, row);
    } finally { db.close(); }
  } catch { /* unreadable index: discovery falls back to the rollout heads */ }
  return rows;
}
/** `originator` from a rollout's session_meta line (who started the session: `codex_cli_rs`, `muster`, …), from a bounded head read. */
export function rolloutOriginator(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(32 * 1024), read = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, read).toString('utf8'), end = head.indexOf('\n');
    return /"originator"\s*:\s*"([^"\\]{1,64})"/.exec(end >= 0 ? head.slice(0, end) : head)?.[1];
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}
/** Head scan of one rollout: its session meta and first prompt. Reads at most DISCOVERY_HEAD_BYTES. */
async function codexHead(path: string): Promise<{ meta: SessionMeta; first?: string; subagent: boolean }> {
  let meta: SessionMeta = {}, first: string | undefined;
  for await (const event of readCodexRollout(path, DISCOVERY_HEAD_BYTES)) {
    if (event.type === 'meta') meta = event.meta;
    else if (event.type === 'item' && event.item.kind === 'user') { first = event.item.text; break; }
  }
  return { meta, first, subagent: meta.source === 'subagent' };
}
export async function discoverCodexSessions(codexHome: string, cache: DiscoveryCache = createDiscoveryCache()): Promise<DiscoveredSession[]> {
  const files = await listCodexRollouts(codexHome);
  if (!files.length) return [];
  const [names, index] = [await codexThreadNames(codexHome), codexThreadIndex(codexHome)];
  const sessions: DiscoveredSession[] = [];
  for (const file of files) {
    let stat; try { stat = await fs.stat(file.path); } catch { continue; }
    const key = `codex:${file.path}`, cached = cache.entries.get(key);
    const sessionIdFromName = ROLLOUT_ID.exec(basename(file.path))?.[1]?.toLowerCase();
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      const session = { ...cached.session, title: (sessionIdFromName && names.get(sessionIdFromName)) || cached.session.title };
      sessions.push(session); continue;
    }
    const indexed = sessionIdFromName ? index.get(sessionIdFromName) : undefined;
    let session: DiscoveredSession;
    const indexedTitle = indexed ? stripInjectedContext(indexed.title || '') || stripInjectedContext(indexed.first_user_message || '') : '';
    if (indexed && indexedTitle) {
      session = { source: 'codex', sessionId: indexed.id, path: file.path, ...(indexed.cwd ? { cwd: indexed.cwd } : {}), title: importTitle(indexedTitle, 'Codex session'),
        updatedAt: isoAt(indexed.updated_at_ms ?? indexed.updated_at ?? undefined, stat.mtime.toISOString()), sizeBytes: stat.size, ...(file.archived || indexed.archived ? { archived: true } : {}), ...(indexed.model ? { model: indexed.model } : {}), messageCount: null };
    } else {
      const head = await codexHead(file.path);
      if (head.subagent) continue;
      const sessionId = head.meta.sessionId || sessionIdFromName; if (!sessionId) continue;
      if (!head.first && index.size && !indexed) continue; // an indexed store without this thread: an internal (subagent) rollout
      session = { source: 'codex', sessionId, path: file.path, ...(head.meta.cwd ? { cwd: head.meta.cwd } : {}), title: importTitle(head.first ?? '', 'Codex session'), updatedAt: stat.mtime.toISOString(), sizeBytes: stat.size, ...(file.archived ? { archived: true } : {}), ...(head.meta.model ? { model: head.meta.model } : {}), messageCount: null };
    }
    const originator = rolloutOriginator(file.path);
    if (originator) session.originator = originator;
    cache.entries.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, session });
    sessions.push({ ...session, title: names.get(session.sessionId) || session.title });
  }
  return sessions;
}

export async function discoverClaudeSessions(claudeDir: string, cache: DiscoveryCache = createDiscoveryCache()): Promise<DiscoveredSession[]> {
  const projects = join(claudeDir, 'projects');
  let slugs: string[] = []; try { slugs = (await fs.readdir(projects, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { return []; }
  const sessions: DiscoveredSession[] = [];
  for (const slug of slugs) {
    let names: string[] = []; try { names = (await fs.readdir(join(projects, slug), { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => entry.name); } catch { continue; }
    for (const name of names) {
      const path = join(projects, slug, name);
      let stat; try { stat = await fs.stat(path); } catch { continue; }
      const key = `claude:${path}`, cached = cache.entries.get(key);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) { sessions.push(cached.session); continue; }
      let meta: SessionMeta = {}, first: string | undefined, sawTurn = false;
      for await (const event of readClaudeTranscript(path, DISCOVERY_HEAD_BYTES)) {
        if (event.type === 'meta') meta = event.meta;
        else if (event.type === 'item') { sawTurn = true; if (event.item.kind === 'user') { first = event.item.text; break; } }
      }
      if (!sawTurn && !first) continue;
      // ai-title / summary lines are appended as the session goes, so the newest sits near the end.
      let stored = meta.title;
      for (const line of tailText(path, DISCOVERY_TAIL_BYTES).split('\n')) {
        if (!line.includes('"ai-title"') && !line.includes('"summary"')) continue;
        try { const row = record(JSON.parse(line)); if (row?.type === 'ai-title' && typeof row.aiTitle === 'string' && row.aiTitle.trim()) stored = row.aiTitle.trim(); else if (row?.type === 'summary' && typeof row.summary === 'string' && !stored) stored = row.summary; } catch { /* partial line */ }
      }
      const session: DiscoveredSession = { source: 'claude-code', sessionId: meta.sessionId || basename(name, '.jsonl'), path, ...(meta.cwd ? { cwd: meta.cwd } : {}), title: stored ? importTitle(stored, 'Claude Code session') : importTitle(first ?? '', 'Claude Code session'), updatedAt: stat.mtime.toISOString(), sizeBytes: stat.size, ...(meta.model ? { model: meta.model } : {}), messageCount: null };
      cache.entries.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, session });
      sessions.push(session);
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------------------------
// OpenCode (W6-E.b2)
// ---------------------------------------------------------------------------------------------
// OpenCode keeps one JSON file per record under `<data>/storage` (`<data>` is `$XDG_DATA_HOME/opencode`,
// by default `~/.local/share/opencode`):
//   session/<projectID>/<sessionID>.json  {id, projectID, directory, parentID?, title, time: {created, updated}}
//   message/<sessionID>/<messageID>.json  {id, sessionID, role, time: {created}, modelID?}
//   part/<messageID>/<partID>.json        {id, messageID, type: text|reasoning|tool|file|compaction|…, text?, synthetic?, callID?, tool?, state?}
// Ids are time-ordered, so a lexical sort is chronological. Every path is built from validated ids under
// the storage root, symlinks are never followed, and nothing is ever written.

const OPENCODE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OPENCODE_RECORD_BYTES = 256 * 1024;
const OPENCODE_PART_BYTES = 4 * 1024 * 1024;
export const openCodeDataDir = (env: NodeJS.ProcessEnv, home: string): string => join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode');
/** A regular file (never a symlink) of at most `max` bytes, parsed as a JSON object. */
async function openCodeRecord(path: string, max: number): Promise<Record<string, unknown> | undefined> {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.size > max) return undefined;
    return record(JSON.parse(await fs.readFile(path, 'utf8')));
  } catch { return undefined; }
}
/** Ids of `<id>.json` regular files (or of real subdirectories) in `dir`, sorted. */
async function openCodeIds(dir: string, kind: 'file' | 'dir'): Promise<string[]> {
  try {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory()) return [];
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter(entry => kind === 'dir' ? entry.isDirectory() && OPENCODE_ID.test(entry.name) : entry.isFile() && entry.name.endsWith('.json') && OPENCODE_ID.test(entry.name.slice(0, -5)))
      .map(entry => kind === 'dir' ? entry.name : entry.name.slice(0, -5)).sort();
  } catch { return []; }
}
const openCodeTime = (value: unknown, fallback: string): string => { const time = record(value); return isoAt(time?.updated ?? time?.completed ?? time?.created, fallback); };
async function openCodeMessages(storage: string, sessionId: string): Promise<Array<{ id: string; role: string; createdAt: string; model?: string }>> {
  const dir = join(storage, 'message', sessionId), rows: Array<{ id: string; role: string; createdAt: string; at: number; model?: string }> = [];
  for (const id of await openCodeIds(dir, 'file')) {
    if (rows.length >= MAX_ITEMS_PER_SESSION) break;
    const message = await openCodeRecord(join(dir, `${id}.json`), OPENCODE_RECORD_BYTES);
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const created = record(message.time)?.created, model = str(message.modelID) || str(record(message.model)?.modelID);
    rows.push({ id, role: str(message.role), createdAt: isoAt(created, new Date(0).toISOString()), at: typeof created === 'number' ? created : 0, ...(model ? { model } : {}) });
  }
  return rows.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).map(({ at: _at, ...row }) => row);
}
async function openCodeParts(storage: string, messageId: string): Promise<Record<string, unknown>[]> {
  const dir = join(storage, 'part', messageId), parts: Record<string, unknown>[] = [];
  for (const id of await openCodeIds(dir, 'file')) { const part = await openCodeRecord(join(dir, `${id}.json`), OPENCODE_PART_BYTES); if (part) parts.push(part); }
  return parts;
}
function openCodeToolImport(part: Record<string, unknown>, createdAt: string): ImportedItem | undefined {
  const ref = str(part.callID) || str(part.id); if (!ref) return undefined;
  const name = str(part.tool), state = record(part.state) ?? {}, input = record(state.input) ?? {};
  const path = str(input.filePath) || str(input.path);
  const tool = (data: Record<string, unknown>, text: string): ImportedItem => ({ kind: 'tool', text, status: 'running', createdAt, ref, data: { name: text, ...data } });
  switch (name) {
    case 'bash': return tool({ type: 'commandExecution', command: str(input.command), ...(str(input.description) ? { description: str(input.description) } : {}) }, str(input.command).replace(/\s+/g, ' ').slice(0, 240) || 'bash');
    case 'read': return tool({ type: 'fileRead', path }, path || 'read');
    case 'write': return tool({ type: 'fileChange', changes: [{ path, kind: { type: 'add' }, diff: str(input.content) }] }, path || 'write');
    case 'edit': return tool({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, oldContent: str(input.oldString), newContent: str(input.newString) }] }, path || 'edit');
    case 'grep': case 'glob': return tool({ type: 'commandExecution', command: `${name} ${str(input.pattern)}`, commandActions: [{ type: name === 'grep' ? 'search' : 'listFiles', ...(name === 'grep' ? { query: str(input.pattern) } : {}), path }] }, `${name} ${str(input.pattern)}`.slice(0, 240));
    case 'list': return tool({ type: 'commandExecution', command: `ls ${path}`, commandActions: [{ type: 'listFiles', path }] }, `ls ${path}`.slice(0, 240));
    case 'webfetch': return tool({ type: 'functionCall', tool: name, arguments: input }, `webfetch ${str(input.url)}`.slice(0, 240));
    case 'todowrite': return tool({ type: 'todoList', tool: name, todos: Array.isArray(input.todos) ? input.todos : [], arguments: JSON.stringify(input) }, 'todowrite');
    case 'task': return tool({ type: 'functionCall', tool: name, arguments: input }, `Agent: ${str(input.description) || str(input.subagent_type) || name}`.slice(0, 240));
    default: return tool({ type: 'functionCall', tool: name, arguments: input }, name || 'tool');
  }
}
const openCodeUserText = (parts: Record<string, unknown>[]): string => parts.map(part => part.type === 'text' && part.synthetic !== true ? str(part.text) : part.type === 'file' ? `[file: ${str(part.filename) || str(part.url).split('/').at(-1) || 'attachment'}]` : '').filter(text => text.trim()).join('\n').trim();

/** Streams one OpenCode session (by its session record file) as normalized events. */
export async function* readOpenCodeSession(sessionPath: string, dataDir: string): AsyncGenerator<ImportedEvent> {
  const storage = join(dataDir, 'storage');
  if (!sessionPath.startsWith(join(storage, 'session') + sep)) throw new Error('This OpenCode session is outside the OpenCode store.');
  const session = await openCodeRecord(sessionPath, OPENCODE_RECORD_BYTES);
  const sessionId = str(session?.id);
  if (!session || !OPENCODE_ID.test(sessionId)) throw new Error('This OpenCode session could not be read.');
  const fallback = openCodeTime(session.time, new Date(0).toISOString());
  const meta: SessionMeta = { sessionId, startedAt: isoAt(record(session.time)?.created, fallback), ...(str(session.directory) ? { cwd: str(session.directory) } : {}), ...(str(session.title) ? { title: str(session.title) } : {}) };
  let announced = false;
  for (const message of await openCodeMessages(storage, sessionId)) {
    if (message.model) meta.model = message.model;
    if (!announced) { announced = true; yield { type: 'meta', meta }; }
    const parts = await openCodeParts(storage, message.id), at = message.createdAt;
    if (message.role === 'user') {
      const text = openCodeUserText(parts);
      if (text) yield { type: 'item', item: { kind: 'user', text, createdAt: at } };
      continue;
    }
    for (const part of parts) {
      if (part.type === 'text' && part.synthetic !== true && str(part.text).trim()) yield { type: 'item', item: { kind: 'assistant', text: str(part.text), status: 'completed', createdAt: at } };
      else if (part.type === 'reasoning' && str(part.text).trim()) yield { type: 'item', item: { kind: 'reasoning', text: str(part.text), status: 'completed', createdAt: at } };
      else if (part.type === 'compaction') yield { type: 'item', item: { kind: 'notice', text: 'Context compacted', status: 'completed', createdAt: at, data: { kind: 'context-compacted' } } };
      else if (part.type === 'tool') {
        const item = openCodeToolImport(part, at); if (!item) continue;
        yield { type: 'item', item };
        const state = record(part.state) ?? {};
        if (state.status === 'completed' || state.status === 'error') yield { type: 'result', ref: item.ref!, output: str(state.output) || str(state.error), status: state.status === 'error' ? 'failed' : 'completed', createdAt: at };
      }
    }
  }
  if (!announced) yield { type: 'meta', meta };
}

/** Top-level OpenCode sessions (child/subagent sessions are skipped), from the session records alone. */
export async function discoverOpenCodeSessions(dataDir: string, cache: DiscoveryCache = createDiscoveryCache()): Promise<DiscoveredSession[]> {
  const storage = join(dataDir, 'storage'), root = join(storage, 'session'), sessions: DiscoveredSession[] = [];
  for (const project of await openCodeIds(root, 'dir')) {
    for (const id of await openCodeIds(join(root, project), 'file')) {
      const path = join(root, project, `${id}.json`);
      let stat; try { stat = await fs.lstat(path); } catch { continue; }
      if (!stat.isFile()) continue;
      const key = `opencode:${path}`, cached = cache.entries.get(key);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) { sessions.push(cached.session); continue; }
      const row = await openCodeRecord(path, OPENCODE_RECORD_BYTES);
      const sessionId = str(row?.id);
      if (!row || !OPENCODE_ID.test(sessionId) || str(row.parentID)) continue;
      let title = str(row.title).trim();
      // OpenCode names an untitled session "New session - <timestamp>"; the first prompt says more.
      if (!title || /^New session - /i.test(title)) {
        for (const message of (await openCodeMessages(storage, sessionId)).slice(0, 8)) {
          if (message.role !== 'user') continue;
          const text = openCodeUserText(await openCodeParts(storage, message.id)); if (text) { title = text; break; }
        }
      }
      const session: DiscoveredSession = { source: 'opencode', sessionId, path, ...(str(row.directory) ? { cwd: str(row.directory) } : {}), title: importTitle(title, 'OpenCode session'), updatedAt: openCodeTime(row.time, stat.mtime.toISOString()), sizeBytes: stat.size, messageCount: null };
      cache.entries.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, session });
      sessions.push(session);
    }
  }
  return sessions;
}
