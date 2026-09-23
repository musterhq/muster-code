/**
 * Mailbox domain contract (SBX-12, SBX-17): a durable inter-agent mailbox.
 *
 * Messages live in SQLite with sender/recipient identity, a project scope, a global sequence, optional idempotency
 * keys, expiry, per-recipient delivery and acknowledgement, and request/reply with a deadline. A chat's pending mail
 * rides into its next turn as one compact inbox block; agents send, reply and ack through the `muster_mailbox` MCP
 * tools. The user sends from the Inbox (per chat and per Project) and is never impersonated by an agent.
 */
/** Who a message is from or for. `agent` is a subagent thread of chat `chatId`; `taskRun` is the chat running project task `id`. */
export type MailboxAddressKind = 'user' | 'chat' | 'agent' | 'project' | 'taskRun';
export interface MailboxAddress { kind: MailboxAddressKind; id: string; chatId?: string; projectId?: string; label?: string }
export type MailboxMessageKind = 'message' | 'request' | 'reply';
/** Message lifecycle: waiting for its recipient's next turn, placed in a completed turn, acknowledged, or expired undelivered. */
export type MailboxState = 'pending' | 'delivered' | 'acked' | 'expired';
/** Request side: 'awaiting' until a reply lands or `replyBy` passes. Plain messages and replies are 'none'. */
export type MailboxReplyState = 'none' | 'awaiting' | 'answered' | 'timed-out';
export interface MailboxDelivery { chatId: string; deliveredAt: string | null; ackedAt: string | null; via: 'turn' | 'steer' | 'tool' | 'user' | null }
export interface MailboxMessage {
  id: string;
  /** Global, strictly increasing: the order an inbox delivers in. Shown to agents as `#seq`. */
  seq: number;
  kind: MailboxMessageKind;
  sender: MailboxAddress;
  recipient: MailboxAddress;
  /** The project the message belongs to, when either side has one. */
  projectId: string | null;
  subject?: string;
  body: string;
  idempotencyKey?: string;
  inReplyTo?: string;
  replyBy?: string;
  expiresAt?: string;
  createdAt: string;
  state: MailboxState;
  reply: MailboxReplyState;
  replyId?: string;
  deliveries: MailboxDelivery[];
}
export interface MailboxList { messages: MailboxMessage[]; unacked: number; pending: number }
export interface MailboxSendInput {
  to: MailboxAddress;
  body: string;
  subject?: string;
  /** 'request' expects a reply before `replyWithinMs` (default 30 min). */
  kind?: 'message' | 'request';
  replyWithinMs?: number;
  /** Undelivered mail stops being delivered after this (default 7 days). */
  expiresInMs?: number;
  /** A repeated send with the same key from the same sender returns the first message instead of a duplicate. */
  idempotencyKey?: string;
  /** Start a turn in an idle recipient chat so the message is read now instead of on its next turn. */
  wake?: boolean;
}
export const MAILBOX_MAX_BODY = 8000;
export const MAILBOX_MAX_SUBJECT = 200;
export const MAILBOX_DEFAULT_EXPIRY_MS = 7 * 24 * 3_600_000;
export const MAILBOX_MAX_EXPIRY_MS = 30 * 24 * 3_600_000;
export const MAILBOX_DEFAULT_REPLY_MS = 30 * 60_000;
export const MAILBOX_MIN_REPLY_MS = 10_000;
export const MAILBOX_MAX_REPLY_MS = 7 * 24 * 3_600_000;
/** Per turn: at most this many messages ride in the inbox block; the rest wait for the next turn. */
export const MAILBOX_TURN_MESSAGES = 6;
/** Per message body in the inbox block; the full text stays readable with the mailbox_inbox tool. */
export const MAILBOX_TURN_BODY_CHARS = 480;
export interface MailboxCommands {
  /** Sends as the user. Agents send through the muster_mailbox MCP tools, as their own chat. */
  'mailbox.send': { input: MailboxSendInput; output: MailboxMessage };
  /** Replies as the user to a request or message addressed to the user. */
  'mailbox.reply': { input: { messageId: string; body: string; idempotencyKey?: string }; output: MailboxMessage };
  /** Acknowledges a message for one recipient chat (its only one when omitted), or for the user. */
  'mailbox.ack': { input: { messageId: string; chatId?: string }; output: MailboxMessage };
  /** A chat's or a project's mail (inbox and outbox), newest first. With neither, the user's own box. */
  'mailbox.list': { input: { chatId?: string; projectId?: string; limit?: number; includeExpired?: boolean }; output: MailboxList };
  'mailbox.get': { input: { id: string }; output: MailboxMessage };
}
export type MailboxEvent = { type: 'mailboxChanged'; chatIds: string[]; projectIds: string[] };
export const MAILBOX_COMMANDS = { 'mailbox.send': true, 'mailbox.reply': true, 'mailbox.ack': true, 'mailbox.list': true, 'mailbox.get': true } as const satisfies Record<keyof MailboxCommands, true>;
