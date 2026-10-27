# MUS-SPEC-09: Browser and previews

A chat can open web pages and local app previews in a browser tab inside Muster, and the agent can use that browser.

What the user can do:
- open a URL or a local dev server in a browser tab, with back, forward, reload and dev tools;
- let the agent read, click and type in the page, and pick an element to point the agent at;
- keep sign-ins per workspace, and see the page picture-in-picture while working elsewhere.

Boundaries:
- Each workspace has its own browser storage; one workspace's sign-in does not leak to another.
- A page that hangs does not freeze the app.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-09-611A](09-browser-and-previews.md#mus-spec-09-611a) | A newly opened browser tab's view is given a white background colour. | [`web pages use a white background independent of the app theme`](../../../packages/agent-app/tests/browser-workspace.test.ts) |
| [MUS-SPEC-09-629A](09-browser-and-previews.md#mus-spec-09-629a) | With a live browser preview card on screen, either the card clears the transcript text or the conversation pane has a reserve on that side; a reserve exists only when the card would otherwise cover text. | [`the visible browser preview never covers transcript text`](../../../packages/agent-app/tests/pip-components.tsx) |
| [MUS-SPEC-09-629B](09-browser-and-previews.md#mus-spec-09-629b) | When a card overlaps the text column, the calculated reserve makes the text end one gap short of the card, in a wide pane and in a pane narrower than the column. | [`the smallest reserve that clears the card: the text ends at the card minus the gap`](../../../packages/agent-app/tests/pip-reserve.test.ts) |
| [MUS-SPEC-09-465A](09-browser-and-previews.md#mus-spec-09-465a) | Taking a picture of a frozen tab wakes it first; a tab whose page was dropped to save memory is recreated; an unknown tab gives nothing. | [`frame() on a frozen tab thaws it and on a discarded tab recreates it`](../../../packages/agent-app/tests/browser-workspace-memory.test.ts) |
| [MUS-SPEC-09-465B](09-browser-and-previews.md#mus-spec-09-465b) | A tab an agent tool is using is not frozen when the panel closes and is not discarded to make room; once the agent is done it can be frozen and discarded again. | [`a tab an agent tool is using is neither frozen nor discarded by the memory paths`](../../../packages/agent-app/tests/browser-workspace-memory.test.ts) |
| [MUS-SPEC-09-465C](09-browser-and-previews.md#mus-spec-09-465c) | A lost connection retries read-only browser tools with backoff, never repeats a click, retries a refused connection for any tool, and gives up after three retries. | [`MCP server: connection resets retry read-only tools with backoff but never repeat a click`](../../../packages/agent-app/tests/browser-route-matrix.test.ts) |
| [MUS-SPEC-09-465D](09-browser-and-previews.md#mus-spec-09-465d) | The idle sweep leaves a tab an agent tool just used awake for three minutes, then freezes it. | [`agent use thaws a hidden page; the sweeper refreezes it once idle`](../../../packages/agent-app/tests/browser-freeze.test.ts) |
| [MUS-SPEC-09-564A](09-browser-and-previews.md#mus-spec-09-564a) | A download name with a right-to-left override keeps its real .exe extension and holds no direction control characters. | [`a downloaded file name cannot use text-direction controls to disguise its extension`](../../../packages/agent-app/tests/browser-download-name.test.ts) |
| [MUS-SPEC-09-721A](09-browser-and-previews.md#mus-spec-09-721a) | When an agent clicks a button in a watched tab, an orange cursor glides there first and the click lands under its tip. | [`the agent cursor glides to a button and the press lands under it`](../../../packages/agent-app/tests/agent-cursor.test.ts) |
| [MUS-SPEC-09-721B](09-browser-and-previews.md#mus-spec-09-721b) | Typing shows a ring around the field; after 1.6 s of quiet the cursor fades out and comes back from the same spot. | [`typing rings the field, and the cursor fades once the agent goes quiet, then returns where it was`](../../../packages/agent-app/tests/agent-cursor.test.ts) |
| [MUS-SPEC-09-721C](09-browser-and-previews.md#mus-spec-09-721c) | Screenshots the agent takes never include the cursor, and a tab nobody can see gets no cursor at all. | [`the model never sees its own cursor, and a page nobody watches pays nothing`](../../../packages/agent-app/tests/agent-cursor.test.ts) |
| [MUS-SPEC-09-721D](09-browser-and-previews.md#mus-spec-09-721d) | With Reduce motion on, the cursor moves to each target instantly. | [`with Reduce motion on, the cursor jumps instead of gliding`](../../../packages/agent-app/tests/agent-cursor.test.ts) |

| [MUS-SPEC-09-637A](09-browser-and-previews.md#mus-spec-09-637a) | At 1180px with the sidebar and a tall summary visible, the transcript viewport sits below the preview rather than shrinking below 440px; widening restores its height. | [`a narrow window keeps the transcript below the preview without squeezing its text`](../../../packages/agent-app/tests/pip-components.tsx) |

### Page background

<a id="mus-spec-09-611a"></a>
#### MUS-SPEC-09-611A: Web pages sit on white, not on the app's dark colour

- Precondition: The browser workspace is set up with a fake window and fake page views. Nothing has been opened yet.
- Action: Open a browser tab on a web page.
- Expected result: The page view is given the background colour white (`#ffffff`), whatever the app theme is. A page that sets no background of its own therefore shows white, not the app's dark colour.
- Test: `packages/agent-app/tests/browser-workspace.test.ts::web pages use a white background independent of the app theme`
- Environment: Node test runner; fake window, view and session objects; no Electron and no network.
- Known gaps: The page view is a fake that records the colour it was given. The test does not render a real page, so it shows the colour is set, not that a real page looks white.
- Evidence: UNVERIFIED

### The preview card and the transcript

<a id="mus-spec-09-629a"></a>
#### MUS-SPEC-09-629A: The browser preview does not cover transcript text

- Precondition: A chat has two live browser sessions, so two preview cards show in the corner. The conversation pane is 1000px wide and its text column is 804px, centred.
- Action: Render the app with the preview cards visible.
- Expected result: Either the cards sit clear of the transcript text, or the conversation pane has been given a reserve on the card's side. Space is reserved only when the card would cover text.
- Test: `packages/agent-app/tests/pip-components.tsx::the visible browser preview never covers transcript text`
- Environment: DOM suite (`linkedom`); the native browser views are stubbed and layout sizes are faked, so no real window is used.
- Known gaps: Sizes come from a fake layout, not a real one, so it does not show the look on screen. It checks one pane width and one card size; other sizes are covered only by the calculation test in MUS-SPEC-09-629B.
- Evidence: UNVERIFIED

<a id="mus-spec-09-629b"></a>
#### MUS-SPEC-09-629B: The reserve is the smallest that clears the card

- Precondition: A pane width, a text column width, a window width and a card position and size, once for a wide pane and once for a pane narrower than the column.
- Action: Ask for the reserve for a card that overlaps the text column on the right.
- Expected result: A reserve is returned, and with it the text ends within 1px of one gap short of the card in both panes.
- Test: `packages/agent-app/tests/pip-reserve.test.ts::the smallest reserve that clears the card: the text ends at the card minus the gap`
- Environment: Node test runner; no window or network.
- Known gaps: A unit test of the pure calculation. The other tests in the file cover the no-reserve, left-side and 440px cases, but only this one is linked. MUS-SPEC-09-629A links the screen-level check.
- Evidence: UNVERIFIED

<a id="mus-spec-09-637a"></a>
#### MUS-SPEC-09-637A: Narrow windows keep the transcript clear of the preview

- Precondition: A running chat has two browser previews, an open sidebar and a tall summary card in a window 1180px wide. Clearing the preview horizontally would leave less than 440px for the transcript.
- Action: Resize to that narrow window, hide and show the preview, then widen the window again.
- Expected result: The scrollable transcript viewport starts at least 8px below the entire preview stack, with no extra horizontal reserve. Hiding the preview or widening the window removes the vertical reserve.
- Test: `packages/agent-app/tests/pip-components.tsx::a narrow window keeps the transcript below the preview without squeezing its text`
- Environment: DOM suite (`linkedom`); fake layout dimensions, no Electron or network.
- Known gaps: Layout dimensions are faked. Separate narrow-window screenshots in both themes verify real browser layout.
- Evidence: UNVERIFIED

### The agent's tab survives a closed panel

<a id="mus-spec-09-465a"></a>
#### MUS-SPEC-09-465A: A picture of a frozen or discarded tab wakes or recreates it

- Precondition: A browser tab was hidden, so it is frozen. Other tabs are then opened and hidden until the live-page cap is reached and the first tab's page is discarded.
- Action: Ask for a frame of the frozen tab, then of the discarded tab, then of a tab that does not exist.
- Expected result: The frozen tab is thawed and returns a frame. The discarded tab is recreated and returns a frame. The unknown tab returns nothing.
- Test: `packages/agent-app/tests/browser-workspace-memory.test.ts::frame() on a frozen tab thaws it and on a discarded tab recreates it`
- Environment: Node test runner; a fake browser view and debugger; no Electron.
- Known gaps: Uses fake web contents, so it does not show a real page render.
- Evidence: UNVERIFIED

<a id="mus-spec-09-465b"></a>
#### MUS-SPEC-09-465B: A tab the agent is using is not frozen or discarded

- Precondition: An agent tool has opened a tab, and the user then closes the browser panel. The live-page cap is 2.
- Action: Open and hide more tabs, run the idle discard, then move the clock four minutes past the agent's last use and run the freeze and discard sweeps again.
- Expected result: Closing the panel does not freeze the agent's tab. It keeps its page while other tabs are discarded and while the idle sweep runs. After the agent is idle for the hold time, the tab is frozen and may be discarded.
- Test: `packages/agent-app/tests/browser-workspace-memory.test.ts::a tab an agent tool is using is neither frozen nor discarded by the memory paths`
- Environment: Node test runner; a fake browser view; no Electron.
- Known gaps: Uses fake web contents and a fake clock.
- Evidence: UNVERIFIED

<a id="mus-spec-09-465c"></a>
#### MUS-SPEC-09-465C: Browser tool calls retry safely after a lost connection

- Precondition: The browser tool server's connection fails: a reset on a read-only tool, a reset on a click, a refused connection on a click, and a refused connection on every try.
- Action: Call each through the retry wrapper.
- Expected result: The read-only tool succeeds on the third try. The click after a reset runs once and the error is passed on, so it is never doubled. The click after a refused connection is retried and succeeds on the third try. A call that is always refused is tried four times (the first call and three retries) and then fails.
- Test: `packages/agent-app/tests/browser-route-matrix.test.ts::MCP server: connection resets retry read-only tools with backoff but never repeat a click`
- Environment: Node test runner; a fake tool call, no network. The wait between tries is set to 1 ms.
- Known gaps: Does not use a real tool server.
- Evidence: UNVERIFIED

<a id="mus-spec-09-465d"></a>
#### MUS-SPEC-09-465D: The idle sweep waits three minutes after the agent's last use

- Precondition: A hidden tab was just driven by an agent tool and has been thawed.
- Action: Run the idle freeze sweep 15 seconds later, then again after three more minutes.
- Expected result: The first sweep freezes nothing. The second sweep freezes the tab.
- Test: `packages/agent-app/tests/browser-freeze.test.ts::agent use thaws a hidden page; the sweeper refreezes it once idle`
- Environment: Node test runner; a fake browser view and clock; no Electron.
- Known gaps: Uses fake web contents and a fake clock.
- Evidence: UNVERIFIED

### Downloads

<a id="mus-spec-09-564a"></a>
#### MUS-SPEC-09-564A: A downloaded file name has no hidden text-direction characters

- Precondition: A page offers a download whose name has a right-to-left override character in the middle, so `invoice` + override + `fdp.exe` would read as `invoiceexe.pdf`.
- Action: Work out the file name the in-app browser saves the download under.
- Expected result: The saved name holds no invisible text-direction characters and still ends in `.exe`. A name that starts with an override character and then reads `report.pdf` is saved as `report.pdf`.
- Test: `packages/agent-app/tests/browser-download-name.test.ts::a downloaded file name cannot use text-direction controls to disguise its extension`
- Environment: Node test runner; no network, no provider.
- Known gaps: Calls the name function used by the download handler, not a real download in the browser tab.
- Evidence: UNVERIFIED

### Agent cursor

<a id="mus-spec-09-721a"></a>
#### MUS-SPEC-09-721A: The agent cursor glides to the control and the press lands under it

- Precondition: An in-app browser tab is open and visible, showing a page with two buttons far apart.
- Action: The agent clicks the near button, then the far button.
- Expected result: An orange "Muster" cursor appears at the near button, then glides to the far button in 140–520 ms depending on distance, with a press ring on each click. Both clicks register on the page, and the cursor tip ends at the centre of the far button.
- Test: `packages/agent-app/tests/agent-cursor.test.ts::the agent cursor glides to a button and the press lands under it`
- Environment: Node test runner driving a real headless Chrome over the DevTools protocol; skipped locally when Chrome is not installed.
- Known gaps: Drives the cursor script in a plain Chrome page, not inside the Electron browser pane.
- Evidence: UNVERIFIED

<a id="mus-spec-09-721b"></a>
#### MUS-SPEC-09-721B: Typing rings the field; the cursor fades when the agent goes quiet

- Precondition: A watched tab shows a text field.
- Action: The agent types into the field, then does nothing for two seconds, then clicks again.
- Expected result: A halo ring circles the field while text goes in. After about 1.6 s idle the cursor fades to transparent over about half a second and stops catching anything. The next action brings it back from where it faded.
- Test: `packages/agent-app/tests/agent-cursor.test.ts::typing rings the field, and the cursor fades once the agent goes quiet, then returns where it was`
- Environment: Node test runner driving a real headless Chrome over the DevTools protocol; skipped locally when Chrome is not installed.
- Known gaps: Drives the cursor script in a plain Chrome page, not inside the Electron browser pane.
- Evidence: UNVERIFIED

<a id="mus-spec-09-721c"></a>
#### MUS-SPEC-09-721C: The model never sees its own cursor, and unwatched pages pay nothing

- Precondition: A watched tab with the cursor showing, and a second tab that is not on screen.
- Action: The agent takes a screenshot of the watched tab, then clicks in the hidden tab.
- Expected result: The screenshot has no cursor pixels, and the cursor reappears afterwards. The hidden tab never mounts a cursor element, and its click costs no extra time.
- Test: `packages/agent-app/tests/agent-cursor.test.ts::the model never sees its own cursor, and a page nobody watches pays nothing`
- Environment: Node test runner driving a real headless Chrome over the DevTools protocol; skipped locally when Chrome is not installed.
- Known gaps: Drives the cursor script in a plain Chrome page, not inside the Electron browser pane.
- Evidence: UNVERIFIED

<a id="mus-spec-09-721d"></a>
#### MUS-SPEC-09-721D: Reduce motion makes the cursor jump instead of glide

- Precondition: The system asks for reduced motion.
- Action: The agent clicks two buttons far apart.
- Expected result: The cursor jumps straight to each target with no glide, and the click still lands under it.
- Test: `packages/agent-app/tests/agent-cursor.test.ts::with Reduce motion on, the cursor jumps instead of gliding`
- Environment: Node test runner driving a real headless Chrome over the DevTools protocol; skipped locally when Chrome is not installed.
- Known gaps: Drives the cursor script in a plain Chrome page, not inside the Electron browser pane.
- Evidence: UNVERIFIED
