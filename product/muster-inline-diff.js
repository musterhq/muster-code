// Muster inline diff — the workbench half of live agent edits, modelled on
// Cursor's inline-diff contribution: decorations for added lines, tokenized
// view zones for removed lines, a per-hunk overlay widget ("n of m · Reject ·
// Accept") on the line after each hunk, and a bottom review bar. The built-in
// extension drives it through two commands:
//   muster.inlineDiff.render {uri, hunks:[{start,count,removed[]}], streaming, files}
//   muster.inlineDiff.clear  {uri}
// and receives clicks back as muster.edit.hunk / muster.edit.file / muster.edit.go.
// Placeholders (__X__) are resolved to the bundle's minified names by
// scripts/patch-workbench.py, which injects this file after the module export.
(() => {
  const Registry = __CommandsRegistry__;
  const ICodeEditorService = __ICodeEditorService__;
  const IModelService = __IModelService__;
  const ILanguageService = __ILanguageService__;
  const ICommandService = __ICommandService__;
  const IViewDescriptorService = __IViewDescriptorService__;

  const states = new WeakMap();
  let commands = null;
  const isMac = /Mac/.test(navigator.platform);
  const KEYS = {
    acceptHunk: isMac ? "⌘Y" : "Ctrl+Shift+Y",
    rejectHunk: isMac ? "⌘N" : "Ctrl+N",
    acceptFile: isMac ? "⌘⏎" : "Ctrl+Enter",
    rejectFile: isMac ? "⌘⌫" : "Ctrl+Shift+⌫",
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const run = (id, args) => { if (commands) void commands.executeCommand(id, args); };
  const button = (label, kbd, cls, onClick) => {
    const node = el("button", `muster-btn ${cls}`);
    node.append(el("span", "label", label));
    if (kbd) node.append(el("kbd", null, kbd));
    node.addEventListener("mousedown", (e) => e.preventDefault());
    node.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return node;
  };

  const editorsFor = (codeEditorService, uri) => codeEditorService.listCodeEditors().filter((e) => e.getModel()?.uri.toString() === uri);

  function applyFont(editor, node) {
    const lines = editor.getDomNode()?.querySelector(".view-lines");
    if (!lines) return;
    const style = getComputedStyle(lines);
    node.style.fontFamily = style.fontFamily;
    node.style.fontSize = style.fontSize;
    node.style.fontWeight = style.fontWeight;
    node.style.lineHeight = style.lineHeight;
    node.style.letterSpacing = style.letterSpacing;
    node.style.fontFeatureSettings = style.fontFeatureSettings;
  }

  function ghostRows(services, languageId, lines, lineHeight, innerRemoved) {
    const frag = document.createDocumentFragment();
    let model;
    try {
      model = services.modelService.createModel(lines.join("\n"), services.languageService.createById(languageId), undefined, true);
      model.tokenization.forceTokenization(lines.length);
      for (let i = 1; i <= lines.length; i++) {
        const row = el("div", "muster-ghost-line");
        row.style.height = row.style.lineHeight = lineHeight;
        const text = lines[i - 1];
        for (const box of (innerRemoved || []).filter((r) => r.row === i - 1)) { const b = el("span", "muster-inner-removed"); b.style.left = `calc(${box.start}ch + .5px)`; b.style.width = `${Math.max(1, box.end - box.start)}ch`; row.append(b); }
        const tokens = model.tokenization.getLineTokens(i);
        const count = tokens.getCount();
        for (let t = 0; t < count; t++) row.append(el("span", tokens.getClassName(t), text.slice(tokens.getStartOffset(t), tokens.getEndOffset(t))));
        if (!text) row.append(el("span", "mtk1", " "));
        frag.append(row);
      }
    } catch {
      for (const text of lines) {
        const row = el("div", "muster-ghost-line", text || " ");
        row.style.height = row.style.lineHeight = lineHeight;
        frag.append(row);
      }
    } finally {
      try { model?.dispose(); } catch { /* scratch model */ }
    }
    return frag;
  }

  function makeHunkWidget(editor, st, index) {
    const dom = el("div", "muster-hunk");
    const nav = el("div", "muster-nav");
    const counter = el("span", "muster-nav-counter", "");
    nav.append(counter);
    const reject = button("Reject", KEYS.rejectHunk, "secondary", () => run("muster.edit.hunk", { uri: st.uri, index: widget.index, action: "reject" }));
    const accept = button("Accept", KEYS.acceptHunk, "primary", () => run("muster.edit.hunk", { uri: st.uri, index: widget.index, action: "accept" }));
    dom.append(nav, reject, accept);
    const id = `muster.hunk.${Math.random().toString(36).slice(2)}`;
    const widget = { getId: () => id, getDomNode: () => dom, getPosition: () => ({ preference: null }), index, line: 1, hidden: true, counter, dom };
    return widget;
  }

  function makeBar(editor, st) {
    const dom = el("div", "muster-review");
    const nav = el("div", "muster-nav");
    const up = el("span", "arrow codicon codicon-chevron-up");
    const down = el("span", "arrow codicon codicon-chevron-down");
    const counter = el("span", "muster-nav-counter", "");
    up.addEventListener("click", () => run("muster.edit.go", { uri: st.uri, direction: -1 }));
    down.addEventListener("click", () => run("muster.edit.go", { uri: st.uri, direction: 1 }));
    nav.append(up, counter, down);
    const actions = el("div", "actions");
    const undo = button("Undo All", KEYS.rejectFile, "text", () => run("muster.edit.file", { uri: st.uri, action: "reject" }));
    const keep = button("Keep All", KEYS.acceptFile, "accent", () => run("muster.edit.file", { uri: st.uri, action: "accept" }));
    // Multi-file review (Cursor): "Keep all changes" + "Review next file ⌥L".
    const keepAll = button("Keep all changes", "", "text", () => run("muster.edit.acceptAll", {}));
    const nextFile = button("Review next file", "⌥L", "accent", () => run("muster.edit.nextFile", {}));
    actions.append(undo, keep, keepAll, nextFile);
    dom.append(nav, actions);
    const id = `muster.review.${Math.random().toString(36).slice(2)}`;
    return { getId: () => id, getDomNode: () => dom, getPosition: () => ({ preference: null }), counter, undo, keep, keepAll, nextFile, dom };
  }

  function currentIndex(editor, hunks) {
    const line = editor.getPosition()?.lineNumber ?? 1;
    const inside = hunks.findIndex((h) => (h.count ? line >= h.start && line < h.start + h.count : line === h.start));
    if (inside >= 0) return inside;
    const after = hunks.findIndex((h) => h.start > line);
    return after >= 0 ? after : 0;
  }

  function updateBar(editor, st) {
    if (!st.bar) return;
    const total = st.hunks.length;
    const pending = st.streaming ? 1 : 0;
    const shown = Math.max(0, total - pending);
    st.bar.dom.style.display = shown ? "" : "none";
    if (!shown) return;
    const index = Math.min(currentIndex(editor, st.hunks) + 1, shown);
    st.bar.counter.textContent = `${index} / ${shown}`;
    st.bar.undo.firstChild.textContent = total > 1 ? "Undo All" : "Undo";
    st.bar.keep.firstChild.textContent = total > 1 ? "Keep All" : "Keep";
    const multi = (st.files || 1) > 1;
    st.bar.undo.style.display = multi ? "none" : ""; st.bar.keep.style.display = multi ? "none" : "";
    st.bar.keepAll.style.display = multi ? "" : "none"; st.bar.nextFile.style.display = multi ? "" : "none";
    // Monaco sizes the overlay container by width only: anchor the bar by top.
    const info = editor.getLayoutInfo();
    const height = st.bar.dom.offsetHeight || 34;
    st.bar.dom.style.top = `${Math.max(0, info.height - height - 14)}px`;
    st.bar.dom.style.bottom = "auto";
  }

  function layout(editor, st) {
    const info = editor.getLayoutInfo();
    const scrollTop = editor.getScrollTop();
    const right = info.verticalScrollbarWidth + 24;
    for (const w of st.hunkWidgets) {
      if (!w) continue;
      const top = editor.getTopForLineNumber(w.line) - scrollTop;
      const visible = !w.hidden && top >= -2 && top <= info.height - 10;
      w.dom.style.display = visible ? "" : "none";
      if (!visible) continue;
      w.dom.style.top = `${Math.round(top)}px`;
      w.dom.style.right = `${right}px`;
      // Cursor shrinks the widget to shortcuts when the line's text would run into it.
      const model = editor.getModel();
      let textEnd = 0;
      try { textEnd = info.contentLeft + editor.getOffsetForColumn(w.line, model.getLineMaxColumn(w.line)) - editor.getScrollLeft(); } catch { textEnd = 0; }
      w.dom.classList.remove("compact");
      const room = info.width - right - w.dom.offsetWidth;
      if (textEnd + 32 > room) w.dom.classList.add("compact");
    }
    updateBar(editor, st);
  }

  function ensureState(editor) {
    let st = states.get(editor);
    if (st) return st;
    st = { uri: null, hunks: [], streaming: false, files: 1, zones: new Map(), decorations: editor.createDecorationsCollection(), hunkWidgets: [], bar: null, disposables: [] };
    st.disposables.push(editor.onDidScrollChange(() => layout(editor, st)));
    st.disposables.push(editor.onDidLayoutChange(() => layout(editor, st)));
    st.disposables.push(editor.onDidChangeCursorPosition(() => updateBar(editor, st)));
    st.disposables.push(editor.onDidChangeModel(() => clear(editor)));
    st.disposables.push(editor.onDidDispose(() => clear(editor)));
    states.set(editor, st);
    return st;
  }

  function clear(editor) {
    const st = states.get(editor);
    if (!st) return;
    states.delete(editor);
    try { st.decorations.clear(); } catch { /* model gone */ }
    try { editor.changeViewZones((a) => { for (const z of st.zones.values()) a.removeZone(z); }); } catch { /* editor gone */ }
    for (const w of st.hunkWidgets) if (w) { try { editor.removeOverlayWidget(w); } catch { /* editor gone */ } }
    if (st.bar) { try { editor.removeOverlayWidget(st.bar); } catch { /* editor gone */ } }
    for (const d of st.disposables) d.dispose();
  }

  function render(editor, services, args) {
    const model = editor.getModel();
    if (!model) return;
    const st = ensureState(editor);
    st.uri = args.uri;
    st.hunks = args.hunks || [];
    st.streaming = !!args.streaming;
    st.files = args.files || 1;
    const lineCount = model.getLineCount();
    const lineHeight = getComputedStyle(editor.getDomNode()?.querySelector(".view-lines") || editor.getDomNode()).lineHeight;

    const decorations = [];
    for (const h of st.hunks) {
      if (h.count <= 0) continue;
      const last = Math.min(h.start + h.count - 1, lineCount);
      decorations.push({
        range: { startLineNumber: h.start, startColumn: 1, endLineNumber: last, endColumn: 1 },
        options: { description: "muster-added", isWholeLine: true, className: "muster-added-line", overviewRuler: { color: { id: "editorOverviewRuler.addedForeground" }, position: 7 } },
      });
      decorations.push({ range: { startLineNumber: h.start, startColumn: 1, endLineNumber: h.start, endColumn: 1 }, options: { description: "muster-added-first", isWholeLine: true, className: "muster-added-first" } });
      for (const box of (h.inner && h.inner.added) || []) {
        const line = h.start + box.row;
        if (line > last) continue;
        decorations.push({ range: { startLineNumber: line, startColumn: box.start + 1, endLineNumber: line, endColumn: box.end + 1 }, options: { description: "muster-inner-added", className: "muster-inner-added" } });
      }
    }
    st.decorations.set(decorations);

    const wanted = new Map();
    for (const h of st.hunks) if (h.removed && h.removed.length) wanted.set(`${h.start}\n${h.removed.join("\n")}\n${JSON.stringify((h.inner && h.inner.removed) || [])}`, h);
    editor.changeViewZones((a) => {
      for (const [key, id] of st.zones) if (!wanted.has(key)) { a.removeZone(id); st.zones.delete(key); }
      for (const [key, h] of wanted) {
        if (st.zones.has(key)) continue;
        const dom = el("div", "muster-ghost");
        applyFont(editor, dom);
        dom.append(ghostRows(services, model.getLanguageId(), h.removed, lineHeight, h.inner && h.inner.removed));
        st.zones.set(key, a.addZone({ afterLineNumber: Math.max(0, h.start - 1), heightInLines: h.removed.length, domNode: dom }));
      }
    });

    // Full access (auto-apply): no per-hunk Accept/Reject prompts; the colours stay and the bar offers Keep all / Undo all.
    const wantWidgets = args.widgets !== false;
    while (st.hunkWidgets.length > (wantWidgets ? st.hunks.length : 0)) { const w = st.hunkWidgets.pop(); if (w) editor.removeOverlayWidget(w); }
    if (wantWidgets) st.hunks.forEach((h, i) => {
      let w = st.hunkWidgets[i];
      if (!w) { w = makeHunkWidget(editor, st, i); st.hunkWidgets[i] = w; editor.addOverlayWidget(w); }
      w.index = i;
      w.line = Math.min(h.start + h.count, lineCount);
      w.hidden = st.streaming && i === st.hunks.length - 1;
      w.counter.textContent = `${i + 1} of ${st.hunks.length}`;
    });

    if (!st.bar) { st.bar = makeBar(editor, st); editor.addOverlayWidget(st.bar); }
    layout(editor, st);
  }

  Registry.registerCommand("muster.inlineDiff.render", (accessor, args) => {
    commands = commands || accessor.get(ICommandService);
    const services = { modelService: accessor.get(IModelService), languageService: accessor.get(ILanguageService) };
    for (const editor of editorsFor(accessor.get(ICodeEditorService), args.uri)) render(editor, services, args);
  });
  // ── ⌘K prompt bar (Cursor's aipopup): a view zone above the selection with Edit Selection ⏎ / Quick Question ⌥⏎ ──
  const bars = new Map();
  function hideBar(uri) {
    const bar = bars.get(uri);
    if (!bar) return;
    bars.delete(uri);
    try { bar.editor.changeViewZones((a) => a.removeZone(bar.zoneId)); } catch { /* editor gone */ }
  }
  function showBar(editor, line) {
    const model = editor.getModel();
    if (!model) return;
    const uri = model.uri.toString();
    hideBar(uri);
    const dom = el("div", "muster-cmdk");
    const input = el("textarea", "muster-cmdk-input");
    input.rows = 1;
    input.placeholder = "Edit selection…";
    const hint = el("div", "muster-cmdk-hint");
    for (const [label, key] of [["Edit Selection", "⏎"], ["Quick Question", "⌥⏎"], ["Close", "Esc"]]) { hint.append(el("span", "lbl", label), el("span", "k", key)); }
    const status = el("div", "muster-cmdk-status", "");
    dom.append(input, hint, status);
    const bar = { editor, dom, input, status, zoneId: null };
    editor.changeViewZones((a) => { bar.zoneId = a.addZone({ afterLineNumber: Math.max(0, line - 1), heightInPx: 84, domNode: dom }); });
    const stop = (e) => e.stopPropagation();
    input.addEventListener("keyup", stop);
    input.addEventListener("keypress", stop);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); hideBar(uri); editor.focus(); return; }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const text = input.value.trim();
        if (!text || input.disabled) return;
        input.disabled = true;
        status.textContent = e.altKey ? "Asking…" : "Generating…";
        run("muster.cmdk.submit", { uri, instruction: text, quick: !!e.altKey });
      }
    });
    bars.set(uri, bar);
    setTimeout(() => input.focus(), 0);
  }
  Registry.registerCommand("muster.cmdk.show", (accessor, args) => {
    commands = commands || accessor.get(ICommandService);
    const editors = editorsFor(accessor.get(ICodeEditorService), args.uri);
    const editor = editors.find((e) => e.hasTextFocus()) || editors[0];
    if (editor) showBar(editor, args.line || 1);
  });
  Registry.registerCommand("muster.cmdk.hide", (accessor, args) => hideBar(args.uri));
  Registry.registerCommand("muster.cmdk.status", (accessor, args) => { const bar = bars.get(args.uri); if (bar) bar.status.textContent = args.text || ""; });

  // Cursor: the agent pane's header is its tab strip. Render the pane's tabs into the secondary
  // sidebar's title row, beside the view actions (+, history, …); the composite bar is hidden by
  // workbench.activityBar.autoHide (single container), so the layout stays VS Code's own.
  let agentHeader = { tabs: [], activeId: "" };
  function renderAgentHeader() {
    const title = document.querySelector(".part.auxiliarybar > .composite.title");
    if (!title) return;
    const label = title.querySelector(":scope > .title-label");
    if (label) label.style.display = "none";
    let strip = title.querySelector(":scope > .muster-tabs");
    if (!strip) { strip = el("div", "muster-tabs"); title.insertBefore(strip, title.firstChild); }
    strip.textContent = "";
    for (const tab of agentHeader.tabs) {
      const node = el("div", "muster-tab" + (tab.id === agentHeader.activeId ? " active" : ""));
      node.title = tab.name;
      if (tab.running) node.append(el("span", "dot"));
      if (tab.kind === "browser") node.append(el("span", "glyph", "◎"));
      node.append(el("span", "name", tab.name));
      const close = el("span", "x", "×"); close.title = "Close";
      close.addEventListener("click", (e) => { e.stopPropagation(); run("muster.agent.closeTab", { id: tab.id }); });
      node.append(close);
      node.addEventListener("click", () => run("muster.agent.tab", { id: tab.id }));
      strip.append(node);
    }
  }
  Registry.registerCommand("muster.agentHeader.set", (accessor, args) => { commands = commands || accessor.get(ICommandService); agentHeader = { tabs: args.tabs || [], activeId: args.activeId || "" }; renderAgentHeader(); });
  const headerObserver = new MutationObserver(() => { const title = document.querySelector(".part.auxiliarybar > .composite.title"); if (title && !title.querySelector(":scope > .muster-tabs")) renderAgentHeader(); });
  headerObserver.observe(document.body, { childList: true, subtree: true });

  // Cursor's plan editor toolbar lives in the breadcrumb row: Preview ⌄ · model ⌄ · Build ⌘⏎ ⌄.
  let planToolbar = { visible: false, model: "", count: 0, selected: 0 };
  function mountPlanToolbar() {
    for (const stale of document.querySelectorAll(".plan-breadcrumb-controls")) if (!planToolbar.visible || stale.closest(".editor-group-container:not(.active)")) stale.remove();
    if (!planToolbar.visible) return;
    const crumbs = document.querySelector(".editor-group-container.active .breadcrumbs-control");
    if (!crumbs) return;
    let node = crumbs.querySelector(":scope > .plan-breadcrumb-controls");
    if (!node) {
      node = el("div", "plan-breadcrumb-controls");
      const pill = (label, cmd, cls) => { const b = el("span", "pbc-pill " + (cls || ""), label); b.append(el("span", "pbc-chev", "▼")); b.addEventListener("click", (e) => { e.stopPropagation(); run(cmd, {}); }); return b; };
      node.append(pill("Preview", "muster.plan.previewMenu", "pbc-preview"), el("span", "pbc-sep"), pill("Model", "muster.plan.model", "pbc-model"));
      const split = el("span", "pbc-split");
      const build = el("button", "pbc-build"); build.append(el("span", "lbl", "Build"), el("kbd", null, "⌘⏎")); build.addEventListener("click", (e) => { e.stopPropagation(); run("muster.plan.build", {}); });
      const more = el("span", "pbc-more", "▼"); more.addEventListener("click", (e) => { e.stopPropagation(); run("muster.plan.buildMenu", {}); });
      split.append(build, more); node.append(split);
      crumbs.append(node);
    }
    const modelPill = node.querySelector(".pbc-model"); if (modelPill) modelPill.firstChild.textContent = planToolbar.model || "Model";
    const lbl = node.querySelector(".pbc-build .lbl"); if (lbl) lbl.textContent = planToolbar.selected && planToolbar.selected < planToolbar.count ? `Build ${planToolbar.selected}` : "Build";
  }
  Registry.registerCommand("muster.planToolbar.set", (accessor, args) => { commands = commands || accessor.get(ICommandService); planToolbar = { ...planToolbar, ...args }; mountPlanToolbar(); });
  const crumbObserver = new MutationObserver(() => { if (planToolbar.visible && !document.querySelector(".editor-group-container.active .breadcrumbs-control > .plan-breadcrumb-controls")) mountPlanToolbar(); });
  crumbObserver.observe(document.body, { childList: true, subtree: true });

  // ── Browser (Cursor's browser pane + visual editor): a main-process WebContentsView positioned over a placeholder tab ──
  const browsers = new Map();
  const ipc = () => (globalThis.vscode && globalThis.vscode.ipcRenderer) || null;
  const mb = (msg) => { const i = ipc(); return i ? i.invoke("vscode:muster-browser", msg) : Promise.resolve(null); };
  const PICKER = `(() => { if (window.__musterPickerOn) return; window.__musterPickerOn = true; window.__musterPick = null;
    const box = document.createElement("div"); box.id = "__muster_pick_box"; Object.assign(box.style, { position: "fixed", pointerEvents: "none", zIndex: 2147483647, border: "2px solid #D2943E", background: "rgba(210,148,62,.12)", borderRadius: "3px", transition: "all .05s" }); document.documentElement.appendChild(box);
    const tag = document.createElement("div"); Object.assign(tag.style, { position: "fixed", zIndex: 2147483647, pointerEvents: "none", font: "12px -apple-system, system-ui, sans-serif", background: "#D2943E", color: "#1a1a1a", padding: "2px 6px", borderRadius: "4px" }); document.documentElement.appendChild(tag);
    const sel = (el) => { const parts = []; let n = el; while (n && n.nodeType === 1 && parts.length < 6) { let p = n.tagName.toLowerCase(); if (n.id) { parts.unshift(p + "#" + n.id); break; } const cls = [...n.classList].slice(0, 2).join("."); if (cls) p += "." + cls; const sib = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : []; if (sib.length > 1) p += ":nth-of-type(" + (sib.indexOf(n) + 1) + ")"; parts.unshift(p); n = n.parentElement; } return parts.join(" > "); };
    let cur = null;
    const move = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); if (!el || el === box || el === tag) return; cur = el; const r = el.getBoundingClientRect(); Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" }); tag.textContent = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : "") + " · " + Math.round(r.width) + "×" + Math.round(r.height); tag.style.left = r.left + "px"; tag.style.top = Math.max(0, r.top - 22) + "px"; };
    const source = (el) => { let n = el; while (n && n.nodeType === 1) { const ds = n.getAttribute("data-source") || n.getAttribute("data-inspector-location") || n.getAttribute("data-v-inspector") || n.getAttribute("data-loc"); if (ds) { const m = /^(.*?):(\\d+)(?::(\\d+))?$/.exec(ds); if (m) return { file: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : 0, via: "attribute" }; }
        const fk = Object.keys(n).find((k) => k.startsWith("__reactFiber$")); if (fk) { let f = n[fk]; let hops = 0; while (f && hops < 12) { const src = f._debugSource; if (src && src.fileName) return { file: src.fileName, line: src.lineNumber || 0, col: src.columnNumber || 0, via: "react", component: (f.type && (f.type.displayName || f.type.name)) || "" }; f = f._debugOwner || f.return; hops++; } }
        if (n.__svelte_meta && n.__svelte_meta.loc) { const l = n.__svelte_meta.loc; return { file: l.file, line: l.line + 1, col: l.column || 0, via: "svelte" }; }
        n = n.parentElement; } return null; };
    const click = (e) => { e.preventDefault(); e.stopPropagation(); const el = cur || e.target; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); const styles = {}; for (const k of ["display","position","width","height","margin","padding","color","background-color","font-family","font-size","font-weight","line-height","border","border-radius","gap","flex-direction","justify-content","align-items"]) styles[k] = cs.getPropertyValue(k); window.__musterPick = { selector: sel(el), tag: el.tagName.toLowerCase(), id: el.id || "", classes: [...el.classList], text: (el.innerText || "").slice(0, 300), html: el.outerHTML.slice(0, 2000), rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, styles, source: source(el), url: location.href, title: document.title }; stop(); };
    const key = (e) => { if (e.key === "Escape") { window.__musterPick = { cancelled: true }; stop(); } };
    function stop() { window.__musterPickerOn = false; document.removeEventListener("mousemove", move, true); document.removeEventListener("click", click, true); document.removeEventListener("keydown", key, true); box.remove(); tag.remove(); }
    document.addEventListener("mousemove", move, true); document.addEventListener("click", click, true); document.addEventListener("keydown", key, true); })();`;
  // The host webview (pane, or a browser editor tab) reports the page area relative to itself; add that webview iframe's offset.
  function hostFrame(b) {
    let container = null;
    if (b.host === "editor") {
      const label = [...document.querySelectorAll(".editor-group-container .tab.active .tab-label")].find((n) => (n.getAttribute("aria-label") || n.textContent || "").includes(`Browser ${b.id}`));
      container = label ? label.closest(".editor-group-container")?.querySelector(":scope > .editor-container") : null;
    } else container = document.querySelector(".part.auxiliarybar > .content");
    if (!container) return null;
    const cr = container.getBoundingClientRect();
    let best = null, bestArea = 0;
    for (const f of document.querySelectorAll("iframe.webview")) { const r = f.getBoundingClientRect(); const w = Math.max(0, Math.min(r.right, cr.right) - Math.max(r.left, cr.left)); const h = Math.max(0, Math.min(r.bottom, cr.bottom) - Math.max(r.top, cr.top)); if (w * h > bestArea) { bestArea = w * h; best = r; } }
    return bestArea > 0 ? best : null;
  }
  function layoutBrowsers() {
    for (const b of browsers.values()) {
      const frame = hostFrame(b);
      const on = !!(b.shown && b.rel && frame && b.rel.width > 10 && b.rel.height > 10);
      if (!on) { if (b.visible !== false) { b.visible = false; void mb({ type: "bounds", id: b.id, visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } }); } continue; }
      const bounds = { x: Math.round(frame.left + b.rel.left), y: Math.round(frame.top + b.rel.top), width: Math.max(0, Math.round(b.rel.width)), height: Math.max(0, Math.round(b.rel.height)) };
      const same = b.visible === true && b.bounds && ["x", "y", "width", "height"].every((k) => b.bounds[k] === bounds[k]);
      if (!same) { b.visible = true; b.bounds = bounds; void mb({ type: "bounds", id: b.id, visible: true, bounds }); }
    }
  }
  function makeBrowser(id, url, host) {
    const b = { id, url, host: host || "pane", title: "", shown: false, rel: null, visible: undefined, bounds: null, ready: false, picking: false, pickTimer: null, poll: null };
    browsers.set(id, b);
    b.poll = setInterval(async () => {
      const events = await mb({ type: "events", id }).catch(() => null);
      for (const e of events || []) {
        if (e.kind === "title") b.title = e.title;
        if (e.kind === "navigate" || e.kind === "ready") { b.url = e.url; if (e.kind === "ready") b.ready = true; }
        run("muster.browser.event", { id, ...e });
      }
    }, 400);
    void mb({ type: "open", id, url, bounds: { x: 0, y: 0, width: 0, height: 0 } });
    return b;
  }
  function startPick(b) {
    b.picking = true;
    void mb({ type: "eval", id: b.id, js: PICKER });
    clearInterval(b.pickTimer);
    b.pickTimer = setInterval(async () => {
      const picked = await mb({ type: "eval", id: b.id, js: "(() => { const p = window.__musterPick; window.__musterPick = null; return p; })()" }).catch(() => null);
      if (!picked || picked.error) return;
      clearInterval(b.pickTimer); b.picking = false;
      if (picked.cancelled) { run("muster.browser.picked", { id: b.id, picked: null, image: null }); return; }
      const image = await mb({ type: "capture", id: b.id }).catch(() => null);
      run("muster.browser.picked", { id: b.id, picked, image: typeof image === "string" ? image : null });
    }, 250);
  }
  async function screenshot(b) {
    const image = await mb({ type: "capture", id: b.id }).catch(() => null);
    const info = await mb({ type: "url", id: b.id }).catch(() => null);
    run("muster.browser.picked", { id: b.id, picked: null, image: typeof image === "string" ? image : null, url: info && info.url, title: info && info.title });
  }
  Registry.registerCommand("muster.browser.open", (accessor, args) => { commands = commands || accessor.get(ICommandService); if (browsers.has(args.id)) { void mb({ type: "navigate", id: args.id, url: args.url }); return true; } makeBrowser(args.id, args.url, args.host); return true; });
  Registry.registerCommand("muster.browser.place", (accessor, args) => { const b = browsers.get(args.id); if (!b) return false; b.rel = args.rel; b.shown = !!args.visible; if (args.host) b.host = args.host; layoutBrowsers(); return true; });
  Registry.registerCommand("muster.browser.close", (accessor, args) => { const b = browsers.get(args.id); if (b) { clearInterval(b.pickTimer); clearInterval(b.poll); browsers.delete(args.id); void mb({ type: "close", id: args.id }); } });
  Registry.registerCommand("muster.browser.reload", (accessor, args) => mb({ type: "reload", id: args.id }));
  Registry.registerCommand("muster.browser.back", (accessor, args) => mb({ type: "back", id: args.id }));
  Registry.registerCommand("muster.browser.forward", (accessor, args) => mb({ type: "forward", id: args.id }));
  Registry.registerCommand("muster.browser.navigate", (accessor, args) => mb({ type: "navigate", id: args.id, url: args.url }));
  Registry.registerCommand("muster.browser.focus", (accessor, args) => mb({ type: "focus", id: args.id }));
  Registry.registerCommand("muster.browser.pick", (accessor, args) => { const b = browsers.get(args.id); if (b) startPick(b); });
  Registry.registerCommand("muster.browser.screenshot", (accessor, args) => { const b = browsers.get(args.id); if (b) return screenshot(b); });
  Registry.registerCommand("muster.browser.context", async (accessor, args) => { const b = args && args.id ? browsers.get(args.id) : [...browsers.values()].find((x) => x.shown) || [...browsers.values()][0]; if (!b) return null; const info = await mb({ type: "url", id: b.id }).catch(() => null); return { id: b.id, url: (info && info.url) || b.url, title: (info && info.title) || b.title }; });
  Registry.registerCommand("muster.browser.eval", (accessor, args) => mb({ type: "eval", id: args.id, js: String(args.js) }));
  Registry.registerCommand("muster.browser.capture", (accessor, args) => mb({ type: "capture", id: args.id }));
  Registry.registerCommand("muster.browser.waitLoad", (accessor, args) => mb({ type: "waitLoad", id: args.id, timeout: args.timeout }));
  Registry.registerCommand("muster.browser.input", (accessor, args) => mb({ type: "input", id: args.id, event: args.event }));
  Registry.registerCommand("muster.browser.probe", async (accessor, args) => { const b = browsers.get(args.id); const main = await mb({ type: "probe", id: args.id }).catch((e) => ({ error: String(e) })); return { ipc: !!ipc(), frame: b ? hostFrame(b) : null, renderer: b ? { ready: b.ready, shown: b.shown, rel: b.rel, visible: b.visible, bounds: b.bounds } : null, main }; });
  const browserObserver = new MutationObserver(() => layoutBrowsers());
  browserObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
  window.addEventListener("resize", layoutBrowsers);

  // Dev: the view containers VS Code keeps in the secondary sidebar (why its composite bar shows).
  Registry.registerCommand("muster.viewContainers", (accessor, args) => {
    const vds = accessor.get(IViewDescriptorService);
    const location = args && typeof args.location === "number" ? args.location : 2;
    return vds.getViewContainersByLocation(location).map((c) => { const model = vds.getViewContainerModel(c); return { id: c.id, title: typeof c.title === "string" ? c.title : (c.title && c.title.value) || "", active: model.activeViewDescriptors.length, visible: model.visibleViewDescriptors.length, all: model.allViewDescriptors.length }; });
  });
  // The built-in Chat container stays registered in the secondary sidebar (even with AI features off) and keeps
  // its composite bar showing. Move it to the panel once, so the sidebar holds only the Agent pane and
  // VS Code hides the bar natively (workbench.activityBar.autoHide) with a correct layout.
  Registry.registerCommand("muster.evictBuiltinChat", (accessor) => {
    const vds = accessor.get(IViewDescriptorService);
    const chat = vds.getViewContainerById("workbench.panel.chat");
    if (chat && vds.getViewContainerLocation(chat) === 2) { vds.moveViewContainerToLocation(chat, 1, undefined, "muster"); return true; }
    return false;
  });
  Registry.registerCommand("muster.moveViewContainer", (accessor, args) => {
    const vds = accessor.get(IViewDescriptorService);
    const container = vds.getViewContainerById(args.id);
    if (container) vds.moveViewContainerToLocation(container, args.location, undefined, "muster");
    return !!container;
  });
  // Dev: parse a CSS text the way the browser does and report how many rules survive ({text}).
  Registry.registerCommand("muster.cssParse", (accessor, args) => { const sheet = new CSSStyleSheet(); sheet.replaceSync(args.text); return { rules: sheet.cssRules.length, last: sheet.cssRules.length ? sheet.cssRules[sheet.cssRules.length - 1].cssText.slice(0, 80) : "" }; });
  // Dev: which of our stylesheet rules the browser actually parsed ({needle}).
  Registry.registerCommand("muster.css", (accessor, args) => {
    const out = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) if (rule.cssText && rule.cssText.includes(args.needle)) out.push({ href: (sheet.href || "inline").slice(-60), text: rule.cssText.slice(0, args.limit || 200) });
    }
    return { sheets: document.styleSheets.length, matches: out.slice(0, args.max || 5) };
  });
  // Dev: inspect the workbench DOM from the harness ({selector, limit}).
  Registry.registerCommand("muster.dom", (accessor, args) => {
    const nodes = [...document.querySelectorAll(args.selector)];
    return nodes.slice(0, args.max || 3).map((n) => ({ tag: n.tagName, cls: n.className, display: getComputedStyle(n).display, rect: n.getBoundingClientRect().toJSON(), html: n.outerHTML.slice(0, args.limit || 600) }));
  });
  Registry.registerCommand("muster.inlineDiff.clear", (accessor, args) => {
    for (const editor of editorsFor(accessor.get(ICodeEditorService), args.uri)) clear(editor);
  });
})();
