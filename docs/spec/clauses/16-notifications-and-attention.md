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
| [MUS-SPEC-16-658A](16-notifications-and-attention.md#mus-spec-16-658a) | The provider watch reports a provider as newly connected only for a new provider, a provider that came back ready after being signed out, failed or removed; never for the launch listing, a launch check that ends ready, or a routine re-check. | [`the connected notice marks a real change only: not a launch check finishing, not a re-check (#590)`](../../../packages/agent-app/tests/setup-detection.test.ts) |

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
