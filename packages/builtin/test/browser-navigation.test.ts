import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

class Emitter {
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  on(name: string, fn: (...args: any[]) => void) { (this.listeners.get(name) ?? this.listeners.set(name, new Set()).get(name)!).add(fn); return this; }
  once(name: string, fn: (...args: any[]) => void) { const wrapped = (...args: any[]) => { this.removeListener(name, wrapped); fn(...args); }; return this.on(name, wrapped); }
  removeListener(name: string, fn: (...args: any[]) => void) { this.listeners.get(name)?.delete(fn); return this; }
  removeAllListeners(name?: string) { if (name) this.listeners.delete(name); else this.listeners.clear(); return this; }
  emit(name: string, ...args: any[]) { for (const fn of [...(this.listeners.get(name) ?? [])]) fn(...args); return true; }
}

class FakeContents extends Emitter {
  currentUrl = ""; loading = false; calls: string[] = []; rejectNext = false; history = { back: false, forward: false };
  session = { setCertificateVerifyProc: () => {}, webRequest: { onBeforeSendHeaders: () => {} } };
  navigationHistory = { canGoBack: () => this.history.back, canGoForward: () => this.history.forward, goBack: () => { this.loading = true; }, goForward: () => { this.loading = true; } };
  loadURL(url: string) { this.calls.push(url); this.loading = true; if (this.rejectNext) { this.rejectNext = false; return Promise.reject(new Error("protocol refused")); } return Promise.resolve(); }
  getURL() { return this.currentUrl; }
  isLoading() { return this.loading; }
  reloadIgnoringCache() { this.loading = true; }
  focus() {}
  sendInputEvent() {}
  executeJavaScript() { return Promise.resolve(true); }
  capturePage() { return Promise.resolve({ toDataURL: () => "data:image/png;base64,AA==" }); }
  setWindowOpenHandler() {}
  openDevTools() {}
  close() {}
}

class FakeView { webContents = new FakeContents(); visible = false; bounds: any;
  constructor(_options: unknown) {}
  setBounds(bounds: any) { this.bounds = bounds; }
  setVisible(value: boolean) { this.visible = value; }
}

test("navigation waiters survive A to B supersession and stale stop events", async () => {
  const ipc: any = { handle: (_name: string, fn: any) => { ipc.handler = fn; } };
  const children: FakeView[] = [];
  const win: any = { id: 7, contentView: { addChildView: (view: FakeView) => children.push(view), removeChildView: () => {} } };
  const source = readFileSync(join(resolve(process.cwd()), "..", "..", "product", "muster-browser-main.js"), "utf8").replace(/^import .*?;\n/m, "");
  vm.runInNewContext(source, { console, Map, Promise, URL, Error, String, setTimeout, clearTimeout, setImmediate, __mbIpcMain: ipc, __mbWebContentsView: FakeView, __mbBrowserWindow: { fromWebContents: () => win } });
  const invoke = (message: any) => ipc.handler({ sender: new FakeContents() }, message);
  await invoke({ id: "b1", type: "open", url: "http://a.test/" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const wc = children[0]!.webContents;
  assert.equal(wc.calls[0], "http://a.test/");
  wc.currentUrl = "http://a.test/"; wc.loading = false; wc.emit("did-stop-loading");
  const b = invoke({ id: "b1", type: "navigate", url: "http://b.test/" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(wc.calls.at(-1), "http://b.test/");
  wc.emit("did-stop-loading");
  let settled = false; void b.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "stale stop must not settle B");
  wc.currentUrl = "http://b.test/"; wc.loading = false; wc.emit("did-stop-loading");
  assert.deepEqual(await b, true);
});

test("navigation rejection, timeout, redirect, concurrent waitLoad, and close are bounded", async () => {
  const ipc: any = { handle: (_name: string, fn: any) => { ipc.handler = fn; } };
  const children: FakeView[] = [];
  const win: any = { id: 8, contentView: { addChildView: (view: FakeView) => children.push(view), removeChildView: () => {} } };
  const source = readFileSync(join(resolve(process.cwd()), "..", "..", "product", "muster-browser-main.js"), "utf8").replace(/^import .*?;\n/m, "");
  vm.runInNewContext(source, { console, Map, Promise, URL, Error, String, setTimeout, clearTimeout, setImmediate, __mbIpcMain: ipc, __mbWebContentsView: FakeView, __mbBrowserWindow: { fromWebContents: () => win } });
  const invoke = (message: any) => ipc.handler({ sender: new FakeContents() }, message);
  await invoke({ id: "b2", type: "open", url: "http://initial.test/" }); await new Promise<void>((resolve) => setImmediate(resolve));
  const wc = children[0]!.webContents; wc.currentUrl = "http://initial.test/"; wc.loading = false; wc.emit("did-stop-loading");
  wc.rejectNext = true; const rejected = await invoke({ id: "b2", type: "navigate", url: "http://reject.test/" }); assert.equal((rejected as any).error, "protocol refused");
  wc.loading = true; const waiting = invoke({ id: "b2", type: "waitLoad", timeout: 20 }); const concurrent = invoke({ id: "b2", type: "waitLoad", timeout: 20 }); assert.equal((await waiting as any).error, "Page load timed out"); assert.equal((await concurrent as any).error, "Page load timed out");
  const redirect = invoke({ id: "b2", type: "navigate", url: "http://redirect.test/" }); await new Promise<void>((resolve) => setImmediate(resolve)); wc.emit("did-navigate", {}, "http://final.test/"); wc.currentUrl = "http://final.test/"; wc.loading = false; wc.emit("did-stop-loading"); assert.equal(await redirect, true);
  wc.loading = true; const closing = invoke({ id: "b2", type: "waitLoad", timeout: 1000 }); await invoke({ id: "b2", type: "close" }); const closed = await closing; assert.equal((closed as any).error, "Browser tab closed"); assert.equal((closed as any).closed, true);
});
