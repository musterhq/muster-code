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
| [MUS-SPEC-14-729A](14-agents-skills-plugins-and-automations.md#mus-spec-14-729a) | Claude Code skills and commands from the user folder and a chat folder are listed with descriptions and argument hints; nested commands read `fe:comp`; non-skill folders are skipped. | [`the skills picker lists Claude Code skills and commands from ~/.claude with their descriptions, nested commands as fe:comp, and skips folders that are not skills`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-729B](14-agents-skills-plugins-and-automations.md#mus-spec-14-729b) | A picked command on a Claude Code chat goes to Claude Code as `/bar <request>`, Claude Code expands it, and one "Ran /bar" row opens to the expansion. | [`a picked command on a Claude Code chat is sent as /bar with the request as its arguments, Claude Code expands it, and the transcript shows "Ran /bar the login flow"`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-729C](14-agents-skills-plugins-and-automations.md#mus-spec-14-729c) | Entries from the user folder show in every chat folder; a folder's own entries only there, and another folder's entry is refused. | [`~/.claude entries show in every folder; a folder's .claude skills and commands only in that folder`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-729D](14-agents-skills-plugins-and-automations.md#mus-spec-14-729d) | A command turned off in Skills & plugins leaves the picker and a send that still names it is refused. | [`a command turned off in Skills & plugins leaves the picker and a send that still names it is refused`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-729E](14-agents-skills-plugins-and-automations.md#mus-spec-14-729e) | Tool rows from connector and plugin servers draw that plugin's logo under every name they arrive with, and read the tool, not the server plumbing. | [`tool rows from connector and plugin servers draw that plugin's logo and read the tool, under every name the coding clients give them`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-729F](14-agents-skills-plugins-and-automations.md#mus-spec-14-729f) | In the `/` picker a Claude Code command reads `/bar` under Commands, after the built-ins, with a Claude Code badge and its argument hint; skills stay under Skills. | [`the / picker lists a Claude Code command as /name under Commands with a Claude Code badge and its argument hint`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-729G](14-agents-skills-plugins-and-automations.md#mus-spec-14-729g) | Transcript MCP tool rows show the providing plugin's icon and read "GitHub / search issues"; unbranded servers keep the thin glyph. | [`MCP tool rows show the providing plugin mark; built-in servers keep the generic glyph`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-729H](14-agents-skills-plugins-and-automations.md#mus-spec-14-729h) | A picked Claude Code skill on a Claude Code chat is sent as `/foo <request>` and reads "Used foo skill". | [`a picked Claude Code skill on a Claude Code chat is invoked by name too and reads "Used foo skill"`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-729I](14-agents-skills-plugins-and-automations.md#mus-spec-14-729i) | On a chat that does not run Claude Code, a picked command's expansion is inlined with numbered arguments filled. | [`the same command on a chat that does not run Claude Code gets its expansion inlined, with numbered arguments filled`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-729J](14-agents-skills-plugins-and-automations.md#mus-spec-14-729j) | Picking /bar makes a chip that reads `/bar`, closes the picker, and the send carries the command. | [`picking /bar inserts a chip that reads /bar and sends the command structurally`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-729K](14-agents-skills-plugins-and-automations.md#mus-spec-14-729k) | Typing `/bar the signup flow` without picking makes the same chip and send; a built-in `/status` keeps its meaning. | [`a hand-typed /bar is recognised as the Claude Code command and sent with it; a built-in /status keeps its own meaning`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-729L](14-agents-skills-plugins-and-automations.md#mus-spec-14-729l) | Connectors & MCP rows for plugin servers, apps and user servers named after a plugin show its logo, and the `@mcp` chip leads with it. | [`Connectors & MCP rows carry the plugin mark: a plugin server, its app and a user server named after the plugin`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-729M](14-agents-skills-plugins-and-automations.md#mus-spec-14-729m) | Each server in Settings › MCP servers shows its plugin logo or a neutral tile, with the health dot on it. | [`Settings › MCP servers shows each server with its plugin mark or a neutral tile, with the health dot on the mark`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-729N](14-agents-skills-plugins-and-automations.md#mus-spec-14-729n) | Opening `/` in a folder chat lists that folder's `.claude` commands even after skills were loaded for another scope. | [`opening / in a folder chat lists that folder's .claude commands even when skills were already loaded for another scope`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-729O](14-agents-skills-plugins-and-automations.md#mus-spec-14-729o) | A skill installed for both clients with the same `SKILL.md` is listed once, as the Claude Code skill, and still runs natively; different same-named skills both stay. | [`a skill installed for both clients (~/.agents/skills and ~/.claude/skills, same SKILL.md) is listed once, as the Claude Code skill; a same-named but different skill stays listed twice`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-729P](14-agents-skills-plugins-and-automations.md#mus-spec-14-729p) | A "Ran /bar" row reads like the typed command, carries the picker's slash glyph, and says where the command came from instead of repeating its arguments as raw JSON. | [`a "Ran /bar" row reads like the typed command, carries the slash glyph and says where the command came from`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-729Q](14-agents-skills-plugins-and-automations.md#mus-spec-14-729q) | A plugin logo over the icon budget is scaled down and shown, in Skills & plugins and on its MCP server, instead of a monogram | [`a plugin whose logo file is over the icon budget (Computer Use ships a 900 KB, 1024px PNG) still shows its logo, scaled down, in Skills & plugins and on its MCP server`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-729R](14-agents-skills-plugins-and-automations.md#mus-spec-14-729r) | A connector app known only by an opaque id reads as its plugin in the + menu, on its chip and in the message | [`an app known only by an opaque id reads as its plugin in the + menu, on its chip and in the message the agent gets`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-729S](14-agents-skills-plugins-and-automations.md#mus-spec-14-729s) | A remote plugin that ships no logo shows the logo Codex lists for it, cached locally, and keeps its monogram when nothing safe is available | [`an installed remote plugin with no logo on disk (Atlassian) shows the logo Codex lists for it, kept in a local cache; unsafe or non-image downloads keep the monogram`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-729T](14-agents-skills-plugins-and-automations.md#mus-spec-14-729t) | A plugin from another marketplace that ships no logo shows the logo an OpenAI catalog lists under its exact name | [`a marketplace plugin with no logo (the Claude marketplace’s linear) shows the logo an OpenAI catalog lists under the same name; other marketplaces, other names and skills keep their monogram`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-729U](14-agents-skills-plugins-and-automations.md#mus-spec-14-729u) | An open + menu redraws a plugin row with its logo when the background refresh caches it. | [`an open + menu redraws Atlassian with its logo when the background refresh caches it`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-729V](14-agents-skills-plugins-and-automations.md#mus-spec-14-729v) | An open Skills & plugins screen redraws a catalog card with its borrowed logo when it is cached. | [`an open Skills & plugins screen redraws Linear with the logo borrowed from the OpenAI catalog when it is cached`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-729W](14-agents-skills-plugins-and-automations.md#mus-spec-14-729w) | The New chat + menu lists MCP servers and plugin apps with their marks, as a chat's composer does. | [`the New chat + menu lists MCP servers and plugin apps with their marks, and a pick inserts the connector chip`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-732A](14-agents-skills-plugins-and-automations.md#mus-spec-14-732a) | A command file swapped for a symlink right after it is checked is not read through the link, in the picker or when a run attaches it. | [`a command file swapped for a symlink right after it is checked is not read through the link, in the picker or when a run attaches it`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-732B](14-agents-skills-plugins-and-automations.md#mus-spec-14-732b) | A logo URL that redirects to plain http is never fetched over http; an https to https redirect still brings the logo. | [`a logo URL that redirects to plain http is never fetched over http; an https to https redirect still brings the logo`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-732C](14-agents-skills-plugins-and-automations.md#mus-spec-14-732c) | An entry Claude Code would not reach by its name (a project command under a personal one, a command under a same-named skill) runs as picked, inlined, not as `/name`. | [`an entry Claude Code would not reach by its name (a project command under a personal one, a command under a same-named skill) runs as picked, inlined, not as /name`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-732D](14-agents-skills-plugins-and-automations.md#mus-spec-14-732d) | A folder whose `.claude/skills` is a link to its `.agents/skills` lists the skill as Claude Code's, and a Claude Code run invokes it by name. | [`a folder whose .claude/skills is a link to its .agents/skills lists the skill as Claude Code's and a Claude Code run invokes it by name`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-732E](14-agents-skills-plugins-and-automations.md#mus-spec-14-732e) | A logo download that fails for a reason that may pass (offline, a 5xx or 429, a timeout) is tried again after six hours, not a week later. A 404 or a non-image is not retried before the weekly refresh. | [`a logo download that fails is tried again after six hours, not a week later`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-732F](14-agents-skills-plugins-and-automations.md#mus-spec-14-732f) | A logo the browser cannot draw falls back to the monogram on its row; a light and dark pair keeps the variant that still draws. | [`a logo the browser cannot draw falls back to the monogram on its row; a pair keeps the variant that still draws`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-732G](14-agents-skills-plugins-and-automations.md#mus-spec-14-732g) | A hand-typed /name shared by a Claude Code skill and a command attaches the skill, as Claude Code would run it | [`a hand-typed /foo, when a Claude Code skill and a command share the name, attaches the skill Claude Code would run`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-732H](14-agents-skills-plugins-and-automations.md#mus-spec-14-732h) | When only the dark-theme logo draws, light theme gets the monogram instead of a logo it cannot show | [`when only the dark-theme logo still draws, it shows in dark theme and the light theme gets the monogram`](../../../packages/agent-app/tests/claude-skills-729-components.tsx) |
| [MUS-SPEC-14-732I](14-agents-skills-plugins-and-automations.md#mus-spec-14-732i) | A command folder swapped for a link to an outside folder while a command is read is refused, even if every check sees it restored | [`a command folder swapped for a link to an outside folder while it is read is refused, even if every check sees the folder restored`](../../../packages/agent-app/tests/confined-read-729.test.ts) |
| [MUS-SPEC-14-732J](14-agents-skills-plugins-and-automations.md#mus-spec-14-732j) | A command's arguments reach the run as typed: a quoted argument stays whole in $0, $1…, its spacing and the command's own name inside it are kept, inlined and native | [`an inlined command keeps a quoted argument whole, splitting its arguments the way Claude Code does`](../../../packages/agent-app/tests/claude-skills-729.test.ts) |
| [MUS-SPEC-14-732K](14-agents-skills-plugins-and-automations.md#mus-spec-14-732k) | The app's real image scaler shrinks a large plugin logo so it shows; an undecodable one keeps the monogram | [`a plugin logo over the icon budget is scaled by the app's real image scaler and shown; one it cannot decode keeps the monogram`](../../../packages/agent-app/tests/large-logo-729.electron.ts) |
| [MUS-SPEC-14-756A](14-agents-skills-plugins-and-automations.md#mus-spec-14-756a) | On a router model without tool search, a chat that names Figma (then Google Drive) loads only those connectors, keeps sub-agents on and never loads the whole connector catalog; no connector asked means none load; tool search keeps the catalog deferred. | [`a router chat that asks for Figma loads only the Figma connector and keeps sub-agents on, turn after turn`](../../../packages/agent-app/tests/router-subagents-756.test.ts) |

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

### Claude Code skills and commands (#729)

<a id="mus-spec-14-729a"></a>
#### MUS-SPEC-14-729A: Claude Code skills and commands are listed in the picker

- Precondition: A temporary HOME with ~/.claude/skills/foo/SKILL.md, ~/.claude/commands/bar.md (argument hint `<flow>`), ~/.claude/commands/fe/comp.md, a ~/.claude/skills/synced folder that holds no SKILL.md, and a project folder with its own .claude/skills/house-style and .claude/commands/ship.md.
- Action: List skills for the project folder.
- Expected result: foo (skill, "Formats the release notes"), bar (command, argument hint `<flow>`) and fe:comp (command) are listed with provenance `~/.claude` and their Claude Code kind. Nothing from the synced folder is listed.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::the skills picker lists Claude Code skills and commands from ~/.claude with their descriptions, nested commands as fe:comp, and skips folders that are not skills`
- Environment: Node test runner; the real agent service, provider, Claude Code lane and adapter, with a fake `claude` executable that replays the command it was given and answers; a temporary HOME; no network.
- Known gaps: Plugin-provided Claude Code skills come through the plugin inventory, not this scan.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729b"></a>
#### MUS-SPEC-14-729B: A picked command runs as a real Claude Code slash command

- Precondition: As 729A, and a chat on a Claude Code model in the project folder.
- Action: Pick bar and send `/bar the login flow`.
- Expected result: Claude Code is launched with the message `/bar the login flow` and `--replay-user-messages`; Muster does not inline the command body as well. The transcript gets one tool row "Ran /bar the login flow" that opens to the expanded body, followed by the answer.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::a picked command on a Claude Code chat is sent as /bar with the request as its arguments, Claude Code expands it, and the transcript shows "Ran /bar the login flow"`
- Environment: Node test runner; the real agent service, provider, Claude Code lane and adapter, with a fake `claude` executable that replays the command it was given and answers; a temporary HOME; no network.
- Known gaps: A steer into a running turn, a turn with images and a turn resumed from a fork summary inline the expansion instead. Only the first picked Claude Code entry runs natively.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729c"></a>
#### MUS-SPEC-14-729C: User entries everywhere, folder entries only in their folder

- Precondition: As 729A, plus a second folder.
- Action: List skills for both folders, then send the project folder's command from a chat in the other folder.
- Expected result: foo, bar and fe:comp show in both folders; ship and house-style only in the project folder. The cross-folder send is refused as outside the chat's allowed skill roots.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::~/.claude entries show in every folder; a folder's .claude skills and commands only in that folder`
- Environment: Node test runner; the real agent service, provider, Claude Code lane and adapter, with a fake `claude` executable that replays the command it was given and answers; a temporary HOME; no network.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729d"></a>
#### MUS-SPEC-14-729D: A turned-off command leaves the picker and cannot be sent

- Precondition: As 729A.
- Action: Turn bar off in Skills & plugins for the user, list skills, then send with its id.
- Expected result: bar is no longer listed and the send is refused with "The /bar command is disabled here".
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::a command turned off in Skills & plugins leaves the picker and a send that still names it is refused`
- Environment: Node test runner; the real agent service, provider, Claude Code lane and adapter, with a fake `claude` executable that replays the command it was given and answers; a temporary HOME; no network.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729e"></a>
#### MUS-SPEC-14-729E: Connector and plugin tool calls draw the plugin's logo

- Precondition: A chat whose plugin inventory has GitHub, Slack, Google Drive, Figma and Notion plugins, each with its own logo.
- Action: The transcript shows tool calls from the servers the coding clients and Claude Code report: `mcp__codex_apps__github`, `mcp__codex_apps__slack`, `codex_apps` with `google_drive.list_drives`, `plugin_figma_figma`, `claude_ai_Notion`, plus the built-in `mcp__node_repl` and `muster_browser`.
- Expected result: Each connector or plugin row draws its plugin's own logo and reads "<Plugin> / <tool>" ("GitHub / create pull request", "Slack / read channel", "Google Drive / list drives", "Notion / search"), with no server plumbing on the row. The REPL and browser rows keep their generic glyphs.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::tool rows from connector and plugin servers draw that plugin's logo and read the tool, under every name the coding clients give them`
- Environment: Real ToolCard in a DOM suite (linkedom); fake app bridge whose plugin inventory carries image logos; no network. The name resolution behind it is also unit-tested in `tests/claude-skills-729.test.ts`.
- Known gaps: Theme-specific CSS is not evaluated by linkedom; screenshots in both themes cover it.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729f"></a>
#### MUS-SPEC-14-729F: The `/` picker shows Claude Code commands as commands

- Precondition: A Claude Code chat whose skill list holds the command bar (argument hint `<flow>`, "Reviews a flow"), the Claude Code skill foo and a personal skill review.
- Action: Type `/`.
- Expected result: /bar sits under Commands after the built-in commands, with the Claude Code badge, the slash-command glyph and "<flow> · Reviews a flow". foo and review stay under Skills, foo badged Claude Code and review Personal; bar is not listed twice.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::the / picker lists a Claude Code command as /name under Commands with a Claude Code badge and its argument hint`
- Environment: Real Composer, ToolCard and McpServers in a DOM suite (linkedom); fake app bridge with a plugin inventory carrying image icons; no network.
- Known gaps: Not checked in the New chat screen, which uses the same helpers.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729g"></a>
#### MUS-SPEC-14-729G: Transcript tool rows show the plugin's own icon and name

- Precondition: A GitHub plugin and a Figma plugin with image icons.
- Action: Render tool rows from `mcp__codex_apps__github` (search_issues), `codex_apps` (figma.get_screenshot), postgres (run_query) and a failed `plugin_figma_figma` (get_metadata).
- Expected result: The GitHub and Figma rows show their logos and read "GitHub / search issues", "Figma / get screenshot" and "Figma / get metadata", with the raw server and tool in the tooltip. postgres keeps the thin glyph and its raw name.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::MCP tool rows show the providing plugin mark; built-in servers keep the generic glyph`
- Environment: Real Composer, ToolCard and McpServers in a DOM suite (linkedom); fake app bridge with a plugin inventory carrying image icons; no network.
- Known gaps: Pixel rendering and both themes are checked from screenshots, not in this suite.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729h"></a>
#### MUS-SPEC-14-729H: A picked Claude Code skill runs natively too

- Precondition: As 729B.
- Action: Pick foo and send `Draft the notes $foo`.
- Expected result: Claude Code is launched with `/foo Draft the notes`. The tool row reads "Used foo skill" and opens to the skill body.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::a picked Claude Code skill on a Claude Code chat is invoked by name too and reads "Used foo skill"`
- Environment: Node test runner; the real agent service, provider, Claude Code lane and adapter, with a fake `claude` executable that replays the command it was given and answers; a temporary HOME; no network.
- Known gaps: As 729B.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729i"></a>
#### MUS-SPEC-14-729I: Other chats get the command inlined

- Precondition: As 729A, and a chat on a model that does not run Claude Code.
- Action: Pick fe:comp and send `/fe:comp Button tailwind`.
- Expected result: Claude Code is not launched. The request carries "Selected command: /fe:comp" and the expansion "Build the Button component with tailwind styling." inside command-instructions.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::the same command on a chat that does not run Claude Code gets its expansion inlined, with numbered arguments filled`
- Environment: Node test runner; the real agent service, provider, Claude Code lane and adapter, with a fake `claude` executable that replays the command it was given and answers; a temporary HOME; no network.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729j"></a>
#### MUS-SPEC-14-729J: A picked command becomes a `/bar` chip and is sent with it

- Precondition: As 729F.
- Action: Pick /bar from the picker and press Send.
- Expected result: The chip reads `/bar` (kind skill), the picker closes, and chat.send carries the command's id.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::picking /bar inserts a chip that reads /bar and sends the command structurally`
- Environment: Real Composer, ToolCard and McpServers in a DOM suite (linkedom); fake app bridge with a plugin inventory carrying image icons; no network.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729k"></a>
#### MUS-SPEC-14-729K: A hand-typed `/bar` is recognised

- Precondition: As 729F.
- Action: Type `/bar the signup flow` and send; then type `/status now`.
- Expected result: The chip reads `/bar`; the send text is `/bar the signup flow` with the command's id. `/status` is drawn as the built-in command.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::a hand-typed /bar is recognised as the Claude Code command and sent with it; a built-in /status keeps its own meaning`
- Environment: Real Composer, ToolCard and McpServers in a DOM suite (linkedom); fake app bridge with a plugin inventory carrying image icons; no network.
- Known gaps: A Claude Code command named like a built-in (for example review) is only reachable by picking it.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729l"></a>
#### MUS-SPEC-14-729L: Connectors & MCP rows and chips show the plugin's icon

- Precondition: A GitHub plugin (server and app) and a Figma plugin with image icons; user MCP servers github and postgres.
- Action: Open the + menu, then pick github.
- Expected result: github, GitHub and figma show their logos; postgres keeps the server glyph. The `@mcp:github` chip leads with the GitHub logo.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::Connectors & MCP rows carry the plugin mark: a plugin server, its app and a user server named after the plugin`
- Environment: Real Composer, ToolCard and McpServers in a DOM suite (linkedom); fake app bridge with a plugin inventory carrying image icons; no network.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729m"></a>
#### MUS-SPEC-14-729M: Settings › MCP servers shows the plugin's icon

- Precondition: As 729L.
- Action: Open Settings › MCP servers.
- Expected result: github shows the GitHub logo and postgres a neutral server tile, each with the health dot in its corner.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::Settings › MCP servers shows each server with its plugin mark or a neutral tile, with the health dot on the mark`
- Environment: Real Composer, ToolCard and McpServers in a DOM suite (linkedom); fake app bridge with a plugin inventory carrying image icons; no network.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729n"></a>
#### MUS-SPEC-14-729N: The `/` picker reads the chat's own folder

- Precondition: A chat in a folder whose `.claude/commands` holds `deploy.md`; the skills list was already loaded without that folder (at start-up, from Skills & plugins or from another chat).
- Action: Type `/` in that chat's composer.
- Expected result: The picker asks for this chat's folder and lists `/deploy` under Commands. The New chat screen does the same for its selected folder.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::opening / in a folder chat lists that folder's .claude commands even when skills were already loaded for another scope`
- Environment: Real Composer and store in a DOM suite (linkedom); fake app bridge whose skill list depends on the folders asked for; no network.
- Known gaps: The New chat screen is covered by the dogfood pass, not by this suite.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729o"></a>
#### MUS-SPEC-14-729O: A skill installed for both clients is listed once

- Precondition: `foo` has the same `SKILL.md` under `~/.agents/skills` and `~/.claude/skills`; `twin` exists in both with different content.
- Action: List skills; send `$foo the notes` on a Claude Code chat with the listed `foo`.
- Expected result: `foo` is listed once, as the Claude Code skill, and Claude Code receives `/foo the notes`. Both `twin` entries stay listed.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::a skill installed for both clients (~/.agents/skills and ~/.claude/skills, same SKILL.md) is listed once, as the Claude Code skill; a same-named but different skill stays listed twice`
- Environment: Real service, provider adapter, router Claude Code lane and Claude Code adapter with a fake `claude` executable and a temporary home; no network.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729p"></a>
#### MUS-SPEC-14-729P: A command row reads like the command that was typed

- Precondition: A Claude Code chat whose transcript has the row for `/bar the login flow`, run from the folder's `.claude/commands/bar.md`.
- Action: Look at the row, hover it, then open it.
- Expected result: The row reads "Ran /bar the login flow" with the same slash glyph the picker uses. Hovering shows the command's source and file. Opened, it shows `/bar the login flow`, the expansion under "Expanded prompt", and a Source entry; the arguments are not repeated as raw JSON.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::a "Ran /bar" row reads like the typed command, carries the slash glyph and says where the command came from`
- Environment: Real ToolCard in a DOM suite (linkedom) with a recorded command row; no network.
- Known gaps: A skill row keeps the "Used foo skill" wording and the skill glyph.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729q"></a>
#### MUS-SPEC-14-729Q: A large plugin logo still shows

- Precondition: An installed plugin whose manifest logo is a raster file over the 256 KB icon budget (Computer Use ships a 923 KB, 1024px PNG), and an MCP server with the plugin's name.
- Action: Open Skills & plugins (Plugins and MCP tabs), the composer's connector menu, and a transcript with one of the server's tool calls.
- Expected result: Every one of those places shows the plugin's own logo, scaled to 128px, not a "CU" monogram. Raster logos up to 8 MB and 4096px are scaled; anything larger, or a logo that cannot be decoded, still falls back to the monogram. SVG logos keep their own budget and are never rasterised.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::a plugin whose logo file is over the icon budget (Computer Use ships a 900 KB, 1024px PNG) still shows its logo, scaled down, in Skills & plugins and on its MCP server`
- Environment: Real agent service and plugin discovery against a temporary ~/.codex plugin cache with a 1 MB PNG. The test uses a stand-in scaler; 732K runs the app's real downscaler on Electron's nativeImage. Live check in an isolated Muster instance with the real Computer Use plugin.
- Known gaps: The Node test checks the scaled logo on the plugin and on its MCP server mark; drawing those marks on rows is 729E, 729G, 729L and 729M. The 4096px dimension limit has no fixture (a valid PNG that size is too large to build in the test). The rejection paths are covered: a raster over 8 MB, one the scaler cannot decode, and an SVG over its own budget all keep the monogram, and only the decodable raster reaches the scaler.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729r"></a>
#### MUS-SPEC-14-729R: A connector app reads by name, never by id

- Precondition: An installed remote connector plugin (Atlassian) whose only app is named by its opaque id, `app-6a83901dde988191b3f3cefdcc19acfa`, and which ships no logo.
- Action: Open the composer's + menu, pick the app under Connectors & MCP, then send.
- Expected result: The row reads "Atlassian" with the App badge, the plugin's description ("Jira, Confluence, Loom, & more") and the plugin's mark (its logo once MUS-SPEC-14-729S has cached it, else its monogram). The chip and the message the agent gets read `@app:Atlassian`; the raw id appears nowhere. Apps with real names keep them.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::an app known only by an opaque id reads as its plugin in the + menu, on its chip and in the message the agent gets`
- Environment: Real Composer in a DOM suite (linkedom); fake app bridge whose plugin inventory includes the Atlassian app; no network.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729s"></a>
#### MUS-SPEC-14-729S: A remote plugin without a logo file still shows its logo

- Precondition: An installed remote plugin (Atlassian, `app-6a83901dde988191b3f3cefdcc19acfa@openai-curated-remote`) whose manifest has no `logo` or `composerIcon` and whose cache folder has no images, while Codex's `plugin/list` gives it `composerIconUrl` and `logoUrlDark`.
- Action: Start Muster, wait for the background refresh (20 s after launch), then open the + menu, Skills & plugins, Settings › MCP servers and a transcript with one of its tool calls.
- Expected result: Every one of those places shows Atlassian's logo, with the dark variant in the dark theme, and an open menu redraws when the logo arrives. Only absolute https URLs are fetched, at most 2 MB each; the bytes must be a PNG, JPEG, GIF, WebP or safe SVG, and then go through the same checks and scaling as a logo file on disk. Plugins that are not installed are skipped. Logos are kept under the data dir and shown offline; the list is read again after a week (after six hours when a try failed). A plugin with no usable logo keeps its monogram.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::an installed remote plugin with no logo on disk (Atlassian) shows the logo Codex lists for it, kept in a local cache; unsafe or non-image downloads keep the monogram`
- Environment: Real agent service and plugin discovery against a temporary ~/.codex plugin cache; an injected `plugin/list` answer and fetch stand in for the Codex app-server and the CDN. Live check in an isolated Muster instance against the real Codex app-server and the installed Atlassian plugin.
- Known gaps: Needs a working Codex CLI (on PATH or bundled with a desktop app) to read `plugin/list`; without one, plugins with no logo file keep their monogram.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729t"></a>
#### MUS-SPEC-14-729T: A marketplace plugin without a logo borrows its brand's logo

- Precondition: A Claude marketplace source lists plugins `linear`, `gitlab` and `firebase` with no logo in their manifests or folders, and Codex's `plugin/list` has `linear@openai-curated-remote` (and the others) with a logo, not installed.
- Action: Open Skills & plugins › Discover and wait a few seconds.
- Expected result: Linear, GitLab and Firebase show their logos, the open screen redraws when they arrive, and an MCP server those plugins bring carries the same mark. Only plugin packages are matched, by their exact name, and only against catalogs whose marketplace is `openai-*`; a name only a third-party catalog lists, and a skill of the same name, keep their monogram. Each name is looked up once and cached with the logos of MUS-SPEC-14-729S (same https, size and image checks, refreshed weekly); names asked for before the first refresh ride along with it, later ones get one short coalesced lookup.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::a marketplace plugin with no logo (the Claude marketplace’s linear) shows the logo an OpenAI catalog lists under the same name; other marketplaces, other names and skills keep their monogram`
- Environment: Real agent service, a local Claude marketplace and skills folder as sources; an injected `plugin/list` answer and fetch stand in for the Codex app-server and the CDN. DOM check `tests/claude-skills-729-components.tsx` for the open screen redrawing. Live check in an isolated Muster instance against the real Claude marketplace and Codex catalog.
- Known gaps: A plugin whose name differs from its brand's catalog entry (discord, telegram, context7, terraform today) keeps its monogram; so do plugins no catalog lists with a logo.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729u"></a>
#### MUS-SPEC-14-729U: An open + menu picks up a newly cached logo

- Precondition: The + menu is open and lists Atlassian under Connectors & MCP with its monogram.
- Action: The background refresh of MUS-SPEC-14-729S caches Atlassian's logo and the runtime sends `pluginIconsChanged`.
- Expected result: Plugins are read again once; the menu stays open and the Atlassian row now shows the logo.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::an open + menu redraws Atlassian with its logo when the background refresh caches it`
- Environment: Real Composer and PluginsScreen in a DOM suite (linkedom); fake app bridge that replays a `pluginIconsChanged` event; no network.
- Known gaps: Pixel rendering and both themes are checked from screenshots, not in this suite.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729v"></a>
#### MUS-SPEC-14-729V: An open Skills & plugins screen picks up a borrowed logo

- Precondition: Skills & plugins › Discover is open and shows the Claude marketplace's linear card with its monogram.
- Action: MUS-SPEC-14-729T caches Linear's logo and the runtime sends `pluginIconsChanged`.
- Expected result: The catalog is read again once and the Linear card shows the logo without leaving the screen.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::an open Skills & plugins screen redraws Linear with the logo borrowed from the OpenAI catalog when it is cached`
- Environment: Real Composer and PluginsScreen in a DOM suite (linkedom); fake app bridge that replays a `pluginIconsChanged` event; no network.
- Known gaps: Pixel rendering and both themes are checked from screenshots, not in this suite.
- Evidence: UNVERIFIED

<a id="mus-spec-14-729w"></a>
#### MUS-SPEC-14-729W: The New chat + menu lists connectors with their marks

- Precondition: A user MCP server named after an installed plugin (github), a server no plugin brings (postgres), and plugins that bring a server (figma) and an app known only by an opaque id (Atlassian).
- Action: Open the + menu on the New chat screen, then pick the Atlassian row.
- Expected result: A Connectors & MCP section lists github, postgres, GitHub, figma and Atlassian, in that order. A server a plugin already brings is not listed twice. github and figma show their plugin logos, postgres shows the generic server glyph, and each row has an MCP or App badge. Picking Atlassian closes the menu and inserts an `@app:` chip that wears the Atlassian mark and puts `@app:Atlassian` in the draft.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::the New chat + menu lists MCP servers and plugin apps with their marks, and a pick inserts the connector chip`
- Environment: Real NewChatScreen in a DOM suite (linkedom); fake app bridge answering `mcp.servers.list` and `plugins.inventory`; no network.
- Known gaps: Pixel rendering and both themes are checked from screenshots, not in this suite.
- Evidence: UNVERIFIED

<a id="mus-spec-14-732a"></a>
#### MUS-SPEC-14-732A: A command file swapped for a link after it is checked is not read through it

- Precondition: `~/.claude/commands/swap.md` exists, and a file outside the commands folder holds a secret.
- Action: Between the last containment check and the read, the command file is replaced by a symlink to the secret (the test swaps it when the path is resolved for the second time). Then the picker lists commands and a run attaches `swap`.
- Expected result: Neither the picker nor the attached command ever contains the secret: the file is opened without following a link and must still be the file that passed the check. An untouched command still reads normally.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::a command file swapped for a symlink right after it is checked is not read through the link, in the picker or when a run attaches it`
- Environment: Real discovery and attachment against a temporary home; `fs.promises.realpath` wrapped to swap the file at that moment.
- Known gaps: Swapping a parent folder for a link is closed by 732I on macOS (O_NOFOLLOW_ANY) and Linux (the kernel's path for the opened file must be the checked one; without /proc the read is refused). Windows opens with the containment and same-file checks only; creating a link there needs admin rights or Developer Mode.
- Evidence: UNVERIFIED

<a id="mus-spec-14-732b"></a>
#### MUS-SPEC-14-732B: A logo redirect to plain http is never followed

- Precondition: Two installed remote plugins with no logo on disk: one's logo URL redirects to an `http:` URL, the other's redirects (relative Location) to another https URL.
- Action: The background logo refresh runs.
- Expected result: No request is ever made over http. The plugin behind the http redirect keeps its monogram; the https-redirected one shows its logo.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::a logo URL that redirects to plain http is never fetched over http; an https to https redirect still brings the logo`
- Environment: Real service and refresh; a fake fetch that follows redirects itself unless asked for `redirect: 'manual'`, as fetch does; no network.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-14-732c"></a>
#### MUS-SPEC-14-732C: An entry Claude Code would not reach by its name runs as picked

- Precondition: A personal and a project command both named `bar`; a personal skill and a personal command both named `foo`. Claude Code runs a skill over a command of the same name, and a personal entry over a project's.
- Action: On a Claude Code chat, send with each of the four entries picked.
- Expected result: The project `bar` and the `foo` command are inlined with their own text filled in, never sent as `/bar` or `/foo`. The personal `bar` and the `foo` skill, which Claude Code does reach, are still sent as `/bar the API` and `/foo the notes`.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::an entry Claude Code would not reach by its name (a project command under a personal one, a command under a same-named skill) runs as picked, inlined, not as /name`
- Environment: Real service, provider adapter and router Claude lane with a fake `claude` executable; temporary home and folder.
- Known gaps: Enterprise-managed and plugin-namespaced entries are not listed by Muster, so they are not ranked.
- Evidence: UNVERIFIED

<a id="mus-spec-14-732d"></a>
#### MUS-SPEC-14-732D: A linked .claude/skills folder still runs its skills natively

- Precondition: A folder with `.agents/skills/shared-notes/SKILL.md`, and `.claude/skills` a symlink to `.agents/skills`.
- Action: List the folder's skills, then send `the notes $shared-notes` with it picked on a Claude Code chat.
- Expected result: The skill is listed once, as a Claude Code skill, and Claude Code receives `/shared-notes the notes`.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::a folder whose .claude/skills is a link to its .agents/skills lists the skill as Claude Code's and a Claude Code run invokes it by name`
- Environment: Real service and Claude lane with a fake `claude` executable; temporary folder.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-14-732e"></a>
#### MUS-SPEC-14-732E: A failed logo download is retried after six hours

- Precondition: An installed remote plugin with no logo on disk whose listed logo URL answers 503.
- Action: Launch three times: at the start, one hour later (the URL now serves the logo), and seven hours later.
- Expected result: The first launch tries the download once. One hour later nothing is tried again and the monogram stays. Seven hours later the download is tried again, the app is told the marks changed, and the plugin shows its logo.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::a logo download that fails is tried again after six hours, not a week later`
- Environment: Real service and refresh with an injected clock and fake fetch; no network.
- Known gaps: The 404 and non-image cases are covered by 729S's check that a fresh cache is not refreshed on every launch.
- Evidence: UNVERIFIED

<a id="mus-spec-14-732f"></a>
#### MUS-SPEC-14-732F: A logo that cannot be drawn falls back to the monogram

- Precondition: A tool row whose server's plugin has a logo, and a plugin mark with light and dark variants.
- Action: The browser reports an error loading the tool row's logo, then the dark variant, then the light one.
- Expected result: The tool row shows the plugin's monogram in place of the broken logo. After the dark variant fails, the light logo shows in both themes. After both fail, the monogram shows.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::a logo the browser cannot draw falls back to the monogram on its row; a pair keeps the variant that still draws`
- Environment: Real ToolCard and PluginIcon in a DOM suite (linkedom); the error event is dispatched on the image.
- Known gaps: A real undecodable file is not decoded in this suite; screenshots cover the drawn result.
- Evidence: UNVERIFIED

<a id="mus-spec-14-732g"></a>
#### MUS-SPEC-14-732G: A typed /name shared by a skill and a command attaches the skill

- Precondition: A Claude Code chat with the personal Claude Code skill foo and a personal Claude Code command foo, the command listed first.
- Action: Type `/foo the notes` by hand (no pick) and send.
- Expected result: The `/foo` chip attaches the skill foo, the entry Claude Code itself runs for `/foo`, so the native `/foo` and the attached entry agree.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::a hand-typed /foo, when a Claude Code skill and a command share the name, attaches the skill Claude Code would run`
- Environment: Real Composer in a DOM suite (linkedom); fake app bridge; no network.
- Known gaps: An explicit pick of the command is 732C (it is inlined, not sent as /foo).
- Evidence: UNVERIFIED

<a id="mus-spec-14-732h"></a>
#### MUS-SPEC-14-732H: A dark-only surviving logo does not vanish in light theme

- Precondition: A plugin mark with light and dark variants.
- Action: The browser reports an error loading the light variant.
- Expected result: The dark logo shows in dark theme only, and the light theme shows the monogram. A white dark-theme mark never sits on the light surface.
- Test: `packages/agent-app/tests/claude-skills-729-components.tsx::when only the dark-theme logo still draws, it shows in dark theme and the light theme gets the monogram`
- Environment: Real PluginIcon in a DOM suite (linkedom); the error event is dispatched on the image.
- Known gaps: linkedom does not apply the theme CSS; the classes that select one per theme are checked, and screenshots cover the drawn result.
- Evidence: UNVERIFIED

<a id="mus-spec-14-732i"></a>
#### MUS-SPEC-14-732I: A command folder swapped for a link while it is read is refused

- Precondition: `~/.claude/commands/team/review.md` and `~/.claude/commands/plain.md` exist, and an outside folder holds a `review.md` with a secret.
- Action: List and attach the untouched command. Then swap `team` for a link to the outside folder, with every containment check before and after still seeing the real folder, and list and attach again.
- Expected result: Untouched, `team:review` is listed and attaches with its own text. During the swap the secret never reaches the picker or a run, and `plain` still reads. macOS opens the file with O_NOFOLLOW_ANY; Linux refuses the read unless the kernel's path for the opened file is the checked one.
- Test: `packages/agent-app/tests/confined-read-729.test.ts::a command folder swapped for a link to an outside folder while it is read is refused, even if every check sees the folder restored`
- Environment: Real discovery and attachment against a temporary home; `realpath` and `lstat` wrapped so the checks see the folder restored while the open sees the link. Runs on macOS and, in CI, on Linux; skipped on Windows.
- Known gaps: Windows is not covered (see 732A).
- Evidence: UNVERIFIED

<a id="mus-spec-14-732j"></a>
#### MUS-SPEC-14-732J: A quoted command argument stays whole

- Precondition: `~/.claude/commands/fe/comp.md` reads `Build the $0 component with $1 styling.`
- Action: On a Codex route send `/fe:comp "Button primary" 'tailwind v4'`, then `/fe:comp "Button  primary" tailwind` (two spaces), then `/fe:comp "say /fe:comp now" tailwind`. On a Claude route send `/fe:comp "say /fe:comp now"  tailwind`.
- Expected result: The first run gets `Build the Button primary component with tailwind v4 styling.`: `$0` is `Button primary` and `$1` is `tailwind v4`, without quotes, as Claude Code splits them (0-based). The second keeps both spaces in `Button  primary`. The third gets `say /fe:comp now`: only the leading invocation is removed. Claude Code receives the fourth message exactly as typed.
- Test: `packages/agent-app/tests/claude-skills-729.test.ts::an inlined command keeps a quoted argument whole, splitting its arguments the way Claude Code does`
- Environment: Real agent service on a Codex route (inlined) and a Claude route (native); the prompt each fake coding client receives is checked.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-14-732k"></a>
#### MUS-SPEC-14-732K: The real image scaler shrinks a large logo

- Precondition: An installed plugin whose logo is a 512px PNG of about 1 MB (over the 256 KB budget), and another whose logo is a PNG that cannot be decoded.
- Action: List the installed plugins with the app's own downscaler, as the Electron main process wires it.
- Expected result: The first plugin carries its logo as a 128×128 PNG within 256 KB; the undecodable one keeps the monogram.
- Test: `packages/agent-app/tests/large-logo-729.electron.ts::a plugin logo over the icon budget is scaled by the app's real image scaler and shown; one it cannot decode keeps the monogram`
- Environment: Runs inside Electron (`npm run test:electron`) with the real nativeImage and the real agent service against a temporary ~/.codex plugin cache.
- Known gaps: The 4096px limit has no fixture (see 729Q).
- Evidence: UNVERIFIED

<a id="mus-spec-14-756a"></a>
#### MUS-SPEC-14-756A: A router chat that uses a connector keeps its sub-agents

- Precondition: A Codex route on a router model with no tool search; the Codex home's connector cache lists Figma, GitHub and Google Drive.
- Action: Send "Check the latest frames in my Figma file and spawn two sub-agents to review them", then "Now open a draft in Google Drive with the summary", then "Thanks, carry on". Separately, send a request that names no connector, and a Figma request on a model with tool search.
- Expected result: Every launch turns sub-agents on. The first loads only Figma (`apps._default.enabled=false` plus Figma's id); the second adds Google Drive; the follow-up keeps both; GitHub never loads. A chat that names no connector loads none, and a model with tool search gets the catalog deferred with nothing scoped.
- Test: `packages/agent-app/tests/router-subagents-756.test.ts::a router chat that asks for Figma loads only the Figma connector and keeps sub-agents on, turn after turn`
- Environment: Node test runner; the real service and provider adapter with a fake Codex core; no network.
- Known gaps: A connector request Muster cannot match to a cached connector (an unknown name, or "Codex apps" in general) still loads the whole catalog, as before.
- Evidence: local; ~/.muster-work/review/756/green.log; exit 0; 1 passed, 0 failed, 0 skipped; commit 1a3ac4fdddd9e638abb3e1d9ffe7d9c04d26f70d
