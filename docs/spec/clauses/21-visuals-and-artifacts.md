# MUS-SPEC-21: Visuals and artifacts

Replies can hold more than text: diagrams, charts, device frames, 3D models, canvases and artifacts the agent builds.

What the user can do:
- see diagrams and charts drawn from a reply, and code blocks with syntax colouring;
- open artifacts and canvases in a tab, and share or export them;
- see app previews inside device frames.

Boundaries:
- A visual that fails to render shows its source and a plain error, never a blank space.
- Device models and frames are downloaded at run time, never bundled.

## Acceptance cases

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-21-43A](21-visuals-and-artifacts.md#mus-spec-21-43a) | "Back to chat" on a side chat opens its parent conversation and keeps the side chat tab open. | [`Back to chat opens the parent conversation and keeps the side chat tab`](../../../packages/agent-app/tests/side-chat-back-dom.tsx) |
| [MUS-SPEC-21-43B](21-visuals-and-artifacts.md#mus-spec-21-43b) | A side chat with no parent, or whose parent chat is gone, shows no "Back to chat" control. | [`No Back to chat control without a parent conversation`](../../../packages/agent-app/tests/side-chat-back-dom.tsx) |
| [MUS-SPEC-21-361A](21-visuals-and-artifacts.md#mus-spec-21-361a) | A closed mermaid fence in a reply draws as a diagram block with its title; while the reply is still streaming the fence stays a code block. | [`a closed mermaid fence in a reply draws as a diagram; while streaming it stays code`](../../../packages/agent-app/tests/rich-block-components.tsx) |
| [MUS-SPEC-21-361B](21-visuals-and-artifacts.md#mus-spec-21-361b) | A mermaid fence that does not parse shows the "Couldn’t render this diagram" card with the parse error and a Show source control that reveals the source. | [`an invalid mermaid fence shows the error card with the parse error and its source`](../../../packages/agent-app/tests/rich-block-components.tsx) |
| [MUS-SPEC-21-361C](21-visuals-and-artifacts.md#mus-spec-21-361c) | A chart fence in the short form draws a Vega chart with its title and kind, offers a Table view of the data, and disposes the chart view when it is switched away or unmounted. | [`a chart fence draws a Vega chart with its title, a table view and disposal on unmount`](../../../packages/agent-app/tests/rich-block-components.tsx) |
| [MUS-SPEC-21-361D](21-visuals-and-artifacts.md#mus-spec-21-361d) | An html-report frame is sandboxed to scripts only (no same-origin, popups, forms or top navigation), sends no referrer, grants no permissions, and is served from its own muster-report origin; a page that must not run gets an empty sandbox. | [`a report frame is scripts-only: no same-origin, served from its own muster-report origin`](../../../packages/agent-app/tests/rich-block-components.tsx) |
| [MUS-SPEC-21-361E](21-visuals-and-artifacts.md#mus-spec-21-361e) | The report origin serves every report with a content security policy that allows no network and no way out of the sandbox. | [`the CSP allows no network at all and no way out of the sandbox`](../../../packages/agent-app/tests/report-origin.test.ts) |
| [MUS-SPEC-21-361F](21-visuals-and-artifacts.md#mus-spec-21-361f) | A chart whose category axis has no sort keeps the rows in the order the reply wrote them (Jan to Jun stays Jan to Jun); an explicit sort and quantitative or temporal channels are left as written. | [`charts: categories keep the data order unless the spec sorts them (months are not alphabetised)`](../../../packages/agent-app/tests/rich-block.test.ts) |
| [MUS-SPEC-21-361G](21-visuals-and-artifacts.md#mus-spec-21-361g) | A report's title decodes HTML entities once (`&amp;lt;` stays `&lt;`) and keeps no tag, even one split to survive a single strip. | [`reports: a title decodes entities once and never keeps a tag`](../../../packages/agent-app/tests/rich-block.test.ts) |
| [MUS-SPEC-21-578A](21-visuals-and-artifacts.md#mus-spec-21-578a) | A render_html page draws inline in the chat as a "Page" block: mounted when it nears the viewport, scripts-only sandbox, the app theme in the frame URL, a network opt-in note, the standard chrome, and full screen with zoom. | [`a render_html page draws inline in the chat: themed, scripts-only sandbox, mounted near the viewport, full screen with zoom`](../../../packages/agent-app/tests/html-preview-components.tsx) |
| [MUS-SPEC-21-578B](21-visuals-and-artifacts.md#mus-spec-21-578b) | preview_open with a URL opens the agent's browser tab, shows the live mini player (or the right pane when asked), refuses non-web URLs, and reports plainly when the server is not running. | [`preview_open(url) opens the agent tab, shows the mini player (or the pane) and reports an unreachable server`](../../../packages/agent-app/tests/html-preview.test.ts) |
| [MUS-SPEC-21-786A](21-visuals-and-artifacts.md#mus-spec-21-786a) | A notebook is read as Markdown, code and raw cells; each saved output shows as an image, else HTML, else text (stream, plain text or a traceback without colour codes); blank and malformed outputs are dropped. | [`a notebook is read as cells with their saved outputs: image over HTML over text, nothing executed`](../../../packages/agent-app/tests/notebook-mermaid-786.test.ts) |
| [MUS-SPEC-21-786B](21-visuals-and-artifacts.md#mus-spec-21-786b) | A notebook that is not JSON, not nbformat 4, or over the cell, output or text limits is refused with a plain sentence instead of a broken preview. | [`a notebook that cannot be shown says why in a sentence`](../../../packages/agent-app/tests/notebook-mermaid-786.test.ts) |
| [MUS-SPEC-21-786C](21-visuals-and-artifacts.md#mus-spec-21-786c) | A Mermaid file holding a URL, a %%{ }%% block, front matter other than a title, raw HTML, node metadata, an img:/image: key or url()/@import is refused before rendering; ordinary diagrams, a title, class annotations and <br> are accepted. | [`a Mermaid file with URLs, configuration, raw HTML or image keys is refused before it reaches Mermaid`](../../../packages/agent-app/tests/notebook-mermaid-786.test.ts) |
| [MUS-SPEC-21-786D](21-visuals-and-artifacts.md#mus-spec-21-786d) | .ipynb files open in the notebook preview and .mmd/.mermaid files in the diagram preview; .json is unchanged. | [`.ipynb opens as a notebook and .mmd or .mermaid as a diagram, not as JSON or plain text`](../../../packages/agent-app/tests/notebook-mermaid-786.test.ts) |
| [MUS-SPEC-21-786E](21-visuals-and-artifacts.md#mus-spec-21-786e) | A measure-only page is served with a CSP whose only script source is the SHA-256 hash of Muster's height reporter, which is injected before the page; without measure, or for a page that runs, nothing changes. | [`a measure-only report runs Muster's height reporter and no script of its own`](../../../packages/agent-app/tests/notebook-mermaid-786.test.ts) |
| [MUS-SPEC-21-786F](21-visuals-and-artifacts.md#mus-spec-21-786f) | A saved HTML output's document carries the active theme's colour scheme, background, text and border colours, holds the output unchanged, and strips characters that could close its style. | [`a saved HTML output is framed in the app colours for light and dark, and the theme cannot break out of its style`](../../../packages/agent-app/tests/notebook-mermaid-786.test.ts) |
| [MUS-SPEC-21-786G](21-visuals-and-artifacts.md#mus-spec-21-786g) | In a real browser a notebook HTML output, served measure-only in the app's sandbox frame, reports its own content height (the frame takes it, and grows for taller content) while its inline script, event handlers, data: script and nested frame never run. | [`a notebook HTML output fits its frame to its content while none of its own scripts run`](../../../packages/agent-app/tests/html-sandbox-security.suite.ts) |
| [MUS-SPEC-21-786H](21-visuals-and-artifacts.md#mus-spec-21-786h) | Opening an .ipynb file tab shows its cells: Markdown through the chat renderer, code syntax-coloured, stream text as pre, images inline, the HTML output in a measure-only muster-report frame; View source and View notebook switch views; nothing asks to run code. | [`a notebook opens as cells: Markdown rendered, code highlighted, saved outputs shown and nothing run`](../../../packages/agent-app/tests/notebook-mermaid-786-dom.tsx) |
| [MUS-SPEC-21-786I](21-visuals-and-artifacts.md#mus-spec-21-786i) | A notebook with 2000 HTML outputs mounts frames only for outputs near the viewport, at most 16 in document order; each frame takes the height its page reports; one that leaves is unmounted and keeps its last height as a placeholder; scrolling back frames it again. | [`only HTML outputs near the viewport get frames, at most 16, each sized to its content and kept as a placeholder when it leaves`](../../../packages/agent-app/tests/notebook-mermaid-786-dom.tsx) |
| [MUS-SPEC-21-786J](21-visuals-and-artifacts.md#mus-spec-21-786j) | Opening a .mmd file tab draws the diagram with its type and title, zoom controls and Expand; Expand opens a full-size dialog with the drawing and Close returns; View source and View diagram switch views; no error appears. | [`a Mermaid file draws as a diagram, toggles to its source and back, and Expand opens it full size and closes`](../../../packages/agent-app/tests/notebook-mermaid-786-dom.tsx) |
| [MUS-SPEC-21-786K](21-visuals-and-artifacts.md#mus-spec-21-786k) | A Mermaid file that does not parse shows "Unable to render diagram: <message>" with its source and Retry; a file with a URL or a %%{ }%% block shows why it is not drawn, with its source, and never reaches Mermaid. | [`an invalid Mermaid file shows the error with its source; a file with a URL or configuration is never handed to Mermaid`](../../../packages/agent-app/tests/notebook-mermaid-786-dom.tsx) |
| [MUS-SPEC-21-786L](21-visuals-and-artifacts.md#mus-spec-21-786l) | Switching the app between dark and light re-serves a notebook HTML output in the new colour scheme and redraws a Mermaid file in the new theme. | [`both previews follow the app theme: HTML outputs are framed in the active colours and diagrams redraw in light and dark`](../../../packages/agent-app/tests/notebook-mermaid-786-dom.tsx) |
| [MUS-SPEC-21-366A](21-visuals-and-artifacts.md#mus-spec-21-366a) | A GLB file opens as an interactive 3D preview: canvas, camera views, model info, wireframe, full screen, and all graphics and worker resources released on close. | [`a GLB model opens as an interactive 3D preview: canvas, views, info, wireframe, full screen, released on close`](../../../packages/agent-app/tests/model-viewer-dom.tsx) |

### Side chats

<a id="mus-spec-21-43a"></a>
#### MUS-SPEC-21-43A: Back to chat returns to the parent conversation

- Precondition: A side chat was opened from a main chat. Its tab fills the maximized right pane, so the main conversation is covered.
- Action: Click "Back to chat" in the side chat's header.
- Expected result: The main chat the side chat was opened from is the active conversation, the pane is restored so the conversation shows beside it, the conversation's message box has focus, and the side chat stays open with its messages.
- Test: `packages/agent-app/tests/side-chat-back-dom.tsx::Back to chat opens the parent conversation and keeps the side chat tab`
- Environment: DOM suite (linkedom) with a stubbed bridge; no provider or network.
- Known gaps: The pane's maximize state is held by a small stand-in with the same toggle contract as the real resource pane. The test does not show which chat is recorded as the parent when the side chat is created (the runtime stores `parentChatId`); it supplies it.
- Evidence: UNVERIFIED

<a id="mus-spec-21-43b"></a>
#### MUS-SPEC-21-43B: No Back to chat without a parent

- Precondition: A side chat that was created with no main chat open, and one whose parent chat has since been deleted.
- Action: Show each side chat's tab.
- Expected result: The header has no "Back to chat" control for either, and still has Open the resource, Promote and Discard.
- Test: `packages/agent-app/tests/side-chat-back-dom.tsx::No Back to chat control without a parent conversation`
- Environment: DOM suite (linkedom) with a stubbed bridge; no provider or network.
- Known gaps: None known.
- Evidence: UNVERIFIED

### Rich replies: diagrams, charts and reports

<a id="mus-spec-21-361a"></a>
#### MUS-SPEC-21-361A: Mermaid diagram renders

- Precondition: An assistant reply holds a mermaid fence (`flowchart LR`), first still open while streaming, then with its closing marker.
- Action: Show the reply while the fence is open, then once the closing fence arrives, then remount it.
- Expected result: While open the fence is an ordinary code block and the diagram renderer is not called. Once closed it becomes a ready "diagram" block titled "Flowchart" with the drawn SVG in its stage, the prose before it kept. Remounting the same source is served from the cache without rendering again.
- Test: `packages/agent-app/tests/rich-block-components.tsx::a closed mermaid fence in a reply draws as a diagram; while streaming it stays code`
- Environment: DOM suite (linkedom) with a stubbed bridge; the Mermaid renderer is a stub that returns an SVG.
- Known gaps: The real mermaid library is not loaded in this suite: the stub stands in for it, so layout and theming of the real SVG are not asserted.
- Evidence: UNVERIFIED

<a id="mus-spec-21-361b"></a>
#### MUS-SPEC-21-361B: Invalid Mermaid shows its source and the error

- Precondition: An assistant reply holds a closed mermaid fence whose source does not parse.
- Action: Show the reply, then click "Show source" on the error card.
- Expected result: The block is in its error state with "Couldn’t render this diagram" and the parse error text, never a blank block; "Show source" reveals the original source.
- Test: `packages/agent-app/tests/rich-block-components.tsx::an invalid mermaid fence shows the error card with the parse error and its source`
- Environment: DOM suite (linkedom) with a stubbed bridge; the Mermaid renderer is a stub that throws the parse error.
- Known gaps: The parse error comes from the stub, not from the real mermaid parser.
- Evidence: UNVERIFIED

<a id="mus-spec-21-361c"></a>
#### MUS-SPEC-21-361C: Vega chart renders

- Precondition: An assistant reply holds a closed chart fence: `{"type":"bar","title":"Users","data":[…],"x":"w","y":"u"}`.
- Action: Show the reply, switch to Table, back to Chart, then unmount the reply.
- Expected result: A ready "chart" block titled "Users" of kind "Bar chart" mounts one chart view, with the actions Show, Chart, Table, Copy source, Download, Open in tab, Full screen in that order. Table shows the columns w and u and two rows and disposes the chart view; Chart draws it again; unmounting disposes it.
- Test: `packages/agent-app/tests/rich-block-components.tsx::a chart fence draws a Vega chart with its title, a table view and disposal on unmount`
- Environment: DOM suite (linkedom) with a stubbed bridge; the Vega mount is a stub that records mounts and disposals.
- Known gaps: The real vega and vega-lite libraries are not loaded in this suite; the spec expansion to Vega-Lite is covered separately by tests/rich-block.test.ts.
- Evidence: UNVERIFIED

<a id="mus-spec-21-361d"></a>
#### MUS-SPEC-21-361D: HTML report runs without same-origin access

- Precondition: A report HTML document is shown through the shared sandboxed frame, once with scripts allowed and once without.
- Action: Render the frame each way.
- Expected result: With scripts the iframe sandbox is exactly "allow-scripts", referrer policy "no-referrer", allow "", and its src is a `muster-report://<32 hex>/index.html?v=1` URL registered through `reports.open`. Without scripts the sandbox attribute is empty.
- Test: `packages/agent-app/tests/rich-block-components.tsx::a report frame is scripts-only: no same-origin, served from its own muster-report origin`
- Environment: DOM suite (linkedom) with a stubbed bridge that answers `reports.open`.
- Known gaps: linkedom does not enforce the sandbox; tests/run-html-sandbox-security.mjs checks enforcement in headless Chrome when Chrome is present.
- Evidence: UNVERIFIED

<a id="mus-spec-21-361e"></a>
#### MUS-SPEC-21-361E: HTML report content security policy

- Precondition: The report origin builds its content security policy for a report.
- Action: Build the policy for a report with scripts and for one without.
- Expected result: With scripts the policy sets default, connect, frame, child, worker, object, form-action, base-uri and manifest sources to 'none', images to data: and blob: only, fonts to data: only and scripts to inline only; it holds no http(s) source, wildcard, eval or own-origin source. A page that must not run gets `script-src 'none'`.
- Test: `packages/agent-app/tests/report-origin.test.ts::the CSP allows no network at all and no way out of the sandbox`
- Environment: Node test of the report registry; no Electron window.
- Known gaps: Header delivery through the real `muster-report://` protocol handler is covered by the wiring test in the same file, not by this one.
- Evidence: UNVERIFIED

<a id="mus-spec-21-361f"></a>
#### MUS-SPEC-21-361F: Chart categories keep the data order

- Precondition: An assistant reply holds a closed chart fence whose bar chart has months Jan to Jun on a nominal x axis with no `sort`.
- Action: Parse the fence for drawing; repeat with the bars inside a layer, with an explicit `sort: "-y"`, and in the short form.
- Expected result: The nominal and ordinal channels get `sort: null`, so the axis reads Jan, Feb, Mar, Apr, May, Jun as written, not alphabetically; the layered spec gets the same; an explicit sort stays `-y`; the quantitative y channel gets no sort.
- Test: `packages/agent-app/tests/rich-block.test.ts::charts: categories keep the data order unless the spec sorts them (months are not alphabetised)`
- Environment: Node test of the pure chart model; no renderer.
- Known gaps: The drawn axis order was checked by hand in an isolated app instance, not by an automated render.
- Evidence: UNVERIFIED

<a id="mus-spec-21-361g"></a>
#### MUS-SPEC-21-361G: Report titles decode once and keep no tags

- Precondition: An html-report whose `<title>` is `A &amp;lt;b&amp;gt; C`, another with `Q&amp;A &lt;3`, and an `<h1>` holding a split tag `a<<b>script>b`.
- Action: Read each report's title for its block header and tab.
- Expected result: The titles are `A &lt;b&gt; C` (decoded once, not twice), `Q&A <3`, and a title with no `<tag`.
- Test: `packages/agent-app/tests/rich-block.test.ts::reports: a title decodes entities once and never keeps a tag`
- Environment: Node test of the pure report model; no renderer.
- Known gaps: Titles are rendered as text, so this guards correctness, not injection.
- Evidence: UNVERIFIED

### Agent pages and previews

<a id="mus-spec-21-578a"></a>
#### MUS-SPEC-21-578A: render_html shows an agent page inline with the theme

- Precondition: An agent called render_html; the tool row holds the stored page id "Revenue dashboard", which asked for network.
- Action: Show the card, scroll it near the viewport, allow network for the page, open full screen and zoom in.
- Expected result: No frame mounts until the card nears the viewport; then the "Revenue dashboard" Page block opens the page through `htmlRenders.open`, with sandbox "allow-scripts" and a `muster-report://` src carrying the `#muster-theme=` fragment. The network note says https only; allowing it calls `htmlRenders.allowNetwork` and reloads the page. The actions are Copy source, Download, Open in tab, Full screen; full screen has zoom (125% after one Zoom in).
- Test: `packages/agent-app/tests/html-preview-components.tsx::a render_html page draws inline in the chat: themed, scripts-only sandbox, mounted near the viewport, full screen with zoom`
- Environment: DOM suite (linkedom) with a stubbed bridge and a fake IntersectionObserver.
- Known gaps: Live theme switches reaching an open page are asserted by the agent-page frame block of the same suite, not by this check.
- Evidence: UNVERIFIED

<a id="mus-spec-21-578b"></a>
#### MUS-SPEC-21-578B: preview_open shows a running dev server

- Precondition: A chat whose agent calls preview_open with a URL, against a fake browser host; once for a reachable server and once for one that refuses the connection.
- Action: Call preview_open with `0.0.0.0:5173`, then with panel: true, then with refused URL schemes (file:, javascript:, muster-report:, ftp:, empty), then against the stopped server on port 3000.
- Expected result: The agent tab opens localhost port 5173, the renderer gets a previewShown event for the chat's agent tab with panel false, and the answer mentions the mini player; panel: true sends panel true. Every refused scheme is an error. Against the stopped server the answer is an error naming "Connection refused (-102)" and the dev server, and the person still sees the preview with its unreachable page.
- Test: `packages/agent-app/tests/html-preview.test.ts::preview_open(url) opens the agent tab, shows the mini player (or the pane) and reports an unreachable server`
- Environment: Node test of the browser bridge with a fake browser host; no Electron window or real server.
- Known gaps: The mini player's streamed frames are not asserted here.
- Evidence: UNVERIFIED

### Notebook and Mermaid file previews

<a id="mus-spec-21-786a"></a>
#### MUS-SPEC-21-786A: Notebook cells and outputs are read as saved

- Precondition: An nbformat 4 notebook with a Markdown cell, a code cell whose outputs are stream text, an HTML table with a plain-text fallback, a PNG with HTML and text fallbacks, a traceback with colour codes and a blank stream, and a raw cell.
- Action: Parse the notebook for preview; also parse one with only a kernelspec language and one whose image is not base64.
- Expected result: Language "python"; cells markdown, code, raw with their line arrays joined as written; outputs in order: "loaded 12 rows", the table HTML (not its plain text), the PNG as a data URL with whitespace removed (not its HTML), and "ValueError: bad / line 2" with no escape codes; the blank stream is dropped. A kernelspec language "R" gives "r"; a malformed image is not shown.
- Test: `packages/agent-app/tests/notebook-mermaid-786.test.ts::a notebook is read as cells with their saved outputs: image over HTML over text, nothing executed`
- Environment: Node test of the pure parser (src/shared/notebook.ts); no renderer.
- Known gaps: Output kinds beyond PNG, JPEG, GIF, WebP, HTML and text (SVG, LaTeX, widgets, JavaScript) fall back to their text form.
- Evidence: UNVERIFIED

<a id="mus-spec-21-786b"></a>
#### MUS-SPEC-21-786B: An unreadable notebook says why

- Precondition: Notebook texts that are cut-off JSON, nbformat 3, 2001 cells, a cell with 201 outputs, and a cell over 512,000 characters.
- Action: Parse each for preview.
- Expected result: Each throws a sentence: "not valid JSON", "version 4 notebooks", "up to 2000 cells", "too many outputs", "too large". The preview shows it in its error card and the View source toggle still shows the file.
- Test: `packages/agent-app/tests/notebook-mermaid-786.test.ts::a notebook that cannot be shown says why in a sentence`
- Environment: Node test of the pure parser; no renderer.
- Known gaps: The error card itself is not asserted in the DOM suite.
- Evidence: UNVERIFIED

<a id="mus-spec-21-786c"></a>
#### MUS-SPEC-21-786C: Unsafe Mermaid files are refused before rendering

- Precondition: Five ordinary diagrams (a flowchart, a titled sequence diagram, a class with <<interface>>, labels with <br>, a commented pie) and thirteen hostile ones.
- Action: Check each text with the file preview's pre-render check.
- Expected result: The ordinary ones pass. Each hostile one is refused with its reason: a URL (https, protocol-relative, data:), a configuration block (with and without spaces), front matter with config, raw HTML (img, script, a comment), node metadata, an img: key, url().
- Test: `packages/agent-app/tests/notebook-mermaid-786.test.ts::a Mermaid file with URLs, configuration, raw HTML or image keys is refused before it reaches Mermaid`
- Environment: Node test of the pure check (src/shared/mermaid-file.ts); no renderer.
- Known gaps: The check is lexical: it may refuse an unusual but harmless diagram (a label that reads like a URL).
- Evidence: UNVERIFIED

<a id="mus-spec-21-786d"></a>
#### MUS-SPEC-21-786D: Notebook and Mermaid files get their own previews

- Precondition: File names analysis/observations.ipynb, docs/flow.mmd, docs/FLOW.MERMAID and data.json.
- Action: Ask which preview each opens in.
- Expected result: notebook, mermaid, mermaid (any case), json.
- Test: `packages/agent-app/tests/notebook-mermaid-786.test.ts::.ipynb opens as a notebook and .mmd or .mermaid as a diagram, not as JSON or plain text`
- Environment: Node test of the file-type dispatch; the DOM suite opens real tabs.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-786e"></a>
#### MUS-SPEC-21-786E: Measure-only pages allow only the height reporter

- Precondition: A report registry and a page holding an inline script.
- Action: Register it with scripts off and measure on, with scripts off only, with scripts on and measure on, and re-register a measured key without measure.
- Expected result: Measure-only: script-src is exactly the reporter's hash (no unsafe-inline, unsafe-hashes or https:), connect-src 'none' even with network, and the reporter is injected before the page. Scripts off only: script-src 'none', no reporter. Scripts on: unchanged ('unsafe-inline'). Re-registering without measure drops it.
- Test: `packages/agent-app/tests/notebook-mermaid-786.test.ts::a measure-only report runs Muster's height reporter and no script of its own`
- Environment: Node test of the report origin (src/main/report-origin.ts) and page preparation; no browser.
- Known gaps: That the browser enforces the CSP is MUS-SPEC-21-786G.
- Evidence: UNVERIFIED

<a id="mus-spec-21-786f"></a>
#### MUS-SPEC-21-786F: HTML outputs are framed in the app colours

- Precondition: A table output and the dark theme's colours; a paragraph and the light theme's; a theme value holding `}</style><script>`.
- Action: Build the output document for each.
- Expected result: Dark: color-scheme:dark, background #1b1c1f, text #e6e7ea, borders #33363b, the table unchanged at the end. Light: color-scheme:light with its colours. The hostile value cannot close the style element.
- Test: `packages/agent-app/tests/notebook-mermaid-786.test.ts::a saved HTML output is framed in the app colours for light and dark, and the theme cannot break out of its style`
- Environment: Node test of the pure document builder; the DOM suite checks a live theme switch.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-786g"></a>
#### MUS-SPEC-21-786G: HTML outputs fit their content and never run, in a real browser

- Precondition: Headless Chrome; a page holding a table, a 300px (then 640px) block, an inline script, an img onerror, an svg onload, a data: script and an srcdoc frame, each of which would post a message to the parent if it ran. Served by the real report registry measure-only, in a 600px-wide `sandbox="allow-scripts"` frame whose parent applies each reported height.
- Action: Load the frame with the 300px block, then with the 640px block.
- Expected result: The reported height is the content plus padding (between 320 and 380px, then between 660 and 720px), the frame is exactly that tall, the taller content reports at least 300px more, and none of the five probes ran. With scripts on instead (checked once by hand) the inline script, onerror and svg onload all run, so the probes are live.
- Test: `packages/agent-app/tests/html-sandbox-security.suite.ts::a notebook HTML output fits its frame to its content while none of its own scripts run`
- Environment: Headless Chrome over CDP (tests/run-html-sandbox-security.mjs); skipped when Chrome is not installed.
- Known gaps: The served page and frame match the app's, but the frame is in a plain page, not inside Electron with the muster-report:// protocol handler.
- Evidence: UNVERIFIED

<a id="mus-spec-21-786h"></a>
#### MUS-SPEC-21-786H: A notebook opens as a document

- Precondition: A workspace holds analysis.ipynb: a Markdown cell ("# Quarterly results", bold "12%") and a Python cell with stream text, an HTML table holding a script, and a PNG.
- Action: Open the file, let the HTML output come near the viewport, then View source and View notebook.
- Expected result: The tab shows the notebook preview "2 cells · python" with "Saved outputs only. Code is never executed."; the heading and bold text are rendered Markdown; the code is coloured; outputs show as pre, a frame and an inline data-URL image. The frame mounts only once near the viewport, with sandbox "allow-scripts" (never same-origin) and a muster-report:// src; it was opened with scripts false and measure true. No command asks to run anything. View source shows the JSON source; View notebook returns.
- Test: `packages/agent-app/tests/notebook-mermaid-786-dom.tsx::a notebook opens as cells: Markdown rendered, code highlighted, saved outputs shown and nothing run`
- Environment: DOM suite (linkedom) through the real FileTab and store, with a stubbed bridge, a stand-in highlighter worker and a fake IntersectionObserver.
- Known gaps: Maths in Markdown cells comes with the chat renderer's maths support (#785), not asserted here.
- Evidence: UNVERIFIED

<a id="mus-spec-21-786i"></a>
#### MUS-SPEC-21-786I: At most 16 output frames, mounted near the viewport

- Precondition: A notebook of 20 cells with 100 HTML outputs each ("saved 0-0" to "saved 19-99").
- Action: Bring the first 40 outputs near the viewport; send the first frame heights 137 then 212 (and 999 from another window); scroll to the last outputs; scroll back to the top.
- Expected result: All 2000 outputs are in the page and observed, with no frame until the observer reports. Near the top: exactly 16 frames, the first "saved 0-0" and the 16th "saved 0-15". The first frame is 137px, then 212px; the foreign message is ignored. At the end: a frame for "saved 19-99", still at most 16, the first frame unmounted and its place 212px tall. Back at the top, "saved 0-0" is framed again with no placeholder height.
- Test: `packages/agent-app/tests/notebook-mermaid-786-dom.tsx::only HTML outputs near the viewport get frames, at most 16, each sized to its content and kept as a placeholder when it leaves`
- Environment: DOM suite (linkedom) with a fake IntersectionObserver standing in for scrolling and report-height messages standing in for the page.
- Known gaps: Real scrolling and layout are not exercised here; MUS-SPEC-21-786G checks the real height in Chrome.
- Evidence: UNVERIFIED

<a id="mus-spec-21-786j"></a>
#### MUS-SPEC-21-786J: A Mermaid file opens as a diagram

- Precondition: A workspace holds flow.mmd, a flowchart titled "Checkout flow" in front matter; Mermaid is a stand-in renderer.
- Action: Open the file, Expand, Close, View source, View diagram.
- Expected result: The diagram is drawn from the file text, labelled "Flowchart · Checkout flow" and "Flowchart: Checkout flow", with zoom controls. Expand opens "Checkout flow (full size)" holding the drawing; Close full size view closes it. View source shows the source table; View diagram draws it again. No alert at any point.
- Test: `packages/agent-app/tests/notebook-mermaid-786-dom.tsx::a Mermaid file draws as a diagram, toggles to its source and back, and Expand opens it full size and closes`
- Environment: DOM suite (linkedom) through the real FileTab, with a stand-in Mermaid renderer.
- Known gaps: Mermaid itself is not run; its strict security level and sanitizing are covered by the chat diagram cases.
- Evidence: UNVERIFIED

<a id="mus-spec-21-786k"></a>
#### MUS-SPEC-21-786K: Invalid or unsafe Mermaid files show their source

- Precondition: broken.mmd (the renderer fails with "Parse error on line 2: Expecting a node"), tracker.mmd (a click with an https URL) and config.mermaid (a %%{init}%% block).
- Action: Open broken.mmd, then Retry once the renderer works; open the other two.
- Expected result: broken.mmd: "Unable to render diagram: Parse error on line 2: Expecting a node", the source below, a Retry that draws the diagram. tracker.mmd and config.mermaid: "This diagram contains a URL / a %%{ }%% configuration block, so Muster does not draw it. Its source is shown below.", the source, no Retry, and the renderer was never called.
- Test: `packages/agent-app/tests/notebook-mermaid-786-dom.tsx::an invalid Mermaid file shows the error with its source; a file with a URL or configuration is never handed to Mermaid`
- Environment: DOM suite (linkedom) through the real FileTab, with a stand-in Mermaid renderer.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-786l"></a>
#### MUS-SPEC-21-786L: Both previews follow the app theme

- Precondition: analysis.ipynb and flow.mmd open in turn, starting in the dark theme.
- Action: Frame the HTML output, switch to light; open the diagram, switch to dark.
- Expected result: The output document is color-scheme:dark, then re-served color-scheme:light; the diagram is drawn with the light theme, then redrawn with the dark one, and stays drawn.
- Test: `packages/agent-app/tests/notebook-mermaid-786-dom.tsx::both previews follow the app theme: HTML outputs are framed in the active colours and diagrams redraw in light and dark`
- Environment: DOM suite (linkedom); theme tokens are read from the data-theme attribute.
- Known gaps: Pixel colours are not compared; screenshots were not taken (the running app was not used).
- Evidence: UNVERIFIED

### 3D models

<a id="mus-spec-21-366a"></a>
#### MUS-SPEC-21-366A: 3D model preview

- Precondition: A workspace folder holds models/cube.glb (a 24-vertex, 12-triangle cube).
- Action: Open it in a tab, open Model info, turn on Wireframe, choose Front, enter and leave full screen, then close it.
- Expected result: The block goes loading then ready, labelled "3D model · GLB: cube.glb", with a keyboard-reachable canvas and a toolbar holding Reset view, Wireframe, Save image of this view, Model info and the Front, 3/4 view, Top, Right views. Info shows 24 vertices, 12 triangles, size 1.00 × 1.00 × 1.00 and GLB · 2 KiB; Wireframe toggles; a view choice renders a frame; full screen enters and exits; the file is read in one chunk. Closing disposes the engine, releases the GL context and terminates the parse worker.
- Test: `packages/agent-app/tests/model-viewer-dom.tsx::a GLB model opens as an interactive 3D preview: canvas, views, info, wireframe, full screen, released on close`
- Environment: DOM suite (linkedom) built by tests/run-model-viewer-dom.mjs, with a fake WebGL renderer and a stubbed `files.modelChunk` bridge.
- Known gaps: No real GPU draws the model; pixels are not compared.
- Evidence: UNVERIFIED
