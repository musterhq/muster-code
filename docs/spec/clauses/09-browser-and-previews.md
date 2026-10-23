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
