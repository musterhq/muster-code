/**
 * Renderer side of a device stream (#363). One feed per device decodes each frame once into a retained source canvas;
 * every viewer (the tab, a PiP card, the 3D screen texture) copies from it when told a new picture arrived. Nothing
 * runs between frames: no rAF loop, no timers, so an idle or hidden device costs nothing here.
 *
 * iOS sends H.264 as AVCC: a decoder description (avcC) and then length-prefixed access units, decoded with WebCodecs
 * after `isConfigSupported` (some decoders reject the simulators' High profile). If this window cannot decode it, the feed
 * asks main to switch that device to MJPEG, decoded with createImageBitmap. Android sends Annex-B H.264, configured from
 * the SPS of the first keyframe. Each finished frame is acknowledged so main keeps sending (flow control).
 * The AVCC handling and the MJPEG fallback follow T3 Code's device stream client (MIT; see THIRD_PARTY_NOTICES.md); the
 * description is repaired first (avcConfig.ts, the stall fix) so the decoder never holds frames back for reordering.
 */
import {useEffect, useRef, useState} from 'react';
import type {DeviceFrame} from '../../shared/device-protocol.ts';
import {invoke} from '../bridge.ts';
import {avcCodecFromAnnexB, avcCodecFromDescription} from './geometry.ts';
import {simulatorAvcConfig} from './avcConfig.ts';

type Listener = () => void;
export class DeviceFeed {
  readonly canvas: HTMLCanvasElement;
  width = 0; height = 0; lastFrameAt = 0; frames = 0;
  error?: string;
  private listeners = new Set<Listener>();
  private decoder?: VideoDecoder;
  private configuring = false;
  private awaitingKey = true;
  private unsubscribe?: () => void;
  /** iOS: frames that arrived while the decoder was being configured from its description. */
  private pending: DeviceFrame[] = [];
  private format?: 'annexb' | 'avcc';
  private fellBack = false;
  private timestamp = 0;
  /** Asked main to stream MJPEG for this device (set once per feed). */
  onFallback?: () => void;
  private refs = 0;
  constructor(readonly deviceId: string, private readonly ack: () => void) {
    this.canvas = document.createElement('canvas');
  }
  retain(): void {
    if (this.refs++) return;
    this.unsubscribe = window.musterDevices?.onFrame(frame => { if (frame.deviceId === this.deviceId) this.accept(frame); });
  }
  release(): boolean {
    if (--this.refs > 0) return false;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.closeDecoder();
    return true;
  }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private present(source: CanvasImageSource, width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    this.canvas.getContext?.('2d', {alpha: false})?.drawImage(source, 0, 0, width, height);
    this.width = width; this.height = height; this.lastFrameAt = Date.now(); this.frames++; this.error = undefined;
    for (const listener of [...this.listeners]) listener();
  }
  private accept(frame: DeviceFrame): void {
    if (frame.codec === 'jpeg') {
      void createImageBitmap(new Blob([frame.data as BlobPart], {type: 'image/jpeg'}))
        .then(bitmap => { try { this.present(bitmap, bitmap.width, bitmap.height); } finally { bitmap.close(); } }, () => {})
        .finally(() => this.ack());
      return;
    }
    if (frame.reset) { this.closeDecoder(); return; }
    if (frame.config) { void this.configureAvcc(frame.data); return; }
    if (frame.format === 'avcc') { if (this.configuring) { if (this.pending.length < 120) this.pending.push(frame); } else this.decode(frame); return; }
    this.decodeH264(frame);
  }
  /** iOS: a new description (a fresh subscription or an encoder change) configures a fresh decoder. */
  private async configureAvcc(raw: Uint8Array): Promise<void> {
    this.closeDecoder();
    // The stall fix (#811): the hub's fallback SPS gets "no reordering" VUI so each frame is output once decoded.
    const description = simulatorAvcConfig(raw);
    this.format = 'avcc';
    const codec = avcCodecFromDescription(description);
    if (typeof VideoDecoder === 'undefined' || !codec) { this.fallBack(); return; }
    this.configuring = true;
    const config: VideoDecoderConfig = {codec, description, optimizeForLatency: true};
    const support = await VideoDecoder.isConfigSupported(config).catch(() => ({supported: false}));
    if (this.format !== 'avcc' || !this.configuring) return;
    this.configuring = false;
    if (!support.supported) { this.fallBack(); return; }
    try {
      this.decoder = this.makeDecoder(() => this.fallBack());
      this.decoder.configure(config);
    } catch { this.fallBack(); return; }
    this.awaitingKey = true;
    const queued = this.pending; this.pending = [];
    for (const frame of queued) this.decode(frame);
  }
  private makeDecoder(onError: () => void): VideoDecoder {
    const decoder: VideoDecoder = new VideoDecoder({
      output: out => { try { if (this.decoder === decoder) this.present(out, out.displayWidth, out.displayHeight); } finally { out.close(); this.ack(); } },
      error: () => { if (this.decoder === decoder) { this.closeDecoder(); onError(); } },
    });
    return decoder;
  }
  /** This window cannot decode the simulator's H.264: main streams MJPEG to this device from now on. */
  private fallBack(): void {
    this.closeDecoder();
    if (this.fellBack) return;
    this.fellBack = true;
    this.onFallback?.();
  }
  private decodeH264(frame: DeviceFrame): void {
    if (typeof VideoDecoder === 'undefined') { this.fail('This build cannot decode the emulator’s video.'); return; }
    if (!this.decoder || this.decoder.state !== 'configured') {
      const codec = frame.key ? avcCodecFromAnnexB(frame.data) : null;
      if (!codec || this.configuring) return;
      this.configuring = true;
      void VideoDecoder.isConfigSupported({codec, optimizeForLatency: true}).then(support => {
        this.configuring = false;
        if (!support.supported) { this.fail(`This computer cannot decode the emulator’s ${codec} video.`); return; }
        this.format = 'annexb';
        this.decoder = this.makeDecoder(() => {});
        this.decoder.configure({codec, optimizeForLatency: true});
        this.awaitingKey = true;
        this.decode(frame);
      }, () => { this.configuring = false; });
      return;
    }
    this.decode(frame);
  }
  private decode(frame: DeviceFrame): void {
    const decoder = this.decoder;
    if (!decoder || decoder.state !== 'configured') return;
    if (this.awaitingKey) { if (!frame.key) return; this.awaitingKey = false; }
    // Monotonic timestamps at the native 60 fps cadence when the stream carries none.
    this.timestamp = frame.pts ?? this.timestamp + 16_667;
    try { decoder.decode(new EncodedVideoChunk({type: frame.key ? 'key' : 'delta', timestamp: this.timestamp, data: frame.data})); }
    catch { this.closeDecoder(); }
  }
  private closeDecoder(): void {
    try { this.decoder?.close(); } catch {}
    this.decoder = undefined; this.awaitingKey = true; this.configuring = false; this.pending = [];
  }
  private fail(message: string): void { this.error = message; for (const listener of [...this.listeners]) listener(); }
}

const feeds = new Map<string, DeviceFeed>();
/** The shared feed of a device (created on first use, dropped when its last viewer goes). */
export function acquireFeed(deviceId: string): DeviceFeed {
  let feed = feeds.get(deviceId);
  if (!feed) {
    feed = new DeviceFeed(deviceId, () => window.musterDevices?.ack(deviceId));
    feed.onFallback = () => void invoke('devices.streamFallback', {id: deviceId}).catch(() => undefined);
    feeds.set(deviceId, feed);
  }
  feed.retain();
  return feed;
}
export function releaseFeed(feed: DeviceFeed): void { if (feed.release()) feeds.delete(feed.deviceId); }

let viewerSeq = 0;
/** What a viewer's layout depends on: the picture size and the error. Frames that keep both re-render nothing. */
const shapeOf = (feed: DeviceFeed) => `${feed.width}x${feed.height}|${feed.error ?? ''}`;
/**
 * A viewer of a device: holds the shared feed and tells main whether this viewer is on screen (video runs only while
 * one is). `tick` changes only when the picture's size or error changes (first frame, rotation, a decoder failure), so
 * a 30 fps stream does not re-render React; viewers draw each frame through `useFeedPaint`.
 */
export function useDeviceFeed(deviceId: string | undefined, active: boolean): {feed?: DeviceFeed; tick: number} {
  const [feed, setFeed] = useState<DeviceFeed>();
  const [tick, setTick] = useState(0);
  const viewer = useRef(`v${++viewerSeq}`);
  useEffect(() => {
    if (!deviceId) return;
    const next = acquireFeed(deviceId);
    setFeed(next);
    let shape = shapeOf(next);
    const off = next.subscribe(() => { const now = shapeOf(next); if (now !== shape) { shape = now; setTick(value => value + 1); } });
    return () => { off(); releaseFeed(next); setFeed(undefined); };
  }, [deviceId]);
  useEffect(() => {
    if (!deviceId) return;
    const id = deviceId, name = viewer.current;
    void invoke('devices.view', {id, viewer: name, active}).catch(() => undefined);
    return () => { if (active) void invoke('devices.view', {id, viewer: name, active: false}).catch(() => undefined); };
  }, [deviceId, active]);
  return {feed, tick};
}
/** Calls `paint` for every new picture (outside React) and once whenever `deps` change, e.g. a canvas remounts. */
export function useFeedPaint(feed: DeviceFeed | undefined, paint: (feed: DeviceFeed, frame: number) => void, deps: readonly unknown[] = []): void {
  const latest = useRef(paint);
  latest.current = paint;
  useEffect(() => {
    if (!feed) return;
    if (feed.width) latest.current(feed, feed.frames);
    return feed.subscribe(() => { if (feed.width) latest.current(feed, feed.frames); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed, ...deps]);
}

/** Copies the feed's latest picture into a viewer canvas sized to its box (device pixels), only when a frame arrived. */
export function paintInto(target: HTMLCanvasElement | null, feed: DeviceFeed | undefined): void {
  if (!target || !feed || !feed.width) return;
  if (target.width !== feed.width || target.height !== feed.height) { target.width = feed.width; target.height = feed.height; }
  target.getContext?.('2d', {alpha: false})?.drawImage(feed.canvas, 0, 0);
}
