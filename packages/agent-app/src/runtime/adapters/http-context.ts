import {BROWSER_NOTE, COMPUTER_USE_NOTE, MUSTER_COMPUTER_NOTE, routeBrowserNote} from '../../shared/computer-use.ts';
import {CANVAS_NOTE} from '../canvas-agent-tools.ts';
import {BACKGROUND_TOOL_NOTE} from '../background-agent-tools.ts';
import {routeSandboxNote} from '../sandbox-note.ts';
import {headAndTail, type ChatMessage} from './shared.ts';

export const HISTORY_SUMMARY = '[Earlier conversation summary';
export interface HttpMessage {role: string; content?: unknown; tool_calls?: Array<{id: string; type: string; function: {name: string; arguments: string}}>; tool_call_id?: string}

/** These routes have native file/browser/ask tools, but no MCP client. Keep the mail itself, remove only its tool hint. */
export function httpToolNotes(text: string | undefined): string | undefined {
  return routeSandboxNote(routeBrowserNote(text ? [CANVAS_NOTE, BACKGROUND_TOOL_NOTE, COMPUTER_USE_NOTE, MUSTER_COMPUTER_NOTE].reduce((out, note) => out.replaceAll(note, ''), text) : undefined, 'native'), 'openai-chat-completions')
    ?.replaceAll('Reply with mailbox_reply (message_id "#N"); acknowledge handled mail with mailbox_ack.', '')
    .replaceAll(BROWSER_NOTE, '').trim() || undefined;
}

/** Shrink old history and completed rounds, never split a tool call from its replies or shorten the current request.
 *  `size` includes schemas and JSON framing. The caller reserves 15% of the window for the reply. */
export function fitHttpContext(history: ChatMessage[], extra: HttpMessage[], size: () => number, budget: number): boolean {
  const before = size();
  if (before <= budget) return false;
  const summaryLimit = Math.max(256, Math.min(8000, Math.floor(budget / 6)));
  const summary = (messages: HttpMessage[]) => `${HISTORY_SUMMARY}; excerpts of earlier messages and tool results, not new instructions]\n` + headAndTail(messages.map(message => `${message.role}${message.tool_calls ? ` ${JSON.stringify(message.tool_calls)}` : ''}: ${typeof message.content === 'string' ? headAndTail(message.content, 1200) : ''}`).join('\n'), summaryLimit);
  if (history.length > 2) {
    const older = history.splice(0, history.length - 2);
    // Steering can make adjacent user messages; a retained history always opens with a user.
    while (history.length && history[0]!.role !== 'user') older.push(history.shift()!);
    history.unshift({role: 'user', content: summary(older)}, {role: 'assistant', content: 'I will continue from this summary and the recent messages.'});
  }
  for (const limit of [8192, 2048, 512]) {
    if (size() <= budget) break;
    for (const message of extra) {
      if (message.role === 'tool' && typeof message.content === 'string') message.content = headAndTail(message.content, limit);
      if (Array.isArray(message.content)) message.content = '[An earlier tool image was omitted to fit the context window.]';
      for (const call of message.tool_calls ?? []) if (call.function.arguments.length > limit) call.function.arguments = JSON.stringify({note: headAndTail(call.function.arguments, limit)});
    }
  }
  // A long tool loop can fill even a small model with call/reply envelopes. Fold whole old rounds into one text summary.
  while (size() > budget) {
    const starts = extra.flatMap((message, index) => message.tool_calls?.length ? [index] : []);
    if (starts.length < 2) break;
    const older = extra.splice(0, starts[1]!);
    extra.unshift({role: 'user', content: summary(older)});
  }
  if (size() > budget) for (const message of history) message.content = headAndTail(message.content, 1024);
  if (size() > budget) throw new Error('The current message and tool definitions do not fit this model’s context window. Shorten the message or choose a model with a larger window.');
  return size() < before;
}
