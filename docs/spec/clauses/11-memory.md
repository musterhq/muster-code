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

No cases yet. A PR that changes this area adds its cases here first (see [acceptance-cases.md](../acceptance-cases.md)).
