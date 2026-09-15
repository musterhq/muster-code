import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PNG_PREFIX = "data:image/png;base64,";

export function decodeScreenshotDataUrl(data: string): Buffer {
  const raw = data.startsWith(PNG_PREFIX) ? data.slice(PNG_PREFIX.length) : data;
  return Buffer.from(raw, "base64");
}

export function screenshotDir(cwd: string | undefined): string {
  if (cwd) return join(cwd, ".muster", "screenshots");
  return join(tmpdir(), "muster-screenshots");
}

export function saveScreenshotPng(cwd: string | undefined, slug: string, pngBase64: string): string {
  const dir = screenshotDir(cwd);
  mkdirSync(dir, { recursive: true });
  const safe = slug.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "page";
  const path = join(dir, `${Date.now()}-${safe}.png`);
  writeFileSync(path, decodeScreenshotDataUrl(pngBase64));
  return path;
}

export const SCREENSHOT_EMBED_HINT =
  "Embed it in your reply as ![alt](/abs/path) so the user sees it inline.";
