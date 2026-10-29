# MUS-SPEC-21: Visuals and artifacts

Replies can hold more than text: diagrams, charts, device frames, 3D models, canvases and artifacts the agent builds.

What the user can do:
- see diagrams and charts drawn from a reply, and code blocks with syntax colouring;
- open artifacts and canvases in a tab, and share or export them;
- see app previews inside device frames.

Boundaries:
- A visual that fails to render shows its source and a plain error, never a blank space.
- Device models and frames are downloaded at run time, never bundled.
- LibreOffice for rendering office documents is never bundled: a copy the user installed is used, otherwise a pinned, checksummed official build is downloaded on first use into Muster's own data folder. Another app's home or cache is never read.

## Acceptance cases

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-21-43A](21-visuals-and-artifacts.md#mus-spec-21-43a) | "Back to chat" on a side chat opens its parent conversation and keeps the side chat tab open. | [`Back to chat opens the parent conversation and keeps the side chat tab`](../../../packages/agent-app/tests/side-chat-back-dom.tsx) |
| [MUS-SPEC-21-43B](21-visuals-and-artifacts.md#mus-spec-21-43b) | A side chat with no parent, or whose parent chat is gone, shows no "Back to chat" control. | [`No Back to chat control without a parent conversation`](../../../packages/agent-app/tests/side-chat-back-dom.tsx) |
| [MUS-SPEC-21-789A](21-visuals-and-artifacts.md#mus-spec-21-789a) | A LibreOffice the user installed (standard location or on PATH) is used, even when Muster also downloaded one, and ensuring the runtime makes no request. | [`a LibreOffice the user installed is used and nothing is downloaded`](../../../packages/agent-app/tests/office-runtime-789.test.ts) |
| [MUS-SPEC-21-789B](21-visuals-and-artifacts.md#mus-spec-21-789b) | With no LibreOffice, the pinned build downloads into Muster's data folder with downloading, verifying and installing progress; concurrent calls share one download. | [`the pinned LibreOffice downloads into Muster's data folder with progress`](../../../packages/agent-app/tests/office-runtime-789.test.ts) |
| [MUS-SPEC-21-789C](21-visuals-and-artifacts.md#mus-spec-21-789c) | An interrupted download keeps its bytes and the next attempt asks only for the rest; a server that ignores ranges restarts the file. | [`an interrupted download resumes from the partial file`](../../../packages/agent-app/tests/office-runtime-789.test.ts) |
| [MUS-SPEC-21-789D](21-visuals-and-artifacts.md#mus-spec-21-789d) | A download whose SHA-256 does not match the pin is rejected, deleted and never unpacked. | [`a download that fails its checksum is rejected and deleted`](../../../packages/agent-app/tests/office-runtime-789.test.ts) |
| [MUS-SPEC-21-789E](21-visuals-and-artifacts.md#mus-spec-21-789e) | A failed or empty unpack leaves no staging or install folder; a good unpack appears in one rename with its manifest. | [`a failed unpack leaves no half-installed runtime`](../../../packages/agent-app/tests/office-runtime-789.test.ts) |
| [MUS-SPEC-21-789F](21-visuals-and-artifacts.md#mus-spec-21-789f) | Remove deletes Muster's downloaded copy and any partial download, reports the bytes freed, and never touches the user's own LibreOffice. | [`remove deletes only Muster's downloaded copy`](../../../packages/agent-app/tests/office-runtime-789.test.ts) |
| [MUS-SPEC-21-789G](21-visuals-and-artifacts.md#mus-spec-21-789g) | Every path the runtime probes is a standard install location, a PATH entry or inside Muster's own folder; no candidate is a hidden folder in the home folder. | [`another app's runtime folders are never probed`](../../../packages/agent-app/tests/office-runtime-789.test.ts) |
| [MUS-SPEC-21-789H](21-visuals-and-artifacts.md#mus-spec-21-789h) | The document preview gets soffice from the office runtime, and without one it reports LibreOffice missing with a pointer to Settings and does not download by itself. | [`the document preview finds soffice through the office runtime`](../../../packages/agent-app/tests/office-runtime-789.test.ts) |
| [MUS-SPEC-21-789I](21-visuals-and-artifacts.md#mus-spec-21-789i) | An office file renders to a PDF and real PNG page images in the output folder; the source is unchanged and the temp folder is removed; a PDF is rasterized directly and the page cap is honoured. | [`rendering an office file gives page images and cleans its temp folder`](../../../packages/agent-app/tests/office-runtime-789.test.ts) |
| [MUS-SPEC-21-789J](21-visuals-and-artifacts.md#mus-spec-21-789j) | A render that runs past its timeout rejects, tells the conversion to stop, removes its temp folder and writes nothing to the output folder; a failed conversion cleans up the same way. | [`a render that runs past its timeout stops and leaves no temp files`](../../../packages/agent-app/tests/office-runtime-789.test.ts) |
| [MUS-SPEC-21-789K](21-visuals-and-artifacts.md#mus-spec-21-789k) | The Settings commands report source, version and size; download returns at once and sends progress events; remove returns to none. | [`Settings commands report the runtime and download it in the background`](../../../packages/agent-app/tests/office-runtime-789.test.ts) |
| [MUS-SPEC-21-789L](21-visuals-and-artifacts.md#mus-spec-21-789l) | macOS, Linux and Windows on Intel and ARM each have a pinned official LibreOffice build with an https documentfoundation.org URL, a SHA-256 and a plausible size; other platforms have none. | [`every pinned LibreOffice build is an official https download with a SHA-256`](../../../packages/agent-app/tests/office-runtime-789.test.ts) |

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

### Office runtime (#789)

<a id="mus-spec-21-789a"></a>
#### MUS-SPEC-21-789A: A LibreOffice the user installed is used

- Precondition: LibreOffice is in a standard install location or on PATH. Muster's own copy may also be downloaded.
- Action: Ask the runtime for soffice, ensure it, and read its status.
- Expected result: The user's soffice is returned, no download request is made, and the status says the source is installed.
- Test: `packages/agent-app/tests/office-runtime-789.test.ts::a LibreOffice the user installed is used and nothing is downloaded`
- Environment: Install locations and PATH are temp folders; the network is a fake.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-789b"></a>
#### MUS-SPEC-21-789B: First use downloads the pinned LibreOffice with progress

- Precondition: No LibreOffice is installed and Muster has not downloaded one.
- Action: Ensure the runtime twice at the same time, then again.
- Expected result: One download of the pinned build is made from its first URL, progress goes from 0 to the full size and then through verifying and installing, soffice is inside Muster's data folder, the status says downloaded with the pinned version and its size, and the archive is deleted after install.
- Test: `packages/agent-app/tests/office-runtime-789.test.ts::the pinned LibreOffice downloads into Muster's data folder with progress`
- Environment: Fake download server and fake unpacker; a temp data folder. Nothing is downloaded for real.
- Known gaps: The real hdiutil, tar and msiexec unpack and the real network are not exercised; a manual smoke covers macOS.
- Evidence: UNVERIFIED

<a id="mus-spec-21-789c"></a>
#### MUS-SPEC-21-789C: An interrupted download resumes

- Precondition: A download dropped its connection part way through.
- Action: Ensure the runtime again.
- Expected result: The kept bytes are reported as a partial download, the next request asks for `bytes=<kept>-`, progress starts from the kept bytes, and the install completes. A server that answers the range with the whole file gets a fresh file, not an appended copy.
- Test: `packages/agent-app/tests/office-runtime-789.test.ts::an interrupted download resumes from the partial file`
- Environment: Fake download server that drops the connection once; no network.
- Known gaps: The real hdiutil, tar and msiexec unpack and the real network are not exercised; a manual smoke covers macOS.
- Evidence: UNVERIFIED

<a id="mus-spec-21-789d"></a>
#### MUS-SPEC-21-789D: A download that fails its checksum is deleted

- Precondition: The server sends bytes that differ from the pinned build.
- Action: Ensure the runtime, then try again.
- Expected result: The attempt fails with a checksum error, nothing is unpacked, the file is deleted, the status shows the error and no partial bytes, and the next attempt starts from zero.
- Test: `packages/agent-app/tests/office-runtime-789.test.ts::a download that fails its checksum is rejected and deleted`
- Environment: Fake download server; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-789e"></a>
#### MUS-SPEC-21-789E: Install is atomic

- Precondition: The download is complete and correct.
- Action: Unpack fails part way, then unpacks nothing, then unpacks correctly.
- Expected result: After each failure the data folder holds no staging or install folder and the status says none. After the good unpack exactly one install folder for the pinned version exists, with its manifest, and no staging folder is left.
- Test: `packages/agent-app/tests/office-runtime-789.test.ts::a failed unpack leaves no half-installed runtime`
- Environment: Fake unpacker; temp data folder.
- Known gaps: The real hdiutil, tar and msiexec unpack and the real network are not exercised; a manual smoke covers macOS.
- Evidence: UNVERIFIED

<a id="mus-spec-21-789f"></a>
#### MUS-SPEC-21-789F: Remove deletes only Muster's copy

- Precondition: Muster downloaded LibreOffice; separately, only the user's own install exists; separately, a download was interrupted.
- Action: Remove the runtime.
- Expected result: Muster's install folder is gone and the status says none; with only the user's install nothing is removed and their soffice is still there; a partial download is deleted.
- Test: `packages/agent-app/tests/office-runtime-789.test.ts::remove deletes only Muster's downloaded copy`
- Environment: Fake download server and unpacker; temp folders.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-789g"></a>
#### MUS-SPEC-21-789G: Another app's runtime folders are never probed

- Precondition: No LibreOffice is installed and no other app's runtime is present.
- Action: Read the status, ensure the runtime and read the status again, recording every path probed. List the install locations for macOS, Linux and Windows and the document preview's list.
- Expected result: No probed path is outside the allowed set, no candidate is in a hidden folder of the home folder, and Muster's own soffice is available.
- Test: `packages/agent-app/tests/office-runtime-789.test.ts::another app's runtime folders are never probed`
- Environment: Recording probe; fake download server and unpacker.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-789h"></a>
#### MUS-SPEC-21-789H: The document preview uses the office runtime

- Precondition: The office runtime is set for the preview and has no copy yet.
- Action: Look up soffice for a preview, download the runtime, and look it up again.
- Expected result: The first lookup fails with the LibreOffice-missing message that names Settings and makes no request; after the download the lookup returns Muster's soffice.
- Test: `packages/agent-app/tests/office-runtime-789.test.ts::the document preview finds soffice through the office runtime`
- Environment: Fake download server and unpacker.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-789i"></a>
#### MUS-SPEC-21-789I: Rendering gives page images

- Precondition: A .docx file and a PDF.
- Action: Render each.
- Expected result: soffice runs headless with an isolated profile to convert to PDF, pdf.js draws page-1.png and page-2.png (real PNG bytes), the PDF is written next to them, the temp folder is empty and the source is unchanged. The PDF needs no LibreOffice and maxPages limits the images.
- Test: `packages/agent-app/tests/office-runtime-789.test.ts::rendering an office file gives page images and cleans its temp folder`
- Environment: soffice is a fake that writes a fixture PDF; pdf.js and its canvas run for real in Node.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-789j"></a>
#### MUS-SPEC-21-789J: A render past its timeout stops and cleans up

- Precondition: A conversion that never finishes, and one that fails.
- Action: Render with a short timeout.
- Expected result: The render rejects with a timed-out message well before the test limit, the conversion is aborted, the temp folder is empty and the output folder has no files. A failed conversion leaves the temp folder empty too.
- Test: `packages/agent-app/tests/office-runtime-789.test.ts::a render that runs past its timeout stops and leaves no temp files`
- Environment: Fake conversion that waits for its abort signal.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-789k"></a>
#### MUS-SPEC-21-789K: Settings shows and downloads the runtime

- Precondition: The office domain runs with no LibreOffice.
- Action: Read the status, start the download, wait for it, then remove.
- Expected result: The first status says none with the pinned version and size, download returns while downloading, progress events with received bytes arrive, the last event is idle with source downloaded under Muster's data folder, and remove reports none.
- Test: `packages/agent-app/tests/office-runtime-789.test.ts::Settings commands report the runtime and download it in the background`
- Environment: Office domain with fake download server and unpacker; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-21-789l"></a>
#### MUS-SPEC-21-789L: Pinned builds are official and checksummed

- Precondition: The pinned build table in the office runtime.
- Action: Look up the build for each platform and processor.
- Expected result: Each has the pinned version, a 64-character SHA-256, a size between 100 MB and 500 MB and only download.documentfoundation.org or downloadarchive.documentfoundation.org URLs; an unknown platform has no build.
- Test: `packages/agent-app/tests/office-runtime-789.test.ts::every pinned LibreOffice build is an official https download with a SHA-256`
- Environment: None; reads constants.
- Known gaps: None known.
- Evidence: UNVERIFIED
