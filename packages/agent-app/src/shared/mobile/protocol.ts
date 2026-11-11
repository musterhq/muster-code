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
export type MobileErrorCode = 'bad-link' | 'pairing-failed' | 'pending' | 'revoked' | 'offline' | 'closed' | 'timeout' | 'read-only' | 'refused' | 'not-found' | 'bad-request' | 'failed';
export const NOT_A_PAIRING_LINK = 'This is not a Muster pairing link. On your computer, open Settings › Integrations › Phone and press Pair a phone.';

const B64URL = /^[A-Za-z0-9_-]+$/;
/** Loopback and private-network hosts, the only ones a relay may be reached on without TLS. Literal addresses only: a name that
 *  resolves to a private address still needs wss://. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || /^fe80:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
export const RELAY_NEEDS_TLS = 'Use a wss:// relay address. Plain ws:// is only allowed on this computer or a private network (such as 192.168.x.x).';
/** A relay address: wss:// anywhere, ws:// only to a loopback or private-network address. */
export function relayUrlAllowed(url: string): boolean {
  const m = /^(wss?):\/\/([^\s/?#]+)(?:\/[^\s?#]*)?$/.exec(url);
  if (!m) return false;
  if (m[1] === 'wss') return true;
  const host = m[2]!.startsWith('[') ? m[2]!.slice(0, m[2]!.indexOf(']') + 1) : m[2]!.replace(/:\d+$/, '');
  return isLocalHost(host);
}
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
  if (query.get('v') !== String(MOBILE_PROTOCOL_VERSION) || !relayUrlAllowed(relayUrl) || !/^[a-f0-9]{16,64}$/.test(route)
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

/** Where a new chat can start: a folder or a Project, by name only. */
export interface MobilePlace { kind: 'folder' | 'project'; id: string; name: string }
export interface MobileModel { id: string; name: string; /** Takes image input. */ images: boolean }
export interface MobileProvider { id: string; name: string; models: MobileModel[] }

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
  /** What a new chat can start in and with: folders and Projects by name, the desktop's ready providers and their models. */
  'chat.options': {params: Record<string, never>; result: {places: MobilePlace[]; providers: MobileProvider[]}};
  /** Starts a chat in one folder or Project (or neither) with that provider and model; the desktop's other defaults apply. */
  'chat.create': {params: {folderId?: string; projectId?: string; providerId: string; model: string}; result: {chat: MobileChat}};
}
export type MobileMethod = keyof MobileMethods;
export const MOBILE_METHODS: readonly MobileMethod[] = ['hello', 'chats.list', 'chat.open', 'chat.close', 'chat.send', 'chat.steer', 'approval.respond', 'question.respond', 'needs.list', 'chat.options', 'chat.create'];
/** Methods a read-only phone may not call. chat.options is only for starting a chat, so it is acting too. */
export const ACTING_METHODS: ReadonlySet<MobileMethod> = new Set(['chat.send', 'chat.steer', 'approval.respond', 'question.respond', 'chat.options', 'chat.create']);

export type MobileEvent =
  | {type: 'chats'; chats: MobileChat[]}
  | {type: 'items'; chatId: string; items: MobileItem[]; revision: number}
  | {type: 'needs'; needs: MobileNeed[]}
  | {type: 'access'; access: MobileAccess}
  /** The desktop confirmed this phone's check code: it is paired (read-only) from now on. */
  | {type: 'paired'};

/** Frames inside the encrypted channel. */
export type MobileFrame =
  | {t: 'req'; id: number; m: MobileMethod; p: unknown}
  | {t: 'res'; id: number; ok: true; r: unknown}
  | {t: 'res'; id: number; ok: false; e: {code: MobileErrorCode; message: string}}
  | {t: 'evt'; e: MobileEvent};

/** Handshake payloads. */
export interface PairRequest { v: number; name: string; platform: string }
export interface Welcome { v: number; desktopName: string; deviceId: string; access: MobileAccess; /** Pairing: waits for the owner to confirm the check code on the desktop. */ pending?: boolean }

/** Close codes the desktop asks the relay to use when it ends a phone's connection. */
/** 4400: a frame (or the first handshake message) did not decrypt or parse. 4401: pairing failed; the reason says why
 *  (\`code-used\`, \`rejected\`, \`expired\`, \`pairing-failed\`). 4403: the phone's key is not paired (revoked). 4404: the desktop is
 *  offline. 4408: the handshake took too long. 4410: the desktop went away. 4429: too many connections or attempts. */
export const CLOSE = {badFrame: 4400, pairingFailed: 4401, revoked: 4403, offline: 4404, timeout: 4408, gone: 4410, busy: 4429} as const;
export const CLOSE_REASON: Record<number, MobileErrorCode> = {4400: 'closed', 4401: 'pairing-failed', 4403: 'revoked', 4404: 'offline', 4408: 'closed', 4410: 'closed', 4429: 'closed'};
