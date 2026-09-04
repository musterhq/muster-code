// Muster browser — main-process half. A child WebContentsView per browser tab,
// attached to the workbench window and positioned by the renderer (bounds in
// DIPs); events are queued and polled over VS Code's IPC bridge ("vscode:" channel).
// Injected into out/main.js by scripts/patch-workbench.py.
import { ipcMain as __mbIpcMain, WebContentsView as __mbWebContentsView, BrowserWindow as __mbBrowserWindow } from "electron";
(() => {
  const views = new Map();
  const trusted = new Set(); // hosts whose certificate the user chose to trust ("Proceed anyway")
  const key = (win, id) => `${win.id}:${id}`;
  // Electron console levels: numeric 0 verbose · 1 info · 2 warning · 3 error (older signature) or strings "debug" | "info" | "warning" | "error".
  // Resolve when the current load settles (finish, stop, or fail other than an abort), or after a timeout.
  const awaitLoad = (wc, timeout = 15000) => new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (done) return; done = true; wc.removeListener("did-finish-load", onOk); wc.removeListener("did-stop-loading", onOk); wc.removeListener("did-fail-load", onFail); resolve(value); };
    const onOk = () => finish(true); const onFail = (_e, code, desc) => finish(code === -3 ? true : { error: desc || ("load failed " + code) });
    wc.on("did-finish-load", onOk); wc.on("did-stop-loading", onOk); wc.on("did-fail-load", onFail);
    setTimeout(() => finish(false), timeout);
  });
  const levelName = (level) => (typeof level === "number" ? ({ 0: "debug", 1: "log", 2: "warn", 3: "error" })[level] || "log" : ({ info: "log", warning: "warn", error: "error", debug: "debug" })[String(level)] || "log");
  __mbIpcMain.handle("vscode:muster-browser", async (event, msg) => {
    const win = __mbBrowserWindow.fromWebContents(event.sender);
    if (!win || !msg || typeof msg.id !== "string") return null;
    const k = key(win, msg.id);
    let entry = views.get(k);
    const ensure = () => {
      if (entry) return entry;
      const view = new __mbWebContentsView({ webPreferences: { partition: "persist:muster-browser", sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundColor: "#ffffff" } });
      entry = { view, events: [], title: "", win };
      views.set(k, entry);
      win.contentView.addChildView(view);
      const wc = view.webContents;
      // Code-OSS guards every webContents it creates with a will-navigate preventDefault (protecting the workbench);
      // a browser must follow links, so drop that guard from our views (now, and again once creation events settle).
      const unguard = () => wc.removeAllListeners("will-navigate");
      unguard(); setImmediate(unguard); wc.once("did-start-loading", unguard);
      wc.on("certificate-error", (event, url, error) => { push({ kind: "cert", url, message: error }); });
      wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => { if (isMainFrame && code !== -3) push({ kind: "console", level: "error", message: `Failed to load ${url}: ${desc} (${code})` }); });
      // Local dev servers without cache headers (python -m http.server, file watchers) must never show a stale page: revalidate localhost loads.
      const ses = wc.session;
      if (!ses.__musterFresh) { ses.__musterFresh = true;
        // Self-signed dev certificates: trust localhost only; everything else keeps Chromium's verdict.
        ses.setCertificateVerifyProc((request, callback) => callback(/^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost)$/.test(request.hostname) || trusted.has(request.hostname) ? 0 : -3)); ses.webRequest.onBeforeSendHeaders({ urls: ["http://localhost/*", "http://127.0.0.1/*", "http://0.0.0.0/*", "http://*.localhost/*", "https://localhost/*", "https://*.localhost/*"] }, (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, "Cache-Control": "max-age=0" } })); }
      const push = (payload) => { entry.events.push(payload); if (entry.events.length > 400) entry.events.shift(); };
      wc.on("page-title-updated", (_e, title) => { entry.title = title; push({ kind: "title", title, url: wc.getURL() }); });
      wc.on("did-navigate", (_e, url) => push({ kind: "navigate", url }));
      wc.on("did-navigate-in-page", (_e, url) => push({ kind: "navigate", url }));
      wc.on("dom-ready", () => push({ kind: "ready", url: wc.getURL() }));
      wc.on("console-message", (e, a, b, c, d) => {
        const details = a !== undefined && typeof a !== "number" && e && e.message !== undefined ? e : null;
        push(details ? { kind: "console", level: levelName(details.level), message: String(details.message), line: details.lineNumber, source: details.sourceId } : { kind: "console", level: levelName(a), message: String(b), line: c, source: d });
      });
      wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url); return { action: "deny" }; });
      return entry;
    };
    switch (msg.type) {
      case "open": { const e = ensure(); if (msg.bounds) e.view.setBounds(msg.bounds); e.view.setVisible(true); if (msg.url) e.view.webContents.loadURL(msg.url); return true; }
      case "bounds": { if (!entry) return false; if (msg.bounds) entry.view.setBounds(msg.bounds); entry.view.setVisible(!!msg.visible); return true; }
      case "navigate": { if (!entry || !msg.url) return false; const wc = entry.view.webContents; const p = awaitLoad(wc); wc.loadURL(msg.url).catch(() => {}); return p; }
      case "reload": { if (!entry) return false; const wc = entry.view.webContents; const p = awaitLoad(wc); wc.reloadIgnoringCache(); return p; }
      case "back": { if (!entry) return false; const wc = entry.view.webContents; if (!wc.navigationHistory.canGoBack()) return true; const p = awaitLoad(wc); wc.navigationHistory.goBack(); return p; }
      case "forward": { if (!entry) return false; const wc = entry.view.webContents; if (!wc.navigationHistory.canGoForward()) return true; const p = awaitLoad(wc); wc.navigationHistory.goForward(); return p; }
      case "waitLoad": { if (!entry) return false; const wc = entry.view.webContents; return wc.isLoading() ? awaitLoad(wc, msg.timeout || 10000) : true; }
      case "events": { if (!entry) return []; const out = entry.events; entry.events = []; return out; }
      case "eval": { if (!entry) return null; try { return await entry.view.webContents.executeJavaScript(String(msg.js), true); } catch (error) { return { error: String((error && error.message) || error) }; } }
      case "capture": { if (!entry) return null; const image = await entry.view.webContents.capturePage(); return image.toDataURL(); }
      case "url": return entry ? { url: entry.view.webContents.getURL(), title: entry.title } : null;
      case "probe": return entry ? { attached: entry.view.webContents.id, url: entry.view.webContents.getURL(), title: entry.title, bounds: entry.view.getBounds() } : null;
      case "focus": { if (entry) entry.view.webContents.focus(); return !!entry; }
      case "devtools": { if (entry) entry.view.webContents.openDevTools({ mode: "detach" }); return !!entry; }
      case "trust": { try { const host = new URL(String(msg.url)).hostname; trusted.add(host); } catch {} return true; }
      // Agent input (browser tools): real mouse/keyboard events into the page, coordinates in the view's own CSS px.
      case "input": { if (!entry || !msg.event) return false; try { entry.view.webContents.focus(); entry.view.webContents.sendInputEvent(msg.event); return true; } catch (error) { return { error: String((error && error.message) || error) }; } }
      case "close": { if (entry) { try { win.contentView.removeChildView(entry.view); } catch {} try { entry.view.webContents.close(); } catch {} views.delete(k); } return true; }
      default: return null;
    }
  });
})();
