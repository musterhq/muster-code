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
