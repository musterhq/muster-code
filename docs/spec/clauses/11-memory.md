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
| [MUS-SPEC-11-673A](11-memory.md#mus-spec-11-673a) | Repository evidence records the branch as release when a tag shares the name. | [`checkout and memory name the branch when a tag shares its name`](../../../packages/agent-app/tests/branch-tag-same-name.test.ts) |

<a id="mus-spec-11-673a"></a>
#### MUS-SPEC-11-673A: Memory records the branch when a tag has the same name

- Precondition: A repository on branch release with a tag also named release.
- Action: Read the repository evidence that memory saves.
- Expected result: The branch recorded is release.
- Test: `packages/agent-app/tests/branch-tag-same-name.test.ts::checkout and memory name the branch when a tag shares its name`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Reads the evidence function only. It does not save a memory. The same test covers check-out (MUS-SPEC-12-673A).
- Evidence: UNVERIFIED
