// Muster browser — main-process half. A child WebContentsView per browser tab,
// attached to the workbench window and positioned by the renderer (bounds in
// DIPs); events are queued and polled over VS Code's IPC bridge ("vscode:" channel).
// Injected into out/main.js by scripts/patch-workbench.py.
import { ipcMain as __mbIpcMain, WebContentsView as __mbWebContentsView, BrowserWindow as __mbBrowserWindow } from "electron";
(() => {
  const views = new Map();
  const key = (win, id) => `${win.id}:${id}`;
  // Electron console levels: numeric 0 verbose · 1 info · 2 warning · 3 error (older signature) or strings "debug" | "info" | "warning" | "error".
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
      case "navigate": { if (entry && msg.url) entry.view.webContents.loadURL(msg.url); return !!entry; }
      case "reload": { if (entry) entry.view.webContents.reload(); return !!entry; }
      case "back": { if (entry && entry.view.webContents.navigationHistory.canGoBack()) entry.view.webContents.navigationHistory.goBack(); return !!entry; }
      case "forward": { if (entry && entry.view.webContents.navigationHistory.canGoForward()) entry.view.webContents.navigationHistory.goForward(); return !!entry; }
      case "events": { if (!entry) return []; const out = entry.events; entry.events = []; return out; }
      case "eval": { if (!entry) return null; try { return await entry.view.webContents.executeJavaScript(String(msg.js), true); } catch (error) { return { error: String((error && error.message) || error) }; } }
      case "capture": { if (!entry) return null; const image = await entry.view.webContents.capturePage(); return image.toDataURL(); }
      case "url": return entry ? { url: entry.view.webContents.getURL(), title: entry.title } : null;
      case "probe": return entry ? { attached: entry.view.webContents.id, url: entry.view.webContents.getURL(), title: entry.title, bounds: entry.view.getBounds() } : null;
      case "focus": { if (entry) entry.view.webContents.focus(); return !!entry; }
      case "close": { if (entry) { try { win.contentView.removeChildView(entry.view); } catch {} try { entry.view.webContents.close(); } catch {} views.delete(k); } return true; }
      default: return null;
    }
  });
})();
