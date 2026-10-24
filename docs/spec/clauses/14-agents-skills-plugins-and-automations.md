# MUS-SPEC-14: Sub-agents, skills, plugins and automations

These extend what an agent can do: sub-agents it can hand work to, skills it can follow, plugins and MCP servers that add tools and pages, and automations that start work on a schedule or trigger.

What the user can do:
- see sub-agents run inside a turn, open their transcripts and stop them;
- write, record, edit and attach skills;
- install, enable and remove plugins and MCP servers;
- create automations that run on a schedule or a repository event, and see their results.

Boundaries:
- A finished sub-agent is announced once in the transcript.
- Plugin files stay inside the plugin's folder; path traversal and symlinks outside it are blocked.

## Acceptance cases

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-14-290A](14-agents-skills-plugins-and-automations.md#mus-spec-14-290a) | After a failed start-up and after a normal dispose, no scheduler tick runs against the closed database and the wake-up does nothing. | [`a domain set that fails to start or is disposed leaves no scheduler tick or wake behind`](../../../packages/agent-app/tests/domain-seam.test.ts) |

<a id="mus-spec-14-290a"></a>
#### MUS-SPEC-14-290A: No scheduler tick or wake after start-up fails or the app is disposed

- Precondition: The scheduler's first tick is due within a few milliseconds. One start-up fails part-way (two domains register the same command), and a second start-up is disposed normally.
- Action: The database closes, the machine wakes from sleep, and time passes beyond several scheduler ticks.
- Expected result: No scheduler tick runs, nothing is logged as "automations: tick failed", and the wake-up does nothing.
- Test: `packages/agent-app/tests/domain-seam.test.ts::a domain set that fails to start or is disposed leaves no scheduler tick or wake behind`
- Environment: Node test runner with an in-memory SQLite database.
- Known gaps: Uses a short real timer, not a slow runner. A dispose in the middle of a running automation run is not covered.
- Evidence: UNVERIFIED
