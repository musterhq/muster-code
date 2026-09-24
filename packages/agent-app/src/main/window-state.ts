import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface WindowGeometry {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface DisplayBounds { x: number; y: number; width: number; height: number }

export const DEFAULT_GEOMETRY: WindowGeometry = { width: 1280, height: 840, maximized: false };
export const MIN_WIDTH = 760;
export const MIN_HEIGHT = 480;

/** Clamp persisted geometry so the window is always usable and at least partially on-screen. */
export function clampGeometry(geometry: WindowGeometry, displays: DisplayBounds[]): WindowGeometry {
  const out: WindowGeometry = {
    width: Math.max(MIN_WIDTH, Math.floor(geometry.width) || DEFAULT_GEOMETRY.width),
    height: Math.max(MIN_HEIGHT, Math.floor(geometry.height) || DEFAULT_GEOMETRY.height),
    maximized: geometry.maximized === true,
  };
  if (typeof geometry.x === 'number' && typeof geometry.y === 'number' && Number.isFinite(geometry.x) && Number.isFinite(geometry.y)) {
    const x = Math.floor(geometry.x);
    const y = Math.floor(geometry.y);
    // Require a meaningful sliver of the window (title bar area) inside some display.
    const visible = displays.some((d) =>
      x + out.width > d.x + 40 &&
      x < d.x + d.width - 40 &&
      y >= d.y - 8 &&
      y < d.y + d.height - 40,
    );
    if (visible) {
      out.x = x;
      out.y = y;
    }
  }
  // Never exceed the largest display.
  const maxW = Math.max(0, ...displays.map((d) => d.width));
  const maxH = Math.max(0, ...displays.map((d) => d.height));
  if (maxW > 0) out.width = Math.min(out.width, maxW);
  if (maxH > 0) out.height = Math.min(out.height, maxH);
  return out;
}

export type DisplayChangePlan =
  | { kind: 'keep' }
  | { kind: 'resize'; width: number; height: number }
  /** The window no longer touches any display: shrink to fit and let the shell centre it on the primary display. */
  | { kind: 'center'; width: number; height: number };

/** Re-clamp a live window after a display is unplugged or rescaled. Maximized/full-screen windows are the OS's job. */
export function planDisplayChange(current: WindowGeometry, displays: DisplayBounds[]): DisplayChangePlan {
  if (current.maximized || displays.length === 0) return { kind: 'keep' };
  const clamped = clampGeometry(current, displays);
  const sized = clamped.width !== current.width || clamped.height !== current.height;
  const onScreen = clamped.x !== undefined && clamped.y !== undefined;
  if (!onScreen) return { kind: 'center', width: clamped.width, height: clamped.height };
  return sized ? { kind: 'resize', width: clamped.width, height: clamped.height } : { kind: 'keep' };
}

export function parseGeometry(raw: string): WindowGeometry | null {
  try {
    const data = JSON.parse(raw) as Partial<WindowGeometry> | null;
    if (!data || typeof data !== 'object') return null;
    if (typeof data.width !== 'number' || typeof data.height !== 'number') return null;
    return {
      x: typeof data.x === 'number' ? data.x : undefined,
      y: typeof data.y === 'number' ? data.y : undefined,
      width: data.width,
      height: data.height,
      maximized: data.maximized === true,
    };
  } catch {
    return null;
  }
}

export class WindowStateStore {
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'window-state.json');
  }

  async load(): Promise<WindowGeometry | null> {
    try {
      return parseGeometry(await fs.readFile(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  async save(geometry: WindowGeometry): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(geometry), 'utf8');
    } catch {
      // Persistence is best-effort; never block shutdown on it.
    }
  }
}
