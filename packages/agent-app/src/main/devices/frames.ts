/**
 * Wire formats of the two streaming servers the device helper vendors (#363). Pure byte handling, no I/O, so the tests
 * exercise every split and corruption case directly.
 *
 * - iOS (serve-sim) MJPEG: `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<N bytes>\r\n`, repeated.
 * - Android (serve-emu) video: WebSocket binary messages, an H.264 access unit behind a 16-byte "SEMU" header
 *   (u32 magic, u8 version, u8 flags with bit 0 = keyframe, 2 reserved bytes, u64 pts).
 */
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);
const HEADER_END = Buffer.from('\r\n\r\n');
/** One JPEG is never this big at the helper's capped resolution; a part that claims more is corrupt. */
export const MAX_JPEG_BYTES = 16 * 1024 * 1024;

/** Splits a multipart MJPEG body into whole JPEGs, however the body arrives in chunks. */
export class MjpegParser {
  private buffer: Buffer = Buffer.alloc(0);
  push(chunk: Uint8Array): Buffer[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const frames: Buffer[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd < 0) { if (this.buffer.length > 64 * 1024) this.resync(); break; }
      const header = this.buffer.subarray(0, headerEnd).toString('latin1');
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? NaN);
      const start = headerEnd + HEADER_END.length;
      if (Number.isFinite(length)) {
        if (length <= 0 || length > MAX_JPEG_BYTES) { this.buffer = this.buffer.subarray(start); continue; }
        if (this.buffer.length < start + length) break;
        const jpeg = this.buffer.subarray(start, start + length);
        this.buffer = this.buffer.subarray(start + length);
        if (jpeg[0] === 0xff && jpeg[1] === 0xd8) frames.push(Buffer.from(jpeg));
        continue;
      }
      // No Content-Length: the picture runs from its SOI to the EOI.
      const soi = this.buffer.indexOf(SOI, start);
      if (soi < 0) break;
      const eoi = this.buffer.indexOf(EOI, soi + 2);
      if (eoi < 0) { if (this.buffer.length - soi > MAX_JPEG_BYTES) this.buffer = Buffer.alloc(0); break; }
      frames.push(Buffer.from(this.buffer.subarray(soi, eoi + 2)));
      this.buffer = this.buffer.subarray(eoi + 2);
    }
    // Leading CRLF between parts would otherwise keep growing a buffer that holds no header.
    if (this.buffer.length > MAX_JPEG_BYTES + 64 * 1024) this.buffer = Buffer.alloc(0);
    return frames;
  }
  /** Drops garbage before the next part boundary. */
  private resync(): void {
    const next = this.buffer.indexOf('--', 1);
    this.buffer = next > 0 ? this.buffer.subarray(next) : Buffer.alloc(0);
  }
  get buffered(): number { return this.buffer.length; }
}

export const SEMU_MAGIC = 0x53454d55, SEMU_HEADER_BYTES = 16;
/** Keyframe flag and pts of a serve-emu video message; a message without the header is scanned for an IDR NAL. */
export function semuInfo(data: Uint8Array): {key: boolean; pts?: number; payloadOffset: number} {
  if (data.byteLength > SEMU_HEADER_BYTES) {
    const view = new DataView(data.buffer, data.byteOffset, SEMU_HEADER_BYTES);
    if (view.getUint32(0, false) === SEMU_MAGIC && view.getUint8(4) === 1) {
      const pts = view.getBigUint64(8, false);
      return {key: (view.getUint8(5) & 1) !== 0, payloadOffset: SEMU_HEADER_BYTES, ...(pts <= BigInt(Number.MAX_SAFE_INTEGER) ? {pts: Number(pts)} : {})};
    }
  }
  return {key: hasIdr(data), payloadOffset: 0};
}
/** Annex-B scan for an IDR slice (NAL type 5). */
export function hasIdr(buf: Uint8Array): boolean {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
    const code = buf[i + 2] === 1 ? 3 : buf[i + 2] === 0 && buf[i + 3] === 1 ? 4 : 0;
    if (code && i + code < buf.length && (buf[i + code]! & 0x1f) === 5) return true;
  }
  return false;
}

/** serve-sim helper socket: `[tag][json]` packets. Tags from the browser and from the helper. */
export const IOS_TAG = {touch: 0x03, button: 0x04, key: 0x06, orientation: 0x07, screenConfig: 0x82, inputAdmitted: 0x83} as const;
export function iosPacket(tag: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const out = Buffer.allocUnsafe(1 + json.length);
  out[0] = tag; json.copy(out, 1);
  return out;
}

/** Latest-frame-wins flow control: at most `window` frames wait for the renderer; newer pictures replace older ones. */
export class FrameGate {
  private inFlight = 0;
  private pending: {data: Buffer; key: boolean} | null = null;
  constructor(private readonly window = 2) {}
  /** Returns the frame to send now, or null when it was held (and may later replace an older held one). */
  offer(data: Buffer, key: boolean): Buffer | null {
    if (this.inFlight < this.window) { this.inFlight++; return data; }
    this.pending = {data, key};
    return null;
  }
  /** The renderer finished a frame: release the newest held one, if any. */
  ack(): Buffer | null {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.pending;
    if (!next) return null;
    this.pending = null; this.inFlight++;
    return next.data;
  }
  reset(): void { this.inFlight = 0; this.pending = null; }
  get waiting(): number { return this.inFlight; }
}
