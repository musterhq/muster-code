import {spawn as nodeSpawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {cliSpawn, jsonLines, loadImages, text} from './shared.ts';
import {killTree} from './cli-common.ts';
import {launcherSpec} from '../launcher-script.ts';
import type {AdapterRunInput, AdapterRunResult, RunnableAdapter} from './types.ts';
import {CLAUDE_CODE_ALIASES, CLAUDE_CODE_DEFAULT} from './claude-models.ts';
import {MESSAGE_BOUNDARY_EVENT} from '../transcript-wire.ts';

export type Spawn = (command: string, args: string[], options: {cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; windowsHide?: boolean; detached?: boolean}) => ChildProcess;
/** Claude Code's default and family aliases only; the versioned list comes from claude-models.ts. */
export const CLAUDE_CODE_MODELS = [CLAUDE_CODE_DEFAULT, ...CLAUDE_CODE_ALIASES];

/** read-only (and every Ask/Plan chat) → plan; workspace → acceptEdits; full → bypassPermissions. */
export const claudePermissionMode = (mode: AdapterRunInput['permissionMode']) => mode === 'full' ? 'bypassPermissions' : mode === 'workspace' ? 'acceptEdits' : 'plan';

/** #427: the sub-agent tools (Task, and Agent in newer builds) are allowed in every permission mode, so a print-mode run
 *  (which cannot ask) never denies a sub-agent. A sub-agent still works under the chat's permission mode. */
export const CLAUDE_SUBAGENT_TOOLS = ['Task', 'Agent'];
function toolArgs(servers: AdapterRunInput['mcpServers']): string[] {
  const names = Object.keys(servers ?? {});
  return [...(names.length ? ['--mcp-config', JSON.stringify({mcpServers: Object.fromEntries(Object.entries(servers ?? {}).map(([name, spec]) => [name, spec.args ? spec : {...spec, ...launcherSpec(spec.command)}]))})] : []),
    '--allowedTools', ...CLAUDE_SUBAGENT_TOOLS, ...names.map(name => `mcp__${name}`)];
}

/** #653: Claude Code's host tools that run commands or change files, denied outright while the chat is sandboxed. Reads
 *  (Read, Grep, Glob, LS) stay; commands and edits go through the muster_sandbox tools. */
export const CLAUDE_SANDBOX_DENIED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

export function claudeArgs(input: AdapterRunInput, sessionId: string): string[] {
  const alias = input.model.replace(/^claude-code\//, '');
  return ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    // The turn arrives as stream-json user messages on stdin (images as content blocks); stdin stays open while the
    // turn runs so a steer can join it as another user message.
    '--input-format', 'stream-json',
    // Muster's own tool servers (in-app browser, terminal, mailbox…): loaded alongside the user's, and allowed, since
    // they are first-party and each enforces its own lease and scope. Both flags are variadic, so a flag follows them.
    ...toolArgs(input.mcpServers),
    // Variadic too, so a flag follows it. A deny rule wins over every permission mode and allow rule.
    ...(input.sandboxed ? ['--disallowedTools', ...CLAUDE_SANDBOX_DENIED_TOOLS] : []),
    '--permission-mode', claudePermissionMode(input.sandboxed ? 'read-only' : input.permissionMode),
    ...(alias && alias !== 'default' ? ['--model', alias] : []),
    ...(input.reasoningEffort ? ['--effort', input.reasoningEffort] : []),
    ...(input.resumeThreadId ? ['--resume', input.resumeThreadId] : ['--session-id', sessionId]),
    ...(input.instructions ? ['--append-system-prompt', input.instructions] : [])];
}

/**
 * Patch for a tool_use before it runs. A new file's position is known (line 1 of an empty file);
 * an edit's is not until Claude Code reports its structuredPatch, so the header carries no
 * positions and the transcript leaves the gutter blank instead of inventing line 1.
 */
const quoteDiff = (before: string, after: string) => {
  const lines = (text: string) => { const out = text.split('\n'); if (out.length > 1 && out.at(-1) === '') out.pop(); return out; };
  const removed = before ? lines(before) : [], added = after ? lines(after) : [];
  const header = removed.length ? '@@ @@' : `@@ -0,0 +1,${added.length} @@`;
  return [header, ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join('\n');
};
/** Claude Code's own record of an applied edit: real hunks with line numbers and context. */
export function claudeResultPatch(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = result as Record<string, unknown>;
  const hunks = Array.isArray(value.structuredPatch) ? value.structuredPatch.filter((hunk): hunk is Record<string, unknown> => !!hunk && typeof hunk === 'object') : [];
  const patch = hunks.flatMap(hunk => {
    const lines = Array.isArray(hunk.lines) ? hunk.lines.filter((line): line is string => typeof line === 'string') : [];
    const n = (key: string) => typeof hunk[key] === 'number' ? hunk[key] as number : undefined;
    const oldStart = n('oldStart'), oldLines = n('oldLines'), newStart = n('newStart'), newLines = n('newLines');
    return oldStart === undefined || newStart === undefined ? [] : [`@@ -${oldStart},${oldLines ?? 0} +${newStart},${newLines ?? 0} @@`, ...lines];
  }).join('\n');
  if (patch) return patch;
  // A created file: structuredPatch is empty and the content is the whole file.
  if (value.type === 'create' && typeof value.content === 'string') {
    const lines = value.content.split('\n'); if (lines.at(-1) === '') lines.pop();
    return lines.length ? [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)].join('\n') : undefined;
  }
  return undefined;
}
/** A Claude Code tool_use block as the Codex item shape the timeline already renders. */
export function claudeToolItem(id: string, name: string, args: Record<string, unknown>, cwd: string, childThreadId?: string): Record<string, unknown> {
  const path = text(args.file_path) || text(args.notebook_path) || text(args.path);
  switch (name) {
    case 'Bash': return {id, type: 'commandExecution', command: text(args.command), cwd, ...(text(args.description) ? {title: text(args.description)} : {})};
    case 'Read': return {id, type: 'fileRead', path, name: path};
    case 'Grep': return {id, type: 'commandExecution', command: `grep ${text(args.pattern)}`, cwd, commandActions: [{type: 'search', query: text(args.pattern), path}]};
    case 'Glob': return {id, type: 'commandExecution', command: `glob ${text(args.pattern)}`, cwd, commandActions: [{type: 'search', query: text(args.pattern), path}]};
    case 'LS': return {id, type: 'commandExecution', command: `ls ${path}`, cwd, commandActions: [{type: 'listFiles', path}]};
    case 'Write': return {id, type: 'fileChange', changes: [{path, kind: 'add', diff: quoteDiff('', text(args.content))}]};
    case 'Edit': return {id, type: 'fileChange', changes: [{path, kind: 'update', diff: quoteDiff(text(args.old_string), text(args.new_string))}]};
    case 'MultiEdit': return {id, type: 'fileChange', changes: [{path, kind: 'update', diff: (Array.isArray(args.edits) ? args.edits : []).slice(0, 64).map(edit => quoteDiff(text((edit as Record<string, unknown>)?.old_string), text((edit as Record<string, unknown>)?.new_string))).join('\n')}]};
    case 'NotebookEdit': return {id, type: 'fileChange', changes: [{path, kind: 'update', diff: quoteDiff('', text(args.new_source))}]};
    case 'WebSearch': return {id, type: 'webSearch', query: text(args.query)};
    case 'TodoWrite': return {id, type: 'todoList', items: (Array.isArray(args.todos) ? args.todos : []).slice(0, 100).map(todo => ({text: text((todo as Record<string, unknown>)?.content), status: text((todo as Record<string, unknown>)?.status)}))};
    case 'Task': case 'Agent': {
      const role = text(args.subagent_type) || 'agent', prompt = text(args.prompt) || text(args.description), title = text(args.description);
      return {id, type: 'collabAgentToolCall', tool: 'spawnAgent', prompt, ...(args.run_in_background === true ? {background: true} : {}),
        // The child thread is `<session>:<Task tool_use id>`: its own events carry that id as parent_tool_use_id.
        ...(childThreadId ? {receiverThreadIds: [childThreadId], receiverAgents: [{threadId: childThreadId, ...(title ? {name: title.slice(0, 80)} : {}), role, prompt, ...(text(args.model) ? {model: text(args.model)} : {})}]}
          : {receiverAgents: [{name: role}]})};
    }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return {id, type: 'mcpToolCall', server: mcp[1], tool: mcp[2], arguments: args};
  return {id, type: 'dynamicToolCall', tool: name, name, arguments: args};
}
const resultText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part && typeof part === 'object' && (part as {type?: unknown}).type === 'text' ? text((part as {text?: unknown}).text) : '').filter(Boolean).join('\n') : '';

/** How a Claude Code task_notification / task_updated status reads as a child state (killed is a stop, not a failure). */
export /** Longest a background subagent may run after its parent's turn ended before it is marked interrupted. */
const BACKGROUND_TIMEOUT_MS = 30 * 60_000;
export const claudeTaskState = (status: unknown): 'completed' | 'failed' | 'interrupted' | undefined =>
  status === 'completed' ? 'completed' : status === 'failed' || status === 'error' ? 'failed' : status === 'killed' || status === 'stopped' || status === 'cancelled' ? 'interrupted' : undefined;
/** The subagent's own final report without the harness's hand-back frame around it. */
const handBack = (content: string): string => { const at = content.indexOf('The report follows:\n'); return (at < 0 ? content : content.slice(at + 20)).replace(/^ {2}/gm, '').replace(/\nagentId: [\s\S]*$/, '').trim(); };

/** The turn's stdin: the plain prompt, or with images one stream-json user message whose
 *  image content blocks carry the attachment bytes (the model sees them directly). */
export const claudeUserMessage = (text: string): string => JSON.stringify({type: 'user', message: {role: 'user', content: [{type: 'text', text}]}}) + '\n';
/** A steer is written as another user message. Said bare, the model often answers just it and ends the turn with the
 *  original task half done: frame it as a correction to fold in, then keep working. */
export const claudeSteerText = (text: string): string =>
  `[The user sent this while you were working. Take it into account and continue the current task; do not stop after acknowledging it. If it changes the task, adjust and keep going until the task is done.]\n\n${text}`;
export function claudeStdin(input: Pick<AdapterRunInput, 'prompt' | 'images'>): string {
  if (!input.images?.length) return claudeUserMessage(input.prompt);
  const images = loadImages(input.images);
  const skipped = input.images.length - images.length;
  const content = [...images.map(image => ({type: 'image', source: {type: 'base64', media_type: image.mediaType, data: image.data}})),
    {type: 'text', text: skipped ? `${input.prompt}\n\n(${skipped} attached image${skipped === 1 ? ' was' : 's were'} too large or unsupported and not included.)` : input.prompt}];
  return JSON.stringify({type: 'user', message: {role: 'user', content}}) + '\n';
}

/** Headless Claude Code (`claude -p --output-format stream-json`) in the chat folder. */
const STEER_GRACE_MS = 2500;
export function claudeCodeAdapter(options: {binary: string; env?: NodeJS.ProcessEnv; spawn?: Spawn; killGraceMs?: number; backgroundTimeoutMs?: number; steerGraceMs?: number}): RunnableAdapter {
  const spawn = options.spawn ?? (nodeSpawn as unknown as Spawn);
  return {kind: 'cli', run(input) {
    return new Promise<AdapterRunResult>(resolve => {
      const sessionId = input.resumeThreadId ?? randomUUID(), turnId = randomUUID();
      // The subscription row must run on the Claude sign-in; an API key in the host env
      // would silently switch billing. That key has its own Anthropic API row.
      const env = {...(options.env ?? process.env), ...(input.env ?? {})}; delete env.ANTHROPIC_API_KEY;
      let child: ChildProcess;
      const launch = cliSpawn(options.binary, claudeArgs(input, sessionId), env);
      try { child = spawn(launch.command, launch.args, {cwd: input.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'}); }
      catch (error) { resolve({status: 'failed', finalMessage: '', dispatchState: 'not-dispatched', errorMessage: `Claude Code could not start: ${error instanceof Error ? error.message : String(error)}`}); return; }
      let accepted = false, settled = false, final: {ok: boolean; text: string} | undefined, stderr = '', streamedText = false;
      // `pending` counts results still owed. The CLI folds a message that arrives mid-turn into that turn, so several
      // steers can share ONE result: after a result, stdin stays open for a short grace while steers are unanswered.
      let pending = 1, inputClosed = false, unanswered = 0, grace: ReturnType<typeof setTimeout> | undefined;
      const graceMs = options.steerGraceMs ?? STEER_GRACE_MS;
      const closeInput = () => { if (inputClosed) return; inputClosed = true; try { child.stdin?.end(); } catch { /* already closed */ } };
      // Token usage (#94). Claude Code repeats an API message's usage on each of its content blocks' `assistant` events,
      // with the output count as of message_start; the final count arrives on that message's `message_delta` stream event,
      // and each `result` carries the totals of its own turn (per result, not per process). So each parent API message is
      // reported once, when its usage is final (message_delta) or its tool results, the next message, the result or the
      // exit end it, and a result only adds what its turn's messages under-reported. Cache reads are cached input; cache
      // writes are input. Counts the CLI did not report stay unknown; a message without its final count is flagged `partial`.
      type Tokens = {input?: number; cached?: number; output?: number};
      const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
      const tokensOf = (raw: unknown): Tokens | null => {
        if (!raw || typeof raw !== 'object') return null;
        const usage = raw as Record<string, unknown>, fresh = count(usage.input_tokens), output = count(usage.output_tokens);
        const read = count(usage.cache_read_input_tokens) ?? 0, written = count(usage.cache_creation_input_tokens) ?? 0;
        const tokens: Tokens = {...(fresh !== undefined ? {input: fresh + read + written, cached: read} : {}), ...(output !== undefined ? {output} : {})};
        return tokens.input === undefined && tokens.output === undefined ? null : tokens;
      };
      const fields = ['input', 'cached', 'output'] as const;
      let openMessage: {id: string; tokens: Tokens; final: boolean} | undefined, streamId: string | undefined;
      /** Messages already reported this turn: a late event for one adds nothing (the result reconciles). */
      const reportedIds = new Set<string>();
      let turnTokens = {input: 0, cached: 0, output: 0};
      const emitUsage = (tokens: Tokens, flags: {partial?: true; reconciliation?: true}) => {
        if (!fields.some(key => (tokens[key] ?? 0) > 0)) return;
        for (const key of fields) turnTokens[key] += tokens[key] ?? 0;
        const last = {...(tokens.input !== undefined ? {inputTokens: tokens.input, cachedInputTokens: tokens.cached ?? 0} : {}), ...(tokens.output !== undefined ? {outputTokens: tokens.output} : {})};
        // A reconciliation is spend, not one request's context, so the context meter ignores it.
        input.onEvent('thread/tokenUsage/updated', {threadId: sessionId, turnId, tokenUsage: {last, ...flags}});
      };
      const flushUsage = () => { if (!openMessage) return; const done = openMessage; openMessage = undefined; if (done.id) reportedIds.add(done.id); emitUsage(done.tokens, done.final ? {} : {partial: true}); };
      const observeUsage = (id: string | undefined, raw: unknown, final = false) => {
        if (id && reportedIds.has(id)) return;
        const tokens = tokensOf(raw);
        if (openMessage && id !== undefined && openMessage.id !== id) flushUsage();
        if (!tokens) { if (final) flushUsage(); return; }
        if (!openMessage) openMessage = {id: id ?? '', tokens: {}, final: false};
        // Counts only grow within a message; later events carry the same input and a larger output.
        for (const key of fields) if (tokens[key] !== undefined) openMessage.tokens[key] = Math.max(openMessage.tokens[key] ?? 0, tokens[key]);
        if (final) { openMessage.final = true; flushUsage(); }
      };
      const settleTurnUsage = (raw: unknown) => {
        flushUsage();
        const totals = tokensOf(raw), reported = turnTokens;
        if (totals) {
          const shortfall: Tokens = {};
          for (const key of fields) if (totals[key] !== undefined) shortfall[key] = Math.max(0, totals[key] - reported[key]);
          emitUsage(shortfall, {reconciliation: true});
        }
        turnTokens = {input: 0, cached: 0, output: 0}; reportedIds.clear(); streamId = undefined;
      };
      const tools = new Map<string, Record<string, unknown>>();
      // Task/Agent children run inside the CLI. Each is a child thread `<session>:<tool_use id>`; its events carry that
      // tool_use id as parent_tool_use_id. A background child outlives the tool_result that launched it.
      type AgentRun = {childId: string; base: Record<string, unknown>; background: boolean; state: 'running' | 'completed' | 'failed' | 'interrupted'; message?: string; launched: boolean; startedAt: number; endedAt?: number};
      const agents = new Map<string, AgentRun>(), taskTools = new Map<string, string>(), toolThreads = new Map<string, string>();
      const backgroundRunning = () => [...agents.values()].some(run => run.background && run.state === 'running');
      // A background child that never reports back must not hold stdin (and the chat's run) open forever.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const maybeClose = () => {
        if (pending > 0 || grace) return;
        if (!backgroundRunning()) { clearTimeout(watchdog); watchdog = undefined; closeInput(); return; }
        watchdog ??= setTimeout(() => {
          for (const [id, run] of agents) if (run.background && run.state === 'running') { run.launched = true; settle(id, 'interrupted', 'Timed out waiting for this background agent to report back.'); }
          closeInput();
        }, options.backgroundTimeoutMs ?? BACKGROUND_TIMEOUT_MS);
      };
      const emitAgent = (run: AgentRun) => input.onEvent(run.launched ? 'item/completed' : 'item/started', {threadId: sessionId, turnId, item: {...run.base, ...(run.background ? {background: true} : {}),
        agentsStates: {[run.childId]: {status: run.state, startedAt: new Date(run.startedAt).toISOString(), ...(run.endedAt ? {endedAt: new Date(run.endedAt).toISOString()} : {}), ...(run.message ? {message: run.message} : {})}},
        ...(run.launched ? {status: run.state === 'running' ? 'completed' : run.state} : {})}});
      // The CLI's own clock: duration_ms from the notification, else the task_updated end_time, else now.
      const endTime = (run: AgentRun, durationMs?: unknown, endMs?: unknown): number =>
        typeof durationMs === 'number' && durationMs >= 0 ? run.startedAt + durationMs : typeof endMs === 'number' && endMs >= run.startedAt ? endMs : Date.now();
      const settle = (toolUseId: string, state: AgentRun['state'], message?: string) => {
        const run = agents.get(toolUseId); if (!run || run.state !== 'running') return;
        run.state = state; run.endedAt ??= endTime(run); if (message) run.message = message.slice(0, 32768);
        if (run.launched) { emitAgent(run); agents.delete(toolUseId); maybeClose(); }
      };
      const accept = () => { if (!accepted) { accepted = true; input.onThreadReady(sessionId); input.onTurnAccepted({threadId: sessionId, turnId}); } };
      const threadFor = (parent: unknown) => typeof parent === 'string' && parent ? `${sessionId}:${parent}` : sessionId;
      const finish = (result: AdapterRunResult) => { if (settled) return; settled = true; input.signal.removeEventListener('abort', abort); clearTimeout(killer); clearTimeout(watchdog); clearTimeout(grace); resolve(result); };
      let killer: ReturnType<typeof setTimeout> | undefined;
      // SIGINT lets the CLI stop its own work; then the whole process group goes, so a tool command it started (which still
      // holds stdout) cannot keep the run open after Stop.
      const abort = () => { child.kill('SIGINT'); killer = setTimeout(() => killTree(child, 'SIGKILL'), options.killGraceMs ?? 3000); };
      child.on('exit', () => { if (input.signal.aborted) killTree(child, 'SIGKILL'); });
      if (input.signal.aborted) abort(); else input.signal.addEventListener('abort', abort, {once: true});
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
      jsonLines(child.stdout!, event => {
        if (settled) return;
        const type = event.type;
        if (type === 'system' && event.subtype === 'init') { accept(); return; }
        accept();
        // Work after a result means the unanswered steer started another turn: its result will follow.
        if (grace && (type === 'assistant' || type === 'stream_event' || type === 'user')) { clearTimeout(grace); grace = undefined; }
        if (type === 'system' && (event.subtype === 'task_started' || event.subtype === 'task_notification')) {
          const toolUseId = text(event.tool_use_id) || taskTools.get(text(event.task_id)) || '', run = agents.get(toolUseId);
          if (event.subtype === 'task_started') {
            if (!run) return;
            taskTools.set(text(event.task_id), toolUseId);
            if (event.is_backgrounded === true) run.background = true;
            emitAgent(run);
          } else {
            if (run) run.endedAt = endTime(run, (event.usage as {duration_ms?: unknown} | undefined)?.duration_ms, run.endedAt);
            settle(toolUseId, claudeTaskState(event.status) ?? 'completed', text(event.summary));
          }
          // task_updated patches precede the notification that carries the summary, which is what settles a child.
          return;
        }
        if (type === 'system' && event.subtype === 'task_updated') {
          const run = agents.get(taskTools.get(text(event.task_id)) ?? ''), end = (event.patch as {end_time?: unknown} | undefined)?.end_time;
          if (run && typeof end === 'number' && end >= run.startedAt) run.endedAt = end;
          return;
        }
        // Claude Code summarised its own history (auto or /compact): the same signal as Codex's thread/compacted,
        // so the service notes it and re-sends static context on the next turn.
        if (type === 'system' && (event.subtype === 'compact_boundary' || event.subtype === 'compaction')) { input.onEvent('thread/compacted', {threadId: sessionId, turnId}); return; }
        if (type === 'stream_event') {
          const inner = event.event as {type?: string; delta?: {type?: string; text?: unknown; thinking?: unknown}; message?: {id?: unknown; usage?: unknown}; usage?: unknown} | undefined;
          // Each assistant message is its own reply segment, even when no tool call sits between two of them.
          if (!event.parent_tool_use_id && inner?.type === 'message_start') { input.onEvent(MESSAGE_BOUNDARY_EVENT, {}); streamId = typeof inner.message?.id === 'string' ? inner.message.id : undefined; observeUsage(streamId, inner.message?.usage); return; }
          if (!event.parent_tool_use_id && inner?.type === 'message_delta') { observeUsage(streamId ?? openMessage?.id, inner.usage, true); return; }
          if (event.parent_tool_use_id || inner?.type !== 'content_block_delta') return;
          if (inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') { streamedText = true; input.onDelta(inner.delta.text); }
          if (inner.delta?.type === 'thinking_delta' && typeof inner.delta.thinking === 'string') input.onReasoning(inner.delta.thinking);
          return;
        }
        const message = event.message as {id?: string; content?: unknown; usage?: Record<string, unknown>} | undefined;
        const blocks = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
        if (type === 'assistant') {
          for (const [index, block] of blocks.entries()) {
            // A child's own words belong to its transcript; only the parent's text streams into the chat.
            if (event.parent_tool_use_id && (block?.type === 'text' || block?.type === 'thinking')) {
              const body = text(block.type === 'text' ? block.text : block.thinking);
              if (body.trim()) input.onEvent('subagent/message', {threadId: threadFor(event.parent_tool_use_id), id: `${threadFor(event.parent_tool_use_id)}:${message?.id || text(event.uuid) || 'm'}:${index}`, role: block.type === 'text' ? 'assistant' : 'reasoning', text: body});
              continue;
            }
            if (block?.type === 'text' && !streamedText && !event.parent_tool_use_id && typeof block.text === 'string') input.onDelta(block.text);
            if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && !tools.has(block.id)) {
              const args = block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {};
              if (block.name === 'Agent' || block.name === 'Task') {
                const childId = `${sessionId}:${block.id}`, run: AgentRun = {childId, base: claudeToolItem(block.id, block.name, args, input.cwd, childId), background: args.run_in_background === true, state: 'running', launched: false, startedAt: Date.now()};
                if (agents.size < 256) agents.set(block.id, run);
                if (text(args.prompt)) input.onEvent('subagent/message', {threadId: childId, id: `${childId}:prompt`, role: 'user', text: text(args.prompt)});
                emitAgent(run);
                continue;
              }
              const item = claudeToolItem(block.id, block.name, args, input.cwd);
              if (tools.size < 4096) { tools.set(block.id, item); toolThreads.set(block.id, threadFor(event.parent_tool_use_id)); }
              input.onEvent('item/started', {threadId: threadFor(event.parent_tool_use_id), turnId, item});
            }
          }
          // Each assistant message restarts text streaming; the next one streams fresh deltas.
          streamedText = false;
          if (!event.parent_tool_use_id) observeUsage(typeof message?.id === 'string' ? message.id : undefined, message?.usage);
          return;
        }
        if (type === 'user') {
          // Tool results follow a finished API message: its usage is as final as it will get.
          if (!event.parent_tool_use_id) flushUsage();
          const results = blocks.filter(block => block?.type === 'tool_result');
          for (const block of blocks) {
            if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
            const run = agents.get(block.tool_use_id);
            if (run) {
              const output = resultText(block.content).slice(0, 256 * 1024);
              run.launched = true;
              if (block.is_error) { run.state = 'failed'; run.message = output.slice(0, 4000); }
              else if (!run.background && run.state === 'running') { run.state = 'completed'; run.message = handBack(output).slice(0, 32768); }
              emitAgent(run);
              if (run.state !== 'running') agents.delete(block.tool_use_id);
              continue;
            }
            const item = tools.get(block.tool_use_id); if (!item) continue;
            const output = resultText(block.content).slice(0, 256 * 1024);
            // `tool_use_result` describes the message's single tool result; with several it is ambiguous.
            const applied = item.type === 'fileChange' && !block.is_error && results.length === 1 ? claudeResultPatch(event.tool_use_result) : undefined;
            const changes = applied && Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]).slice(0, 1).map(change => ({...change, diff: applied})) : undefined;
            input.onEvent('item/completed', {threadId: toolThreads.get(block.tool_use_id) ?? threadFor(event.parent_tool_use_id), turnId, item: {...item, ...(changes ? {changes} : {}), status: block.is_error ? 'failed' : 'completed', aggregatedOutput: output, ...(block.is_error ? {success: false} : {})}});
            tools.delete(block.tool_use_id); toolThreads.delete(block.tool_use_id);
          }
          return;
        }
        if (type === 'result') {
          if (!event.parent_tool_use_id) settleTurnUsage(event.usage);
          final = {ok: event.is_error !== true && event.subtype === 'success', text: text(event.result)};
          // Each user message (the prompt, then any steers) ends in one result; the last one closes stdin so the run ends.
          // A background subagent keeps the CLI alive: closing stdin now would end it before it reports back.
          if (grace) { clearTimeout(grace); grace = undefined; }
          if (unanswered > 0) {
            // Steers written since the last result may have been folded into this turn, or may start another one.
            unanswered = 0; pending = 1;
            grace = setTimeout(() => { grace = undefined; pending = 0; maybeClose(); }, graceMs);
          } else { pending = 0; maybeClose(); }
        }
      });
      child.on('error', error => finish({status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', ...(accepted ? {threadId: sessionId, turnId} : {}), errorMessage: `Claude Code could not start: ${error.message}`}));
      child.on('close', code => {
        flushUsage();
        for (const [id, item] of tools) input.onEvent('item/completed', {threadId: toolThreads.get(id) ?? sessionId, turnId, item: {...item, id, status: 'interrupted'}});
        for (const run of agents.values()) if (run.state === 'running') { run.state = 'interrupted'; run.launched = true; run.endedAt ??= Date.now(); emitAgent(run); }
        const identity = accepted ? {threadId: sessionId, turnId} : {};
        if (input.signal.aborted) return finish({status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', ...identity, errorMessage: 'Stopped.'});
        if (final?.ok && code === 0) return finish({status: 'completed', finalMessage: final.text, dispatchState: 'dispatched', ...identity});
        const reason = (final && !final.ok ? final.text : '') || stderr.trim().split('\n').slice(-3).join(' ') || `Claude Code exited with code ${code}.`;
        finish({status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', ...identity, errorMessage: reason.replace(/[\x00-\x1f]+/g, ' ').slice(0, 400)});
      });
      child.stdin?.on('error', () => {});
      child.stdin?.write(claudeStdin(input));
      input.onSteerable?.(message => {
        if (settled || inputClosed || !child.stdin || input.signal.aborted) return false;
        pending++; unanswered++;
        try { child.stdin.write(claudeUserMessage(claudeSteerText(message))); if (grace) { clearTimeout(grace); grace = undefined; } return true; } catch { pending--; unanswered--; return false; }
      });
    });
  }};
}
