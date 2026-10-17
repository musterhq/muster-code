import {execFileSync} from 'node:child_process';
import type {TimelineItem} from '../shared/protocol.ts';

export const FORK_DIGEST_ITEMS = 30;
export const FORK_DIGEST_BYTES = 24 * 1024;
const ITEM_BYTES = 4 * 1024;

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
function line(item: TimelineItem): string | null {
  const text = item.text.trim();
  if (!text) return null;
  if (item.kind === 'user') return `User: ${clip(text, ITEM_BYTES)}`;
  if (item.kind === 'assistant') return `Assistant: ${clip(text, ITEM_BYTES)}`;
  // Tools contribute their label (command, file or tool name), never their output.
  if (item.kind === 'tool') { const label = typeof item.data?.name === 'string' ? item.data.name : text.split('\n')[0]!; return `Tool (${item.status ?? 'done'}): ${clip(label.trim(), 240)}`; }
  return null;
}

const RECENT_USER_MESSAGES = 5;
const RECENT_USER_BYTES = 2 * 1024;
const GIT_BYTES = 2 * 1024;
const GIT_TIMEOUT_MS = 1500;

/** Branch and `git status --short` of the chat's folder, bounded; '' when it is not a git repo or git is unavailable. */
export function workspaceGitState(cwd: string | undefined): string {
  if (!cwd) return '';
  const git = (args: string[]) => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}}).trim();
  try {
    let branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === 'HEAD') branch = `detached at ${git(['rev-parse', '--short', 'HEAD'])}`;
    const status = git(['status', '--short']);
    const rows = status ? status.split('\n') : [];
    let text = `Branch: ${branch}\n${rows.length ? 'git status --short:' : 'git status --short: clean'}`;
    let shown = 0;
    for (const row of rows) {
      if (Buffer.byteLength(text) + Buffer.byteLength(row) + 1 > GIT_BYTES - 40) break;
      text += `\n${clip(row, 240)}`; shown++;
    }
    if (shown < rows.length) text += `\n… ${rows.length - shown} more changed paths`;
    return text;
  } catch { return ''; }
}

/** The context a fork's (or a replaced chat's) fresh provider conversation starts with, at most 24 KB. The task always comes first:
 *  the first request, the last 5 user messages, the last assistant message and the folder's git state; the rest of the
 *  budget holds the newest of the last 30 items (tool lines included), oldest first. Returns '' when there is nothing worth sending. */
export function transcriptDigest(items: readonly TimelineItem[], cwd?: string): string {
  const firstIndex = items.findIndex(item => item.kind === 'user' && item.text.trim());
  const userIndexes: number[] = [];
  for (let index = items.length - 1; index >= 0 && userIndexes.length < RECENT_USER_MESSAGES; index--) if (index !== firstIndex && items[index]!.kind === 'user' && items[index]!.text.trim()) userIndexes.unshift(index);
  let summaryIndex = -1;
  for (let index = items.length - 1; index >= 0; index--) if (items[index]!.kind === 'assistant' && items[index]!.text.trim()) { summaryIndex = index; break; }
  const taken = new Set<number>([...(firstIndex >= 0 ? [firstIndex] : []), ...userIndexes, ...(summaryIndex >= 0 ? [summaryIndex] : [])]);
  const git = workspaceGitState(cwd);
  const body = (index: number, max: number) => clip(items[index]!.text.trim(), max);
  const sections: string[] = [];
  if (firstIndex >= 0) sections.push(`First request in this task:\nUser: ${body(firstIndex, ITEM_BYTES)}`);
  if (userIndexes.length) sections.push(`Latest user messages:\n${userIndexes.map(index => `User: ${body(index, RECENT_USER_BYTES)}`).join('\n\n')}`);
  if (summaryIndex >= 0) sections.push(`Last assistant message:\nAssistant: ${body(summaryIndex, ITEM_BYTES)}`);
  if (git) sections.push(`Workspace state now:\n${git}`);
  let bytes = sections.reduce((sum, section) => sum + Buffer.byteLength(section) + 2, 0);
  const recent: string[] = [];
  for (let index = items.length - 1, seen = 0; index >= 0 && seen < FORK_DIGEST_ITEMS; index--, seen++) {
    if (taken.has(index)) continue;
    const entry = line(items[index]!);
    if (!entry) continue;
    const size = Buffer.byteLength(entry) + 2;
    if (bytes + size > FORK_DIGEST_BYTES) break;
    recent.push(entry); bytes += size;
  }
  if (recent.length) sections.push(`Recent activity (oldest first):\n${recent.reverse().join('\n\n')}`);
  if (!sections.length) return '';
  return `Earlier conversation (forked):\n<earlier-conversation>\n${sections.join('\n\n')}\n</earlier-conversation>\nContinue from this conversation. Files were not rewound; check the workspace for their current state.`;
}
