import type {TimelineItem} from './protocol.ts';

/**
 * One deterministic sentence for a finished turn, built only from its rows (no model call):
 * "Edited 2 files, ran tests (3 passed), opened 3 sites". At most three parts, most significant first.
 * The runtime stores it on the turn's prompt (`data.turnDigest`) and the transcript shows it under the fold.
 */
export const DIGEST_MAX_PARTS = 3;

const TEST_COMMAND = /\b(?:pytest|vitest|jest|mocha|ava|rspec|phpunit|tox|unittest|playwright test|(?:npm|pnpm|yarn|bun)(?: run)? test|go test|cargo test|node (?:--[\w-]+ )*--test|deno test|dotnet test|mvn test|gradle test|swift test|mix test)\b/;

/** "3 passed, 1 failed" from common runners' summaries; undefined when the output names no counts. */
export function testCounts(output: string): {passed?: number; failed?: number} | undefined {
  const tail = output.slice(-4000);
  const last = (pattern: RegExp) => { let value: number | undefined; for (const match of tail.matchAll(pattern)) value = Number(match[1]); return value; };
  const passed = last(/(\d+) (?:passed|passing)\b/g) ?? last(/^# pass (\d+)/gm) ?? last(/^ℹ pass (\d+)/gm) ?? last(/Tests?:\s+(?:\d+ \w+, )*(\d+) passed/g);
  const failed = last(/(\d+) (?:failed|failing)\b/g) ?? last(/^# fail (\d+)/gm) ?? last(/^ℹ fail (\d+)/gm);
  if (passed === undefined && failed === undefined) return undefined;
  return {...(passed !== undefined ? {passed} : {}), ...(failed ? {failed} : {})};
}

const str = (value: unknown) => typeof value === 'string' ? value : '';
const parse = (value: unknown): unknown => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return undefined; } };
function urlsOf(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || value == null) return;
    if (typeof value === 'string') { if (/^https?:\/\//i.test(value)) out.push(value); return; }
    if (typeof value === 'object') for (const [key, inner] of Object.entries(value as Record<string, unknown>)) if (key === 'url' || key === 'href' || depth < 1) visit(inner, depth + 1);
  };
  visit(parse(data.arguments), 0);
  const computer = data.computer as Record<string, unknown> | undefined;
  if (computer && typeof computer.url === 'string') out.push(computer.url);
  return out;
}
export function hostOf(url: string): string { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The sentence for `items` (one turn's rows, prompt included or not). Empty when the turn did no work. */
export function turnDigest(items: readonly TimelineItem[]): string {
  const edited = new Set<string>(), read = new Set<string>(), sites = new Set<string>(), agents = new Set<string>();
  let commands = 0, searches = 0, tests: {passed: number; failed: number; ran: number} | undefined;
  for (const item of items) {
    if (item.kind !== 'tool' || !item.data) continue;
    const data = item.data, type = str(data.type);
    if (type === 'fileChange') { for (const change of Array.isArray(data.changes) ? data.changes : []) { const path = change && typeof change === 'object' ? str((change as Record<string, unknown>).path) : ''; if (path) edited.add(path); } continue; }
    if (type === 'commandExecution') {
      const actions = Array.isArray(data.commandActions) ? data.commandActions.filter(a => a && typeof a === 'object') as Record<string, unknown>[] : [];
      if (actions.length && actions.every(a => a.type === 'read')) { for (const a of actions) { const path = str(a.path) || str(a.name); if (path) read.add(path); } continue; }
      if (actions.length && actions.every(a => a.type === 'search' || a.type === 'listFiles')) { searches++; continue; }
      const command = str(data.command);
      if (TEST_COMMAND.test(command)) {
        const counts = testCounts(str(data.output));
        tests ??= {passed: 0, failed: 0, ran: 0};
        // A later run of the suite replaces an earlier one: the turn's result is the last run's.
        tests = {passed: counts?.passed ?? tests.passed, failed: counts ? counts.failed ?? 0 : tests.failed, ran: tests.ran + 1};
      } else commands++;
      continue;
    }
    if (type === 'fileRead') { const path = str(data.path) || str(data.name); if (path) read.add(path); continue; }
    if (type === 'webSearch') { searches++; continue; }
    if (type === 'collabAgentToolCall') { for (const id of Array.isArray(data.receiverThreadIds) ? data.receiverThreadIds : []) if (typeof id === 'string') agents.add(id); continue; }
    if (type === 'mcpToolCall' || type === 'dynamicToolCall') for (const url of urlsOf(data)) { const host = hostOf(url); if (host) sites.add(host); }
  }
  const parts: string[] = [];
  if (edited.size) parts.push(`edited ${count(edited.size, 'file')}`);
  if (tests) {
    const result = [tests.passed ? `${tests.passed} passed` : '', tests.failed ? `${tests.failed} failed` : ''].filter(Boolean).join(', ');
    parts.push(result ? `ran tests (${result})` : 'ran tests');
  } else if (commands) parts.push(`ran ${count(commands, 'command')}`);
  if (sites.size) parts.push(`opened ${count(sites.size, 'site')}`);
  if (agents.size) parts.push(`ran ${count(agents.size, 'sub-agent')}`);
  if (searches) parts.push(`searched ${count(searches, 'time')}`);
  if (read.size) parts.push(`read ${count(read.size, 'file')}`);
  if (tests && commands && parts.length < DIGEST_MAX_PARTS) parts.push(`ran ${count(commands, 'other command')}`);
  const sentence = parts.slice(0, DIGEST_MAX_PARTS).join(', ');
  return sentence ? sentence[0]!.toUpperCase() + sentence.slice(1) : '';
}
