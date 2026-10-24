# MUS-SPEC-16: Notifications and attention

Muster tells the user when something needs them: a turn finished, an approval is waiting, a run failed.

What the user can do:
- see in-app toasts, system notifications and dock badges for chats that need attention;
- snooze an item, mark it done, or jump to it;
- choose which events notify them.

Boundaries:
- An item that needs attention stays visible until the user acts on it or it expires.
- Toasts never cover the summary card or the composer.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-16-564A](16-notifications-and-attention.md#mus-spec-16-564a) | With 3 pending requests the badge is cleared on focus, shown again on blur without bouncing, and not repeated when nothing changed. | [`the dock badge comes back when the window loses focus with the same pending count`](../../../packages/agent-app/tests/app-shell.test.ts) |
| [MUS-SPEC-16-561A](16-notifications-and-attention.md#mus-spec-16-561a) | With four error notices showing, a new success notice with Undo is kept, the stack stays at four or fewer, and the newest error is kept. | [`a confirmation or Undo notice is not lost while persistent errors fill the stack`](../../../packages/agent-app/tests/notice-overflow.test.ts) |

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
