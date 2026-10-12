/**
 * Renderer side of a device stream (#363). One feed per device decodes each frame once into a retained source canvas;
 * every viewer (the tab, a PiP card, the 3D screen texture) copies from it when told a new picture arrived. Nothing
 * runs between frames: no rAF loop, no timers, so an idle or hidden device costs nothing here.
 *
 * JPEG (iOS) decodes with createImageBitmap off the main thread; H.264 (Android) decodes with WebCodecs, configured from
 * the SPS of the first keyframe. Each finished frame is acknowledged so main sends the next (latest frame wins).
 */
import {useEffect, useRef, useState} from 'react';
import type {DeviceFrame} from '../../shared/device-protocol.ts';
import {invoke} from '../bridge.ts';
import {avcCodecFromAnnexB} from './geometry.ts';

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
    this.decodeH264(frame);
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
        this.decoder = new VideoDecoder({
          output: out => { try { this.present(out, out.displayWidth, out.displayHeight); } finally { out.close(); this.ack(); } },
          error: () => { this.closeDecoder(); },
        });
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
    try { decoder.decode(new EncodedVideoChunk({type: frame.key ? 'key' : 'delta', timestamp: frame.pts ?? this.frames * 33_333, data: frame.data})); }
    catch { this.closeDecoder(); }
  }
  private closeDecoder(): void {
    try { this.decoder?.close(); } catch {}
    this.decoder = undefined; this.awaitingKey = true; this.configuring = false;
  }
  private fail(message: string): void { this.error = message; for (const listener of [...this.listeners]) listener(); }
}

const feeds = new Map<string, DeviceFeed>();
/** The shared feed of a device (created on first use, dropped when its last viewer goes). */
export function acquireFeed(deviceId: string): DeviceFeed {
  let feed = feeds.get(deviceId);
  if (!feed) { feed = new DeviceFeed(deviceId, () => window.musterDevices?.ack(deviceId)); feeds.set(deviceId, feed); }
  feed.retain();
  return feed;
}
export function releaseFeed(feed: DeviceFeed): void { if (feed.release()) feeds.delete(feed.deviceId); }

let viewerSeq = 0;
/**
 * A viewer of a device: holds the shared feed, tells main whether this viewer is on screen (video runs only while one
 * is), and returns the feed plus a counter that changes with every new picture.
 */
export function useDeviceFeed(deviceId: string | undefined, active: boolean): {feed?: DeviceFeed; tick: number} {
  const [feed, setFeed] = useState<DeviceFeed>();
  const [tick, setTick] = useState(0);
  const viewer = useRef(`v${++viewerSeq}`);
  useEffect(() => {
    if (!deviceId) return;
    const next = acquireFeed(deviceId);
    setFeed(next);
    const off = next.subscribe(() => setTick(value => value + 1));
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

/** Copies the feed's latest picture into a viewer canvas sized to its box (device pixels), only when a frame arrived. */
export function paintInto(target: HTMLCanvasElement | null, feed: DeviceFeed | undefined): void {
  if (!target || !feed || !feed.width) return;
  if (target.width !== feed.width || target.height !== feed.height) { target.width = feed.width; target.height = feed.height; }
  target.getContext?.('2d', {alpha: false})?.drawImage(feed.canvas, 0, 0);
}
