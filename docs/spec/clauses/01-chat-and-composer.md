# MUS-SPEC-01: Chat and composer

A chat is one conversation with an agent about one folder or worktree. The composer is where the user writes to it.

What the user can do:
- start a chat in a folder, a new worktree or a Project; name, rename, pin, archive, delete, fork and export it;
- write a message with attachments (files, images, sketches), mentions and slash commands, and pick the model, reasoning effort and access mode;
- search chats, move back and forward through them, and import conversations from other tools.

Boundaries:
- How a turn runs once sent is clause [02](02-turns-streaming-and-queue.md). Model choice is clause [03](03-providers-models-and-accounts.md). Access modes are clause [05](05-access-modes-and-approvals.md).
- The composer never loses a draft: a failed send, a restart or switching chats keeps it.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-01-95A](01-chat-and-composer.md#mus-spec-01-95a) | An imported Codex chat and an imported Claude Code chat each record the model and provider their own session ran, in the import note. | [`an imported chat records the model and provider its own session ran`](../../../packages/agent-app/tests/conversation-import.test.ts) |
| [MUS-SPEC-01-95B](01-chat-and-composer.md#mus-spec-01-95b) | The imported-chat note shows the session model and provider as plain text, with no control to change them. | [`the imported chat note shows the session model and provider read-only`](../../../packages/agent-app/tests/import-origin-dom.tsx) |
| [MUS-SPEC-01-554A](01-chat-and-composer.md#mus-spec-01-554a) | The message box has `dir="auto"`, so it follows the direction of what is typed (the draft here is Arabic). | [`the message field follows the direction of what is typed`](../../../packages/agent-app/tests/composer-rtl-dom.tsx) |
| [MUS-SPEC-01-554B](01-chat-and-composer.md#mus-spec-01-554b) | Every chat title in the sidebar has `dir="auto"`, including an Arabic title. | [`sidebar chat titles follow their own text direction`](../../../packages/agent-app/tests/composer-rtl-dom.tsx) |
| [MUS-SPEC-01-554C](01-chat-and-composer.md#mus-spec-01-554c) | Each of your messages in the transcript has `dir="auto"`, for an Arabic message and an English one. | [`each user message takes its text direction from its own first strong character`](../../../packages/agent-app/tests/chat-rtl-dom.tsx) |
| [MUS-SPEC-01-554D](01-chat-and-composer.md#mus-spec-01-554d) | In an Arabic reply, the paragraph, the list and each list item have `dir="auto"`. | [`paragraphs and list items in a reply take their own text direction`](../../../packages/agent-app/tests/chat-rtl-dom.tsx) |
| [MUS-SPEC-01-555A](01-chat-and-composer.md#mus-spec-01-555a) | After a send finishes, the chip that was sent is gone from the composer, and a chip added while the send was in flight is still there. | [`a context chip added while a send is in flight is kept, and only the sent chip is cleared`](../../../packages/agent-app/tests/composer-inflight-chips-dom.tsx) |
| [MUS-SPEC-01-560A](01-chat-and-composer.md#mus-spec-01-560a) | Enter pressed to confirm an IME composition (or the key that follows it) leaves the search palette open and screen unchanged; a plain Enter opens the row. | [`Enter that confirms an IME composition does not open the highlighted search row`](../../../packages/agent-app/tests/ime-enter-dom.tsx) |
| [MUS-SPEC-01-560B](01-chat-and-composer.md#mus-spec-01-560b) | Search highlight ranges cover a whole emoji, merge adjacent emoji, and never split a surrogate pair. | [`fuzzyMatch ranges never cut an emoji in half`](../../../packages/agent-app/tests/spotlight-model.test.ts) |
| [MUS-SPEC-01-599A](01-chat-and-composer.md#mus-spec-01-599a) | In a reply, single newlines in prose, list items and quotes become line breaks; blank lines still split paragraphs; bold is kept; an explicit break is not doubled; code blocks and table rows get no breaks. Both when animated and not. | [`a single newline in assistant prose, lists and quotes shows as a line break`](../../../packages/agent-app/tests/markdown-breaks-dom.tsx) |
| [MUS-SPEC-01-599B](01-chat-and-composer.md#mus-spec-01-599b) | A streamed reply that adds lines one at a time keeps a break for each and fades in only the new lines. | [`streamed text that arrives on a new line still fades in with its line break`](../../../packages/agent-app/tests/markdown-breaks-dom.tsx) |
| [MUS-SPEC-01-670A](01-chat-and-composer.md#mus-spec-01-670a) | Clicking Clone a repository on the folder step closes the guide for the clone sheet and starts no interval timer. | [`cloning from the setup guide hands back through the clone sheet and leaves no background poll`](../../../packages/agent-app/tests/setup-clone-handoff-dom.tsx) |
| [MUS-SPEC-01-670B](01-chat-and-composer.md#mus-spec-01-670b) | After the clone sheet is closed without a clone, a folder that arrives in a later snapshot leaves the setup guide closed after more than a second. | [`a folder added later does not reopen the setup guide after an abandoned clone`](../../../packages/agent-app/tests/setup-clone-handoff-dom.tsx) |
| [MUS-SPEC-01-569A](01-chat-and-composer.md#mus-spec-01-569a) | Searching "checklist" in a message holding "İzmir" returns a highlight range that covers "checklist". | [`the index returns a correct highlight for such a message`](../../../packages/agent-app/tests/chat-search-casefold.test.ts) |
| [MUS-SPEC-01-569B](01-chat-and-composer.md#mus-spec-01-569b) | In "İİİİ İstanbul deploy notes" the one highlight covers "deploy". | [`a snippet after a dotted capital I highlights the matched word itself`](../../../packages/agent-app/tests/chat-search-casefold.test.ts) |
| [MUS-SPEC-01-569C](01-chat-and-composer.md#mus-spec-01-569c) | In a 200-"İ" message the snippet window holds "needle" and the highlight covers it. | [`a long message: the window is centred on the match, not shifted by earlier dotted capitals`](../../../packages/agent-app/tests/chat-search-casefold.test.ts) |
| [MUS-SPEC-01-403A](01-chat-and-composer.md#mus-spec-01-403a) | Generated titles keep question marks, exclamation marks, periods, colons, slashes, hashes and quotation marks through send and completion. | [`sending a first message keeps punctuation in its generated sidebar title`](../../../packages/agent-app/tests/sidebar-chrome-403-dom.tsx) |
| [MUS-SPEC-01-403B](01-chat-and-composer.md#mus-spec-01-403b) | New chat remembers the last selected project folder, avoids broad home folders and submits in the displayed folder. | [`New chat returns to the last project after a folderless or Documents chat`](../../../packages/agent-app/tests/sidebar-chrome-403-dom.tsx) |
| [MUS-SPEC-01-403C](01-chat-and-composer.md#mus-spec-01-403c) | A single turn leaves no stray minimap dash; multi-turn ticks jump to their matching user row and disappear when the conversation shrinks. | [`a one-turn transcript has no lone minimap dash and later turns remain reachable`](../../../packages/agent-app/tests/sidebar-chrome-403-dom.tsx) |
| [MUS-SPEC-01-403D](01-chat-and-composer.md#mus-spec-01-403d) | Duplicate chat names show distinct visible suffix hints, including same-folder chats; unique names stay plain. | [`duplicate sidebar chat names get distinct suffixes without renaming them`](../../../packages/agent-app/tests/sidebar-chrome-403-dom.tsx) |
| [MUS-SPEC-01-792A](01-chat-and-composer.md#mus-spec-01-792a) | A chat with no folder and one plain reply renders no summary card, and `.center` has no `data-summary`, so the transcript and composer keep the full width. | [`a chat with nothing to summarise shows no summary card and reserves no room`](../../../packages/agent-app/tests/summary-card-empty-dom.tsx) |
| [MUS-SPEC-01-792B](01-chat-and-composer.md#mus-spec-01-792b) | When the same chat edits a file, the summary card appears with a Sources section and `.center` gets its `data-summary` layout. | [`the summary card appears once the chat changes a file`](../../../packages/agent-app/tests/summary-card-empty-dom.tsx) |
| [MUS-SPEC-01-840A](01-chat-and-composer.md#mus-spec-01-840a) | Clicking the mic shows the recording state; clicking it again sends the fake recording to `dictation.transcribe`, the words land in the composer, and Enter sends them with `chat.send`. | [`clicking the mic records, the transcript fills the composer, and Enter sends it`](../../../packages/agent-app/tests/composer-dictation-840-dom.tsx) |
| [MUS-SPEC-01-840B](01-chat-and-composer.md#mus-spec-01-840b) | Esc while recording stops the microphone, makes no `dictation.transcribe` call and leaves the draft as it was. | [`Esc while recording cancels and keeps the draft unchanged`](../../../packages/agent-app/tests/composer-dictation-840-dom.tsx) |
| [MUS-SPEC-01-840C](01-chat-and-composer.md#mus-spec-01-840c) | Holding ⌘⇧D records while held and transcribes on release; the words are inserted. | [`holding the dictation shortcut records until the key is released`](../../../packages/agent-app/tests/composer-dictation-840-dom.tsx) |
| [MUS-SPEC-01-840D](01-chat-and-composer.md#mus-spec-01-840d) | When macOS microphone access is denied, the composer says how to turn it on and never opens the microphone. | [`a denied microphone shows how to allow it and records nothing`](../../../packages/agent-app/tests/composer-dictation-840-dom.tsx) |
| [MUS-SPEC-01-840E](01-chat-and-composer.md#mus-spec-01-840e) | While the chat runs, dictated words fill the composer and Enter steers them with `chat.steer`. | [`dictation works in the steer composer while a chat runs`](../../../packages/agent-app/tests/composer-dictation-840-dom.tsx) |
| [MUS-SPEC-01-840F](01-chat-and-composer.md#mus-spec-01-840f) | Settings › Chat shows Dictation; choosing Cloud and saving an endpoint, model and key calls `dictation.config.set`, and the key is not shown back. | [`Settings › Chat chooses the dictation service and saves a cloud key`](../../../packages/agent-app/tests/composer-dictation-840-dom.tsx) |
| [MUS-SPEC-01-840G](01-chat-and-composer.md#mus-spec-01-840g) | The cloud backend posts the audio as a multipart file to `<endpoint>/audio/transcriptions` with the saved key and model, returns the text, and writes no audio to disk or logs. | [`the cloud backend sends the recording to the chosen endpoint and keeps nothing`](../../../packages/agent-app/tests/dictation-840.test.ts) |
| [MUS-SPEC-01-840H](01-chat-and-composer.md#mus-spec-01-840h) | With dictation off or set to an on-device option that is not available, transcribing fails with a clear message and makes no network request. | [`audio never leaves the machine unless a cloud backend is chosen`](../../../packages/agent-app/tests/dictation-840.test.ts) |
| [MUS-SPEC-01-840I](01-chat-and-composer.md#mus-spec-01-840i) | Cloud dictation through a saved OpenAI-compatible connection uses that connection's endpoint and stored key. | [`the cloud backend can use a saved provider connection and its key`](../../../packages/agent-app/tests/dictation-840.test.ts) |
| [MUS-SPEC-01-840J](01-chat-and-composer.md#mus-spec-01-840j) | On macOS, microphone access asks the system once when undecided and returns a System Settings message when denied, without asking. | [`microphone access asks macOS when undecided and explains a denial`](../../../packages/agent-app/tests/microphone-840.test.ts) |
| [MUS-SPEC-01-840K](01-chat-and-composer.md#mus-spec-01-840k) | The window allows a media request only for audio from the app's own page; video, other permissions and other pages are refused. | [`only the app page may open the microphone, and only for audio`](../../../packages/agent-app/tests/microphone-840.test.ts) |

### Imported chats keep their own model

<a id="mus-spec-01-95a"></a>
#### MUS-SPEC-01-95A: An imported chat records the model and provider its session ran

- Precondition: A Codex rollout whose session ran `gpt-6-codex` on provider `openai`, and a Claude Code transcript whose assistant turns ran `claude-fable-5-1`. The app's default model is a different one.
- Action: Import both sessions.
- Expected result: Each chat's import note holds the session's own model and provider (`gpt-6-codex` on `openai`, `claude-fable-5-1` on `anthropic`), not the app default.
- Test: `packages/agent-app/tests/conversation-import.test.ts::an imported chat records the model and provider its own session ran`
- Environment: Node test runner; the agent service with a fake provider; fixture sessions in a temp folder.
- Known gaps: ChatGPT export sessions are not covered (the export names no model). The chat's own model field stays a model Muster can run, so the next message runs on that, not on the imported model.
- Evidence: UNVERIFIED

<a id="mus-spec-01-95b"></a>
#### MUS-SPEC-01-95B: The imported-chat note shows the session model read-only

- Precondition: An imported chat whose import note holds the model `gpt-6-codex` and the provider `openai`.
- Action: Open the chat, and look at the note at the top.
- Expected result: The note names the model and the provider as plain text. It has no button, input or menu for either. A note with no model records shows no model text.
- Test: `packages/agent-app/tests/import-origin-dom.tsx::the imported chat note shows the session model and provider read-only`
- Environment: DOM suite in linkedom; the real ImportOrigin component.
- Known gaps: Does not render the whole chat screen.
- Evidence: UNVERIFIED

### Text direction

<a id="mus-spec-01-554a"></a>
#### MUS-SPEC-01-554A: The message box follows the direction of what is typed

- Precondition: A chat is open and its draft is Arabic text.
- Action: Render the composer.
- Expected result: The message box has `dir="auto"`, so Arabic text lines up on the right and English text on the left.
- Test: `packages/agent-app/tests/composer-rtl-dom.tsx::the message field follows the direction of what is typed`
- Environment: Real Composer and Sidebar in a DOM suite (linkedom); fake app bridge; no network.
- Known gaps: Checks the `dir` attribute only. Real text layout and the caret are decided by the browser and are not tested.
- Evidence: UNVERIFIED

<a id="mus-spec-01-554b"></a>
#### MUS-SPEC-01-554B: Chat titles in the sidebar follow their own direction

- Precondition: The sidebar lists a chat called "مراجعة الملف" and a chat with an English title.
- Action: Render the sidebar.
- Expected result: Every chat title in the list has `dir="auto"`.
- Test: `packages/agent-app/tests/composer-rtl-dom.tsx::sidebar chat titles follow their own text direction`
- Environment: Real Composer and Sidebar in a DOM suite (linkedom); fake app bridge; no network.
- Known gaps: Checks the `dir` attribute only, not how the browser lays the title out.
- Evidence: UNVERIFIED

<a id="mus-spec-01-554c"></a>
#### MUS-SPEC-01-554C: Each message in the transcript follows its own direction

- Precondition: The transcript holds an Arabic user message and an English user message.
- Action: Render the transcript.
- Expected result: Both user messages have `dir="auto"`. Each one decides its direction from its own first strong character, not from the app language.
- Test: `packages/agent-app/tests/chat-rtl-dom.tsx::each user message takes its text direction from its own first strong character`
- Environment: Real transcript component in a DOM suite (linkedom); no network.
- Known gaps: Checks the `dir` attribute only. Does not cover the Markdown body of a reply (see MUS-SPEC-01-554D).
- Evidence: UNVERIFIED

<a id="mus-spec-01-554d"></a>
#### MUS-SPEC-01-554D: Paragraphs and lists in a reply follow their own direction

- Precondition: The transcript holds an Arabic reply with a paragraph and a two-item bullet list.
- Action: Render the transcript.
- Expected result: The paragraph, the list and each list item have `dir="auto"`, so the bullet markers switch sides with the text.
- Test: `packages/agent-app/tests/chat-rtl-dom.tsx::paragraphs and list items in a reply take their own text direction`
- Environment: Real transcript component in a DOM suite (linkedom); no network.
- Known gaps: Checks the `dir` attribute on the first paragraph, list and item only. Code blocks and tables are not covered.
- Evidence: UNVERIFIED

### Context chips and sending

<a id="mus-spec-01-555a"></a>
#### MUS-SPEC-01-555A: Context added while a message is sending is kept

- Precondition: A context chip ("sent-chip") is on the composer and the draft has text. The user presses send, and the send has not finished yet.
- Action: Add a second context chip ("late-chip") while the send is in flight, then let the send finish.
- Expected result: The composer's context area no longer shows "sent-chip", and still shows "late-chip" for the next message. Before the change, both were cleared.
- Test: `packages/agent-app/tests/composer-inflight-chips-dom.tsx::a context chip added while a send is in flight is kept, and only the sent chip is cleared`
- Environment: Real Composer in a DOM suite (linkedom); fake app bridge with a send that waits until released; no network.
- Known gaps: Uses the app bridge fake, not a running agent. It covers a selection chip only; the in-text mention chips use the same fix but are not tested.
- Evidence: UNVERIFIED

### Typing with an IME and emoji

<a id="mus-spec-01-560a"></a>
#### MUS-SPEC-01-560A: Enter that confirms an IME composition does not run the search row

- Precondition: The search palette is open with the query "OSS-12", so one row is highlighted.
- Action: Press Enter flagged as part of a composition; then Enter with key code 229 (the key event some browsers send right after the composition ends); then a plain Enter.
- Expected result: The first two keys do nothing: the screen stays the same and the palette stays open. The plain Enter opens the row.
- Test: `packages/agent-app/tests/ime-enter-dom.tsx::Enter that confirms an IME composition does not open the highlighted search row`
- Environment: Real SpotlightSearchHost in a DOM suite (linkedom); fake app bridge; no network.
- Known gaps: Only the search palette is driven. The same helper is applied to quick open, chat and folder rename, the branch picker, the owner picker and the add-resource menu, and those have no test here. Real IME input is not tested; the events are made by hand.
- Evidence: UNVERIFIED

<a id="mus-spec-01-560b"></a>
#### MUS-SPEC-01-560B: Search highlights keep an emoji whole

- Precondition: The search text is an emoji, or two emoji in a row, and the result text has them inside other letters.
- Action: Match the text and split the result into highlighted and plain parts.
- Expected result: The highlight covers the whole emoji (both halves of its surrogate pair). Adjacent emoji form one span. Every part is well-formed text.
- Test: `packages/agent-app/tests/spotlight-model.test.ts::fuzzyMatch ranges never cut an emoji in half`
- Environment: Node test runner; no UI and no network.
- Known gaps: Unit test of the matcher and the splitter, not the rendered highlight in the palette.
- Evidence: UNVERIFIED

### Line breaks in replies

<a id="mus-spec-01-599a"></a>
#### MUS-SPEC-01-599A: A single newline in a reply shows as a line break

- Precondition: An assistant reply has three lines with no blank line between them (with bold and inline code), a list item that continues on the next line, a two-line quote, a line that ends with an explicit Markdown break, a fenced code block, an indented code block and a two-row table.
- Action: Render the reply, once plain and once with the streaming fade turned on.
- Expected result: The first paragraph holds 2 line breaks and keeps its bold text. A blank line still starts a new paragraph. The list item and the quote each hold 1 line break. The explicit break gives 1 line break, not 2. Both code blocks keep their text with the newline inside, no break element appears in code or the table, and the table still has its two rows.
- Test: `packages/agent-app/tests/markdown-breaks-dom.tsx::a single newline in assistant prose, lists and quotes shows as a line break`
- Environment: Real MessageBody in a DOM suite (linkedom); no network.
- Known gaps: Checks the break elements in the DOM, not how the text is laid out on screen. The code and table assertions already hold on main (they guard against over-fixing). The same suite also checks that a Markdown file opened as a document keeps soft breaks as spaces; that check passes on main too, so it carries no case.
- Evidence: UNVERIFIED

<a id="mus-spec-01-599b"></a>
#### MUS-SPEC-01-599B: Streamed lines keep their break and still fade in

- Precondition: A reply is streaming and has one line of text.
- Action: A second, then a third line arrive, one at a time.
- Expected result: The new lines ("Line two arrives" and "Line three") fade in, the first line does not, and the reply holds 2 line breaks.
- Test: `packages/agent-app/tests/markdown-breaks-dom.tsx::streamed text that arrives on a new line still fades in with its line break`
- Environment: Real MessageBody in a DOM suite (linkedom); no network.
- Known gaps: Does not run a real stream; the test sends the growing text itself. The fade is checked by its class, not by looking at it.
- Evidence: UNVERIFIED

### Cloning from the setup guide (#670)

<a id="mus-spec-01-670a"></a>
#### MUS-SPEC-01-670A: Cloning from the setup guide leaves no background timer

- Precondition: The setup guide is open on the folder step, with git available and no folder added yet.
- Action: Click "Clone a repository…".
- Expected result: The guide closes to make room for the clone sheet, and no interval timer is started, so nothing keeps watching for new folders in the background.
- Test: `packages/agent-app/tests/setup-clone-handoff-dom.tsx::cloning from the setup guide hands back through the clone sheet and leaves no background poll`
- Environment: DOM suite on linkedom, built and run by scripts/test-renderer.mjs; the runtime is a fake; no network or git.
- Known gaps: Does not run a clone to the end, so it does not show the guide reopening on the folder step when the clone lands or the new "setup continues once it lands" hint. It counts calls to setInterval during the click, so a timer made another way is not seen.
- Evidence: UNVERIFIED

<a id="mus-spec-01-670b"></a>
#### MUS-SPEC-01-670B: A folder added later does not reopen the setup guide

- Precondition: The user clicked "Clone a repository…" from the setup guide, so the guide is closed, and then closed the clone sheet without cloning.
- Action: A new folder arrives in an app snapshot (added another way), and the test waits 1.3 seconds.
- Expected result: The setup guide is still closed.
- Test: `packages/agent-app/tests/setup-clone-handoff-dom.tsx::a folder added later does not reopen the setup guide after an abandoned clone`
- Environment: DOM suite on linkedom, built and run by scripts/test-renderer.mjs; the runtime is a fake; no network or git.
- Known gaps: The 1.3 second wait covers the old one-second poll but not its 10-minute limit. It does not show a finished clone reopening the guide.
- Evidence: UNVERIFIED

### Search highlights

<a id="mus-spec-01-569a"></a>
#### MUS-SPEC-01-569A: Chat search highlights the right word in a message with "İ"

- Precondition: A chat message reads "İzmir İzmir release checklist".
- Action: Search the chat index for "checklist".
- Expected result: The first hit's highlight range covers exactly "checklist".
- Test: `packages/agent-app/tests/chat-search-casefold.test.ts::the index returns a correct highlight for such a message`
- Environment: Node test runner; no network, no provider.
- Known gaps: Checks the range from the index, not the highlight drawn in the search panel.
- Evidence: UNVERIFIED

<a id="mus-spec-01-569b"></a>
#### MUS-SPEC-01-569B: A snippet after "İİİİ" highlights the matched word

- Precondition: Text that starts with several dotted capital I letters.
- Action: Build the search snippet for "deploy".
- Expected result: There is one highlight range and it covers exactly "deploy".
- Test: `packages/agent-app/tests/chat-search-casefold.test.ts::a snippet after a dotted capital I highlights the matched word itself`
- Environment: Node test runner; no network, no provider.
- Known gaps: Tests the snippet builder directly.
- Evidence: UNVERIFIED

<a id="mus-spec-01-569c"></a>
#### MUS-SPEC-01-569C: A long message with many "İ" shows the match in its snippet

- Precondition: A message with 200 "İ" characters, filler, then "needle here".
- Action: Build the search snippet for "needle".
- Expected result: One highlight range, covering exactly "needle".
- Test: `packages/agent-app/tests/chat-search-casefold.test.ts::a long message: the window is centred on the match, not shifted by earlier dotted capitals`
- Environment: Node test runner; no network, no provider.
- Known gaps: Tests the snippet builder directly.
- Evidence: UNVERIFIED

### Sidebar and conversation chrome

<a id="mus-spec-01-403a"></a>
#### MUS-SPEC-01-403A: Generated titles keep question marks, exclamation marks, periods, colons, slashes, hashes and quotation marks through send and completion.

- Precondition: A new chat draft and a temporary durable chat store.
- Action: Send first messages containing punctuation, finish each exchange and inspect the sidebar title.
- Expected result: The generated sidebar titles keep their punctuation both during and after the exchange; a custom rename still wins.
- Test: `packages/agent-app/tests/sidebar-chrome-403-dom.tsx::sending a first message keeps punctuation in its generated sidebar title`
- Environment: The renderer bridge uses the real AgentStore title lifecycle with a scripted send; no external provider.
- Known gaps: No external provider or native desktop; browser screenshots cover both themes separately.
- Evidence: local; node packages/agent-app/dist/tests/sidebar-chrome-403-dom/sidebar-chrome-403-dom.mjs; exit 0; 4 passed, 0 failed, 0 skipped; commit 3d6bdf75f2454256e508cbebff87d2d923443774

<a id="mus-spec-01-403b"></a>
#### MUS-SPEC-01-403B: New chat remembers the last selected project folder, avoids broad home folders and submits in the displayed folder.

- Precondition: Two project folders, a folderless chat and an old chat in the home Documents folder.
- Action: Select a project chat, switch to a folderless chat and open New chat; send, then repeat from Documents and after removing the remembered folder.
- Expected result: The draft and chat.create use the last selected valid project folder. Explicit No folder remains available; missing folders and broad home paths are never implicit defaults.
- Test: `packages/agent-app/tests/sidebar-chrome-403-dom.tsx::New chat returns to the last project after a folderless or Documents chat`
- Environment: DOM suite with a fake runtime and in-memory browser storage; no desktop or filesystem writes.
- Known gaps: No external provider or native desktop; browser screenshots cover both themes separately.
- Evidence: local; node packages/agent-app/dist/tests/sidebar-chrome-403-dom/sidebar-chrome-403-dom.mjs; exit 0; 4 passed, 0 failed, 0 skipped; commit 3d6bdf75f2454256e508cbebff87d2d923443774

<a id="mus-spec-01-403c"></a>
#### MUS-SPEC-01-403C: A single turn leaves no stray minimap dash; multi-turn ticks jump to their matching user row and disappear when the conversation shrinks.

- Precondition: A transcript with one user message and its reply.
- Action: Render it, add another exchange, click each turn marker, then replace it with a one-turn and empty transcript.
- Expected result: No turn tick for zero or one turn. Each tick in a longer conversation targets its own user row; conversation search still opens for a single turn.
- Test: `packages/agent-app/tests/sidebar-chrome-403-dom.tsx::a one-turn transcript has no lone minimap dash and later turns remain reachable`
- Environment: DOM suite rendering the real Timeline with virtualized layout measurements.
- Known gaps: No external provider or native desktop; browser screenshots cover both themes separately.
- Evidence: local; node packages/agent-app/dist/tests/sidebar-chrome-403-dom/sidebar-chrome-403-dom.mjs; exit 0; 4 passed, 0 failed, 0 skipped; commit 3d6bdf75f2454256e508cbebff87d2d923443774

<a id="mus-spec-01-403d"></a>
#### MUS-SPEC-01-403D: Duplicate chat names show distinct visible suffix hints, including same-folder chats; unique names stay plain.

- Precondition: Chats with the same title across folders and inside one folder, plus a unique title.
- Action: Render the sidebar, select duplicate rows, then rename one chat so its title becomes unique.
- Expected result: Every duplicate has a distinct visible suffix; selection still targets the correct chat, titles remain verbatim and the obsolete hint disappears.
- Test: `packages/agent-app/tests/sidebar-chrome-403-dom.tsx::duplicate sidebar chat names get distinct suffixes without renaming them`
- Environment: DOM suite rendering the real Sidebar; no provider or desktop.
- Known gaps: No external provider or native desktop; browser screenshots cover both themes separately.
- Evidence: local; node packages/agent-app/dist/tests/sidebar-chrome-403-dom/sidebar-chrome-403-dom.mjs; exit 0; 4 passed, 0 failed, 0 skipped; commit 3d6bdf75f2454256e508cbebff87d2d923443774

### Summary card with nothing to summarise (#792)

<a id="mus-spec-01-792a"></a>
#### MUS-SPEC-01-792A: A chat with nothing to summarise shows no summary card

- Precondition: A chat with no folder, no changed files, no processes, no subagents and no tasks has one user message and one reply that used no tools.
- Action: Open the chat.
- Expected result: No `.summary-card` is rendered, and `.center` has no `data-summary` attribute, so no room is reserved beside the transcript and the composer is not shifted. Before the change, an empty card (`<div class="summary-card-body"></div>`) rendered with `data-summary="reserve"`.
- Test: `packages/agent-app/tests/summary-card-empty-dom.tsx::a chat with nothing to summarise shows no summary card and reserves no room`
- Environment: Real SummaryCard inside a `.center` element in a DOM suite (linkedom); fake app bridge; no network.
- Known gaps: Layout width is not measured in linkedom, so the check is on the `data-summary` attribute that drives the reserve CSS, not on pixel positions.
- Evidence: local; node packages/agent-app/dist/tests/summary-card-empty-dom.mjs; exit 0; 2 passed, 0 failed, 0 skipped; commit 51d98019fafa5b2fe3842c1acb1a3e7c3cbe9d56

<a id="mus-spec-01-792b"></a>
#### MUS-SPEC-01-792B: The summary card appears as soon as there is a section

- Precondition: The chat from MUS-SPEC-01-792A is open with no summary card.
- Action: A completed tool row that edits `src/app.ts` arrives in the chat's timeline.
- Expected result: The summary card renders with a Sources section listing `app.ts`, and `.center` has a `data-summary` layout value.
- Test: `packages/agent-app/tests/summary-card-empty-dom.tsx::the summary card appears once the chat changes a file`
- Environment: Real SummaryCard inside a `.center` element in a DOM suite (linkedom); fake app bridge; no network.
- Known gaps: Covers the Sources section only; folders, processes, subagents and scheduled automations use the same visibility check but are not each tested here.
- Evidence: local; node packages/agent-app/dist/tests/summary-card-empty-dom.mjs; exit 0; 2 passed, 0 failed, 0 skipped; commit 51d98019fafa5b2fe3842c1acb1a3e7c3cbe9d56

### Dictation (#840)

<a id="mus-spec-01-840a"></a>
#### MUS-SPEC-01-840A: Clicking the mic records and the transcript fills the composer

- Precondition: A chat is open with an empty draft. Dictation is set to Cloud and ready. The microphone is allowed. A fake MediaRecorder stands in for the microphone and a fake `dictation.transcribe` returns "ship the release notes".
- Action: Click the mic, then click it again, then press Enter.
- Expected result: While recording, the mic has `aria-pressed="true"` and the status line says Listening and that Esc cancels. After the second click the recording (as base64 webm) goes to `dictation.transcribe`, the status shows Transcribing, and then the composer holds "ship the release notes". The fake microphone track is stopped. Enter calls `chat.send` with that text.
- Test: `packages/agent-app/tests/composer-dictation-840-dom.tsx::clicking the mic records, the transcript fills the composer, and Enter sends it`
- Environment: Real Composer in a DOM suite (linkedom); fake MediaRecorder, fake getUserMedia and fake app bridge; no network, no real microphone.
- Known gaps: A real MediaRecorder, real audio and the system microphone prompt are not exercised; that needs the packaged app.
- Evidence: UNVERIFIED

<a id="mus-spec-01-840b"></a>
#### MUS-SPEC-01-840B: Esc while recording cancels dictation

- Precondition: A chat is open with the draft "keep me". Dictation is ready.
- Action: Click the mic, then press Esc in the composer.
- Expected result: Recording stops, the fake microphone track is stopped, `dictation.transcribe` is never called, the mic is no longer pressed, and the draft is still "keep me".
- Test: `packages/agent-app/tests/composer-dictation-840-dom.tsx::Esc while recording cancels and keeps the draft unchanged`
- Environment: Real Composer in a DOM suite (linkedom); fake MediaRecorder and app bridge; no network, no real microphone.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-01-840c"></a>
#### MUS-SPEC-01-840C: Holding the dictation shortcut records until it is released

- Precondition: A chat is open with an empty draft. Dictation is ready.
- Action: In the composer press ⌘⇧D, hold it for longer than the hold threshold, then release D.
- Expected result: Recording starts on the key press and stops on release; the recording is transcribed and the words are inserted into the composer.
- Test: `packages/agent-app/tests/composer-dictation-840-dom.tsx::holding the dictation shortcut records until the key is released`
- Environment: Real Composer in a DOM suite (linkedom); fake MediaRecorder and app bridge; no network, no real microphone.
- Known gaps: A quick tap toggles recording on instead; that path is not asserted here. Key repeat timing of a real keyboard is not simulated.
- Evidence: UNVERIFIED

<a id="mus-spec-01-840d"></a>
#### MUS-SPEC-01-840D: A denied microphone shows how to allow it

- Precondition: Dictation is ready but `dictation.microphone` reports that macOS denied access.
- Action: Click the mic.
- Expected result: The composer shows a message that names System Settings › Privacy & Security › Microphone, getUserMedia is never called and the mic is not pressed.
- Test: `packages/agent-app/tests/composer-dictation-840-dom.tsx::a denied microphone shows how to allow it and records nothing`
- Environment: Real Composer in a DOM suite (linkedom); fake app bridge; no network, no real microphone.
- Known gaps: The real macOS prompt and System Settings pane are not shown in tests.
- Evidence: UNVERIFIED

<a id="mus-spec-01-840e"></a>
#### MUS-SPEC-01-840E: Dictation works in the steer composer

- Precondition: The chat is running and Enter while running is set to Steer. Dictation is ready.
- Action: Click the mic twice, then press Enter.
- Expected result: The transcript fills the composer, and Enter calls `chat.steer` with it (not `chat.send`).
- Test: `packages/agent-app/tests/composer-dictation-840-dom.tsx::dictation works in the steer composer while a chat runs`
- Environment: Real Composer in a DOM suite (linkedom); fake MediaRecorder and app bridge; no network, no real microphone.
- Known gaps: The new-chat screen uses the same dictation hook but is not driven here.
- Evidence: UNVERIFIED

<a id="mus-spec-01-840f"></a>
#### MUS-SPEC-01-840F: Settings › Chat chooses the dictation service

- Precondition: Settings is open on Chat. Dictation is Off.
- Action: Choose Cloud, enter an endpoint, a model and an API key, and press Save.
- Expected result: `dictation.config.set` is called with backend `cloud`, the endpoint, the model and the key; after saving, the key field is empty and the row says a key is saved. The description says audio leaves the computer only for a cloud service.
- Test: `packages/agent-app/tests/composer-dictation-840-dom.tsx::Settings › Chat chooses the dictation service and saves a cloud key`
- Environment: Real PreferencesScreen in a DOM suite (linkedom); fake app bridge; no network.
- Known gaps: Keychain encryption of the key is covered by the secret store's own tests, not here.
- Evidence: UNVERIFIED

<a id="mus-spec-01-840g"></a>
#### MUS-SPEC-01-840G: The cloud backend sends the recording and keeps nothing

- Precondition: Dictation is set to Cloud with endpoint host `speech.example` (path `/v1`), model `whisper-1` and a saved key, in a temp data folder. A fake fetch answers `{"text":"hello there"}`.
- Action: Call `dictation.transcribe` with a base64 webm recording.
- Expected result: One POST goes to that endpoint's `/v1/audio/transcriptions` with `Authorization: Bearer <key>` and a multipart body holding the audio file and the model; the result is "hello there". No file in the data folder holds the audio bytes, and nothing logged to the console holds them.
- Test: `packages/agent-app/tests/dictation-840.test.ts::the cloud backend sends the recording to the chosen endpoint and keeps nothing`
- Environment: Runtime dictation domain with real files in a temp folder; fake fetch and an in-memory secret box; no network.
- Known gaps: A real transcription service is not called; its answer shape is the OpenAI-compatible `{text}`.
- Evidence: UNVERIFIED

<a id="mus-spec-01-840h"></a>
#### MUS-SPEC-01-840H: Audio stays on the machine unless a cloud backend is chosen

- Precondition: Dictation is Off; then it is set to macOS on-device, which this build does not ship.
- Action: Call `dictation.transcribe` in each state.
- Expected result: Each call fails with a message that says how to choose a dictation service, and the fake fetch is never called.
- Test: `packages/agent-app/tests/dictation-840.test.ts::audio never leaves the machine unless a cloud backend is chosen`
- Environment: Runtime dictation domain with a temp folder; fake fetch; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-01-840i"></a>
#### MUS-SPEC-01-840I: Cloud dictation can use a saved provider connection

- Precondition: A saved OpenAI-compatible connection has endpoint host `router.example` (path `/v1`) and a key in the secret store. Dictation is set to Cloud through that connection.
- Action: Call `dictation.transcribe`.
- Expected result: The POST goes to `/v1/audio/transcriptions` on `router.example` with that connection's key.
- Test: `packages/agent-app/tests/dictation-840.test.ts::the cloud backend can use a saved provider connection and its key`
- Environment: Runtime dictation domain with a temp folder; fake connection list, fake fetch and in-memory secret box; no network.
- Known gaps: Whether a given router supports transcription is only known when it answers; a 404 is reported as unsupported.
- Evidence: UNVERIFIED

<a id="mus-spec-01-840j"></a>
#### MUS-SPEC-01-840J: Microphone access asks macOS when undecided

- Precondition: On macOS, microphone access is first not determined, then denied.
- Action: Call the main process microphone check in each state.
- Expected result: Not determined: `askForMediaAccess('microphone')` is called and its answer is returned. Denied: it is not called, and the message names System Settings › Privacy & Security › Microphone.
- Test: `packages/agent-app/tests/microphone-840.test.ts::microphone access asks macOS when undecided and explains a denial`
- Environment: Main-process helper with a fake systemPreferences; no Electron, no real microphone.
- Known gaps: The Info.plist usage string and the audio-input entitlement are only checked in a packaged build.
- Evidence: UNVERIFIED

<a id="mus-spec-01-840k"></a>
#### MUS-SPEC-01-840K: Only the app page may open the microphone

- Precondition: The main window's permission handler is set.
- Action: Ask for media with audio only from the app page, with video, with another permission, and from another page.
- Expected result: Only the audio-only request from the app's own page in its window is allowed.
- Test: `packages/agent-app/tests/microphone-840.test.ts::only the app page may open the microphone, and only for audio`
- Environment: Main-process helper with plain inputs; no Electron.
- Known gaps: None known.
- Evidence: UNVERIFIED
