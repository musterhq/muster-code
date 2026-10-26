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

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-16-1A](16-notifications-and-attention.md#mus-spec-16-1a) | In a wide window the toast stack sits in the bottom-right corner, right of the composer and transcript column, with its bottom edge 8px above the status row and its top below the summary card. | [`toasts stack in the bottom-right corner above the status row`](../../../packages/agent-app/tests/notice-placement-dom.tsx) |
| [MUS-SPEC-16-1B](16-notifications-and-attention.md#mus-spec-16-1b) | In a narrow window with the summary card open, the stack lifts above the composer and stops 8px below the card, so neither is covered. | [`toasts lift above the composer in a narrow window`](../../../packages/agent-app/tests/notice-placement-dom.tsx) |
| [MUS-SPEC-16-1C](16-notifications-and-attention.md#mus-spec-16-1c) | With the summary card folded to its pill in a narrow window, the stack lifts above the composer and stays below the pill. | [`toasts stay below the folded pill and above the composer`](../../../packages/agent-app/tests/notice-placement-dom.tsx) |
| [MUS-SPEC-16-1D](16-notifications-and-attention.md#mus-spec-16-1d) | With the right pane open, the stack stays in the window's bottom-right corner over the pane, clear of the card and the composer, and follows the status row when it moves. | [`toasts stay in the window corner when the right pane is open`](../../../packages/agent-app/tests/notice-placement-dom.tsx) |
| [MUS-SPEC-16-564A](16-notifications-and-attention.md#mus-spec-16-564a) | With 3 pending requests the badge is cleared on focus, shown again on blur without bouncing, and not repeated when nothing changed. | [`the dock badge comes back when the window loses focus with the same pending count`](../../../packages/agent-app/tests/app-shell.test.ts) |
| [MUS-SPEC-16-561A](16-notifications-and-attention.md#mus-spec-16-561a) | With four error notices showing, a new success notice with Undo is kept, the stack stays at four or fewer, and the newest error is kept. | [`a confirmation or Undo notice is not lost while persistent errors fill the stack`](../../../packages/agent-app/tests/notice-overflow.test.ts) |
| [MUS-SPEC-16-658A](16-notifications-and-attention.md#mus-spec-16-658a) | The provider watch reports a provider as newly connected only for a new provider, a provider that came back ready after being signed out, failed or removed; never for the launch listing, a launch check that ends ready, or a routine re-check. | [`the connected notice marks a real change only: not a launch check finishing, not a re-check (#590)`](../../../packages/agent-app/tests/setup-detection.test.ts) |

### Where toasts stack

<a id="mus-spec-16-1a"></a>
#### MUS-SPEC-16-1A: Toasts stack bottom-right, above the status row

- Precondition: A 1440 by 900 window shows a chat with the summary card open in the top-right (down to y=360) and the right pane closed. The transcript column and the composer both end at x=1040. The status row starts at y=810.
- Action: Two notices appear.
- Expected result: The stack is 16px from the right edge and starts right of the transcript column and the composer (x=1044 or more). Its bottom edge is 8px above the top of the status row (y=802), and it cannot reach higher than 8px below the card (y=368). It is not at the top of the window.
- Test: `packages/agent-app/tests/notice-placement-dom.tsx::toasts stack in the bottom-right corner above the status row`
- Environment: DOM suite (`linkedom`); layout sizes are faked per element, so no real window is used.
- Known gaps: Positions come from faked sizes, not a real layout, so it does not show the look on screen; before and after screenshots are needed.
- Evidence: UNVERIFIED

<a id="mus-spec-16-1b"></a>
#### MUS-SPEC-16-1B: Toasts lift above the composer in a narrow window

- Precondition: An 800 by 640 window with the sidebar open shows the summary card expanded over the right side of the conversation, down to y=400. The composer starts at y=520 and spans almost the whole conversation, so there is no clear column beside it.
- Action: Four notices appear.
- Expected result: The stack is 16px from the right edge, its bottom edge is at least 8px above the composer (y=512 or higher) and its top is at least 8px below the card (y=408), so the composer and the card are both uncovered.
- Test: `packages/agent-app/tests/notice-placement-dom.tsx::toasts lift above the composer in a narrow window`
- Environment: DOM suite (`linkedom`); layout sizes are faked per element.
- Known gaps: Fake sizes only; no screenshot. In this layout the stack can sit over transcript text until dismissed, and if the card reaches nearly down to the composer the stack keeps room for one toast and may touch the card.
- Evidence: UNVERIFIED

<a id="mus-spec-16-1c"></a>
#### MUS-SPEC-16-1C: Toasts stay below the folded pill and above the composer

- Precondition: A 1000 by 700 window shows the summary card folded to its pill (y=56 to y=88) in the top-right. The composer starts at y=560 and spans almost the whole conversation.
- Action: One notice appears.
- Expected result: The stack is 16px from the right edge, its bottom edge is at least 8px above the composer (y=552 or higher) and its top is at least 8px below the pill (y=96).
- Test: `packages/agent-app/tests/notice-placement-dom.tsx::toasts stay below the folded pill and above the composer`
- Environment: DOM suite (`linkedom`); layout sizes are faked per element.
- Known gaps: Fake sizes only; no screenshot. The stack can sit over transcript text until dismissed.
- Evidence: UNVERIFIED

<a id="mus-spec-16-1d"></a>
#### MUS-SPEC-16-1D: Toasts stay in the window corner when the right pane is open

- Precondition: A 1280 by 800 window has the right pane open at 420px, so the conversation ends at x=860 and the summary card sits at x=546 to 846. The composer ends at x=824. The status row starts at y=736.
- Action: A notice appears. Then the status row moves up 30px, as when the composer grows, and the window fires a resize.
- Expected result: The stack is 16px from the right edge and 380px wide, so it sits right of the card and the composer (starts at x=884). Its bottom edge is 8px above the status row (y=728), and 30px higher (y=698) after the move.
- Test: `packages/agent-app/tests/notice-placement-dom.tsx::toasts stay in the window corner when the right pane is open`
- Environment: DOM suite (`linkedom`); layout sizes are faked per element.
- Known gaps: Fake sizes only; no screenshot. The stack covers part of the open pane while it is up.
- Evidence: UNVERIFIED

### Dock badge

<a id="mus-spec-16-564a"></a>
#### MUS-SPEC-16-564A: The dock badge returns when you switch away with requests still pending

- Precondition: Three approvals or questions are pending and the window is not in front.
- Action: Focus the window, then switch away again with the same count.
- Expected result: The badge shows 3 and bounces once, clears on focus, comes back as 3 without a second bounce when the window loses focus, and a repeat with the same state does nothing.
- Test: `packages/agent-app/tests/app-shell.test.ts::the dock badge comes back when the window loses focus with the same pending count`
- Environment: Node test runner; no network, no provider.
- Known gaps: Tests the badge tracker, not the real dock; the wiring in the main process is not run.
- Evidence: UNVERIFIED

### Notice stack

<a id="mus-spec-16-561a"></a>
#### MUS-SPEC-16-561A: A confirmation or Undo notice is kept when error notices fill the stack

- Precondition: Four unread error notices are on screen, which is the most the stack holds.
- Action: Push a success notice with an Undo button, such as "Archived 2 chats".
- Expected result: The new notice is shown with its Undo, the stack still holds no more than four, and the newest error is still there.
- Test: `packages/agent-app/tests/notice-overflow.test.ts::a confirmation or Undo notice is not lost while persistent errors fill the stack`
- Environment: Node test runner; the real notice store is bundled and run with an in-memory localStorage.
- Known gaps: Calls the notice store, not the toast stack that draws it. This is the only test for this behaviour.
- Evidence: UNVERIFIED

### Provider connected notice

<a id="mus-spec-16-658a"></a>
#### MUS-SPEC-16-658A: The "connected" notice shows only when something really changed

- Precondition: The app has just launched. One provider is ready, one is still being checked, and one is signed out.
- Action: Run the provider watch through this sequence: the launch check of the pending provider ends ready; the signed-out provider signs in; the first provider re-checks its sign-in and passes; another provider fails, is checked again and recovers while a new provider appears; one provider leaves the list and returns ready. In a second run, a provider whose check is still running at launch ends signed out, is checked again, and then signs in.
- Expected result: Nothing is announced for the launch listing, for a launch check that ends ready, or for a re-check that passes. A provider is announced as connected when it signs in after being signed out at launch, when it recovers after a failure, when it is new, and when it comes back after leaving the list. In the second run, the provider is announced once, when it signs in after the signed-out state found at launch.
- Test: `packages/agent-app/tests/setup-detection.test.ts::the connected notice marks a real change only: not a launch check finishing, not a re-check (#590)`
- Environment: Node test runner; the provider watch is the real one, fed with a fake provider list; no real provider, network or timers beyond a short debounce.
- Known gaps: Checks which providers the watch reports as connected, not the toast on screen. The toast wiring in the renderer is not covered by this test.
- Evidence: UNVERIFIED
