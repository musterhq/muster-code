import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";
import { paneHtml } from "../src/agent-view.js";
import { AgentGraphAdapter } from "../src/agent-orchestration.js";

function harness(saved: unknown = {}) {
  const html = paneHtml("test:", "test:codicon.ttf");
  const { window } = parseHTML(html);
  const document = window.document;
  const posted: any[] = [], frames: (() => void)[] = [];
  let persisted: any = saved;
  const context = createContext({ document, window, navigator: {}, console, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    requestAnimationFrame: (cb: () => void) => frames.push(cb),
    ResizeObserver: class { observe() {} },
    acquireVsCodeApi: () => ({ postMessage: (m: any) => posted.push(m), getState: () => persisted, setState: (v: unknown) => persisted = v }),
  });
  const prototype = window.HTMLElement.prototype as any;
  prototype.getBoundingClientRect = () => ({top:0,left:0,bottom:100,width:600,height:400});
  prototype.setSelectionRange = function(a: number,b: number) { this.selectionStart=a;this.selectionEnd=b; };
  prototype.scrollIntoView = () => {};
  for (const script of document.querySelectorAll("script")) runInContext(script.textContent!, context);
  const emit = (data: any) => { const e = new window.Event("message"); (e as any).data = data; window.dispatchEvent(e); };
  const state = (id: string, draft={text:"",context:[] as string[]}) => emit({type:"state",activeId:id,draft,view:"chat",reviewMode:"auto",tabs:[{id,name:id,running:false}],modes:[{id:"agent",name:"Agent",icon:"",placeholder:"Message"}],models:[{id:"astra",name:"Astra",efforts:[{id:"high"}]}],access:[],settings:{mode:"agent",modelId:"astra",effortId:"high"}});
  const evaluate = (code: string) => runInContext(code, context);
  return {window,document,posted,emit,state,evaluate,persisted:()=>persisted,flush:()=>{while(frames.length) frames.shift()!();}};
}

test("composer restores independent drafts/context on tab switches and a new webview", () => {
  const h=harness();h.state("one");h.evaluate('input.value="Review @src/app.ts "; retainedContext=["@README.md"]; persistView()');
  h.state("two");assert.equal((h.document.getElementById("input") as any).value,"");
  h.evaluate('input.value="Second draft"; persistView()');h.state("one");
  assert.equal((h.document.getElementById("input") as any).value,"Review @src/app.ts ");
  assert.match(h.document.getElementById("ctxrow")!.textContent!, /README.md/);
  const next=harness(h.persisted());next.state("one");assert.equal((next.document.getElementById("input") as any).value,"Review @src/app.ts ");
});
test("send retains context, clears only prose, and removes retained context explicitly", () => {
  const h=harness();h.state("one");h.evaluate('input.value="Fix @src/app.ts "; send()');
  assert.equal(h.posted.filter(m=>m.type==="send")[0].text,"Fix @src/app.ts");
  assert.equal((h.document.getElementById("input") as any).value,"");
  h.evaluate('input.value="Check again"; send()');
  assert.match(h.posted.filter(m=>m.type==="send")[1].text,/Check again\n\n@src\/app.ts/);
  (h.document.querySelector(".ctx.retained .x") as any).click();h.evaluate('input.value="Next"; send()');
  assert.equal(h.posted.filter(m=>m.type==="send")[2].text,"Next");
});
test("unchanged UI persistence does not repost the same draft", () => {
  const h=harness(); h.state("one"); h.evaluate("persistView(); persistView();"); assert.equal(h.posted.filter(m=>m.type==="draft").length,1); h.evaluate('input.value="changed"; persistView(); persistView();'); assert.equal(h.posted.filter(m=>m.type==="draft").length,2); h.evaluate('input.value=""; persistView();'); assert.equal(h.posted.filter(m=>m.type==="draft").length,3);
});
test("long messages expand and keep that state after transcript replay", () => {
  const h=harness();h.state("one");const messages=[{kind:"user",text:"Complete sentence. ".repeat(70),checkpoint:"cp-1"}];
  h.emit({type:"messages",messages});const button=h.document.querySelector(".expand-message") as any;
  assert.equal(button.hidden,false);button.click();assert.equal(button.getAttribute("aria-expanded"),"true");
  h.emit({type:"messages",messages});assert.equal(h.document.querySelector(".human")!.classList.contains("expanded"),true);
});
test("streaming batches fragments and preserves reading position", () => {
  const h=harness();h.state("one");h.emit({type:"delta",text:"First "});h.emit({type:"delta",text:"second"});
  assert.equal(h.document.querySelector(".assistant")!.textContent,"");h.flush();assert.equal(h.document.querySelector(".assistant")!.textContent,"First second");
  h.evaluate('following=false;messages.scrollTop=42');h.emit({type:"delta",text:" third"});h.flush();
  assert.equal((h.document.getElementById("messages") as any).scrollTop,42);
  assert.equal((h.document.getElementById("jump-latest") as any).hidden,false);
});
test("Full Access labels review as applied changes and telemetry uses reported values", () => {
  const h=harness();h.state("one");assert.equal(h.document.getElementById("review-accept")!.textContent,"Dismiss review");
  h.emit({type:"telemetry",activity:"Running command",usage:{inputTokens:100,cachedInputTokens:80,outputTokens:12,reasoningOutputTokens:5}});
  assert.equal(h.document.getElementById("activity-label")!.textContent,"Running command");
  assert.equal(h.document.getElementById("usage-input")!.textContent,"100 · 80");
  assert.equal(h.document.getElementById("usage-output")!.textContent,"12 · 5");
});

test("shared popovers open upward and remain scrollable in a narrow, short pane", () => {
  const h = harness(); h.state("one");
  h.evaluate(`
    state.models = [
      {id:"openai-direct:astra",providerId:"openai-direct",name:"Astra",efforts:[]},
      {id:"openai-direct:sol",providerId:"openai-direct",name:"Sol",efforts:[]},
      {id:"hybrow:terra",providerId:"hybrow",name:"Terra",efforts:[]},
      {id:"hybrow:luna",providerId:"hybrow",name:"Luna",efforts:[]},
      {id:"hybrow:sol",providerId:"hybrow",name:"Sol",efforts:[]},
      {id:"hybrow:astra",providerId:"hybrow",name:"Astra",efforts:[]},
      {id:"hybrow:fable",providerId:"hybrow",name:"Fable",efforts:[]},
      {id:"claude:opus",providerId:"claude",name:"Claude",efforts:[]}
    ]; state.settings.modelId = "openai-direct:astra"; renderState();
    Object.defineProperty(window,"innerWidth",{value:329,configurable:true});
    Object.defineProperty(window,"innerHeight",{value:220,configurable:true});
    const model = document.getElementById("model-pill");
    model.getBoundingClientRect = () => ({top:180,left:260,bottom:204,width:60,height:24});
    Object.defineProperties(menu,{scrollHeight:{get:()=>420,configurable:true},offsetHeight:{get:()=>168,configurable:true},offsetWidth:{get:()=>220,configurable:true}});
    openMenu("model",model);
  `);
  const menu = h.document.getElementById("menu") as any;
  assert.equal(menu.parentElement, h.document.body);
  assert.equal(menu.closest("#composer"), null);
  assert.match(menu.textContent, /Hybrow OmniRoute/);
  assert.equal(menu.style.maxHeight, "168px");
  assert.equal(menu.style.top, "8px");
  assert.equal(menu.style.left, "101px");
  (menu.querySelector('[data-id="hybrow:terra"]') as any).click();
  assert.equal(h.posted.at(-1).type, "setModel");
  assert.equal(h.posted.at(-1).id, "hybrow:terra");

  h.evaluate(`
    const access = document.getElementById("access-pill");
    access.getBoundingClientRect = () => ({top:10,left:-20,bottom:34,width:60,height:24});
    Object.defineProperties(menu,{scrollHeight:{get:()=>80,configurable:true},offsetHeight:{get:()=>80,configurable:true},offsetWidth:{get:()=>220,configurable:true}});
    openMenu("access",access);
  `);
  assert.equal(menu.style.top, "38px");
  assert.equal(menu.style.left, "8px");
});

test("activity renders recoverable run state, event timeline, usage ledger, and exact context", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "telemetry", run: { id: "r1", state: "waiting", startedAt: 1720000000000 }, activity: "Waiting for approval", activityTimeline: [{ id: "e1", method: "muster/tool/completed", summary: "Ran tests", ts: 1720000000000 }], usageLedger: [{ turnId: "turn-2", inputTokens: 20, cachedInputTokens: 8, outputTokens: 4, reasoningOutputTokens: 1, id: "u2", startedAt: 1720000000000 }], contextReferences: [{ token: "@src/app.ts", source: "src/app.ts", startLine: 4, endLine: 18, includedLines: 15, sourceMtimeMs: 1720000000000, truncated: true, tokenEstimate: 62 }] });
  assert.equal(h.document.getElementById("activity-state")!.textContent, "Waiting for approval");
  assert.match(h.document.getElementById("activity-timeline")!.textContent!, /Ran tests/);
  assert.match(h.document.getElementById("usage-rows")!.textContent!, /20/);
  assert.match(h.document.getElementById("context-refs")!.textContent!, /4–18/);
  assert.match(h.document.getElementById("context-refs")!.textContent!, /15 lines/);
  assert.equal(h.document.getElementById("activity-usage")!.classList.contains("has"), true);
  h.evaluate('document.getElementById("activity-usage").open=true; document.getElementById("context-inspector").open=true; document.getElementById("usage-ledger").open=true; persistView()'); const next = harness(h.persisted()); next.state("one"); next.emit({type:"messages",messages:[]});
  assert.match(next.document.getElementById("activity-timeline")!.textContent!, /Ran tests/);
  assert.equal((next.document.getElementById("activity-usage") as any).open, true); assert.equal((next.document.getElementById("context-inspector") as any).open, true); assert.equal((next.document.getElementById("usage-ledger") as any).open, true);
});

test("malformed transcript and review payloads do not break the pane", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "messages", messages: null }); h.emit({ type: "review", files: null });
  assert.equal(h.document.querySelectorAll(".human,.assistant,.error").length, 0);
});

test("idle surface is compact while active chat controls remain reachable", () => {
  const html = paneHtml("test:", "test:codicon.ttf"); assert.match(html, /#activity \{ display:none;/); assert.doesNotMatch(html, /body:not\(\.has-messages\)\[data-view="chat"\] #composer \{ order: -1/); assert.match(html, /pasteImage/); assert.match(html, /masthead-menu/); assert.match(html, /Start a new task/);
  const h = harness(); const welcome = h.document.querySelector(".welcome")!; assert.ok(welcome.querySelector("h1")); assert.equal(welcome.querySelector(".quick"), null); assert.match(welcome.textContent!, /What are we working on/); assert.match(welcome.textContent!, /Describe the work/); assert.equal(h.document.getElementById("activity")!.classList.contains("has-details"), false); assert.equal(h.document.getElementById("m-tasks")!.getAttribute("aria-label"), "Task workspace"); assert.equal(h.document.getElementById("m-agents")!.getAttribute("aria-label"), "Agent workspace"); assert.ok(h.document.getElementById("m-history"));
  h.document.getElementById("m-more")!.click(); assert.equal((h.document.getElementById("masthead-menu") as any).hidden, false); assert.match(h.document.getElementById("masthead-menu")!.textContent!, /Chat history/); h.document.getElementById("m-history")!.click(); assert.equal(h.posted.at(-1).type, "view"); assert.equal(h.posted.at(-1).view, "history");
  assert.equal((h.document.getElementById("masthead-menu") as any).hidden, true); assert.match(h.document.getElementById("masthead-menu")!.textContent!, /Managed terminals/);
});

test("composer stays compact, chips pasted images, and does not lift above the transcript", () => {
  const html = paneHtml("test:", "test:codicon.ttf");
  assert.match(html, /Math.max\(44,/);
  assert.match(html, /ingestImageBlob/);
  const h = harness(); h.state("one");
  h.emit({ type: "insert", text: "@image:%2Ftmp%2Fshot.png " });
  assert.ok(h.document.querySelector(".ctx.image"));
  assert.ok(h.posted.some((m) => m.type === "resolveImage" && String(m.src).includes("shot.png")));
});

test("history entry point renders provider rows and an honest empty state", () => {
  const h = harness(); h.emit({ type: "state", activeId: "one", draft: { text: "", context: [] }, view: "history", reviewMode: "auto", tabs: [{ id: "one", name: "one", running: false }], modes: [{ id: "agent", name: "Agent", icon: "", placeholder: "Message" }], models: [], access: [], settings: { mode: "agent", modelId: "", effortId: "" } }); h.emit({ type: "threads", items: [{ id: "thread-1", name: "Fix login", project: "muster", age: "2m", turns: 3, size: "8 KB", live: false, pinned: true }] }); assert.match(h.document.getElementById("hlist")!.textContent!, /Fix login/); assert.match(h.document.getElementById("hlist")!.textContent!, /Pinned/); h.emit({ type: "threads", items: [] }); assert.match(h.document.getElementById("hlist")!.textContent!, /No threads in this workspace yet/);
});

test("managed terminals action dispatches its command by click and keyboard", () => {
  const h = harness(); h.state("one"); const terminal = h.document.getElementById("m-terminal") as any;
  assert.equal(terminal.getAttribute("aria-label"), "Managed terminals"); terminal.click();
  // linkedom's Event does not expose key; assign the key used by the webview listener.
  terminal.dispatchEvent(Object.assign(new h.window.Event("keydown"), { key: "Enter" }));
  const commands = h.posted.filter((m) => m.type === "command" && m.id === "muster.terminal.workspace");
  assert.equal(commands.length, 2);
});

test("stress-sized transcript and rapid updates remain recoverable and interactive", () => {
  const h = harness(); h.state("stress", { text: "", context: ["@stress/a.ts", "@stress/b.ts"] });
  const long = Array.from({ length: 1800 }, (_, i) => "line " + i + " · deterministic payload").join("\\n");
  h.emit({ type: "messages", messages: [{ kind: "user", text: long, checkpoint: "stress-cp" }, { kind: "tool", id: "stress-tool", title: "Ran", tool: "command", detail: "stress", output: long, status: "completed" }, { kind: "assistant", text: "Initial response", reasoning: "Initial summary" }] });
  h.emit({ type: "telemetry", run: { id: "stress-run", state: "running", startedAt: 1720000000000 }, activityTimeline: Array.from({ length: 60 }, (_, i) => ({ id: "e" + i, ts: 1720000000000 + i, method: "stress/event", summary: "event " + i })), usageLedger: Array.from({ length: 30 }, (_, i) => ({ id: "u" + i, startedAt: 1720000000000, inputTokens: i, outputTokens: i })), contextReferences: [{ token: "@stress/a.ts", source: "stress/a.ts", startLine: 1, endLine: 1800, includedLines: 1800, tokenEstimate: 9000 }] });
  for (let i = 0; i < 80; i++) h.emit({ type: "delta", text: "rapid " + i + " " });
  h.flush();
  assert.equal(h.document.getElementById("activity-timeline")!.children.length, 40);
  assert.equal(h.document.getElementById("usage-rows")!.querySelectorAll("tr").length, 21);
  const expand = h.document.querySelector(".expand-message") as any; assert.equal(expand.hidden, false); expand.click(); assert.equal(expand.getAttribute("aria-expanded"), "true");
  (h.document.querySelector(".ctx.retained .x") as any).click(); assert.equal(h.document.querySelectorAll(".ctx.retained").length, 1);
  h.evaluate("following=false;messages.scrollTop=17"); h.emit({ type: "delta", text: "after scroll" }); h.flush(); assert.equal((h.document.getElementById("messages") as any).scrollTop, 17); assert.equal((h.document.getElementById("jump-latest") as any).hidden, false);
});

test("activity remains bounded and deduplicates identical complete status", () => {
  const html = paneHtml("test:", "test:codicon.ttf");
  assert.match(html, /#activity \{[^}]*max-height:clamp\(132px,35vh,360px\)/);
  assert.match(html, /#activity summary \{[^}]*position:sticky/);
  assert.match(html, /#activity:not\(\.has-details\) \.activity-body/);
  assert.match(html, /Usage details/);
  assert.doesNotMatch(html, /Selected model · effort/);
  assert.match(html, /#composer \.ctxrow \{[^}]*align-items:center[^}]*flex-wrap:wrap/);
  assert.match(html, /#composer \.ctx \{[^}]*height:20px[^}]*min-height:20px/);
  assert.match(html, /#composer \.ctx \.ci \{[^}]*width:16px[^}]*height:16px/);
  assert.match(html, /#composer \.ctx \.x \{[^}]*width:18px[^}]*height:18px/);
  assert.match(html, /--m-accent:[^;]*#81A1C1/i);
  assert.doesNotMatch(html, /color-mix\(in srgb,var\(--vscode-editor-background\) 88%,var\(--m-accent\) 12%\)/);
  assert.match(html, /prefers-reduced-transparency:reduce/);
  assert.match(html, /forced-colors:active/);
  assert.match(html, /body\.vscode-high-contrast-light .*backdrop-filter:none/);
  const h = harness(); h.state("one"); h.emit({ type: "telemetry", activity: "Complete", run: { id: "r1", state: "complete", startedAt: 1720000000000 } });
  assert.equal(h.document.getElementById("activity-state")!.textContent, "Complete"); assert.equal(h.document.getElementById("activity-label")!.textContent, ""); assert.equal(h.document.getElementById("activity")!.classList.contains("has-details"), false);
});

test("agent workspace renders runtime graph and scoped capabilities", () => {
  const h = harness(); h.state("one"); h.emit({ type: "state", activeId: "one", draft: { text: "", context: [] }, view: "chat", reviewMode: "auto", tabs: [{ id: "one", name: "one", running: false }], modes: [{ id: "agent", name: "Agent", icon: "∞", placeholder: "Message" }], models: [{ id: "astra", name: "Astra", efforts: [{ id: "high" }] }], access: [], settings: { mode: "agent", modelId: "astra", effortId: "high" }, agentWorkspace: { version: 1, rootThreadId: "parent", nodes: [{ threadId: "parent", status: "running", updatedAt: 1720000000000 }, { threadId: "child", parentThreadId: "parent", taskName: "Child worker", role: "reviewer", status: "running", turnId: "turn-child", usage: { inputTokens: 12, cachedInputTokens: 8, outputTokens: 4, reasoningOutputTokens: 1 }, changes: [{ path: "src/api.ts", adds: 2, dels: 1 }], updatedAt: 1720000000000 }], events: [{ id: "event-1", ts: 1720000000000, kind: "message", threadId: "child", parentThreadId: "parent", summary: "Please inspect the API" }], capabilities: { providerSpawnObserved: true, forkSupported: false, childSteerSupported: true, childInterruptSupported: true } } });
  (h.document.getElementById("m-agents") as any).click(); (h.document.querySelector('[data-agent="child"]') as any).click(); assert.equal(h.document.body.classList.contains("agent-workspace-open"), true); assert.equal(h.document.querySelectorAll(".aw-node").length, 2); assert.match(h.document.getElementById("aw-detail")!.textContent!, /Child worker/); assert.match(h.document.getElementById("aw-detail")!.textContent!, /src\/api.ts/); assert.match(h.document.getElementById("aw-detail")!.textContent!, /Please inspect the API/);
  (h.document.getElementById("aw-manage") as any).click(); assert.equal(h.posted.at(-1).type, "command"); assert.equal(h.posted.at(-1).id, "muster.thread.catalog");
  (h.document.querySelector('[aria-label="Stop Child worker"]') as any).click(); (h.document.querySelector('[aria-label="Steer Child worker"]') as any).click(); (h.document.querySelector(".aw-actions button:last-child") as any).click(); const actions=h.posted.filter((m)=>m.type==="agentAction"); assert.equal(actions.length,3); assert.equal(actions.map((m)=>m.action).join(","),"stop,steer,open"); assert.equal(actions.every((m)=>m.agentId==="child"&&m.threadId==="child"),true); h.emit({type:"agentActionResult",ok:false,action:"stop",agentId:"child",reason:"Child interrupt unavailable"}); assert.equal(h.document.getElementById("aw-feedback")!.classList.contains("error"),true); assert.match(h.document.getElementById("aw-feedback")!.textContent!,/interrupt unavailable/);
});

test("agent workspace stays honest with absent or malformed graph data", () => {
  const h = harness(); h.state("one"); (h.document.getElementById("m-agents") as any).click(); assert.match(h.document.getElementById("aw-tree")!.textContent!, /No agent graph data/); h.emit({ type: "agentWorkspace", data: { version: 1, nodes: [null, { threadId: "only", status: "completed", updatedAt: 1720000000000 }], events: Array.from({ length: 100 }, (_, i) => ({ id: "event-" + i, threadId: "only", kind: "status", summary: "event " + i, ts: 1720000000000 + i })), capabilities: { providerSpawnObserved: false, forkSupported: false, childSteerSupported: false, childInterruptSupported: false } } }); assert.equal(h.document.querySelectorAll(".aw-node").length, 1); assert.equal(h.document.querySelectorAll(".aw-message").length, 80);
});

test("runtime agent graph snapshot reaches the workspace UI", () => {
  const graph = new AgentGraphAdapter("parent"); graph.ingest("thread/started", { thread: { id: "parent", name: "Root" } }, 1720000000000); graph.ingest("item/started", { threadId: "parent", item: { id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: "parent", receiverThreadIds: ["child-a", "child-b"], agentsStates: { "child-a": { status: "running" }, "child-b": { status: "running" } }, prompt: "Review the API" } }, 1720000000000); graph.ingest("thread/status/changed", { threadId: "child-a", status: { type: "running" } }, 1720000000000); graph.ingest("thread/status/changed", { threadId: "child-b", status: { type: "running" } }, 1720000000000); graph.ingest("item/completed", { threadId: "child-a", turnId: "turn-a", item: { id: "item-a", type: "fileChange", status: "completed", changes: [{ path: "src/api.ts", diff: "- old\n+ <script>untrusted()</script>" }] } }, 1720000000000); graph.ingest("item/completed", { threadId: "child-b", turnId: "turn-b", item: { id: "item-b", type: "fileChange", status: "completed", changes: [{ path: "src/api.ts", diff: "x".repeat(32001) }] } }, 1720000000000);
  const snapshot = graph.snapshot();
  const h = harness(); h.state("one"); h.emit({ type: "state", activeId: "one", draft: { text: "", context: [] }, view: "chat", reviewMode: "auto", tabs: [{ id: "one", name: "one", running: false }], modes: [{ id: "agent", name: "Agent", icon: "∞", placeholder: "Message" }], models: [{ id: "astra", name: "Astra", efforts: [{ id: "high" }] }], access: [], settings: { mode: "agent", modelId: "astra", effortId: "high" }, agentWorkspace: snapshot }); h.emit({ type: "telemetry", activity: "Working", agentWorkspace: snapshot }); h.emit({ type: "delta", text: "child output" });
  (h.document.getElementById("m-agents") as any).click(); assert.equal(h.document.querySelectorAll(".aw-node").length, 3); (h.document.querySelector('[data-agent="child-a"]') as any).click(); assert.match(h.document.getElementById("aw-detail")!.textContent!, /Review the API/); assert.equal(h.document.querySelectorAll(".aw-receipt").length, 1); assert.equal(h.document.querySelectorAll(".aw-receipt pre script").length, 0); assert.match(h.document.querySelector(".aw-receipt pre")!.textContent!, /untrusted/); h.evaluate('document.querySelector(".aw-receipt").open=true; agentReceiptOpen[document.querySelector(".aw-receipt").dataset.receipt]=true; persistView()'); h.emit({ type: "telemetry", activity: "Working", agentWorkspace: snapshot }); assert.equal((h.document.querySelector(".aw-receipt") as any).open, true); (h.document.querySelector('[data-agent="child-b"]') as any).click(); assert.match(h.document.getElementById("aw-detail")!.textContent!, /truncated/); const next=harness(h.persisted()); next.state("one"); next.emit({type:"agentWorkspace",data:snapshot}); next.emit({type:"messages",messages:[]}); (next.document.getElementById("m-agents") as any).click(); (next.document.querySelector('[data-agent="child-a"]') as any).click(); assert.equal((next.document.querySelector(".aw-receipt") as any).open,true);
});

test("task workspace renders bounded runtime identities and routes only addressable chats", () => {
  const h = harness(); h.state("one"); const snapshot = { version: 1, activeTaskId: "task-a", tasks: [
    { taskId: "task-a", workspaceId: "ws-a", cwd: "/work/a", threadId: "one", name: "Review auth", status: "running", capability: "shared-checkout-serialized", activeTurnId: "turn-a", workspaceOwner: "current checkout", changes: [{ path: "src/auth.ts", adds: 4, dels: 1 }] },
    { taskId: "task-b", workspaceId: "ws-b", cwd: "/work/b", name: "Docs", status: "completed", capability: "isolated-worktree", workspaceOwner: "docs worktree", changes: [] },
  ] };
  h.emit({ type: "taskWorkspace", data: snapshot }); (h.document.getElementById("m-tasks") as any).click(); assert.equal(h.document.querySelectorAll(".tw-card").length, 2); assert.match(h.document.getElementById("tw-focus")!.textContent!, /Review auth/); assert.match(h.document.getElementById("tw-focus")!.textContent!, /shared checkout/);
  (h.document.querySelector('.tw-change button[title="Open full-file diff"]') as any).click(); (h.document.querySelector('.tw-change button[title="Pin review for this task"]') as any).click(); assert.equal(h.posted.at(-2).type, "openPath"); assert.equal(h.posted.at(-2).path, "src/auth.ts"); assert.equal(h.posted.at(-1).type, "openReview");
  (h.document.querySelector('[data-task-layout="split"]') as any).click(); assert.equal(h.document.getElementById("task-workspace")!.dataset.layout, "split"); assert.equal(h.persisted().taskLayout, "split");
  const next = harness(h.persisted()); next.state("one"); next.emit({ type: "taskWorkspace", data: snapshot }); (next.document.getElementById("m-tasks") as any).click(); assert.equal(next.document.getElementById("task-workspace")!.dataset.layout, "split");
});

test("task workspace rejects malformed and unaddressable snapshots without fake controls", () => {
  const h = harness(); h.state("one"); h.emit({ type: "taskWorkspace", data: { version: 1, activeTaskId: "missing", tasks: [] } }); (h.document.getElementById("m-tasks") as any).click(); assert.match(h.document.getElementById("tw-grid")!.textContent!, /No task identities/); assert.equal(h.document.querySelectorAll(".tw-change button").length, 0);
  h.emit({ type: "taskWorkspace", data: { version: 1, activeTaskId: "task", tasks: [{ taskId: "task", workspaceId: "ws", cwd: "/work", name: "No thread", status: "running", capability: "shared-checkout-serialized", changes: [{ path: "secret.ts" }] }] } }); assert.equal((h.document.querySelector(".tw-card") as any).disabled, true); assert.match(h.document.querySelector(".tw-card")!.getAttribute("title")!, /thread identity/);
  const large = Array.from({ length: 80 }, (_, i) => ({ taskId: "task-" + i, workspaceId: "ws-" + i, cwd: "/work/" + i, threadId: "thread-" + i, name: "Task " + i, status: "idle", capability: "isolated-worktree", changes: [] })); h.emit({ type: "taskWorkspace", data: { version: 1, activeTaskId: "task-79", tasks: large } }); assert.equal(h.document.querySelectorAll(".tw-card").length, 64);
});

test("returning to a running chat resumes the existing response without duplicating it", () => {
  const h=harness();h.state("one");h.evaluate('state.tabs[0].running=true');
  h.emit({type:"messages",messages:[{kind:"assistant",text:"Already streamed",reasoning:"Earlier summary"}]});
  h.emit({type:"delta",text:" and continued"});h.emit({type:"reasoning",text:" more summary"});h.flush();
  assert.equal(h.document.querySelectorAll(".assistant").length,1);assert.equal(h.document.querySelector(".assistant .assistant-body")!.textContent,"Already streamed and continued");
  assert.equal(h.document.querySelectorAll(".thinking").length,1);assert.match(h.document.querySelector(".thinking")!.textContent!,/Earlier summary more summary/);
});
test("streaming diff updates respect a user-collapsed preview and approval shows proposed code as text", () => {
  const h=harness();h.state("one");const card={path:"src/a.ts",status:"streaming",adds:2,dels:1,diff:"-old\n+new"};
  h.emit({type:"edit",card});const head=h.document.querySelector(".editwrap .edit") as any;head.click();
  h.emit({type:"edit",card:{...card,diff:"-old\n+new\n+newer"}});assert.equal(h.document.querySelector(".editwrap")!.classList.contains("open"),false);
  h.emit({type:"approval",approval:{id:"a",kind:"patch",files:["a.ts"],command:"Apply changes",diff:"+<script>untrusted()</script>"}});
  assert.match(h.document.querySelector(".approval-diff pre")!.textContent!,/untrusted/);assert.equal(h.document.querySelectorAll(".approval-diff script").length,0);
});

test("slash suggestion labels keep flex so long details do not clip the command name", () => {
  const html = paneHtml("test:", "test:codicon.ttf");
  assert.doesNotMatch(html, /\.menu \.row \.text \{ flex: 0/);
  assert.match(html, /\.menu \.row \.text \{ flex: 1 1 auto; min-width: 0/);
  assert.match(html, /\.menu \.row \.secondary \{ flex: 0 1 45%; min-width: 0/);
  const h = harness(); h.state("one");
  const detail = "x".repeat(60);
  h.evaluate(`suggestSeq=1; suggest={kind:"skill",start:0,query:"",mode:"all",items:[],sections:[],index:0,title:""};`);
  h.emit({ type: "suggestions", kind: "skill", seq: 1, sections: [{ title: "Commands", items: [
    { label: "/summarize", detail, insert: "/summarize" },
    { label: "/explain", detail, insert: "/explain" },
    { label: "/review", detail, insert: "/review" },
    { label: "/plan-work", detail, insert: "/plan-work" },
  ] }] });
  const rows = [...h.document.querySelectorAll(".menu .row")];
  assert.equal(rows.length, 4);
  for (const row of rows) {
    const label = row.querySelector(".text");
    assert.equal(label.getAttribute("style"), null);
    assert.ok(!/flex:\s*0/.test(label.getAttribute("style") || ""));
    assert.match(label.textContent, /^\/(summarize|explain|review|plan-work)$/);
  }
  assert.match(h.document.querySelector(".menu .title")!.textContent!, /Commands/i);
});

test("thinking summary becomes Thought with a duration after the first assistant delta", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "reasoning", text: "Considering the approach" });
  assert.match(h.document.querySelector(".thinking .label")!.textContent!, /Thinking/);
  h.emit({ type: "delta", text: "Here is the plan." });
  h.flush();
  assert.equal(h.document.querySelector(".thinking .label")!.textContent, "Thought");
  assert.match(h.document.querySelector(".thinking .dur")!.textContent!, /^\d+s$/);
});

test("consecutive read and search tools collapse into one explored group", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "tool", tool: { id: "r1", tool: "read", detail: "cat src/a.ts", status: "completed", output: "a" } });
  h.emit({ type: "tool", tool: { id: "r2", tool: "search", detail: "rg foo", status: "completed", output: "hit" } });
  h.emit({ type: "tool", tool: { id: "r3", tool: "read", detail: "cat src/b.ts", status: "completed", output: "b" } });
  const groups = h.document.querySelectorAll(".tool-group");
  assert.equal(groups.length, 1);
  assert.match(groups[0].querySelector(".g-label")!.textContent!, /Exploring 2 files, 1 search/);
  assert.equal(groups[0].querySelector("#tool-r1")!.parentElement, groups[0].querySelector(".group-body"));
  assert.ok(groups[0].querySelector("#tool-r2"));
  assert.ok(groups[0].querySelector("#tool-r3"));
  h.emit({ type: "tool", tool: { id: "cmd1", tool: "command", detail: "pnpm test", status: "completed", output: "ok" } });
  assert.equal(h.document.querySelectorAll(".tool-group").length, 1);
  assert.match(groups[0].querySelector(".g-label")!.textContent!, /Explored 2 files, 1 search/);
  assert.equal(h.document.getElementById("tool-cmd1")!.closest(".tool-group"), null);
  h.emit({ type: "tool", tool: { id: "fail1", tool: "command", detail: "boom", status: "failed", output: "err" } });
  assert.equal(h.document.getElementById("tool-fail1")!.classList.contains("failed"), true);
});

test("command tools stay as Ran lines and reopen thinking as planning after work", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "reasoning", text: "I will inspect the app" });
  h.emit({ type: "tool", tool: { id: "cmd-line", title: "Check running app and assemble dest", tool: "command", detail: "/bin/zsh -lc 'pgrep Muster'", status: "completed", output: "pid 1", durationMs: 12 } });
  const row = h.document.getElementById("tool-cmd-line")!;
  assert.equal(row.querySelector(".t")!.textContent, "Ran");
  assert.match(row.querySelector(".cmd")!.textContent!, /pgrep Muster/);
  assert.equal(row.classList.contains("open"), false);
  h.emit({ type: "reasoning", text: "Next I will launch it" });
  const thoughts = [...h.document.querySelectorAll(".thinking")];
  assert.equal(thoughts.length, 2);
  assert.equal(thoughts[1]!.querySelector(".label")!.textContent, "Planning next moves");
  assert.equal((thoughts[1] as any).open, true);
});

test("three consecutive reads summarize as Exploring 3 files while live", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "tool", tool: { id: "f1", tool: "read", detail: "cat one.ts", status: "completed" } });
  h.emit({ type: "tool", tool: { id: "f2", tool: "read", detail: "cat two.ts", status: "completed" } });
  h.emit({ type: "tool", tool: { id: "f3", tool: "read", detail: "cat three.ts", status: "completed" } });
  assert.equal(h.document.querySelectorAll(".tool-group").length, 1);
  assert.equal(h.document.querySelector(".tool-group .g-label")!.textContent, "Exploring 3 files");
  assert.ok(h.document.querySelector(".tool-group #tool-f1"));
  assert.ok(h.document.querySelector(".tool-group #tool-f2"));
  assert.ok(h.document.querySelector(".tool-group #tool-f3"));
});

test("live thinking uses Thinking plus a pulse, then freezes Thought with duration", () => {
  const html = paneHtml("test:", "test:codicon.ttf");
  assert.match(html, /--motion-fast:\s*120ms/);
  assert.match(html, /--motion-ui:\s*160ms/);
  assert.doesNotMatch(html, /600ms/);
  assert.match(html, /think-glyph/);
  assert.match(html, /grid-template-rows: 0fr/);
  const h = harness(); h.state("one");
  h.emit({ type: "reasoning", text: "Considering the approach" });
  assert.equal(h.document.querySelector(".thinking .label")!.textContent, "Thinking");
  assert.equal((h.document.querySelector(".thinking") as any).open, true);
  assert.match(h.document.querySelector(".thinking .body")!.textContent!, /Considering the approach/);
  assert.equal(h.document.querySelectorAll(".thinking.streaming .pulse").length, 1);
  h.emit({ type: "delta", text: "Here is the plan." });
  h.flush();
  assert.equal(h.document.querySelector(".thinking .label")!.textContent, "Thought");
  assert.equal((h.document.querySelector(".thinking") as any).open, false);
  assert.match(h.document.querySelector(".thinking .dur")!.textContent!, /^\d+s$/);
  assert.equal(h.document.querySelector(".thinking")!.classList.contains("streaming"), false);
});

test("unsaved tool screenshots stay on the tool card", () => {
  const h = harness(); h.state("one");
  const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  h.emit({ type: "tool", tool: { id: "shot-live", tool: "command", detail: "browser_screenshot", status: "completed", image: pixel } });
  const card = h.document.getElementById("tool-shot-live")!;
  assert.equal(card.querySelector("img.shot")!.getAttribute("src"), pixel);
  h.emit({ type: "tool", tool: { id: "shot-saved", tool: "command", detail: "browser_screenshot", status: "completed", image: pixel, screenshotPath: "/tmp/page.png", save: true } });
  assert.equal(h.document.getElementById("tool-shot-saved")!.querySelector("img.shot"), null);
});

test("streaming does not scroll when the reader has left the tail", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "delta", text: "First " }); h.flush();
  h.evaluate("following=false;messages.scrollTop=17");
  h.emit({ type: "reasoning", text: "later thought" });
  h.emit({ type: "delta", text: "more" }); h.flush();
  assert.equal((h.document.getElementById("messages") as any).scrollTop, 17);
});

test("human bubbles hide @image paths and show a thumbnail strip", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "user", text: "Look at this @image:%2Ftmp%2Fshot.png please", checkpoint: "cp-img" });
  const human = h.document.querySelector(".human")!;
  assert.equal(human.classList.contains("has-images"), true);
  assert.equal(human.querySelector(".txt")!.textContent, "Look at this please");
  assert.doesNotMatch(human.textContent || "", /@image:/);
  assert.equal(human.querySelectorAll(".human-thumb").length, 1);
  assert.match(human.querySelector(".human-thumb")!.getAttribute("data-src") || "", /shot\.png/);
});

test("Generating sits above the composer card, not inside it", () => {
  const html = paneHtml("test:", "test:codicon.ttf");
  assert.match(html, /<div id="status">[\s\S]*<div id="composer">/);
  assert.doesNotMatch(html, /<div id="composer">[\s\S]*<div id="status">/);
  const h = harness(); h.state("one");
  h.emit({ type: "start" });
  assert.equal(h.document.getElementById("status")!.closest("#composer"), null);
  assert.equal(h.document.body.classList.contains("running"), true);
  assert.equal(h.document.querySelector(".thinking .label")!.textContent, "Thinking");
  assert.equal(h.document.querySelectorAll(".thinking.streaming").length, 1);
});

test("live thinking ticks new lines upward then freezes as Thought", () => {
  const html = paneHtml("test:", "test:codicon.ttf");
  assert.match(html, /justify-content: flex-end/);
  assert.match(html, /think-rise/);
  assert.match(html, /linear-gradient\(to bottom, transparent 0%, #000 28%/);
  const h = harness(); h.state("one");
  h.emit({ type: "reasoning", text: "First line\nSecond line" });
  const body = h.document.querySelector(".thinking .body")!;
  assert.match(body.querySelector(".think-prev")!.textContent!, /First line/);
  assert.equal(body.querySelector(".think-line")!.textContent, "Second line");
  assert.equal(h.document.querySelector(".thinking .label")!.textContent, "Thinking");
  h.emit({ type: "delta", text: "Answer." }); h.flush();
  assert.equal(h.document.querySelector(".thinking .label")!.textContent, "Thought");
  h.emit({ type: "done", ok: true });
  assert.equal(h.document.querySelector(".assistant .msg-acts .act")!.title, "Copy");
});

test("command tools render as >_ cards and spawned children appear in the transcript", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "tool", tool: { id: "cmd-card", tool: "command", detail: "pnpm test", status: "completed", output: "ok", durationMs: 12 } });
  const row = h.document.getElementById("tool-cmd-card")!;
  assert.equal(row.querySelector(".prompt-ic")!.textContent, ">_");
  assert.equal(row.querySelector(".t")!.textContent, "Ran");
  h.emit({ type: "agentWorkspace", data: { version: 1, rootThreadId: "parent", nodes: [{ threadId: "parent", status: "running", updatedAt: 1 }, { threadId: "child", parentThreadId: "parent", taskName: "Reviewer", role: "reviewer", status: "running", updatedAt: 1 }], events: [{ id: "sp1", ts: 1, kind: "spawned", threadId: "child", parentThreadId: "parent", summary: "Inspect auth flow" }] } });
  const card = h.document.getElementById("subagent-child")!;
  assert.equal(card.querySelector(".sa-name")!.textContent, "Reviewer");
  assert.equal(card.querySelector(".sa-status")!.textContent, "Working");
  assert.match(card.querySelector(".sa-prompt")!.textContent!, /Inspect auth flow/);
  assert.equal(card.classList.contains("running"), true);
});

test("pasted images stay as chips and are not left in the textarea", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "insert", text: "@image:%2Ftmp%2Fshot.png " });
  assert.equal((h.document.getElementById("input") as HTMLTextAreaElement).value, "");
  assert.ok(h.document.querySelector(".ctx.image"));
  h.evaluate('input.value="See this"; send()');
  const sent = h.posted.filter((m) => m.type === "send").at(-1);
  assert.match(String(sent.text), /@image:%2Ftmp%2Fshot\.png/);
  assert.match(String(sent.text), /See this/);
  assert.equal(h.document.querySelector(".ctx.image"), null);
});

test("replayed user messages without checkpoints still expose edit controls", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "messages", messages: [{ kind: "user", text: "hello again" }] });
  const human = h.document.querySelector(".human")!;
  assert.ok(human.querySelector(".tools"));
  assert.equal(human.dataset.checkpoint, "cp-r-0");
});

test("user bubble is a capsule with hover actions outside the layout", () => {
  const html = paneHtml("test:", "test:codicon.ttf");
  assert.match(html, /border-radius:\s*999px/);
  assert.match(html, /\.human \.tools \{[^}]*position:\s*absolute/);
  assert.match(html, /\.human-thumb \{[^}]*width:\s*32px/);
  const h = harness(); h.state("one");
  h.emit({ type: "user", text: "open it up and check for yourself", checkpoint: "cp-hover" });
  const human = h.document.querySelector(".human")!;
  assert.equal(human.classList.contains("has-images"), false);
  assert.equal(human.querySelector(".txt")!.textContent, "open it up and check for yourself");
  assert.ok(human.querySelector(".tools"));
});

test("thinking shows live elapsed seconds while streaming", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "start" });
  assert.match(h.document.querySelector(".thinking .dur")!.textContent!, /^\d+s$/);
  h.emit({ type: "reasoning", text: "Checking files" });
  assert.match(h.document.querySelector(".thinking .dur")!.textContent!, /^\d+s$/);
});

test("explore lines show duration when complete and expose match popover markup", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "tool", tool: { id: "grep-pop", tool: "command", detail: "rg foo packages/builtin/src/agent-view.ts", status: "completed", output: "packages/builtin/src/agent-view.ts:12:match\npackages/builtin/src/foo.ts:3:hit", durationMs: 240 } });
  const row = h.document.getElementById("tool-grep-pop")!;
  assert.equal(row.querySelector(".line-dur")!.textContent, "240ms");
  assert.ok(row.querySelector(".explore-pop"));
  h.evaluate('document.getElementById("tool-grep-pop").querySelector(".head").dispatchEvent(new window.Event("mouseenter"))');
  assert.match(row.querySelector(".explore-pop")!.innerHTML!, /agent-view\.ts/);
});

test("cat and rg commands stream as Read and Grepped lines, not shell cards", () => {
  const h = harness(); h.state("one");
  h.emit({ type: "tool", tool: { id: "read-sed", tool: "command", detail: "sed -n '800,919p' packages/core/src/codex-app-server.ts", status: "completed" } });
  const read = h.document.getElementById("tool-read-sed")!;
  assert.equal(read.querySelector(".t")!.textContent, "Read");
  assert.equal(read.querySelector(".cmd")!.textContent, "codex-app-server.ts L800-919");
  assert.equal(read.classList.contains("line"), true);
  assert.equal(read.classList.contains("command"), false);
  h.emit({ type: "tool", tool: { id: "grep-rg", tool: "command", detail: "rg foo packages/builtin/src/agent-view.ts", status: "running" } });
  const grep = h.document.getElementById("tool-grep-rg")!;
  assert.equal(grep.querySelector(".t")!.textContent, "Grepping");
  assert.match(grep.querySelector(".cmd")!.textContent!, /foo/);
  assert.equal(grep.classList.contains("line"), true);
  assert.match(h.document.querySelector(".tool-group.collecting .g-label")!.textContent!, /Exploring/);
});
