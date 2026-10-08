# Changelog

All notable changes to Muster Agent. Each `## <version>` section becomes the notes of the
`agent-v<version>` GitHub Release (`.github/workflows/agent-app-release.yml`).

## Unreleased

- Smoother typing and streaming (fluidity): the composer, sidebar, summary card and workspace subscribe to just the state they use, so a keystroke re-renders the composer only; runtime snapshots are coalesced and structurally shared; the focus refresh is debounced; startup fetches Paperclip far less often (#302); no synchronous `sysctl` or `git` on the main process; cheaper animations; background throttling when idle and unfocused.

## 0.3.5

- Outputs of a server project open on your Mac (#305). Every document, attachment and work product in a connected project's Outputs tab is a link: Muster downloads it with your own sign-in into a private cache (readable only by you, one folder per server, 50 MB at most) and shows it in its own viewer, with a spinner while it loads and a plain sentence if the server refuses or no longer has it. When the project is linked for Work locally and the same file exists in that folder, the local file opens instead. Each row also has Download… (a save dialog) and Open on server. Pull requests and links open as before, and local projects are unchanged.

## 0.3.4

- Work locally no longer needs a git repository (#303). Any folder can be linked to a project: a git repository still gets its own worktree and branch, and any other folder is used as it is, with "Working in <folder>" on screen. Muster notes the files at check-out, and progress and the hand-back list the files added, changed and removed instead of a git diff. A plain folder hands back when you say you are done in the local chat (and, if it has a test setup and tests ran, they passed after the last change); it never pushes and never opens a pull request.
- A project with no folder yet offers "Use a new folder Muster creates" (~/Muster/<Org>/<Project>, readable only by you), "Choose a folder…" or "Use a git repository…", in the first-use sheet and in the project's Settings row. Tasks with no project can be worked locally too: Settings › Local checkouts has a "<Org> · tasks without a project" row, else Muster makes ~/Muster/<Org>/_tasks/<KEY>.
- Hand-back is no longer stuck for projects without tests (a project with no recognised test setup has no test gate, and the hand-back says "No tests in this project"), for test output Muster cannot read (your own "done" accepts a run that exited 0), or for uncommitted changes (when you say done, Muster commits them as you with "<KEY>: <title>", never on the agent's say-so). Repositories on GitLab, Bitbucket or a self-hosted server are found like GitHub ones, and a repository with no remote, or a push that fails, still hands back with "branch is local on <your Mac>".
- The error toast for a folder that cannot be linked reads "That folder does not exist…" without the `checkout.bind:` command label, and the copy says files and folders instead of code.

## 0.3.3

- Every org on your server, not one. Settings › Integrations › Muster Server lists each org you belong to with a checkbox and what the sidebar shows of it (My work, My team or Nothing). The sidebar has one row per org with your open count, an accordion, your own active tasks (five, newest first, then “See all mine”) and the org's projects with your open-count badge. A My work page groups it all by org and project, with filters and a board. The Inbox lists only what asks you, from every org, each row tagged with its org, and includes @mentions of you. Other people's tasks never show up in your sidebar, and a teammate's task is named instead of labelled “You”.
- Work locally. One button on a server task: Muster assigns it to you if needed, sets it In progress, posts “Checked out · working locally on <your Mac> · via Muster”, copies the org read-only (agents, instructions, skills, the task's context and its review policy), makes a worktree and a branch from the project's dev branch in your own checkout, and opens a local chat with the context loaded. Pick the engine once: the org's own agents on your providers, or your own subscriptions. Everything runs on your Mac and your credentials stay here.
- While you work, Muster reports as you, labelled “via Muster · local”: decisions (a message can be posted as a decision), a context summary, the pull request, test results, and one rolling Local work log document with a section per turn. Cost entries say whether you or the org paid and which engine ran.
- Hand-back is automatic. When your branch has new commits, is pushed to its own upstream (or its pull request is open on the same repository), and a real test run after the last change passes, or when you say you are done, Muster posts the summary, sets In review and gives the task to the reviewer the task's policy names (else whoever opened it), with a toast and Undo for about two minutes. Failing or untested work stays checked out with a note, and nothing the agent writes or a comment says can hand a task back. Per project you can choose Ask me instead.
- Offline works. Every post is kept in a queue on your Mac and sent in order when the server is back; if the task changed meanwhile (reassigned, closed) you choose to send anyway, edit or discard. A quiet session gets one “paused” note and, after a while, a reminder.
- Owners and assignees can be people as well as agents: a picker with Me first, then People, then Agents, type to filter, and a name shown once. @-mentions offer people and agents and write the same chip Paperclip's own composer writes.
- `muster://task/<org>/<task>?host=…` opens a task from the optional Muster plugin for Paperclip, for servers you have already connected.
- Server text (task descriptions, comments, org instructions) reaches the local agent marked as untrusted data, and everything Muster posts as you is built from the agent's own replies with secrets removed and no hidden notes or mention links.
- Connected projects: Costs come from the server instead of saying the project no longer exists; a run opens from its task as well as from the Ledger; project Activity shows the project, with an Organisation switch; the server's workspace path is labelled Server workspace, beside your Local checkout on this Mac; receipts list the tools a server run used and link to it on the server.
- A comment's author is named; only yours says You. An expired sign-in says so and points to Settings, instead of saying the server can't be reached.
- The optional Muster plugin for Paperclip (packages/paperclip-plugin-muster) shows on the server who has a task checked out and on which Mac, the Local work log and receipts, a My work page, and one reminder after a quiet day. It never reassigns anything.

## 0.3.2

- One Muster Server. Paperclip and Muster Server are now a single connection in Settings › Integrations › Muster Server: type the server address and press Connect (a server on this Mac is offered inline; an API token is under Other ways to connect). The app finds out what is at the address by itself, so a Muster Server's org and projects show in the app exactly as a linked Paperclip's always did: projects under their org in the sidebar, tasks as threads, the Roster graph, Inbox, Ledger receipts, approvals, Pause and Resume, and Import from Muster Server. Nothing opens in a browser any more, and the separate Paperclip section is gone. Existing Paperclip links, tokens and imported copies carry over with no sign-in.
- Connect opens the server's own sign-in page in the app, in a window with a session of its own for that server. A hosted server then updates the app instantly (a task created there arrives in about a tenth of a second) instead of every few seconds; if that session ends, updates continue every few seconds and a quiet Reconnect brings the socket back without signing in again. "Use my browser instead" is still there.

## 0.3.1

- Updates keep working when GitHub's download links are slow or down. If a release file times out or GitHub returns a server error, Muster retries and then fetches it through GitHub's API instead; the checksum and signature checks are unchanged. A persistent outage reads "GitHub didn't respond. Muster will try again automatically."


## 0.3.0

**The sidebar is back the way it was.** Inbox, New chat, Search chats, Memory, Automations and Ledger, then Pinned, Folders, Projects and Chats. Each project lists its tasks with their owners, and opening a project shows its Dashboard, Tasks, Roster, Outputs, Ledger, Budget and Settings.

**Projects work end to end.**
- Answer an agent's question right in the task's card; the run continues.
- Pause really stops work: running work stops, nothing new starts, and Resume all only resumes what Pause all paused. One agent can be held on its own.
- Agent replies show in the task thread, receipts are credited to the right Roster agent, and each subtask gets a Delegated card.
- Tasks: Sort and Group no longer crash; a real Backlog column; dropping on Done goes through review.
- A failed task can be opened in its run chat and restarted. Provider errors are shown as the provider sent them.
- The project Dashboard shows its own charts; Outputs lists the files agents changed; budgets can be set in tokens and warn in the Inbox at 80% and 100%.
- Paperclip: blockers come through on link and import, questions can be answered in place, a Paperclip on this Mac at 127.0.0.1 is treated as local, imported tasks aren't listed twice, and the offline banner appears and clears live.
- Worktrees created by Assign & start no longer fill the Folders list.

**Muster Server and CLI (new).** Run Muster for your team on your own server: `muster-server init` then `start`, or Docker Compose. The web UI is the same as the desktop app. Local accounts with single-use invite links, owner/admin/member/viewer roles plus per-project roles, instant revoke, rate-limited sign-in and a tamper-evident audit log. An admin console under Settings › Server shows people, invites, project access, usage and cost per person, sessions and connectors. Connect several Slack workspaces, Telegram bots and Mattermost servers; messages become project chats and replies go back to the channel. In the desktop app, Settings › Integrations › Muster Server (optional, off by default) connects to a team server. Downloads: `muster-server-0.3.0-<platform>.tar.gz`; see docs/server.md.

**Agents and governance.**
- Agents wake for a reason you can see. Each Roster agent has a run policy: a heartbeat timer, wake on assignment, wake on a comment or @mention, wake on a decision, and a least gap between wakes. A timer wake only starts a run when the agent has ready work, so an idle heartbeat costs nothing. Wakes that arrive close together merge into one run, a runaway burst pauses the agent and tells you, and every run shows why it started.
- Runs that go wrong recover instead of stalling. An empty or plan-only turn is continued (up to twice), a temporary failure is retried after a backoff, a usage limit is explained, and a run that ends with no comment is asked once and then gets a note written from its Receipt. Lost runs, stranded tasks and tasks with no next step show up under Settings › Run policy with a way out.
- Hold a whole subtree: pause it, or cancel it (type the task key to confirm) and restore it later. Stop a run three ways: Stop, Stop and mark done (it still goes through review), or Stop and cancel. Hide a task from lists.
- Review and approval policies: a task can need a review or approval by you or by an agent reviewer before it counts as done. Request changes needs a note and wakes the owner with it; the last approval verifies the task. A stopped subtree raises one finding for you (or a watchdog agent) to accept, reopen or reassign, and follow-up checks wake the owner, create a recovery task, or ask you.
- Per-agent governance on the agent's page: an instruction bundle (AGENTS.md, SOUL.md, HEARTBEAT.md, TOOLS.md, more) with revisions and restore, permissions (create and assign tasks, propose hires, low-trust containment), tool rules (allow, ask or deny by command, file or connector tool), a git identity for its commits, and the secrets lent to it. A project's secrets are versioned, rotatable, audited, and agents can ask for one by name; you type the value, the agent never sees it.
- A monthly budget now stops new runs at 100% (and raises an incident) until you raise it, and an agent can be limited to a number of tasks at once.

**Work layer.**
- Status cards on a project's Dashboard: a short report an agent writes and keeps up to date from the tasks it watches (the same search as the Tasks tab, such as `status:blocked label:release`). It reads the project and never changes it, keeps every revision, refreshes daily or when the watched tasks change, stays within a token cap, and skips the run (no tokens) when nothing changed.
- Automations create tasks. Each firing can make a project task for a Roster agent (and start it in its own worktree), or run a standup: one task, a subtask per agent, and one digest of their reports written into the parent for your review. Templates: Daily standup, What the org learned, CI health check, Project digest.
- Automations take `{{variables}}` (Run now asks for them), a signed webhook trigger on this computer only (HMAC-SHA256, the secret shown once and kept in the encrypted store), an approval gate that waits in your Inbox, and an activity gate that skips a run, at no cost, when nothing changed since the last one ended.
- Task documents with any key (plan, design, notes): every save is a revision with a note, you can compare and restore, select text to start a comment thread that wakes the owner, and agents can save one from their final message. Thumbs on agent replies and documents (kept on this computer, exportable).
- Pull requests link to tasks, pasted or found in an agent's report, and show their state and checks through your signed-in GitHub CLI. The Tasks search takes `pr:failing`, `label:`, `status:`, `assignee:`, `priority:` and `is:live`, and views can be saved.
- Labels, a goals tree (a run is told the chain of goals its task serves), project status and target date, star and hide for agents and projects, Roster state tabs, and a paused banner on the Dashboard.
- Outputs by kind (documents, images, video, text, data, code, pull requests) with search, grouping by task, a status for each (draft, ready for review, approved, changes requested, merged), approve or request changes (which tells the owner), and a mark for what arrived since you last looked.
- The Inbox has Mine, Unread and Snoozed views, Mark all read and Snooze; a decision can carry a decide-by date and "Ask <agent> for a recommendation". The Ledger Timeline is a Gantt (a bar per run, range, zoom, stats) and Activity exports to CSV.

**Find and understand.**
- Keyboard shortcuts with a cheatsheet (press `?`): `c` new task, `/` search, `g` then `i`/`d`/`t`/`r`/`o`/`l` to jump, `j`/`k` to move. They never fire while you type and can be turned off.
- ⌘K finds tasks, agents, projects, documents, comments, outputs and decisions; type a task key like `OSS-12` to open it.
- Set up a project inside Projects: mission and target date, starter agents, a first task, or "Interview me" to plan it with the coordinator. The app's own onboarding is unchanged.
- A "You" card with your tasks, turns, tokens, cost and streak; the Ledger has Costs (by model, agent, project and day, with provider usage windows and your own prices) and Runs tabs.
- A reflection coach proposes better instructions for an agent from its recent work; nothing changes until you apply it. Skill Studio tests a skill against saved inputs, forks it, or makes one from a task.

**Paperclip and models.**
- The latest models are in the picker. Claude Sonnet 5.5 (1M context, images, up to Extra High reasoning) leads the Claude Code list, with Sonnet 5 kept for existing chats. GPT-6.1 Sol shows as "GPT-6.1 Sol" and leads the ChatGPT list (new chats start on it), and the model set in Codex's config.toml stays selectable even when Codex's model cache is out of date.
- Paperclip and your own projects stay apart. An import never writes into a project you made in Muster: each Paperclip project becomes its own project, listed under its org (for example "RagnarDataOps · Paperclip") in Projects and the sidebar, and updated in place by the next import. What you change in Muster (a project's name or goal, a task's title, priority, owner or status) is kept when you import again, and the import report lists each kept edit. An issue deleted in Paperclip is cancelled and marked "Removed in Paperclip". A hire still waiting for approval is not added to the Roster.
- Big Paperclip orgs work. Issues and comments are read page by page with no 500 or 200 cap, so a company of thousands of issues links, imports and re-imports without duplicates, and an issue with hundreds of comments shows every one. The import report says how long it took.
- Change a linked Paperclip task's priority and assignee from its Properties, create tasks there with labels, a goal and blockers, and approve, reject or ask for changes on Paperclip approvals (hires, strategy, budget overrides) from the thread, the Inbox and the Roster. Nothing is sent until you press a button. Pause and Resume on a project's Roster wake only the agents that Pause stopped.
- Paperclip task documents and plans (with their revisions), work products, labels, goal parents and owners, budgets and routines show in Muster, and an import brings them across (routines arrive as paused Automations). Test connection says when a URL is not a Paperclip API, and warns when a token would travel over plain http.
- An imported agent whose runner is not on this Mac no longer starts on the project's default model. Starting its task stops with "Choose a model for <agent>".

## 0.2.10

- Models from OmniRoute and other providers you add in Settings work again. The API key you paste into Muster is now sent with every chat; before, chats went out without it and failed with HTTP 401.
- A provider that rejects your key (401/403) is no longer retried. You get one clear message and an **Open Accounts & providers** button.
- Codex-configured providers work with every way Codex gets a key: a token command (kept in memory only, refreshed, never logged), environment variables, stored tokens and custom headers.
- Codex model catalogs are read correctly, including large and symlinked files. When one really is broken, the message names the file, the field and why.
- One unreadable line in `config.toml` no longer hides every provider in that file, and duplicate "No runnable adapter" rows are gone.
- Pasting a full `…/v1/chat/completions` URL no longer doubles `/v1`, and model names with slashes (like `claude/claude-opus-4.1`) are sent unchanged.


## 0.2.9

- Every project now opens on one page laid out like Paperclip's, whether you made it in Muster or brought it from Paperclip. The header shows the title, repository and open count, and the tabs are Tasks, Roster, Outputs, Settings and Budget.
- Tasks is a list or a board. You can search, filter by status, owner and priority, sort, and group by status, owner or parent. Subtasks nest under their parent and collapse. Keys carry the project's prefix (OSS-1), and a number is never reused.
- New task sets an owner (an agent on the Roster, or you), a priority and a parent. **Assign & start** begins the owner's first run on its runner and model, with its instructions, in a new worktree. Your checkout is never touched.
- Roster: **Add agent** takes a name, title, who it reports to, a runner and model, and instructions. If a project requires approval to add agents, a new hire waits as an approval card in the Inbox and on the Roster. The org chart draws the reporting lines. The generic "Agents" row is gone, and the old Agents tab is now "Working now" under Roster.
- Everything from the old project screen is under Settings: General (name, goal, task keys, default model, approvals, instructions, coordinator, archive and delete), Folders, Members, Mail (the project mailbox, no longer called Inbox), Chats, Knowledge, Runs & verification, and Activity. Changes moved to Outputs.
- Budget shows this month's spend from the Ledger against an optional monthly budget, with a soft alert at 80%.
- Dashboard shows:
  - live agent cards;
  - agents enabled, tasks in progress, month spend and pending approvals;
  - 14-day run activity, tasks by status and success rate;
  - recent activity and recent tasks.
  Spend with no known price reads "Unpriced", never $0.
- Import from Paperclip first asks where each Paperclip project goes: an existing Muster project (suggested by the same folder, repository or name), a new one, or nowhere. Filling your own project keeps its name.
- The sidebar follows Paperclip's order: Inbox and Dashboard, then Work (Tasks, Projects, Automations, Outputs), then Org (Roster, Skills, Integrations, Ledger). Your chats, folders and projects stay below.

## 0.2.8

- The Inbox badge counts only what still needs you: a chat that failed, was interrupted or is waiting counts until you open it, then stays listed under Problems for three days. A turn cut short because Muster quit now reads "Interrupted when Muster quit — continue?". Every Inbox item has Dismiss; a new failure in the same chat shows again.
- The Ledger imports your past turns after an upgrade, in the background, as Imported history: one entry per past turn with its chat, project, model, tools and outcome, plus runs brought in from Paperclip. Imported entries stay outside the verified chain. An empty Ledger explains what gets recorded and offers Import history.

## 0.2.7

- Projects gain an Inbox, task threads and a Ledger. The Inbox sits at the top of the sidebar and gathers everything that needs you from every chat and run: questions, approvals, finished work and problems.
- Each project has a Roster: an org chart of its agents you can zoom, pan and navigate with the keyboard, with a runs board and Pause/Resume, plus the project's Outputs.
- Every agent turn in a project gets a receipt (files changed, tests, tokens, time, cost) recorded in a tamper-evident Ledger with Receipts, Timeline, Activity and Costs views.
- Link a Paperclip server (this Mac or a custom URL with an encrypted token) from Settings › Integrations, or import a Paperclip company into Muster: projects, tasks with their full threads, each project's Roster and past decisions. Import only reads from Paperclip and never copies secrets.
- Start any imported task in its own worktree on its owner agent's runner; it never runs in your checkout and never starts on its own.

## 0.2.6

- Intel Macs get their own download (`Muster-Agent-<version>-x64.dmg` / `.zip`) and update to the Intel build automatically.
- Installing an update no longer hangs on "Installing" when you cancel the quit prompt or choose Keep Working in
  Background; the update stays ready and can be installed again.
- Windows: agent tools work. The terminal, browser, sandbox, canvas, mailbox and MCP-server tools are started
  through Windows launchers instead of shell scripts Windows could not run.
- Claude Code subagents are reviewable like Codex ones: each appears on the summary card and in the Subagents tab
  with its own transcript, live state and a Background tag. Children left running by a crash show as interrupted,
  and a background child that never reports is stopped after 30 minutes.
- Linux: the AppImage and tar.gz start on Ubuntu 23.10+ and other systems that restrict user namespaces; the
  Chromium sandbox stays on whenever it can (always for the `.deb`). The app groups correctly in docks and
  taskbars, handles `muster://` links, and the `.deb` declares its dependencies.
- Linux: API keys and browser sign-ins are only saved with a real keyring (GNOME Keyring, KWallet, including on
  MATE and LXQt), never with Chromium's insecure fallback. Keys saved under that fallback must be entered again.
- Linux: Docker Engine is found with rootless sockets, `DOCKER_HOST` and snap installs, and agent CLIs installed
  via npm prefixes, snap, Linuxbrew, Volta or pnpm are detected.
- Sandboxed chats tell the agent truthfully that its own shell still runs on your computer under the chat's
  access level, and to use the sandbox tools instead.
- Muster Agent is now open source under the MIT license.

## 0.2.5

- Muster Agent for Windows and Linux. Windows 10/11 (x64): a per-user installer (`-win-x64-setup.exe`) or a
  portable zip. Linux (x64): an AppImage, a `.deb` for Debian/Ubuntu and a tar.gz. Terminals open PowerShell on
  Windows and your shell on Linux; Codex, Claude Code and OpenCode are found whether they came from npm or a
  native installer. Computer use and Quick Look previews stay macOS-only.
- On Windows and Linux, Muster tells you when a new version is out and **Download update** opens the release page.

## 0.2.4

- Projects: creating a project lets you pick one or more sources: tick existing folders, choose a folder,
  or clone a repository. The first is the primary (where chats and task runs start); change it any time.
- Model picker: one compact picker everywhere (composer, new chat, automations, default models). One-line rows
  with only known capabilities, it opens on your current model's provider, and a router's auto routes fold into
  one "Auto routes" group.
- Steer works for Claude Code: a message sent while it works joins the running turn instead of being queued.
- Imports bring in whole sessions: the old 20,000-item cut-off is gone.
- Codex keeps working after a ChatGPT app update that moves its bundled CLI: a stale `codex` wrapper is skipped
  and the new location is found.
- Router agents work: picking Intelligent planner, Advisor, Executor or an auto route on a router no longer fails
  with "Selected model does not match the provider".

## 0.2.3

- The conversation and the composer sit centred between the sidebar and the summary card, as in Codex,
  instead of drifting under the card on wide windows.
- Files mentioned in replies are links: `src/app.py:342` or "fleet_status.py (line 134)" opens the file at
  that line, with a coloured file-type icon. Names that match no file in the chat's folders stay plain text.
  Links read in a clearer blue.
- New models on an account appear without a relaunch: the list refreshes when the window regains focus and
  whenever the model picker opens (for example GPT-6 Sol and Luna on a ChatGPT sign-in).
- Routers with a model catalog also offer their own agents and auto routes (for example Hybrow OmniRouter's
  planner, advisor, executor and smol). Every other model the router serves is loaded too, off by default;
  switch any on under Settings › Models › "more models on this router".
- Updates are checked every hour and when you come back to the window.
- Model lists over 1 MB (large routers) load correctly; image, audio and video models are left out of chat pickers.
- Computer use picture-in-picture, Codex-style: live window cards stacked under the summary card (one per
  app or page the agent is using), with just close and take-control. Activity rows show each app's icon and
  summarise as "Used Mail, Notes and the browser, …".
- Every agent can use the in-app browser: Claude Code (direct) now gets Muster's browser, terminal and other
  tools, like Codex-based models. Saying "in-app browser", "the browser" or "here" means the right-pane browser.
- In Ask for approval mode the in-app browser no longer asks per step (desktop computer use still asks).

## 0.2.2

- Thinking opens: models that show their reasoning as text (Claude-style thinking through a gateway)
  now fill "Thought for …", so you can click it and read what the model considered. Models with
  hidden reasoning still show their summary only.
- Tighter transcript: one-line activity (thinking, tools, notices) stacks closely, and only a turn's
  last reply carries the copy, time and actions row.
- Code blocks: a "</> Plain text" / "TypeScript" style label, a wrap toggle beside Copy, rounder corners.
- Lists in replies read as one block, with bullets in the text colour.

## 0.2.1

- Chat replies read more like a native assistant: 14px text by default (Settings › Appearance › Chat text
  size, 13–16px), slightly heavier and softer, with a line between paragraphs. New text fades in while a reply
  streams; Reduce motion turns it off.
- Response style (Settings › Chat): Automatic asks Codex-based models for the Friendly personality unless your
  Codex config sets one, so answers explain what was done and why. Choose Friendly or Pragmatic to override.
- Memory for teams: on a shared Hindsight server, personal memory is now one bank per person (only a hash of
  your identity is sent) and a git repository's memory is shared by everyone working on it. Folders without
  a remote stay private. The Memory screen says whether a scope is shared with your team or private to you.
  IT can set each person's identity with MUSTER_MEMORY_IDENTITY.
- The memory recall list above the message box opens fully instead of being clipped.

## 0.2.0

First downloadable build of Muster Agent, the standalone desktop app for running coding agents on
your own folders. It is plain Electron, with no editor or extension host.

- Updates: checks GitHub Releases in the background, verifies each download's checksum and signature,
  and installs with one click on **Update and relaunch** at the bottom of the sidebar.
- Terminal: opens in a bottom panel under the chat (⌘J), or in the right pane if you prefer.
- Chats: streaming agent turns with tool calls and diffs shown inline, steering and stopping a run
  mid-turn, chat search, and import of earlier agent sessions.
- Providers: detects the model providers already signed in on your Mac (subscription sign-ins, API
  keys, local model servers or a configured gateway) and uses them directly; guided setup when none are found. You pick default
  models per user, project or folder.
- Workspaces: folders and projects with a file tree, integrated terminal, git history, an embedded
  browser, and previews for PDFs, spreadsheets and images.
- Projects: tasks and decisions that persist, run through linked agent chats, plus portable exports.
- Automations, memory, skills and plugins, parallel runs, and optional Docker sandboxes and computer use.
- Reliability: crash-safe storage with versioned schema migrations and automatic backups, protection
  for your own processes, and a first-run guide.
- Distribution: signed macOS builds for Apple silicon (arm64) and Intel (x64) as `.dmg` and `.zip`,
  with SHA-256 checksums.
