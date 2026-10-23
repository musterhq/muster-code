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
