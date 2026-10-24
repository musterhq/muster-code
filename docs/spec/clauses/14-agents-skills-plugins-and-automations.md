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

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-14-382A](14-agents-skills-plugins-and-automations.md#mus-spec-14-382a) | After 31 minutes with no report the sub-agent still reads running, the chat run is still open and Claude Code input is open; Stop then interrupts Claude Code, the sub-agent reads interrupted and the run ends as Stopped. | [`Claude Code background sub-agent: no 30 minute cut-off while it is still running`](../../../packages/agent-app/tests/claude-background-382.test.ts) |
| [MUS-SPEC-14-480A](14-agents-skills-plugins-and-automations.md#mus-spec-14-480a) | An MCP server added mid-run stops the running chat once, re-sends its last message through the queue with the new server in its tools, leaves the queue unpaused and adds one notice. | [`an MCP server added mid-run restarts the running chat once and re-sends its prompt through the queue with the new tools`](../../../packages/agent-app/tests/plugin-reload.test.ts) |
| [MUS-SPEC-14-480B](14-agents-skills-plugins-and-automations.md#mus-spec-14-480b) | An idle chat whose last message asked for the plugin gets it re-sent; an idle chat on another topic and a running chat doing unrelated work are not stopped or re-sent. | [`an MCP server added mid-run restarts the running chat once and re-sends its prompt through the queue with the new tools`](../../../packages/agent-app/tests/plugin-reload.test.ts) |
| [MUS-SPEC-14-480C](14-agents-skills-plugins-and-automations.md#mus-spec-14-480c) | Adding a second, unrelated server later sends nothing again and stops nothing. | [`an MCP server added mid-run restarts the running chat once and re-sends its prompt through the queue with the new tools`](../../../packages/agent-app/tests/plugin-reload.test.ts) |
| [MUS-SPEC-14-480D](14-agents-skills-plugins-and-automations.md#mus-spec-14-480d) | Whole-word, case-insensitive matching with "google-drive" matching "Google Drive"; the last turn skips steering messages; an idle turn older than 30 minutes does not count; one install claims a chat once. | [`a turn is about a plugin only when it names it and ended recently`](../../../packages/agent-app/tests/plugin-reload.test.ts) |
| [MUS-SPEC-14-480E](14-agents-skills-plugins-and-automations.md#mus-spec-14-480e) | A marketplace install and an enabled MCP server give a plugin; a disabled server, an uninstall and an empty result give nothing. | [`installedPlugin reads marketplace installs and added MCP servers, nothing else`](../../../packages/agent-app/tests/plugin-reload.test.ts) |

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

### Installing a plugin while a chat is open (#480)

<a id="mus-spec-14-480a"></a>
#### MUS-SPEC-14-480A: A chat working on a new plugin restarts and re-sends its message

- Precondition: A chat is running a turn whose message names the plugin "fake_tools" ("triage the bug backlog in fake_tools"). The plugin is not installed yet.
- Action: Add the MCP server "fake_tools" while the turn is running.
- Expected result: The provider is stopped for that chat once. The same message is sent again on a fresh session whose tool settings include the new server's address. The queue is empty and not paused afterwards, and the chat shows one notice "fake_tools installed — restarted the session and re-sent your last message".
- Test: `packages/agent-app/tests/plugin-reload.test.ts::an MCP server added mid-run restarts the running chat once and re-sends its prompt through the queue with the new tools`
- Environment: Node test runner; the agent service with a fake provider that holds each turn open until told to finish; no network.
- Known gaps: Adds an MCP server. A plugin from the marketplace goes through the same hook but only its parsing is tested (MUS-SPEC-14-480E). The fake provider does not load real tools, so it shows the tool settings sent, not that the model used them.
- Evidence: UNVERIFIED

<a id="mus-spec-14-480b"></a>
#### MUS-SPEC-14-480B: An idle chat that just asked for the plugin is re-sent; other chats are left alone

- Precondition: Four chats: one running a turn about "fake_tools", one idle whose last message was "list my open issues with fake_tools", one idle that wrote a haiku, and one running a turn about refactoring a parser.
- Action: Add the MCP server "fake_tools".
- Expected result: The idle chat that asked for the plugin is re-sent on a fresh session with the new server in its tool settings. The haiku chat and the parser chat get no stop, no re-send and no notice. The provider is stopped for the one running chat about the plugin and for no other.
- Test: `packages/agent-app/tests/plugin-reload.test.ts::an MCP server added mid-run restarts the running chat once and re-sends its prompt through the queue with the new tools`
- Environment: Node test runner; the agent service with a fake provider; no network.
- Known gaps: The 30-minute limit for idle chats is tested on its own in MUS-SPEC-14-480D, not through the service.
- Evidence: UNVERIFIED

<a id="mus-spec-14-480c"></a>
#### MUS-SPEC-14-480C: One install restarts a chat only once

- Precondition: The chats from MUS-SPEC-14-480A have been re-sent and have finished their turns.
- Action: Add a second MCP server "other_tools" that no chat mentioned.
- Expected result: No chat is re-sent and the provider is not stopped again.
- Test: `packages/agent-app/tests/plugin-reload.test.ts::an MCP server added mid-run restarts the running chat once and re-sends its prompt through the queue with the new tools`
- Environment: Node test runner; the agent service with a fake provider; no network.
- Known gaps: Does not install the same plugin twice. The once-per-chat rule for one install is checked only in MUS-SPEC-14-480D.
- Evidence: UNVERIFIED

<a id="mus-spec-14-480d"></a>
#### MUS-SPEC-14-480D: A turn counts as about a plugin only if it names it, and an idle one only if it was recent

- Precondition: A plugin named "linear" and a chat whose last message is "summarise my Linear issues", followed by a steering message.
- Action: Check whether the turn is about the plugin: just ended, ended 30 minutes and 1 ms ago, and for a plugin named "slack". Check "a nonlinear problem". Claim the install for the same chat twice.
- Expected result: The recent turn is about "linear". The old turn, the "slack" plugin and the word inside "nonlinear" are not. The steering message is not taken as the last message. The first claim for a chat is true and the second is false; another chat can still claim it.
- Test: `packages/agent-app/tests/plugin-reload.test.ts::a turn is about a plugin only when it names it and ended recently`
- Environment: Node test runner; pure functions, no service or network.
- Known gaps: Unit test of the matching rules, not a running chat. It is added to the service-level cases above and not instead of them.
- Evidence: UNVERIFIED

<a id="mus-spec-14-480e"></a>
#### MUS-SPEC-14-480E: Only a finished install is read as a new plugin

- Precondition: The results of the install commands: a Notion marketplace install that has connector apps, an enabled MCP server "linear", a disabled MCP server, an uninstall and an empty result.
- Action: Read each result as an installed plugin.
- Expected result: The first two give a plugin with its names; the marketplace one is marked as having connectors. The disabled server, the uninstall and the empty result give nothing.
- Test: `packages/agent-app/tests/plugin-reload.test.ts::installedPlugin reads marketplace installs and added MCP servers, nothing else`
- Environment: Node test runner; pure function, no service or network.
- Known gaps: Unit test of the parser. The service-level test drives only the MCP command.
- Evidence: UNVERIFIED
