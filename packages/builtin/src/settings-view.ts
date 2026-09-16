export function settingsHtml(csp: string): string {
  return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${csp}; script-src 'unsafe-inline' ${csp};">
<style>
  :root { --fg: var(--vscode-editor-foreground); --t2: color-mix(in srgb, var(--fg) 66%, transparent); --t3: color-mix(in srgb, var(--fg) 36%, transparent); --s2: color-mix(in srgb, var(--fg) 12%, transparent); --s3: color-mix(in srgb, var(--fg) 8%, transparent); --b3: color-mix(in srgb, var(--fg) 8%, transparent); --b4: color-mix(in srgb, var(--fg) 6%, transparent); }
  * { box-sizing: border-box; } html, body { margin: 0; height: 100%; }
  body { display: flex; font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--vscode-editor-background); }
  nav { width: 200px; padding: 20px 10px; border-right: 1px solid var(--s3); display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; }
  nav h1 { font-size: 15px; font-weight: 600; margin: 0 8px 12px; }
  nav .item { padding: 6px 10px; border-radius: 6px; cursor: pointer; color: var(--t2); }
  nav .item:hover { background: var(--b4); color: var(--fg); } nav .item.on { background: var(--b3); color: var(--fg); }
  main { flex: 1; overflow: auto; padding: 24px 32px 60px; max-width: 860px; }
  h2 { font-size: 18px; font-weight: 600; margin: 0 0 4px; } .sub { color: var(--t2); margin-bottom: 18px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--s3); }
  .row .l { flex: 1; min-width: 0; } .row .t { font-weight: 500; } .row .d { color: var(--t2); font-size: 12px; margin-top: 2px; white-space: pre-wrap; }
  .pill { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--b3); color: var(--t2); }
  .pill.ok { background: color-mix(in srgb, var(--vscode-charts-green) 20%, transparent); color: var(--vscode-charts-green); }
  button { font: inherit; color: var(--fg); background: var(--b3); border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; } button:hover { background: var(--s2); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  input, select { font: inherit; color: var(--fg); background: var(--vscode-input-background); border: 1px solid var(--s2); border-radius: 6px; padding: 5px 8px; }
  .toggle { width: 34px; height: 18px; border-radius: 999px; background: var(--s2); position: relative; cursor: pointer; }
  .toggle.on { background: var(--vscode-button-background); } .toggle::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .12s; } .toggle.on::after { left: 18px; }
  .bar { height: 6px; border-radius: 3px; background: var(--s3); overflow: hidden; margin-top: 6px; } .bar > i { display: block; height: 100%; background: var(--vscode-charts-green); }
  pre { background: var(--b4); border-radius: 6px; padding: 10px; font-family: var(--vscode-editor-font-family); font-size: 12px; overflow: auto; }
  .empty { color: var(--t3); padding: 12px 0; }
  .fresh { float: right; font-size: 11px; color: var(--t3); margin-top: 4px; } .fresh a { color: var(--t2); }
  .pill.warn { background: color-mix(in srgb, var(--vscode-charts-yellow, #D2943E) 20%, transparent); color: var(--vscode-charts-yellow, #D2943E); }
  .row details { font-size: 12px; color: var(--t2); } .row details code { font-size: 11px; background: var(--b4); padding: 1px 4px; border-radius: 3px; margin: 2px 2px 0 0; display: inline-block; } .row summary { cursor: pointer; }
  .row .l + .toggle, .row .l + button, .row .l + span { flex: 0 0 auto; }
  .form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; } .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--t2); } .form label input, .form label textarea { font: inherit; color: var(--fg); background: var(--vscode-input-background); border: 1px solid var(--s2); border-radius: 6px; padding: 5px 8px; }
  .form label:has(textarea), .form .flags, .form > div { grid-column: 1 / -1; } .form .flags { display: flex; flex-wrap: wrap; gap: 6px 14px; } .form .flag { flex-direction: row; align-items: center; gap: 6px; }
  nav .item { user-select: none; } nav .item:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, .toggle:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .theme-row { display:flex; align-items:center; gap:8px; } .theme-swatches { display:flex; gap:4px; margin-right:4px; } .theme-swatch { width:18px; height:18px; border:1px solid #8888; border-radius:50%; } .theme-row button:disabled { opacity:.7; cursor:default; }
  @media (max-width: 680px) { body { display:block; overflow:auto; } nav { width:auto; flex-direction:row; overflow:auto; padding:8px; border-right:0; border-bottom:1px solid var(--s3); } nav h1 { display:none; } nav .item { white-space:nowrap; } main { padding:18px 16px 40px; } .form { grid-template-columns:1fr; } }
</style></head>
<body>
  <nav><h1>Muster Settings</h1></nav>
  <main id="main"></main>
<script>const vscode = acquireVsCodeApi();</script>
<script>
  const SECTIONS = [["appearance","Appearance"],["general","General"],["models","Models"],["modes","Modes"],["rules","Rules"],["mcp","MCP"],["skills","Skills"],["plugins","Plugins"],["hooks","Hooks"],["docs","Docs"]];
  const nav = document.querySelector("nav"), main = document.getElementById("main");
  let current = "general";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  for (const [id, label] of SECTIONS) { const el = document.createElement("div"); el.className = "item" + (id === current ? " on" : ""); el.textContent = label; el.dataset.id = id; el.setAttribute("role", "tab"); el.setAttribute("tabindex", id === current ? "0" : "-1"); el.setAttribute("aria-selected", String(id === current)); const select = () => { current = id; [...nav.querySelectorAll(".item")].forEach((n) => { const active = n.dataset.id === id; n.classList.toggle("on", active); n.tabIndex = active ? 0 : -1; n.setAttribute("aria-selected", String(active)); }); vscode.postMessage({ type: "section", section: id }); }; el.addEventListener("click", select); el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } else if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); const items = [...nav.querySelectorAll(".item")]; const i = items.indexOf(el); const next = items[(i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length]; next.focus(); next.click(); } }); nav.appendChild(el); }
  const row = (t, d, right) => '<div class="row"><div class="l"><div class="t">' + t + '</div>' + (d ? '<div class="d">' + d + '</div>' : "") + '</div>' + (right || "") + '</div>';
  function render(section, data, age) {
    if (data && data.error) { main.innerHTML = '<h2>' + esc(section) + '</h2><div class="empty">' + esc(data.error) + '</div>'; return; }
    data = data && typeof data === "object" ? data : {};
    data = { ...data, settings: data.settings && typeof data.settings === "object" ? data.settings : {}, themes: Array.isArray(data.themes) ? data.themes : [], models: Array.isArray(data.models) ? data.models : [], rules: Array.isArray(data.rules) ? data.rules : [], servers: Array.isArray(data.servers) ? data.servers : [], skills: Array.isArray(data.skills) ? data.skills : [], plugins: Array.isArray(data.plugins) ? data.plugins : [], hooks: Array.isArray(data.hooks) ? data.hooks : [], builtin: Array.isArray(data.builtin) ? data.builtin : [], custom: Array.isArray(data.custom) ? data.custom : [], docs: Array.isArray(data.docs) ? data.docs : [] };
    let h = "";
    if (age !== undefined) h += '<div class="fresh">' + (age < 60000 ? "updated just now" : "updated " + Math.round(age / 60000) + " min ago") + ' · <a href="#" id="refresh">Refresh</a></div>';
    if (section === "appearance") {
      h += '<h2>Make Muster yours</h2><div class="sub">Themes for the whole workspace. Syntax, terminals, and live diffs keep their semantic colors. Preview a palette, then reset chat styling independently.</div>';
      for (const t of (Array.isArray(data.themes) ? data.themes : [])) h += row('<div class="theme-row"><span>' + esc(t.name) + '</span>' + (data.active === t.name ? '<span class="pill ok">active</span>' : '') + '</div>', esc(t.description), '<div class="theme-row"><span class="theme-swatches">' + (Array.isArray(t.colors) ? t.colors : []).map(c => '<span class="theme-swatch" style="background:' + esc(c) + '" title="' + esc(c) + '"></span>').join('') + '</span><button data-theme="' + esc(t.name) + '" ' + (data.active === t.name ? 'disabled' : '') + '>' + (data.active === t.name ? 'Active' : 'Preview') + '</button></div>');
      h += row('Chat density', 'Keep a roomy conversation or fit more on screen.', '<select data-appearance="ui.density"><option value="comfortable" ' + (data.density === 'comfortable' ? 'selected' : '') + '>Comfortable</option><option value="compact" ' + (data.density === 'compact' ? 'selected' : '') + '>Compact</option></select>');
      h += row('Chat text size', 'Applies to messages and the composer.', '<input data-appearance="ui.fontSize" type="number" min="12" max="18" value="' + esc(data.fontSize) + '" style="width:70px">');
      h += row('Chat accent', 'Optional hex color. Leave empty to follow the selected theme.', '<input data-appearance="ui.accent" placeholder="#9bd7c4" value="' + esc(data.accent) + '" style="width:110px">');
      h += row('Frosted surfaces', 'Use a subtle blur on the Masthead, composer and inspectors. The transcript stays opaque for readability.', '<input data-appearance="ui.glass" type="checkbox" ' + (data.glass !== false ? 'checked' : '') + '>');
      h += row('Icons', 'Muster Icons uses Lucide for native navigation, terminals, and agent actions.', '<button data-appearance-command="workbench.action.selectProductIconTheme">Product icons</button><button data-appearance-command="workbench.action.selectIconTheme">File icons</button>');
      h += row('Advanced customization', 'Use any installed theme, or configure per-theme colors and editor token colors in settings.', '<button data-appearance-command="workbench.action.selectTheme">All themes</button><button data-appearance-command="workbench.action.openSettingsJson">Settings JSON</button>');
      h += '<div style="margin-top:18px"><button id="resetAppearance">Reset chat styling</button></div>';
    } else if (section === "general") {
      const a = data.account, l = data.limits, p = l && l.primary;
      h += '<h2>General</h2><div class="sub">Account, usage and defaults for new agents.</div>';
      h += row("Codex account", a ? esc(a.email) + " · " + esc(a.planType) : "Not signed in (run codex login)", a ? '<span class="pill ok">' + esc(a.type) + '</span>' : "");
      if (p) h += row("Usage", esc(p.usedPercent) + "% of the " + Math.round(p.windowDurationMins / 1440) + "-day window · resets " + new Date(p.resetsAt * 1000).toLocaleString() + '<div class="bar"><i style="width:' + esc(p.usedPercent) + '%"></i></div>');
      h += row("Default model", esc(data.settings.model) + " · effort " + esc(data.settings.effort), '<span class="pill">per thread in the composer</span>');
      h += row("Access", "Permission policy is selected per thread in the Agent composer.", '<span class="pill">Per thread</span>');
      h += row("Muster Tab", "Inline completions from Codex as you pause typing (uses your plan)", '<div class="toggle' + (data.settings.completions ? " on" : "") + '" data-key="completions.enabled" data-value="' + (data.settings.completions ? "false" : "true") + '"></div>');
    } else if (section === "models") {
      h += '<h2>Models</h2><div class="sub">From model/list (Codex) and your Claude Code models. Efforts are each provider’s own.</div>';
      for (const m of data.models) h += row(esc(m.name) + (m.isDefault ? ' <span class="pill">default</span>' : ""), esc(m.description) + "<br>" + (Array.isArray(m.efforts) ? m.efforts : []).map((e) => esc(e.id)).join(" · "), '<span class="pill">' + (m.provider === "claude" ? "Claude Code" : "Codex") + '</span>');
    } else if (section === "rules") {
      h += '<h2>Rules</h2><div class="sub">How the reference IDE attaches them: <b>Always</b> every turn · <b>Auto</b> when a mentioned file matches the globs · <b>Agent</b> offered by description (@rule:name loads it) · <b>Manual</b> only when mentioned. Files: .muster/rules/*.md, .cursor/rules/*.mdc.</div>';
      h += '<div style="margin:0 0 10px"><button class="primary" id="newRule">New rule</button></div>';
      if (data.userRules) h += row("User rules <span class=\\"pill\\">~/.codex/AGENTS.md</span>", esc(data.userRules.preview), '<button data-open="' + esc(data.userRules.path) + '">Open</button>');
      if (data.agentsMd) h += row("AGENTS.md <span class=\\"pill\\">project</span>", esc(data.agentsMd.preview), '<button data-open="' + esc(data.agentsMd.path) + '">Open</button>');
      const KIND = { always: "Always", auto: "Auto", agent: "Agent", manual: "Manual" };
      for (const r of data.rules) h += row(esc(r.name) + ' <span class="pill">' + esc(r.source) + '</span> <span class="pill ' + (r.kind === "always" ? "ok" : "") + '">' + (KIND[r.kind] || "Rule") + (r.kind === "auto" ? ": " + esc((Array.isArray(r.globs) ? r.globs : []).join(", ")) : "") + '</span>', esc(r.description || r.preview), '<div class="toggle' + (r.enabled ? " on" : "") + '" data-rule="' + esc(r.name) + '" title="' + (r.enabled ? "Enabled" : "Disabled") + '"></div><button data-open="' + esc(r.path) + '">Open</button>');
      if (!data.rules.length) h += '<div class="empty">No rules yet.</div>';
    } else if (section === "mcp") {
      h += '<h2>MCP</h2><div class="sub">Servers Codex has loaded for this folder (mcpServerStatus/list). Switching one off here passes <code>mcp_servers.&lt;name&gt;.enabled=false</code> to Muster’s turns only; ~/.codex/config.toml stays yours.</div>';
      h += '<div style="margin:0 0 10px;display:flex;gap:8px"><button id="openConfig">Open ~/.codex/config.toml</button><button id="mcpLogs">Reveal logs</button></div>';
      for (const s of data.servers) {
        const health = !s.enabled ? '<span class="pill">disabled</span>' : s.auth === "notLoggedIn" ? '<span class="pill warn">needs login</span>' : (s.status && /error|fail/i.test(s.status)) ? '<span class="pill warn">' + esc(s.status) + '</span>' : '<span class="pill ok">' + esc(s.status || "connected") + '</span>';
        const toolsList = Array.isArray(s.tools) ? s.tools : []; const tools = toolsList.length ? '<details><summary>' + toolsList.length + ' tool' + (toolsList.length === 1 ? "" : "s") + '</summary>' + toolsList.map((t) => '<code>' + esc(t) + '</code>').join(" ") + '</details>' : '<span class="d">no tools reported</span>';
        h += row(esc(s.name) + (s.version ? ' <span class="pill">v' + esc(s.version) + '</span>' : "") + (s.plugin ? ' <span class="pill">plugin</span>' : ""), tools, health + (s.auth === "notLoggedIn" ? '<button data-login="' + esc(s.name) + '">Login</button>' : "") + '<div class="toggle' + (s.enabled ? " on" : "") + '" data-mcp="' + esc(s.name) + '"></div>');
      }
      if (!data.servers.length) h += '<div class="empty">No MCP servers reported.</div>';
    } else if (section === "skills") {
      h += '<h2>Skills</h2><div class="sub">From skills/list; type / in the composer to use one.</div><div style="margin:0 0 10px"><button id="openSkills">Reveal ~/.codex/skills</button></div>';
      for (const s of data.skills) h += row(esc(s.name), esc(s.description), s.path ? '<button data-open="' + esc(s.path) + '">Open</button>' : "");
      if (!data.skills.length) h += '<div class="empty">No skills reported.</div>';
    } else if (section === "plugins") {
      h += '<h2>Plugins</h2><div class="sub">From plugin/list. Your Codex plugins work as they are; computer use answers its permission prompts in the chat.</div>';
      for (const p of data.plugins) h += row(esc(p.name), esc(p.detail), '<span class="pill ok">enabled</span>');
      if (!data.plugins.length) h += '<div class="empty">No plugins reported.</div>';
    } else if (section === "hooks") {
      h += '<h2>Hooks</h2><div class="sub">hooks/list as Codex reports it: user, project and plugin hooks in the order they run.</div>';
      for (const k of data.hooks) h += row('<span class="pill">' + esc(k.event) + '</span> ' + esc(k.command), (k.matcher ? "matcher " + esc(k.matcher) + " · " : "") + (k.async ? "async · " : "") + (k.timeout ? k.timeout + "s · " : "") + esc(k.source), k.source ? '<button data-open="' + esc(k.source) + '">Open</button>' : "");
      if (!data.hooks.length) h += '<div class="empty">No hooks.</div>' + (data.raw ? '<pre>' + esc(data.raw) + '</pre>' : "");
    } else if (section === "modes") {
      h += '<h2>Modes</h2><div class="sub">Built-in modes and your own. A custom mode carries the same behaviours as the built-ins (read-only, plan, auto-fix, parallel, board, spec, debug), a system prompt, an effort and a placeholder — ⌘. cycles them in the composer.</div>';
      const FLAGS = ["readOnly", "plan", "autoFix", "parallel", "board", "spec", "debug"];
      const flags = (m) => FLAGS.filter((f) => m[f]).map((f) => '<span class="pill">' + f + '</span>').join(" ");
      for (const m of data.builtin) h += row(esc(m.icon) + " " + esc(m.name) + ' <span class="pill">built-in</span>', esc(m.description || "") + (m.effort ? " · effort " + esc(m.effort) : ""), flags(m));
      for (const m of data.custom) h += row(esc(m.icon || "◆") + " " + esc(m.name) + ' <span class="pill ok">custom</span>', esc(m.description || m.placeholder || ""), flags(m) + ' <button data-editmode="' + esc(m.id) + '">Edit</button><button data-deletemode="' + esc(m.id) + '">Delete</button>');
      h += '<h3 style="margin:18px 0 6px;font-size:14px">Add or edit a mode</h3><form id="modeForm" class="form">';
      h += '<label>Id <input name="id" placeholder="review" required pattern="[a-z0-9-]+"></label><label>Name <input name="name" placeholder="Review" required></label><label>Icon <input name="icon" placeholder="◆" style="width:60px"></label>';
      h += '<label>Description <input name="description" placeholder="What this mode is for"></label><label>Placeholder <input name="placeholder" placeholder="Composer placeholder"></label><label>Effort <input name="effort" placeholder="low · medium · high · xhigh · max · ultra"></label>';
      h += '<label>System prompt <textarea name="prompt" rows="4" placeholder="Extra instructions sent with every turn in this mode"></textarea></label>';
      h += '<div class="flags">' + FLAGS.map((f) => '<label class="flag"><input type="checkbox" name="' + f + '"> ' + f + '</label>').join("") + '</div>';
      h += '<div style="margin-top:10px"><button class="primary" type="submit">Save mode</button></div></form>';
    } else if (section === "docs") {
      h += '<h2>Docs</h2><div class="sub">@Docs mentions: fetched once, cached under .muster/docs.</div>';
      h += '<div class="row"><input id="docName" placeholder="Name"><input id="docUrl" placeholder="https://…" style="flex:1"><button class="primary" id="addDoc">Add</button></div>';
      for (const d of data.docs) h += row(esc(d.name), esc(d.url), '<button data-removedoc="' + esc(d.name) + '">Remove</button>');
    }
    main.innerHTML = h;
    const rf = document.getElementById("refresh"); if (rf) rf.addEventListener("click", (e) => { e.preventDefault(); rf.textContent = "Refreshing…"; vscode.postMessage({ type: "refresh", section }); });
    main.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => vscode.postMessage({ type: "open", path: b.dataset.open })));
    main.querySelectorAll("[data-rule]").forEach((t) => { t.setAttribute("role", "switch"); t.setAttribute("tabindex", "0"); const change = () => vscode.postMessage({ type: "toggleRule", name: t.dataset.rule }); t.addEventListener("click", change); t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); change(); } }); });
    main.querySelectorAll("[data-mcp]").forEach((t) => { t.setAttribute("role", "switch"); t.setAttribute("tabindex", "0"); const change = () => vscode.postMessage({ type: "toggleMcp", name: t.dataset.mcp }); t.addEventListener("click", change); t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); change(); } }); });
    main.querySelectorAll("[data-login]").forEach((b) => b.addEventListener("click", () => vscode.postMessage({ type: "mcpLogin", name: b.dataset.login })));
    const ml = document.getElementById("mcpLogs"); if (ml) ml.addEventListener("click", () => vscode.postMessage({ type: "mcpLogs" }));
    main.querySelectorAll("[data-deletemode]").forEach((b) => b.addEventListener("click", () => vscode.postMessage({ type: "deleteMode", name: b.dataset.deletemode })));
    main.querySelectorAll("[data-editmode]").forEach((b) => b.addEventListener("click", () => { const m = (data.custom || []).find((x) => x.id === b.dataset.editmode); const f = document.getElementById("modeForm"); if (!m || !f) return; for (const el of f.elements) { if (!el.name) continue; if (el.type === "checkbox") el.checked = !!m[el.name]; else el.value = m[el.name] || ""; } f.scrollIntoView({ block: "center" }); }));
    const mf = document.getElementById("modeForm"); if (mf) mf.addEventListener("submit", (e) => { e.preventDefault(); const mode = {}; for (const el of mf.elements) { if (!el.name) continue; if (el.type === "checkbox") { if (el.checked) mode[el.name] = true; } else if (el.value.trim()) mode[el.name] = el.value.trim(); } if (mode.id && mode.name) vscode.postMessage({ type: "saveMode", section: "modes", value: mode }); });
    main.querySelectorAll("[data-theme]").forEach(b => b.addEventListener("click", () => vscode.postMessage({type:"theme",name:b.dataset.theme})));
    main.querySelectorAll("[data-appearance-command]").forEach(b => b.addEventListener("click", () => vscode.postMessage({type:"appearanceCommand",name:b.dataset.appearanceCommand})));
    main.querySelectorAll("[data-appearance]").forEach(b => b.addEventListener("change", () => { if (b.dataset.appearance === "ui.accent" && b.value && !/^#[0-9a-f]{6}$/i.test(b.value)) { b.setCustomValidity("Enter six hex digits, for example #9bd7c4"); b.reportValidity(); return; } b.setCustomValidity(""); vscode.postMessage({type:"set",section:"appearance",key:b.dataset.appearance,value:b.type === "checkbox" ? b.checked : b.type === "number" ? Math.max(12,Math.min(18,Number(b.value)||13)) : b.value}); }));
    main.querySelectorAll(".toggle").forEach((t) => { t.setAttribute("role", "switch"); t.setAttribute("tabindex", "0"); t.setAttribute("aria-checked", String(t.classList.contains("on"))); if (!t.dataset.key) return; const change = () => vscode.postMessage({ type: "set", section, key: t.dataset.key, value: t.dataset.value === "true" }); t.addEventListener("click", change); t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); change(); } }); });
    const nr = document.getElementById("newRule"); if (nr) nr.addEventListener("click", () => vscode.postMessage({ type: "newRule" }));
    const oc = document.getElementById("openConfig"); if (oc) oc.addEventListener("click", () => vscode.postMessage({ type: "openConfig" }));
    const os = document.getElementById("openSkills"); if (os) os.addEventListener("click", () => vscode.postMessage({ type: "openSkills" }));
    const ra = document.getElementById("resetAppearance"); if (ra) ra.addEventListener("click", () => vscode.postMessage({ type: "resetAppearance" }));
    const ad = document.getElementById("addDoc"); if (ad) ad.addEventListener("click", () => vscode.postMessage({ type: "addDoc", name: document.getElementById("docName").value.trim(), url: document.getElementById("docUrl").value.trim() }));
    main.querySelectorAll("[data-removedoc]").forEach((b) => b.addEventListener("click", () => vscode.postMessage({ type: "removeDoc", name: b.dataset.removedoc })));
  }
  window.addEventListener("message", (e) => { const m = e.data; if (m.type === "section") { current = m.section; [...nav.querySelectorAll(".item")].forEach((n) => n.classList.toggle("on", n.dataset.id === current)); render(m.section, m.data, m.age); } });
  vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}
