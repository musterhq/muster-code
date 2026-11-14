/**
 * The encrypted channel over a text transport (#326). Every transport message is one base64 string:
 *
 * - phone → desktop, first: [mode byte: 'P' pairing (IKpsk1) | 'S' session (IK)] + Noise message 1;
 * - desktop → phone: Noise message 2;
 * - then each Noise transport message seals [flag byte: 1 more | 0 last] + a chunk of the UTF-8 JSON frame, so a frame larger
 *   than a Noise message is split and joined in order.
 *
 * The prologue binds the protocol version and mode, so a session handshake can't be replayed as a pairing one.
 */
import {concat, fromBase64, fromUtf8, toBase64, utf8} from './bytes.ts';
import {type CipherState, NOISE_MAX_MESSAGE, type NoiseCrypto} from './noise.ts';
import {MOBILE_PROTOCOL_VERSION, type MobileFrame} from './protocol.ts';

export type ChannelMode = 'pair' | 'session';
export const MODE_BYTE: Record<ChannelMode, number> = {pair: 0x50, session: 0x53};
export const prologue = (mode: ChannelMode): Uint8Array => utf8(`muster-mobile/${MOBILE_PROTOCOL_VERSION}/${mode}`);
const CHUNK = NOISE_MAX_MESSAGE - 16 - 1;
/** A frame larger than this (after JSON) is refused rather than buffered. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const EMPTY = new Uint8Array(0);

/** The 6-digit check code both ends show after a pairing handshake (from the handshake hash, so a different peer gives a
 *  different code). */
export function checkCodeOf(handshakeHash: Uint8Array): string {
  const n = ((handshakeHash[0]! << 24) >>> 0) + (handshakeHash[1]! << 16) + (handshakeHash[2]! << 8) + handshakeHash[3]!;
  return String(n % 1_000_000).padStart(6, '0');
}
/** "123 456" for reading aloud or comparing. */
export const groupCheckCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;
/** A short fingerprint of a phone's public key: the first 8 bytes of its SHA-256, as four groups of hex. */
export function keyFingerprint(crypto: NoiseCrypto, publicKey: Uint8Array): string {
  return Array.from(crypto.sha256(publicKey).subarray(0, 8), byte => byte.toString(16).padStart(2, '0')).join('').replace(/(.{4})(?!$)/g, '$1 ');
}

export class SecureChannel {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  constructor(private readonly send: CipherState, private readonly receive: CipherState) {}
  /** Seals one frame into one or more transport messages (base64). */
  seal(frame: MobileFrame): string[] {
    const bytes = utf8(JSON.stringify(frame));
    const out: string[] = [];
    for (let at = 0; at < bytes.length || at === 0; at += CHUNK) {
      const chunk = bytes.subarray(at, at + CHUNK), last = at + CHUNK >= bytes.length;
      out.push(toBase64(this.send.encrypt(EMPTY, concat(Uint8Array.of(last ? 0 : 1), chunk))));
      if (last) break;
    }
    return out;
  }
  /** Opens one transport message; returns the frame once its last chunk arrived, else null. Throws on any tampering. */
  open(message: string): MobileFrame | null {
    // Refused before decrypting: a Noise transport message is at most 65,535 bytes (base64 ≤ 87,380 characters).
    if (message.length > Math.ceil(NOISE_MAX_MESSAGE / 3) * 4) throw new Error('Frame too large.');
    const sealed = fromBase64(message);
    if (sealed.length > NOISE_MAX_MESSAGE) throw new Error('Frame too large.');
    const plain = this.receive.decrypt(EMPTY, sealed);
    if (!plain.length || plain[0]! > 1) throw new Error('Malformed frame.');
    this.pending.push(plain.subarray(1)); this.pendingBytes += plain.length - 1;
    if (this.pendingBytes > MAX_FRAME_BYTES) throw new Error('Frame too large.');
    if (plain[0] === 1) return null;
    const whole = concat(...this.pending);
    this.pending = []; this.pendingBytes = 0;
    const frame = JSON.parse(fromUtf8(whole)) as MobileFrame;
    if (!frame || typeof frame !== 'object' || typeof (frame as {t?: unknown}).t !== 'string') throw new Error('Malformed frame.');
    return frame;
  }
}
