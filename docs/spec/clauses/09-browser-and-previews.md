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
| [MUS-SPEC-09-564A](09-browser-and-previews.md#mus-spec-09-564a) | A download name with a right-to-left override keeps its real .exe extension and holds no direction control characters. | [`a downloaded file name cannot use text-direction controls to disguise its extension`](../../../packages/agent-app/tests/browser-download-name.test.ts) |

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
