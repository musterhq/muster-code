# MUS-SPEC-21: Visuals and artifacts

Replies can hold more than text: diagrams, charts, device frames, 3D models, canvases and artifacts the agent builds.

What the user can do:
- see diagrams and charts drawn from a reply, and code blocks with syntax colouring;
- open artifacts and canvases in a tab, and share or export them;
- see app previews inside device frames.

Boundaries:
- A visual that fails to render shows its source and a plain error, never a blank space.
- Device models and frames are downloaded at run time, never bundled.

## Acceptance cases

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-21-43A](21-visuals-and-artifacts.md#mus-spec-21-43a) | "Back to chat" on a side chat opens its parent conversation and keeps the side chat tab open. | [`Back to chat opens the parent conversation and keeps the side chat tab`](../../../packages/agent-app/tests/side-chat-back-dom.tsx) |
| [MUS-SPEC-21-43B](21-visuals-and-artifacts.md#mus-spec-21-43b) | A side chat with no parent, or whose parent chat is gone, shows no "Back to chat" control. | [`No Back to chat control without a parent conversation`](../../../packages/agent-app/tests/side-chat-back-dom.tsx) |

### Side chats

<a id="mus-spec-21-43a"></a>
#### MUS-SPEC-21-43A: Back to chat returns to the parent conversation

- Precondition: A side chat was opened from a main chat. Its tab fills the maximized right pane, so the main conversation is covered.
- Action: Click "Back to chat" in the side chat's header.
- Expected result: The main chat the side chat was opened from is the active conversation, the pane is restored so the conversation shows beside it, the conversation's message box has focus, and the side chat stays open with its messages.
- Test: `packages/agent-app/tests/side-chat-back-dom.tsx::Back to chat opens the parent conversation and keeps the side chat tab`
- Environment: DOM suite (linkedom) with a stubbed bridge; no provider or network.
- Known gaps: The pane's maximize state is held by a small stand-in with the same toggle contract as the real resource pane. The test does not show which chat is recorded as the parent when the side chat is created (the runtime stores `parentChatId`); it supplies it.
- Evidence: UNVERIFIED

<a id="mus-spec-21-43b"></a>
#### MUS-SPEC-21-43B: No Back to chat without a parent

- Precondition: A side chat that was created with no main chat open, and one whose parent chat has since been deleted.
- Action: Show each side chat's tab.
- Expected result: The header has no "Back to chat" control for either, and still has Open the resource, Promote and Discard.
- Test: `packages/agent-app/tests/side-chat-back-dom.tsx::No Back to chat control without a parent conversation`
- Environment: DOM suite (linkedom) with a stubbed bridge; no provider or network.
- Known gaps: None known.
- Evidence: UNVERIFIED
