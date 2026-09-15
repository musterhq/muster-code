/** Muster's conversation surface. Intentionally independent of the host for DOM regression tests. */
export const polishStyles = String.raw`
:root { --m-body-size:14px; --m-accent: var(--vscode-textLink-foreground, #81A1C1); --text-tertiary: color-mix(in srgb, var(--fg) 37%, transparent); }
#chat { position: relative; align-items: stretch; }
#chat #messages { align-self: center; }
.masthead,#composer,#activity,.menu,.agent-workspace { background-color:var(--vscode-editor-background); }
body[data-glass="on"] .masthead,body[data-glass="on"] #activity,body[data-glass="on"] .menu,body[data-glass="on"] .agent-workspace { background-color:color-mix(in srgb,var(--vscode-editor-background) 92%,transparent 8%); box-shadow:inset 0 1px color-mix(in srgb,#fff 10%,transparent); backdrop-filter:blur(12px) saturate(120%); }
body[data-glass="on"] #composer { background-color:var(--vscode-input-background); backdrop-filter:none; }
@supports not (backdrop-filter:blur(1px)) { body[data-glass="on"] .masthead,body[data-glass="on"] #composer,body[data-glass="on"] #activity,body[data-glass="on"] .menu,body[data-glass="on"] .agent-workspace { background-color:var(--vscode-editor-background); backdrop-filter:none; } }
.masthead { display:none; align-items:center; gap:8px; padding:12px 14px 10px; flex:0 0 auto; border-bottom:1px solid var(--stroke-tertiary); }
.wordmark { font-size:12px; font-weight:650; letter-spacing:3px; color:#E34671; }
.masthead .sub { color:var(--text-tertiary); font-size:11px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.masthead button { border:0; border-radius:6px; padding:4px 8px; font-size:11px; color:var(--text-secondary); background:transparent; transition:background-color var(--motion-fast) var(--ease-out),color var(--motion-fast) var(--ease-out),transform 80ms var(--ease-out); }
.masthead button:hover { background:var(--bg-quaternary); color:var(--fg); }
.masthead button:active { transform:scale(.96); }
.masthead .new-task { color:var(--fg); background:var(--bg-quinary); font-weight:500; }
.masthead .new-task kbd { color:var(--text-tertiary); font:inherit; font-size:10px; margin-left:5px; }
.masthead .more { width:30px; padding:3px 5px; font-size:15px; line-height:14px; }
.masthead-menu { position:absolute; top:42px; right:10px; z-index:22; min-width:190px; padding:4px; border:1px solid var(--stroke-secondary); border-radius:8px; background:var(--vscode-editorWidget-background,var(--vscode-editor-background)); box-shadow:0 0 0 1px var(--stroke-tertiary),0 2px 8px #00000066; }
.masthead-menu[hidden] { display:none; }
.masthead-menu button { display:flex; width:100%; align-items:center; justify-content:flex-start; border:0; border-radius:6px; padding:7px 9px; text-align:left; }
.masthead-menu button:hover,.masthead-menu button:focus-visible { background:var(--bg-tertiary); color:var(--fg); }
.masthead #m-terminal { width:28px; padding-left:4px; padding-right:4px; font-size:14px; line-height:16px; }
#messages { padding:16px 20px 12px; gap:0; scrollbar-gutter:stable; overflow-anchor:none; width:100%; max-width:840px; margin:0 auto; box-sizing:border-box; }
#messages > * { flex-shrink:0; min-width:0; margin-bottom:14px; }
#messages > *:last-child { margin-bottom:0; }
.welcome { padding:clamp(22px,7vh,64px) 22px 18px; flex:1 1 auto; display:flex; flex-direction:column; justify-content:center; gap:4px; max-width:760px; }
.welcome .eyebrow { color:var(--m-accent); letter-spacing:1.8px; font-size:10px; font-weight:600; text-transform:uppercase; }
.welcome h1 { margin:6px 0 4px; color:var(--fg); font-size:clamp(22px,4vw,30px); font-weight:550; line-height:1.2; letter-spacing:-.5px; }
.welcome p { margin:0; color:var(--text-secondary); max-width:520px; font-size:12px; line-height:18px; }
body.has-messages .welcome { display:none; }
.h-empty { padding:26px 12px; color:var(--text-tertiary); font-size:12px; line-height:18px; text-align:center; border:1px dashed var(--stroke-tertiary); border-radius:9px; }
body:not(.has-messages)[data-view="chat"] #composer { order:0; }
#composer { margin:8px 12px 12px; padding:8px 10px 8px; border-radius:12px; background:var(--vscode-input-background); border:1px solid var(--stroke-secondary); box-shadow:0 0 0 1px color-mix(in srgb,var(--fg) 6%,transparent),0 2px 8px #00000040; }
#composer:focus-within { border-color:color-mix(in srgb,var(--fg) 20%,transparent); box-shadow:0 0 0 1px color-mix(in srgb,var(--fg) 10%,transparent),0 8px 24px #00000050; }
#composer #status { display:none; }
body.running #composer #status { display:none; }
#status { padding:0 2px; font-size:12px; }
#composer .bar { flex-wrap:nowrap; gap:4px; }
#composer .pill.access { height:20px; padding:0 6px; font-size:12px; color:var(--text-tertiary); }
#composer .pill.mode { background:var(--bg-secondary); height:20px; padding:0 8px; font-size:12px; }
#composer .pill.mode .mode-kbd { font:inherit; font-size:11px; color:var(--text-tertiary); margin:0 2px; }
#composer .pill.model { height:20px; padding:0 6px; font-size:12px; }
#composer .send,#composer .stopbtn { width:22px; height:22px; }
#composer .ctxrow { display:flex; align-items:center; flex-wrap:wrap; gap:4px; min-height:20px; max-height:132px; overflow:auto; padding-bottom:6px; line-height:16px; }
#composer .ctx { display:inline-flex; align-items:center; gap:4px; max-width:100%; height:20px; min-height:20px; padding:0 4px; border-radius:4px; line-height:16px; }
#composer .ctx.image { height:32px; min-height:32px; padding:2px 6px 2px 2px; }
#composer .ctx.image .ctx-thumb { width:32px; height:32px; object-fit:cover; border-radius:4px; background:var(--bg-tertiary); }
#composer .ctx.image .n { display:none; }
#composer .ctx .ci { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; min-width:16px; line-height:16px; }
#composer .ctx .ci .cod, #composer .ctx .ci .badge { width:14px; height:14px; line-height:14px; }
#composer .ctx .n { min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:18px; }
#composer .ctx .x { display:none; align-items:center; justify-content:center; width:18px; min-width:18px; height:18px; line-height:18px; color:var(--text-secondary); }
#composer .ctx:hover .ci { display:none; }
#composer .ctx:hover .x { display:inline-flex; }
#composer .ctx:focus-visible, #composer .ctx .x:focus-visible { outline:2px solid var(--m-accent); outline-offset:2px; }
.ctx:hover .ci { display:none; }
.ctx:hover .x { display:inline-flex; }
.ctx.retained { border-color:var(--stroke-secondary); background:transparent; }
.context-note { display:none; }
.context-note button { font-size:10px; text-decoration:underline; }
.human { max-height:none; width:fit-content; max-width:min(84%, 640px); margin-left:max(32px, 12%); padding:7px 16px; border-radius:999px; line-height:22px; overflow:visible; white-space:normal; background:var(--vscode-input-background); border:1px solid var(--stroke-secondary); box-shadow:none; }
.human.has-images,.human.clipped,.human.expanded,.human.editing { border-radius:16px; padding:10px 14px; }
.human:hover { background:color-mix(in srgb, var(--vscode-input-background) 82%, var(--fg) 8%); border-color:var(--stroke-primary); }
.human .txt { display:block; white-space:pre-wrap; overflow-wrap:anywhere; }
.human.clipped:not(.expanded) .txt { max-height:132px; overflow:hidden; mask-image:linear-gradient(to bottom,#000 80%,transparent); }
.human .expand-message[hidden] { display:none; }
.human .expand-message { display:block; color:var(--text-secondary); margin-top:6px; font-size:12px; font-weight:500; }
.card.tool, .tool { background:transparent; border:0; box-shadow:none; border-radius:6px; }
.card.tool:hover, .tool:hover { background:var(--bg-quaternary); }
.card.tool .head, .tool .head { min-height:22px; height:22px; padding:0 4px; }
.tool pre { display:none; }
.tool.open pre { display:block; max-height:220px; mask-image:none; background:transparent; border:0; }
.card.tool.command, .tool.command { background:var(--vscode-editor-background)!important; border:1px solid var(--stroke-secondary)!important; border-radius:12px!important; overflow:hidden; }
.tool.command:hover { background:var(--vscode-editor-background)!important; }
.tool.command .head { height:28px!important; min-height:28px!important; padding:0 10px!important; }
.tool.command pre { display:block; max-height:4.6em; padding:4px 10px 8px; mask-image:linear-gradient(to bottom,#000 55%,transparent); }
.tool.command.open pre { max-height:220px; mask-image:none; }
.thinking summary { font-size:13px; color:var(--text-secondary); }
#status { padding:0; font-size:12px; }
.human .tools { position:absolute; right:0; top:calc(100% + 4px); display:none; margin:0; z-index:3; padding:2px; border:1px solid var(--stroke-secondary); border-radius:8px; background:var(--vscode-editor-background); }
.human:hover .tools,.human:focus-within .tools { display:inline-flex; opacity:1; }
.assistant,.human,#input,#backdrop { font-size:var(--m-body-size); }
body[data-density="compact"] #messages { gap:8px;padding:10px; }
body[data-density="compact"] .human { padding:8px 10px; }
body[data-density="compact"] .masthead { padding-top:8px;padding-bottom:8px; }
.assistant { overflow-wrap:anywhere; line-height:1.65; display:flex; flex-direction:column; align-items:flex-start; width:100%; }
.assistant .assistant-body { width:100%; min-width:0; }
.assistant .msg-acts { margin-top:4px; margin-bottom:2px; }
.assistant pre { overflow-x:auto; white-space:pre; }
.assistant table { display:block; max-width:100%; overflow-x:auto; }
.card.tool .cmd { overflow-wrap:anywhere; }
.thinking { border-left:0; padding:0; color:var(--text-secondary); }
.thinking summary { font-size:12px; }
.thinking .reveal { display:grid; grid-template-rows:0fr; transition:grid-template-rows var(--motion-ui) var(--ease-out); }
.thinking[open] .reveal, .thinking.streaming .reveal { grid-template-rows:1fr; }
.thinking .body { min-height:0; overflow:hidden; white-space:pre-wrap; overflow-wrap:anywhere; font-style:italic; }
.thinking[open]:not(.streaming) .ticker { max-height:240px; overflow:auto; }
.thinking.streaming .ticker { max-height:6.75em; display:flex; flex-direction:column; justify-content:flex-end; }
#activity { display:none; margin:0 14px; border:1px solid var(--stroke-tertiary); border-radius:9px; background:var(--bg-quinary); flex:0 1 auto; min-height:0; max-height:clamp(132px,35vh,360px); overflow:auto; }
#activity summary { display:flex; align-items:center; gap:8px; cursor:pointer; list-style:none; padding:8px 10px; font-size:11px; position:sticky; top:0; z-index:1; background:var(--bg-quinary); }
#activity-label:empty { display:none; }
#activity summary::after { content:'Details'; color:var(--text-tertiary); margin-left:auto; font-size:10px; }
#activity[open] summary::after { content:'Less'; }
#activity .live-dot { width:6px;height:6px;border-radius:50%;background:var(--text-tertiary);flex:none; }
body.running #activity .live-dot { background:var(--m-accent);animation:m-pulse 1.7s ease-in-out infinite; }
#activity .elapsed { color:var(--text-tertiary); font-variant-numeric:tabular-nums; }
.activity-state { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--stroke-secondary); border-radius:999px; padding:1px 7px; color:var(--text-secondary); font-size:10px; }
body[data-run-state="running"] .activity-state, body[data-run-state="preparing"] .activity-state { color:var(--m-accent); border-color:color-mix(in srgb,var(--m-accent) 36%,transparent); }
body[data-run-state="waiting"] .activity-state { color:var(--vscode-charts-yellow,#d2943e); }
body[data-run-state="disconnected"] .activity-state, body[data-run-state="interrupted"] .activity-state, body[data-run-state="failed"] .activity-state { color:var(--vscode-errorForeground); }
.activity-timeline { display:flex; flex-direction:column; gap:5px; max-height:150px; overflow:auto; border-top:1px solid var(--stroke-tertiary); padding-top:8px; }
.activity-event { display:grid; grid-template-columns:auto 1fr auto; gap:7px; align-items:baseline; min-width:0; color:var(--text-secondary); font-size:10px; line-height:15px; }
.activity-event .dot { width:5px; height:5px; margin-top:5px; border-radius:50%; background:var(--text-tertiary); }
.activity-event[data-kind="error"] .dot { background:var(--vscode-errorForeground); } .activity-event[data-kind="complete"] .dot { background:var(--vscode-charts-green); }
.activity-event .label { min-width:0; overflow-wrap:anywhere; } .activity-event .time { color:var(--text-tertiary); font-variant-numeric:tabular-nums; white-space:nowrap; }
.context-inspector { display:none; border-top:1px solid var(--stroke-tertiary); padding-top:8px; }
.context-inspector.has { display:block; } .context-inspector summary { cursor:pointer; color:var(--text-secondary); font-size:10px; }
.context-ref { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; padding:5px 0 0; font-size:10px; }
.context-ref .source { min-width:0; overflow-wrap:anywhere; color:var(--fg); } .context-ref .detail { color:var(--text-tertiary); text-align:right; white-space:nowrap; }
.masthead #m-agents { width:28px; padding-left:4px; padding-right:4px; font-size:14px; line-height:16px; }
.agent-workspace { position:absolute; inset:0; z-index:8; display:none; flex-direction:column; background:var(--vscode-editor-background); }
body.agent-workspace-open .agent-workspace { display:flex; }
.aw-head { display:flex; align-items:center; gap:8px; min-height:44px; padding:8px 14px; border-bottom:1px solid var(--stroke-tertiary); }
.aw-head h2 { margin:0; font-size:13px; font-weight:550; } .aw-head .count { color:var(--text-tertiary); font-size:10px; }
.aw-head .close { margin-left:auto; width:26px; height:26px; border-radius:6px; color:var(--text-secondary); } .aw-head .close:hover { background:var(--bg-tertiary); color:var(--fg); }
.task-workspace { position:absolute; inset:0; z-index:9; display:none; flex-direction:column; background:var(--vscode-editor-background); }
body.task-workspace-open .task-workspace { display:flex; }
.tw-head { display:flex; align-items:center; gap:8px; min-height:44px; padding:8px 14px; border-bottom:1px solid var(--stroke-tertiary); }
.tw-head h2 { margin:0; font-size:13px; font-weight:550; } .tw-head .count { color:var(--text-tertiary); font-size:10px; } .tw-feedback { color:var(--text-tertiary); font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .tw-feedback.error { color:var(--vscode-errorForeground); }
.tw-head button { border:1px solid var(--stroke-secondary); border-radius:6px; padding:3px 8px; color:var(--text-secondary); font-size:10px; } .tw-head button.on,.tw-head button:hover { background:var(--bg-tertiary); color:var(--fg); }
.tw-head .close { margin-left:auto; width:26px; height:26px; padding:0; border:0; font-size:16px; }
.tw-body { display:grid; grid-template-columns:minmax(0,1fr) minmax(240px,36%); min-height:0; flex:1; }
.tw-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); align-content:start; gap:8px; overflow:auto; min-width:0; padding:12px; }
.task-workspace[data-layout="split"] .tw-grid { grid-template-columns:1fr; align-content:start; }
.tw-card { display:flex; flex-direction:column; gap:5px; min-width:0; min-height:86px; padding:9px 10px; border:1px solid var(--stroke-tertiary); border-radius:9px; background:var(--bg-quinary); color:var(--text-secondary); text-align:left; }
.tw-card:hover,.tw-card.selected { border-color:var(--stroke-secondary); background:var(--bg-tertiary); color:var(--fg); }
.tw-card .title { display:flex; align-items:center; gap:6px; min-width:0; font-size:11px; font-weight:550; } .tw-card .title .name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tw-card .status { margin-left:auto; color:var(--text-tertiary); font-size:10px; font-weight:400; } .tw-card[data-status="running"] .status { color:var(--m-accent); } .tw-card[data-status="failed"] .status { color:var(--vscode-errorForeground); }
.tw-card .meta { color:var(--text-tertiary); font-size:10px; line-height:15px; overflow-wrap:anywhere; } .tw-card .meta b { color:var(--text-secondary); font-weight:500; }
.tw-focus { min-width:0; overflow:auto; padding:14px; border-left:1px solid var(--stroke-tertiary); }
.tw-focus h3 { margin:0 0 4px; font-size:16px; font-weight:550; overflow-wrap:anywhere; } .tw-focus .identity { display:flex; flex-wrap:wrap; gap:5px 10px; margin-bottom:12px; color:var(--text-tertiary); font-size:10px; }
.tw-focus .identity b { color:var(--text-secondary); font-weight:500; } .tw-focus h4 { margin:14px 0 7px; color:var(--text-tertiary); font-size:10px; letter-spacing:.8px; text-transform:uppercase; }
.tw-preview { max-height:132px; overflow:auto; padding:8px; border:1px solid var(--stroke-tertiary); border-radius:7px; color:var(--text-secondary); font-size:10px; line-height:15px; white-space:pre-wrap; overflow-wrap:anywhere; }
.tw-change { display:flex; align-items:center; gap:6px; min-width:0; padding:4px 0; border-bottom:1px solid var(--stroke-tertiary); font-size:10px; } .tw-change .path { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--vscode-editor-font-family); }
.tw-change button { flex:0 0 auto; padding:2px 5px; color:var(--text-secondary); font-size:10px; } .tw-change button:hover { color:var(--fg); background:var(--bg-tertiary); border-radius:4px; }
.tw-note { color:var(--text-tertiary); font-size:10px; line-height:15px; }
@media(max-width:620px) { .tw-body { grid-template-columns:1fr; grid-template-rows:minmax(170px,42%) minmax(0,1fr); } .tw-focus { border-left:0; border-top:1px solid var(--stroke-tertiary); } .tw-grid { grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); } }
.aw-head #aw-manage { border:1px solid var(--stroke-secondary); border-radius:6px; padding:3px 8px; color:var(--text-secondary); font-size:10px; } .aw-head #aw-manage:hover { color:var(--fg); background:var(--bg-tertiary); }
.aw-feedback { margin:0 14px 8px; padding:6px 8px; border:1px solid var(--stroke-secondary); border-radius:6px; color:var(--text-secondary); font-size:10px; } .aw-feedback.error { color:var(--vscode-errorForeground); }
.aw-layout { display:grid; grid-template-columns:minmax(150px,34%) minmax(0,1fr); min-height:0; flex:1; }
.aw-tree { min-width:0; overflow:auto; padding:8px 6px; border-right:1px solid var(--stroke-tertiary); }
.aw-tree-empty { padding:18px 10px; color:var(--text-tertiary); font-size:11px; line-height:17px; }
.aw-node { display:flex; align-items:center; gap:6px; width:100%; min-height:30px; padding:4px 7px; border-radius:6px; color:var(--text-secondary); text-align:left; font-size:11px; }
.aw-node:hover { background:var(--bg-quaternary); color:var(--fg); } .aw-node.selected { background:var(--bg-tertiary); color:var(--fg); }
.aw-node .rail { color:var(--text-tertiary); font-size:10px; } .aw-node .name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .aw-node .status { margin-left:auto; color:var(--text-tertiary); font-size:10px; white-space:nowrap; } .aw-node[data-status="running"] .status { color:var(--m-accent); } .aw-node[data-status="failed"] .status { color:var(--vscode-errorForeground); }
.aw-detail { min-width:0; overflow:auto; padding:14px; } .aw-empty { color:var(--text-tertiary); font-size:11px; line-height:17px; }
.aw-title { display:flex; align-items:baseline; gap:8px; min-width:0; } .aw-title h3 { margin:0; font-size:16px; font-weight:550; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .aw-title .status { color:var(--m-accent); font-size:10px; }
.aw-meta { display:flex; flex-wrap:wrap; gap:5px 10px; margin:6px 0 12px; color:var(--text-tertiary); font-size:10px; } .aw-meta span { overflow-wrap:anywhere; }
.aw-actions { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; } .aw-actions button { border:1px solid var(--stroke-secondary); border-radius:6px; padding:4px 9px; color:var(--text-secondary); font-size:10px; } .aw-actions button:hover { color:var(--fg); background:var(--bg-tertiary); } .aw-actions button.danger { color:var(--vscode-errorForeground); }
.aw-section { margin-top:14px; } .aw-section h4 { margin:0 0 6px; font-size:10px; color:var(--text-tertiary); font-weight:550; text-transform:uppercase; letter-spacing:.5px; }
.aw-timeline { display:flex; flex-direction:column; gap:5px; } .aw-message { display:grid; grid-template-columns:auto minmax(0,1fr); gap:7px; padding:5px 7px; border:1px solid var(--stroke-tertiary); border-radius:6px; font-size:10px; line-height:15px; } .aw-message .from { color:var(--m-accent); white-space:nowrap; } .aw-message .text { min-width:0; overflow-wrap:anywhere; }
.aw-changes { display:flex; flex-direction:column; gap:4px; } .aw-change { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:7px; font-size:10px; } .aw-change .path { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--vscode-editor-font-family); } .aw-change .adds { color:var(--vscode-charts-green); } .aw-change .dels { color:var(--vscode-charts-red); }
.aw-receipts { display:flex; flex-direction:column; gap:5px; } .aw-receipt { border:1px solid var(--stroke-tertiary); border-radius:6px; overflow:hidden; } .aw-receipt summary { cursor:pointer; padding:6px 8px; color:var(--text-secondary); font-size:10px; } .aw-receipt summary:hover { color:var(--fg); background:var(--bg-quaternary); } .aw-receipt .receipt-meta { color:var(--text-tertiary); margin-left:6px; } .aw-receipt pre { margin:0; max-height:260px; overflow:auto; padding:7px 8px; border-top:1px solid var(--stroke-tertiary); background:var(--vscode-textCodeBlock-background); color:var(--text-secondary); font:10px/15px var(--vscode-editor-font-family); white-space:pre-wrap; overflow-wrap:anywhere; } .aw-receipt .receipt-note { padding:7px 8px; border-top:1px solid var(--stroke-tertiary); color:var(--text-tertiary); font-size:10px; line-height:15px; } .aw-receipt .receipt-open { margin:0 8px 8px; border:1px solid var(--stroke-secondary); border-radius:5px; padding:3px 7px; color:var(--text-secondary); font-size:10px; } .aw-receipt .receipt-open:hover { background:var(--bg-tertiary); color:var(--fg); }
.aw-usage { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; } .aw-usage span { display:block; color:var(--text-tertiary); font-size:9px; } .aw-usage b { display:block; margin-top:2px; font-size:10px; font-weight:500; font-variant-numeric:tabular-nums; }
@media(max-width:420px) { .aw-layout { grid-template-columns:1fr; grid-template-rows:minmax(130px,35%) minmax(0,1fr); } .aw-tree { border-right:0; border-bottom:1px solid var(--stroke-tertiary); } .aw-detail { padding:10px; } .aw-usage { grid-template-columns:repeat(2,minmax(0,1fr)); } }
.usage-ledger { display:none; border-top:1px solid var(--stroke-tertiary); padding-top:8px; }
.usage-ledger.has { display:block; } .usage-ledger summary { cursor:pointer; color:var(--text-secondary); font-size:10px; }
.usage-ledger table { width:100%; margin-top:5px; border-collapse:collapse; font-size:10px; } .usage-ledger th,.usage-ledger td { padding:3px 2px; border-bottom:1px solid var(--stroke-tertiary); text-align:right; font-variant-numeric:tabular-nums; } .usage-ledger th:first-child,.usage-ledger td:first-child { text-align:left; } .usage-ledger th { color:var(--text-tertiary); font-weight:500; }
.activity-body { display:flex; flex-direction:column; gap:10px; border-top:1px solid var(--stroke-tertiary); padding:0 10px 10px; font-size:11px; min-height:0; }
#activity:not(.has-details) .activity-body { display:none; }
body[data-run-state="ready"] #activity { display:none; }
.activity-usage { display:none; border-bottom:1px solid var(--stroke-tertiary); }
.activity-usage.has { display:block; }
.activity-usage summary { cursor:pointer; color:var(--text-secondary); font-size:10px; padding:8px 0; }
.activity-metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; padding:0 0 8px; }
.activity-metrics .metric { display:flex; flex-direction:column; gap:2px; min-width:0; }
.activity-metrics .metric span { color:var(--text-tertiary);font-size:10px; }
.activity-metrics b { font-weight:500;overflow-wrap:anywhere;font-variant-numeric:tabular-nums; }
.activity-usage p { margin:0 0 8px; color:var(--text-tertiary); font-size:10px; line-height:15px; }
@media(max-width:520px) { .activity-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } }
#jump-latest { align-self:center; margin:0 0 8px; padding:5px 12px; border:1px solid var(--stroke-secondary); border-radius:20px; color:var(--text-secondary); font-size:11px; background:var(--vscode-editor-background); }
#jump-latest[hidden] { display:none; }
#toast { position:fixed; left:50%; bottom:88px; transform:translateX(-50%); z-index:40; max-width:min(420px,calc(100% - 24px)); padding:8px 12px; border-radius:8px; background:var(--vscode-notifications-background, var(--vscode-editorWidget-background)); color:var(--fg); border:1px solid var(--vscode-notifications-border, var(--stroke-secondary)); box-shadow:0 0 0 1px var(--stroke-tertiary),0 2px 8px #00000066; font-size:12px; line-height:18px; }
#toast[hidden] { display:none; }
#review { margin-left:14px; margin-right:14px; border-radius:9px; }
.btn.primary { background:var(--m-accent); color:var(--vscode-editor-background); }
#review .head { flex-wrap:wrap; min-height:36px; height:auto; padding-top:6px; padding-bottom:6px; }
#input,#backdrop { overflow-wrap:anywhere; }
button:focus-visible,[role=button]:focus-visible,summary:focus-visible,.head:focus-visible,.row:focus-visible { outline:2px solid color-mix(in srgb, var(--accent) 70%, transparent);outline-offset:1px; }
.bbar { height:42px;gap:6px; }
#burl { height:30px;border-radius:8px; }
.browser-health { padding:6px 10px;color:var(--text-secondary);font-size:11px;border-bottom:1px solid var(--stroke-tertiary); }
.browser-health.error { color:var(--vscode-errorForeground); }
.bsections { height:clamp(140px,28vh,250px); }
@keyframes m-pulse { 50% { opacity:.35; } }
@media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important;scroll-behavior:auto!important; } :root { --motion-fast:0ms; --motion-ui:0ms; --motion-panel:0ms; --dur-fast:0ms; --dur:0ms; } }
@media(prefers-reduced-motion:reduce) { body[data-glass="on"] .masthead,body[data-glass="on"] #composer,body[data-glass="on"] #activity,body[data-glass="on"] .menu,body[data-glass="on"] .agent-workspace { backdrop-filter:none; } }
@media(prefers-reduced-transparency:reduce), (forced-colors:active) { body[data-glass="on"] .masthead,body[data-glass="on"] #composer,body[data-glass="on"] #activity,body[data-glass="on"] .menu,body[data-glass="on"] .agent-workspace { background-color:var(--vscode-editor-background); box-shadow:none; backdrop-filter:none; } }
body.vscode-high-contrast .masthead,body.vscode-high-contrast #composer,body.vscode-high-contrast #activity,body.vscode-high-contrast .menu,body.vscode-high-contrast .agent-workspace,body.vscode-high-contrast-light .masthead,body.vscode-high-contrast-light #composer,body.vscode-high-contrast-light #activity,body.vscode-high-contrast-light .menu,body.vscode-high-contrast-light .agent-workspace { background-color:var(--vscode-editor-background); box-shadow:none; backdrop-filter:none; }
.btn { height:22px; padding:0 8px; border-radius:6px; font-size:12px; display:inline-flex; align-items:center; gap:4px; transition:background-color var(--motion-fast) var(--ease-out),color var(--motion-fast) var(--ease-out),transform 80ms var(--ease-out); }
.btn:active,.icon:active,.pill:active,.send:active,.stopbtn:active { transform:scale(.96); }
.btn.primary { background:var(--vscode-button-background,#81A1C1); color:var(--vscode-button-foreground,#141414); }
#review .btn.primary { background:var(--bg-secondary); color:var(--fg); }
.card.approval { background:transparent; border:0; box-shadow:none; border-radius:8px; }
.card.approval .head { height:22px; padding:0 4px; border-bottom:0; }
.icon,.pill,.send,.stopbtn,.tab,.tabbtn { transition:background-color var(--motion-fast) var(--ease-out),color var(--motion-fast) var(--ease-out),transform 80ms var(--ease-out); }
.icon:active,.tabbtn:active { transform:scale(.94); }
body.running #input { min-height:44px; }
@media(max-width:420px) { .masthead {padding:12px;} .masthead .sub{display:none;} .wordmark{flex:1;} #messages{padding:12px;gap:12px;} #composer{margin:6px 8px 8px;padding:10px;} #activity{margin:0 8px;} .human{margin-left:4px;} .welcome{padding:22px 14px;} }
`;

// Runs inside the webview's script, after its base controls have been initialized.
export const polishScript = String.raw`
  const savedView = vscode.getState() || {};
  const viewStates = savedView.views || {};
  let viewId = null, retainedContext = [], following = true, renderPending = false, streamedTarget = null;
  let telemetry = {}, saveTimer = null, restoring = false, agentPayload = null, taskPayload = null, selectedAgentId = null, agentReceiptOpen = {}, taskLayout = savedView.taskLayout === "split" ? "split" : "grid", chatDiffExpanded = savedView.chatDiffExpanded !== false, lastDraftKey = "";
  const masthead = document.createElement("div"); masthead.className = "masthead";
  masthead.innerHTML = '<span class="wordmark">MUSTER</span><button class="new-task" id="m-new-task" title="Start a new task">New task <kbd>⌘N</kbd></button><span class="sub">Ready for a focused change</span><button id="m-tasks" title="Task workspace" aria-label="Task workspace">▦</button><button id="m-agents" title="Agent workspace" aria-label="Agent workspace">◎</button><button class="more" id="m-more" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">•••</button><div class="masthead-menu" id="masthead-menu" role="menu" hidden><button id="m-history" role="menuitem">Chat history</button><button id="m-appearance" role="menuitem">Style</button><button id="m-tools" role="menuitem">Tools</button><button id="m-terminal" title="Managed terminals" aria-label="Managed terminals" role="menuitem">Managed terminals</button><button id="m-browser" role="menuitem">Browser</button></div>';
  $("chat").prepend(masthead);
  const toastEl=$("toast"); let toastTimer=null;
  function showToast(text){ if(!toastEl||!text)return; toastEl.textContent=String(text); toastEl.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>{toastEl.hidden=true;},3200); }
  window.showToast=showToast;
  $("m-new-task").onclick = () => vscode.postMessage({type:"newAgent"});
  $("m-appearance").onclick = () => vscode.postMessage({type:"command",id:"muster.appearance.open"});
  $("m-tools").onclick = () => vscode.postMessage({type:"command",id:"muster.agent.plugins"});
  $("m-terminal").onclick = () => vscode.postMessage({type:"command",id:"muster.terminal.workspace"});
  $("m-browser").onclick = () => vscode.postMessage({type:"newBrowser"});
  $("m-history").onclick = () => { $("masthead-menu").hidden=true; $("m-more").setAttribute("aria-expanded","false"); vscode.postMessage({type:"view",view:"history"}); };
  $("m-more").onclick = () => { const menu=$("masthead-menu"); const open=menu.hidden; menu.hidden=!open; $("m-more").setAttribute("aria-expanded",String(open)); };
  const agentWorkspace=document.createElement("section"); agentWorkspace.className="agent-workspace"; agentWorkspace.id="agent-workspace"; agentWorkspace.hidden=true;
  agentWorkspace.innerHTML='<div class="aw-head"><h2>Agent workspace</h2><span class="count" id="aw-count"></span><button id="aw-manage" title="Open thread manager">Threads</button><button class="close" id="aw-close" title="Close agent workspace" aria-label="Close agent workspace">×</button></div><div class="aw-feedback" id="aw-feedback" role="status" hidden></div><div class="aw-layout"><div class="aw-tree" id="aw-tree"><div class="aw-tree-empty">Agent hierarchy appears here when the runtime reports child sessions.</div></div><div class="aw-detail" id="aw-detail"><div class="aw-empty">Select an agent to inspect its status, changes, and usage.</div></div></div>';
  masthead.after(agentWorkspace);
  const taskWorkspace=document.createElement("section"); taskWorkspace.className="task-workspace"; taskWorkspace.id="task-workspace"; taskWorkspace.dataset.layout=taskLayout; taskWorkspace.hidden=true;
  taskWorkspace.innerHTML='<div class="tw-head"><h2>Task workspace</h2><span class="count" id="tw-count"></span><span class="tw-feedback" id="tw-feedback" role="status" hidden></span><button type="button" data-task-layout="grid" class="on">Grid</button><button type="button" data-task-layout="split">Split</button><button type="button" class="close" id="tw-close" title="Close task workspace" aria-label="Close task workspace">×</button></div><div class="tw-body"><div class="tw-grid" id="tw-grid"><div class="tw-note">Task cards appear here when the runtime reports task identities.</div></div><div class="tw-focus" id="tw-focus"><div class="tw-note">Select a task to inspect its status, workspace, changes, and focused chat.</div></div></div>';
  masthead.after(taskWorkspace);
  $("m-agents").onclick=()=>{ const open=!body.classList.contains("agent-workspace-open"); body.classList.toggle("agent-workspace-open",open); agentWorkspace.hidden=!open; if(open) renderAgentWorkspace(agentPayload); };
  $("m-tasks").onclick=()=>{ const open=!body.classList.contains("task-workspace-open"); body.classList.toggle("task-workspace-open",open); taskWorkspace.hidden=!open; if(open) renderTaskWorkspace(taskPayload); };
  $("aw-close").onclick=()=>{body.classList.remove("agent-workspace-open");agentWorkspace.hidden=true;};
  $("tw-close").onclick=()=>{body.classList.remove("task-workspace-open");taskWorkspace.hidden=true;};
  taskWorkspace.querySelectorAll("[data-task-layout]").forEach((button)=>{button.setAttribute("aria-pressed",String(button.dataset.taskLayout===taskLayout));button.classList.toggle("on",button.dataset.taskLayout===taskLayout);button.addEventListener("click",()=>{taskLayout=button.dataset.taskLayout==="split"?"split":"grid";taskWorkspace.dataset.layout=taskLayout;taskWorkspace.querySelectorAll("[data-task-layout]").forEach((item)=>{item.classList.toggle("on",item===button);item.setAttribute("aria-pressed",String(item===button));});renderTaskWorkspace(taskPayload);persistView();});});
  $("aw-manage").onclick=()=>vscode.postMessage({type:"command",id:"muster.thread.catalog"});
  const welcome = document.createElement("div"); welcome.className="welcome";
  welcome.innerHTML='<span class="eyebrow">New task</span><h1>What are we working on?</h1><p>Describe the work below. Add context from the composer when it helps.</p>';
  messages.before(welcome);
  const note=document.createElement("div");note.className="context-note";
  note.innerHTML='<span id="context-hint">Attach files or browser selections with @</span><button id="clear-context" hidden>Clear retained</button>';
  $("ctxrow").before(note);
  $("clear-context").onclick=()=>{retainedContext=[];renderTokens();persistView();};
  const activity=document.createElement("details");activity.id="activity";
  activity.innerHTML='<summary><span class="live-dot"></span><span id="activity-label">Ready when you are</span><span class="activity-state" id="activity-state">Ready</span><span class="elapsed" id="activity-time"></span></summary><div class="activity-body"><details class="activity-usage" id="activity-usage"><summary>Usage details</summary><div class="activity-metrics"><div class="metric"><span>Input · cached input</span><b id="usage-input">Not reported</b></div><div class="metric"><span>Output · reasoning output</span><b id="usage-output">Not reported</b></div><div class="metric"><span>Expanded prompt estimate</span><b id="usage-context">Available after send</b></div></div><p>Provider counts are reported values; prompt size is a text estimate.</p></details><div class="activity-timeline" id="activity-timeline" hidden></div><details class="context-inspector" id="context-inspector"><summary>Included context</summary><div id="context-refs"></div></details><details class="usage-ledger" id="usage-ledger"><summary>Usage by turn</summary><div id="usage-rows"></div></details></div>';
  $("composer").before(activity);
  activity.addEventListener("toggle",()=>{if(!restoring) persistView();});
  $("activity-usage").addEventListener("toggle",()=>{if(!restoring) persistView();}); $("context-inspector").addEventListener("toggle",()=>{if(!restoring) persistView();}); $("usage-ledger").addEventListener("toggle",()=>{if(!restoring) persistView();});
  const jump=document.createElement("button");jump.id="jump-latest";jump.hidden=true;jump.textContent="Jump to latest";
  messages.after(jump);jump.onclick=()=>{following=true;scroll(true);persistView();};
  messages.addEventListener("scroll",()=>{following=messages.scrollHeight-messages.clientHeight-messages.scrollTop<60;jump.hidden=following; scheduleSave();},{passive:true});
  function expansionKey(el) { const siblings=[...messages.querySelectorAll(".human,.thinking,.tool,.editwrap")];return el.id || el.dataset.checkpoint || el.classList[0]+":"+siblings.indexOf(el); }
  function persistView() {
    if(!viewId || restoring) return;
    const expanded={}; messages.querySelectorAll(".human,.thinking,.tool,.editwrap").forEach(el=>{expanded[expansionKey(el)]=el.tagName==="DETAILS"?el.open:el.classList.contains("expanded")||el.classList.contains("open");});
    const value={text:input.value,context:[...retainedContext],images:[...composerImages],expanded,scrollTop:messages.scrollTop,following,activityOpen:activity.open,usageOpen:$("activity-usage").open,contextOpen:$("context-inspector").open,usageLedgerOpen:$("usage-ledger").open,taskLayout,agentSelected:selectedAgentId,agentReceiptOpen:{...agentReceiptOpen},chatDiffExpanded,reviewOpen:$("review").classList.contains("open"),planExpanded,planSelection:[...planSel],telemetry:{...telemetry,events:Array.isArray(telemetry.events)?telemetry.events.slice(-40):telemetry.events,activityEvents:Array.isArray(telemetry.activityEvents)?telemetry.activityEvents.slice(-40):telemetry.activityEvents,usageLedger:Array.isArray(telemetry.usageLedger)?telemetry.usageLedger.slice(-20):telemetry.usageLedger}};
    viewStates[viewId]=value;
    vscode.setState({views:viewStates,taskLayout});
    const draftKey=viewId+"\u0000"+value.text+"\u0000"+JSON.stringify(value.context); if(draftKey!==lastDraftKey){lastDraftKey=draftKey;vscode.postMessage({type:"draft",id:viewId,draft:{text:value.text,context:value.context}});}
  }
  function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(persistView,180);}
  function beforeState(next) {
    if(viewId===next.activeId) { if(state?.view!==next.view)persistView(); return; }
    flushStream();persistView(); viewId=next.activeId;
    const local=viewStates[viewId]; const draft=local || next.draft || {text:"",context:[]};
    input.value=typeof draft.text==="string"?draft.text:"";retainedContext=[...new Set(Array.isArray(draft.context)?draft.context.filter(t=>typeof t==="string"&&/^@[\w./:?=&%#+-]+$/.test(t)&&!t.startsWith("@image:")):[])];
    composerImages=Array.isArray(draft.images)?draft.images.filter(t=>typeof t==="string"&&t.startsWith("@image:")):[];
    following=local?local.following!==false:true;restoring=true;activity.open=!!local?.activityOpen;restoring=false;
    tokenOk.clear();tokenBad.clear();telemetry=local?.telemetry&&typeof local.telemetry==="object"?{...local.telemetry}:{}; if(local&&local.agentSelected!==undefined)selectedAgentId=local.agentSelected; agentReceiptOpen=local?.agentReceiptOpen&&typeof local.agentReceiptOpen==="object"?{...local.agentReceiptOpen}:{}; if(local&&typeof local.chatDiffExpanded==="boolean")chatDiffExpanded=local.chatDiffExpanded; closeSuggest();autosize();
  }
  function restoreView() {
    const value=viewStates[viewId]; if(!value)return;
    restoring=true;
    messages.querySelectorAll(".human,.thinking,.tool,.editwrap").forEach(el=>{const expanded=value.expanded?.[expansionKey(el)];if(expanded===undefined)return;if(el.classList.contains("tool")&&!el.classList.contains("failed"))return;if(el.tagName==="DETAILS")el.open=expanded;else el.classList.toggle(el.classList.contains("human")?"expanded":"open",expanded);const head=el.querySelector(".head,.edit");if(head)head.setAttribute("aria-expanded",String(expanded));const b=el.querySelector(".expand-message");if(b){b.textContent=expanded?"Show less":"Show full message";b.setAttribute("aria-expanded",String(expanded));}});
    $("review").classList.toggle("open",!!value.reviewOpen); if($("activity-usage").classList.contains("has"))$("activity-usage").open=!!value.usageOpen; if($("context-inspector").classList.contains("has"))$("context-inspector").open=!!value.contextOpen; if($("usage-ledger").classList.contains("has"))$("usage-ledger").open=!!value.usageLedgerOpen;
    if(planEl && planCardData) { planExpanded=!!value.planExpanded;planSel=new Set(value.planSelection||[]);planCard(planCardData); }
    following=value.following!==false;
    if(following)scroll(true);else{messages.scrollTop=value.scrollTop||0;jump.hidden=false;}
    restoring=false;
  }
  function flushStream(){if(!streamedTarget)return;renderMarkdownIncremental(streamedTarget);streamedTarget=null;renderPending=false;scroll();}
  function scheduleStream(el){streamedTarget=el;if(renderPending)return;renderPending=true;requestAnimationFrame(flushStream);}
  function runStateLabel(status) { return ({preparing:"Preparing",running:"Running",waiting:"Waiting for approval",disconnected:"Disconnected",interrupted:"Interrupted",failed:"Failed",complete:"Complete",ready:"Ready"})[status] || "Ready"; }
  function paintActivityEvents(events) {
    const root=$("activity-timeline"); if(!root)return;
    const rows=Array.isArray(events)?events.filter(e=>e&&typeof e==="object").slice(-40):[];
    root.hidden=!rows.length; if(!rows.length){root.replaceChildren();return;}
    root.replaceChildren(...rows.map((e)=>{const row=document.createElement("div");row.className="activity-event";row.dataset.kind=String(e.kind||e.type||e.phase||"");const dot=document.createElement("span");dot.className="dot";const label=document.createElement("span");label.className="label";label.textContent=String(e.label||e.summary||e.message||e.activity||e.method||e.type||"Activity");const time=document.createElement("span");time.className="time";const ms=typeof e.timestamp==="number"?e.timestamp:typeof e.ts==="number"?e.ts:typeof e.at==="number"?e.at:0;time.textContent=ms?new Date(ms).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}):"";row.append(dot,label,time);return row;}));
  }
  function paintContextRefs(refs) {
    const inspector=$("context-inspector"), root=$("context-refs"); if(!inspector||!root)return;
    const rows=Array.isArray(refs)?refs.filter(r=>r&&typeof r==="object"):[]; inspector.classList.toggle("has",rows.length>0); inspector.hidden=!rows.length; root.replaceChildren(...rows.map((r)=>{const row=document.createElement("div");row.className="context-ref";const source=document.createElement("span");source.className="source";source.textContent=String(r.label||r.path||r.url||r.source||r.token||"Context");const detail=document.createElement("span");detail.className="detail";const range=r.range||r.includedRange;const start=r.startLine??(range&&typeof range==="object"?range.startLine:undefined);const end=r.endLine??(range&&typeof range==="object"?range.endLine:undefined);const rangeText=typeof range==="string"?range:(start!==undefined?(String(start)+(end!==undefined?"–"+end:"")):"");const lines=typeof r.includedLines==="number"?" · "+r.includedLines+" lines":"";const updated=typeof r.sourceMtimeMs==="number"?" · updated "+new Date(r.sourceMtimeMs).toLocaleDateString([], {month:"short",day:"numeric"}):"";const trunc=r.truncated?" · truncated":"";const tokens=typeof r.tokenEstimate==="number"?" · ~"+r.tokenEstimate+" tokens":"";detail.textContent=rangeText+lines+updated+trunc+tokens;row.append(source,detail);return row;}));
  }
  function paintUsageLedger(ledger) {
    const root=$("usage-ledger"), target=$("usage-rows"); if(!root||!target)return; const rows=Array.isArray(ledger)?ledger.filter(r=>r&&typeof r==="object").slice(-20):[]; root.classList.toggle("has",rows.length>0); if(!rows.length){target.replaceChildren();return;}
    const table=document.createElement("table"); const head=document.createElement("tr"); ["Turn","Input","Cached","Output","Reasoning"].forEach((x,i)=>{const th=document.createElement("th");th.textContent=x;head.appendChild(th);}); table.appendChild(head); const n=v=>typeof v==="number"?v.toLocaleString():"—"; rows.forEach((r,i)=>{const tr=document.createElement("tr"); const label=typeof r.turn==="number"?"#"+r.turn:String(r.label||r.id||"#"+(i+1)); [label,n(r.inputTokens),n(r.cachedInputTokens),n(r.outputTokens),n(r.reasoningOutputTokens)].forEach((x)=>{const td=document.createElement("td");td.textContent=x;tr.appendChild(td);}); table.appendChild(tr);}); target.replaceChildren(table);
  }
  function paintTelemetry(update) {
    const incoming=update&&typeof update==="object"?update:{}; telemetry={...telemetry,...Object.fromEntries(Object.entries(incoming).filter(([,v])=>v!==undefined))};
    const status=telemetry.runState||telemetry.status||telemetry.run?.state||(body.classList.contains("running")?"running":"ready"); const statusLabel=runStateLabel(status); body.dataset.runState=status; $("activity-state").textContent=statusLabel; const activityLabel=typeof telemetry.activity==="string"?telemetry.activity.trim():""; $("activity-label").textContent=activityLabel.toLowerCase()===statusLabel.toLowerCase()?"":(activityLabel||statusLabel);
    const n=v=>typeof v==="number"?v.toLocaleString():"—";
    const u=telemetry.usage||{};
    $("usage-input").textContent=Object.keys(u).length?n(u.inputTokens)+" · "+n(u.cachedInputTokens):"Not reported";
    $("usage-output").textContent=Object.keys(u).length?n(u.outputTokens)+" · "+n(u.reasoningOutputTokens):"Not reported";
    if(telemetry.promptEstimate!==undefined)$("usage-context").textContent="~"+n(telemetry.promptEstimate)+" tokens · text only";
    else if(!telemetry.startedAt)$("usage-context").textContent="Available after send";
    const events=telemetry.events||telemetry.activityEvents||telemetry.activityTimeline||telemetry.timeline; const refs=telemetry.contextRefs||telemetry.contextReferences||telemetry.includedContext; const ledger=telemetry.usageLedger||telemetry.ledger||telemetry.turnUsage;
    paintActivityEvents(events); paintContextRefs(refs); paintUsageLedger(ledger);
    const usageDetails=$("activity-usage"); const hasUsage=Object.keys(u).length>0||telemetry.promptEstimate!==undefined||(Array.isArray(ledger)&&ledger.some(row=>row&&typeof row==="object")); if(usageDetails)usageDetails.classList.toggle("has",hasUsage);
    const hasDetails=hasUsage||(Array.isArray(events)&&events.some(row=>row&&typeof row==="object"))||(Array.isArray(refs)&&refs.some(row=>row&&typeof row==="object")); activity.classList.toggle("has-details",hasDetails);
    paintTime();
  }
  function paintTime(){if(!telemetry.startedAt){$("activity-time").textContent="";return;}if(!body.classList.contains("running"))return;const seconds=Math.max(0,Math.floor((Date.now()-telemetry.startedAt)/1000));$("activity-time").textContent=seconds<60?seconds+"s":Math.floor(seconds/60)+"m "+seconds%60+"s";}
  function setRunState(status, activity) { telemetry={...telemetry,runState:status,...(activity?{activity}: {})}; paintTelemetry(telemetry); }
  function graphNodes(graph) {
    if(!graph||typeof graph!=="object"||graph.version!==1||!Array.isArray(graph.nodes))return [];
    return graph.nodes.filter(n=>n&&typeof n==="object"&&(typeof n.threadId==="string"||typeof n.threadId==="number")&&String(n.threadId).length>0);
  }
  function agentAction(action,node) { const message={type:"agentAction",action,agentId:String(node.threadId),threadId:String(node.threadId)}; const box=$("aw-feedback"); if(box){box.hidden=false;box.classList.remove("error");box.textContent="Requesting "+action+" for "+String(node.taskName||node.threadId)+"…";} vscode.postMessage(message); }
  function agentActionResult(result) { const box=$("aw-feedback"); if(!box||!result||typeof result!=="object")return; box.hidden=false; box.classList.toggle("error",result.ok===false); box.textContent=String(result.message||result.reason||(result.ok===false?"Agent action failed":"Agent action accepted")); }
  function taskRows(snapshot) {
    if(!snapshot||typeof snapshot!=="object"||snapshot.version!==1||!Array.isArray(snapshot.tasks))return [];
    return snapshot.tasks.filter((task)=>task&&typeof task==="object"&&typeof task.taskId==="string"&&typeof task.workspaceId==="string"&&typeof task.cwd==="string"&&typeof task.name==="string"&&["idle","running","waiting","cancelled","completed","failed"].includes(task.status)&&["isolated-worktree","shared-checkout-serialized"].includes(task.capability)).slice(-64);
  }
  function renderTaskWorkspace(snapshot) {
    taskPayload=snapshot; const rows=taskRows(snapshot), grid=$("tw-grid"), focus=$("tw-focus"), count=$("tw-count"); if(!grid||!focus||!count)return; const activeId=snapshot&&typeof snapshot==="object"&&typeof snapshot.activeTaskId==="string"?snapshot.activeTaskId:""; count.textContent=rows.length?rows.length+" task"+(rows.length===1?"":"s"):""; grid.replaceChildren();
    if(!rows.length){const empty=document.createElement("div");empty.className="tw-note";empty.textContent="No task identities reported by the runtime.";grid.appendChild(empty);focus.replaceChildren();const note=document.createElement("div");note.className="tw-note";note.textContent="The registry has not reported task workspace data for this session.";focus.appendChild(note);return;}
    let active=rows.find((task)=>task.taskId===activeId)||rows[0]; rows.forEach((task)=>{const card=document.createElement("button");card.type="button";card.className="tw-card"+(task.taskId===active.taskId?" selected":"");card.dataset.status=String(task.status);const title=document.createElement("span");title.className="title";const name=document.createElement("span");name.className="name";name.textContent=task.name;const status=document.createElement("span");status.className="status";status.textContent=task.status;title.append(name,status);const meta=document.createElement("span");meta.className="meta";meta.textContent=(task.capability==="isolated-worktree"?"Isolated worktree":"Shared checkout · serialized")+" · "+(Array.isArray(task.changes)?task.changes.length+" change"+(task.changes.length===1?"":"s"):"changes unavailable");card.append(title,meta);if(task.workspaceOwner||task.cwd){const owner=document.createElement("span");owner.className="meta";owner.textContent=(task.workspaceOwner?"Owner · "+task.workspaceOwner:"Workspace · "+task.cwd);card.appendChild(owner);}if(typeof task.threadId!=="string"||!task.threadId){card.disabled=true;card.title="Task chat is not addressable until the runtime supplies its thread identity.";}else card.onclick=()=>{vscode.postMessage({type:"activateTab",id:task.threadId});};grid.appendChild(card);});
    focus.replaceChildren(); const heading=document.createElement("h3");heading.textContent=active.name;focus.appendChild(heading);const identity=document.createElement("div");identity.className="identity";for(const item of ["Status · "+active.status,"Capability · "+(active.capability==="isolated-worktree"?"isolated worktree":"shared checkout · serialized"),active.activeTurnId&&"Turn · "+active.activeTurnId,active.workspaceOwner&&"Owner · "+active.workspaceOwner,"Workspace · "+active.workspaceId])if(item){const span=document.createElement("span");span.textContent=String(item);identity.appendChild(span);}focus.appendChild(identity);
    const chatHeading=document.createElement("h4");chatHeading.textContent="Focused chat";focus.appendChild(chatHeading);const preview=document.createElement("div");preview.className="tw-preview";preview.textContent=active.threadId?"Open this task to continue its full transcript. Other task cards remain bounded previews until selected.":"Full transcript unavailable until the runtime supplies a thread identity.";focus.appendChild(preview);if(active.threadId){const open=document.createElement("button");open.className="btn";open.type="button";open.textContent="Open focused chat";open.onclick=()=>{vscode.postMessage({type:"activateTab",id:active.threadId});$("tw-close").click();};focus.appendChild(open);}
    const changesHeading=document.createElement("h4");changesHeading.textContent="Changes · full file diff";focus.appendChild(changesHeading);const changes=Array.isArray(active.changes)?active.changes.slice(0,100):[];if(!changes.length){const note=document.createElement("div");note.className="tw-note";note.textContent="No change receipt reported by the runtime.";focus.appendChild(note);}else changes.forEach((change)=>{if(!change||typeof change.path!=="string")return;const row=document.createElement("div");row.className="tw-change";const path=document.createElement("span");path.className="path";path.textContent=change.path;row.appendChild(path);const diff=document.createElement("button");diff.type="button";diff.textContent="Open diff";diff.title="Open full-file diff";diff.onclick=()=>vscode.postMessage({type:"openPath",path:change.path});const pin=document.createElement("button");pin.type="button";pin.textContent="Pin review";pin.title="Pin review for this task";pin.onclick=()=>vscode.postMessage({type:"openReview"});row.append(diff,pin);focus.appendChild(row);});
  }
  function renderAgentWorkspace(graph) {
    agentPayload=graph; document.querySelectorAll(".aw-receipt[data-receipt]").forEach(el=>{agentReceiptOpen[el.dataset.receipt]=el.open;}); const nodes=graphNodes(graph), tree=$("aw-tree"), detail=$("aw-detail"), count=$("aw-count"); if(!tree||!detail)return;
    count.textContent=nodes.length?nodes.length+" agent"+(nodes.length===1?"":"s"):""; tree.replaceChildren();
    if(!nodes.length){tree.innerHTML='<div class="aw-tree-empty">No agent graph data reported by the runtime.</div>';detail.innerHTML='<div class="aw-empty">The provider has not reported child sessions for this thread.</div>';return;}
    const byParent=new Map(); nodes.forEach(n=>{const key=n.parentThreadId?String(n.parentThreadId):"";const list=byParent.get(key)||[];list.push(n);byParent.set(key,list);}); const roots=byParent.get("")||[]; const seen=new Set();
    const addNode=(node,depth)=>{if(!node||seen.has(node.threadId))return;seen.add(node.threadId);const button=document.createElement("button");button.type="button";button.className="aw-node";button.style.paddingLeft=(7+Math.min(8,depth)*14)+"px";button.dataset.agent=String(node.threadId);button.dataset.status=String(node.status||"");const rail=document.createElement("span");rail.className="rail";rail.textContent=depth?"↳":"●";const name=document.createElement("span");name.className="name";name.textContent=String(node.taskName||node.role||node.threadId);const status=document.createElement("span");status.className="status";status.textContent=String(node.status||"unknown");button.append(rail,name,status);button.addEventListener("click",()=>{selectedAgentId=node.threadId;renderAgentWorkspace(agentPayload);});tree.appendChild(button);for(const child of (byParent.get(String(node.threadId))||[]))addNode(child,depth+1);};
    for(const node of roots)addNode(node,0); for(const node of nodes)if(!seen.has(node.threadId))addNode(node,0);
    const selected=nodes.find(n=>String(n.threadId)===String(selectedAgentId))||nodes.find(n=>String(n.threadId)===String(graph.rootThreadId))||nodes[0]; selectedAgentId=selected.threadId; tree.querySelectorAll(".aw-node").forEach(el=>el.classList.toggle("selected",el.dataset.agent===String(selected.threadId))); detail.replaceChildren();
    const title=document.createElement("div");title.className="aw-title";const heading=document.createElement("h3");heading.textContent=String(selected.taskName||selected.role||selected.threadId);const stateLabel=document.createElement("span");stateLabel.className="status";stateLabel.textContent=String(selected.status||"unknown");title.append(heading,stateLabel);detail.appendChild(title);
    const meta=document.createElement("div");meta.className="aw-meta";for(const value of [selected.role&&("Role · "+selected.role),selected.turnId&&("Turn · "+selected.turnId),selected.updatedAt&&("Updated · "+new Date(selected.updatedAt).toLocaleTimeString())])if(value){const span=document.createElement("span");span.textContent=String(value);meta.appendChild(span);}detail.appendChild(meta);
    const capabilities=graph.capabilities||{};const actions=document.createElement("div");actions.className="aw-actions";const isChild=!!selected.parentThreadId;if(isChild&&["pendingInit","running"].includes(String(selected.status))&&capabilities.childInterruptSupported===true){const stop=document.createElement("button");stop.type="button";stop.className="danger";stop.textContent="Stop";stop.setAttribute("aria-label","Stop "+String(selected.taskName||selected.threadId));stop.onclick=()=>agentAction("stop",selected);actions.appendChild(stop);}if(isChild&&capabilities.childSteerSupported===true){const steer=document.createElement("button");steer.type="button";steer.textContent="Steer";steer.setAttribute("aria-label","Steer "+String(selected.taskName||selected.threadId));steer.onclick=()=>agentAction("steer",selected);actions.appendChild(steer);}if(isChild){const open=document.createElement("button");open.type="button";open.textContent="Open thread";open.onclick=()=>agentAction("open",selected);actions.appendChild(open);}if(actions.children.length)detail.appendChild(actions);
    const rawTimeline=Array.isArray(graph.events)?graph.events.filter(e=>e&&typeof e==="object"&&(String(e.threadId)===String(selected.threadId)||String(e.parentThreadId)===String(selected.threadId)||String(e.threadId)===String(selected.parentThreadId)||String(e.fromThreadId)===String(selected.threadId)||(Array.isArray(e.toThreadIds)&&e.toThreadIds.some(id=>String(id)===String(selected.threadId))))):[];if(rawTimeline.length){const section=document.createElement("section");section.className="aw-section";const h=document.createElement("h4");h.textContent="Parent · child timeline";section.appendChild(h);const list=document.createElement("div");list.className="aw-timeline";rawTimeline.slice(-80).forEach(m=>{const row=document.createElement("div");row.className="aw-message";const from=document.createElement("span");from.className="from";from.textContent=String(m.fromThreadId||m.kind||"event");const text=document.createElement("span");text.className="text";text.textContent=String(m.summary||m.kind||"");row.append(from,text);list.appendChild(row);});section.appendChild(list);detail.appendChild(section);}
    const changes=Array.isArray(selected.changes)?selected.changes:[];if(changes.length){const section=document.createElement("section");section.className="aw-section";const h=document.createElement("h4");h.textContent="Changes";section.appendChild(h);const list=document.createElement("div");list.className="aw-changes";changes.slice(0,100).forEach(change=>{const path=typeof change==="string"?change:(change&&typeof change==="object"?change.path:"");if(!path)return;const row=document.createElement("div");row.className="aw-change";const name=document.createElement("span");name.className="path";name.textContent=String(path);row.appendChild(name);if(change&&typeof change==="object"&&Number.isFinite(change.adds)){const adds=document.createElement("span");adds.className="adds";adds.textContent="+"+change.adds;row.appendChild(adds);}if(change&&typeof change==="object"&&Number.isFinite(change.dels)){const dels=document.createElement("span");dels.className="dels";dels.textContent="−"+change.dels;row.appendChild(dels);}list.appendChild(row);});section.appendChild(list);detail.appendChild(section);}
    const receipts=Array.isArray(selected.changeRecords)?selected.changeRecords.filter(record=>record&&typeof record==="object"&&typeof record.id==="string"&&typeof record.path==="string"):[]; if(receipts.length){const section=document.createElement("section");section.className="aw-section";const h=document.createElement("h4");h.textContent="Patch receipts";section.appendChild(h);const list=document.createElement("div");list.className="aw-receipts";receipts.slice(-100).forEach(record=>{const receipt=document.createElement("details");receipt.className="aw-receipt";receipt.dataset.receipt=record.id;receipt.open=agentReceiptOpen[receipt.dataset.receipt]===true;receipt.addEventListener("toggle",()=>{agentReceiptOpen[receipt.dataset.receipt]=receipt.open;persistView();});const summary=document.createElement("summary");summary.textContent=String(record.path);const meta=document.createElement("span");meta.className="receipt-meta";meta.textContent=(record.turnId?"turn "+String(record.turnId).slice(0,12):"provider patch")+(record.itemId?" · item "+String(record.itemId).slice(0,12):"");summary.appendChild(meta);receipt.appendChild(summary);if(typeof record.diff==="string"&&record.diff){const pre=document.createElement("pre");pre.textContent=record.diff;receipt.appendChild(pre);}if(record.unavailable||record.truncated||!(typeof record.diff==="string"&&record.diff)){const note=document.createElement("div");note.className="receipt-note";note.textContent=record.unavailable?"Patch content was not supplied by the provider; open the thread to inspect the change.":record.truncated?"Patch preview truncated; open the thread to inspect the complete change.":"Patch content was not supplied by the provider; open the thread to inspect the change.";receipt.appendChild(note);}const open=document.createElement("button");open.type="button";open.className="receipt-open";open.textContent="Open thread";open.onclick=()=>agentAction("open",selected);receipt.appendChild(open);list.appendChild(receipt);});section.appendChild(list);detail.appendChild(section);}
    const usage=selected.usage&&typeof selected.usage==="object"?selected.usage:null;if(usage){const section=document.createElement("section");section.className="aw-section";const h=document.createElement("h4");h.textContent="Usage";section.appendChild(h);const grid=document.createElement("div");grid.className="aw-usage";for(const pair of [["Input","inputTokens"],["Cached","cachedInputTokens"],["Output","outputTokens"],["Reasoning","reasoningOutputTokens"]]){const cell=document.createElement("div");const label=document.createElement("span");label.textContent=pair[0];const value=document.createElement("b");value.textContent=typeof usage[pair[1]]==="number"?usage[pair[1]].toLocaleString():"—";cell.append(label,value);grid.appendChild(cell);}section.appendChild(grid);detail.appendChild(section);}
    if(isChild&&capabilities.childInterruptSupported!==true&&capabilities.childSteerSupported!==true){const note=document.createElement("div");note.className="aw-empty";note.textContent="Child controls are not exposed by this provider.";detail.appendChild(note);}
    if(typeof syncSpawnCards==="function")syncSpawnCards(graph);
  }
  setInterval(paintTime,1000);
  input.addEventListener("input",scheduleSave);
  input.addEventListener("blur",persistView);
  window.addEventListener("pagehide",persistView);
  messages.addEventListener("click",()=>scheduleSave());
  messages.addEventListener("toggle",()=>scheduleSave(),true);
  for(const id of ["ctx-add","mode-pill","access-pill","model-pill","send","attach","stopbtn","m-terminal","m-tasks","m-agents","m-new-task","m-more"]) {
    const el=$(id);if(!el)continue;el.setAttribute("role","button");el.tabIndex=0;
    el.setAttribute("aria-label",el.title||({"send":"Send message","mode-pill":"Choose mode","access-pill":"Choose access","model-pill":"Choose model"}[id])||el.textContent.trim());
    el.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();e.stopPropagation();el.click();}});
  }
  input.setAttribute("aria-label","Message Muster");
`;
