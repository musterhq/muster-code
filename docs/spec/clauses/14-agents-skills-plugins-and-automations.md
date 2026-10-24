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
| [MUS-SPEC-14-382A](14-agents-skills-plugins-and-automations.md#mus-spec-14-382a) | After 31 minutes with no report the sub-agent still reads running, the chat run is still open and Claude Code input is open; Stop then interrupts Claude Code, the sub-agent reads interrupted and the run ends as Stopped. | [`Claude Code background sub-agent: no 30 minute cut-off while it is still running`](../../../packages/agent-app/tests/claude-background-382.test.ts) |

### Claude Code background sub-agents
<a id="mus-spec-14-382a"></a>
#### MUS-SPEC-14-382A: A background sub-agent is not cut off after 30 minutes

- Precondition: A chat on the Claude Code route. Claude Code launches a background sub-agent and the parent's turn ends while the sub-agent is still working.
- Action: Let 31 minutes pass without the sub-agent reporting back, then press Stop.
- Expected result: After 31 minutes the sub-agent still reads as running, the chat still counts as working, and Claude Code's input is still open so the sub-agent can report back. After Stop, Claude Code is interrupted, the sub-agent's row reads interrupted and the run ends as stopped.
- Test: `packages/agent-app/tests/claude-background-382.test.ts::Claude Code background sub-agent: no 30 minute cut-off while it is still running`
- Environment: Node test runner; a fake Claude Code process replaying a recorded background run; mocked timers.
- Known gaps: A sub-agent that hangs forever keeps the chat working until the user presses Stop. Does not show a real Claude Code process exiting on the interrupt signal. The Stop half already worked before this change; it is kept so the removed time limit never leaves a run that cannot be ended.
- Evidence: UNVERIFIED
