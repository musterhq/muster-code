/**
 * The phone link's wire protocol (#326), shared by the desktop runtime and packages/mobile. Plain TypeScript with no platform
 * imports. The phone sees only these slim types, never the runtime's own (no file paths beyond names, no settings, no keys).
 */
export const MOBILE_PROTOCOL_VERSION = 1;
export const PAIRING_SCHEME = 'muster://pair';
export type MobileAccess = 'read-only' | 'act';
export const MOBILE_ACCESS: readonly MobileAccess[] = ['read-only', 'act'];

/** What the desktop's QR holds. Keys and code are base64url. `lan`: the desktop's private-network addresses (host:port) the
 *  phone tries first, before the relay (phase 2). */
export interface PairingLink { relayUrl: string; route: string; desktopKey: string; code: string; desktopName: string; lan?: string[] }

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
/** At most this many LAN addresses travel in a link or a hello. */
export const MAX_LAN_ADDRESSES = 4;
/** A direct address on the same network: a literal loopback or private-network address with a port (IPv6 in brackets). Never
 *  a name (it could resolve anywhere) and never a public address. */
export function lanAddressAllowed(entry: string): boolean {
  const m = /^(\[[0-9a-fA-F:]+\]|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(entry);
  if (!m) return false;
  const port = Number(m[2]);
  return port >= 1 && port <= 65_535 && isLocalHost(m[1]!) && m[1]!.toLowerCase() !== 'localhost';
}
/** The valid LAN addresses of a list (at most four), or undefined when none is left. */
export function cleanLanAddresses(list: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const kept = [...new Set(list.filter((entry): entry is string => typeof entry === 'string' && lanAddressAllowed(entry)))].slice(0, MAX_LAN_ADDRESSES);
  return kept.length ? kept : undefined;
}
export const lanUrl = (address: string, route: string): string => `ws://${address}/v1/phone/${route}`;
export function formatPairingLink(link: PairingLink): string {
  const query = new URLSearchParams({v: String(MOBILE_PROTOCOL_VERSION), r: link.relayUrl, d: link.route, k: link.desktopKey, c: link.code, n: link.desktopName});
  if (link.lan?.length) query.set('l', link.lan.join(','));
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
  const lan = cleanLanAddresses((query.get('l') ?? '').split(',').filter(Boolean));
  return {relayUrl, route, desktopKey, code, desktopName: (query.get('n') ?? '').slice(0, 80) || 'Muster', ...(lan ? {lan} : {})};
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
/** One change to the open chat's items (phase 3): for an item the phone already has, `append` adds text to its end (a reply
 *  streaming) and `status` sets its status (it finished); `item` adds a new item or replaces one whose other fields changed;
 *  `remove` (phase 4) takes an item away (deleted on the desktop). A phone that does not know an op reopens the chat. */
export type MobileItemOp = {id: string; append?: string; status?: string} | {item: MobileItem} | {remove: string};
export interface MobileNeed {
  chatId: string; chatTitle: string; itemId: string; kind: 'approval' | 'question'; summary: string; createdAt: string;
  approval?: MobileApproval; questions?: MobileQuestion[];
}

/** Where a new chat can start: a folder or a Project, by name only. */
export interface MobilePlace { kind: 'folder' | 'project'; id: string; name: string }
export interface MobileModel { id: string; name: string; /** Takes image input. */ images: boolean }
export interface MobileProvider { id: string; name: string; models: MobileModel[] }

/** Photos and files from the phone (phase 2) travel through the session in chunks: the same cap as the desktop's own
 *  attachments, and chunks small enough to keep each request inside one or two Noise messages. */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 32 * 1024;
/** Uploads one phone may have open at once. */
export const UPLOADS_AT_ONCE = 2;
/** Attachments one message from the phone may carry. */
export const MAX_SEND_ATTACHMENTS = 10;
export interface MobileAttachment { id: string; name: string; mime: string; size: number; kind: 'image' | 'file' }


/** A file the chat's latest turn changed (phase 5), by its path inside the chat's folder. `state` is what the person decided:
 *  still to review, kept or undone. An undone file is listed from the review marks after it left the change list. */
export type MobileReviewState = 'review' | 'kept' | 'undone';
export interface MobileChange {
  path: string; previousPath?: string; status: 'modified' | 'added' | 'deleted' | 'renamed'; adds: number; dels: number;
  binary?: boolean; state: MobileReviewState; afterHash: string;
}
/** A run of code with one colour: the text and an index into the diff's `palette` (no index: the text colour). */
export type MobileToken = [text: string, color?: number];
/** One diff line (phase 5): added, removed or context, the hunk it belongs to, its new line number (none for a removed line),
 *  its code as coloured tokens, and the changed words as [start, end) character ranges. */
export interface MobileDiffLine { k: 'a' | 'd' | 'c'; h: number; n?: number; old?: number; t: MobileToken[]; w?: Array<[number, number]> }
/** A hunk: its id for keep and undo, the function it is in (or null), its first new line and its size. */
export interface MobileHunk { id: string; fn: string | null; newStart: number; adds: number; dels: number; state: MobileReviewState }
/** Lines one changes.diff page holds at most. */
export const DIFF_PAGE_LINES = 400;
export interface MobileDiffPage {
  runId: string; path: string; status: MobileChange['status']; afterHash: string; adds: number; dels: number;
  /** Too large or binary: no lines; open it on the computer. */
  binary?: boolean; tooLarge?: boolean;
  /** Token colours as [dark, light]. */
  palette: Array<[string, string]>;
  hunks: MobileHunk[];
  /** Lines `from` to `from + lines.length` of `total`; `next` is where the next page starts, null at the end. */
  lines: MobileDiffLine[]; from: number; total: number; next: number | null;
}

/** Methods the phone may call. Every one is checked on the desktop against the phone's access. */
export interface MobileMethods {
  /** `lan`: the desktop's current direct addresses (phase 2), so the phone's record follows network changes. */
  'hello': {params: Record<string, never>; result: {desktopName: string; deviceId: string; access: MobileAccess; protocol: number; lan?: string[]}};
  /** The phone's heartbeat (phase 3): answered at once, for read-only phones too, so a dead link is noticed fast. */
  'ping': {params: Record<string, never>; result: Record<string, never>};
  'chats.list': {params: Record<string, never>; result: {chats: MobileChat[]}};
  /** Returns the chat and its latest items, and streams its item events to this phone until chat.close or another chat.open.
   *  With `deltas` (phase 3) the stream is `delta` events numbered from `seq`, carrying only appended text and changed items;
   *  without it, whole changed items (`items` events), as phase 1 phones expect. */
  'chat.open': {params: {id: string; deltas?: boolean}; result: {chat: MobileChat; items: MobileItem[]; revision: number; seq?: number}};
  'chat.close': {params: {id: string}; result: Record<string, never>};
  /** `attachmentIds`: attachments this phone uploaded to this chat (upload.finish). */
  'chat.send': {params: {id: string; text: string; requestId: string; attachmentIds?: string[]}; result: {runId: string}};
  'chat.steer': {params: {id: string; text: string; requestId: string}; result: {steered: boolean; reason?: string}};
  /** One request only; approving for a whole session is desktop-only. */
  'approval.respond': {params: {itemId: string; decision: 'accept' | 'decline'}; result: Record<string, never>};
  'question.respond': {params: {itemId: string; answers: Record<string, string[]>}; result: Record<string, never>};
  'needs.list': {params: Record<string, never>; result: {needs: MobileNeed[]}};
  /** What a new chat can start in and with: folders and Projects by name, the desktop's ready providers and their models. */
  'chat.options': {params: Record<string, never>; result: {places: MobilePlace[]; providers: MobileProvider[]}};
  /** Starts a chat in one folder or Project (or neither) with that provider and model; the desktop's other defaults apply. */
  'chat.create': {params: {folderId?: string; projectId?: string; providerId: string; model: string}; result: {chat: MobileChat}};
  /** Opens an upload of `size` bytes whose SHA-256 (hex) is `sha256`. */
  'upload.start': {params: {chatId: string; name: string; mime: string; size: number; sha256: string}; result: {uploadId: string; chunkBytes: number}};
  /** The next chunk, in order: `offset` must equal the bytes received so far. A refused chunk ends the upload. */
  'upload.chunk': {params: {uploadId: string; offset: number; data: string}; result: {received: number}};
  /** Checks length and hash, then stages the file in the chat on the desktop. */
  'upload.finish': {params: {uploadId: string}; result: {attachment: MobileAttachment}};
  'upload.cancel': {params: {uploadId: string}; result: Record<string, never>};
  /** Removes a file this phone uploaded and has not sent (the person took it out of the composer). */
  'upload.discard': {params: {chatId: string; attachmentId: string}; result: Record<string, never>};
  /** The chat's latest turn's changed files (phase 5); runId is null when the chat has no turn with a snapshot. */
  'changes.list': {params: {chatId: string}; result: {runId: string | null; files: MobileChange[]; truncated: boolean}};
  /** One page of a changed file's diff, highlighted on the computer. `from` is a line index (0 for the first page). */
  'changes.diff': {params: {chatId: string; path: string; from?: number}; result: MobileDiffPage};
  /** Keeps hunks of a file of the turn ('*' for the whole file); the computer records it as its own Keep does. */
  'changes.keep': {params: {chatId: string; runId: string; path: string; hunkIds: string[]}; result: {state: MobileReviewState}};
  /** Undoes one hunk, or the whole file without a hunk id, if the file is still as the phone read it (`afterHash`). */
  'changes.undo': {params: {chatId: string; runId: string; path: string; afterHash: string; hunkId?: string}; result: {stale: boolean}};
  /** Stops the chat's running turn. */
  'chat.stop': {params: {id: string}; result: Record<string, never>};
}
export type MobileMethod = keyof MobileMethods;
export const MOBILE_METHODS: readonly MobileMethod[] = ['hello', 'ping', 'chats.list', 'chat.open', 'chat.close', 'chat.send', 'chat.steer', 'approval.respond', 'question.respond', 'needs.list', 'chat.options', 'chat.create', 'upload.start', 'upload.chunk', 'upload.finish', 'upload.cancel', 'upload.discard', 'changes.list', 'changes.diff', 'changes.keep', 'changes.undo', 'chat.stop'];
/** Methods a read-only phone may not call. chat.options is only for starting a chat, so it is acting too. */
export const ACTING_METHODS: ReadonlySet<MobileMethod> = new Set(['chat.send', 'chat.steer', 'approval.respond', 'question.respond', 'chat.options', 'chat.create', 'upload.start', 'upload.chunk', 'upload.finish', 'upload.cancel', 'upload.discard', 'changes.keep', 'changes.undo', 'chat.stop']);

export type MobileEvent =
  | {type: 'chats'; chats: MobileChat[]}
  | {type: 'items'; chatId: string; items: MobileItem[]; revision: number}
  /** The open chat's changes, numbered one after another from chat.open's `seq`: a skipped number means the phone missed one
   *  and reopens the chat (phase 3). */
  | {type: 'delta'; chatId: string; seq: number; ops: MobileItemOp[]}
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
