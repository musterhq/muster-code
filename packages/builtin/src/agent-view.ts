import { MUSTER_ICON_CODES } from "./muster-icons.js";
import { polishStyles, polishScript } from "./agent-polish.js";
import { MARKDOWN_RENDER_SCRIPT } from "./markdown-render.js";

export function paneHtml(csp: string, codicon = ""): string {
  return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${csp}; script-src 'unsafe-inline' ${csp}; img-src ${csp} data: https:; font-src ${csp};">
<style>
  @font-face { font-family: codicon; src: url("${codicon}") format("truetype"); font-display: block; }
  :root {
    --fg: var(--vscode-editor-foreground);
    --bg-primary: color-mix(in srgb, var(--fg) 20%, transparent);
    --bg-secondary: color-mix(in srgb, var(--fg) 14%, transparent);
    --bg-tertiary: color-mix(in srgb, var(--fg) 8%, transparent);
    --bg-quaternary: color-mix(in srgb, var(--fg) 6%, transparent);
    --bg-quinary: color-mix(in srgb, var(--fg) 4%, transparent);
    --text-secondary: color-mix(in srgb, var(--fg) 55%, transparent);
    --text-tertiary: color-mix(in srgb, var(--fg) 37%, transparent);
    --stroke-primary: color-mix(in srgb, var(--fg) 20%, transparent);
    --stroke-secondary: color-mix(in srgb, var(--fg) 12%, transparent);
    --stroke-tertiary: color-mix(in srgb, var(--fg) 8%, transparent);
    --surface-0: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --surface-1: color-mix(in srgb, var(--vscode-editorWidget-background, var(--surface-0)) 85%, var(--fg) 4%);
    --surface-2: color-mix(in srgb, var(--surface-1) 86%, var(--fg) 8%);
    --rim: color-mix(in srgb, var(--fg) 10%, transparent);
    --rim-strong: color-mix(in srgb, var(--fg) 16%, transparent);
    --shadow-1: 0 1px 2px rgba(0,0,0,.18);
    --shadow-2: 0 4px 14px rgba(0,0,0,.22);
    --m-accent: var(--vscode-textLink-foreground, #81A1C1);
    --accent: var(--m-accent);
    --ok: var(--vscode-charts-green);
    --warn: var(--vscode-charts-yellow);
    --err: var(--vscode-charts-red);
    --run: var(--accent);
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    --motion-instant: 0ms;
    --motion-fast: 120ms;
    --motion-ui: 160ms;
    --motion-panel: 180ms;
    --motion-ack: 1000ms;
    --dur-fast: var(--motion-fast);
    --dur: var(--motion-ui);
    --amber: #D2943E;
    --radius-sm: 4px; --radius-base: 6px; --radius-lg: 8px; --radius-xl: 12px;
    --fs-xs: 11px; --fs-sm: 12px; --fs-base: 13px; --fs-lg: 14px; --lh-lg: 22px;
  }
  @media (prefers-reduced-motion: reduce) { :root { --motion-fast: 0ms; --motion-ui: 0ms; --motion-panel: 0ms; --dur-fast: 0ms; --dur: 0ms; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font-family: var(--vscode-font-family); font-size: var(--fs-lg); line-height: var(--lh-lg); color: var(--fg); background: transparent; -webkit-font-smoothing: subpixel-antialiased; display: flex; flex-direction: column; overflow: hidden; }
  button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
  .head:focus-visible, .row:focus-visible, button:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 70%, transparent); outline-offset: 1px; }
  #tabs { display: none; }
  #tabs::-webkit-scrollbar { display: none; }
  .tab { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px 0 10px; border-radius: var(--radius-base); font-size: var(--fs-base); color: var(--text-secondary); white-space: nowrap; max-width: 220px; cursor: pointer; flex: 0 0 auto; }
  .tab .name { overflow: hidden; text-overflow: ellipsis; }
  .tab.active { background: var(--bg-tertiary); color: var(--fg); }
  .tab:hover { background: var(--bg-quaternary); }
  .tab .x { width: 16px; height: 16px; border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-tertiary); font-size: 12px; visibility: hidden; }
  .tab:hover .x, .tab.active .x { visibility: visible; }
  .tab .x:hover { background: var(--bg-secondary); color: var(--fg); }
  .tab .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-green); }
  .tabbtn { width: 26px; height: 26px; border-radius: var(--radius-base); display: inline-flex; align-items: center; justify-content: center; color: var(--text-secondary); flex: 0 0 auto; }
  .tabbtn:hover { background: var(--bg-tertiary); color: var(--fg); }
  .tabbtn.on { color: var(--fg); background: var(--bg-tertiary); }
  .tabbtn svg { width: 15px; height: 15px; }
  #tabs .spacer { flex: 1; }
  .view { display: none; flex: 1; min-height: 0; flex-direction: column; }
  body[data-view="chat"] #chat, body[data-view="history"] #history, body[data-view="board"] #board, body[data-view="browser"] #browserpane { display: flex; }
  .bbar { display: flex; align-items: center; gap: 4px; height: 34px; padding: 0 8px; border-bottom: 1px solid var(--stroke-tertiary); flex: 0 0 auto; }
  .bbtn { width: 26px; height: 24px; border-radius: var(--radius-base); color: var(--text-secondary); font-size: 13px; display: inline-flex; align-items: center; justify-content: center; }
  .bbtn:hover { background: var(--bg-tertiary); color: var(--fg); } .bbtn.on { background: var(--amber); color: #1a1a1a; }
  #burl { flex: 1; min-width: 0; height: 24px; border: 1px solid var(--stroke-secondary); border-radius: var(--radius-base); background: var(--vscode-input-background); color: var(--fg); font: inherit; font-size: var(--fs-sm); padding: 0 10px; outline: none; }
  #burl:focus { border-color: var(--stroke-primary); }
  #bhost { flex: 1; min-height: 120px; background: transparent; }
  .bsections { flex: 0 0 auto; height: 190px; border-top: 1px solid var(--stroke-tertiary); display: flex; flex-direction: column; }
  .bstabs { display: flex; align-items: center; gap: 2px; height: 28px; padding: 0 6px; border-bottom: 1px solid var(--stroke-tertiary); font-size: var(--fs-sm); }
  .bstab { padding: 3px 8px; border-radius: var(--radius-sm); color: var(--text-secondary); cursor: pointer; } .bstab:hover { background: var(--bg-quaternary); } .bstab.on { background: var(--bg-tertiary); color: var(--fg); }
  .bstab .cnt { color: var(--text-tertiary); font-size: var(--fs-xs); }
  .bsbody { flex: 1; overflow: auto; padding: 6px 10px; font-family: var(--vscode-editor-font-family); font-size: var(--fs-xs); line-height: 17px; white-space: pre-wrap; word-break: break-word; }
  .bsbody .c { display: block; } .bsbody .c.warn { color: var(--vscode-charts-yellow, #D2943E); } .bsbody .c.error { color: var(--vscode-charts-red); } .bsbody .c.debug { color: var(--text-tertiary); }
  .bsbody .kv { display: block; } .bsbody .kv b { color: var(--text-secondary); font-weight: 500; }
  .bbookmarks { display: none; gap: 4px; padding: 3px 8px; border-bottom: 1px solid var(--stroke-tertiary); overflow-x: auto; white-space: nowrap; } .bbookmarks.has { display: flex; }
  .bbookmarks .bm { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 6px; border-radius: 4px; font-size: var(--fs-xs); color: var(--text-secondary); cursor: pointer; max-width: 160px; } .bbookmarks .bm:hover { background: var(--bg-tertiary); color: var(--fg); } .bbookmarks .bm span { overflow: hidden; text-overflow: ellipsis; } .bbookmarks .bm .cod { font-size: 11px; width: 12px; height: 12px; }
  #bstar.on { color: var(--amber); }
  .bcert { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: var(--fs-sm); color: var(--vscode-charts-yellow, #D2943E); border-bottom: 1px solid var(--stroke-tertiary); } .bcert[hidden] { display: none; } .bcert .msg { flex: 1; }
  body.dictating .icon[title="Dictate"] { color: var(--amber); filter: drop-shadow(0 0 4px var(--amber)); }
  .bdriving { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; color: var(--amber); font-size: var(--fs-xs); white-space: nowrap; } .bdriving[hidden] { display: none; }
  .bdriving .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--amber); box-shadow: 0 0 6px var(--amber); }
  .bsbody .field { display: flex; align-items: center; gap: 6px; margin: 3px 0; font-family: var(--vscode-font-family); } .bsbody .field b { width: 96px; flex: 0 0 auto; color: var(--text-secondary); font-weight: 500; }
  .bsbody .field input { flex: 1; min-width: 0; height: 20px; background: var(--bg-quaternary); border: 1px solid var(--stroke-tertiary); border-radius: var(--radius-sm); color: var(--fg); font: inherit; font-size: var(--fs-xs); padding: 0 6px; outline: 0; } .bsbody .field input:focus { border-color: var(--amber); }
  .bsbody .field input.changed { border-color: color-mix(in srgb, var(--amber) 60%, transparent); background: color-mix(in srgb, var(--amber) 10%, transparent); }
  .bchange { display: flex; align-items: center; gap: 6px; margin: 2px 0; white-space: nowrap; overflow: hidden; } .bchange .sel { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; max-width: 40%; } .bchange .old { color: var(--text-tertiary); text-decoration: line-through; } .bchange .arrow { color: var(--text-tertiary); } .bchange .new { color: var(--fg); } .bchange .x { cursor: pointer; color: var(--text-tertiary); margin-left: auto; } .bchange .x:hover { color: var(--fg); }
  .bsbody .bapply { margin-top: 8px; }
  #messages { flex: 1; overflow: auto; padding: 16px 20px 12px; display: flex; flex-direction: column; align-items: stretch; gap: 0; width: 100%; max-width: 840px; margin: 0 auto; box-sizing: border-box; }
  #messages > * { margin-bottom: 14px; }
  #messages > *:last-child { margin-bottom: 0; }
  body:not(.has-messages) #messages { display: none; }
  .human { align-self: flex-end; width: fit-content; margin-left: max(32px, 12%); min-width: 0; max-width: min(84%, 640px); max-height: none; overflow: visible; position: relative; display: flex; flex-direction: column; gap: 6px; background: var(--vscode-input-background); border: 1px solid var(--stroke-secondary); border-radius: 999px; box-shadow: none; padding: 7px 16px; white-space: pre-wrap; word-break: break-word; font-size: var(--fs-lg); line-height: var(--lh-lg); transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
  .human.has-images, .human.clipped, .human.expanded, .human.editing { border-radius: 16px; padding: 10px 14px; }
  .human.has-images { flex-direction: row; flex-wrap: wrap; align-items: flex-start; gap: 10px; }
  .human:hover { background: color-mix(in srgb, var(--vscode-input-background) 82%, var(--fg) 8%); border-color: var(--stroke-primary); }
  .human-images { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; }
  .human-thumb { width: 32px; height: 32px; object-fit: cover; border-radius: 6px; border: 1px solid var(--stroke-secondary); cursor: zoom-in; background: var(--bg-tertiary); flex: 0 0 auto; }
  .human .txt { min-width: 0; flex: 1 1 auto; }
  .msg-acts { display: flex; align-items: center; gap: 2px; margin-top: 4px; margin-bottom: 2px; opacity: 0; transition: opacity var(--motion-fast) var(--ease-out); }
  .assistant:hover .msg-acts, .assistant:focus-within .msg-acts { opacity: 1; }
  .msg-acts .act { width: 22px; height: 22px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-tertiary); cursor: pointer; }
  .msg-acts .act:hover { color: var(--fg); background: var(--bg-tertiary); }
  .msg-acts .act .cod { width: 14px; height: 14px; font-size: 14px; }
  #img-lightbox { position: fixed; inset: 0; z-index: 80; display: none; align-items: center; justify-content: center; }
  #img-lightbox.open { display: flex; }
  #img-lightbox .lb-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.72); }
  #img-lightbox img { position: relative; max-width: min(92vw, 960px); max-height: 88vh; border-radius: 8px; object-fit: contain; box-shadow: 0 8px 32px #00000088; }
  .human .tools { position: absolute; right: 0; top: calc(100% + 4px); display: none; gap: 2px; margin: 0; z-index: 3; padding: 2px; border: 1px solid var(--stroke-secondary); border-radius: 8px; background: var(--vscode-editor-background); box-shadow: 0 4px 14px rgba(0,0,0,.28); }
  .human:hover .tools, .human:focus-within .tools { display: inline-flex; }
  .human .tools button { width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-secondary); background: transparent; cursor: pointer; }
  .human .tools button:hover { color: var(--fg); background: var(--bg-tertiary); } .human .tools .cod { font-size: 13px; width: 13px; height: 13px; }
  .human.editing { max-height: none; overflow: visible; }
  .human textarea.edit { width: 100%; min-height: 64px; box-sizing: border-box; background: transparent; border: 0; outline: 0; color: var(--fg); font: inherit; font-size: var(--fs-base); line-height: var(--lh-base); resize: vertical; padding: 0; }
  .human .editbar { display: flex; justify-content: flex-end; margin-top: 4px; font-size: var(--fs-xs); color: var(--text-tertiary); }
  .human.steer .txt::before { content: "added mid-turn"; display: block; font-size: var(--fs-xs); color: var(--text-tertiary); margin-bottom: 2px; }
  #queue { display: none; flex-direction: column; gap: 4px; padding: 0 12px 6px; } #queue.has { display: flex; }
  #queue .q { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border: 1px dashed var(--stroke-secondary); border-radius: var(--radius-base); font-size: var(--fs-sm); color: var(--text-secondary); min-width: 0; }
  #queue .q .lbl { flex: 0 0 auto; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .3px; color: var(--text-tertiary); } #queue .q .txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } #queue .q .x { cursor: pointer; } #queue .q .x:hover { color: var(--fg); }
  .stopbtn { display: none; background: var(--fg); color: var(--vscode-editor-background); border-radius: 9999px; width: 24px; height: 24px; align-items: center; justify-content: center; cursor: pointer; font-size: 10px; } body.running .stopbtn { display: inline-flex; }
  .human-thumb[data-pending="1"] { opacity: .45; background: var(--bg-tertiary); }
  .human.clipped::after { display: none; }
  .assistant { word-break: break-word; font-size: var(--fs-lg); line-height: var(--lh-lg); display: flex; flex-direction: column; align-items: flex-start; width: 100%; }
  .assistant .assistant-body { width: 100%; min-width: 0; }
  .assistant p { margin: 0 0 10px; }
  .assistant p:last-child { margin-bottom: 4px; }
  .assistant h1, .assistant h2, .assistant h3 { margin: 14px 0 6px; font-weight: 600; line-height: 1.3; }
  .assistant h1 { font-size: 16px; } .assistant h2 { font-size: 15px; } .assistant h3 { font-size: 14px; }
  .assistant ul, .assistant ol { margin: 0 0 8px; padding-left: 22px; }
  .assistant li { margin: 2px 0; }
  .assistant code { background: color-mix(in srgb, var(--fg) 9%, transparent); border-radius: 5px; padding: 1px 5px; font-family: var(--vscode-editor-font-family); font-size: 12.5px; }
  .assistant .code { position: relative; margin: 8px 0; border: 1px solid var(--rim); border-radius: 8px; background: var(--surface-1); box-shadow: var(--shadow-1); }
  .assistant .code .head { display: flex; align-items: center; height: 28px; padding: 0 10px; font-size: var(--fs-xs); color: var(--text-tertiary); border-bottom: 1px solid var(--rim); }
  .assistant .code .copy { margin-left: auto; color: var(--text-secondary); font-size: var(--fs-xs); }
  .assistant .code .copy:hover { color: var(--fg); }
  .assistant pre { margin: 0; padding: 8px 10px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--fs-base); line-height: 20px; }
  .assistant a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .assistant a.file { color: inherit; cursor: pointer; } .assistant a.file code, .assistant a.file .path { text-decoration: underline dotted color-mix(in srgb, var(--fg) 40%, transparent); text-underline-offset: 3px; } .assistant a.file:hover code, .assistant a.file:hover .path { background: var(--bg-tertiary); }
  .assistant .cite { display: inline-flex; align-items: center; gap: 3px; height: 18px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--stroke-secondary); font-size: var(--fs-xs); font-family: var(--vscode-editor-font-family); vertical-align: middle; } .assistant .cite .cod { font-size: 11px; width: 12px; height: 12px; }
  .assistant .code .head .path { font-family: var(--vscode-editor-font-family); color: var(--text-secondary); } .assistant .code .head .spacer { flex: 1; }
  .assistant .code .head button { margin-left: 6px; color: var(--text-tertiary); font-size: var(--fs-xs); cursor: pointer; } .assistant .code .head button:hover { color: var(--fg); } .assistant .code .head button.apply { color: var(--amber); }
  .assistant li.task { list-style: none; margin-left: -16px; display: flex; align-items: flex-start; gap: 6px; } .assistant li.task .cod { font-size: 13px; width: 14px; height: 20px; color: var(--text-tertiary); } .assistant li.task.done .cod { color: var(--vscode-charts-green, #7bd88f); } .assistant li.task.done { color: var(--text-tertiary); }
  .assistant.streaming:last-child > :last-child::after { content: ""; display: inline-block; width: 2px; height: 1em; margin-left: 2px; background: var(--fg); vertical-align: -2px; animation: caret 1s steps(2) infinite; } @keyframes caret { 50% { opacity: 0; } }
  .thinking.streaming ~ .assistant.streaming > :last-child::after { display: none; }
  .assistant blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); color: var(--text-secondary); }
  .assistant table { border-collapse: collapse; margin: 0 0 8px; font-size: var(--fs-base); }
  .assistant th, .assistant td { border: 1px solid var(--rim); padding: 4px 10px; text-align: left; }
  .assistant th { background: var(--surface-1); font-weight: 600; }
  .assistant hr { border: 0; border-top: 1px solid var(--stroke-secondary); margin: 10px 0; }
  .assistant .md-img { max-width: 100%; border-radius: 8px; border: 1px solid var(--stroke-tertiary); margin: 6px 0; cursor: zoom-in; display:block }
  .thinking { color: var(--text-secondary); font-size: 13px; line-height: 20px; }
  .thinking.stream-in, .tool.stream-in { animation: stream-in var(--motion-ui) var(--ease-out); }
  @keyframes stream-in { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
  .thinking summary { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--text-secondary); list-style: none; }
  .thinking summary::-webkit-details-marker { display: none; }
  .thinking .pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); flex: 0 0 auto; animation: think-pulse 1.2s ease-in-out infinite; }
  .thinking:not(.streaming) .pulse { display: none; }
  .thinking .think-glyph { width: 11px; height: 11px; flex: 0 0 auto; border: 1.5px solid var(--m-accent); border-radius: 2px; transform: rotate(45deg); opacity: .7; }
  .thinking.streaming .think-glyph { animation: think-glyph 1.05s var(--ease-out) infinite; }
  .thinking:not(.streaming) .think-glyph { display: none; }
  .thinking.streaming .chev { visibility: hidden; width: 0; margin: 0; border: 0; }
  .thinking .chev { width: 8px; height: 8px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform var(--motion-ui) var(--ease-out); flex: 0 0 auto; }
  .thinking[open] .chev { transform: rotate(45deg); }
  .thinking .label { font-weight: 500; }
  .thinking.streaming .label { background: linear-gradient(90deg, var(--text-secondary) 0%, var(--fg) 45%, var(--text-secondary) 90%); background-size: 180% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: think-shimmer 1.6s ease-in-out infinite; }
  .thinking .dur { color: var(--text-tertiary); font-variant-numeric: tabular-nums; margin-left: 2px; }
  .thinking.streaming .dur:empty { display: none; }
  .thinking .reveal { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--motion-ui) var(--ease-out); }
  .thinking[open] .reveal, .thinking.streaming .reveal { grid-template-rows: 1fr; }
  .thinking .ticker { min-height: 0; overflow: hidden; }
  .thinking.streaming .ticker { max-height: 6.75em; display: flex; flex-direction: column; justify-content: flex-end; margin-top: 4px; mask-image: linear-gradient(to bottom, transparent 0%, #000 28%, #000 100%); -webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 28%, #000 100%); }
  .thinking .body { color: var(--text-secondary); font-size: 12px; line-height: 18px; font-style: italic; min-height: 0; overflow: hidden; white-space: pre-wrap; }
  .thinking[open]:not(.streaming) .ticker { max-height: 240px; overflow: auto; margin-top: 4px; }
  .thinking[open]:not(.streaming) .body { max-height: none; overflow: visible; }
  .thinking.streaming .body { max-height: none; overflow: visible; margin: 0; }
  .thinking .think-prev { opacity: .72; }
  .thinking .think-line { display: block; }
  .thinking.streaming .think-line.think-rise { animation: think-rise var(--motion-ui) var(--ease-out); }
  @keyframes think-rise { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes think-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -80% 0; } }
  @keyframes think-glyph { 0%, 100% { transform: rotate(45deg) scale(.92); opacity: .4; } 50% { transform: rotate(225deg) scale(1.12); opacity: 1; } }
  @keyframes think-pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .thinking .pulse, .thinking.streaming .think-glyph, .thinking.streaming .label, .thinking.streaming .think-line.think-rise { animation: none; } .thinking.streaming .label { color: var(--text-secondary); background: none; -webkit-background-clip: unset; background-clip: unset; } .thinking .chev, .thinking .reveal { transition: none; } .assistant.streaming:last-child > :last-child::after { animation: none; } }
  .error { color: var(--vscode-errorForeground); font-size: var(--fs-base); }
  .card { border: 1px solid var(--rim); border-radius: 8px; background: var(--surface-1); box-shadow: var(--shadow-1); font-size: var(--fs-base); }
  .edit { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 10px; color: var(--text-secondary); cursor: pointer; }
  .edit:hover { background: var(--bg-quinary); }
  .edit .path { color: var(--fg); font-family: var(--vscode-editor-font-family); font-size: var(--fs-sm); }
  .adds { color: var(--vscode-charts-green); font-variant-numeric: tabular-nums; } .dels { color: var(--vscode-charts-red); font-variant-numeric: tabular-nums; }
  .edit .state { margin-left: auto; color: var(--text-tertiary); font-size: var(--fs-xs); }
  .editwrap .diff { display: none; margin: 0; padding: 6px 10px 8px; border-top: 1px solid var(--stroke-tertiary); max-height: 260px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--fs-sm); line-height: 18px; white-space: pre; }
  .editwrap.open .diff { display: block; }
  .editwrap .diff .a { background: var(--vscode-diffEditor-insertedLineBackground); display: block; }
  .editwrap .diff .d { background: var(--vscode-diffEditor-removedLineBackground); display: block; opacity: .9; }
  .editwrap .diff .h { color: var(--text-tertiary); display: block; }
  .card.tool, .tool { background: transparent !important; border: 0 !important; border-radius: 0; box-shadow: none !important; margin: 0; padding: 0; }
  .tool:hover { background: var(--bg-quaternary); }
  .tool .head { display: flex; align-items: center; gap: 4px; height: 22px; max-height: 22px; overflow: hidden; padding: 0 4px; color: var(--text-tertiary); font-size: var(--fs-base); cursor: pointer; }
  .tool .head .t { color: var(--fg); font-weight: 500; flex: 0 0 auto; white-space: nowrap; }
  .tool .head .cmd { flex: 1 1 auto; min-width: 0; font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap !important; }
  .tool .head .more { flex: 0 0 auto; margin-left: auto; color: var(--text-tertiary); letter-spacing: 1px; padding: 0 2px; opacity: 0; }
  .tool:hover .head .more { opacity: 1; }
  .tool .head .status { flex: 0 0 auto; color: var(--text-tertiary); font-size: var(--fs-xs); }
  .tool pre { display: none; margin: 0; padding: 4px 8px 4px 6px; border-top: 0; max-height: 220px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 18px; color: var(--text-secondary); white-space: pre-wrap; background: transparent; border-radius: 0; }
  .tool.open pre { display: block; }
  .tool pre:empty { display: none; }
  .tool .head .ic { display: inline-flex; } .tool .head .ic .cod { font-size: 14px; width: 14px; height: 14px; color: var(--text-secondary); }
  .tool .prompt-ic { font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 16px; color: var(--text-secondary); letter-spacing: -0.4px; }
  .card.tool.command, .tool.command { background: var(--vscode-editor-background) !important; border: 1px solid var(--stroke-secondary) !important; border-radius: var(--radius-xl) !important; box-shadow: none !important; overflow: hidden; margin: 2px 0; }
  .tool.command:hover { background: var(--vscode-editor-background) !important; }
  .tool.command .head { height: 28px; max-height: 28px; padding: 0 10px; gap: 6px; }
  .tool.command pre { display: block; max-height: 4.6em; padding: 4px 10px 8px; mask-image: linear-gradient(to bottom, #000 55%, transparent); -webkit-mask-image: linear-gradient(to bottom, #000 55%, transparent); }
  .tool.command.open pre { max-height: 220px; mask-image: none; -webkit-mask-image: none; }
  .tool.command.running { box-shadow: inset 2px 0 0 var(--run) !important; }
  .subagent { border: 1px solid var(--stroke-secondary); border-radius: var(--radius-xl); background: var(--vscode-editor-background); overflow: hidden; margin: 2px 0; }
  .subagent .sa-head { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; cursor: pointer; color: var(--text-secondary); font-size: var(--fs-sm); }
  .subagent .sa-head:hover { background: var(--bg-quaternary); }
  .subagent .sa-name { color: var(--fg); font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subagent .sa-status { color: var(--text-tertiary); font-size: var(--fs-xs); }
  .subagent.running .sa-status { color: var(--m-accent); }
  .subagent.failed .sa-status { color: var(--err); }
  .subagent .sa-dur { margin-left: auto; color: var(--text-tertiary); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); }
  .subagent .sa-glyph { width: 10px; height: 10px; flex: 0 0 auto; border: 1.5px solid var(--m-accent); border-radius: 2px; transform: rotate(45deg); opacity: .65; }
  .subagent:not(.running) .sa-glyph, .subagent:not(.running) .sa-pulse { display: none; }
  .subagent.running .sa-glyph { animation: think-glyph 1.05s var(--ease-out) infinite; }
  .subagent .sa-pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); animation: think-pulse 1.2s ease-in-out infinite; }
  .subagent .chev { width: 8px; height: 8px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform var(--motion-ui) var(--ease-out); }
  .subagent.open .chev { transform: rotate(45deg); }
  .subagent .sa-reveal { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--motion-ui) var(--ease-out); }
  .subagent.open .sa-reveal { grid-template-rows: 1fr; }
  .subagent .sa-body { min-height: 0; overflow: hidden; padding: 0 10px 8px; }
  .subagent .sa-prompt { color: var(--text-secondary); font-size: 12px; line-height: 18px; margin-bottom: 6px; }
  .subagent .sa-event { color: var(--text-tertiary); font-size: 11px; line-height: 16px; padding: 1px 0 1px 14px; position: relative; }
  .subagent .sa-event::before { content: ""; position: absolute; left: 4px; top: 7px; width: 5px; height: 5px; border-radius: 50%; background: var(--text-tertiary); }
  .subagent .sa-event[data-kind="spawned"]::before { background: var(--m-accent); }
  .subagent .sa-event[data-kind="change"]::before { background: var(--ok); }
  .tool .spin { width: 12px; height: 12px; border: 1.5px solid var(--rim-strong); border-top-color: var(--run); border-radius: 50%; flex: 0 0 auto; animation: m-tool-spin .7s linear infinite; }
  @keyframes m-tool-spin { to { transform: rotate(360deg); } }
  .tool:not(.running) .spin { display: none; }
  .tool.running { box-shadow: inset 2px 0 0 var(--run); }
  .tool.failed { box-shadow: inset 2px 0 0 var(--err); }
  .tool.failed .head .t, .tool.failed .head .status { color: var(--err); }
  @media (prefers-reduced-motion: reduce) { .tool .spin { animation: none; width: 6px; height: 6px; border: 0; background: var(--run); } }
  .tool.line { background: transparent !important; border: 0 !important; box-shadow: none !important; margin: 0; }
  .tool.line .head { height: 20px; max-height: 20px; padding: 0; gap: 6px; }
  .tool.line .head .t { font-weight: 500; color: var(--text-secondary); }
  .tool.line .head .cmd { color: var(--text-secondary); font-family: inherit; font-size: 13px; }
  .tool.line .head .cmd .xp { color: var(--m-accent); }
  .tool.line .head .cmd .xk { color: var(--amber); }
  .tool.line .head .cmd .xr { color: var(--text-tertiary); }
  .tool.line { position: relative; }
  .tool.line .ic, .tool.line .more, .tool.line .spin, .tool.line .status { display: none; }
  .tool.line .line-dur { flex: 0 0 auto; margin-left: auto; color: var(--text-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
  .tool.line.running .line-dur { display: none; }
  .tool.line pre { display: none; }
  .tool.line .explore-pop { position: absolute; left: 0; top: calc(100% + 3px); z-index: 12; min-width: 180px; max-width: min(440px, 92vw); max-height: 220px; overflow: auto; padding: 6px 8px; border: 1px solid var(--stroke-secondary); border-radius: 8px; background: var(--vscode-editor-background); box-shadow: var(--shadow-2); font-size: 12px; line-height: 18px; pointer-events: none; }
  .tool.line .explore-pop[hidden] { display: none; }
  .tool.line .explore-pop .ep { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 1px 0; }
  .tool.line .explore-pop .ep .xp { color: var(--m-accent); }
  .tool.line:hover .head { background: var(--bg-quaternary); border-radius: 4px; }
  .tool.line.running .t { background: linear-gradient(90deg, var(--text-secondary) 0%, var(--fg) 45%, var(--text-secondary) 90%); background-size: 180% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: think-shimmer 1.6s ease-in-out infinite; }
  .tool-group { background: transparent; border: 0; box-shadow: none; }
  .tool-group > .head { display: none; align-items: center; gap: 6px; height: 20px; padding: 0; color: var(--text-secondary); font-size: 13px; cursor: pointer; }
  .tool-group.collecting > .head { display: flex; }
  .tool-group > .head .chev { width: 8px; height: 8px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform var(--motion-ui) var(--ease-out); }
  .tool-group.open > .head .chev { transform: rotate(45deg); }
  .tool-group .reveal { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--motion-ui) var(--ease-out); }
  .tool-group.open .reveal { grid-template-rows: 1fr; }
  .tool-group .group-body { min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 6px; padding: 2px 0 4px; }
  .tool .shot { display: block; max-width: 100%; margin: 0; border-top: 1px solid var(--rim); border-radius: 0 0 8px 8px; }
  .card.approval { margin: 4px 0; background: var(--surface-1); border: 1px solid var(--rim); box-shadow: var(--shadow-1); }
  .card.approval .head { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; font-size: var(--fs-sm); color: var(--text-secondary); border-bottom: 1px solid var(--stroke-tertiary); }
  .card.approval .head .ic .cod { font-size: 13px; width: 14px; height: 14px; color: var(--amber); } .card.approval .head .t { color: var(--fg); font-weight: 500; } .card.approval .head .hint { margin-left: auto; color: var(--text-tertiary); font-size: var(--fs-xs); }
  .card.approval .what { margin: 0; padding: 8px 10px; font-family: var(--vscode-editor-font-family); font-size: var(--fs-sm); white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; }
  .card.approval .meta { padding: 0 10px 6px; font-size: var(--fs-xs); color: var(--text-tertiary); } .card.approval .meta:empty { display: none; }
  .card.approval .actions { display: flex; gap: 6px; padding: 6px 10px 8px; border-top: 1px solid var(--stroke-tertiary); } .card.approval .actions kbd { font-family: inherit; margin-left: 6px; opacity: .6; font-size: var(--fs-xs); }
  .card.approval.decided { border-color: var(--stroke-tertiary); opacity: .8; }
  .plan { padding: 8px 10px 8px; }
  .plan .file { display: flex; align-items: center; gap: 6px; font-size: var(--fs-base); color: var(--text-secondary); margin-bottom: 6px; }
  .plan .file .icon { color: var(--text-tertiary); }
  .plan .file .name { font-family: var(--vscode-editor-font-family); font-size: var(--fs-sm); }
  .plan h3 { margin: 2px 0 4px; font-size: 14px; font-weight: 600; line-height: 20px; }
  .plan .summary { color: var(--text-secondary); margin-bottom: 6px; font-size: var(--fs-base); line-height: 19px; }
  .plan .todos { border: 1px solid var(--stroke-tertiary); border-radius: var(--radius-lg); padding: 6px 8px; background: var(--bg-quinary); }
  .plan .todos .t { color: var(--text-tertiary); font-size: var(--fs-base); margin-bottom: 4px; }
  .plan .todo { display: flex; gap: 8px; align-items: flex-start; padding: 2px 4px; margin: 0 -4px; border-radius: 4px; font-size: var(--fs-sm); line-height: 18px; cursor: pointer; }
  .plan .todo:hover { background: var(--bg-quaternary); }
  .plan .todo .o { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid var(--stroke-primary); flex: 0 0 auto; margin-top: 3px; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; color: var(--vscode-button-foreground); }
  .plan .todo.sel .o { background: var(--amber); border-color: var(--amber); color: #1a1a1a; }
  .plan .todos .t { display: flex; align-items: center; gap: 8px; }
  .plan .todos .t .all { margin-left: auto; color: var(--text-secondary); font-size: var(--fs-xs); cursor: pointer; }
  .plan .todos .t .all:hover { color: var(--fg); }
  .plan .more { cursor: pointer; } .plan .more:hover { color: var(--text-secondary); }
  .plan .foot .modelpick { color: var(--text-secondary); font-size: var(--fs-base); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; height: 24px; border-radius: var(--radius-base); }
  .plan .foot .modelpick:hover { background: var(--bg-quaternary); color: var(--fg); }
  .plan .foot .split { display: inline-flex; border-radius: var(--radius-base); overflow: hidden; }
  .plan .foot .split .btn { border-radius: 0; }
  .plan .foot .split .chev { width: 22px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: var(--amber); color: #1a1a1a; border-left: 1px solid rgba(0,0,0,.25); cursor: pointer; font-size: 9px; }
  .btn.amber, .btn.amber kbd { color: #1a1a1a; }
  .plan .planned { color: var(--text-tertiary); font-size: var(--fs-xs); margin-left: auto; }
  .plan .todo.done .o { background: var(--vscode-charts-green); border-color: var(--vscode-charts-green); }
  .plan .todo.done { color: var(--text-tertiary); text-decoration: line-through; }
  .plan .more { color: var(--text-tertiary); font-size: var(--fs-base); padding: 3px 0 0 22px; }
  .plan .foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .plan .foot .viewplan { color: var(--text-secondary); font-size: var(--fs-base); }
  .plan .foot .viewplan:hover { color: var(--fg); }
  .plan .foot .spacer { flex: 1; }
  .btn { height: 24px; padding: 0 9px; border-radius: var(--radius-base); font-size: var(--fs-sm); display: inline-flex; align-items: center; gap: 6px; }
  .btn.amber { background: var(--amber); color: #1a1a1a; font-weight: 500; }
  .btn.amber kbd { font-family: inherit; opacity: .7; }
  .btn.text { color: var(--text-secondary); } .btn.text:hover { color: var(--fg); background: var(--surface-2); }
  .btn.primary { background: var(--accent); color: color-mix(in srgb, white 88%, black); }
  .card.approval .btn.primary { background: var(--accent); color: color-mix(in srgb, white 88%, black); }
  #redo { display: none; padding: 0 10px 8px; }
  body.can-redo:not(.running) #redo { display: flex; }
  #redo button { height: 28px; padding: 0 10px; border-radius: var(--radius-base); display: inline-flex; align-items: center; gap: 7px; color: var(--text-secondary); background: var(--bg-tertiary); font-size: var(--fs-base); }
  #redo button:hover { color: var(--fg); background: var(--bg-secondary); }
  #redo svg { width: 14px; height: 14px; }
  #review { display: none; margin: 0 10px; border: 1px solid var(--stroke-secondary); border-bottom: 0; border-radius: var(--radius-xl) var(--radius-xl) 0 0; background: var(--vscode-input-background); font-size: var(--fs-base); }
  body.reviewing #review { display: block; }
  body.reviewing #composer { margin-top: 0; border-top-left-radius: 0; border-top-right-radius: 0; }
  #review .head { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; cursor: pointer; }
  #review .chev { color: var(--text-tertiary); font-size: 10px; width: 10px; }
  #review .files { display: none; border-top: 1px solid var(--stroke-tertiary); padding: 4px 0; }
  #review.open .files { display: block; }
  #review .file { display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 10px; cursor: pointer; }
  #review .file:hover { background: var(--bg-quaternary); }
  #review .file .name { font-family: var(--vscode-editor-font-family); font-size: var(--fs-sm); }
  #review .file .dir { color: var(--text-tertiary); font-size: var(--fs-xs); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #status { display: none; align-items: center; justify-content: space-between; margin: 0 12px 4px; padding: 0 2px; font-size: 12px; color: var(--text-secondary); flex: 0 0 auto; }
  body.running #status { display: flex; }
  #status .stop { cursor: pointer; } #status .stop kbd { font-family: inherit; color: var(--text-tertiary); margin-left: 6px; }
  #composer { margin: 6px 10px 8px; background: var(--vscode-input-background); border: 1px solid var(--stroke-secondary); border-radius: var(--radius-xl); padding: 10px 12px 8px; position: relative; flex: 0 0 auto; min-width: 0; overflow: hidden; container-type: inline-size; }
  #messages, .card, .assistant, .human { min-width: 0; }
  #messages > * { flex-shrink: 0; }
  .card { overflow: hidden; }
  .edit .path, .tool .head .cmd { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .assistant pre, .assistant table { max-width: 100%; }
  @container (max-width: 420px) { .pill.access .lbl { display: none; } .pill.model .lbl { max-width: 110px; } }
  @container (max-width: 300px) { .pill.mode .lbl { display: none; } .icon[title="Dictate"] { display: none; } }
  #composer:focus-within { border-color: var(--stroke-primary); }
  /* Cursor's context pills (.context-pill): 20px, 12px text, icon that turns into × on hover; dashed for suggestions and "Add Context". */
  .ctx { display: inline-flex; align-items: center; gap: 4px; height: 20px; box-sizing: border-box; padding: 2px 4px; border: 1px solid var(--stroke-secondary); border-radius: 4px; font-size: 12px; line-height: 16px; color: var(--fg); white-space: nowrap; max-width: 220px; cursor: default; user-select: none; }
  .ctx:hover { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 80%, transparent); }
  .ctx .ci { display: inline-flex; width: 12px; height: 12px; align-items: center; justify-content: center; flex: 0 0 auto; } .ctx .ci .cod { font-size: 12px; width: 12px; height: 12px; } .ctx .ci .badge { font-size: 8px; height: 12px; line-height: 12px; min-width: 14px; padding: 0 2px; }
  .ctx .x { display: none; width: 12px; height: 12px; align-items: center; justify-content: center; cursor: pointer; color: var(--fg); font-family: codicon; font-size: 12px; } .ctx:hover .ci { display: none; } .ctx:hover .x { display: inline-flex; }
  .ctx .n { overflow: hidden; text-overflow: ellipsis; }
  .ctx.bad { border-style: dashed; opacity: .6; }
  .ctx.suggestion { border-style: dashed; opacity: .6; cursor: pointer; } .ctx.suggestion:hover { opacity: .9; }
  .ctx.openable .n { cursor: pointer; } .ctx.openable .n:hover { text-decoration: underline; }
  .ctx.add { border-style: dashed; opacity: .6; cursor: pointer; color: var(--text-secondary); } .ctx.add:hover { opacity: .9; background: transparent; } .ctx.add .cod { font-size: 12px; width: 12px; height: 12px; }
  .inputwrap { position: relative; }
  /* Cursor's inline mention (.mention): radius 6, padding 1px 4px, quiet background; unresolved ones dashed. */
  #backdrop mark { color: transparent; background: color-mix(in srgb, var(--fg) 12%, transparent); border-radius: 6px; padding: 1px 4px; margin: 0 -4px; }
  #backdrop mark.bad { background: transparent; outline: 1px dashed color-mix(in srgb, var(--fg) 35%, transparent); outline-offset: -1px; }
  #backdrop { position: absolute; inset: 0; overflow: hidden; pointer-events: none; color: transparent; white-space: pre-wrap; word-wrap: break-word; font: inherit; font-size: var(--fs-lg); line-height: var(--lh-lg); padding: 0; }
  #input { position: relative; z-index: 1; width: 100%; min-height: 44px; max-height: 240px; resize: none; border: 0; outline: 0; background: transparent; color: var(--fg); font: inherit; font-size: var(--fs-lg); line-height: var(--lh-lg); padding: 0; }
  #input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .bar { display: flex; align-items: center; gap: 6px; margin-top: 6px; min-width: 0; }
  .pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 7px; border-radius: var(--radius-base); font-size: var(--fs-sm); color: var(--fg); cursor: pointer; white-space: nowrap; min-width: 0; flex: 0 1 auto; }
  .pill .lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
  .pill.mode { flex-shrink: 0; }
  .icon, .send { flex-shrink: 0; }
  .pill:hover { background: var(--bg-tertiary); }
  .pill.mode { background: var(--bg-secondary); }
  .pill.mode.plan { background: color-mix(in srgb, var(--amber) 24%, transparent); color: var(--amber); }
  .pill .chev { font-size: 9px; opacity: .7; }
  .pill.model, .pill.access { color: var(--text-secondary); }
  .pill.model:hover, .pill.access:hover { color: var(--fg); }
  .spacer { flex: 1 1 0; min-width: 4px; }
  .icon { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-base); color: var(--fg); cursor: pointer; }
  .icon:hover { background: var(--bg-tertiary); }
  .icon svg { width: 16px; height: 16px; }
  .send { background: var(--fg); color: var(--vscode-editor-background); border-radius: 9999px; width: 24px; height: 24px; display: none; align-items: center; justify-content: center; cursor: pointer; }
  body.dirty .send, body.stage .send { display: inline-flex; } body.running .send { display: none; }
  .pill, .icon, .tab, .menu .item, .menu .row, .h, .send, .stopbtn { transition: background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .menu { position: fixed; top: 0; left: 0; visibility: hidden; min-width: min(220px, calc(100vw - 16px)); max-width: min(320px, calc(100vw - 16px)); max-height: min(320px, calc(100vh - 16px)); overflow: auto; overscroll-behavior: contain; background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background)); border: 1px solid var(--stroke-secondary); border-radius: var(--radius-lg); box-shadow: 0 0 0 1px var(--vscode-widget-border, var(--stroke-secondary)), 0 2px 8px var(--vscode-widget-shadow, #00000066); padding: 4px; z-index: 20; display: none; font-size: var(--fs-base); }
  .menu.open { display: block; visibility: visible; }
  .menu .group { padding: 6px 10px 2px; font-size: var(--fs-xs); color: var(--text-tertiary); text-transform: uppercase; letter-spacing: .3px; }
  .menu .item { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-radius: var(--radius-sm); cursor: pointer; }
  .menu .item:hover, .menu .item.sel { background: var(--bg-tertiary); }
  /* Cursor's typeahead popover: 300px, 2px padding, 24px rows (12px text, 2px 6px padding), path right-aligned and truncated from the left, matches highlighted. */
  .cod { font-family: codicon; font-size: 14px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: 0 0 auto; color: var(--text-secondary); }
  .menu.typeahead { width: min(300px, calc(100vw - 16px)); min-width: min(300px, calc(100vw - 16px)); max-width: min(300px, calc(100vw - 16px)); padding: 2px; border-radius: 6px; box-shadow: 0 5px 10px rgba(0, 0, 0, .3); }
  .menu .title { padding: 4px 6px 2px; font-size: 11px; line-height: 15px; color: var(--vscode-input-placeholderForeground); text-transform: uppercase; letter-spacing: .4px; }
  .menu .row { display: flex; align-items: center; gap: 6px; height: 24px; padding: 2px 6px; box-sizing: border-box; border-radius: 4px; font-size: 12px; line-height: 20px; cursor: pointer; }
  .menu .row.sel { background: var(--bg-tertiary); color: var(--fg); }
  .menu .row .text { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fg); }
  .menu .row .secondary { flex: 0 1 45%; min-width: 0; direction: rtl; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-tertiary); font-size: 12px; }
  .menu .ic.slash, .menu .row > .cod { width: 16px; flex: 0 0 16px; }
  .menu .row .hl { color: var(--vscode-list-highlightForeground); font-weight: 600; }
  .menu .row .chev { margin-left: auto; color: var(--text-tertiary); } .menu .row .secondary + .chev { margin-left: 0; }
  .menu .back { display: flex; align-items: center; gap: 4px; height: 24px; padding: 2px 6px; box-sizing: border-box; font-size: 12px; color: var(--text-secondary); cursor: pointer; border-bottom: 1px solid var(--stroke-tertiary); margin-bottom: 2px; }
  .menu .ic.badge { font-size: 9px; font-weight: 700; letter-spacing: .2px; line-height: 14px; height: 14px; min-width: 18px; padding: 0 3px; border-radius: 3px; text-align: center; background: color-mix(in srgb, var(--badge, #8b949e) 22%, transparent); color: var(--badge, #8b949e); flex: 0 0 auto; }
  .menu .ic.slash { width: 16px; text-align: center; color: var(--amber); font-weight: 600; }
  .menu .item.sel .lbl { color: var(--fg); }
  .menu .item .ic { width: 16px; text-align: center; color: var(--text-secondary); }
  .menu .item .lbl { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu .item .sub { color: var(--text-tertiary); font-size: var(--fs-xs); margin-left: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; flex: 0 1 45%; min-width: 0; }
  .menu .item.mode .lbl { flex: 0 0 auto; }
  .menu .item .check { width: 14px; color: var(--fg); visibility: hidden; }
  .menu .item.on .check { visibility: visible; }
  .menu .item .kbd { color: var(--text-tertiary); font-size: var(--fs-xs); }
  .menu .item.mode { align-items: flex-start; padding: 6px 10px; }
  .menu .item .two { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .menu .item .desc { color: var(--text-tertiary); font-size: var(--fs-xs); line-height: 16px; white-space: normal; }
  .menu.wide { min-width: 300px; max-width: 360px; }
  .menu .sep { border-top: 1px solid var(--stroke-tertiary); margin: 4px 0; }
  .menu .note { padding: 6px 10px; color: var(--text-tertiary); font-size: var(--fs-xs); }
  #history { padding: 4px 10px 10px; gap: 6px; }
  #hsearch { height: 30px; border: 1px solid var(--stroke-secondary); border-radius: var(--radius-lg); background: var(--vscode-input-background); color: var(--fg); padding: 0 10px; font: inherit; font-size: var(--fs-base); outline: none; }
  #hlist { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
  .h { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--radius-base); cursor: pointer; }
  .h:hover { background: var(--bg-quaternary); }
  .h .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-base); }
  .h .meta { color: var(--text-tertiary); font-size: var(--fs-xs); white-space: nowrap; }
  .h .pin { color: var(--text-tertiary); width: 18px; text-align: center; visibility: hidden; }
  .h .hacts { display: none; gap: 2px; margin-left: auto; } .h:hover .hacts { display: inline-flex; } .h .hb { width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; color: var(--text-tertiary); cursor: pointer; } .h .hb:hover { color: var(--fg); background: var(--bg-tertiary); } .h .hb .cod { font-size: 12px; width: 12px; height: 12px; }
  .h:hover .pin, .h.pinned .pin { visibility: visible; } .h.pinned .pin { color: var(--amber); }
  .live { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-green); display: inline-block; }
  .hsec { color: var(--text-tertiary); font-size: var(--fs-xs); padding: 8px 8px 2px; text-transform: uppercase; letter-spacing: .3px; }
  #board { padding: 4px 10px 10px; gap: 8px; }
  #bcols { flex: 1; display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 8px; overflow: auto; }
  .col { border: 1px solid var(--stroke-tertiary); border-radius: var(--radius-lg); background: var(--bg-quinary); display: flex; flex-direction: column; min-height: 120px; }
  .col .ct { padding: 6px 10px; font-size: var(--fs-xs); color: var(--text-tertiary); text-transform: uppercase; letter-spacing: .3px; display: flex; gap: 6px; }
  .col .cards { padding: 0 6px 6px; display: flex; flex-direction: column; gap: 6px; }
  .kcard { border: 1px solid var(--stroke-tertiary); border-radius: var(--radius-base); background: var(--vscode-editor-background); padding: 6px 8px; font-size: var(--fs-base); cursor: pointer; }
  .kcard:hover { border-color: var(--stroke-primary); }
  .kcard .sub { color: var(--text-tertiary); font-size: var(--fs-xs); display: flex; align-items: center; gap: 6px; margin-top: 2px; }
  .kcard .acts { display: none; gap: 4px; margin-top: 6px; } .kcard:hover .acts { display: flex; }
  .kcard .acts .btn { height: 20px; padding: 0 6px; font-size: var(--fs-xs); background: var(--bg-tertiary); }
  #badd { height: 30px; border: 1px solid var(--stroke-secondary); border-radius: var(--radius-lg); background: var(--vscode-input-background); color: var(--fg); padding: 0 10px; font: inherit; font-size: var(--fs-base); outline: none; }
${polishStyles}
</style></head>
<body data-view="chat">
  <div id="tabs"></div>
  <div class="view" id="chat">
    <div id="messages"></div>
    <div id="redo"><button title="Restore edits to the latest checkpoint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 8v5h-5"/><path d="M19 13a8 8 0 1 1-2.3-5.7L20 10"/></svg><span>Redo checkpoint</span></button></div>
    <div id="review"><div class="head" id="review-head"><span class="chev">▶</span><span id="review-summary">1 file</span><span class="adds" id="review-adds">+0</span><span class="dels" id="review-dels">−0</span><span class="spacer"></span><button class="btn text" id="review-open" title="Review Changes editor">Review</button><button class="btn text" id="review-reject">Reject</button><button class="btn primary" id="review-accept">Accept</button></div><div class="files" id="review-files"></div></div>
    <div id="queue"></div>
    <div id="status"><span>Generating..</span><span class="stop" id="stop">Stop<kbd>⇧⌘⌫</kbd></span></div>
    <div id="composer">
      <div class="ctxrow" id="ctxrow"><span class="ctx add" id="ctx-add" title="Add context (@)"><span class="cod"></span>Add Context</span></div>
      <div class="inputwrap"><div id="backdrop"></div><textarea id="input" placeholder="Plan, search, build anything" rows="1"></textarea></div>
      <div class="bar">
        <span class="pill mode" id="mode-pill"><span id="mode-icon">∞</span><span class="lbl" id="mode-name">Agent</span><kbd class="mode-kbd">⌘I</kbd><span class="chev">▼</span></span>
        <span class="pill access" id="access-pill" title="Access"><span class="lbl" id="access-name">…</span><span class="chev">▼</span></span>
        <span class="pill model" id="model-pill" title="Model"><span class="lbl" id="model-name">…</span><span class="chev">▼</span></span>
        <span class="spacer"></span>
        <span class="icon" title="Attach image" id="attach"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.5l-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.3-8.3"/></svg></span>
        <span class="icon" title="Dictate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></span>
        <span class="send" id="send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="14" height="14"><path d="M12 19V5M5 12l7-7 7 7"/></svg></span>
      </div>
    </div>
  </div>
  <div class="menu" id="menu"></div>
  <div id="toast" role="status" aria-live="polite" hidden></div>
  <div id="img-lightbox" hidden><div class="lb-backdrop"></div><img alt=""></div>
  <div class="view" id="browserpane">
    <div class="bbar"><button class="bbtn" data-act="back" title="Back">←</button><button class="bbtn" data-act="forward" title="Forward">→</button><button class="bbtn" data-act="reload" title="Reload ⌘R">⟳</button><input id="burl" placeholder="Enter a URL"><button class="bbtn" id="bpick" data-act="pick" title="Select an element for the chat">⌖</button><button class="bbtn" data-act="screenshot" title="Screenshot to chat">⧉</button><button class="bbtn" id="bstar" title="Bookmark">☆</button><button class="bbtn" id="bdevtools" title="DevTools">⚙</button></div>
    <div class="bbookmarks" id="bbookmarks"></div>
    <div class="bcert" id="bcert" hidden><span class="msg"></span><button class="btn text">Proceed anyway</button></div>
    <div id="bhost"></div>
    <div class="bsections"><div class="bstabs"><span class="bstab on" data-sec="console">Console <span id="bconsole-count" class="cnt"></span></span><span class="bstab" data-sec="selected">Selected</span><span class="bstab" data-sec="page">Page</span><span class="bstab" data-sec="changes">Changes <span id="bchanges-count" class="cnt"></span></span><span class="bdriving" id="bdriving" hidden><span class="dot"></span>Agent is browsing<button class="btn text" id="btake">Take control</button></span><span class="spacer"></span><button class="btn text" id="bclear">Clear</button><button class="btn primary" id="btochat">Add to chat</button></div><div class="bsbody" id="bsbody"></div></div>
  </div>
  <div class="view" id="history"><input id="hsearch" placeholder="Search threads"><div id="hlist"></div></div>
  <div class="view" id="board"><input id="badd" placeholder="Add a task to the board and press Enter"><div id="bcols"></div></div>
<script>const vscode = acquireVsCodeApi(); vscode.postMessage({ type: "boot" }); window.addEventListener("error", (e) => vscode.postMessage({ type: "clientError", message: String(e.message) + " @" + e.lineno + ":" + e.colno }));</script>
<script>
  window.addEventListener("error", (e) => { vscode.postMessage({ type: "clientError", message: String(e.message) + " @" + e.lineno + ":" + e.colno }); if (typeof setRunState === "function") setRunState("disconnected", "Webview error"); });
  window.addEventListener("unhandledrejection", (e) => { vscode.postMessage({ type: "clientError", message: "unhandled: " + String(e.reason) }); if (typeof setRunState === "function") setRunState("disconnected", "Webview error"); });
  const $ = (id) => document.getElementById(id);
  const messages = $("messages"), input = $("input"), body = document.body, menu = $("menu");
  let assistantEl = null, thinkingEl = null, planEl = null, state = null, threads = [], thinkingStartedAt = 0, thinkingTick = null, exploreLifecycleHooked = false;
  const ICONS = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/></svg>',
    board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    max: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/></svg>',
  };
  ${MARKDOWN_RENDER_SCRIPT}
  messages.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]"); if (b) { const text = b.parentElement?.nextElementSibling?.textContent || ""; Promise.resolve(navigator.clipboard?.writeText(text)).catch(() => { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch {} ta.remove(); }).finally(() => { b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); }); return; }
    const ap = e.target.closest("[data-apply]"); if (ap) { const block = ap.closest(".code"); vscode.postMessage({ type: "applyBlock", path: block.dataset.path, lang: block.dataset.lang, code: block.querySelector("pre").textContent }); ap.textContent = "Applying…"; return; }
    const ins = e.target.closest("[data-insert]"); if (ins) { const block = ins.closest(".code"); vscode.postMessage({ type: "insertBlock", code: block.querySelector("pre").textContent }); return; }
    const f = e.target.closest("a.file"); if (f) { e.preventDefault(); vscode.postMessage({ type: "openPath", path: f.dataset.path, line: f.dataset.line ? Number(f.dataset.line) : undefined, endLine: f.dataset.end ? Number(f.dataset.end) : undefined }); }
    const thumb = e.target.closest(".human-thumb, .ctx-thumb, img.md-img"); if (thumb) { e.preventDefault(); openLightbox(thumb.getAttribute("src") || thumb.getAttribute("data-src") || ""); }
  });
  const lightbox = $("img-lightbox");
  function openLightbox(src) { if (!src || !lightbox) return; const img = lightbox.querySelector("img"); img.src = src; lightbox.hidden = false; lightbox.classList.add("open"); }
  function closeLightbox() { if (!lightbox) return; lightbox.hidden = true; lightbox.classList.remove("open"); const img = lightbox.querySelector("img"); img.removeAttribute("src"); }
  if (lightbox) { lightbox.querySelector(".lb-backdrop").addEventListener("click", closeLightbox); document.addEventListener("keydown", (e) => { if (e.key === "Escape" && lightbox.classList.contains("open")) closeLightbox(); }); }
  function scroll(force = false) { if (!force && typeof following !== "undefined" && following === false) { if (typeof jump !== "undefined") jump.hidden = false; return; } if (force || typeof following === "undefined" || following) { messages.scrollTop = messages.scrollHeight; if (typeof following !== "undefined") following = true; if (typeof jump !== "undefined") jump.hidden = true; } else if (typeof jump !== "undefined") jump.hidden = false; }
  function parseImageTokens(text) {
    const images = [];
    const visible = String(text || "").replace(/(^|\\s)(@image:[^\\s]+)/g, function (_, sp, tok) { images.push(tok); return sp; }).replace(/[ \\t]{2,}/g, " ").trim();
    return { visible, images };
  }
  function imagePath(token) {
    let body = String(token || "").replace(/^@/, "");
    try { body = decodeURIComponent(body); } catch {}
    return body.replace(/^image:/, "");
  }
  function imageKey(src) {
    let s = String(src || "").trim();
    try { s = decodeURIComponent(s); } catch {}
    s = s.replace(/^image:/, "");
    if (s.toLowerCase().indexOf("file://") === 0) s = s.slice(7);
    return s.replace(/^["']|["']$/g, "");
  }
  const THUMB_PLACEHOLDER = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="%23282828"/></svg>');
  function attachThumb(img, token) {
    const src = imageKey(imagePath(token)); img.setAttribute("data-src", src); img.setAttribute("data-pending", "1"); img.alt = src.split("/").pop() || "image";
    img.src = THUMB_PLACEHOLDER;
    vscode.postMessage({ type: "resolveImage", src: src });
  }
  function rehydrateTranscriptImages() {
    document.querySelectorAll("img.human-thumb, img.ctx-thumb").forEach((img) => {
      const src = imageKey(img.getAttribute("data-src") || "");
      if (!src) return;
      img.setAttribute("data-src", src);
      if (!img.getAttribute("src") || img.getAttribute("src") === THUMB_PLACEHOLDER) img.src = THUMB_PLACEHOLDER;
      img.setAttribute("data-pending", "1");
      vscode.postMessage({ type: "resolveImage", src: src });
    });
  }
  let composerImages = [];
  function buildHuman(text, checkpoint, steer) {
    const el = document.createElement("div"); el.className = "human" + (steer ? " steer" : ""); if (checkpoint) el.dataset.checkpoint = checkpoint;
    el.dataset.raw = text;
    const parsed = parseImageTokens(text);
    if (parsed.images.length) {
      el.classList.add("has-images");
      const strip = document.createElement("div"); strip.className = "human-images";
      for (const tok of parsed.images) { const img = document.createElement("img"); img.className = "human-thumb"; attachThumb(img, tok); strip.appendChild(img); }
      el.appendChild(strip);
    }
    const span = document.createElement("span"); span.className = "txt"; span.textContent = parsed.visible; el.appendChild(span);
    const expand = document.createElement("button"); expand.className = "expand-message"; expand.textContent = "Show full message"; expand.hidden = true; expand.setAttribute("aria-expanded", "false");
    expand.onclick = () => { const open = el.classList.toggle("expanded"); expand.textContent = open ? "Show less" : "Show full message"; expand.setAttribute("aria-expanded", String(open)); persistView(); }; el.appendChild(expand);
    if (checkpoint && !steer) {
      const tools = document.createElement("div"); tools.className = "tools";
      const edit = document.createElement("button"); edit.title = "Edit message"; edit.setAttribute("aria-label", "Edit message"); edit.innerHTML = cod("edit");
      edit.addEventListener("click", (e) => { e.stopPropagation(); startEdit(el, text, checkpoint, steer); });
      const restore = document.createElement("button"); restore.className = "restore"; restore.title = "Restore checkpoint"; restore.setAttribute("aria-label", "Restore checkpoint"); restore.innerHTML = cod("reply");
      restore.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "restore", id: checkpoint }); });
      tools.append(edit, restore); el.appendChild(tools);
      span.addEventListener("dblclick", () => startEdit(el, text, checkpoint, steer));
    }
    return el;
  }
  function startEdit(el, text, checkpoint, steer) {
    if (el.classList.contains("editing")) return;
    el.classList.add("editing"); el.classList.remove("clipped"); el.innerHTML = "";
    const ta = document.createElement("textarea"); ta.className = "edit"; ta.value = text;
    const bar = document.createElement("div"); bar.className = "editbar"; bar.innerHTML = '<span>⏎ resend · esc cancel · the workspace goes back to this point</span>';
    el.append(ta, bar); ta.focus(); ta.setSelectionRange(text.length, text.length);
    ta.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); vscode.postMessage({ type: "editMessage", checkpoint, text: ta.value }); } else if (e.key === "Escape") { el.replaceWith(buildHuman(text, checkpoint, steer)); } });
  }
  function addHuman(text, checkpoint, steer) { const el = buildHuman(text, checkpoint, steer); messages.appendChild(el); if (el.querySelector(".txt").scrollHeight > 140 || text.length > 600 || text.split("\\n").length > 7) { el.classList.add("clipped"); el.querySelector(".expand-message").hidden = false; } body.classList.add("has-messages"); scroll(); }
  function renderQueue(list) { const q = $("queue"); if (!q) return; q.innerHTML = ""; q.classList.toggle("has", list.length > 0); list.forEach((t, i) => { const row = document.createElement("div"); row.className = "q"; row.innerHTML = '<span class="lbl">Queued</span><span class="txt"></span><span class="x" title="Remove">×</span>'; row.querySelector(".txt").textContent = t; row.querySelector(".x").addEventListener("click", () => vscode.postMessage({ type: "dropQueued", index: i })); q.appendChild(row); }); }
  function ensureAssistantBody(el) {
    let bodyEl = el.querySelector(".assistant-body");
    if (!bodyEl) {
      bodyEl = document.createElement("div"); bodyEl.className = "assistant-body";
      while (el.firstChild) bodyEl.appendChild(el.firstChild);
      el.appendChild(bodyEl);
    }
    return bodyEl;
  }
  function addAssistant(text) { const el = document.createElement("div"); el.className = "assistant"; el.dataset.raw = text; ensureAssistantBody(el).innerHTML = renderMarkdown(text); messages.appendChild(el); body.classList.add("has-messages"); return el; }
  function decorateAssistant(el) {
    if (!el || el.querySelector(".msg-acts")) return;
    ensureAssistantBody(el);
    const acts = document.createElement("div"); acts.className = "msg-acts";
    const copy = document.createElement("button"); copy.className = "act"; copy.title = "Copy"; copy.setAttribute("aria-label", "Copy"); copy.innerHTML = cod("copy");
    copy.addEventListener("click", (e) => { e.stopPropagation(); const text = el.dataset.raw || el.textContent || ""; Promise.resolve(navigator.clipboard?.writeText(text)).catch(() => { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch {} ta.remove(); }).finally(() => { copy.title = "Copied"; setTimeout(() => (copy.title = "Copy"), 1000); }); });
    const fork = document.createElement("button"); fork.className = "act"; fork.title = "Fork chat"; fork.setAttribute("aria-label", "Fork chat"); fork.innerHTML = cod("git-fork");
    fork.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "command", id: "muster.thread.fork" }); });
    acts.append(copy, fork); el.appendChild(acts);
  }
  function ensureAssistant() { finishThinking(); if (!assistantEl) assistantEl = addAssistant(""); return assistantEl; }
  function nowMs() { return (typeof performance !== "undefined" && typeof performance.now === "function") ? performance.now() : Date.now(); }
  function formatThoughtSeconds(ms) { const sec = Math.max(1, Math.round(Math.max(0, ms) / 1000)); return sec + "s"; }
  function formatToolDuration(ms) {
    if (typeof ms !== "number" || ms < 0) return "";
    if (ms >= 1000) return (ms / 1000).toFixed(ms >= 10_000 ? 0 : 1).replace(/\\.0$/, "") + "s";
    return ms + "ms";
  }
  function thinkingDuration() { return thinkingStartedAt ? formatThoughtSeconds(nowMs() - thinkingStartedAt) : "1s"; }
  function stopThinkingTick() { if (thinkingTick) { clearInterval(thinkingTick); thinkingTick = null; } }
  function syncThinkingDur() {
    if (!thinkingEl || !thinkingEl.classList.contains("streaming")) return;
    const dur = thinkingEl.querySelector(".dur"); if (dur) dur.textContent = thinkingDuration();
  }
  function startThinkingTick() { stopThinkingTick(); syncThinkingDur(); thinkingTick = setInterval(syncThinkingDur, 400); }
  function thinkingMarkup() { return "<summary><span class=pulse></span><span class=think-glyph></span><span class=chev></span><span class=label></span><span class=dur></span></summary><div class=reveal><div class=ticker><div class=body></div></div></div>"; }
  function setThinkingBody(el, text) {
    const bodyEl = el.querySelector(".body"); if (!bodyEl) return;
    const streaming = el.classList.contains("streaming");
    const raw = String(text || "");
    if (!streaming) {
      if (typeof renderMarkdown === "function") bodyEl.innerHTML = renderMarkdown(raw); else bodyEl.textContent = raw;
      return;
    }
    const chunks = raw.replace(/\\s+$/, "").split(/\\n/);
    const last = chunks[chunks.length - 1] || "";
    const older = chunks.slice(0, -1).join("\\n");
    const grewLine = (bodyEl.dataset.shown || "").split("\\n").length < chunks.length;
    bodyEl.dataset.shown = raw;
    let prev = bodyEl.querySelector(".think-prev"); let line = bodyEl.querySelector(".think-line");
    if (!prev) { prev = document.createElement("div"); prev.className = "think-prev"; }
    if (!line) { line = document.createElement("div"); line.className = "think-line"; }
    if (prev.parentNode !== bodyEl) { bodyEl.replaceChildren(prev, line); }
    prev.textContent = older; prev.hidden = !older;
    line.textContent = last;
    if (grewLine) { line.classList.remove("think-rise"); void line.offsetWidth; line.classList.add("think-rise"); }
    const ticker = el.querySelector(".ticker"); if (ticker) ticker.scrollTop = ticker.scrollHeight;
  }
  function finishThinking() {
    if (!thinkingEl || thinkingEl.classList.contains("done")) return;
    stopThinkingTick();
    thinkingEl.classList.add("done"); thinkingEl.classList.remove("streaming"); thinkingEl.open = false;
    const label = thinkingEl.querySelector(".label"); const dur = thinkingEl.querySelector(".dur");
    if (label) label.textContent = "Thought"; if (dur) dur.textContent = thinkingDuration();
    setThinkingBody(thinkingEl, thinkingEl.dataset.raw || "");
  }
  function closeExploreGroup() {
    messages.querySelectorAll(".tool-group.collecting").forEach((g) => {
      g.classList.remove("collecting");
      const label = g.querySelector(".g-label");
      if (label) label.textContent = exploreLabel(g);
    });
  }
  function hookTranscriptLifecycle() {
    if (exploreLifecycleHooked) return; exploreLifecycleHooked = true;
    window.addEventListener("message", (event) => {
      const m = event.data; if (!m || typeof m !== "object") return;
      if (m.type === "delta" || m.type === "tool" || m.type === "done") finishThinking();
      if (m.type === "delta" || m.type === "approval" || m.type === "user" || m.type === "done") closeExploreGroup();
      if (m.type === "user" || m.type === "done") thinkingStartedAt = 0;
    }, true);
  }
  function ensureThinking() {
    hookTranscriptLifecycle();
    const live = thinkingEl && !thinkingEl.classList.contains("done");
    let resume = false;
    if (thinkingEl && thinkingEl.classList.contains("done")) {
      resume = true;
      for (let n = thinkingEl.nextElementSibling; n; n = n.nextElementSibling) {
        if (n.classList.contains("tool") || n.classList.contains("tool-group")) { resume = false; break; }
      }
    }
    if (live || resume) {
      thinkingEl.classList.add("streaming"); thinkingEl.classList.remove("done"); thinkingEl.open = true;
      thinkingStartedAt = nowMs();
      if (!thinkingEl.dataset.raw) thinkingEl.dataset.raw = ((thinkingEl.querySelector(".body") || {}).textContent) || "";
      const label = thinkingEl.querySelector(".label");
      if (label) label.textContent = resume ? "Planning next moves" : "Thinking";
      startThinkingTick();
      return thinkingEl;
    }
    const hadWork = !!messages.querySelector(".tool, .tool-group");
    thinkingEl = document.createElement("details"); thinkingEl.className = "thinking streaming stream-in"; thinkingEl.open = true;
    thinkingEl.innerHTML = thinkingMarkup();
    thinkingEl.querySelector(".label").textContent = hadWork ? "Planning next moves" : "Thinking";
    thinkingStartedAt = nowMs(); messages.appendChild(thinkingEl); startThinkingTick();
    return thinkingEl;
  }
  function isExploreTool(tool) {
    if (!tool || typeof tool !== "object") return false;
    const kind = String(tool.tool || "").toLowerCase();
    if (kind === "read" || kind === "search" || kind === "grep" || kind === "list" || kind === "glob") return true;
    return /^(rg |grep |cat |sed -n|ls |find |head |tail |bat )/i.test(String(tool.detail || "").trim());
  }
  function exploreKind(tool) {
    const kind = String(tool.tool || "").toLowerCase();
    const detail = String(tool.detail || "").trim();
    if (kind === "grep" || /^(rg |grep )/i.test(detail)) return "grep";
    if (kind === "read" || /^(cat |sed -n|head |tail |bat )/i.test(detail)) return "read";
    if (kind === "list" || /^(ls |find )/i.test(detail)) return "list";
    if (kind === "glob" || kind === "search") return "search";
    return kind || "read";
  }
  function exploreVerb(kind, running) {
    const map = { grep: ["Grepping", "Grepped"], read: ["Reading", "Read"], search: ["Searching", "Searched"], list: ["Listing", "Listed"], glob: ["Searching", "Searched"] };
    const pair = map[kind] || ["Working", "Done"];
    return running ? pair[0] : pair[1];
  }
  function exploreEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function exploreFileName(p) { return String(p || "").replace(/^["']|["']$/g, "").split("/").pop() || String(p || ""); }
  function prettyExploreDetail(tool) {
    const d = String(tool.detail || "").trim();
    let m = /sed -n ['"]?(\\d+),(\\d+)p['"]?\\s+(\\S+)/i.exec(d);
    if (m) return exploreFileName(m[3]) + " L" + m[1] + "-" + m[2];
    m = /^(?:cat|bat|head|tail)\\s+(\\S+)/i.exec(d);
    if (m) return exploreFileName(m[1]);
    m = /^(?:rg|grep)\\s+(?:-[A-Za-z]+\\s+)*(.+?)(?:\\s+(\\S+))?$/i.exec(d);
    if (m) { const pat = m[1].replace(/^["']|["']$/g, ""); return m[2] ? pat + " in " + exploreFileName(m[2]) : pat; }
    const tail = d.split("/").pop();
    return tail || d;
  }
  function prettyExploreDetailHtml(tool) {
    const d = String(tool.detail || "").trim();
    const xp = (p) => '<span class="xp">' + exploreEsc(exploreFileName(p)) + '</span>';
    const xr = (a, b) => ' <span class="xr">L' + exploreEsc(a) + '-' + exploreEsc(b) + '</span>';
    let m = /sed -n ['"]?(\\d+),(\\d+)p['"]?\\s+(\\S+)/i.exec(d);
    if (m) return xp(m[3]) + xr(m[1], m[2]);
    m = /^(?:cat|bat|head|tail)\\s+(\\S+)/i.exec(d);
    if (m) return xp(m[1]);
    m = /^(?:rg|grep)\\s+(?:-[A-Za-z]+\\s+)*(.+?)(?:\\s+(\\S+))?$/i.exec(d);
    if (m) { const pat = m[1].replace(/^["']|["']$/g, ""); return '<span class="xk">' + exploreEsc(pat) + '</span>' + (m[2] ? ' in ' + xp(m[2]) : ''); }
    return exploreEsc(prettyExploreDetail(tool));
  }
  function exploreFullPath(detail) {
    const d = String(detail || "").trim();
    let m = /sed -n ['"]?(\\d+),(\\d+)p['"]?\\s+(\\S+)/i.exec(d);
    if (m) return m[3].replace(/^["']|["']$/g, "");
    m = /^(?:cat|bat|head|tail)\\s+(\\S+)/i.exec(d);
    if (m) return m[1].replace(/^["']|["']$/g, "");
    m = /^(?:rg|grep)\\s+(?:-[A-Za-z]+\\s+)*.+\\s+(\\S+)\\s*$/i.exec(d);
    if (m) return m[1].replace(/^["']|["']$/g, "");
    return d;
  }
  function explorePopoverHtml(detail, output) {
    const out = String(output || "").trim();
    const paths = [];
    if (out) {
      for (const line of out.split(/\\n/)) {
        const t = line.trim(); if (!t) continue;
        const hit = /^([^:]+):\\d+/.exec(t);
        if (hit) paths.push(hit[1]);
        else if (t.length < 240 && !/^\\s*$/.test(t)) paths.push(t);
        if (paths.length >= 12) break;
      }
    }
    if (!paths.length) {
      const full = exploreFullPath(detail);
      if (full) paths.push(full);
    }
    const seen = new Set();
    const uniq = paths.filter((p) => { if (seen.has(p)) return false; seen.add(p); return true; });
    return uniq.slice(0, 10).map((p) => {
      const base = exploreFileName(p);
      const prefix = p.length > base.length ? exploreEsc(p.slice(0, p.length - base.length)) : "";
      return '<div class="ep">' + prefix + '<span class="xp">' + exploreEsc(base) + '</span></div>';
    }).join("");
  }
  function ensureExplorePopover(el) {
    let pop = el.querySelector(".explore-pop");
    if (!pop) {
      pop = document.createElement("div"); pop.className = "explore-pop"; pop.hidden = true; el.appendChild(pop);
      const head = el.querySelector(".head");
      head.addEventListener("mouseenter", () => {
        const html = explorePopoverHtml(el.dataset.toolDetail || "", el.dataset.toolOutput || "");
        if (!html) { pop.hidden = true; return; }
        pop.innerHTML = html; pop.hidden = false;
      });
      head.addEventListener("mouseleave", () => { pop.hidden = true; });
    }
    return pop;
  }
  function commandBits(detail) {
    const names = []; const raw = " " + String(detail || "");
    const re = /(?:^|[;&|\\n]|&&|\\|\\|)\\s*([A-Za-z][\\w.-]*)/g; let m;
    while ((m = re.exec(raw)) && names.length < 8) { if (!/^(then|do|fi|exit|true|false)$/.test(m[1])) names.push(m[1]); }
    return names;
  }
  function exploreLabel(group) {
    const tools = [...group.querySelectorAll(".card.tool")];
    let files = 0, searches = 0;
    for (const el of tools) {
      const kind = ((el.className.match(/\\b(read|search|grep|list|glob)\\b/) || [])[1] || "");
      const cmd = ((el.querySelector(".cmd") || {}).textContent || "");
      if (kind === "search" || kind === "grep" || kind === "glob" || /^rg /i.test(cmd)) searches++; else files++;
    }
    if (!group.classList.contains("collecting")) {
      if (files === 1 && searches === 0) return "Read 1 file";
      if (files === 0 && searches === 1) return "Searched 1 search";
    }
    const parts = [];
    if (files) parts.push(files + (files === 1 ? " file" : " files"));
    if (searches) parts.push(searches + (searches === 1 ? " search" : " searches"));
    return (group.classList.contains("collecting") ? "Exploring " : "Explored ") + (parts.join(", ") || "…");
  }
  function ensureExploreGroup() {
    const last = messages.lastElementChild;
    if (last && last.classList.contains("tool-group") && last.classList.contains("collecting")) return last;
    closeExploreGroup();
    const g = document.createElement("div"); g.className = "card tool-group collecting open";
    g.innerHTML = '<div class="head" role="button" tabindex="0"><span class="chev"></span><span class="g-label"></span></div><div class="reveal"><div class="group-body"></div></div>';
    const head = g.querySelector(".head");
    head.addEventListener("mousedown", (e) => e.preventDefault());
    head.addEventListener("click", () => g.classList.toggle("open"));
    head.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); head.click(); } };
    messages.appendChild(g); return g;
  }
  // Cursor's tool rows: "Running…" while live, then "Ran" (exit 0) / "Exit 1" / "Skipped", duration, output on click.
  function toolEl(tool) {
    if (!tool || typeof tool !== "object" || !tool.id) return;
    hookTranscriptLifecycle();
    let el = document.getElementById("tool-" + tool.id);
    if (!el) {
      el = document.createElement("div");
      const explore = isExploreTool(tool);
      const kind = explore ? exploreKind(tool) : String(tool.tool || "");
      el.className = "card tool stream-in" + (kind ? " " + kind : "") + (explore ? " line" : "") + (!explore && tool.tool === "command" ? " command" : "");
      el.id = "tool-" + tool.id;
      el.innerHTML = '<div class="head"><span class="ic"></span><span class="t"></span><span class="cmd"></span><span class="line-dur"></span><span class="more" title="More">⋯</span><span class="status"></span><span class="spin"></span></div><pre></pre>';
      el.querySelector(".head").setAttribute("role", "button"); el.querySelector(".head").tabIndex = 0; el.querySelector(".head").setAttribute("aria-label", "Expand tool details");
      el.querySelector(".head").addEventListener("mousedown", (e) => e.preventDefault());
      el.querySelector(".head").addEventListener("click", () => { el.classList.toggle("open"); el.querySelector(".head").setAttribute("aria-expanded", String(el.classList.contains("open"))); });
      el.querySelector(".head").onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); el.querySelector(".head").click(); } };
      el.querySelector(".ic").innerHTML = (!explore && tool.tool === "command") ? '<span class="prompt-ic">&gt;_</span>' : cod(kind === "search" || kind === "grep" ? "search" : kind === "read" ? "file" : "plug");
      if (explore) { ensureExplorePopover(el); const g = ensureExploreGroup(); g.querySelector(".group-body").appendChild(el); g.querySelector(".g-label").textContent = exploreLabel(g); }
      else { closeExploreGroup(); messages.appendChild(el); }
      body.classList.add("has-messages");
    }
    const running = tool.status === "running" || tool.status === "inProgress";
    if (running && !el.dataset.startedAt) el.dataset.startedAt = String(nowMs());
    if (!running && el.dataset.startedAt && typeof tool.durationMs !== "number") {
      tool.durationMs = Math.max(0, Math.round(nowMs() - Number(el.dataset.startedAt)));
      delete el.dataset.startedAt;
    }
    const failed = tool.status === "failed" || (typeof tool.exitCode === "number" && tool.exitCode !== 0);
    const explore = isExploreTool(tool);
    const kind = explore ? exploreKind(tool) : String(tool.tool || "");
    const generic = /^(Ran|Running|Failed|Skipped|Called|Calling|Searched|Searching|Read|Reading|Grepped|Grepping|Listed|Listing)$/;
    const bits = !explore && tool.tool === "command" ? commandBits(tool.detail) : [];
    const title = explore ? exploreVerb(kind, running) : (tool.tool === "command" ? (running ? "Running" : tool.status === "declined" ? "Skipped" : failed ? "Failed" : "Ran") : (tool.title && !generic.test(tool.title)) ? tool.title : (running ? "Calling" : "Called"));
    const dur = formatToolDuration(typeof tool.durationMs === "number" ? tool.durationMs : undefined);
    el.classList.toggle("running", running); el.classList.toggle("failed", failed); if (!failed) el.classList.remove("open");
    el.querySelector(".t").textContent = title;
    const cmdEl = el.querySelector(".cmd");
    if (explore) {
      el.dataset.toolDetail = tool.detail || "";
      el.dataset.toolOutput = tool.output || "";
      cmdEl.innerHTML = prettyExploreDetailHtml(tool);
      ensureExplorePopover(el);
      const lineDur = el.querySelector(".line-dur"); if (lineDur) lineDur.textContent = running ? "" : dur;
    } else {
      cmdEl.textContent = tool.detail || bits.join(", ");
      const lineDur = el.querySelector(".line-dur"); if (lineDur) lineDur.textContent = "";
    }
    cmdEl.title = (tool.cwd ? tool.cwd + " $ " : "") + (tool.detail || "");
    el.querySelector(".status").textContent = running ? "" : [typeof tool.exitCode === "number" && tool.exitCode !== 0 ? "exit " + tool.exitCode : "", explore ? "" : dur].filter(Boolean).join(" · ");
    el.querySelector("pre").textContent = tool.output || ""; if (failed && tool.output) el.classList.add("open");
    const savedShot = !!(tool.screenshotPath || tool.save === true || tool.saved);
    const shotSrc = !savedShot && typeof tool.image === "string" ? tool.image : "";
    let shot = el.querySelector("img.shot");
    if (shotSrc && /^(data:|https?:)/i.test(shotSrc)) { if (!shot) { shot = document.createElement("img"); shot.className = "shot md-img"; el.appendChild(shot); } shot.alt = tool.title || "Screenshot"; shot.src = shotSrc; }
    else if (shot) shot.remove();
    const group = el.closest(".tool-group"); if (group) group.querySelector(".g-label").textContent = exploreLabel(group);
    scroll();
  }
  // Approval cards (Cursor: the pending shell tool decision — ⏎ Run, ⇧⏎ Run and allow for session, Esc Skip).
  const approvals = new Map();
  function approvalEl(a) {
    if (!a || typeof a !== "object" || !a.id) return;
    closeExploreGroup();
    const el = document.createElement("div"); el.className = "card approval " + a.kind; el.id = "approval-" + a.id;
    const head = a.kind === "command" ? "Run command" : a.kind === "patch" ? "Apply changes" : "Permission request";
    el.innerHTML = '<div class="head"><span class="ic"></span><span class="t"></span><span class="hint">waiting for you</span></div><pre class="what"></pre><div class="meta"></div><div class="actions"><button class="btn primary run"></button><button class="btn text session"></button><button class="btn text skip"></button></div>';
    el.querySelector(".ic").innerHTML = cod(a.kind === "command" ? "terminal" : a.kind === "patch" ? "file-code" : "plug"); el.querySelector(".t").textContent = head;
    if (a.diff) { const preview = document.createElement("details"); preview.open = true; preview.className = "approval-diff"; const summary = document.createElement("summary"); summary.textContent = "Proposed changes"; const code = document.createElement("pre"); code.className = "what"; code.textContent = a.diff; preview.append(summary, code); el.querySelector(".actions").before(preview); }
    el.querySelector(".what").textContent = a.kind === "patch" && a.files && a.files.length ? a.files.join("\\n") : a.command;
    el.querySelector(".meta").textContent = [a.cwd ? "in " + a.cwd : "", a.reason || ""].filter(Boolean).join(" · ");
    el.querySelector(".run").innerHTML = (a.kind === "command" ? "Run" : a.kind === "patch" ? "Apply" : "Allow") + '<kbd>⏎</kbd>';
    el.querySelector(".session").innerHTML = 'Allow for session<kbd>⇧⏎</kbd>'; if (a.kind === "elicitation") el.querySelector(".session").remove();
    el.querySelector(".skip").innerHTML = (a.kind === "elicitation" ? "Decline" : "Skip") + '<kbd>esc</kbd>';
    el.querySelector(".run").addEventListener("click", () => decide(a.id, "accept")); const ses = el.querySelector(".session"); if (ses) ses.addEventListener("click", () => decide(a.id, "acceptForSession")); el.querySelector(".skip").addEventListener("click", () => decide(a.id, "decline"));
    approvals.set(a.id, el); messages.appendChild(el); body.classList.add("has-messages"); body.classList.add("pending"); scroll();
  }
  function decide(id, decision) { if (!approvals.has(id)) return; vscode.postMessage({ type: "decide", id, decision }); }
  function approvalDone(id, decision) {
    const el = approvals.get(id); approvals.delete(id); if (!approvals.size) body.classList.remove("pending"); if (!el) return;
    el.classList.add("decided"); el.querySelector(".actions").remove(); el.querySelector(".hint").textContent = decision === "decline" ? "skipped" : decision === "acceptForSession" ? "allowed for the session" : "approved";
  }
  function firstApproval() { return approvals.size ? [...approvals.keys()][0] : null; }
  function spawnStatusLabel(status) {
    return ({ pendingInit: "Starting…", running: "Working", interrupted: "Stopped", completed: "Done", errored: "Failed", shutdown: "Closed", notFound: "Missing" })[status] || String(status || "Working");
  }
  function syncSpawnCards(graph) {
    if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes)) return;
    const root = String(graph.rootThreadId || "");
    const children = graph.nodes.filter((n) => n && n.parentThreadId && (!root || String(n.parentThreadId) === root));
    const events = Array.isArray(graph.events) ? graph.events : [];
    for (const node of children) {
      const id = String(node.threadId);
      let el = document.getElementById("subagent-" + id);
      if (!el) {
        el = document.createElement("div"); el.className = "subagent"; el.id = "subagent-" + id;
        el.innerHTML = '<div class="sa-head" role="button" tabindex="0"><span class="sa-glyph"></span><span class="sa-pulse"></span><span class="sa-name"></span><span class="sa-status"></span><span class="sa-dur"></span><span class="chev"></span></div><div class="sa-reveal"><div class="sa-body"><div class="sa-prompt"></div><div class="sa-events"></div></div></div>';
        const head = el.querySelector(".sa-head");
        head.addEventListener("mousedown", (e) => e.preventDefault());
        head.addEventListener("click", () => el.classList.toggle("open"));
        head.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); head.click(); } };
        closeExploreGroup(); messages.appendChild(el); body.classList.add("has-messages");
      }
      const running = node.status === "running" || node.status === "pendingInit";
      el.dataset.status = String(node.status || "");
      el.classList.toggle("running", running);
      el.classList.toggle("failed", node.status === "errored");
      if (running) el.classList.add("open");
      const spawned = events.find((e) => e && e.kind === "spawned" && String(e.threadId) === id);
      el.querySelector(".sa-name").textContent = String(node.taskName || node.role || "Subagent");
      el.querySelector(".sa-status").textContent = spawnStatusLabel(node.status);
      el.querySelector(".sa-prompt").textContent = String((spawned && spawned.summary) || node.taskName || node.role || "");
      const list = el.querySelector(".sa-events"); list.replaceChildren();
      const mine = events.filter((e) => e && (String(e.threadId) === id || String(e.parentThreadId) === id || (Array.isArray(e.toThreadIds) && e.toThreadIds.some((t) => String(t) === id)))).slice(-12);
      for (const ev of mine) {
        const row = document.createElement("div"); row.className = "sa-event"; row.dataset.kind = String(ev.kind || "");
        row.textContent = String(ev.summary || ev.kind || ""); list.appendChild(row);
      }
    }
    scroll();
  }
  let planSel = new Set(), planExpanded = false, planModel = null, planCardData = null;
  function buildPlan(newThread) {
    if (!planCardData) return;
    const todos = [...planSel].sort((a, b) => a - b);
    vscode.postMessage({ type: "buildPlan", todos: todos.length ? todos : undefined, model: planModel || undefined, newThread: !!newThread });
  }
  function planCard(card) {
    if (!planEl) { planEl = document.createElement("div"); planEl.className = "card plan"; messages.appendChild(planEl); body.classList.add("has-messages"); planSel = new Set(); planExpanded = false; planModel = card.modelId || (state && state.settings.modelId) || null; }
    planCardData = card;
    if (!planModel) planModel = card.modelId || (state && state.settings.modelId) || null;
    const shown = planExpanded ? card.todos : card.todos.slice(0, 3), more = card.todos.length - shown.length;
    const modelName = (state && (state.models.find((m) => m.id === planModel) || {}).name) || card.model || "Model";
    const sel = planSel.size;
    planEl.innerHTML = '<div class="file"><span class="icon">☰</span><span class="name">' + escape(card.path ? card.path.split("/").pop() : "plan.md") + '</span>' + (card.model ? '<span class="planned">Planned with ' + escape(card.model) + '</span>' : "") + '</div><h3>' + escape(card.title) + '</h3>' + (card.summary ? '<div class="summary">' + escape(card.summary) + '</div>' : "") +
      (card.todos.length ? '<div class="todos"><div class="t"><span>' + card.todos.length + ' To-dos' + (sel ? ' · ' + sel + ' selected' : '') + '</span><span class="all" id="plan-all">' + (sel === card.todos.length ? "Clear" : "Select all") + '</span></div>' + shown.map((t, i) => '<div class="todo' + (t.done ? " done" : "") + (planSel.has(i) ? " sel" : "") + '" data-i="' + i + '"><span class="o">' + (planSel.has(i) ? "✓" : "") + '</span><span>' + escape(t.text) + '</span></div>').join("") + (more > 0 ? '<div class="more" id="plan-more">··· ' + more + ' more</div>' : "") + '</div>' : "") +
      '<div class="foot"><button class="viewplan" id="plan-view">View Plan</button><span class="spacer"></span><span class="modelpick" id="plan-model" title="Model used to build this plan">' + escape(modelName) + ' <span class="chev">▼</span></span><span class="split"><button class="btn amber" id="plan-build">Build' + (sel && sel < card.todos.length ? " " + sel : "") + ' <kbd>⌘⏎</kbd></button><span class="chev" id="plan-build-more">▼</span></span></div>';
    planEl.querySelector("#plan-view").addEventListener("click", () => vscode.postMessage({ type: "viewPlan" }));
    planEl.querySelector("#plan-build").addEventListener("click", () => buildPlan(false));
    planEl.querySelector("#plan-build-more").addEventListener("click", (e) => { e.stopPropagation(); openPlanBuildMenu(e.currentTarget); });
    planEl.querySelector("#plan-model").addEventListener("click", (e) => { e.stopPropagation(); openPlanModelMenu(e.currentTarget); });
    const all = planEl.querySelector("#plan-all"); if (all) all.addEventListener("click", () => { if (planSel.size === card.todos.length) planSel = new Set(); else planSel = new Set(card.todos.map((_, i) => i)); planCard(card); });
    const moreEl = planEl.querySelector("#plan-more"); if (moreEl) moreEl.addEventListener("click", () => { planExpanded = true; planCard(card); });
    planEl.querySelectorAll(".todo").forEach((el) => el.addEventListener("click", () => { const i = Number(el.dataset.i); if (planSel.has(i)) planSel.delete(i); else planSel.add(i); planCard(card); }));
    scroll();
  }
  function openPlanModelMenu(anchor) {
    menu.dataset.kind = "planmodel"; menu.innerHTML = ""; const add = (html) => menu.insertAdjacentHTML("beforeend", html);
    for (const [prov, title] of [["openai-direct", "OpenAI Direct"], ["hybrow", "Hybrow OmniRoute"], ["claude", "Claude Code"]]) { const ms = (state ? state.models : []).filter((m) => (m.providerId || m.provider) === prov); if (!ms.length) continue; add('<div class="group">' + title + '</div>'); for (const m of ms) add('<div class="item' + (m.id === planModel ? " on" : "") + '" data-id="' + escape(m.id) + '"><span class="lbl">' + escape(m.name) + '</span><span class="check">✓</span></div>'); }
    menu.querySelectorAll(".item").forEach((el) => el.addEventListener("click", () => { planModel = el.dataset.id; closeMenu(); if (planCardData) planCard(planCardData); }));
    menu.classList.remove("wide"); menu.classList.add("open"); placeMenu(anchor);
  }
  function openPlanBuildMenu(anchor) {
    menu.dataset.kind = "planbuild"; menu.innerHTML = '<div class="item" data-act="here"><span class="lbl">Build in this thread</span><span class="kbd">⌘⏎</span></div><div class="item" data-act="new"><span class="lbl">Build in a new agent thread</span></div>';
    menu.querySelectorAll(".item").forEach((el) => el.addEventListener("click", () => { closeMenu(); buildPlan(el.dataset.act === "new"); }));
    menu.classList.remove("wide"); menu.classList.add("open"); placeMenu(anchor);
  }
  function editCard(card) {
    if (!card || typeof card !== "object" || !card.path) return;
    const id = "edit-" + encodeURIComponent(card.path); let wrap = document.getElementById(id);
    if (!wrap) {
      wrap = document.createElement("div"); wrap.className = "card editwrap"; wrap.id = id;
      const head = document.createElement("div"); head.className = "edit"; const diff = document.createElement("pre"); diff.className = "diff";
      head.setAttribute("role", "button"); head.tabIndex = 0; head.setAttribute("aria-label", "Expand changes in " + card.path); head.addEventListener("click", () => { if (wrap.dataset.hasDiff === "1") { wrap.classList.toggle("open"); chatDiffExpanded = wrap.classList.contains("open"); } head.setAttribute("aria-expanded", String(wrap.classList.contains("open"))); persistView(); }); head.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); head.click(); } };
      wrap.append(head, diff); messages.appendChild(wrap); body.classList.add("has-messages");
    }
    const labels = { streaming: "Editing…", written: "Applied", kept: "Reviewed", undone: "Undone" };
    wrap.querySelector(".edit").innerHTML = '<span class="path">' + escape(card.path) + '</span>' + (card.path.includes(".") ? badge(card.path.split(".").pop()) : "") + '<span class="adds">+' + card.adds + '</span><span class="dels">−' + card.dels + '</span><span class="state">' + labels[card.status] + ((card.diff || wrap.dataset.lastDiff) ? " ▾" : "") + '</span>';
    const pre = wrap.querySelector(".diff"); if (card.diff) wrap.dataset.lastDiff = card.diff; const diffText = card.diff || wrap.dataset.lastDiff || ""; wrap.dataset.hasDiff = diffText ? "1" : "0";
    pre.innerHTML = diffText ? diffText.split("\\n").map((l) => '<span class="' + (l[0] === "+" ? "a" : l[0] === "-" ? "d" : "h") + '">' + escape(l) + '</span>').join("") : "";
    if (card.diff && !wrap.dataset.openedOnce) { wrap.classList.toggle("open", chatDiffExpanded); wrap.dataset.openedOnce = "1"; }
    scroll();
  }
  function renderMessages(list) {
    list = Array.isArray(list) ? list : []; flushStream(); approvals.clear(); body.classList.remove("pending"); messages.innerHTML = ""; assistantEl = thinkingEl = planEl = null; body.classList.toggle("has-messages", list.length > 0);
    let userIdx = 0;
    for (const m of list) {
      if (!m || typeof m !== "object" || typeof m.kind !== "string") continue;
      if (m.kind === "user") {
        const cp = m.checkpoint || ("cp-r-" + (userIdx++));
        addHuman(m.text, cp, m.steer);
      }
      else if (m.kind === "assistant") { if (m.reasoning) { const d = document.createElement("details"); d.className = "thinking done"; d.innerHTML = thinkingMarkup(); d.querySelector(".label").textContent = "Thought"; const durEl = d.querySelector(".dur"); if (durEl) durEl.textContent = typeof m.reasoningDurationMs === "number" ? formatThoughtSeconds(m.reasoningDurationMs) : ""; setThinkingBody(d, m.reasoning); messages.appendChild(d); } const a = addAssistant(m.text); decorateAssistant(a); }
      else if (m.kind === "tool") toolEl(m);
      else if (m.kind === "plan") { planEl = null; planSel = new Set(); planExpanded = false; planModel = null; planCard(m.card); }
    }
    if (state?.tabs.find(t => t.id === state.activeId)?.running) { assistantEl = [...messages.querySelectorAll(".assistant")].pop() || null; thinkingEl = [...messages.querySelectorAll(".thinking")].pop() || null; }
    rehydrateTranscriptImages();
    scroll();
  }
  function renderTabs() {
    const t = $("tabs"); t.innerHTML = "";
    for (const tab of (Array.isArray(state.tabs) ? state.tabs : [])) {
      const el = document.createElement("div"); el.className = "tab" + (tab.id === state.activeId ? " active" : ""); el.title = tab.name;
      el.innerHTML = (tab.running ? '<span class="dot"></span>' : "") + '<span class="name">' + escape(tab.name) + '</span><span class="x" title="Close">×</span>';
      el.addEventListener("click", (e) => { if (e.target.classList.contains("x")) vscode.postMessage({ type: "closeTab", id: tab.id }); else vscode.postMessage({ type: "activateTab", id: tab.id }); });
      t.appendChild(el);
    }
    const mk = (icon, title, on, fn) => { const b = document.createElement("button"); b.className = "tabbtn" + (on ? " on" : ""); b.title = title; b.innerHTML = icon; b.addEventListener("click", fn); return b; };
    t.appendChild(mk(ICONS.plus, "New Agent ⇧⌘L", false, () => vscode.postMessage({ type: "newAgent" })));
    t.appendChild(mk(ICONS.globe, "Open Browser ⇧⌘B", false, () => vscode.postMessage({ type: "newBrowser" })));
    const sp = document.createElement("span"); sp.className = "spacer"; t.appendChild(sp);
    t.appendChild(mk(ICONS.history, "History", state.view === "history", () => vscode.postMessage({ type: "view", view: state.view === "history" ? "chat" : "history" })));
    if (state.view === "board") t.appendChild(mk(ICONS.board, "Board", true, () => vscode.postMessage({ type: "view", view: "chat" })));
    t.appendChild(mk(ICONS.more, "More", false, () => vscode.postMessage({ type: "command", id: "muster.agent.more" })));
    t.appendChild(mk(ICONS.max, "Maximize Chat ⌥⌘E", false, () => vscode.postMessage({ type: "command", id: "muster.agent.maximize" })));
  }
  function effortLabel(id) { return ({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" })[id] || id; }
  function renderState() {
    if (!state) return; body.dataset.view = state.view || "chat"; renderTabs();
    const appearance = state.appearance || {}; body.dataset.density = appearance.density || "comfortable"; body.dataset.glass = appearance.glass === false ? "off" : "on";
    body.style.setProperty("--m-body-size", Math.max(12, Math.min(18, appearance.fontSize || 13)) + "px");
    if (/^#[0-9a-f]{6}$/i.test(appearance.accent || "")) body.style.setProperty("--m-accent", appearance.accent); else body.style.removeProperty("--m-accent");
    const modes = Array.isArray(state.modes) ? state.modes : []; const settings = state.settings || {}; const mode = modes.find((m) => m.id === settings.mode) || modes[0] || { id: "agent", name: "Agent", icon: "∞", placeholder: "Message Muster" };
    $("mode-icon").textContent = mode.icon; $("mode-name").textContent = mode.name; $("mode-pill").classList.toggle("plan", mode.id === "plan" || mode.id === "spec"); body.classList.toggle("stage", mode.id === "debug" && mode.placeholder !== "Enter additional context about the issue");
    input.placeholder = planEl && mode.id === "spec" ? "Spin up a new thread with this plan as context" : (body.classList.contains("has-messages") && mode.id === "plan" ? "Steer the plan, or add more details" : mode.placeholder);
    const access = (state.access || []).find((a) => a.id === settings.accessId); $("access-name").textContent = access ? access.label : (state.loading ? "…" : "Access");
    const model = (state.models || []).find((m) => m.id === settings.modelId);
    const effort = model && (model.efforts || []).find((e) => e.id === settings.effortId);
    $("model-name").textContent = model ? (model.providerId === "hybrow" ? "Hybrow · " : model.providerId === "openai-direct" ? "Direct · " : "") + model.name + (effort ? " " + effortLabel(effort.id) : "") : (state.loading ? "Loading models…" : "Choose model");
    body.classList.toggle("running", !!(state.tabs || []).find((t) => t.id === state.activeId && t.running));
    body.classList.toggle("can-redo", state.canRedo);
    $("review-accept").textContent = state.reviewMode === "auto" ? "Dismiss review" : "Keep changes";
    $("review-reject").textContent = "Undo changes";
    $("review-accept").title = "Changes are already on disk. Clear their review highlights.";
    $("review-open").title = "Inspect the changes already applied to files";
  }
  function placeMenu(anchor) {
    // Measure before choosing a side so a tall menu opens above its composer pill.
    const a = anchor.getBoundingClientRect(), edge = 8, gap = 4;
    const root = document.documentElement;
    const vw = Number(window.innerWidth) || root.clientWidth, vh = Number(window.innerHeight) || root.clientHeight;
    if (!(vw > 0 && vh > 0)) return;
    const maxWidth = Math.max(0, vw - edge * 2);
    menu.style.minWidth = Math.min(220, maxWidth) + "px";
    menu.style.maxWidth = maxWidth + "px";
    menu.style.maxHeight = Math.max(0, vh - edge * 2) + "px";
    const below = Math.max(0, vh - a.bottom - edge - gap), above = Math.max(0, a.top - edge - gap);
    const naturalHeight = menu.scrollHeight || menu.offsetHeight || 0;
    const opensAbove = naturalHeight > below && above > below;
    const availableHeight = opensAbove ? above : below;
    menu.style.maxHeight = availableHeight + "px";
    const h = Math.min(menu.offsetHeight || menu.getBoundingClientRect().height || availableHeight, availableHeight);
    const w = Math.min(menu.offsetWidth || menu.getBoundingClientRect().width || maxWidth, maxWidth);
    const top = opensAbove ? a.top - gap - h : a.bottom + gap;
    menu.style.top = Math.max(edge, Math.min(top, vh - h - edge)) + "px";
    menu.style.left = Math.max(edge, Math.min(a.left, vw - w - edge)) + "px";
  }
  let menuAnchor = null;
  function openMenu(kind, anchor) {
    if (menu.dataset.kind === kind && menu.classList.contains("open")) { closeMenu(); return; }
    menuAnchor = anchor;
    menu.dataset.kind = kind; menu.innerHTML = ""; const add = (html) => menu.insertAdjacentHTML("beforeend", html);
    if (kind === "mode") {
      for (const m of state.modes) add('<div class="item mode' + (m.id === state.settings.mode ? " on" : "") + '" data-id="' + escape(m.id) + '"><span class="ic">' + escape(m.icon) + '</span><span class="two"><span class="lbl">' + escape(m.name) + '</span><span class="desc">' + escape(m.description || "") + '</span></span><span class="check">✓</span></div>');
      add('<div class="sep"></div><div class="note">⌘. or ⇧Tab opens this menu · custom modes: settings → muster.modes</div>');
      menu.querySelectorAll(".item").forEach((el) => el.addEventListener("click", () => { vscode.postMessage({ type: "setMode", id: el.dataset.id }); closeMenu(); }));
    } else if (kind === "access") {
      if (!state.access.length) add('<div class="note">' + (state.loading ? "Loading access modes from Codex…" : "No access modes reported by Codex (permissionProfile/list)") + '</div>');
      for (const a of state.access) add('<div class="item' + (a.id === state.settings.accessId ? " on" : "") + '" data-id="' + escape(a.id) + '"><span class="lbl">' + escape(a.label) + '</span><span class="sub">' + escape(a.sandbox) + ' · ' + escape(a.approvalPolicy) + '</span><span class="check">✓</span></div>');
      menu.querySelectorAll(".item").forEach((el) => el.addEventListener("click", () => { vscode.postMessage({ type: "setAccess", id: el.dataset.id }); closeMenu(); }));
    } else if (kind === "model") {
      if (!state.models.length) add('<div class="note">' + (state.loading ? "Loading models from Codex…" : "No models reported (model/list). Is Codex signed in?") + '</div>');
      for (const [prov, title] of [["openai-direct", "OpenAI Direct · signed-in Codex account"], ["hybrow", "Hybrow OmniRoute"], ["claude", "Claude Code · Claude subscription"]]) { const ms = state.models.filter((m) => (m.providerId || m.provider) === prov); if (!ms.length) continue; add('<div class="group">' + title + '</div>');
        for (const m of ms) add('<div class="item' + (m.id === state.settings.modelId ? " on" : "") + '" data-id="' + escape(m.id) + '" title="' + escape(m.description) + '"><span class="lbl">' + escape(m.name) + '</span>' + (m.isDefault ? '<span class="sub">default</span>' : "") + '<span class="check">✓</span></div>'); }
      const model = state.models.find((m) => m.id === state.settings.modelId);
      if (model && model.efforts.length) { add('<div class="sep"></div><div class="group">Effort · ' + escape(model.name) + '</div>'); for (const e of model.efforts) add('<div class="item' + (e.id === state.settings.effortId ? " on" : "") + '" data-effort="' + escape(e.id) + '"><span class="lbl">' + effortLabel(e.id) + '</span><span class="sub">' + escape(e.description) + '</span><span class="check">✓</span></div>'); }
      menu.querySelectorAll(".item[data-id]").forEach((el) => el.addEventListener("click", () => { vscode.postMessage({ type: "setModel", id: el.dataset.id }); setTimeout(() => { if (menuAnchor) { menu.classList.remove("open"); openMenu("model", menuAnchor); } }, 60); }));
      menu.querySelectorAll(".item[data-effort]").forEach((el) => el.addEventListener("click", () => { vscode.postMessage({ type: "setEffort", id: el.dataset.effort }); closeMenu(); }));
    }
    menu.classList.toggle("wide", kind === "mode");
    menu.classList.add("open");
    placeMenu(anchor);
  }
  function closeMenu() { menu.classList.remove("open"); menu.classList.remove("typeahead"); menuAnchor = null; }
  window.addEventListener("resize", () => { if (menuAnchor) placeMenu(menuAnchor); });
  messages.addEventListener("scroll", closeMenu);
  $("mode-pill").addEventListener("click", (e) => { e.stopPropagation(); openMenu("mode", e.currentTarget); });
  $("access-pill").addEventListener("click", (e) => { e.stopPropagation(); openMenu("access", e.currentTarget); });
  $("model-pill").addEventListener("click", (e) => { e.stopPropagation(); openMenu("model", e.currentTarget); });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) closeMenu(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
    if ((e.metaKey || e.ctrlKey) && e.key === "." && state) { e.preventDefault(); const i = state.modes.findIndex((m) => m.id === state.settings.mode); vscode.postMessage({ type: "setMode", id: state.modes[(i + 1) % state.modes.length].id }); }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && planEl && !body.classList.contains("running") && !input.value.trim()) buildPlan(false);
  });
  $("hsearch").addEventListener("input", renderHistory);
  function renderHistory() {
    const q = $("hsearch").value.toLowerCase(); const list = $("hlist"); list.innerHTML = "";
    const items = threads.filter((t) => !q || (t.name + " " + t.project).toLowerCase().includes(q));
    const section = (title, arr) => { if (!arr.length) return; list.insertAdjacentHTML("beforeend", '<div class="hsec">' + title + '</div>'); for (const t of arr) { const el = document.createElement("div"); el.className = "h" + (t.pinned ? " pinned" : ""); el.innerHTML = (t.live ? '<span class="live"></span>' : "") + '<span class="name">' + escape(t.name) + '</span><span class="meta">' + escape(t.project) + ' · ' + escape(t.age) + ' · ' + t.turns + ' turns</span><span class="hacts"><span class="hb" data-act="renameThread" title="Rename">' + cod("edit") + '</span><span class="hb" data-act="exportThread" title="Export as Markdown">' + cod("link") + '</span><span class="hb" data-act="archiveThread" title="Archive">' + cod("history") + '</span></span><span class="pin" title="Pin">★</span>'; el.querySelector(".pin").addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "pin", id: t.id, pinned: !t.pinned }); }); el.querySelectorAll(".hb").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: b.dataset.act, id: t.id }); })); el.addEventListener("click", () => vscode.postMessage({ type: "openThread", id: t.id })); list.appendChild(el); } };
    section("Pinned", items.filter((t) => t.pinned)); section("Threads", items.filter((t) => !t.pinned)); if (!items.length) { const empty = document.createElement("div"); empty.className = "h-empty"; empty.textContent = q ? "No threads match this search." : "No threads in this workspace yet."; list.appendChild(empty); }
  }
  $("badd").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.value.trim()) { vscode.postMessage({ type: "boardAdd", title: e.target.value.trim() }); e.target.value = ""; } });
  function renderBoard(columns) {
    const root = $("bcols"); root.innerHTML = "";
    for (const c of columns) { const col = document.createElement("div"); col.className = "col"; col.innerHTML = '<div class="ct">' + escape(c.title) + '<span class="n">' + c.cards.length + '</span></div><div class="cards"></div>'; const cards = col.querySelector(".cards");
      for (const k of c.cards) { const el = document.createElement("div"); el.className = "kcard"; el.innerHTML = '<div>' + escape(k.title) + '</div><div class="sub">' + (k.running ? '<span class="live"></span> running' : escape(k.subtitle)) + '</div><div class="acts"><button class="btn" data-run>' + (k.subtitle === "thread" ? "Open" : "Run") + '</button>' + (c.id !== "done" ? '<button class="btn" data-move="' + (c.id === "backlog" ? "progress" : c.id === "progress" ? "review" : "done") + '">→</button>' : "") + '</div>';
        el.querySelector("[data-run]").addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "boardRun", id: k.id }); }); const mv = el.querySelector("[data-move]"); if (mv) mv.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "boardMove", id: k.id, column: mv.dataset.move }); }); cards.appendChild(el); }
      root.appendChild(col); }
  }
  $("review-head").addEventListener("click", (e) => { if (e.target.closest("button")) return; $("review").classList.toggle("open"); });
  $("review-accept").addEventListener("click", () => vscode.postMessage({ type: "acceptAll" }));
  $("review-open").addEventListener("click", () => vscode.postMessage({ type: "openReview" }));
  $("review-reject").addEventListener("click", () => vscode.postMessage({ type: "rejectAll" }));
  $("redo").querySelector("button").addEventListener("click", () => vscode.postMessage({ type: "redo" }));
  function renderReview(files) {
    files = Array.isArray(files) ? files : []; body.classList.toggle("reviewing", files.length > 0); if (!files.length) { $("review-files").replaceChildren(); return; }
    const validFiles = files.filter((f) => f && typeof f === "object" && typeof f.path === "string"); $("review-summary").textContent = validFiles.length + (validFiles.length === 1 ? " file" : " files"); $("review-adds").textContent = "+" + validFiles.reduce((n, f) => n + (Number.isFinite(f.adds) ? f.adds : 0), 0); $("review-dels").textContent = "−" + validFiles.reduce((n, f) => n + (Number.isFinite(f.dels) ? f.dels : 0), 0);
    const list = $("review-files"); list.innerHTML = "";
    for (const f of files) { if (!f || typeof f !== "object" || typeof f.path !== "string") continue; const row = document.createElement("div"); row.className = "file"; const parts = f.path.split("/"); const name = parts.pop(); row.innerHTML = '<span class="name">' + escape(name) + '</span><span class="dir">' + escape(parts.join("/")) + '</span><span class="adds">+' + (Number.isFinite(f.adds) ? f.adds : 0) + '</span><span class="dels">−' + (Number.isFinite(f.dels) ? f.dels : 0) + '</span>'; row.addEventListener("click", () => vscode.postMessage({ type: "open", path: f.path })); list.appendChild(row); }
  }
  // Mentions light up like the Plan pill when they resolve; a chips row mirrors them with remove buttons (Cursor's context row).
  const TOKEN = /(^|\\s)(@[\\w./:?=&%#+-]+|\\/[\\w-]+)/g;
  let tokenOk = new Set(), tokenBad = new Set();
  function tokensIn(text) { const out = []; let m; TOKEN.lastIndex = 0; while ((m = TOKEN.exec(text))) out.push(m[2]); return out; }
  function renderTokens() {
    const text = input.value;
    // The token still being typed at the caret is not a mention yet (Cursor shows the pill once it is chosen).
    const typing = triggerAt(); const typingEnd = typing ? input.selectionStart : -1;
    let html = ""; let last = 0; TOKEN.lastIndex = 0; let m; const done = [];
    while ((m = TOKEN.exec(text))) { const start = m.index + m[1].length; const end = start + m[2].length; if (end === typingEnd) continue; done.push(m[2]); html += escape(text.slice(last, start)) + '<mark class="' + (tokenBad.has(m[2]) ? "bad" : "") + '">' + escape(m[2]) + '</mark>'; last = end; }
    html += escape(text.slice(last)) + "\\n";
    $("backdrop").innerHTML = html; $("backdrop").scrollTop = input.scrollTop;
    const row = $("ctxrow"); [...row.querySelectorAll(".ctx:not(.add)")].forEach((c) => c.remove());
    const seen = new Set();
    const addChip = (chip) => { const add = $("ctx-add"); if (add && add.parentNode === row) row.insertBefore(chip, add); else row.appendChild(chip); };
    for (const t of [...composerImages, ...retainedContext, ...done]) {
      if (!t.startsWith("@") && !composerImages.includes(t)) continue;
      if (t.startsWith("/")) continue;
      if (seen.has(t)) continue; seen.add(t);
      const chip = document.createElement("span"); chip.className = "ctx" + (tokenBad.has(t) ? " bad" : ""); chip.title = tokenBad.has(t) ? t + " (not found)" : t; chip.classList.toggle("retained", retainedContext.includes(t));
      let body = t.slice(1); try { body = decodeURIComponent(body); } catch {} let icon, label;
      if (t.startsWith("/")) { icon = cod("sparkle"); label = t; }
      else if (body.startsWith("image:")) { const src = body.slice(6); icon = '<img class="ctx-thumb" data-src="' + escape(src) + '" alt="">'; label = src.split("/").pop() || "image"; chip.classList.add("image"); }
      else if (body === "browser" || body.startsWith("browser:")) { icon = cod("browser"); label = body === "browser" ? "Live browser" : "Saved browser selection"; }
      else if (body === "web") { icon = cod("globe"); label = "Web"; }
      else if (body.startsWith("git:commit:")) { icon = cod("git-commit"); label = body.slice(11, 18); }
      else if (body.startsWith("git:")) { icon = cod("git-branch"); label = body === "git:branch" ? "Branch" : "Working Tree"; }
      else if (body.startsWith("terminal")) { icon = cod("terminal"); label = body.includes(":") ? body.slice(9) : "Terminal"; }
      else if (body.startsWith("docs:")) { icon = cod("book"); label = body.slice(5); }
      else if (body.startsWith("link:") || /^https?:\\/\\//.test(body)) { icon = cod("link"); label = body.replace(/^link:/, "").replace(/^https?:\\/\\//, "").slice(0, 40); }
      else if (body.startsWith("code:") || body.startsWith("symbol:")) { icon = cod("symbol-method"); label = body.slice(body.indexOf(":") + 1); }
      else if (body === "rules" || body.startsWith("rule:")) { icon = cod("note"); label = body === "rules" ? "Rules" : body.slice(5); }
      else if (body === "git:pr") { icon = cod("git-pull-request"); label = "Pull Request"; }
      else if (body.startsWith("folder:") || body.endsWith("/")) { icon = cod("folder"); label = body.replace(/^folder:/, "").replace(/\\/$/, "").split("/").pop() || body; }
      else if (body.startsWith("chat:")) { icon = cod("comment-discussion"); label = "Past chat"; }
      else { const name = body.replace(/:\\d+-\\d+$/, "").split("/").pop() || body; icon = name.includes(".") ? badge(name.split(".").pop()) : cod("folder"); label = name + (/:\\d+-\\d+$/.test(body) ? body.slice(body.lastIndexOf(":")) : ""); }
      chip.innerHTML = '<span class="ci">' + icon + '</span><span class="n">' + escape(label) + '</span><span class="x" title="Remove">' + String.fromCodePoint(COD.close) + '</span>';
      const thumb = chip.querySelector("img.ctx-thumb"); if (thumb && thumb.getAttribute("data-src")) vscode.postMessage({ type: "resolveImage", src: thumb.getAttribute("data-src") });
      if (t.startsWith("@") && !/^(browser|web|terminal|git:|docs:|chat:|image:|link:|code:|symbol:|rules$|rule:|folder:|https?:)/.test(body) && !tokenBad.has(t)) { chip.classList.add("openable"); chip.querySelector(".n").addEventListener("click", () => { const range = /:(\\d+)-(\\d+)$/.exec(body); vscode.postMessage({ type: "openPath", path: body.replace(/:\\d+-\\d+$/, "").replace(/\\/$/, ""), line: range ? Number(range[1]) : undefined, endLine: range ? Number(range[2]) : undefined }); }); }
      chip.querySelector(".x").addEventListener("click", () => { retainedContext = retainedContext.filter(x => x !== t); composerImages = composerImages.filter(x => x !== t); const re = new RegExp("(^|\\\\s)" + t.replace(/[.*+?^\${}()|[\\]\\\\/]/g, "\\\\$&") + "(?=\\\\s|$)"); input.value = input.value.replace(re, "$1").replace(/  +/g, " "); autosize(); persistView(); input.focus(); });
      chip.querySelector(".x").setAttribute("role", "button"); chip.querySelector(".x").tabIndex = 0; chip.querySelector(".x").setAttribute("aria-label", "Remove " + label); chip.querySelector(".x").onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); chip.querySelector(".x").click(); } };
      addChip(chip);
    }
    // Cursor: the active editor's file as a dashed suggestion pill; click to add it.
    let cur = null; try { cur = state && state.currentFile; } catch { cur = null; } const curTok = cur ? "@" + encodeURI(cur) : null;
    if (curTok && !seen.has(curTok)) { const sug = document.createElement("span"); sug.className = "ctx suggestion"; sug.title = "Add the current file: " + cur; const nm = cur.split("/").pop(); sug.innerHTML = '<span class="ci">' + (nm.includes(".") ? badge(nm.split(".").pop()) : cod("file")) + '</span><span class="n">' + escape(nm) + '</span>'; sug.addEventListener("click", () => { const at = input.selectionStart; const pre = input.value.slice(0, at); const sp = pre && !/\\s$/.test(pre) ? " " : ""; input.value = pre + sp + curTok + " " + input.value.slice(at); const c = (pre + sp + curTok + " ").length; input.setSelectionRange(c, c); input.focus(); input.dispatchEvent(new Event("input")); }); row.appendChild(sug); }
    if ($("context-hint")) $("context-hint").textContent = retainedContext.length ? retainedContext.length + " retained · refreshed on each send" : "Attach files or browser selections with @";
    if ($("clear-context")) $("clear-context").hidden = !retainedContext.length;
    const toks = [...seen].filter((t) => !tokenOk.has(t) && !tokenBad.has(t));
    if (toks.length) vscode.postMessage({ type: "validate", tokens: toks });
  }
  input.addEventListener("scroll", () => { $("backdrop").scrollTop = input.scrollTop; });
  $("ctx-add").querySelector(".cod").textContent = String.fromCodePoint(${MUSTER_ICON_CODES.mention});
  $("ctx-add").addEventListener("click", () => { const at = input.selectionStart; const pre = input.value.slice(0, at); const needsSpace = pre && !/\\s$/.test(pre); input.value = pre + (needsSpace ? " @" : "@") + input.value.slice(at); const caret = pre.length + (needsSpace ? 2 : 1); input.setSelectionRange(caret, caret); input.focus(); input.dispatchEvent(new Event("input")); });
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(240, Math.max(44, input.scrollHeight)) + "px"; $("backdrop").style.height = input.style.height; body.classList.toggle("dirty", input.value.trim().length > 0); renderTokens(); }
  function send() {
    let text = input.value.trim();
    const mode = state && state.modes.find((m) => m.id === state.settings.mode);
    if (!text && mode && mode.id === "debug" && input.placeholder !== "Enter additional context about the issue") text = input.placeholder;
    const imageBits = composerImages.slice();
    if (!text && !imageBits.length) return;
    const keep = tokensIn(text).filter((t) => t.startsWith("@") && !t.startsWith("@image:"));
    retainedContext = [...new Set([...retainedContext.filter((t) => t.startsWith("@") && !t.startsWith("@image:")), ...keep])];
    const present = new Set(tokensIn(text));
    const extra = retainedContext.filter((t) => !present.has(t) && !t.startsWith("@image:"));
    const prompt = [...imageBits, text, extra.length ? extra.join(" ") : ""].filter(Boolean).join("\\n\\n");
    following = true; composerImages = []; vscode.postMessage({ type: "send", text: prompt }); input.value = ""; autosize(); persistView();
  }
  // @ mentions and / commands — Cursor's typeahead: an empty state with recent files and navigation rows into modes
  // (Files & Folders, Past Chats, Docs, Terminals, Commits), one "Results" list while typing, highlighted matches,
  // ↑/↓, Enter/Tab, → into a mode, Backspace out of it, Escape.
  const COD = ${JSON.stringify(MUSTER_ICON_CODES)};
  const cod = (name, cls) => '<span class="cod ' + (cls || "") + '">' + String.fromCodePoint(COD[name] || COD.file) + '</span>';
  const BADGE = { ts: "#519aba", tsx: "#519aba", js: "#cbcb41", jsx: "#cbcb41", mjs: "#cbcb41", cjs: "#cbcb41", json: "#cbcb41", md: "#519aba", mdx: "#519aba", css: "#a074c4", scss: "#f55385", html: "#e37933", py: "#519aba", go: "#519aba", rs: "#e37933", sh: "#4d5a5e", zsh: "#4d5a5e", yml: "#a074c4", yaml: "#a074c4", toml: "#8b949e", svg: "#f55385", png: "#f55385", jpg: "#f55385", swift: "#e37933", java: "#cc3e44", rb: "#cc3e44", sql: "#519aba", txt: "#8b949e", lock: "#8b949e" };
  const badge = (ext) => { ext = String(ext || "").toLowerCase(); const color = BADGE[ext] || "#8b949e"; return '<span class="ic badge" style="--badge:' + color + '">' + escape((ext || "file").slice(0, 4).toUpperCase()) + '</span>'; };
  function menuIcon(it) { if (it.iconKind === "badge") return badge(it.icon); if (it.iconKind === "slash") return '<span class="ic slash">/</span>'; return cod(it.icon || "file", "ic"); }
  function hl(label, query) { if (!query) return escape(label); const lower = label.toLowerCase(); let qi = 0, out = ""; for (let i = 0; i < label.length; i++) { if (qi < query.length && lower[i] === query[qi]) { out += '<span class="hl">' + escape(label[i]) + '</span>'; qi++; } else out += escape(label[i]); } return out; }
  let suggest = null, suggestSeq = 0;
  function triggerAt() { const upto = input.value.slice(0, input.selectionStart); const m = /(^|\\s)([@/])([\\w./:?=&%#+-]*)$/.exec(upto); return m ? { kind: m[2] === "@" ? "file" : "skill", start: upto.length - m[3].length - 1, query: m[3] } : null; }
  // Posted on every keystroke, no timer: the extension answers from memory, stale replies are dropped by seq, and timers in an occluded window fire late.
  function requestSuggestions() { if (!suggest) return; suggestSeq++; vscode.postMessage({ type: "suggest", kind: suggest.kind, query: suggest.query, mode: suggest.mode, seq: suggestSeq }); }
  function markSel() { if (!suggest) return; const els = menu.querySelectorAll(".row"); els.forEach((el, i) => el.classList.toggle("sel", i === suggest.index)); const cur = els[suggest.index]; if (cur) cur.scrollIntoView({ block: "nearest" }); }
  function closeSuggest() { suggest = null; menu.classList.remove("typeahead"); closeMenu(); }
  function renderSuggestions(m) {
    if (!suggest || suggest.kind !== m.kind || (m.seq !== undefined && m.seq !== suggestSeq)) return;
    suggest.sections = m.sections || []; suggest.items = suggest.sections.flatMap((s) => s.items); suggest.index = 0; suggest.title = m.title || "";
    menu.dataset.kind = "suggest"; menu.classList.add("typeahead"); menu.innerHTML = "";
    if (suggest.mode !== "all") { const back = document.createElement("div"); back.className = "back"; back.innerHTML = cod("chevron-left") + '<span>' + escape(suggest.title) + '</span>'; back.addEventListener("mousedown", (e) => { e.preventDefault(); setMode("all"); }); menu.appendChild(back); }
    if (!suggest.items.length) menu.insertAdjacentHTML("beforeend", '<div class="note">No results</div>');
    const q = suggest.query.toLowerCase(); let flat = 0;
    for (const sec of suggest.sections) {
      if (sec.title) menu.insertAdjacentHTML("beforeend", '<div class="title">' + escape(sec.title) + '</div>');
      for (const it of sec.items) {
        const row = document.createElement("div"); row.className = "row"; row.dataset.i = String(flat++); row.title = it.insert || it.label;
        row.innerHTML = menuIcon(it) + '<span class="text">' + hl(it.label, q) + '</span>' + (it.detail ? '<span class="secondary">' + escape(it.detail) + '</span>' : "") + (it.nav ? cod("chevron-right", "chev") : "");
        row.addEventListener("mousedown", (e) => { e.preventDefault(); chooseSuggestion(it); });
        row.addEventListener("mouseenter", () => { if (suggest) { suggest.index = Number(row.dataset.i); markSel(); } });
        menu.appendChild(row);
      }
    }
    menu.classList.add("open"); placeMenu($("mode-pill")); markSel();
  }
  // Entering or leaving a mode drops what was typed after the trigger (Cursor deletes that range too).
  function setMode(mode) { if (!suggest) return; const caret = input.selectionStart; input.value = input.value.slice(0, suggest.start + 1) + input.value.slice(caret); input.setSelectionRange(suggest.start + 1, suggest.start + 1); suggest.query = ""; suggest.mode = mode; autosize(); requestSuggestions(); }
  function chooseSuggestion(it) {
    if (!suggest) return;
    if (it.nav) { setMode(it.nav); return; }
    if (it.action) { const end = input.selectionStart; input.value = input.value.slice(0, suggest.start) + input.value.slice(end); input.setSelectionRange(suggest.start, suggest.start); closeSuggest(); autosize(); vscode.postMessage({ type: "slashAction", id: it.action }); return; }
    if (it.insert) acceptSuggestion(it.insert);
  }
  function acceptSuggestion(insert) { if (!suggest) return; const end = input.selectionStart; input.value = input.value.slice(0, suggest.start) + insert + " " + input.value.slice(end); const caret = suggest.start + insert.length + 1; input.setSelectionRange(caret, caret); closeSuggest(); autosize(); input.focus(); }
  input.addEventListener("input", () => { autosize(); const t = triggerAt(); if (!t) { if (suggest) closeSuggest(); return; } const keep = suggest && suggest.kind === t.kind && suggest.start === t.start; suggest = { ...t, mode: keep ? suggest.mode : "all", items: keep ? suggest.items : [], sections: keep ? suggest.sections : [], index: keep ? suggest.index : 0, title: keep ? suggest.title : "" }; requestSuggestions(); });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); openMenu("mode", $("mode-pill")); return; }
    if (suggest && menu.classList.contains("open")) {
      const n = suggest.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (n) { suggest.index = (suggest.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n; markSel(); } return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const it = suggest.items[suggest.index] || suggest.items[0]; if (it) chooseSuggestion(it); return; }
      if (e.key === "ArrowRight") { const it = suggest.items[suggest.index]; if (it && it.nav) { e.preventDefault(); setMode(it.nav); return; } }
      if (e.key === "Backspace" && suggest.query === "" && suggest.mode !== "all") { e.preventDefault(); setMode("all"); return; }
      if (e.key === "Escape") { closeSuggest(); return; }
    }
    const pendingId = firstApproval();
    if (pendingId && !input.value.trim()) {
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); decide(pendingId, e.shiftKey ? "acceptForSession" : "accept"); return; }
      if (e.key === "Escape") { e.preventDefault(); decide(pendingId, "decline"); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); send(); }
  });
  document.addEventListener("keydown", (e) => { if (e.target === input) return; const id = firstApproval(); if (!id) return; if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); decide(id, e.shiftKey ? "acceptForSession" : "accept"); } else if (e.key === "Escape") { e.preventDefault(); decide(id, "decline"); } });
  $("send").addEventListener("click", send);
  $("attach").addEventListener("click", () => vscode.postMessage({ type: "attach" }));
  function ingestImageBlob(blob, name) {
    if (!blob || !/^image\\/(png|jpe?g|gif|webp)$/i.test(blob.type || "")) return false;
    if (blob.size > 8_000_000) return false;
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      const data = raw.replace(/^data:[^;]+;base64,/, "");
      if (!data) return;
      vscode.postMessage({ type: "pasteImage", mime: blob.type || "image/png", data: data, name: name || blob.name || "paste.png" });
    };
    reader.readAsDataURL(blob);
    return true;
  }
  input.addEventListener("paste", (e) => {
    const items = e.clipboardData ? [...(e.clipboardData.items || [])] : [];
    const files = e.clipboardData ? [...(e.clipboardData.files || [])] : [];
    let used = false;
    for (const it of items) { if (it.type && it.type.indexOf("image/") === 0) { const f = it.getAsFile(); if (f && ingestImageBlob(f, f.name)) used = true; } }
    if (!used) for (const f of files) if (ingestImageBlob(f, f.name)) used = true;
    if (used) e.preventDefault();
  });
  $("composer").addEventListener("dragover", (e) => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  $("composer").addEventListener("drop", (e) => {
    const files = e.dataTransfer ? [...(e.dataTransfer.files || [])] : [];
    let used = false;
    for (const f of files) if (ingestImageBlob(f, f.name)) used = true;
    if (used) e.preventDefault();
  });
  { const mic = document.querySelector('.icon[title="Dictate"]'); if (mic) mic.addEventListener("click", () => vscode.postMessage({ type: "dictate" })); }
  $("stop").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  // Stop in the send slot while running (Cursor), ⇧⌘⌫ anywhere in the pane; queued follow-ups live between the messages and the composer.
  { const stopBtn = document.createElement("span"); stopBtn.className = "stopbtn"; stopBtn.id = "stopbtn"; stopBtn.title = "Stop ⇧⌘⌫"; stopBtn.textContent = "■"; stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" })); $("send").parentNode.insertBefore(stopBtn, $("send").nextSibling); }
  document.addEventListener("keydown", (e) => { if (e.key === "Backspace" && e.metaKey && e.shiftKey) { e.preventDefault(); vscode.postMessage({ type: "stop" }); } });
  // ── browser tab: URL bar, page area (the workbench places the real page over #bhost), sections ──
  let bstate = null, bsec = "console";
  const bhost = $("bhost");
  const health = document.createElement("div"); health.id = "browser-health"; health.className = "browser-health"; health.setAttribute("role", "status"); bhost.before(health);
  function reportRect() {
    if (!bstate) return;
    const r = bhost.getBoundingClientRect(); const visible = body.dataset.view === "browser" && r.width > 10 && r.height > 10;
    vscode.postMessage({ type: "browserRect", id: bstate.id, rect: { top: r.top, left: r.left, width: r.width, height: r.height }, visible });
  }
  setInterval(reportRect, 500);
  window.addEventListener("resize", reportRect);
  function renderBrowser(st) {
    if (!st || typeof st !== "object") return; st = { console: [], changes: [], ...st }; st.console = Array.isArray(st.console) ? st.console : []; st.changes = Array.isArray(st.changes) ? st.changes : []; bstate = st;
    const health = $("browser-health"); if (health) { health.textContent = st.loadError || (st.loading ? "Loading page…" : "Browser ready · select an element to attach it to chat"); health.classList.toggle("error", !!st.loadError); }
    if (document.activeElement !== $("burl")) $("burl").value = st.url || "";
    $("bpick").classList.toggle("on", !!st.picking);
    $("bconsole-count").textContent = st.console.length ? "(" + st.console.length + ")" : "";
    const body_ = $("bsbody");
    if (bsec === "console") body_.innerHTML = st.console.length ? st.console.slice(-200).map((c) => '<span class="c ' + escape(c.level) + '">' + escape(c.message) + (c.source ? ' <span style="opacity:.5">' + escape(String(c.source).split("/").pop()) + (c.line ? ':' + c.line : '') + '</span>' : '') + '</span>').join("") : '<span class="c debug">No console output yet.</span>';
    else if (bsec === "changes") body_.innerHTML = (st.changes || []).length ? st.changes.map((c, i) => '<span class="bchange"><span class="sel" title="' + escape(c.selector) + '">' + escape(c.selector) + '</span><span>' + escape(c.kind === "text" ? "text" : c.prop) + '</span><span class="old">' + escape(c.before) + '</span><span class="arrow">→</span><span class="new">' + escape(c.after) + '</span><span class="x" data-i="' + i + '" title="Revert">×</span></span>').join("") + '<button class="btn primary bapply" id="bapply">Apply changes in chat</button>' : '<span class="c debug">Edit the selected element’s text or styles; every change is listed here as old → new until the agent applies it to code.</span>';
    else if (bsec === "selected" && st.picked && body_.contains(document.activeElement)) { /* keep the field being edited */ }
    else if (bsec === "selected") body_.innerHTML = st.picked ? '<span class="kv"><b>selector</b> ' + escape(st.picked.selector) + '</span>' + (st.picked.source ? '<span class="kv"><b>source</b> ' + escape(st.picked.source.file) + ':' + escape(st.picked.source.line) + '</span>' : '') + '<span class="kv"><b>text</b> ' + escape(st.picked.text) + '</span><span class="kv"><b>rect</b> ' + escape(JSON.stringify(st.picked.rect)) + '</span><span class="kv"><b>styles</b> ' + escape(Object.entries(st.picked.styles).map(([k, v]) => k + ": " + v).join("; ")) + '</span><span class="kv"><b>html</b> ' + escape(st.picked.html.slice(0, 800)) + '</span>' : '<span class="c debug">Click ⌖ then an element in the page.</span>';
    else body_.innerHTML = '<span class="kv"><b>url</b> ' + escape(st.url) + '</span><span class="kv"><b>title</b> ' + escape(st.title) + '</span>';
    if (bsec === "selected" && st.picked && !body_.querySelector(".field")) {
      const changed = (prop) => (st.changes || []).some((c) => c.selector === st.picked.selector && (c.kind === "text" ? "text" : c.prop) === prop);
      const field = (label, prop, value) => '<span class="field"><b>' + escape(label) + '</b><input data-prop="' + escape(prop) + '" class="' + (changed(prop) ? "changed" : "") + '" value="' + escape(value || "") + '"></span>';
      let html = '<span class="kv" style="margin-top:8px"><b>Edit</b></span>' + field("text", "text", st.picked.text);
      for (const p of ["color", "background-color", "font-size", "font-weight", "padding", "margin", "border-radius"]) html += field(p, p, (st.picked.styles || {})[p]);
      body_.insertAdjacentHTML("beforeend", html);
    }
    $("bdriving").hidden = !st.driving;
    $("bchanges-count").textContent = (st.changes || []).length ? "(" + st.changes.length + ")" : "";
    reportRect();
  }
  $("btake").addEventListener("click", () => { if (bstate) vscode.postMessage({ type: "browserTakeControl", id: bstate.id }); });
  // Cursor's browser chrome extras: bookmarks bar under the address bar, DevTools, and the certificate overlay.
  let bookmarks = [];
  function renderBookmarks(list, cert) {
    bookmarks = list; const bar = $("bbookmarks"); bar.innerHTML = ""; bar.classList.toggle("has", list.length > 0);
    for (const b of list) { const chip = document.createElement("span"); chip.className = "bm"; chip.title = b.url; chip.innerHTML = cod("globe") + '<span>' + escape(b.title) + '</span>'; chip.addEventListener("click", () => { if (bstate) vscode.postMessage({ type: "browserNav", id: bstate.id, url: b.url }); }); bar.appendChild(chip); }
    $("bstar").classList.toggle("on", !!(bstate && list.some((b) => b.url === bstate.url)));
    const c = $("bcert"); c.hidden = !cert; if (cert) c.querySelector(".msg").textContent = "Certificate not trusted for " + cert.url.replace(/^https?:\\/\\//, "").split("/")[0] + " (" + cert.error + ")";
  }
  $("bstar").addEventListener("click", () => { if (bstate) vscode.postMessage({ type: "browserBookmark", id: bstate.id }); });
  $("bdevtools").addEventListener("click", () => { if (bstate) vscode.postMessage({ type: "browserDevtools", id: bstate.id }); });
  $("bcert").querySelector("button").addEventListener("click", () => { if (bstate) vscode.postMessage({ type: "browserTrust", id: bstate.id }); });
  $("bsbody").addEventListener("change", (e) => { const f = e.target; if (bstate && f && f.dataset && f.dataset.prop) vscode.postMessage({ type: "browserEdit", id: bstate.id, kind: f.dataset.prop === "text" ? "text" : "style", prop: f.dataset.prop === "text" ? undefined : f.dataset.prop, value: f.value }); });
  $("bsbody").addEventListener("click", (e) => { const t = e.target; if (!bstate || !t) return; if (t.classList.contains("x") && t.dataset.i !== undefined) vscode.postMessage({ type: "browserRevert", id: bstate.id, index: Number(t.dataset.i) }); else if (t.id === "bapply") vscode.postMessage({ type: "browserApply", id: bstate.id }); });
  $("burl").addEventListener("keydown", (e) => { if (e.key === "Enter" && bstate) vscode.postMessage({ type: "browserNav", id: bstate.id, url: $("burl").value }); e.stopPropagation(); });
  document.querySelectorAll(".bbar .bbtn").forEach((b) => b.addEventListener("click", () => { if (bstate) vscode.postMessage({ type: "browserAction", id: bstate.id, action: b.dataset.act }); }));
  document.querySelectorAll(".bstab").forEach((t) => t.addEventListener("click", () => { bsec = t.dataset.sec; document.querySelectorAll(".bstab").forEach((x) => x.classList.toggle("on", x === t)); if (bstate) renderBrowser(bstate); }));
  $("bclear").addEventListener("click", () => { if (bstate) { bstate.console = []; renderBrowser(bstate); } });
  $("btochat").addEventListener("click", () => { if (bstate) vscode.postMessage({ type: "browserToChat", id: bstate.id }); });
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "browser" && state?.view === "browser") { renderBrowser(m.state); }
    if (m.type === "state") { beforeState(m); state = m; renderState(); renderQueue(m.queue || []); renderTokens(); paintTelemetry({activity:m.activity,usage:m.usage,usageLedger:m.usageLedger,startedAt:m.startedAt,promptEstimate:m.promptEstimate,run:m.run,runState:m.runState||m.status,events:m.activityEvents||m.activityTimeline||m.events||m.timeline,contextRefs:m.contextRefs||m.contextReferences||m.includedContext}); if(Object.prototype.hasOwnProperty.call(m,"agentWorkspace"))renderAgentWorkspace(m.agentWorkspace); if(Object.prototype.hasOwnProperty.call(m,"taskWorkspace"))renderTaskWorkspace(m.taskWorkspace); reportRect(); }
    else if (m.type === "messages") { renderMessages(m.messages); for (const card of m.edits || []) editCard(card); restoreView(); if (state) renderState(); if (typeof agentPayload !== "undefined" && agentPayload) syncSpawnCards(agentPayload); }
    else if (m.type === "agentWorkspace") { renderAgentWorkspace(m.data); }
    else if (m.type === "taskWorkspace") { renderTaskWorkspace(m.data); }
    else if (m.type === "agentActionResult") { agentActionResult(m); }
    else if (m.type === "user") { flushStream(); assistantEl = thinkingEl = null; addHuman(m.text, m.checkpoint, m.steer); if (state) renderState(); }
    else if (m.type === "start") { body.classList.add("running"); setRunState("running", "Working"); ensureThinking(); }
    else if (m.type === "reasoning") { const t = ensureThinking(); t.dataset.raw = (t.dataset.raw || "") + m.text; setThinkingBody(t, t.dataset.raw); scroll(); }
    else if (m.type === "delta") { const a = ensureAssistant(); a.classList.add("streaming"); a.dataset.raw += m.text; scheduleStream(a); }
    else if (m.type === "telemetry") { paintTelemetry(m); if(Object.prototype.hasOwnProperty.call(m,"agentWorkspace"))renderAgentWorkspace(m.agentWorkspace); if(Object.prototype.hasOwnProperty.call(m,"taskWorkspace"))renderTaskWorkspace(m.taskWorkspace); }
    else if (m.type === "tool") { toolEl(m.tool); }
    else if (m.type === "approval") { approvalEl(m.approval); setRunState("waiting", "Waiting for approval"); }
    else if (m.type === "approvalDone") { approvalDone(m.id, m.decision); }
    else if (m.type === "plan") { planCard(m.card); }
    else if (m.type === "edit") { editCard(m.card); }
    else if (m.type === "review") { renderReview(m.files); }
    else if (m.type === "threads") { threads = m.items; renderHistory(); }
    else if (m.type === "board") { renderBoard(m.columns); }
    else if (m.type === "suggestions") { renderSuggestions(m); }
    else if (m.type === "setInput") { input.focus(); input.value = m.text; input.setSelectionRange(m.text.length, m.text.length); input.dispatchEvent(new Event("input")); setTimeout(() => vscode.postMessage({ type: "probed", value: input.value, seq: suggestSeq, query: suggest ? suggest.query : null, mode: suggest ? suggest.mode : null, title: menu.classList.contains("typeahead") ? (menu.querySelector(".back span") || {}).textContent || "" : "", rows: [...menu.querySelectorAll(".typeahead .row, .row")].filter((r) => menu.classList.contains("open")).map((r) => ({ text: (r.querySelector(".text") || {}).textContent || "", sel: r.classList.contains("sel"), icon: (r.querySelector(".ic, .cod") || {}).className || "" })), chips: [...$("ctxrow").querySelectorAll(".ctx:not(.add)")].map((e) => ({ t: e.title, bad: e.classList.contains("bad") })), cards: [...messages.querySelectorAll(".card")].map((e) => e.className + " | " + ((e.querySelector(".t") || {}).textContent || "") + " | " + ((e.querySelector(".hint, .status") || {}).textContent || "")), marks: [...$("backdrop").querySelectorAll("mark")].map((e) => ({ t: e.textContent, bad: e.classList.contains("bad") })) }), 700); }
    else if (m.type === "validated") { for (const t of m.ok) { tokenOk.add(t); tokenBad.delete(t); } for (const t of m.bad) { tokenBad.add(t); tokenOk.delete(t); } renderTokens(); }
    else if (m.type === "openModeMenu") { openMenu("mode", $("mode-pill")); }
    else if (m.type === "openMenu") { if (m.kind === "model") openMenu("model", $("model-pill")); else if (m.kind === "access") openMenu("access", $("access-pill")); else $("ctx-add").click(); }
    else if (m.type === "dictation") { body.classList.toggle("dictating", !!m.on); if (m.text) { const at = input.selectionStart; const pre = input.value.slice(0, at); const sp = pre && !/\\s$/.test(pre) ? " " : ""; input.value = pre + sp + m.text + input.value.slice(at); const c = (pre + sp + m.text).length; input.setSelectionRange(c, c); input.dispatchEvent(new Event("input")); } }
    else if (m.type === "browserExtras") { renderBookmarks(m.bookmarks || [], m.cert || null); }
    else if (m.type === "insert") {
      const chunk = String(m.text || "");
      if (chunk.trim().startsWith("@image:")) {
        const tok = chunk.trim().split(/\\s+/)[0];
        if (tok && !composerImages.includes(tok)) composerImages.push(tok);
        autosize(); persistView(); input.focus();
      } else {
        const at = input.selectionStart; input.value = input.value.slice(0, at) + m.text + input.value.slice(at); input.setSelectionRange(at + m.text.length, at + m.text.length); autosize(); persistView(); input.focus();
      }
    }
    else if (m.type === "done") { flushStream(); paintTime(); body.classList.remove("running"); document.querySelectorAll(".assistant.streaming").forEach((a) => { a.classList.remove("streaming"); decorateAssistant(a); }); if (thinkingEl) finishThinking(); stopThinkingTick(); if (!m.ok) { const e = document.createElement("div"); e.className = "error"; e.textContent = m.error || "Failed"; messages.appendChild(e); if (typeof window.showToast === "function") window.showToast(m.error || "Failed"); } assistantEl = thinkingEl = null; thinkingStartedAt = 0; setRunState(m.ok ? "complete" : "interrupted", m.ok ? "Complete" : (m.error || "Interrupted")); scroll(); }
  });
  ${polishScript}
  autosize();
  vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}
