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
| [MUS-SPEC-21-788A](21-visuals-and-artifacts.md#mus-spec-21-788a) | Right-click on the gallery hero, a gallery thumbnail, a gallery file link, a tool-row thumbnail, an inline reply image and the open image viewer each asks for the image menu, with that image's chat and path. | [`Right-click on every chat image surface asks for the image menu with its path`](../../../packages/agent-app/tests/image-context-menu-788-dom.tsx) |
| [MUS-SPEC-21-788B](21-visuals-and-artifacts.md#mus-spec-21-788b) | Cmd+C in the open image viewer asks the app to copy the shown image to the clipboard. | [`Cmd+C in the image viewer copies the image`](../../../packages/agent-app/tests/image-context-menu-788-dom.tsx) |
| [MUS-SPEC-21-788C](21-visuals-and-artifacts.md#mus-spec-21-788c) | The ContextMenu key and Shift+F10 on a focused image ask for the image menu, placed at the image. | [`ContextMenu key and Shift+F10 open the image menu on a focused image`](../../../packages/agent-app/tests/image-context-menu-788-dom.tsx) |
| [MUS-SPEC-21-788D](21-visuals-and-artifacts.md#mus-spec-21-788d) | When the file is gone, choosing Copy image copies the picture already shown in the chat. | [`A missing file copies the image from its loaded pixels`](../../../packages/agent-app/tests/image-context-menu-788-dom.tsx) |
| [MUS-SPEC-21-788E](21-visuals-and-artifacts.md#mus-spec-21-788e) | The native image menu has Copy image, Copy path, Reveal in Finder, an Open with submenu of the apps for images, Save as and Open in Canvas, all enabled for a file on disk. | [`The image menu lists Copy image, Copy path, Reveal, Open with, Save as and Open in Canvas`](../../../packages/agent-app/tests/image-context-menu-788.test.ts) |
| [MUS-SPEC-21-788F](21-visuals-and-artifacts.md#mus-spec-21-788f) | Copy image writes the picture itself to the clipboard; Copy path writes the absolute path the runtime resolved. | [`Copy image puts the picture on the clipboard and Copy path the absolute path`](../../../packages/agent-app/tests/image-context-menu-788.test.ts) |
| [MUS-SPEC-21-788G](21-visuals-and-artifacts.md#mus-spec-21-788g) | When the file is gone, Reveal, Open with, Save as and Open in Canvas are disabled, the menu says why, and Copy image and Copy path stay enabled. | [`A missing file disables file actions with a reason and keeps Copy image`](../../../packages/agent-app/tests/image-context-menu-788.test.ts) |
| [MUS-SPEC-21-788H](21-visuals-and-artifacts.md#mus-spec-21-788h) | Reveal and Open with act on the absolute path the runtime resolved, and an image path outside its folder or not named by the chat is refused before any action. | [`Reveal and Open with use the path the runtime checked, never the renderer's`](../../../packages/agent-app/tests/image-context-menu-788.test.ts) |
| [MUS-SPEC-21-788I](21-visuals-and-artifacts.md#mus-spec-21-788i) | Save as asks where to save, named after the image, and copies the file there; cancelling writes nothing. | [`Save as copies the file to the place the user picks`](../../../packages/agent-app/tests/image-context-menu-788.test.ts) |
| [MUS-SPEC-21-361A](21-visuals-and-artifacts.md#mus-spec-21-361a) | A closed mermaid fence in a reply draws as a diagram block with its title; while the reply is still streaming the fence stays a code block. | [`a closed mermaid fence in a reply draws as a diagram; while streaming it stays code`](../../../packages/agent-app/tests/rich-block-components.tsx) |
| [MUS-SPEC-21-361B](21-visuals-and-artifacts.md#mus-spec-21-361b) | A mermaid fence that does not parse shows the "Couldn’t render this diagram" card with the parse error and a Show source control that reveals the source. | [`an invalid mermaid fence shows the error card with the parse error and its source`](../../../packages/agent-app/tests/rich-block-components.tsx) |
| [MUS-SPEC-21-361C](21-visuals-and-artifacts.md#mus-spec-21-361c) | A chart fence in the short form draws a Vega chart with its title and kind, offers a Table view of the data, and disposes the chart view when it is switched away or unmounted. | [`a chart fence draws a Vega chart with its title, a table view and disposal on unmount`](../../../packages/agent-app/tests/rich-block-components.tsx) |
| [MUS-SPEC-21-361D](21-visuals-and-artifacts.md#mus-spec-21-361d) | An html-report frame is sandboxed to scripts only (no same-origin, popups, forms or top navigation), sends no referrer, grants no permissions, and is served from its own muster-report origin; a page that must not run gets an empty sandbox. | [`a report frame is scripts-only: no same-origin, served from its own muster-report origin`](../../../packages/agent-app/tests/rich-block-components.tsx) |
| [MUS-SPEC-21-361E](21-visuals-and-artifacts.md#mus-spec-21-361e) | The report origin serves every report with a content security policy that allows no network and no way out of the sandbox. | [`the CSP allows no network at all and no way out of the sandbox`](../../../packages/agent-app/tests/report-origin.test.ts) |
| [MUS-SPEC-21-361F](21-visuals-and-artifacts.md#mus-spec-21-361f) | A chart whose category axis has no sort keeps the rows in the order the reply wrote them (Jan to Jun stays Jan to Jun); an explicit sort and quantitative or temporal channels are left as written. | [`charts: categories keep the data order unless the spec sorts them (months are not alphabetised)`](../../../packages/agent-app/tests/rich-block.test.ts) |
| [MUS-SPEC-21-361G](21-visuals-and-artifacts.md#mus-spec-21-361g) | A report's title decodes HTML entities once (`&amp;lt;` stays `&lt;`) and keeps no tag, even one split to survive a single strip. | [`reports: a title decodes entities once and never keeps a tag`](../../../packages/agent-app/tests/rich-block.test.ts) |
| [MUS-SPEC-21-578A](21-visuals-and-artifacts.md#mus-spec-21-578a) | A render_html page draws inline in the chat as a "Page" block: mounted when it nears the viewport, scripts-only sandbox, the app theme in the frame URL, a network opt-in note, the standard chrome, and full screen with zoom. | [`a render_html page draws inline in the chat: themed, scripts-only sandbox, mounted near the viewport, full screen with zoom`](../../../packages/agent-app/tests/html-preview-components.tsx) |
| [MUS-SPEC-21-578B](21-visuals-and-artifacts.md#mus-spec-21-578b) | preview_open with a URL opens the agent's browser tab, shows the live mini player (or the right pane when asked), refuses non-web URLs, and reports plainly when the server is not running. | [`preview_open(url) opens the agent tab, shows the mini player (or the pane) and reports an unreachable server`](../../../packages/agent-app/tests/html-preview.test.ts) |
| [MUS-SPEC-21-366A](21-visuals-and-artifacts.md#mus-spec-21-366a) | A GLB file opens as an interactive 3D preview: canvas, camera views, model info, wireframe, full screen, and all graphics and worker resources released on close. | [`a GLB model opens as an interactive 3D preview: canvas, views, info, wireframe, full screen, released on close`](../../../packages/agent-app/tests/model-viewer-dom.tsx) |
| [MUS-SPEC-21-785A](21-visuals-and-artifacts.md#mus-spec-21-785a) | Inline and display formulas typeset with their labels; display maths scrolls sideways; prices, shell variables, code and links stay as written. | [`a reply typesets inline and display maths, labelled, with display maths scrolling sideways`](../../../packages/agent-app/tests/markdown-math-dom.tsx) |
| [MUS-SPEC-21-785B](21-visuals-and-artifacts.md#mus-spec-21-785b) | Prices and shell variables stay plain text; code spans, code blocks and links are untouched. | [`maths parsing: prices, shell variables, code, escapes and links stay text`](../../../packages/agent-app/tests/markdown-math.test.ts) |
| [MUS-SPEC-21-785C](21-visuals-and-artifacts.md#mus-spec-21-785c) | The four delimiters typeset as inline or display formulas. | [`maths parsing: the four delimiters, display blocks and source offsets`](../../../packages/agent-app/tests/markdown-math.test.ts) |
| [MUS-SPEC-21-785D](21-visuals-and-artifacts.md#mus-spec-21-785d) | While a reply streams, an unfinished formula shows as its source. | [`maths parsing: an unfinished formula stays text at every point of a streaming reply`](../../../packages/agent-app/tests/markdown-math.test.ts) |
| [MUS-SPEC-21-785E](21-visuals-and-artifacts.md#mus-spec-21-785e) | TeX pipes inside a table cell do not break the table; a display equation's `=` line is not read as a heading. | [`maths parsing: TeX pipes stay in their table cell and a display = line is not a heading`](../../../packages/agent-app/tests/markdown-math.test.ts) |
| [MUS-SPEC-21-785F](21-visuals-and-artifacts.md#mus-spec-21-785f) | While a reply streams an unfinished formula shows as its source; invalid TeX shows its source. | [`a streaming formula shows its source until it closes, and invalid TeX shows its source`](../../../packages/agent-app/tests/markdown-math-dom.tsx) |
| [MUS-SPEC-21-785G](21-visuals-and-artifacts.md#mus-spec-21-785g) | Copying a selection that includes a formula copies the whole TeX source with its delimiters; the same for Mermaid diagrams. | [`copying a selection with maths or a diagram gives back the TeX and the fenced source`](../../../packages/agent-app/tests/markdown-math-dom.tsx) |
| [MUS-SPEC-21-785H](21-visuals-and-artifacts.md#mus-spec-21-785h) | Replies render formulas, on by default. | [`maths is on by default and the Chat setting turns it off`](../../../packages/agent-app/tests/markdown-math-dom.tsx) |

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

### Image context menu

<a id="mus-spec-21-788a"></a>
#### MUS-SPEC-21-788A: Right-click on any chat image opens the image menu

- Precondition: A chat shows images in a turn gallery (hero, thumbnail strip and file links), in a tool row's thumbnails, inline in a reply, and in the zoomed image viewer.
- Action: Right-click each image.
- Expected result: Each right-click asks the app for one image menu, sent with the chat, the path the chat named and, for a folder image, the folder and its folder-relative path. The browser's own context menu is suppressed.
- Test: `packages/agent-app/tests/image-context-menu-788-dom.tsx::Right-click on every chat image surface asks for the image menu with its path`
- Environment: DOM suite (linkedom) with a stubbed bridge; no provider or network.
- Known gaps: The native menu itself is not drawn in this suite; its items are checked in MUS-SPEC-21-788E. Images from a connected server (attachment links) are not covered.
- Evidence: UNVERIFIED

<a id="mus-spec-21-788b"></a>
#### MUS-SPEC-21-788B: Cmd+C in the image viewer copies the image

- Precondition: The zoomed image viewer is open on a chat image.
- Action: Press Cmd+C (Ctrl+C off macOS) with no text selected.
- Expected result: The app is asked to copy that image (by its chat and path) as a picture.
- Test: `packages/agent-app/tests/image-context-menu-788-dom.tsx::Cmd+C in the image viewer copies the image`
- Environment: DOM suite (linkedom) with a stubbed bridge; no provider or network.
- Known gaps: The system clipboard itself is checked in MUS-SPEC-21-788F, not here.
- Evidence: UNVERIFIED

<a id="mus-spec-21-788c"></a>
#### MUS-SPEC-21-788C: The keyboard opens the image menu

- Precondition: A chat image has keyboard focus.
- Action: Press the ContextMenu key, then Shift+F10.
- Expected result: Each press asks for the image menu for that image, once, and the key does nothing else.
- Test: `packages/agent-app/tests/image-context-menu-788-dom.tsx::ContextMenu key and Shift+F10 open the image menu on a focused image`
- Environment: DOM suite (linkedom) with a stubbed bridge; no provider or network.
- Known gaps: Keyboard movement inside the native menu is the operating system's and is not tested.
- Evidence: UNVERIFIED

<a id="mus-spec-21-788d"></a>
#### MUS-SPEC-21-788D: Copy image falls back to the loaded picture when the file is gone

- Precondition: An image in an older chat was shown, and its file has since been deleted.
- Action: Right-click it and choose Copy image.
- Expected result: The app reports the file is missing and the chat sends the picture it already loaded, so Copy image still works.
- Test: `packages/agent-app/tests/image-context-menu-788-dom.tsx::A missing file copies the image from its loaded pixels`
- Environment: DOM suite (linkedom) with a stubbed bridge; no provider or network.
- Known gaps: The suite cannot decode real pixels, so it sends the loaded data URL as is; turning a scaled thumbnail into PNG runs only in the app.
- Evidence: UNVERIFIED

<a id="mus-spec-21-788e"></a>
#### MUS-SPEC-21-788E: The image menu lists every action

- Precondition: A chat image whose file exists, and an app that opens images is installed.
- Action: Open the image menu.
- Expected result: The menu holds the six actions in order, Open with lists the installed image apps, and every action is enabled.
- Test: `packages/agent-app/tests/image-context-menu-788.test.ts::The image menu lists Copy image, Copy path, Reveal, Open with, Save as and Open in Canvas`
- Environment: Node test with a fake runtime, menu, clipboard and dialog; no Electron.
- Known gaps: The real native menu drawing is not tested.
- Evidence: UNVERIFIED

<a id="mus-spec-21-788f"></a>
#### MUS-SPEC-21-788F: Copy image and Copy path use the system clipboard

- Precondition: A chat image whose file exists.
- Action: Choose Copy image, then Copy path.
- Expected result: The clipboard gets an image made from the file on disk, then the absolute path as text.
- Test: `packages/agent-app/tests/image-context-menu-788.test.ts::Copy image puts the picture on the clipboard and Copy path the absolute path`
- Environment: Node test with a fake runtime, menu, clipboard and dialog; no Electron.
- Known gaps: Pasting into another app is not tested.
- Evidence: UNVERIFIED

<a id="mus-spec-21-788g"></a>
#### MUS-SPEC-21-788G: A missing file disables file actions with a reason

- Precondition: A chat image whose file has been deleted.
- Action: Open the image menu.
- Expected result: File actions are disabled, a disabled line says the file is no longer on disk, Copy image stays enabled and asks the chat for its loaded picture.
- Test: `packages/agent-app/tests/image-context-menu-788.test.ts::A missing file disables file actions with a reason and keeps Copy image`
- Environment: Node test with a fake runtime, menu, clipboard and dialog; no Electron.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-788h"></a>
#### MUS-SPEC-21-788H: File actions use only paths the runtime checked

- Precondition: A chat image inside a folder, a path that escapes the folder with `..`, and an absolute path the chat never named.
- Action: Choose Reveal and Open with on the first; ask for the menu on the other two.
- Expected result: Reveal shows the resolved file, Open with opens it in the chosen app, and the other two are refused with no menu and no file action.
- Test: `packages/agent-app/tests/image-context-menu-788.test.ts::Reveal and Open with use the path the runtime checked, never the renderer's`
- Environment: Node test with a fake runtime, menu, clipboard and dialog, and the runtime files domain over a temporary folder; no Electron.
- Known gaps: Finder itself is not opened.
- Evidence: UNVERIFIED

<a id="mus-spec-21-788i"></a>
#### MUS-SPEC-21-788I: Save as writes a copy where the user picks

- Precondition: A chat image whose file exists.
- Action: Choose Save as, pick a place; then choose Save as again and cancel.
- Expected result: The file is copied to the chosen place once; the cancelled save writes nothing.
- Test: `packages/agent-app/tests/image-context-menu-788.test.ts::Save as copies the file to the place the user picks`
- Environment: Node test with a fake runtime, menu, clipboard and dialog; no Electron.
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

### Maths in replies

<a id="mus-spec-21-785a"></a>
#### MUS-SPEC-21-785A: Inline and display maths typeset

- Precondition: An assistant reply holds `$x^2$`, `\(y_1\)` and a `$$…$$` display block, plus prices, a shell variable, a code span and a link.
- Action: Show the reply; then show one whose TeX uses `\href{javascript:…}` and `\htmlClass`.
- Expected result: The three formulas are typeset by KaTeX: inline ones are groups labelled "Inline equation", the display one is labelled "Display equation", is display style, sits in a horizontal scroller that takes keyboard focus, and carries MathML with its TeX annotation. Prices, `$HOME`, the code span and the link stay as written. TeX makes no `javascript:` link and no injected class.
- Test: `packages/agent-app/tests/markdown-math-dom.tsx::a reply typesets inline and display maths, labelled, with display maths scrolling sideways`
- Environment: DOM suite (linkedom) with a stubbed bridge and the real KaTeX.
- Known gaps: linkedom has no layout: that a long display formula actually scrolls, and the focus ring, are styling and are not measured.
- Evidence: UNVERIFIED

<a id="mus-spec-21-785b"></a>
#### MUS-SPEC-21-785B: Prices, shell variables, code and links stay text

- Precondition: Prose with prices (`$5 and $10`, `$5-$10`, `$1,000,$2,000`), shell variables (`$HOME`, `${PATH}`, `$(pwd)`), code spans, indented code, links, autolinks, escaped dollars and citations like `\[1\]`.
- Action: Parse each with the parser replies use.
- Expected result: None of them becomes a formula and each keeps its text as written; a real formula later on the same line as a price still is one; a link or autolink keeps a `$` in its destination.
- Test: `packages/agent-app/tests/markdown-math.test.ts::maths parsing: prices, shell variables, code, escapes and links stay text`
- Environment: Node test of the remark pipeline (remark-parse, remark-gfm, remark-math on the patched tokenizer); no DOM.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-785c"></a>
#### MUS-SPEC-21-785C: The four delimiters and display blocks

- Precondition: Text with `$…$`, `\(…\)`, `$$…$$` and `\[…\]`, display blocks on their own lines, formulas ending in a comma, TeX escapes and CRLF line ends.
- Action: Parse each.
- Expected result: Inline and display formulas come out in order with their TeX; Markdown block syntax inside a display block stays TeX; source offsets match the original text for every line ending.
- Test: `packages/agent-app/tests/markdown-math.test.ts::maths parsing: the four delimiters, display blocks and source offsets`
- Environment: Node test of the remark pipeline; no DOM.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-785d"></a>
#### MUS-SPEC-21-785D: An unfinished formula stays text while streaming

- Precondition: A reply with an inline and a display formula, cut at every character as a stream would deliver it.
- Action: Parse every prefix.
- Expected result: No prefix throws; an unclosed `\(`, `$$` or `\[` stays text; once closed the formulas are read; a ```math fence counts only once closed.
- Test: `packages/agent-app/tests/markdown-math.test.ts::maths parsing: an unfinished formula stays text at every point of a streaming reply`
- Environment: Node test of the remark pipeline; no DOM.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-785e"></a>
#### MUS-SPEC-21-785E: TeX pipes in tables and a display = line

- Precondition: Tables whose cells hold `$|x|$`, `\(\frac{1}{|x|}\)`, `\|x\|`, a formula opened in one row and closed in a later one, and literal dollars in links and code; a `\[ … \]` block whose middle line is a lone `=`.
- Action: Parse each.
- Expected result: Every row keeps its cell count; a pipe inside a formula stays in its cell; a formula split across rows is text; the display block is one formula, not a setext heading.
- Test: `packages/agent-app/tests/markdown-math.test.ts::maths parsing: TeX pipes stay in their table cell and a display = line is not a heading`
- Environment: Node test of the remark pipeline; no DOM.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-785f"></a>
#### MUS-SPEC-21-785F: Streaming and invalid formulas show their source

- Precondition: A reply streams `Energy \(E = mc`, then `… \(E = mc^2\) and $$\sum_i`, then the whole text; another reply holds invalid TeX (`$\frac{1}$`) beside a valid formula.
- Action: Show each stage, then the reply with invalid TeX.
- Expected result: An unfinished formula is never rendered: its source shows; the closed one typesets while the open display one stays as written; invalid TeX shows its source exactly as written, with no KaTeX error box.
- Test: `packages/agent-app/tests/markdown-math-dom.tsx::a streaming formula shows its source until it closes, and invalid TeX shows its source`
- Environment: DOM suite (linkedom) with a stubbed bridge and the real KaTeX.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-785g"></a>
#### MUS-SPEC-21-785G: Copy keeps the TeX and the diagram source

- Precondition: A reply with an inline formula, a display formula, a mermaid fence and prose, all rendered.
- Action: Copy a selection across the whole reply, part of one formula, a part inside the diagram, and plain prose only.
- Expected result: The whole-reply copy is the Markdown as written: TeX with its own delimiters and the diagram as its fenced source; the HTML flavour carries the TeX, not the glyphs or the SVG. Part of a formula copies the whole formula; a selection inside the diagram copies its fence; plain prose is left to the browser.
- Test: `packages/agent-app/tests/markdown-math-dom.tsx::copying a selection with maths or a diagram gives back the TeX and the fenced source`
- Environment: DOM suite (linkedom) with a stubbed bridge and a stub Mermaid renderer; the selection is a stand-in that clones the nodes a browser selection would.
- Known gaps: linkedom has no selection: the stand-in clones whole nodes, so a selection that starts mid-word is not exercised. Pasting into another app is not tested. Formulas inside Mermaid labels are drawn by Mermaid's own KaTeX and are not asserted here.
- Evidence: UNVERIFIED

<a id="mus-spec-21-785h"></a>
#### MUS-SPEC-21-785H: Maths is on by default and can be turned off

- Precondition: Fresh settings.
- Action: Read the default, turn off "Typeset maths in replies" (Settings › Chat), show a reply with maths, then turn it back on.
- Expected result: The setting is on by default; with it off the reply shows its TeX as written and nothing is typeset; turning it back on typesets the formulas.
- Test: `packages/agent-app/tests/markdown-math-dom.tsx::maths is on by default and the Chat setting turns it off`
- Environment: DOM suite (linkedom) with a stubbed bridge.
- Known gaps: The Settings row itself is not clicked in this suite.
- Evidence: UNVERIFIED
