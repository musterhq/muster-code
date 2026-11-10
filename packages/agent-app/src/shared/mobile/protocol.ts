/**
 * The phone link's wire protocol (#326), shared by the desktop runtime and packages/mobile. Plain TypeScript with no platform
 * imports. The phone sees only these slim types, never the runtime's own (no file paths beyond names, no settings, no keys).
 */
export const MOBILE_PROTOCOL_VERSION = 1;
export const PAIRING_SCHEME = 'muster://pair';
export type MobileAccess = 'read-only' | 'act';
export const MOBILE_ACCESS: readonly MobileAccess[] = ['read-only', 'act'];

/** What the desktop's QR holds. Keys and code are base64url. */
export interface PairingLink { relayUrl: string; route: string; desktopKey: string; code: string; desktopName: string }

export class MobileError extends Error {
  constructor(readonly code: MobileErrorCode, message: string) { super(message); this.name = 'MobileError'; }
}
export type MobileErrorCode = 'bad-link' | 'pairing-failed' | 'revoked' | 'offline' | 'closed' | 'timeout' | 'read-only' | 'refused' | 'not-found' | 'bad-request' | 'failed';
export const NOT_A_PAIRING_LINK = 'This is not a Muster pairing link. On your computer, open Settings › Integrations › Phone and press Pair a phone.';

const B64URL = /^[A-Za-z0-9_-]+$/;
export function formatPairingLink(link: PairingLink): string {
  const query = new URLSearchParams({v: String(MOBILE_PROTOCOL_VERSION), r: link.relayUrl, d: link.route, k: link.desktopKey, c: link.code, n: link.desktopName});
  return `${PAIRING_SCHEME}?${query.toString()}`;
}
export function parsePairingLink(text: string): PairingLink {
  const value = (text ?? '').trim();
  const bad = () => new MobileError('bad-link', NOT_A_PAIRING_LINK);
  if (!value.startsWith(`${PAIRING_SCHEME}?`)) throw bad();
  const query = new URLSearchParams(value.slice(PAIRING_SCHEME.length + 1));
  const relayUrl = query.get('r') ?? '', route = query.get('d') ?? '', desktopKey = query.get('k') ?? '', code = query.get('c') ?? '';
  if (query.get('v') !== String(MOBILE_PROTOCOL_VERSION) || !/^wss?:\/\/[^\s]+$/.test(relayUrl) || !/^[a-f0-9]{16,64}$/.test(route)
    || !B64URL.test(desktopKey) || desktopKey.length !== 43 || !B64URL.test(code) || code.length !== 43) throw bad();
  return {relayUrl, route, desktopKey, code, desktopName: (query.get('n') ?? '').slice(0, 80) || 'Muster'};
}

export type MobileChatStatus = 'idle' | 'running' | 'stopping' | 'completed' | 'failed' | 'interrupted' | 'waiting';
export interface MobileChat {
  id: string; title: string; status: MobileChatStatus; updatedAt: string;
  /** The folder or project it belongs to, by name. */
  place: string | null;
  /** Approvals and questions waiting on the person. */
  needsYou: number;
}
export type MobileItemKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'approval' | 'question' | 'notice';
export interface MobileApproval { kind: 'command' | 'fileChange' | 'mcp'; command?: string; cwd?: string; reason?: string; files?: string[]; server?: string; tool?: string }
export interface MobileQuestion { id: string; header: string; question: string; options: Array<{label: string; description?: string}>; allowCustomAnswer: boolean; multiSelect: boolean; secret?: boolean }
export interface MobileItem {
  id: string; kind: MobileItemKind; text: string; status?: string; createdAt: string;
  approval?: MobileApproval; questions?: MobileQuestion[];
}
export interface MobileNeed {
  chatId: string; chatTitle: string; itemId: string; kind: 'approval' | 'question'; summary: string; createdAt: string;
  approval?: MobileApproval; questions?: MobileQuestion[];
}

/** Methods the phone may call. Every one is checked on the desktop against the phone's access. */
export interface MobileMethods {
  'hello': {params: Record<string, never>; result: {desktopName: string; deviceId: string; access: MobileAccess; protocol: number}};
  'chats.list': {params: Record<string, never>; result: {chats: MobileChat[]}};
  /** Returns the chat and its latest items, and streams its item events to this phone until chat.close or another chat.open. */
  'chat.open': {params: {id: string}; result: {chat: MobileChat; items: MobileItem[]; revision: number}};
  'chat.close': {params: {id: string}; result: Record<string, never>};
  'chat.send': {params: {id: string; text: string; requestId: string}; result: {runId: string}};
  'chat.steer': {params: {id: string; text: string; requestId: string}; result: {steered: boolean; reason?: string}};
  /** One request only; approving for a whole session is desktop-only. */
  'approval.respond': {params: {itemId: string; decision: 'accept' | 'decline'}; result: Record<string, never>};
  'question.respond': {params: {itemId: string; answers: Record<string, string[]>}; result: Record<string, never>};
  'needs.list': {params: Record<string, never>; result: {needs: MobileNeed[]}};
}
export type MobileMethod = keyof MobileMethods;
export const MOBILE_METHODS: readonly MobileMethod[] = ['hello', 'chats.list', 'chat.open', 'chat.close', 'chat.send', 'chat.steer', 'approval.respond', 'question.respond', 'needs.list'];
/** Methods a read-only phone may not call. */
export const ACTING_METHODS: ReadonlySet<MobileMethod> = new Set(['chat.send', 'chat.steer', 'approval.respond', 'question.respond']);

export type MobileEvent =
  | {type: 'chats'; chats: MobileChat[]}
  | {type: 'items'; chatId: string; items: MobileItem[]; revision: number}
  | {type: 'needs'; needs: MobileNeed[]}
  | {type: 'access'; access: MobileAccess};

/** Frames inside the encrypted channel. */
export type MobileFrame =
  | {t: 'req'; id: number; m: MobileMethod; p: unknown}
  | {t: 'res'; id: number; ok: true; r: unknown}
  | {t: 'res'; id: number; ok: false; e: {code: MobileErrorCode; message: string}}
  | {t: 'evt'; e: MobileEvent};

/** Handshake payloads. */
export interface PairRequest { v: number; name: string; platform: string }
export interface Welcome { v: number; desktopName: string; deviceId: string; access: MobileAccess }

/** Close codes the desktop asks the relay to use when it ends a phone's connection. */
export const CLOSE = {pairingFailed: 4401, revoked: 4403, offline: 4404, badFrame: 4400, gone: 4410} as const;
export const CLOSE_REASON: Record<number, MobileErrorCode> = {4401: 'pairing-failed', 4403: 'revoked', 4404: 'offline', 4400: 'closed', 4410: 'closed'};
