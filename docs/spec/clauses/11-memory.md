# MUS-SPEC-11: Memory

Memory lets agents recall facts and decisions across chats. It is stored locally per user and per Project.

What the user can do:
- see what an agent recalled for a reply, and open the memory behind it;
- browse, search, edit and delete memories, and turn memory on or off per Project;
- reflect on a chat to save what was learned.

Boundaries:
- Memory never stores secrets; redaction (clause [19](19-security-and-redaction.md)) runs before anything is saved.
- One Project's memory is not recalled in another Project.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-11-558A](11-memory.md#mus-spec-11-558a) | After the first save fails slowly and a later toggle saves, the later choice (After runs) is still selected. | [`a failed memory save does not undo a later toggle that went through`](../../../packages/agent-app/tests/memory-settings-rollback-dom.tsx) |

### Memory settings

<a id="mus-spec-11-558a"></a>
#### MUS-SPEC-11-558A: A failed memory save does not undo a later toggle that went through

- Precondition: Settings > Memory is open. The first save is slow and then fails; the next save works.
- Action: Switch "Use memory in agent runs", then right away pick "After runs" for "After a run completes".
- Expected result: When the first save fails, its error is shown, but "After runs" stays selected because the later save went through.
- Test: `packages/agent-app/tests/memory-settings-rollback-dom.tsx::a failed memory save does not undo a later toggle that went through`
- Environment: Node and linkedom: a DOM suite with the real PreferencesScreen and a fake bridge; no server.
- Known gaps: Does not check the error notice text.
- Evidence: UNVERIFIED

