/**
 * Tool use of a Paperclip run, read from the run's own log (`GET /heartbeat-runs/:id/log`): the run row carries none. The log is the
 * adapter's stdout as NDJSON chunks; the adapters that stream JSON (Claude Code's stream-json, Codex's `--json`) write one event per
 * line, and a tool call is a `tool_use` content block (Claude) or a completed `command_execution` / `mcp_tool_call` / `file_change` /
 * `web_search` item (Codex). Anything else (a plain `process` adapter) has no tool events to count: an honest "none recorded".
 */
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const str = (v: unknown): string | null => typeof v === 'string' && v ? v : null;
const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(pytest|vitest|jest|mocha|phpunit|rspec)\b|\bgo\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b/;

export interface RunTools { tools: { name: string; count: number }[]; tests: number }

/** The stdout lines of an NDJSON run log (`{"stream":"stdout","chunk":"…"}` per line), rejoined across chunk boundaries. */
function stdoutLines(content: string): string[] {
  let text = '';
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { const record = obj(JSON.parse(line)); if (record.stream === undefined || record.stream === 'stdout') text += typeof record.chunk === 'string' ? record.chunk : ''; } catch { /* a cut-off last line */ }
  }
  return text.split('\n');
}

export function toolsFromLog(content: string): RunTools {
  const counts = new Map<string, number>();
  let tests = 0;
  const count = (name: string, command?: string | null) => { counts.set(name, (counts.get(name) ?? 0) + 1); if (command && TEST_COMMAND.test(command)) tests++; };
  for (const line of stdoutLines(content)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Json; try { event = obj(JSON.parse(trimmed)); } catch { continue; }
    // Claude Code stream-json: an assistant message's tool_use blocks.
    const message = obj(event.message);
    if (event.type === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) { const b = obj(block); if (b.type === 'tool_use') count(str(b.name) ?? 'tool', str(obj(b.input).command)); }
      continue;
    }
    // Codex --json: an item that finished (its `item.started` is the same call).
    if (event.type === 'item.completed') {
      const item = obj(event.item), kind = str(item.type);
      if (kind === 'command_execution') count('Shell command', str(item.command));
      else if (kind === 'mcp_tool_call') count(`${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`);
      else if (kind === 'file_change') count('File change');
      else if (kind === 'web_search') count('Web search');
    }
  }
  return { tools: [...counts].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), tests };
}
