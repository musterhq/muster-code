# MUS-SPEC-06: Sandbox and scoped computers

A sandbox runs a chat's or a Project's commands and services inside a container instead of directly on the user's computer. A scoped computer gives the agent controlled use of an app window.

What the user can do:
- turn on a sandbox for a chat or a Project and set its memory, CPU and disk limits;
- see the sandbox's state, its files and services, and apply its changes back to the real folder;
- let the agent use a chosen app window, and take it back at any time.

Boundaries:
- A sandbox never goes past its memory or disk limit; a write or command that would is refused or stopped with a notice.
- Deleting a chat removes its sandbox; archiving stops it and keeps its files. A Project's shared sandbox keeps running while any chat still uses it.
- When no container engine is available, Muster says so instead of running outside the sandbox.

## Acceptance cases

No cases yet. A PR that changes this area adds its cases here first (see [acceptance-cases.md](../acceptance-cases.md)).
