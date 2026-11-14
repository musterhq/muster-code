# MUS-SPEC-09: Browser and previews

A chat can open web pages and local app previews in a browser tab inside Muster, and the agent can use that browser.

What the user can do:
- open a URL or a local dev server in a browser tab, with back, forward, reload and dev tools;
- let the agent read, click and type in the page, and pick an element to point the agent at;
- keep sign-ins per workspace, and see the page picture-in-picture while working elsewhere.
- fill a sign-in form from their own 1Password; agents never see the password.

Boundaries:
- Each workspace has its own browser storage; one workspace's sign-in does not leak to another.
- A page that hangs does not freeze the app.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-09-611A](09-browser-and-previews.md#mus-spec-09-611a) | A newly opened browser tab's view is given a white background colour. | [`web pages use a white background independent of the app theme`](../../../packages/agent-app/tests/browser-workspace.test.ts) |
| [MUS-SPEC-09-629A](09-browser-and-previews.md#mus-spec-09-629a) | With a live browser preview card on screen, either the card clears the transcript text or the conversation pane has a reserve on that side; a reserve exists only when the card would otherwise cover text. | [`the visible browser preview never covers transcript text`](../../../packages/agent-app/tests/pip-components.tsx) |
| [MUS-SPEC-09-629B](09-browser-and-previews.md#mus-spec-09-629b) | When a card overlaps the text column, the calculated reserve makes the text end one gap short of the card, in a wide pane and in a pane narrower than the column. | [`the smallest reserve that clears the card: the text ends at the card minus the gap`](../../../packages/agent-app/tests/pip-reserve.test.ts) |
| [MUS-SPEC-09-637A](09-browser-and-previews.md#mus-spec-09-637a) | At 1180px with the sidebar and a tall summary visible, the transcript viewport sits below the preview rather than shrinking below 440px; widening restores its height. | [`a narrow window keeps the transcript below the preview without squeezing its text`](../../../packages/agent-app/tests/pip-components.tsx) |
| [MUS-SPEC-09-465A](09-browser-and-previews.md#mus-spec-09-465a) | Taking a picture of a frozen tab wakes it first; a tab whose page was dropped to save memory is recreated; an unknown tab gives nothing. | [`frame() on a frozen tab thaws it and on a discarded tab recreates it`](../../../packages/agent-app/tests/browser-workspace-memory.test.ts) |
| [MUS-SPEC-09-465B](09-browser-and-previews.md#mus-spec-09-465b) | A tab an agent tool is using is not frozen when the panel closes and is not discarded to make room; once the agent is done it can be frozen and discarded again. | [`a tab an agent tool is using is neither frozen nor discarded by the memory paths`](../../../packages/agent-app/tests/browser-workspace-memory.test.ts) |
| [MUS-SPEC-09-465C](09-browser-and-previews.md#mus-spec-09-465c) | A lost connection retries read-only browser tools with backoff, never repeats a click, retries a refused connection for any tool, and gives up after three retries. | [`MCP server: connection resets retry read-only tools with backoff but never repeat a click`](../../../packages/agent-app/tests/browser-route-matrix.test.ts) |
| [MUS-SPEC-09-465D](09-browser-and-previews.md#mus-spec-09-465d) | The idle sweep leaves a tab an agent tool just used awake for three minutes, then freezes it. | [`agent use thaws a hidden page; the sweeper refreezes it once idle`](../../../packages/agent-app/tests/browser-freeze.test.ts) |
| [MUS-SPEC-09-564A](09-browser-and-previews.md#mus-spec-09-564a) | A download name with a right-to-left override keeps its real .exe extension and holds no direction control characters. | [`a downloaded file name cannot use text-direction controls to disguise its extension`](../../../packages/agent-app/tests/browser-download-name.test.ts) |
| [MUS-SPEC-09-721A](09-browser-and-previews.md#mus-spec-09-721a) | When an agent clicks a button in a watched tab, an orange cursor glides there first and the click lands under its tip. | [`the agent cursor glides to a button and the press lands under it`](../../../packages/agent-app/tests/agent-cursor.test.ts) |
| [MUS-SPEC-09-721B](09-browser-and-previews.md#mus-spec-09-721b) | Typing shows a ring around the field; after 1.6 s of quiet the cursor fades out and comes back from the same spot. | [`typing rings the field, and the cursor fades once the agent goes quiet, then returns where it was`](../../../packages/agent-app/tests/agent-cursor.test.ts) |
| [MUS-SPEC-09-721C](09-browser-and-previews.md#mus-spec-09-721c) | Screenshots the agent takes never include the cursor, and a tab nobody can see gets no cursor at all. | [`the model never sees its own cursor, and a page nobody watches pays nothing`](../../../packages/agent-app/tests/agent-cursor.test.ts) |
| [MUS-SPEC-09-721D](09-browser-and-previews.md#mus-spec-09-721d) | With Reduce motion on, the cursor moves to each target instantly. | [`with Reduce motion on, the cursor jumps instead of gliding`](../../../packages/agent-app/tests/agent-cursor.test.ts) |
| [MUS-SPEC-09-843A](09-browser-and-previews.md#mus-spec-09-843a) | The key menu lists only the 1Password logins saved for the page's site (subdomains included; other sites, look-alike hosts and an https login on an http page excluded), with title and username but no password. | [`the key menu offers only logins saved for this site, never their passwords`](../../../packages/agent-app/tests/browser-passwords-843.test.ts) |
| [MUS-SPEC-09-843B](09-browser-and-previews.md#mus-spec-09-843b) | Choosing a login fills its username and password into the page's sign-in form with real input events; `op` is run as `item get <id> --vault <vault> --format json` and an invalid id never runs it. | [`choosing a login fills the sign-in form from 1Password`](../../../packages/agent-app/tests/browser-passwords-843.test.ts) |
| [MUS-SPEC-09-843C](09-browser-and-previews.md#mus-spec-09-843c) | After a fill, the agent's snapshot, typing result and screenshot never reveal the password, even when the page switches the field to plain text or the field has no label. | [`after a fill the agent never reads the password: snapshot, typing and screenshot stay masked`](../../../packages/agent-app/tests/browser-passwords-843.test.ts) |
| [MUS-SPEC-09-843D](09-browser-and-previews.md#mus-spec-09-843d) | A login saved for another site, a page that navigated away while 1Password was asked, and a page with no sign-in form are refused and nothing is typed. | [`a fill is refused when the login is for another site or the page changed meanwhile`](../../../packages/agent-app/tests/browser-passwords-843.test.ts) |
| [MUS-SPEC-09-843E](09-browser-and-previews.md#mus-spec-09-843e) | A fill emits and returns no password, keeps no page form state in the tab's saved history, writes nothing containing it to disk, and no agent browser tool can trigger it. | [`a fill leaves no password in events, saved history, files or agent tools`](../../../packages/agent-app/tests/browser-passwords-843.test.ts) |
| [MUS-SPEC-09-843F](09-browser-and-previews.md#mus-spec-09-843f) | The browser toolbar's key button lists matching logins and choosing one asks main to fill it; without the 1Password CLI it says so. | [`the key button lists matching logins and fills the chosen one`](../../../packages/agent-app/tests/browser-passwords-843-dom.tsx) |
| [MUS-SPEC-09-843G](09-browser-and-previews.md#mus-spec-09-843g) | A value is typed only into the field focused for it: when the page moves focus to another field before the value lands, nothing is typed there, the fill stops and says the page changed during the fill. | [`a value is typed only into the field focused for it; focus moved by the page stops the fill`](../../../packages/agent-app/tests/browser-passwords-843.test.ts) |
| [MUS-SPEC-09-147A](09-browser-and-previews.md#mus-spec-09-147a) | Forwarding a host port returns a `http://127.0.0.1:<port>` URL that reaches the host’s server, is listed, and stops working once closed. | [`a port on the SSH host opens on 127.0.0.1 through a forward`](../../../packages/agent-app/tests/ssh-workspaces-147.test.ts) |

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
- Evidence: local; ~/.muster-work/review/637/green-pip.txt; exit 0; 2 passed, 0 failed, 0 skipped; commit d84d030210ccc9ce29ea7a7398654a006ab5cee3

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

### Passwords

<a id="mus-spec-09-843a"></a>
#### MUS-SPEC-09-843A: The key menu offers only logins saved for the site

- Precondition: A fake `op` CLI on disk returns four Login items: one for `example.test`, one for `accounts.example.test` with an `https` URL, one for `example.test.evil.invalid`, and one for `other.invalid`. No real password manager is used.
- Action: Ask for the logins for the page `app.example.test/login` over https, then for `example.test/login` over plain http.
- Expected result: The `https` page gets the `example.test` login (it covers subdomains) but not the look-alike or other sites; the `http` page gets no `https`-only login. Each entry carries id, vault, title and username only, and the whole reply contains no password. `op` was run as `item list --categories Login --format json`.
- Test: `packages/agent-app/tests/browser-passwords-843.test.ts::the key menu offers only logins saved for this site, never their passwords`
- Environment: Node test runner; a fake `op` script that logs its arguments; no Electron, no network.
- Known gaps: Matching compares host names (with subdomains) and scheme; it does not use the public suffix list, so a login saved for a whole shared domain would match its subdomains. The real `op` JSON shape is reproduced from 1Password CLI 2 output, not recorded live.
- Evidence: UNVERIFIED

<a id="mus-spec-09-843b"></a>
#### MUS-SPEC-09-843B: Choosing a login fills the sign-in form

- Precondition: A real headless Chrome shows a test sign-in page with an email field, a password field and listeners that count input events. The fake `op` returns the chosen item with a username and a password.
- Action: Fill the `example.test` login into the page; separately, ask to fill an id that is not a 1Password item id.
- Expected result: The email and password fields hold the item's values and each got trusted input events. `op` was run as `item get <id> --vault <vault> --format json`. The malformed id is refused before `op` runs.
- Test: `packages/agent-app/tests/browser-passwords-843.test.ts::choosing a login fills the sign-in form from 1Password`
- Environment: Node test runner driving real headless Chrome over the DevTools protocol (Electron's WebContents swapped for CDP); skipped locally when Chrome is not installed.
- Known gaps: Runs in a plain Chrome page, not the Electron pane; isolated worlds collapse to the main world over CDP. Logins inside cross-origin frames are not filled.
- Evidence: UNVERIFIED

<a id="mus-spec-09-843c"></a>
#### MUS-SPEC-09-843C: After a fill the agent never reads the password

- Precondition: The test page is filled as in MUS-SPEC-09-843B. It also has a "Show password" button that turns the field into plain text, and a second form whose password field has no label or placeholder.
- Action: The agent takes a snapshot, clicks Show password, snapshots again, types into the email field, and takes a screenshot.
- Expected result: No snapshot or tool reply contains the password (the filled field reads `••••••` even after it is shown as text, and an unlabeled password field is not named by its value). While the screenshot is taken the revealed field is drawn as dots, and it reads as text again afterwards.
- Test: `packages/agent-app/tests/browser-passwords-843.test.ts::after a fill the agent never reads the password: snapshot, typing and screenshot stay masked`
- Environment: Node test runner driving real headless Chrome over the DevTools protocol; skipped locally when Chrome is not installed.
- Known gaps: The page itself can still read and log its own field; a page that copies the password into other text or the console is not masked. The live picture-in-picture the person watches is not masked (it never reaches the model).
- Evidence: UNVERIFIED

<a id="mus-spec-09-843d"></a>
#### MUS-SPEC-09-843D: A fill is refused for another site or a changed page

- Precondition: The fake `op` has a login saved for `other.invalid`. The browser page is `example.test/login` over https.
- Action: Fill the `other.invalid` login; then fill a matching login while the page navigates to `evil.invalid` during the `op` call; then fill a matching login on a page that moves to `evil.invalid` as soon as the username is typed; then fill on a page with no password or username field.
- Expected result: The first is refused as not saved for this site; the second is refused because the page changed and nothing is typed; the third types the username only, never the password, and is refused because the page changed; the fourth says no sign-in form was found. The password is never typed into a page of another origin.
- Test: `packages/agent-app/tests/browser-passwords-843.test.ts::a fill is refused when the login is for another site or the page changed meanwhile`
- Environment: Node test runner; fake page contents that record typed text; fake `op` script.
- Known gaps: The page change check compares origins, so a single-page app that changes path keeps the fill.
- Evidence: UNVERIFIED

<a id="mus-spec-09-843e"></a>
#### MUS-SPEC-09-843E: A fill leaves no password anywhere but the page

- Precondition: A browser workspace with fake views opens `example.test/login` over https; its history entries carry page state. The fake `op` returns a login whose password is a unique marker.
- Action: Fill through the workspace, then read the emitted events, the fill reply, the tab's saved sessions, every file in the test's data folder and the agent browser tool list.
- Expected result: The marker appears only in the text typed into the page. Events and the reply hold no marker; the tab's saved history has no page state; no file contains it; no agent browser tool fills logins, and the bridge refuses one by name.
- Test: `packages/agent-app/tests/browser-passwords-843.test.ts::a fill leaves no password in events, saved history, files or agent tools`
- Environment: Node test runner; fake window, views and session; fake `op`; no Electron.
- Known gaps: Checks this process's outputs only; it cannot prove Chromium keeps no copy in its own memory or caches.
- Evidence: UNVERIFIED

<a id="mus-spec-09-843g"></a>
#### MUS-SPEC-09-843G: A value is typed only into the field focused for it

- Precondition: The browser page is `example.test/login` over https with a sign-in form and a plain text field ("Notes") outside it; the fake `op` has a matching login.
- Action: Fill the login while the page moves focus to the Notes field after the password field was focused and before the password is typed. Then fill again while the page moves focus to the Notes field before the username is typed.
- Expected result: A value is typed only while `document.activeElement` is still exactly the field focused for it, still connected, a password field for the password (or the username field for the username), and the page is still on the same origin. Otherwise nothing more is typed: the Notes field stays empty, the password field stays empty, and the fill fails with "The page changed during the fill". Any field that receives input while the password is typed is treated as secret, so agent snapshots show its value as dots.
- Test: `packages/agent-app/tests/browser-passwords-843.test.ts::a value is typed only into the field focused for it; focus moved by the page stops the fill`
- Environment: Node test runner; real headless Chrome running the real fill scripts; the page's focus move is made between the focus step and the typed text; fake `op` script.
- Known gaps: The guard runs in the top frame, so focus moved into a cross-origin iframe in the instant between the last check and the typed text is detected afterwards (the fill fails) but cannot stop that one value from reaching the iframe. A username typed before the page changed stays typed.
- Evidence: local; ~/.muster-work/review/857/green-843G.log; exit 0; 1 passed, 0 failed, 0 skipped; commit e92f8884a0e9e0d8c82527bb201322ebcd691ac6

<a id="mus-spec-09-843f"></a>
#### MUS-SPEC-09-843F: The key button fills a chosen login

- Precondition: The browser tab shows `example.test/login`. The bridge fakes `browser.passwords` with one login, then a reply that the 1Password CLI is not installed.
- Action: Open the key menu and choose the login; then open it again with no CLI.
- Expected result: The menu lists the login's title and username; choosing it sends `browser.fillLogin` with the tab and the item's id and vault, and the tab says it filled the login. Without the CLI the menu says 1Password's command-line tool is needed.
- Test: `packages/agent-app/tests/browser-passwords-843-dom.tsx::the key button lists matching logins and fills the chosen one`
- Environment: DOM suite (`linkedom`); the bridge is faked.
- Known gaps: Does not open a real menu on screen or drive 1Password's approval prompt.
- Evidence: UNVERIFIED

### Ports on an SSH host (#147)

<a id="mus-spec-09-147a"></a>
#### MUS-SPEC-09-147A: A port on the SSH host opens on 127.0.0.1 through a forward

- Precondition: A remote folder on a connected host and a web server on the host.
- Action: Open a forward for the server’s port, fetch the URL, list forwards, close it and fetch again.
- Expected result: The fetch returns the host server’s page; the list has the forward; after closing, the URL refuses connections.
- Test: `packages/agent-app/tests/ssh-workspaces-147.test.ts::a port on the SSH host opens on 127.0.0.1 through a forward`
- Environment: Node test runner with the real agent service, a temp data folder and a temp HOME; a stand-in `ssh` and `ssh-keyscan` on PATH (`tests/fixtures/fake-ssh/`) that run the remote commands under /bin/sh on this machine. No network, no real host.
- Known gaps: The in-app browser is not opened here; the URL it would load is.
- Evidence: UNVERIFIED
