/** Device presets for browser_resize (CSS px). Keep in sync with product/muster-inline-diff.js VIEWPORT_PRESETS. */
export const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  "iphone-se": { width: 375, height: 667 },
  "iphone-12-pro": { width: 390, height: 844 },
  "pixel-7": { width: 412, height: 915 },
  ipad: { width: 820, height: 1180 },
  "desktop-1280": { width: 1280, height: 800 },
  "desktop-1440": { width: 1440, height: 900 },
};

export type ViewportMode = "fill" | "freeform" | "preset";
export type ViewportSetting =
  | { mode: "fill" }
  | { mode: "freeform"; width: number; height: number }
  | { mode: "preset"; preset: keyof typeof VIEWPORT_PRESETS | string; width: number; height: number };

export function resolvePresetSize(preset: string, orientation?: "portrait" | "landscape"): { width: number; height: number } {
  const base = VIEWPORT_PRESETS[preset];
  if (!base) throw new Error(`Unknown viewport preset "${preset}".`);
  let { width, height } = base;
  const landscape = orientation === "landscape";
  const portrait = orientation === "portrait";
  if (landscape && width < height) [width, height] = [height, width];
  if (portrait && width > height) [width, height] = [height, width];
  return { width, height };
}

export function resolveViewportSetting(input: {
  mode: ViewportMode;
  width?: number;
  height?: number;
  preset?: string;
  orientation?: "portrait" | "landscape";
}): ViewportSetting {
  if (input.mode === "fill") return { mode: "fill" };
  if (input.mode === "freeform") {
    const width = Number(input.width);
    const height = Number(input.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error("freeform mode requires width and height.");
    return { mode: "freeform", width: Math.round(width), height: Math.round(height) };
  }
  const preset = String(input.preset ?? "");
  if (!preset) throw new Error("preset mode requires preset.");
  const { width, height } = resolvePresetSize(preset, input.orientation);
  return { mode: "preset", preset, width, height };
}

/** Letterbox target CSS viewport inside host bounds; returns view size and offsets within the host. */
export function letterboxViewport(hostWidth: number, hostHeight: number, targetWidth: number, targetHeight: number): {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
} {
  const scale = Math.min(1, hostWidth / targetWidth, hostHeight / targetHeight);
  const width = Math.max(1, Math.round(targetWidth * scale));
  const height = Math.max(1, Math.round(targetHeight * scale));
  const offsetX = Math.round((hostWidth - width) / 2);
  const offsetY = Math.round((hostHeight - height) / 2);
  return { offsetX, offsetY, width, height };
}

export function viewportFromSetting(setting: ViewportSetting, hostWidth: number, hostHeight: number): {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  mode: ViewportMode;
  preset?: string;
} {
  if (setting.mode === "fill") {
    return { offsetX: 0, offsetY: 0, width: Math.max(1, Math.round(hostWidth)), height: Math.max(1, Math.round(hostHeight)), mode: "fill" };
  }
  const lb = letterboxViewport(hostWidth, hostHeight, setting.width, setting.height);
  return { ...lb, mode: setting.mode, ...(setting.mode === "preset" ? { preset: setting.preset } : {}) };
}
