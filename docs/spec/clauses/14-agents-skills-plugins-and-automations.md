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
| [MUS-SPEC-14-382A](14-agents-skills-plugins-and-automations.md#mus-spec-14-382a) | A background Claude Code sub-agent is still running, and the chat is still waiting for it, 31 minutes after the parent's turn ended. | not written yet (#382) |
| [MUS-SPEC-14-382B](14-agents-skills-plugins-and-automations.md#mus-spec-14-382b) | Stop ends a background sub-agent that never reported back: it reads interrupted and the chat run ends as stopped. | not written yet (#382) |

### Claude Code background sub-agents
<a id="mus-spec-14-382a"></a>
#### MUS-SPEC-14-382A: A background sub-agent is not cut off after 30 minutes

- Precondition: A chat on the Claude Code route. Claude Code launches a background sub-agent and the parent's turn ends while the sub-agent is still working.
- Action: Let 31 minutes pass without the sub-agent reporting back.
- Expected result: The sub-agent still reads as running, the chat still counts as working, and Claude Code's input is still open so the sub-agent can report back.
- Test: not written yet (#382)
- Environment: Node test runner; a fake Claude Code process replaying a recorded background run; mocked timers.
- Known gaps: A sub-agent that hangs forever keeps the chat working until the user presses Stop.
- Evidence: UNVERIFIED

<a id="mus-spec-14-382b"></a>
#### MUS-SPEC-14-382B: Stop ends a background sub-agent

- Precondition: A chat on the Claude Code route with a background sub-agent still running after the parent's turn ended.
- Action: Press Stop.
- Expected result: Claude Code is interrupted, the sub-agent's row reads interrupted, and the chat's run ends as stopped.
- Test: not written yet (#382)
- Environment: Node test runner; a fake Claude Code process replaying a recorded background run.
- Known gaps: Does not show a real Claude Code process exiting on the interrupt signal.
- Evidence: UNVERIFIED
