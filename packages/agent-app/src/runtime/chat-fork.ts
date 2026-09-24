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

/** The context a fork's (or a replaced chat's) fresh provider conversation starts with: the last 30 items, at most 24 KB, oldest first.
 *  Returns '' when there is nothing worth sending. */
export function transcriptDigest(items: readonly TimelineItem[]): string {
  const lines: string[] = [];
  let bytes = 0;
  for (let index = items.length - 1; index >= 0 && lines.length < FORK_DIGEST_ITEMS; index--) {
    const entry = line(items[index]!);
    if (!entry) continue;
    const size = Buffer.byteLength(entry) + 2;
    if (bytes + size > FORK_DIGEST_BYTES) break;
    lines.push(entry); bytes += size;
  }
  if (!lines.length) return '';
  return `Earlier conversation (forked):\n<earlier-conversation>\n${lines.reverse().join('\n\n')}\n</earlier-conversation>\nContinue from this conversation. Files were not rewound; check the workspace for their current state.`;
}

