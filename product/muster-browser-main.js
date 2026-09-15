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
  const historyOf = (wc) => { try { const h = wc.navigationHistory; return { canGoBack: !!h.canGoBack(), canGoForward: !!h.canGoForward() }; } catch { return { canGoBack: false, canGoForward: false }; } };
  const navigate = async (entry, url, requestedNavigation) => {
    const wc = entry.view.webContents;
    if (!/^https?:\/\//i.test(url)) return { error: "Only http and https URLs are supported" };
    const navigation = typeof requestedNavigation === "number" ? Math.max(entry.navigation + 1, requestedNavigation) : entry.navigation + 1;
    entry.navigation = navigation;
    entry.targetUrl = url;
    if (entry.cancelLoad) entry.cancelLoad({ error: "Navigation superseded", superseded: true });
    for (const cancel of entry.waiters || []) cancel({ error: "Navigation superseded", superseded: true });
    const loaded = awaitLoad(entry, navigation, 15000);
    const cancel = entry.cancelLoad;
    // Do not await Electron's loadURL promise: a broken protocol handler can leave it pending
    // forever even though our did-fail/did-stop/timeout watcher has a bounded lifetime.
    Promise.resolve().then(() => wc.loadURL(url)).catch(error => cancel?.({ error: error instanceof Error ? error.message : String(error) }));
    return loaded;
  };
  const awaitLoad = (entry, navigation, timeout = 15000, registerCancel = true) => new Promise(resolve => {
    const wc = entry.view.webContents; let timer; let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); wc.removeListener("did-stop-loading", ok); wc.removeListener("did-fail-load", fail); if (registerCancel && entry.cancelLoad === cancel) entry.cancelLoad = null; if (!registerCancel) entry.waiters?.delete(cancel); resolve(value); };
    const cancel = value => finish(value);
    const ok = () => { if (entry.navigation === navigation && (!entry.targetUrl || wc.getURL() === entry.targetUrl)) finish(true); };
    const fail = (_e, code, description, _url, main) => { if (main && entry.navigation === navigation) finish({ error: description || String(code), ...(code === -3 ? { superseded: true } : {}) }); };
    if (registerCancel) entry.cancelLoad = cancel; else (entry.waiters || (entry.waiters = new Set())).add(cancel);
    wc.on("did-stop-loading", ok); wc.on("did-fail-load", fail); timer = setTimeout(() => finish({ error: "Page load timed out" }), timeout);
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
      entry = { view, events: [], title: "", win, navigation: 0, cancelLoad: null, waiters: new Set(), desiredVisible: false, failed: false, targetUrl: "", debuggerAttached: false, colorScheme: "system" };
      views.set(k, entry);
      win.contentView.addChildView(view);
      const wc = view.webContents;
      // Code-OSS guards every webContents it creates with a will-navigate preventDefault (protecting the workbench);
      // a browser must follow links, so drop that guard from our views (now, and again once creation events settle).
      const unguard = () => wc.removeAllListeners("will-navigate");
      unguard(); setImmediate(unguard); wc.once("did-start-loading", unguard);
      wc.on("certificate-error", (event, url, error) => { push({ kind: "cert", url, message: error, navigation: entry.navigation }); });
      wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => { if (code === -3 || (isMainFrame && entry.targetUrl && url !== entry.targetUrl)) return; if (isMainFrame) { entry.failed = true; entry.view.setVisible(false); } push({ kind: isMainFrame ? "loadError" : "networkError", url, code, mainFrame: !!isMainFrame, message: `Failed to load ${url}: ${desc} (${code})`, navigation: entry.navigation, history: historyOf(wc) }); });
      // Local dev servers without cache headers (python -m http.server, file watchers) must never show a stale page: revalidate localhost loads.
      const ses = wc.session;
      if (!ses.__musterFresh) { ses.__musterFresh = true;
        // Self-signed dev certificates: trust localhost only; everything else keeps Chromium's verdict.
        ses.setCertificateVerifyProc((request, callback) => callback(/^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost)$/.test(request.hostname) || trusted.has(request.hostname) ? 0 : -3)); ses.webRequest.onBeforeSendHeaders({ urls: ["http://localhost/*", "http://127.0.0.1/*", "http://0.0.0.0/*", "http://*.localhost/*", "https://localhost/*", "https://*.localhost/*"] }, (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, "Cache-Control": "max-age=0" } })); }
      const push = (payload) => { entry.events.push(payload); if (entry.events.length > 400) entry.events.shift(); };
      wc.on("did-start-loading", () => { entry.failed = false; entry.view.setVisible(false); push({ kind: "loading", navigation: entry.navigation, history: historyOf(wc) }); });
      wc.on("did-stop-loading", () => { if (entry.desiredVisible && !entry.failed) entry.view.setVisible(true); push({ kind: "loaded", navigation: entry.navigation, history: historyOf(wc) }); });
      wc.on("page-title-updated", (_e, title) => { entry.title = title; push({ kind: "title", title, url: wc.getURL(), navigation: entry.navigation, history: historyOf(wc) }); });
      wc.on("did-navigate", (_e, url) => { entry.targetUrl = url; push({ kind: "navigate", url, navigation: entry.navigation, history: historyOf(wc) }); });
      wc.on("did-navigate-in-page", (_e, url) => { entry.targetUrl = url; push({ kind: "navigate", url, navigation: entry.navigation, history: historyOf(wc) }); });
      wc.on("dom-ready", () => push({ kind: "ready", url: wc.getURL(), navigation: entry.navigation, history: historyOf(wc) }));
      wc.on("console-message", (e, a, b, c, d) => {
        const details = a !== undefined && typeof a !== "number" && e && e.message !== undefined ? e : null;
        push(details ? { kind: "console", level: levelName(details.level), message: String(details.message), line: details.lineNumber, source: details.sourceId, navigation: entry.navigation } : { kind: "console", level: levelName(a), message: String(b), line: c, source: d, navigation: entry.navigation });
      });
      wc.setWindowOpenHandler(({ url }) => { void navigate(entry, url); return { action: "deny" }; });
      return entry;
    };
    switch (msg.type) {
      case "open": { const e = ensure(); if (msg.bounds) e.view.setBounds(msg.bounds); e.view.setVisible(true); if (msg.url) void navigate(e, msg.url, msg.navigation); return true; }
      case "bounds": { if (!entry) return false; if (msg.bounds) entry.view.setBounds(msg.bounds); entry.desiredVisible = !!msg.visible; entry.view.setVisible(entry.desiredVisible && !entry.failed && !entry.view.webContents.isLoading()); return true; }
      case "navigate": { if (!entry || !msg.url) return false; return navigate(entry, msg.url, msg.navigation); }
      case "reload": { if (!entry) return false; const wc = entry.view.webContents; const navigation = ++entry.navigation; entry.targetUrl = wc.getURL(); if (entry.cancelLoad) entry.cancelLoad({ error: "Navigation superseded", superseded: true }); for (const cancel of entry.waiters || []) cancel({ error: "Navigation superseded", superseded: true }); const p = awaitLoad(entry, navigation); wc.reloadIgnoringCache(); return p; }
      case "back": { if (!entry) return false; const wc = entry.view.webContents; if (!wc.navigationHistory.canGoBack()) return true; const navigation = ++entry.navigation; entry.targetUrl = ""; if (entry.cancelLoad) entry.cancelLoad({ error: "Navigation superseded", superseded: true }); for (const cancel of entry.waiters || []) cancel({ error: "Navigation superseded", superseded: true }); const p = awaitLoad(entry, navigation); wc.navigationHistory.goBack(); return p; }
      case "forward": { if (!entry) return false; const wc = entry.view.webContents; if (!wc.navigationHistory.canGoForward()) return true; const navigation = ++entry.navigation; entry.targetUrl = ""; if (entry.cancelLoad) entry.cancelLoad({ error: "Navigation superseded", superseded: true }); for (const cancel of entry.waiters || []) cancel({ error: "Navigation superseded", superseded: true }); const p = awaitLoad(entry, navigation); wc.navigationHistory.goForward(); return p; }
      case "waitLoad": { if (!entry) return false; const wc = entry.view.webContents; return wc.isLoading() ? awaitLoad(entry, entry.navigation, msg.timeout || 10000, false) : true; }
      case "events": { if (!entry) return []; const out = entry.events; entry.events = []; return out; }
      case "eval": { if (!entry) return null; try { return await entry.view.webContents.executeJavaScript(String(msg.js), true); } catch (error) { return { error: String((error && error.message) || error) }; } }
      case "capture": {
        if (!entry) return null;
        const wc = entry.view.webContents;
        if (msg.fullPage) {
          const size = await wc.executeJavaScript(`(() => ({ width: Math.max(document.documentElement.scrollWidth, document.body && document.body.scrollWidth || 0, window.innerWidth), height: Math.max(document.documentElement.scrollHeight, document.body && document.body.scrollHeight || 0, window.innerHeight) }))()`, true).catch(() => null);
          if (size && size.width > 0 && size.height > 0) {
            const image = await wc.capturePage({ x: 0, y: 0, width: Math.round(size.width), height: Math.round(size.height) });
            return image.toDataURL();
          }
        }
        const image = await wc.capturePage();
        return image.toDataURL();
      }
      case "setAppearance": {
        if (!entry) return { error: "Browser tab is not open" };
        const scheme = String(msg.colorScheme || "system");
        const wc = entry.view.webContents;
        const dbg = wc.debugger;
        try {
          if (!dbg.isAttached()) { dbg.attach("1.3"); entry.debuggerAttached = true; }
          const value = scheme === "system" ? "" : scheme;
          await dbg.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
          entry.colorScheme = scheme;
          return { colorScheme: scheme };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "url": return entry ? { url: entry.view.webContents.getURL(), title: entry.title, history: historyOf(entry.view.webContents), navigation: entry.navigation } : null;
      case "probe": return entry ? { attached: entry.view.webContents.id, url: entry.view.webContents.getURL(), title: entry.title, bounds: entry.view.getBounds(), history: historyOf(entry.view.webContents), navigation: entry.navigation } : null;
      case "focus": { if (entry) entry.view.webContents.focus(); return !!entry; }
      case "devtools": { if (entry) entry.view.webContents.openDevTools({ mode: "detach" }); return !!entry; }
      case "trust": { try { const host = new URL(String(msg.url)).hostname; trusted.add(host); } catch {} return true; }
      // Agent input (browser tools): real mouse/keyboard events into the page, coordinates in the view's own CSS px.
      case "input": { if (!entry || !msg.event) return false; try { entry.view.webContents.focus(); entry.view.webContents.sendInputEvent(msg.event); return true; } catch (error) { return { error: String((error && error.message) || error) }; } }
      case "close": { if (entry) { entry.cancelLoad?.({ error: "Browser tab closed", closed: true }); for (const cancel of entry.waiters || []) cancel({ error: "Browser tab closed", closed: true }); if (entry.debuggerAttached) { try { entry.view.webContents.debugger.detach(); } catch {} entry.debuggerAttached = false; } try { win.contentView.removeChildView(entry.view); } catch {} try { entry.view.webContents.close(); } catch {} views.delete(k); } return true; }
      default: return null;
    }
  });
})();
