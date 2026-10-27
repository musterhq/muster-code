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
| [MUS-SPEC-14-290A](14-agents-skills-plugins-and-automations.md#mus-spec-14-290a) | After a failed start-up and after a normal dispose, no scheduler tick runs against the closed database and the wake-up does nothing. | [`a domain set that fails to start or is disposed leaves no scheduler tick or wake behind`](../../../packages/agent-app/tests/domain-seam.test.ts) |
| [MUS-SPEC-14-651A](14-agents-skills-plugins-and-automations.md#mus-spec-14-651a) | A sub-agent name skips a leading location or boilerplate clause and keeps the task; a provider name still wins; a thread id is never a name. | [`a sub-agent is named from its task, not from the location clause the prompt opens with`](../../../packages/agent-app/tests/subagent-names-651.test.ts) |
| [MUS-SPEC-14-651B](14-agents-skills-plugins-and-automations.md#mus-spec-14-651b) | Two agents asked the same thing get "(2)" and "(3)"; a prompt with no readable task falls back to "Agent N". | [`names stay unique within a chat, and an unreadable prompt falls back to Agent N plus its first distinctive words`](../../../packages/agent-app/tests/subagent-names-651.test.ts) |
| [MUS-SPEC-14-651C](14-agents-skills-plugins-and-automations.md#mus-spec-14-651c) | The transcript announces three differently named sub-agents started together and each finished once, even though every prompt opens the same way. | [`three parallel sub-agents with the same location clause show three distinct rows in the transcript`](../../../packages/agent-app/tests/subagent-names-651.test.ts) |
| [MUS-SPEC-14-651E](14-agents-skills-plugins-and-automations.md#mus-spec-14-651e) | With three finished agents the panel lists three different names and its header reads "0 running 3 completed", not "0 completed 3 reported back". | [`three finished sub-agents with one location clause list three distinct names and read three completed`](../../../packages/agent-app/tests/subagent-components.tsx) |
| [MUS-SPEC-14-721E](14-agents-skills-plugins-and-automations.md#mus-spec-14-721e) | A desktop app is driven with no other app's plugin installed: reading it lists its controls, a click answers with only the lines that changed (a changed element once, as its new line), element numbers stay valid across steps and an unknown number is refused. | [`MUS-SPEC-14-721E: an agent drives a desktop app with Muster alone and each step answers with only what changed`](../../../packages/agent-app/tests/computer-mcp.test.ts) |
| [MUS-SPEC-14-721F](14-agents-skills-plugins-and-automations.md#mus-spec-14-721f) | In a read-only chat the click and type tools are not offered, a click is refused, and the app is unchanged. | [`MUS-SPEC-14-721F: a read-only chat can look at apps but not change them`](../../../packages/agent-app/tests/computer-mcp.test.ts) |
| [MUS-SPEC-14-721G](14-agents-skills-plugins-and-automations.md#mus-spec-14-721g) | Every agent chat gets the muster_computer server on Codex and Claude Code, a Full access router chat still runs on its own route, and without the helper the old note stays. | [`MUS-SPEC-14-721G: every agent chat gets Muster computer use on every MCP route, without forcing router chats onto Codex`](../../../packages/agent-app/tests/computer-mcp.test.ts) |

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

<a id="mus-spec-14-290a"></a>
#### MUS-SPEC-14-290A: No scheduler tick or wake after start-up fails or the app is disposed

- Precondition: The scheduler's first tick is due within a few milliseconds. One start-up fails part-way (two domains register the same command), and a second start-up is disposed normally.
- Action: The database closes, the machine wakes from sleep, and time passes beyond several scheduler ticks.
- Expected result: No scheduler tick runs, nothing is logged as "automations: tick failed", and the wake-up does nothing.
- Test: `packages/agent-app/tests/domain-seam.test.ts::a domain set that fails to start or is disposed leaves no scheduler tick or wake behind`
- Environment: Node test runner with an in-memory SQLite database.
- Known gaps: Uses a short real timer, not a slow runner. A dispose in the middle of a running automation run is not covered.
- Evidence: UNVERIFIED

### Sub-agent names and counts (#651)

<a id="mus-spec-14-651a"></a>
#### MUS-SPEC-14-651A: A sub-agent is named from its task, not from the location clause

- Precondition: Three prompts that all start "In the repository at /private/tmp/…," and then ask for different jobs (count lines, list files, summarize a README), plus prompts that open with "You are …", "Please", "Task:" or a Windows path.
- Action: Work out the display name of each sub-agent from its prompt, role and provider name.
- Expected result: The three names are "Count the lines in data/lines.txt", "List the files in assets/" and "Summarize README.md in 5 words". Boilerplate is skipped, long tasks are cut at a word with an ellipsis, a prompt that is only a location or a path gives no task name, a provider name wins over the prompt, the task wins over a generic role, and a thread id becomes "Agent N".
- Test: `packages/agent-app/tests/subagent-names-651.test.ts::a sub-agent is named from its task, not from the location clause the prompt opens with`
- Environment: Node test runner; pure functions, no service or network.
- Known gaps: Prompt shapes are the ones seen in QA plus a few common openings; other phrasings fall back to the first clause of the prompt.
- Evidence: UNVERIFIED

<a id="mus-spec-14-651b"></a>
#### MUS-SPEC-14-651B: Sub-agent names are unique within a chat

- Precondition: Three sub-agents in one chat whose prompts give the same task, and agents with no prompt or only a path.
- Action: Work out the display names of the whole chat together.
- Expected result: Repeats get " (2)" and " (3)" in order, case ignored. An agent with no readable task is "Agent N", numbered by its place in the chat.
- Test: `packages/agent-app/tests/subagent-names-651.test.ts::names stay unique within a chat, and an unreadable prompt falls back to Agent N plus its first distinctive words`
- Environment: Node test runner; pure functions, no service or network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-14-651c"></a>
#### MUS-SPEC-14-651C: Three parallel sub-agents show three distinct rows in the transcript

- Precondition: A chat whose timeline holds three spawn reports and one wait report that finishes all three; every prompt starts "In the repository at /private/tmp/…,".
- Action: Build the transcript rows for that timeline.
- Expected result: One "started working" row names all three agents by their tasks. Three separate "finished" rows follow, one per agent, each with its own task name.
- Test: `packages/agent-app/tests/subagent-names-651.test.ts::three parallel sub-agents with the same location clause show three distinct rows in the transcript`
- Environment: Node test runner; the real transcript grouping code on a timeline of tool reports; no service or network.
- Known gaps: Uses timeline reports in the shape the Codex provider sends. The Claude Code adapter names its children from the task description it gives.
- Evidence: UNVERIFIED

<a id="mus-spec-14-651e"></a>
#### MUS-SPEC-14-651E: The Subagents panel reads finished agents as completed

- Precondition: A chat whose three sub-agents all finished, each with a reported result, and whose prompts all open with the same location clause. The Subagents panel is open.
- Action: Read the card names and the count line in the panel header.
- Expected result: The three cards show the three task names. The header count line reads "0 running" and "3 completed" and shows no separate "reported back" count.
- Test: `packages/agent-app/tests/subagent-components.tsx::three finished sub-agents with one location clause list three distinct names and read three completed`
- Environment: DOM suite built with esbuild and run with Node and linkedom; the real panel component and store; the bridge is a fixture.
- Known gaps: The card still tells "Reported back" from "Completed" on its own badge; only the header folds them.
- Evidence: UNVERIFIED

### Muster computer use (#721)

<a id="mus-spec-14-721e"></a>
#### MUS-SPEC-14-721E: An agent drives a desktop app with Muster alone, one small answer per step

- Precondition: macOS with Accessibility allowed for the runner. No other desktop app's computer-use plugin is involved. A fixture app with a notes field, an "Add one" button and a "Count 0" label is built from `tests/fixtures/computer-use/fixture-app.swift`.
- Action: Over stdio, start the shipped `dist/main/computer-mcp.cjs` with the shipped `dist/main/muster-computer` helper. Read the app, click "Add one" by element number, type into Notes, click again, then click element 9999.
- Expected result: The server names itself muster_computer and lists nine tools. Reading the app shows the button and "Count 0". The click answers within 3 s, after the app settles, with "Changed:" followed only by the label's new line ("Count 1"). It does not repeat the old value or the unchanged button line. The transcript names the step "Clicked “Add one” in MusterFixture", not an element number or the app's path. The typed text shows in the next answer. The second click with the same number gives "Count 2". Element 9999 is refused with an error.
- Test: `packages/agent-app/tests/computer-mcp.test.ts::MUS-SPEC-14-721E: an agent drives a desktop app with Muster alone and each step answers with only what changed`
- Environment: Node test runner on macOS with a real AppKit app and the real helper. Skipped when Accessibility is not granted, unless `MUSTER_REQUIRE_COMPUTER_E2E=1`.
- Known gaps: Windows and Linux backends are not built yet. CI macOS runners have no Accessibility grant, so this runs on a developer Mac.
- Evidence: UNVERIFIED

<a id="mus-spec-14-721f"></a>
#### MUS-SPEC-14-721F: A read-only chat can look at apps but not change them

- Precondition: The same fixture app and shipped server as 721E, started with `MUSTER_COMPUTER_READ_ONLY=1` (what a read-only chat gets).
- Action: List the tools, read the app, then call click on "Add one".
- Expected result: click and type_text are not in the tool list. The click is refused with a message that the chat is read-only. Reading the app again still shows "Count 0".
- Test: `packages/agent-app/tests/computer-mcp.test.ts::MUS-SPEC-14-721F: a read-only chat can look at apps but not change them`
- Environment: As 721E.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-14-721g"></a>
#### MUS-SPEC-14-721G: Every agent chat gets Muster computer use, on every MCP route

- Precondition: A computer-use launcher file exists, as main writes it on macOS when the helper ships.
- Action: Build the turn options for a workspace agent chat and a read-only one, pass them through the Claude Code route, check whether a Full access router chat may stay on its route, and build them once more with the launcher missing.
- Expected result: The Codex options register `mcp_servers.muster_computer` with the chat id and the read-only flag (0, then 1). The notes name muster_computer and no longer send the model to another app's plugin. The Claude Code route receives the server. A Full access router chat is still allowed on its own route. A muster_computer tool call shows as computer use in the transcript. Without the launcher the previous note is kept.
- Test: `packages/agent-app/tests/computer-mcp.test.ts::MUS-SPEC-14-721G: every agent chat gets Muster computer use on every MCP route, without forcing router chats onto Codex`
- Environment: Node test runner; no desktop needed.
- Known gaps: OpenCode and Grok get the server through the same overrides but are not checked here.
- Evidence: UNVERIFIED
