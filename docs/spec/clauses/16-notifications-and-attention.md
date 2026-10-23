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
| [MUS-SPEC-16-561A](16-notifications-and-attention.md#mus-spec-16-561a) | With four error notices showing, a new success notice with Undo is kept, the stack stays at four or fewer, and the newest error is kept. | [`a confirmation or Undo notice is not lost while persistent errors fill the stack`](../../../packages/agent-app/tests/notice-overflow.test.ts) |

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

