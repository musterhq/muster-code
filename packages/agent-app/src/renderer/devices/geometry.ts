/** Pure geometry for the device view (#363): where a picture sits in its box, and where a pointer lands on the device. */
export interface Box {left: number; top: number; width: number; height: number}

/** The rectangle a `width`×`height` picture occupies when contained (letterboxed) in `box`. */
export function containRect(box: Box, width: number, height: number): Box {
  if (!(width > 0 && height > 0 && box.width > 0 && box.height > 0)) return {left: box.left, top: box.top, width: 0, height: 0};
  const scale = Math.min(box.width / width, box.height / height);
  const w = width * scale, h = height * scale;
  return {left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h};
}
/** A client point as 0..1 coordinates on the device screen, or null when it falls outside the picture. */
export function pointOnScreen(clientX: number, clientY: number, picture: Box): {x: number; y: number} | null {
  if (!(picture.width > 0 && picture.height > 0)) return null;
  const x = (clientX - picture.left) / picture.width, y = (clientY - picture.top) / picture.height;
  return x < 0 || y < 0 || x > 1 || y > 1 ? null : {x, y};
}
/** The same point clamped to the screen edge (a drag that leaves the picture keeps moving along its edge). */
export function clampedPointOnScreen(clientX: number, clientY: number, picture: Box): {x: number; y: number} {
  const x = picture.width > 0 ? (clientX - picture.left) / picture.width : 0, y = picture.height > 0 ? (clientY - picture.top) / picture.height : 0;
  return {x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y))};
}
/** WebCodecs `avc1.PPCCLL` from the first SPS NAL of an Annex-B access unit, or null when it carries none. */
export function avcCodecFromAnnexB(buf: Uint8Array): string | null {
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
    const code = buf[i + 2] === 1 ? 3 : buf[i + 2] === 0 && buf[i + 3] === 1 ? 4 : 0;
    if (!code) continue;
    const nal = i + code;
    if ((buf[nal]! & 0x1f) === 7 && nal + 3 < buf.length) {
      const hex = (byte: number) => byte.toString(16).padStart(2, '0');
      return `avc1.${hex(buf[nal + 1]!)}${hex(buf[nal + 2]!)}${hex(buf[nal + 3]!)}`;
    }
  }
  return null;
}
/** WebCodecs `avc1.PPCCLL` from an avcC decoder description (iOS AVCC stream); null when it is not one. */
export function avcCodecFromDescription(avcc: Uint8Array): string | null {
  if (avcc.length < 4 || avcc[0] !== 1) return null;
  const hex = (byte: number) => byte.toString(16).padStart(2, '0');
  return `avc1.${hex(avcc[1]!)}${hex(avcc[2]!)}${hex(avcc[3]!)}`;
}
/** "Live", "Stale · 4s", or "Reconnecting" for the header pill. */
export type FeedHealth = 'live' | 'stale' | 'waiting';
export function feedHealth(lastFrameAt: number | undefined, now: number, staleMs = 3000): FeedHealth {
  if (!lastFrameAt) return 'waiting';
  return now - lastFrameAt < staleMs ? 'live' : 'stale';
}
