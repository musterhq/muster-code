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

  function ghostRows(services, languageId, lines, lineHeight) {
    const frag = document.createDocumentFragment();
    let model;
    try {
      model = services.modelService.createModel(lines.join("\n"), services.languageService.createById(languageId), undefined, true);
      model.tokenization.forceTokenization(lines.length);
      for (let i = 1; i <= lines.length; i++) {
        const row = el("div", "muster-ghost-line");
        row.style.height = row.style.lineHeight = lineHeight;
        const text = lines[i - 1];
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
    actions.append(undo, keep);
    dom.append(nav, actions);
    const id = `muster.review.${Math.random().toString(36).slice(2)}`;
    return { getId: () => id, getDomNode: () => dom, getPosition: () => ({ preference: null }), counter, undo, keep, dom };
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
    }
    st.decorations.set(decorations);

    const wanted = new Map();
    for (const h of st.hunks) if (h.removed && h.removed.length) wanted.set(`${h.start}\n${h.removed.join("\n")}`, h);
    editor.changeViewZones((a) => {
      for (const [key, id] of st.zones) if (!wanted.has(key)) { a.removeZone(id); st.zones.delete(key); }
      for (const [key, h] of wanted) {
        if (st.zones.has(key)) continue;
        const dom = el("div", "muster-ghost");
        applyFont(editor, dom);
        dom.append(ghostRows(services, model.getLanguageId(), h.removed, lineHeight));
        st.zones.set(key, a.addZone({ afterLineNumber: Math.max(0, h.start - 1), heightInLines: h.removed.length, domNode: dom }));
      }
    });

    while (st.hunkWidgets.length > st.hunks.length) { const w = st.hunkWidgets.pop(); if (w) editor.removeOverlayWidget(w); }
    st.hunks.forEach((h, i) => {
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
    hint.innerHTML = '<span class="k">⌘K</span><span class="lbl">Edit Selection</span><span class="k">⏎</span><span class="lbl">Quick Question</span><span class="k">⌥⏎</span><span class="lbl">Close</span><span class="k">Esc</span>';
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

  Registry.registerCommand("muster.inlineDiff.clear", (accessor, args) => {
    for (const editor of editorsFor(accessor.get(ICodeEditorService), args.uri)) clear(editor);
  });
})();
