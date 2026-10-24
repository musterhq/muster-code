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
| [MUS-SPEC-09-465A](09-browser-and-previews.md#mus-spec-09-465a) | Taking a picture of a frozen tab wakes it first; a tab whose page was dropped to save memory is recreated; an unknown tab gives nothing. | [`frame() on a frozen tab thaws it and on a discarded tab recreates it`](../../../packages/agent-app/tests/browser-workspace-memory.test.ts) |
| [MUS-SPEC-09-465B](09-browser-and-previews.md#mus-spec-09-465b) | A tab an agent tool is using is not frozen when the panel closes and is not discarded to make room; once the agent is done it can be frozen and discarded again. | [`a tab an agent tool is using is neither frozen nor discarded by the memory paths`](../../../packages/agent-app/tests/browser-workspace-memory.test.ts) |
| [MUS-SPEC-09-465C](09-browser-and-previews.md#mus-spec-09-465c) | A lost connection retries read-only browser tools with backoff, never repeats a click, retries a refused connection for any tool, and gives up after three retries. | [`MCP server: connection resets retry read-only tools with backoff but never repeat a click`](../../../packages/agent-app/tests/browser-route-matrix.test.ts) |
| [MUS-SPEC-09-465D](09-browser-and-previews.md#mus-spec-09-465d) | The idle sweep leaves a tab an agent tool just used awake for three minutes, then freezes it. | [`agent use thaws a hidden page; the sweeper refreezes it once idle`](../../../packages/agent-app/tests/browser-freeze.test.ts) |

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
