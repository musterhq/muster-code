# MUS-SPEC-20: Performance

Muster stays responsive with long chats, large folders and many running agents.

What the user can do:
- scroll long transcripts and large diffs smoothly;
- switch chats and screens without waiting on slow reads, seeing the last copy straight away while it refreshes.

Boundaries:
- Each performance case names its measure and its limit, and the machine it was measured on.
- A slow provider or server never blocks the interface.

## Acceptance cases

| Case | What the assertions check | Test |

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|

|---|---|---|
| [MUS-SPEC-20-566A](20-performance.md#mus-spec-20-566a) | Building the renderer, the files the first page load pulls in do not include HubSetup.tsx or ProjectTasks.tsx. | [`the startup bundle leaves the hub setup forms and the project task page to their lazy chunks`](../../../packages/agent-app/tests/startup-bundle.test.ts) |

### Startup size

<a id="mus-spec-20-566a"></a>
#### MUS-SPEC-20-566A: The new-task form and project task page are not loaded at startup

- Precondition: The renderer is bundled the way the app builds it, with code splitting.
- Action: Follow the imports that load before first paint from `main.js`.
- Expected result: Neither `HubSetup.tsx` nor `ProjectTasks.tsx` is in that set; they load on first use.
- Test: `packages/agent-app/tests/startup-bundle.test.ts::the startup bundle leaves the hub setup forms and the project task page to their lazy chunks`
- Environment: Node test runner with esbuild; no network. It builds the renderer, so it takes a few seconds.
- Known gaps: Measure: which files load before first paint. The change cut about 87 KB (1.90 MB to 1.81 MB), measured on the author's machine; the test checks only that the two files are out, not the size. The new-task sheet still opening after a lazy load is checked by the existing DOM suite (nav-components.tsx), which also passes on main, so it is not linked.
- Evidence: UNVERIFIED
