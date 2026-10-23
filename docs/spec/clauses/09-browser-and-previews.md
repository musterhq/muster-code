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
| [MUS-SPEC-09-629A](09-browser-and-previews.md#mus-spec-09-629a) | With a live browser preview card on screen, either the card clears the transcript text or the conversation pane has a reserve on that side; a reserve exists only when the card would otherwise cover text. | [`the visible browser preview never covers transcript text`](../../../packages/agent-app/tests/pip-components.tsx) |
| [MUS-SPEC-09-629B](09-browser-and-previews.md#mus-spec-09-629b) | When a card overlaps the text column, the calculated reserve makes the text end one gap short of the card, in a wide pane and in a pane narrower than the column. | [`the smallest reserve that clears the card: the text ends at the card minus the gap`](../../../packages/agent-app/tests/pip-reserve.test.ts) |

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
