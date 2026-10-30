import {ClampToEdgeWrapping, LinearFilter, SRGBColorSpace, Texture} from 'three';

/** Anything WebGL can upload as a texture. ImageBitmap and VideoFrame are closed by the engine when `own` is set. */
export type FrameSource = HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap | ImageData | HTMLImageElement | VideoFrame;

/** What FrameTexture needs from the engine (kept narrow so it can be driven by a test double). */
export interface FrameHost {
  /** Ask for one more render. */
  invalidate(): void;
  /** Run `callback` once after the next completed render (when the upload has happened). */
  afterNextRender(callback: () => void): void;
}

const isClosable = (frame: unknown): frame is {close(): void} => typeof (frame as {close?: unknown}).close === 'function';

/**
 * A texture fed by pushed frames: device-stream JPEG/BGRA frames (ImageBitmap), a canvas, or a playing <video>.
 *
 * The engine renders only when a frame arrives, never on a timer, so a paused or hidden stream costs no GPU.
 * Orientation: every source is uploaded unflipped and the texture transform maps image row 0 to v = 1, so the image
 * is upright on a mesh whose v = 1 edge is up (three.js default planes) and `uvToPixel(uv, w, h)` gives the pixel.
 */
export class FrameTexture {
  readonly texture: Texture;
  private current: FrameSource | null = null;
  private ownsCurrent = false;
  private stopVideo: (() => void) | null = null;
  private disposed = false;
  /** Frames received. Useful for stats and tests. */
  frames = 0;

  constructor(private readonly host: FrameHost) {
    this.texture = new Texture();
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.flipY = false;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.wrapS = this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.repeat.set(1, -1);
    this.texture.offset.set(0, 1);
  }

  get size(): {width: number; height: number} | null {
    const s = this.current as {width?: number; height?: number; videoWidth?: number; videoHeight?: number; displayWidth?: number; displayHeight?: number} | null;
    if (!s) return null;
    const width = s.videoWidth ?? s.displayWidth ?? s.width ?? 0, height = s.videoHeight ?? s.displayHeight ?? s.height ?? 0;
    return width && height ? {width, height} : null;
  }

  /**
   * Show `frame` on the next render. With `own: true` the engine closes the previous ImageBitmap / VideoFrame once the
   * new one is on the GPU, so callers can stream `createImageBitmap(...)` results without leaking.
   */
  update(frame: FrameSource, options: {own?: boolean} = {}): void {
    if (this.disposed) { if (options.own && isClosable(frame)) frame.close(); return; }
    const previous = this.current, previousOwned = this.ownsCurrent;
    this.current = frame;
    this.ownsCurrent = Boolean(options.own);
    this.texture.image = frame as never;
    this.texture.needsUpdate = true;
    this.frames++;
    if (previous && previous !== frame && previousOwned && isClosable(previous)) this.host.afterNextRender(() => previous.close());
    this.host.invalidate();
  }

  /**
   * Mirror a <video> element. Uses requestVideoFrameCallback so a render is requested only when the decoder presents a
   * new frame (a paused video requests none). Returns a detach function.
   */
  attachVideo(video: HTMLVideoElement): () => void {
    this.detachVideo();
    let handle = 0, stopped = false;
    const withCallback = video as HTMLVideoElement & {requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (id: number) => void};
    const present = () => {
      if (stopped || this.disposed) return;
      this.current = video; this.ownsCurrent = false; this.texture.image = video; this.texture.needsUpdate = true; this.frames++;
      this.host.invalidate();
      schedule();
    };
    const schedule = () => {
      if (stopped) return;
      if (withCallback.requestVideoFrameCallback) handle = withCallback.requestVideoFrameCallback(present);
    };
    const onSeek = () => present();
    video.addEventListener('seeked', onSeek);
    video.addEventListener('loadeddata', onSeek);
    present();
    this.stopVideo = () => {
      stopped = true;
      video.removeEventListener('seeked', onSeek); video.removeEventListener('loadeddata', onSeek);
      if (handle) withCallback.cancelVideoFrameCallback?.(handle);
    };
    return () => this.detachVideo();
  }

  detachVideo(): void { this.stopVideo?.(); this.stopVideo = null; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachVideo();
    const frame = this.ownsCurrent ? this.current : null;
    this.current = null;
    this.texture.image = null as never;
    this.texture.dispose();
    if (frame && isClosable(frame)) { try { frame.close(); } catch { /* already closed */ } }
  }
}
