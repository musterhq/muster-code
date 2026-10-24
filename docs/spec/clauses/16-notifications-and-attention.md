# MUS-SPEC-16: Notifications and attention

Muster tells the user when something needs them: a turn finished, an approval is waiting, a run failed.

What the user can do:
- see in-app toasts, system notifications and dock badges for chats that need attention;
- snooze an item, mark it done, or jump to it;
- choose which events notify them.

Boundaries:
- An item that needs attention stays visible until the user acts on it or it expires.
- Toasts stack in the bottom-right corner of the window, above the status row (the environment, branch and context line under the composer). They stay clear of the summary card, the composer and the transcript column when the window has room, and never cover the composer or the card when it does not.

## Acceptance cases

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-16-1A](16-notifications-and-attention.md#mus-spec-16-1a) | In a wide window the toast stack sits in the bottom-right corner, right of the composer and transcript column, with its bottom edge 8px above the status row and its top below the summary card. | not written yet (#627) |
| [MUS-SPEC-16-1B](16-notifications-and-attention.md#mus-spec-16-1b) | In a narrow window with the summary card open, the stack lifts above the composer and stops 8px below the card, so neither is covered. | not written yet (#627) |
| [MUS-SPEC-16-1C](16-notifications-and-attention.md#mus-spec-16-1c) | With the summary card folded to its pill in a narrow window, the stack lifts above the composer and stays below the pill. | not written yet (#627) |
| [MUS-SPEC-16-1D](16-notifications-and-attention.md#mus-spec-16-1d) | With the right pane open, the stack stays in the window's bottom-right corner over the pane, clear of the card and the composer, and follows the status row when it moves. | not written yet (#627) |

### Where toasts stack

<a id="mus-spec-16-1a"></a>
#### MUS-SPEC-16-1A: Toasts stack bottom-right, above the status row

- Precondition: A 1440 by 900 window shows a chat with the summary card open in the top-right (down to y=360) and the right pane closed. The transcript column ends at x=1072 and the composer at x=1040. The status row starts at y=810.
- Action: Two notices appear.
- Expected result: The stack is 16px from the right edge and starts at least 8px right of the transcript column. Its bottom edge is 8px above the top of the status row (y=802), and it cannot reach higher than 8px below the card (y=368). It is not at the top of the window.
- Test: not written yet (#627)
- Environment: DOM suite (`linkedom`); layout sizes are faked per element, so no real window is used.
- Known gaps: Positions come from faked sizes, not a real layout, so it does not show the look on screen; before and after screenshots are needed.
- Evidence: UNVERIFIED

<a id="mus-spec-16-1b"></a>
#### MUS-SPEC-16-1B: Toasts lift above the composer in a narrow window

- Precondition: An 800 by 640 window with the sidebar open shows the summary card expanded over the right side of the conversation, down to y=400. The composer starts at y=520 and spans almost the whole conversation, so there is no clear column beside it.
- Action: Four notices appear.
- Expected result: The stack is 16px from the right edge, its bottom edge is at least 8px above the composer (y=512 or higher) and its top is at least 8px below the card (y=408), so the composer and the card are both uncovered.
- Test: not written yet (#627)
- Environment: DOM suite (`linkedom`); layout sizes are faked per element.
- Known gaps: Fake sizes only; no screenshot. In this layout the stack can sit over transcript text until dismissed, and if the card reaches nearly down to the composer the stack keeps room for one toast and may touch the card.
- Evidence: UNVERIFIED

<a id="mus-spec-16-1c"></a>
#### MUS-SPEC-16-1C: Toasts stay below the folded pill and above the composer

- Precondition: A 1000 by 700 window shows the summary card folded to its pill (y=56 to y=88) in the top-right. The composer starts at y=560 and spans almost the whole conversation.
- Action: One notice appears.
- Expected result: The stack is 16px from the right edge, its bottom edge is at least 8px above the composer (y=552 or higher) and its top is at least 8px below the pill (y=96).
- Test: not written yet (#627)
- Environment: DOM suite (`linkedom`); layout sizes are faked per element.
- Known gaps: Fake sizes only; no screenshot. The stack can sit over transcript text until dismissed.
- Evidence: UNVERIFIED

<a id="mus-spec-16-1d"></a>
#### MUS-SPEC-16-1D: Toasts stay in the window corner when the right pane is open

- Precondition: A 1280 by 800 window has the right pane open at 420px, so the conversation ends at x=860 and the summary card sits at x=546 to 846. The composer ends at x=824. The status row starts at y=736.
- Action: A notice appears. Then the status row moves up 30px, as when the composer grows, and the window fires a resize.
- Expected result: The stack is 16px from the right edge and 380px wide, so it sits right of the card and the composer (starts at x=884). Its bottom edge is 8px above the status row (y=728), and 30px higher (y=698) after the move.
- Test: not written yet (#627)
- Environment: DOM suite (`linkedom`); layout sizes are faked per element.
- Known gaps: Fake sizes only; no screenshot. The stack covers part of the open pane while it is up.
- Evidence: UNVERIFIED
