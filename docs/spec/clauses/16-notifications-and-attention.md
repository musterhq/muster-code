# MUS-SPEC-16: Notifications and attention

Muster tells the user when something needs them: a turn finished, an approval is waiting, a run failed.

What the user can do:
- see in-app toasts, system notifications and dock badges for chats that need attention;
- snooze an item, mark it done, or jump to it;
- choose which events notify them.

Boundaries:
- An item that needs attention stays visible until the user acts on it or it expires.
- Toasts stack in the bottom-right corner of the window, just above the status row, and never cover the summary card.

## Acceptance cases

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-16-1A](16-notifications-and-attention.md#mus-spec-16-1a) | In a wide window with the summary card open, the toast stack sits in the bottom-right corner, 8px above the status row, and its top stays 8px below the card. | not written yet (#627) |
| [MUS-SPEC-16-1B](16-notifications-and-attention.md#mus-spec-16-1b) | In a narrow window with the sidebar open, the toast stack is cut short so its top stays 8px below the summary card, and it scrolls inside that height. | not written yet (#627) |
| [MUS-SPEC-16-1C](16-notifications-and-attention.md#mus-spec-16-1c) | With the summary card folded to its pill, the toasts keep the same corner and stay below the pill. | not written yet (#627) |
| [MUS-SPEC-16-1D](16-notifications-and-attention.md#mus-spec-16-1d) | With the right pane open, the toasts stay in the window's bottom-right corner, and follow the status row when it moves. | not written yet (#627) |

### Where toasts stack

<a id="mus-spec-16-1a"></a>
#### MUS-SPEC-16-1A: Toasts stack bottom-right, above the status row

- Precondition: A 1440 by 900 window shows a chat with the summary card open in the top-right and the right pane closed. The status row (environment, branch, context meter) starts 40px above the bottom of the window.
- Action: Two notices appear.
- Expected result: The stack is anchored 16px from the right edge and its bottom edge is 8px above the top of the status row. It is not anchored to the top of the window. Its height is limited so its top stays 8px below the bottom of the summary card.
- Test: not written yet (#627)
- Environment: DOM suite (`linkedom`); layout sizes are faked per element, so no real window is used.
- Known gaps: Positions come from faked sizes, not a real layout, so it does not show the look on screen; before and after screenshots are needed. In a mid-width window the stack can sit over the right end of the composer.
- Evidence: UNVERIFIED

<a id="mus-spec-16-1b"></a>
#### MUS-SPEC-16-1B: Toasts stay below the summary card in a narrow window

- Precondition: An 800 by 640 window with the sidebar open shows the summary card expanded over the right side of the conversation, reaching down to 400px. The status row starts 40px above the bottom.
- Action: Four notices appear.
- Expected result: The stack's top edge is at least 8px below the bottom of the summary card, and the stack scrolls inside the room that is left. No toast covers the card.
- Test: not written yet (#627)
- Environment: DOM suite (`linkedom`); layout sizes are faked per element.
- Known gaps: Fake sizes only; no screenshot. If the card reaches nearly to the status row, the stack keeps room for one toast and may then touch the card.
- Evidence: UNVERIFIED

<a id="mus-spec-16-1c"></a>
#### MUS-SPEC-16-1C: Toasts keep the corner when the summary card is folded

- Precondition: A 1000 by 700 window shows the summary card folded to its pill in the top-right, 32px tall. The status row starts 40px above the bottom.
- Action: One notice appears.
- Expected result: The stack is in the same bottom-right corner, 8px above the status row, and its top stays below the pill.
- Test: not written yet (#627)
- Environment: DOM suite (`linkedom`); layout sizes are faked per element.
- Known gaps: Fake sizes only; no screenshot.
- Evidence: UNVERIFIED

<a id="mus-spec-16-1d"></a>
#### MUS-SPEC-16-1D: Toasts stay in the window corner when the right pane is open

- Precondition: A 1280 by 800 window has the right pane open at 420px, so the summary card sits left of the pane and does not reach the corner. The status row starts 40px above the bottom.
- Action: A notice appears. Then the status row moves up 30px, as when the composer grows, and the window is resized.
- Expected result: The stack stays in the window's bottom-right corner, 8px above the status row, with no limit from the card. After the move it is 30px higher.
- Test: not written yet (#627)
- Environment: DOM suite (`linkedom`); layout sizes are faked per element.
- Known gaps: Fake sizes only; no screenshot. The stack covers part of the open pane while it is up.
- Evidence: UNVERIFIED
