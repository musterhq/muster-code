import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { transformSync } from "esbuild";
import { letterboxViewport, resolvePresetSize, resolveViewportSetting } from "../src/browser-viewport.js";
import { saveScreenshotPng } from "../src/browser-screenshot.js";
import { runWaitFor } from "../src/browser-wait-for.js";

const root = resolve(process.cwd());
const mcpSource = readFileSync(join(root, "src", "browser-mcp.ts"), "utf8");
const mainSource = readFileSync(join(root, "..", "..", "product", "muster-browser-main.js"), "utf8");

type BrowserToolServerCtor = new (...args: any[]) => {
  execute: (tool: string, args: Record<string, unknown>) => Promise<{ text?: string; image?: string; isError?: boolean }>;
};

function loadBrowserTools(mocks: Record<string, unknown>) {
  const code = transformSync(readFileSync(join(root, "src", "browser-tools.ts"), "utf8"), { loader: "ts", format: "cjs", target: "es2022" }).code;
  const module = { exports: {} as Record<string, unknown> };
  const req = (name: string) => {
    if (name in mocks) return mocks[name];
    if (name === "vscode") return mocks.vscode;
    if (name.endsWith(".js")) {
      const rel = name.replace(/^\.\//, "").replace(/\.js$/, ".ts");
      const path = join(root, "src", rel);
      const sub = transformSync(readFileSync(path, "utf8"), { loader: "ts", format: "cjs", target: "es2022" }).code;
      const subMod = { exports: {} };
      new Function("require", "module", "exports", sub)(req, subMod, subMod.exports);
      return subMod.exports;
    }
    return require(name);
  };
  new Function("require", "module", "exports", code)(req, module, module.exports);
  return module.exports.BrowserToolServer as BrowserToolServerCtor;
}

test("tools/list includes new tools with annotations and unique names", () => {
  const names = [...mcpSource.matchAll(/name: "(browser_[^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, names.length, "duplicate tool names");
  for (const required of ["browser_scroll", "browser_resize", "browser_set_appearance", "browser_status"]) assert.ok(names.includes(required), required);
  assert.match(mcpSource, /readOnlyHint/);
  assert.match(mcpSource, /browser_status/);
  const toolBlocks = mcpSource.split("{ name: \"browser_").slice(1);
  assert.equal(toolBlocks.length, names.length);
  for (const block of toolBlocks) assert.match(block, /annotations: ann\(/);
});

test("browser_resize letterbox preset orientations", () => {
  const portrait = resolvePresetSize("iphone-12-pro", "portrait");
  assert.equal(portrait.width, 390);
  assert.equal(portrait.height, 844);
  const landscape = resolvePresetSize("iphone-12-pro", "landscape");
  assert.equal(landscape.width, 844);
  assert.equal(landscape.height, 390);
  const lb = letterboxViewport(800, 600, landscape.width, landscape.height);
  assert.equal(lb.width, 800);
  assert.equal(lb.height, 370);
  assert.equal(lb.offsetX, 0);
  assert.equal(lb.offsetY, 115);
});

test("browser_screenshot save=true writes PNG and returns path text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-shot-"));
  const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAD0lEQVR42mP8z59/QAD//wM9f+1l/1xTAAAAAElFTkSuQmCC";
  const path = saveScreenshotPng(dir, "example.com", png1x1);
  assert.ok(existsSync(path));
  assert.match(path, /\.muster\/screenshots\/\d+-example\.com\.png$/);
  rmSync(dir, { recursive: true, force: true });

  const tab = { id: "b1", url: "https://example.com/", title: "Ex", console: [], driving: false, headless: false, picked: null, picking: false, changes: [] };
  const commands = new Map<string, (args?: any) => Promise<unknown>>();
  commands.set("muster.browser.capture", async () => `data:image/png;base64,${png1x1}`);
  const browser = {
    list: () => [tab],
    get: () => tab,
    setDriving: () => {},
    onTakeControl: () => () => {},
    diagnostics: () => ({}),
    status: () => ({}),
    setViewport: async () => ({}),
    setAppearance: async () => ({}),
  };
  const vscode = { commands: { executeCommand: async (cmd: string, args?: unknown) => { const h = commands.get(cmd); return h ? h(args) : null; } } };
  const Server = loadBrowserTools({ vscode });
  const server = new Server(browser, () => "b1", () => tab, () => {}, () => dir);
  const result = await server.execute("browser_screenshot", { save: true });
  assert.ok(result.image);
  assert.match(result.text ?? "", /screenshotPath:/);
  assert.match(result.text ?? "", /Embed it in your reply/);
  rmSync(join(dir, ".muster"), { recursive: true, force: true });
});

test("browser_wait_for resolves and times out with condition name", async () => {
  let calls = 0;
  let clock = 0;
  const ok = await runWaitFor({ selector: "#x" }, {
    timeoutMs: 500,
    pollMs: 10,
    evalJs: async () => { calls++; return calls >= 3; },
    sleep: async () => { clock += 10; },
    now: () => clock,
  });
  assert.equal(ok.ok, true);

  const fail = await runWaitFor({ text: "hello" }, {
    timeoutMs: 100,
    pollMs: 20,
    evalJs: async () => false,
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 25); })(),
  });
  assert.equal(fail.ok, false);
  if (!fail.ok) assert.equal(fail.failed, "text");
});

test("browser_set_appearance and browser_status via tool server", async () => {
  const tab: any = { id: "b1", url: "http://localhost/", title: "T", console: [], driving: false, headless: false, picked: null, picking: false, changes: [], colorScheme: "system", viewport: { mode: "preset", preset: "iphone-se", width: 375, height: 667, measured: { width: 375, height: 667 } } };
  const commands = new Map<string, (args?: any) => Promise<unknown>>();
  commands.set("muster.browser.setAppearance", async (args) => {
    if (args.colorScheme === "dark") return { colorScheme: "dark" };
    return { error: "attach failed" };
  });
  commands.set("muster.browser.eval", async () => ({ width: 375, height: 667 }));
  commands.set("muster.browser.viewport", async () => ({ width: 375, height: 667 }));
  const browser = {
    list: () => [tab],
    get: () => tab,
    setDriving: () => {},
    onTakeControl: () => () => {},
    diagnostics: () => ({ id: "b1", url: tab.url, title: tab.title, loading: false, history: { canGoBack: false, canGoForward: false }, console: { total: 0, errors: 0, warnings: 0 }, networkErrors: [], changes: 0 }),
    status: () => ({ id: "b1", url: tab.url, title: tab.title, loading: false, history: { canGoBack: false, canGoForward: false }, console: { total: 0, errors: 1, warnings: 0 }, networkErrors: [], changes: 0, viewport: { width: 375, height: 667, mode: "preset", preset: "iphone-se" }, colorScheme: tab.colorScheme, recording: "unsupported" }),
    setViewport: async (_id: string, input: any) => {
      const setting = resolveViewportSetting(input);
      tab.viewport = { ...setting, measured: { width: setting.mode === "fill" ? 800 : setting.width, height: setting.mode === "fill" ? 600 : setting.height } };
      const layout = await commands.get("muster.browser.viewport")!({ id: "b1", viewport: setting });
      return { viewport: { width: (layout as any).width, height: (layout as any).height, mode: setting.mode, ...(setting.mode === "preset" ? { preset: setting.preset } : {}) } };
    },
    setAppearance: async (_id: string, scheme: string) => {
      const r = await commands.get("muster.browser.setAppearance")!({ id: "b1", colorScheme: scheme }) as any;
      if (r.error) return { error: r.error };
      tab.colorScheme = scheme;
      return { colorScheme: scheme };
    },
  };
  const vscode = { commands: { executeCommand: async (cmd: string, args?: unknown) => { const h = commands.get(cmd); return h ? h(args) : null; } } };
  const Server = loadBrowserTools({ vscode });
  const server = new Server(browser, () => "b1", () => tab, () => {});

  const bad = await server.execute("browser_set_appearance", { colorScheme: "light" });
  assert.equal(bad.isError, true);
  assert.match(bad.text ?? "", /attach failed/);

  const good = await server.execute("browser_set_appearance", { colorScheme: "dark" });
  assert.equal(good.isError, undefined);
  assert.match(good.text ?? "", /dark/);

  const status = await server.execute("browser_status", {});
  const parsed = JSON.parse(status.text ?? "{}");
  assert.equal(parsed.viewport.preset, "iphone-se");
  assert.equal(parsed.colorScheme, "dark");
  assert.equal(parsed.recording, "unsupported");
});

test("main process setAppearance uses emulation and capture supports fullPage flag", () => {
  assert.match(mainSource, /setAppearance/);
  assert.match(mainSource, /Emulation\.setEmulatedMedia/);
  assert.match(mainSource, /fullPage/);
});
