/**
 * Non-blocking questions: the `ask_user` agent tool. The agent states a question and the default it will go with; Muster
 * posts the usual question card and answers the tool at once ("continue with the default"), so the run never stops to
 * wait. A later answer from the user reaches the agent as a steer while the run is still going (on routes that take
 * mid-run messages), or as the chat's next turn through the queue once it has ended.
 *
 * CLI routes (Codex, Claude Code, OpenCode, Grok) reach it through the `muster_ask` MCP server (a ToolHost); HTTP routes
 * get it as a native function tool (http-tools.ts). Both end in the service's askUser, which owns the card.
 */
import type { PendingQuestion, PendingQuestionData } from '../shared/protocol.ts';
import type { ToolSpec } from './governance/tool-host.ts';

export const ASK_MCP = 'muster_ask';
export const ASK_MCP_LAUNCHER_ENV = 'MUSTER_ASK_MCP_LAUNCHER';
export const ASK_USER_TOOL = 'ask_user';
/** The adapter → service request an HTTP route's ask_user call travels as (provider.ts onRequest). Never blocks. */
export const ASK_USER_METHOD = 'muster/askUser';
/** The one question id of an ask_user card. */
export const ASK_QUESTION_ID = 'answer';
const MAX_QUESTION = 4096, MAX_OPTION = 512, MAX_OPTIONS = 9, MAX_DEFAULT = 512;

export const ASK_USER_SPEC: ToolSpec = {
  name: ASK_USER_TOOL,
  description: 'Ask the user a question without stopping. Muster shows the question and this call returns at once: keep working with `default`. If the user answers later, the answer arrives as a new user message; adjust then.',
  inputSchema: { type: 'object', properties: {
    question: { type: 'string', description: 'The question, in one or two sentences.' },
    options: { type: 'array', items: { type: 'string' }, description: 'Up to 9 short choices (optional). The user can also type an answer.' },
    default: { type: 'string', description: 'What you will do meanwhile if the user has not answered: the choice you continue with now.' },
  }, required: ['question', 'default'] },
};
/** One line of agent instructions (agent mode). */
export const ASK_USER_RULE = `When a choice needs the user's input and you have the ${ASK_USER_TOOL} tool, call it with the question and the default you will use, then keep working on that default instead of ending your turn to ask.`;

export interface AskUserInput { question: string; options: string[]; defaultAnswer: string }
/** Validates the tool's arguments; a string is the error to hand back to the model. */
export function parseAskUser(args: Record<string, unknown>): AskUserInput | string {
  const question = typeof args.question === 'string' ? args.question.trim().slice(0, MAX_QUESTION) : '';
  if (!question) return 'ask_user needs a question.';
  const fallback = args.default ?? args.defaultAnswer;
  const defaultAnswer = typeof fallback === 'string' ? fallback.trim().slice(0, MAX_DEFAULT) : '';
  if (!defaultAnswer) return 'ask_user needs a default: the choice you continue with while the user has not answered.';
  const raw = Array.isArray(args.options) ? args.options : [];
  const options = [...new Set(raw.flatMap(option => typeof option === 'string' && option.trim() ? [option.trim().slice(0, MAX_OPTION)] : []))].slice(0, MAX_OPTIONS);
  return { question, options, defaultAnswer };
}
/** The card's data: the existing question card shape plus the non-blocking marker and the default. No deadline: the run is not waiting. */
export function askUserCard(input: AskUserInput): PendingQuestionData {
  const question: PendingQuestion = { id: ASK_QUESTION_ID, header: 'Question', question: input.question, options: input.options.map(label => ({ label })), allowCustomAnswer: true, multiSelect: false };
  return { method: 'item/tool/requestUserInput', questions: [question], nonBlocking: true, defaultAnswer: input.defaultAnswer };
}
/** What the tool answers the model, immediately. */
export const askUserReply = (input: AskUserInput) => `The question is shown to the user. No answer yet: continue now with "${input.defaultAnswer}". If the user answers later, the answer arrives as a new user message.`;
/** The message a later answer is delivered as (steer or next turn). */
export const askUserAnswerMessage = (question: string, answer: string) => `Answer to your earlier question "${question}": ${answer}`;
export const isNonBlockingQuestion = (data: Record<string, unknown> | undefined | null) => data?.nonBlocking === true;
/** The muster_ask server for a run, once the host is listening. */
export function askUserRunOverrides(chatId: string, launcher: string | undefined, chatToken: string): Record<string, string | number> {
  if (!launcher) return {};
  return { [`mcp_servers.${ASK_MCP}.command`]: launcher, [`mcp_servers.${ASK_MCP}.env.MUSTER_CHAT_ID`]: chatId, [`mcp_servers.${ASK_MCP}.env.MUSTER_CHAT_TOKEN`]: chatToken, [`mcp_servers.${ASK_MCP}.tool_timeout_sec`]: 30 };
}
