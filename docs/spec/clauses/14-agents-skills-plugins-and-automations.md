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
| [MUS-SPEC-14-398A](14-agents-skills-plugins-and-automations.md#mus-spec-14-398a) | Marketplace cards show their source name without a repeated runtime prefix; the full provenance stays in a tooltip. | [`marketplace cards show the source name and keep full provenance in a tooltip`](../../../packages/agent-app/tests/ui-sweep-dom.tsx) |
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
| [MUS-SPEC-14-772B](14-agents-skills-plugins-and-automations.md#mus-spec-14-772b) | The person's own skills and plugins stay linked; another app's docx skill and documents/pdf plugins are left out; Muster's four skills are installed; the person's home is untouched. | [`Muster's home links the person's own skills and plugins but not another app's office ones, and installs Muster's`](../../../packages/agent-app/tests/office-skills-772.test.ts) |
| [MUS-SPEC-14-772C](14-agents-skills-plugins-and-automations.md#mus-spec-14-772c) | Only agent chats get muster_office and a note naming Muster's four skill files; the Messages route drops both and router chats keep their route. | [`agent chats get the muster_office server and a note naming Muster's skills; router chats are not forced off their route`](../../../packages/agent-app/tests/office-skills-772.test.ts) |
| [MUS-SPEC-14-772D](14-agents-skills-plugins-and-automations.md#mus-spec-14-772d) | With office_setup's command, ES module imports and require() of the office libraries work from any folder; a project's own copy still wins. | [`the office libraries resolve from an agent script's own working folder, by import and by require`](../../../packages/agent-app/tests/office-skills-772.test.ts) |
| [MUS-SPEC-14-776A](14-agents-skills-plugins-and-automations.md#mus-spec-14-776a) | Every plugin Muster ships lists Muster's version next to installed ones | [`with another app's plugin cache and Muster's built-ins, every plugin lists Muster's version next to the installed one`](../../../packages/agent-app/tests/plugin-choice-776.test.ts) |
| [MUS-SPEC-14-776B](14-agents-skills-plugins-and-automations.md#mus-spec-14-776b) | Choosing a version links only that one into the chat's home | [`choosing the installed version links only that one into the chat's home, and choosing Muster's links only Muster's`](../../../packages/agent-app/tests/plugin-choice-776.test.ts) |
| [MUS-SPEC-14-776C](14-agents-skills-plugins-and-automations.md#mus-spec-14-776c) | Removing the installed app falls back to Muster's version | [`when the chosen installed app is removed the next turn falls back to Muster's version and says so once`](../../../packages/agent-app/tests/plugin-choice-776.test.ts) |
| [MUS-SPEC-14-776D](14-agents-skills-plugins-and-automations.md#mus-spec-14-776d) | Old whole-folder links get the defaults; the person's own skills are never removed | [`old whole-folder links get the defaults and a person's own unrelated skill is never removed`](../../../packages/agent-app/tests/plugin-choice-776.test.ts) |
| [MUS-SPEC-14-776E](14-agents-skills-plugins-and-automations.md#mus-spec-14-776e) | Computer use follows the choice too | [`choosing installed or off for computer use leaves Muster's computer-use server out of the turn`](../../../packages/agent-app/tests/plugin-choice-776.test.ts) |
| [MUS-SPEC-14-776F](14-agents-skills-plugins-and-automations.md#mus-spec-14-776f) | Each plugin row in Skills & plugins has a version picker | [`#776 each plugin row picks Muster's version, an installed one or off`](../../../packages/agent-app/tests/plugin-choice-776-components.tsx) |
| [MUS-SPEC-14-845A](14-agents-skills-plugins-and-automations.md#mus-spec-14-845a) | Nothing runs before the set time; one run at 3:00 PM New York (19:00 UTC); days later still one run, kept and marked done with no next run, its chat linked; renaming it does not run it again. | [`a once automation runs at its local date and time, then shows as done with its run linked`](../../../packages/agent-app/tests/automations-once-845.test.ts) |
| [MUS-SPEC-14-845B](14-agents-skills-plugins-and-automations.md#mus-spec-14-845b) | Create and move-to-past are refused with a message to choose a future time; impossible or malformed dates are refused; the preview shows no run and says the time has passed. | [`a once time that has already passed is refused at save, and the preview says so`](../../../packages/agent-app/tests/automations-once-845.test.ts) |
| [MUS-SPEC-14-845C](14-agents-skills-plugins-and-automations.md#mus-spec-14-845c) | After a restart past the time, catch-up on runs once with trigger catch-up and a "Ran late. It was due …" reason; catch-up off records one missed entry and sends nothing; both read done. | [`closed at the set time: it runs once at the next start and says it ran late, or records one missed entry when catch-up is off`](../../../packages/agent-app/tests/automations-once-845.test.ts) |
| [MUS-SPEC-14-845D](14-agents-skills-plugins-and-automations.md#mus-spec-14-845d) | Editing the target from chat A to chat B keeps the set time; at that time the run goes to chat B only and chat A gets nothing. | [`a scheduled once automation moved to another chat before its time runs in the new chat only, at the same time`](../../../packages/agent-app/tests/automations-once-845.test.ts) |
| [MUS-SPEC-14-845E](14-agents-skills-plugins-and-automations.md#mus-spec-14-845e) | Kolkata, New York summer and winter, a DST-skipped 02:30 (runs 03:30) and a repeated 01:30 (runs the first) all resolve; nothing after the time; summaries name the zone; malformed and impossible dates are refused. | [`once times are wall-clock times in their zone, DST included, and malformed ones are refused`](../../../packages/agent-app/tests/automations-once-845.test.ts) |
| [MUS-SPEC-14-845F](14-agents-skills-plugins-and-automations.md#mus-spec-14-845f) | Repeat lists "Once at a date and time"; picking it shows a date and time control (9:00 tomorrow) and the time zone; the preview says "Runs at"; a refused past time shows in the editor; the save sends the once schedule; a run once automation reads Done with its chat linked. | [`#845 the editor schedules a once run with a date and time in a named zone, and a run once automation reads Done with its chat linked`](../../../packages/agent-app/tests/automations-once-845-dom.tsx) |
| [MUS-SPEC-14-44A](14-agents-skills-plugins-and-automations.md#mus-spec-14-44a) | The tool answers with the child's status ("finished" on Beta One) and its final reply; the child chat is on beta/beta-1, titled as asked, in the parent's folder with Workspace access, and got the prompt; it reads "Started by Planner"; the parent shows "Started Summarise README on Beta One" then "Summarise README finished"; the parent has no extra turn. | [`delegate_task with wait starts a child chat on another provider in the parent's folder and returns its final reply`](../../../packages/agent-app/tests/delegation-44.test.ts) |
| [MUS-SPEC-14-44B](14-agents-skills-plugins-and-automations.md#mus-spec-14-44b) | With the parent idle, the first child's finish starts one parent turn whose prompt says a delegated chat finished, with its reply and id; with the parent busy, the second report waits in the parent's queue and starts one turn after the parent's turn; each result wakes the parent once; both "finished" rows show. | [`an idle parent wakes with the child's result when an async child finishes; a busy parent gets it after its turn`](../../../packages/agent-app/tests/delegation-44.test.ts) |
| [MUS-SPEC-14-44C](14-agents-skills-plugins-and-automations.md#mus-spec-14-44c) | On a working child message_task answers "Steered Tests" and the provider got exactly that text as a steer; on the finished child it answers "Sent to Tests" and the child runs a second turn with the text; read_task with last 2 returns both replies in order. | [`message_task steers a working child, and gives an idle child a new turn`](../../../packages/agent-app/tests/delegation-44.test.ts) |
| [MUS-SPEC-14-44D](14-agents-skills-plugins-and-automations.md#mus-spec-14-44d) | interrupt_task answers "Stopped 2 chats (Refactor and the chats it started)"; the provider was told to stop the child and the grandchild; both read interrupted; the parent gets no new turn; the parent shows "Refactor was stopped"; list_tasks lists both as stopped, the grandchild indented. | [`interrupt_task stops a child and the chat it started, and a stop does not wake the parent`](../../../packages/agent-app/tests/delegation-44.test.ts) |
| [MUS-SPEC-14-44E](14-agents-skills-plugins-and-automations.md#mus-spec-14-44e) | While the child works read_task says running with no reply; after it finished, read_task returns finished, "Seeded SEEDS.md." and "Changed files: SEEDS.md"; the report queued while the parent worked is withdrawn, so the parent has one turn and an empty queue. | [`read_task returns status, the final reply and changed files, and reading a result first withdraws its queued report`](../../../packages/agent-app/tests/delegation-44.test.ts) |
| [MUS-SPEC-14-44F](14-agents-skills-plugins-and-automations.md#mus-spec-14-44f) | A read-only chat's turn carries no muster_delegation server or token and a call without its token gets 403; a Full access parent's child is Full access; a chain stops at 3 deep with "at most 3 chats deep"; every child in the chain has Workspace like its root; the fifth concurrent child is refused ("at most 4 at once"); an unknown model, an unknown provider and a folder outside the chat's are refused with what is set up; refused calls create no chat. | [`children get the parent's access and never more; read-only chats get no tools; depth, concurrency and unconfigured models are refused`](../../../packages/agent-app/tests/delegation-44.test.ts) |
| [MUS-SPEC-14-44H](14-agents-skills-plugins-and-automations.md#mus-spec-14-44h) | A sibling chat's read_task, message_task, wait_task and interrupt_task on the child are refused with "is not a chat you started"; the child cannot interrupt its parent; nothing was steered or stopped; the sibling lists no tasks; the root may read its grandchild. | [`only a parent or its ancestors may control a child; a sibling or the child itself is refused`](../../../packages/agent-app/tests/delegation-44.test.ts) |
| [MUS-SPEC-14-44I](14-agents-skills-plugins-and-automations.md#mus-spec-14-44i) | After a restart delegation.children still returns the child; the parent's list_tasks shows it finished and read_task returns "42 files."; another chat is still refused; the child still reads "Started by Lead". | [`links survive a restart: the parent still lists, reads and controls its child, and others still cannot`](../../../packages/agent-app/tests/delegation-44.test.ts) |
| [MUS-SPEC-14-44J](14-agents-skills-plugins-and-automations.md#mus-spec-14-44j) | delegation.children lists both working children with title, status, model and depth; delegation.stopChildren answers {stopped: 2}; both read interrupted. | [`stopping a parent's children stops every working chat below it`](../../../packages/agent-app/tests/delegation-44.test.ts) |
| [MUS-SPEC-14-44K](14-agents-skills-plugins-and-automations.md#mus-spec-14-44k) | The parent's transcript shows "Started Audit API on Beta One", "Started Audit UI on Beta One" and "Audit UI finished", each opening its chat; the child shows "Started by Lead", opening the parent; the sub-agents pane lists both chats as Working and Done with a count of 2 and opens them; the parent's approval copy reads "From Audit API, a chat this one started" and Approve answers the copy. | [`#44 started chats show as compact linked rows in both transcripts, in the sub-agents pane and on the parent's approval copy`](../../../packages/agent-app/tests/delegation-44-dom.tsx) |
| [MUS-SPEC-14-44L](14-agents-skills-plugins-and-automations.md#mus-spec-14-44l) | Stop on Lead (Audit API still working) opens the app's dialog naming "Audit API" with Cancel, Stop this chat only and Stop all; Stop all stops Lead then its children; Stop this chat only stops Lead; Cancel and Esc stop nothing; window.confirm is never used. | [`#44 Stop on a chat with working children offers Stop all, Stop this chat only and Cancel; Cancel and Esc stop nothing`](../../../packages/agent-app/tests/delegation-44-dom.tsx) |
| [MUS-SPEC-14-44M](14-agents-skills-plugins-and-automations.md#mus-spec-14-44m) | The report's row is a delegation-row notice "Audit UI finished · The UI is clean. · Open" whose Open opens the child; no user bubble starts with "Muster: a chat you delegated"; the user's own message stays a bubble. | [`#44 a wake-up report shows as a compact notice row with the child's first line and Open, never as a user bubble`](../../../packages/agent-app/tests/delegation-44-dom.tsx) |
| [MUS-SPEC-14-44N](14-agents-skills-plugins-and-automations.md#mus-spec-14-44n) | The provider still gets the report as the wake turn's message; the transcript row carries kind delegation-report with the child id, title, state finished and the first line of the reply; the user's own message is not marked. | [`the wake-up report is marked as a delegation report in the parent's transcript, not as the user's message`](../../../packages/agent-app/tests/delegation-44.test.ts) |

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

<a id="mus-spec-14-398a"></a>
#### MUS-SPEC-14-398A: Marketplace cards show a concise source with full provenance available

- Precondition: A marketplace source is labelled Codex: local-marketplace and offers an uninstalled Notes plugin.
- Action: Open Skills & plugins and select Discover.
- Expected result: The Notes card shows local-marketplace with the full source label in its tooltip, and offers Install.
- Test: `packages/agent-app/tests/ui-sweep-dom.tsx::marketplace cards show the source name and keep full provenance in a tooltip`
- Environment: Node and linkedom with the real PluginsScreen and fixture bridge; no network.
- Known gaps: Real marketplace sources are not synced; layout is checked in the browser fixture.
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

### Muster office skills (#772-#775)

<a id="mus-spec-14-772b"></a>
#### MUS-SPEC-14-772B: Muster's home keeps the person's skills and plugins but not another app's office ones

- Precondition: A person's home with skills (their own, a pdf and a docx skill, .system) and a plugin cache where one marketplace has documents, pdf and another plugin. Muster's home still has the old whole-folder links for skills and plugins.
- Action: Prepare Muster's home; remove one of the person's skills and add another; prepare again; prepare a home whose source has no skills folder.
- Expected result: skills and plugins become real folders. The person's own skill, .system, plugins/data, a marketplace with no office plugin and the other plugin are links. The docx skill and the documents and pdf plugins are not linked in. documents, spreadsheets, presentations and pdf are Muster's own copies. The person's home is unchanged. A removed skill disappears and a new one appears. A source with no skills folder still gets Muster's four skills.
- Test: `packages/agent-app/tests/office-skills-772.test.ts::Muster's home links the person's own skills and plugins but not another app's office ones, and installs Muster's`
- Environment: Node test runner; temp folders.
- Known gaps: When a chat runs in the person's own home (shared-home mode or a Keychain sign-in), their office skills stay visible; the note still points at Muster's and says they win. The plugins' enabled entries in the shared config are left as they are; the coding client finds no plugin to load. Not run against a real coding client here.
- Evidence: UNVERIFIED

<a id="mus-spec-14-772c"></a>
#### MUS-SPEC-14-772C: Agent chats get the office tools and a note that names Muster's skills

- Precondition: The office domain with a stub context.
- Action: Ask for run options for a plan chat and an agent chat; strip the note for the Messages route; check whether a Full access router chat with the office server may stay on its route.
- Expected result: A plan chat gets nothing. An agent chat gets mcp_servers.muster_office with its chat id and a timeout of at least 10 minutes, and a note naming the four skill files in the shipped skills folder that says they take precedence. Each skill has a name, a description, mentions office_setup and office_render, and names no other product or Python. The Messages route drops the note and the server, and the chat may stay on its route.
- Test: `packages/agent-app/tests/office-skills-772.test.ts::agent chats get the muster_office server and a note naming Muster's skills; router chats are not forced off their route`
- Environment: Node test runner.
- Known gaps: OpenCode and Grok get the server through the same overrides but are not checked here.
- Evidence: UNVERIFIED

<a id="mus-spec-14-772d"></a>
#### MUS-SPEC-14-772D: The office libraries resolve from an agent script's own working folder

- Precondition: Office libraries linked from the checkout into a temp Muster data folder; a script folder with a space in its path and no node_modules.
- Action: Run an ES module that imports all six libraries and a CommonJS script that requires five of them with the command office_setup returns; add a project copy of jszip and import it; remove the libraries.
- Expected result: Both scripts load every library. The project's own jszip wins over Muster's. Remove deletes Muster's links and leaves the checkout's packages alone.
- Test: `packages/agent-app/tests/office-skills-772.test.ts::the office libraries resolve from an agent script's own working folder, by import and by require`
- Environment: Node test runner; node stands in for Muster's Electron-as-Node.
- Known gaps: Not run inside the coding client's sandbox on a packaged build.
- Evidence: UNVERIFIED

### Choosing Muster's or an installed version (#776)

For each plugin Muster ships (documents, spreadsheets, presentations, PDF, visualize, computer use) the person picks Muster's version, an installed one or none. Only the chosen one is loaded into a chat's home.

<a id="mus-spec-14-776a"></a>
#### MUS-SPEC-14-776A: Every plugin Muster ships lists Muster's version next to installed ones

- Precondition: Another app's plugin cache with documents, pdf and visualize plugins (two marketplaces), the person's own docx and pdf skills, and Muster's shipped skills.
- Action: List the plugin choices through the extensions domain.
- Expected result: Documents, spreadsheets, presentations, PDF, visualize and computer use are listed. Each has Muster's version (name, source, version, path) and every installed version found, each with name, source, version and path. No choice was made, so each with a Muster version is set to Muster's. Nothing found is run: the folders are only read.
- Test: `packages/agent-app/tests/plugin-choice-776.test.ts::with another app's plugin cache and Muster's built-ins, every plugin lists Muster's version next to the installed one`
- Environment: Node test runner; temp folders; the real extensions domain in an agent service.
- Known gaps: Only the coding client's home is searched (skills and plugins/cache); skills under ~/.agents/skills are not offered as an installed version.
- Evidence: UNVERIFIED

<a id="mus-spec-14-776b"></a>
#### MUS-SPEC-14-776B: Choosing a version links only that one into the chat's home

- Precondition: The same person's home and Muster's home prepared for a chat.
- Action: Choose the installed documents plugin, then the installed pdf skill, prepare the home the way a turn does; then choose Muster's for both and prepare again; then choose off for spreadsheets.
- Expected result: With installed chosen, the installed documents plugin is linked and Muster's documents skill is gone from the home; the other app's docx skill stays out; the pdf skill link points at the person's pdf skill. With Muster's chosen, Muster's copies are back and neither installed one is linked. Off leaves both out. The turn's key changes with each choice, so a warm session restarts on the next turn.
- Test: `packages/agent-app/tests/plugin-choice-776.test.ts::choosing the installed version links only that one into the chat's home, and choosing Muster's links only Muster's`
- Environment: Node test runner; temp folders.
- Known gaps: A chat already running a turn keeps what it loaded until its next turn. Choices are per person, not per chat or folder. Muster's render_html and office tools stay on whatever is chosen; only the skills and plugins in the home follow the choice.
- Evidence: UNVERIFIED

<a id="mus-spec-14-776c"></a>
#### MUS-SPEC-14-776C: Removing the installed app falls back to Muster's version

- Precondition: The installed visualize plugin is chosen and linked.
- Action: Delete the other app's plugin cache folder, then prepare the home and ask for the turn's run options twice.
- Expected result: Preparing does not throw; the broken link is gone, nothing of the other app is linked, and the plugin row reports Muster's version in use with the installed one missing. The first turn's notes say once that Muster's version is used; the second turn's do not.
- Test: `packages/agent-app/tests/plugin-choice-776.test.ts::when the chosen installed app is removed the next turn falls back to Muster's version and says so once`
- Environment: Node test runner; temp folders.
- Known gaps: The note goes to the agent as turn context; the app itself shows no banner, only the row's badge in Skills & plugins.
- Evidence: UNVERIFIED

<a id="mus-spec-14-776d"></a>
#### MUS-SPEC-14-776D: Old whole-folder links get the defaults; the person's own skills are never removed

- Precondition: Muster's home from before #772 with skills and plugins as single links into the person's home, which has their own skill and another app's office plugins.
- Action: Prepare the home with no saved choices; change every choice to off and back; prepare after each.
- Expected result: The old links are replaced by real folders with Muster's versions in place and the other app's office plugins left out. The person's own skill stays linked through every change, and the person's home keeps every file it had.
- Test: `packages/agent-app/tests/plugin-choice-776.test.ts::old whole-folder links get the defaults and a person's own unrelated skill is never removed`
- Environment: Node test runner; temp folders.
- Known gaps: Not run against a real coding client.
- Evidence: UNVERIFIED

<a id="mus-spec-14-776e"></a>
#### MUS-SPEC-14-776E: Computer use follows the choice too

- Precondition: Muster's computer-use launcher is present.
- Action: Ask the computer domain's run options for an agent chat with Muster's chosen, then installed, then off.
- Expected result: With Muster's, the turn gets muster_computer. With installed or off it does not, and the installed plugin is linked only for installed.
- Test: `packages/agent-app/tests/plugin-choice-776.test.ts::choosing installed or off for computer use leaves Muster's computer-use server out of the turn`
- Environment: Node test runner; temp folders.
- Known gaps: The Claude Code route keeps its own tools and does not read this choice.
- Evidence: UNVERIFIED

<a id="mus-spec-14-776f"></a>
#### MUS-SPEC-14-776F: Each plugin row in Skills & plugins has a version picker

- Precondition: The Installed tab with Muster's documents and visualize plus installed versions of both, one installed version missing.
- Action: Open the Installed tab, read the plugin rows, pick the installed documents version, then off.
- Expected result: A Muster's plugins group shows one row per plugin with the usual row look: name, which version is in use and a picker with Muster's, each installed version and Off. Muster's is selected by default. Picking sends the choice and the row updates. The missing one shows a badge that Muster's is in use.
- Test: `packages/agent-app/tests/plugin-choice-776-components.tsx::#776 each plugin row picks Muster's version, an installed one or off`
- Environment: Renderer DOM suite (linkedom); stubbed bridge.
- Known gaps: Not a screenshot of the real app.
- Evidence: UNVERIFIED

### Run once at a set time (#845)

An automation can run once at a date and time instead of repeating. The time is a wall-clock time in the automation's time zone, shown with the zone. Once it has run (or been missed) it stays in the list as done, with its run linked.

<a id="mus-spec-14-845a"></a>
#### MUS-SPEC-14-845A: A once automation runs at its local date and time, then shows as done

- Precondition: An automation set to "Once at" 3:00 PM on 18 Sep 2026 in America/New_York, created at 10:00 UTC that day, opening a new chat.
- Action: Move the clock to one minute before, then just after, the set time; then three days on; then rename it.
- Expected result: Nothing runs before 19:00 UTC. One scheduled run starts at the set time in a new chat and completes. Days later it has still run exactly once. The automation is kept, reads as done with no next run, and its last run links the chat. Its summary reads "Once on Fri, Sep 18, 2026 at 3:00 PM (America/New_York)". Renaming it is allowed and does not run it again.
- Test: `packages/agent-app/tests/automations-once-845.test.ts::a once automation runs at its local date and time, then shows as done with its run linked`
- Environment: Node test runner; the real service with its scheduler clock (automationTiming.now) moved by the test; a fake provider.
- Known gaps: Runs only while Muster is open, like every automation.
- Evidence: local; ~/.muster-work/review/845/green-workflow.log; exit 0; 5 passed, 0 failed, 0 skipped; commit f9ec3210c81cb85a725b81e73ce5d8b4ce170f89

<a id="mus-spec-14-845b"></a>
#### MUS-SPEC-14-845B: A once time that has already passed is refused at save

- Precondition: Clock at 10:00 UTC on 18 Sep 2026; the automation time zone is America/New_York.
- Action: Save a once automation for 05:59 local (one minute ago), for 30 Feb, and for free text; preview a past and a future time; move a pending one into the past.
- Expected result: Saving a past time is refused: "That time has already passed. Choose a time in the future." An impossible or malformed date is refused with a request for a date and time. The preview lists no next run and warns that the time has passed; a future time previews its one run and no warning. Moving a pending one into the past is refused and it keeps its time.
- Test: `packages/agent-app/tests/automations-once-845.test.ts::a once time that has already passed is refused at save, and the preview says so`
- Environment: Node test runner; the real service; the scheduler clock moved by the test.
- Known gaps: A time a few seconds ahead can still pass before the first tick; it then runs on that tick as a normal on-time run.
- Evidence: local; ~/.muster-work/review/845/green-workflow.log; exit 0; 5 passed, 0 failed, 0 skipped; commit f9ec3210c81cb85a725b81e73ce5d8b4ce170f89

<a id="mus-spec-14-845c"></a>
#### MUS-SPEC-14-845C: Closed at the set time: it runs once at the next start and says it ran late

- Precondition: Two once automations for 3:00 PM New York on 18 Sep 2026, one with "After sleep: Run once to catch up" (the default) and one with "Skip missed runs". Muster closes before the time.
- Action: Start Muster again at 22:30 UTC, three and a half hours late, and let it run until the next morning.
- Expected result: The catch-up one runs once, as a catch-up run for 19:00 UTC, with the reason "Ran late. It was due Fri, Sep 18, 2026 at 3:00 PM (America/New_York) …". The other gets one missed entry saying it did not run, and sends no prompt. Neither runs again; both read as done. This is the same missed-run rule every other schedule follows.
- Test: `packages/agent-app/tests/automations-once-845.test.ts::closed at the set time: it runs once at the next start and says it ran late, or records one missed entry when catch-up is off`
- Environment: Node test runner; two real service instances on one data folder; the scheduler clock moved by the test; a fake provider.
- Known gaps: A run is "late" after the scheduler grace (150 seconds); a run within the grace counts as on time.
- Evidence: local; ~/.muster-work/review/845/green-workflow.log; exit 0; 5 passed, 0 failed, 0 skipped; commit f9ec3210c81cb85a725b81e73ce5d8b4ce170f89

<a id="mus-spec-14-845d"></a>
#### MUS-SPEC-14-845D: A scheduled once automation can be moved to another chat before it runs

- Precondition: A once automation for 3:00 PM New York that continues chat A, and another chat B.
- Action: Before the time, edit the automation to continue chat B instead; then let the time pass.
- Expected result: The edit keeps the next run at 19:00 UTC. At that time one run starts in chat B, which gets the run notice and the prompt; chat A gets nothing.
- Test: `packages/agent-app/tests/automations-once-845.test.ts::a scheduled once automation moved to another chat before its time runs in the new chat only, at the same time`
- Environment: Node test runner; the real service; the scheduler clock moved by the test; a fake provider.
- Known gaps: Moving uses the existing Edit form; there is no drag between chats. The same applies to every automation, not only once.
- Evidence: local; ~/.muster-work/review/845/green-workflow.log; exit 0; 5 passed, 0 failed, 0 skipped; commit f9ec3210c81cb85a725b81e73ce5d8b4ce170f89

<a id="mus-spec-14-845e"></a>
#### MUS-SPEC-14-845E: Once times are wall-clock times in their time zone

- Precondition: Once schedules in Asia/Kolkata, America/New_York and UTC, including the 2026 DST changes.
- Action: Ask the schedule math for the run time and the summary, and validate malformed values.
- Expected result: 09:00 in Kolkata is 03:30 UTC; 09:00 New York is 14:00 UTC in December; 02:30 on 8 Mar 2026 in New York (skipped by DST) runs at 03:30 EDT, and 01:30 on 1 Nov 2026 (repeated) runs at the first one, as daily schedules do. There is nothing after the time. The summary is "Once on Mon, Sep 21, 2026 at 9:05 AM (Asia/Kolkata)". A date without a time, 24:00, month 13, 29 Feb in a non-leap year, empty and padded values are refused.
- Test: `packages/agent-app/tests/automations-once-845.test.ts::once times are wall-clock times in their zone, DST included, and malformed ones are refused`
- Environment: Node test runner; pure schedule functions.
- Known gaps: None.
- Evidence: local; ~/.muster-work/review/845/green-workflow.log; exit 0; 5 passed, 0 failed, 0 skipped; commit f9ec3210c81cb85a725b81e73ce5d8b4ce170f89

<a id="mus-spec-14-845f"></a>
#### MUS-SPEC-14-845F: The editor offers Once in its Repeat picker, and a run once automation reads Done

- Precondition: The Automations list with one once automation that already ran in "Release notes chat".
- Action: Read its row and open it; then start a new automation, pick Once, set 1 Dec 2026 9:00, save while the runtime refuses, then save again.
- Expected result: The row is kept, reads Done, and its summary names the time and zone; opened, its history links "Release notes chat". The existing Repeat picker offers "Once at a date and time"; picking it shows an "On" date and time field defaulting to 9:00 tomorrow and the Time zone field with this computer's zone. The preview asks for the once schedule and reads "Runs at". No repeating preset reads as picked. A refused save shows the message in the editor; the next save sends {kind: once, at: 2026-12-01T09:00} with the zone.
- Test: `packages/agent-app/tests/automations-once-845-dom.tsx::#845 the editor schedules a once run with a date and time in a named zone, and a run once automation reads Done with its chat linked`
- Environment: Renderer DOM suite (linkedom); stubbed bridge.
- Known gaps: Not a screenshot of the real app; the native date and time picker is not opened.
- Evidence: local; ~/.muster-work/review/845/green-dom.log; exit 0; 1 passed, 0 failed, 0 skipped; commit f9ec3210c81cb85a725b81e73ce5d8b4ce170f89

### Agents start and control agents (#44)

An agent can hand a task to a child chat on any provider and model the user has set up, follow it, steer it and stop it, through the `muster_delegation` tools (delegate_task, message_task, wait_task, read_task, interrupt_task, list_tasks). A child is a real Muster chat linked to the chat that started it.

<a id="mus-spec-14-44a"></a>
#### MUS-SPEC-14-44A: Delegate_task with wait starts a child chat on another provider and returns its final reply

- Precondition: An agent chat "Planner" on provider Alpha with Workspace access in a folder; a second configured provider Beta with model beta-1.
- Action: The parent's turn calls delegate_task with a prompt, provider "Beta", model beta-1, title "Summarise README" and wait true; the child's turn replies "README says hello."
- Expected result: The call blocks until the child finishes and returns its status and final reply. The child is a real chat: on Beta One, titled "Summarise README", in the parent's folder, with the parent's access, and its first message is the prompt. The child shows "Started by Planner". The parent's transcript has "Started Summarise README on Beta One" and then "Summarise README finished", each linking the child. A parent that waited for the result is not woken again with it.
- Test: `packages/agent-app/tests/delegation-44.test.ts::delegate_task with wait starts a child chat on another provider in the parent's folder and returns its final reply`
- Environment: Node test runner; the real service; a fake provider with two routes whose turns call the real muster_delegation loopback host with the run's chat token.
- Known gaps: A real provider's own MCP timeout is not exercised; the bound is 10 minutes and the provider is told 11.
- Evidence: local; ~/.muster-work/review/44/green-workflow.log; exit 0; 10 passed, 0 failed, 0 skipped; commit 7662754086388ccd540e6a1b29e66c71a5504fac

<a id="mus-spec-14-44b"></a>
#### MUS-SPEC-14-44B: An idle parent wakes with the child's result; a busy parent gets it after its turn

- Precondition: A parent that started two children without waiting; both children block until released.
- Action: Release the first child while the parent is idle; then send the parent a message that keeps it busy and release the second child; then let the parent finish.
- Expected result: The idle parent starts a turn at once with the first child's report (marked as a report, not the user's words, with the child's reply and id). While the parent works, the second report waits in its queue and does not interrupt it; when the parent's turn ends, the report starts one more turn. No result wakes the parent twice.
- Test: `packages/agent-app/tests/delegation-44.test.ts::an idle parent wakes with the child's result when an async child finishes; a busy parent gets it after its turn`
- Environment: Node test runner; the real service and queue; a fake provider; the real tool host.
- Known gaps: Only a completed or failed child turn reports back; a stopped one does not (MUS-SPEC-14-44D).
- Evidence: local; ~/.muster-work/review/44/green-workflow.log; exit 0; 10 passed, 0 failed, 0 skipped; commit 7662754086388ccd540e6a1b29e66c71a5504fac

<a id="mus-spec-14-44c"></a>
#### MUS-SPEC-14-44C: Message_task steers a working child and gives an idle child a new turn

- Precondition: A parent with one child that is still working.
- Action: Call message_task while the child works; let it finish; call message_task again; then read_task with last 2.
- Expected result: A message to a working child steers its current turn (the same path as the composer's Steer, #839); when the turn cannot take it, it is queued. A message to an idle child starts a new turn in it. read_task returns the last replies, oldest first.
- Test: `packages/agent-app/tests/delegation-44.test.ts::message_task steers a working child, and gives an idle child a new turn`
- Environment: Node test runner; the real service; a fake provider that accepts steers while a turn runs.
- Known gaps: A route that refuses steering mid-turn falls back to the child's queue; that branch is not driven here.
- Evidence: local; ~/.muster-work/review/44/green-workflow.log; exit 0; 10 passed, 0 failed, 0 skipped; commit 7662754086388ccd540e6a1b29e66c71a5504fac

<a id="mus-spec-14-44d"></a>
#### MUS-SPEC-14-44D: Interrupt_task stops a child and the chats it started; a stop does not wake the parent

- Precondition: A parent whose child started a grandchild; both are working.
- Action: The parent calls interrupt_task on the child.
- Expected result: The child and every working chat below it are stopped. A stop is the parent's (or the user's) own act, so it does not start a report turn in the parent; the parent's transcript says the child was stopped.
- Test: `packages/agent-app/tests/delegation-44.test.ts::interrupt_task stops a child and the chat it started, and a stop does not wake the parent`
- Environment: Node test runner; the real service; a fake provider whose stop ends the running turn as cancelled.
- Known gaps: None known.
- Evidence: local; ~/.muster-work/review/44/green-workflow.log; exit 0; 10 passed, 0 failed, 0 skipped; commit 7662754086388ccd540e6a1b29e66c71a5504fac

<a id="mus-spec-14-44e"></a>
#### MUS-SPEC-14-44E: Read_task returns status, the final reply and changed files; reading first withdraws the queued report

- Precondition: A parent that starts a child and keeps working while the child edits SEEDS.md and finishes.
- Action: The parent calls read_task while the child works, and again after it finished, in the same turn.
- Expected result: read_task gives the child's status, its final reply and the files its turns changed (folder-relative). A parent that read a result itself is not woken with it again: the queued report is removed.
- Test: `packages/agent-app/tests/delegation-44.test.ts::read_task returns status, the final reply and changed files, and reading a result first withdraws its queued report`
- Environment: Node test runner; the real service; a fake provider that reports a fileChange item.
- Known gaps: Changed files come from the child's own edit rows; a file a command changed without an edit row is not listed.
- Evidence: local; ~/.muster-work/review/44/green-workflow.log; exit 0; 10 passed, 0 failed, 0 skipped; commit 7662754086388ccd540e6a1b29e66c71a5504fac

<a id="mus-spec-14-44f"></a>
#### MUS-SPEC-14-44F: Children never get more access than the parent; read-only gets no tools; depth, concurrency and models are bounded

- Precondition: Chats with Read only, Full access and Workspace access; providers Alpha and Beta.
- Action: Run a read-only turn; delegate from the Full access chat; delegate down a chain until it is refused; start five children at once; ask for model gpt-unknown, provider gamma and folder /etc.
- Expected result: Delegation is offered only to agent chats with more than read-only access. A child has exactly its parent's effective access, never more. Delegation goes at most 3 chats deep and at most 4 of a chat's children work at once. The model must be one a configured, available provider offers (no new credentials); the folder must be the parent's or one of its project's. A refusal says why and what is allowed, and creates no chat.
- Test: `packages/agent-app/tests/delegation-44.test.ts::children get the parent's access and never more; read-only chats get no tools; depth, concurrency and unconfigured models are refused`
- Environment: Node test runner; the real service; a fake provider; the real tool host and chat-token binding.
- Known gaps: The 403 shows the host refusing a call without the run's token; the per-chat token itself is covered by tests/agent-tool-chat-binding.test.ts.
- Evidence: local; ~/.muster-work/review/44/green-workflow.log; exit 0; 10 passed, 0 failed, 0 skipped; commit 7662754086388ccd540e6a1b29e66c71a5504fac

<a id="mus-spec-14-44h"></a>
#### MUS-SPEC-14-44H: Only a parent or its ancestors may control a child

- Precondition: A parent with a child that started a grandchild, and an unrelated chat in the same folder.
- Action: The unrelated chat calls every control tool on the child; the child calls interrupt_task on its parent; the parent reads the grandchild.
- Expected result: Only the chat that started a child, or a chat above it, may read, message, wait for or stop it. Anyone else is refused and nothing happens to the child.
- Test: `packages/agent-app/tests/delegation-44.test.ts::only a parent or its ancestors may control a child; a sibling or the child itself is refused`
- Environment: Node test runner; the real service; a fake provider; the real tool host.
- Known gaps: None known.
- Evidence: local; ~/.muster-work/review/44/green-workflow.log; exit 0; 10 passed, 0 failed, 0 skipped; commit 7662754086388ccd540e6a1b29e66c71a5504fac

<a id="mus-spec-14-44i"></a>
#### MUS-SPEC-14-44I: Links survive a restart

- Precondition: A parent whose child finished, then Muster restarts on the same data folder.
- Action: After the restart the parent calls list_tasks and read_task, and another chat calls read_task.
- Expected result: The parent-child link is stored, so after a restart the parent still sees, reads and controls its children and others still cannot.
- Test: `packages/agent-app/tests/delegation-44.test.ts::links survive a restart: the parent still lists, reads and controls its child, and others still cannot`
- Environment: Node test runner; two real service instances on one data folder; a fake provider.
- Known gaps: A child that was working when Muster closed follows the usual restart rules (#449); its report is not re-sent after the restart.
- Evidence: local; ~/.muster-work/review/44/green-workflow.log; exit 0; 10 passed, 0 failed, 0 skipped; commit 7662754086388ccd540e6a1b29e66c71a5504fac

<a id="mus-spec-14-44j"></a>
#### MUS-SPEC-14-44J: Stopping a parent's children stops every working chat below it

- Precondition: A parent with two working children.
- Action: Ask for the parent's children, then stop them (what Stop on the parent does when the user chooses to stop its children too).
- Expected result: The parent's children are listed with their state; stopping them stops every working chat below the parent.
- Test: `packages/agent-app/tests/delegation-44.test.ts::stopping a parent's children stops every working chat below it`
- Environment: Node test runner; the real service; a fake provider.
- Known gaps: The Stop dialog itself is covered by MUS-SPEC-14-44K.
- Evidence: local; ~/.muster-work/review/44/green-workflow.log; exit 0; 10 passed, 0 failed, 0 skipped; commit 7662754086388ccd540e6a1b29e66c71a5504fac

<a id="mus-spec-14-44k"></a>
#### MUS-SPEC-14-44K: Started chats are visible and reachable from both sides

- Precondition: Chat "Lead" is working; it started "Audit API" (working) and "Audit UI" (finished) on Beta One; "Audit API" asked to run `rm -rf build`.
- Action: Look at Lead's transcript and click its rows; look at Audit API's transcript and click "Started by"; open Lead's sub-agents pane and click a card; approve the copied card.
- Expected result: Lead's transcript has one compact row per event: "Started Audit API on Beta One", "Started Audit UI on Beta One", "Audit UI finished"; each names the chat and opens it. The child's transcript starts with "Started by Lead", which opens Lead. The existing sub-agents pane lists the started chats next to provider sub-agents (Audit API Working, Audit UI Done; count 2) and a card opens its chat. Lead's copy of the approval says "From Audit API, a chat this one started" and Approve answers it. (Stop is MUS-SPEC-14-44L.)
- Test: `packages/agent-app/tests/delegation-44-dom.tsx::#44 started chats show as compact linked rows in both transcripts, in the sub-agents pane and on the parent's approval copy`
- Environment: Renderer DOM suite (linkedom); stubbed bridge; the real Timeline, SubagentsTab, ApprovalCard and store.
- Known gaps: Not a screenshot of the real app. The summary card's Subagents row also counts started chats; that is not asserted here.
- Evidence: UNVERIFIED

<a id="mus-spec-14-44l"></a>
#### MUS-SPEC-14-44L: Stop on a chat with working children asks with three explicit choices

- Precondition: Chat "Lead" is working and started "Audit API", which is still working.
- Action: Press Stop on Lead and choose Stop all; again and choose Stop this chat only; again and choose Cancel; again and press Esc.
- Expected result: Stop opens the app's own confirmation sheet (not the system confirm), saying "“Lead” started a chat that is still working: “Audit API”." with three buttons: Cancel, Stop this chat only and Stop all (the default). Stop all stops Lead and then every working chat below it. Stop this chat only stops Lead and leaves its children working. Cancel, Esc and a click outside stop nothing. A chat with no working children stops at once, without asking, and a second press while a chat is already stopping never asks.
- Test: `packages/agent-app/tests/delegation-44-dom.tsx::#44 Stop on a chat with working children offers Stop all, Stop this chat only and Cancel; Cancel and Esc stop nothing`
- Environment: Renderer DOM suite (linkedom); stubbed bridge; the real store, ConfirmSheet and host.
- Known gaps: Not a screenshot of the real app. A window with no mounted host (none today) stops only the chat without asking.
- Evidence: UNVERIFIED

<a id="mus-spec-14-44m"></a>
#### MUS-SPEC-14-44M: A wake-up report shows as a notice, not as the user's message

- Precondition: Chat "Lead" started a child that finishes while Lead is idle (or the report arrives after Lead's turn).
- Action: Let the child finish so the report wakes Lead; look at Lead's transcript.
- Expected result: The provider still receives the report as the wake turn's message. In the transcript that row carries `kind: 'delegation-report'` with the child's id, title, state and the first line of its reply, and is shown as a compact notice in the delegation-row style: "<title> finished · <first line of its reply> · Open", where Open opens the child chat. No user bubble starts with "Muster: a chat you delegated". The user's own messages are unchanged.
- Test: `packages/agent-app/tests/delegation-44-dom.tsx::#44 a wake-up report shows as a compact notice row with the child's first line and Open, never as a user bubble`
- Environment: Renderer DOM suite (linkedom); stubbed bridge; the real Timeline. The runtime marking is MUS-SPEC-14-44N.
- Known gaps: While it waits in the composer's queue (a busy parent), the report still reads as its text in the queue list.
- Evidence: UNVERIFIED

<a id="mus-spec-14-44n"></a>
#### MUS-SPEC-14-44N: The runtime marks the wake-up report's transcript row as a delegation report

- Precondition: Chat "Lead" started "Link check", which finishes with "All 12 links work." while Lead is idle.
- Action: Let the report wake Lead; read Lead's transcript.
- Expected result: The provider receives the report as the wake turn's message (so routes that need a user-role message still get one). The transcript row of that message carries `kind: 'delegation-report'`, the child's id, its title, state `finished` and the first line of its reply as `summary`. The user's own message carries no such mark.
- Test: `packages/agent-app/tests/delegation-44.test.ts::the wake-up report is marked as a delegation report in the parent's transcript, not as the user's message`
- Environment: Node test runner; the real service and queue; a fake provider; the real tool host.
- Known gaps: How the row looks is MUS-SPEC-14-44M.
- Evidence: UNVERIFIED
