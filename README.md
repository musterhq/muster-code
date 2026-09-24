<div align="center">

# Muster Agent

**The agentic development client that remembers.**

A native macOS app where coding agents work in your folders, with long-term memory, sandboxed
computers, and the model providers you already have, all in one window.

[![Latest release](https://img.shields.io/github/v/release/musterhq/muster-code?filter=agent-v*&label=release&color=2f6feb)](https://github.com/musterhq/muster-code/releases/latest)
[![macOS 14+ · Apple silicon](https://img.shields.io/badge/macOS-14%2B%20·%20Apple%20silicon-111?logo=apple)](https://github.com/musterhq/muster-code/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/musterhq/muster-code?style=flat&color=f5c518)](https://github.com/musterhq/muster-code/stargazers)

### [⬇ Download for macOS (Apple silicon)](https://github.com/musterhq/muster-code/releases/latest)

<sub>Grab <code>Muster-Agent-&lt;version&gt;-arm64.dmg</code> from the latest release · Intel Macs: <a href="#run-muster-agent-on-another-mac-from-source">run from a clone</a></sub>

<br/>

<img src="docs/images/muster-agent-hero.png" alt="Muster Agent: a chat with an agent on the left and the live diff of its edits on the right" width="100%"/>

<sub>A chat on the left and the live diff of the agent's edit on the right. Undo any change before you keep it.</sub>

</div>

---

## Why Muster Agent

Most agent apps start every chat from zero, run commands straight on your machine, and lock you
into one vendor's models. Muster Agent is an **agentic development client (ADC)** built the other way
around:

- **It remembers.** Long-term memory, backed by the Hindsight memory engine, carries what the agent
  learned about you and each project into the next chat. You can see what will be recalled before
  you send.
- **It keeps agents contained.** Each chat or folder can get its own Docker-backed computer with no
  network by default, capped memory, CPU and process counts, and only the grants you give it.
- **It uses the providers you already have.** On first launch it finds your existing sign-ins,
  gateways, API keys and local model servers. You don't sign in again.
- **It stays light.** Long chats, terminals and diffs are virtualized and kept in bounded buffers,
  so memory use stays bounded as a session grows.
- **It is a real workbench.** Live diffs with Keep/Undo, a terminal, a browser, git history and
  parallel chats sit next to the conversation, so you rarely have to switch windows.

## Tour

What each part of the app looks like, and what to look for. The screenshots use a made-up project,
*taskboard*, a small TypeScript API and web board.

<table>
<tr>
<td width="50%" valign="top"><img src="docs/images/muster-agent-timeline.png" alt="One turn, opened up"/><br/><b>One turn, opened up.</b> The agent's reasoning, the files it read and searched, each edit with its +/- counts, and the test run with its output and exit code.</td>
<td width="50%" valign="top"><img src="docs/images/muster-agent-inline-diff.png" alt="Inline diffs in the chat"/><br/><b>Inline diffs in the chat.</b> Each edited file shows as a diff in the conversation. Keep or Undo one change, or the whole file.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/images/muster-agent-memory.png" alt="Memory"/><br/><b>Memory.</b> Personal and folder notes with where they came from, a note suggested by the last run to keep or dismiss, and search.</td>
<td width="50%" valign="top"><img src="docs/images/muster-agent-recall.png" alt="Recall preview"/><br/><b>Recall preview.</b> Before you send, the composer lists the notes the next turn will recall for this draft; remove any you don’t want in this chat.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/images/muster-agent-providers.png" alt="Accounts and providers"/><br/><b>Accounts and providers.</b> Found on first launch and ready for chats, each with its endpoint, model catalog and a health check.</td>
<td width="50%" valign="top"><img src="docs/images/muster-agent-providers-local.png" alt="Local model servers"/><br/><b>Local model servers.</b> Ollama and LM Studio on this Mac, next to API keys from your environment.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/images/muster-agent-model-picker.png" alt="Model picker"/><br/><b>Model picker.</b> Every ready provider's models with context size, image support and reasoning level, switchable per chat.</td>
<td width="50%" valign="top"><img src="docs/images/muster-agent-sandbox.png" alt="A scoped computer"/><br/><b>A scoped computer.</b> A disposable Linux container with no network, live memory, CPU and process use against its limits, services, command history and files.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/images/muster-agent-environment-menu.png" alt="Where a chat runs"/><br/><b>Where a chat runs.</b> This Mac, a sandbox, or a new worktree so a parallel chat doesn't touch your checkout.</td>
<td width="50%" valign="top"><img src="docs/images/muster-agent-terminal.png" alt="Terminal panel"/><br/><b>Terminal panel.</b> Real shells under the chat, one tab per shell, with the dev server and the test run side by side.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/images/muster-agent-git-changes.png" alt="Git changes"/><br/><b>Git changes.</b> Uncommitted files colour-coded by status, with the chat that changed each one, and the commit box.</td>
<td width="50%" valign="top"><img src="docs/images/muster-agent-git-history.png" alt="Git history"/><br/><b>Git history.</b> The commit graph with branches, tags and remotes. Pick a commit to see its message and files.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/images/muster-agent-projects.png" alt="Projects"/><br/><b>Projects.</b> Tasks with owners, priorities and dependencies. Ready tasks go to agents in parallel, and you verify the results.</td>
<td width="50%" valign="top"><img src="docs/images/muster-agent-spotlight.png" alt="Spotlight search"/><br/><b>Spotlight search.</b> ⌘K finds chats, message text and files from anywhere in the app.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/images/muster-agent-skills.png" alt="Skills and plugins"/><br/><b>Skills and plugins.</b> Local skills by scope, each switched on or off. Plugins and MCP servers have their own tabs.</td>
<td width="50%" valign="top"><img src="docs/images/muster-agent-automations.png" alt="Automations"/><br/><b>Automations.</b> Runs on a schedule, when a repository event such as a failed check happens, or when files change.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/images/muster-agent-updates.png" alt="Updates"/><br/><b>Updates.</b> A new version downloads in the background. Update and relaunch installs it; the same button sits at the bottom of the sidebar.</td>
<td width="50%" valign="top"><img src="docs/images/muster-agent-hero-light.png" alt="Light theme"/><br/><b>Light theme.</b> Every screen follows the macOS appearance, or pick light or dark in Settings.</td>
</tr>
</table>

## Memory

<img src="docs/images/muster-agent-memory.png" alt="The Memory screen: saved notes for a folder with search and scope" width="100%"/>

Agents that learn, not just agents that chat.

- **Personal and per-folder memory.** Notes live in your Personal scope or with a folder or project,
  so one repo's conventions never leak into another.
- **Recall preview.** A chip in the composer shows which notes the next turn will recall for the
  draft you are typing. Open it to inspect them, or leave one out of this chat.

  <img src="docs/images/muster-agent-recall.png" alt="The recall list open above the composer: three notes the next turn will use, each removable" width="80%"/>
- **Auto-save after runs.** Choose *Never*, *Ask after runs*, or *Save after completed runs*.
  Recall runs automatically before each turn, and you can turn it off.
- **You're in control.** Browse, search, add and delete memories in the Memory screen. Deletions
  are tracked until the engine confirms them.
- **Powered by Hindsight.** Point Muster at a Hindsight endpoint in Memory settings (for example
  `http://localhost:8888`), or set `HINDSIGHT_API_URL` / `HINDSIGHT_API_KEY`. A key saved in settings is
  stored encrypted.

## Sandboxing

Give an agent a computer of its own instead of your laptop.

<img src="docs/images/muster-agent-sandbox.png" alt="A chat next to its scoped computer: resource limits and live use, services, read-only layers, command history and files" width="100%"/>

<sub>The chat runs in a disposable sandbox. Look for <i>No network</i>, the memory, CPU and process meters, and the commands it ran.</sub>

- **Scoped computers.** A chat (session) or a folder (workspace) gets its own Docker container,
  with its own history, files and services.
- **Safe defaults.** No network unless you allow egress. Defaults are 512 MiB of memory, 1 CPU and
  256 processes, adjustable per computer. At most two computers run at once.
- **Explicit grants.** Environment variables and tool access are allowlisted. Extra folders can be
  mounted read-only.
- **Optional.** Install Docker Desktop to turn sandboxes on. Without it, everything else works normally.

## Your providers

<img src="docs/images/muster-agent-providers.png" alt="Provider setup: detected sign-ins, gateways, API keys and local model servers" width="100%"/>

Muster Agent detects what is already on your Mac and uses it as-is:

| Source | What it picks up |
| --- | --- |
| **Subscription sign-ins** | Your ChatGPT and Claude sign-ins from the command-line tools already on this Mac |
| **Routers and gateways** | OpenAI-compatible gateways already configured in your local agent CLI config |
| **API keys in your environment** | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY` |
| **Local models** | Ollama and LM Studio on this Mac, on their default ports or the ports their config names |
| **Anything else** | Add a custom OpenAI-compatible endpoint |

Models come from each provider's own `/models` endpoint. There is no hard-coded model list. If
nothing is found, guided setup walks you through adding a provider.

<img src="docs/images/muster-agent-model-picker.png" alt="The model picker: providers down the side, models with context size, image support and reasoning level" width="100%"/>

<sub>Pick any ready provider's model per chat, with its context size, image support and reasoning level.</sub>

## Built for low RAM

Agent sessions get long. Muster Agent keeps what it holds in memory bounded:

<img src="docs/images/muster-agent-timeline.png" alt="An agent turn opened up: reasoning, reads, edits and a test run with its output" width="100%"/>

<sub>Tool rows fold into one line per step and long output shows only its tail until you ask for more.</sub>

- **Virtualized timelines.** Chat history, tool output and git history render only the rows on screen.
- **Incremental streaming.** Streaming Markdown re-parses only the part still being written, so
  finished code blocks are not re-parsed on every token. The timeline syncs as a snapshot plus
  ordered deltas, and completed rows keep their identity.
- **Panes load when you open them.** Settings, Projects, Memory, Automations, git history, pull
  requests and computer tabs load on first use. They are preloaded when the app is idle.
- **One terminal emulator per shell.** It moves between the bottom panel and the side tab instead of
  being rebuilt. Scrollback is capped at 5,000 lines.
- **Bounded command output.** Each command keeps up to 128 KB, and finished commands share a 2 MB
  budget. Older output keeps only its tail.
- **Workers that go away.** Diffing and syntax highlighting run in web workers, off the UI thread.
  Idle workers are shut down and recreated on demand.

## Features

<img src="docs/images/muster-agent-terminal.png" alt="The integrated terminal panel under a chat" width="100%"/>

| | | |
| --- | --- | --- |
| **Live diffs**<br/>Review each edit as it lands. Keep or Undo per hunk or per file, or view whole-file inline diffs. | **Integrated terminal**<br/>A bottom panel with real shells and search. | **Built-in browser**<br/>Preview your app, read its console and pick elements for the agent. |
| **Git tab**<br/>Commit history, and compare any two refs. | **Parallel chats and projects**<br/>Several chats in one checkout, with overlap detection and "Run in a worktree". | **Skills, plugins and MCP**<br/>Install plugins, write skills, connect MCP servers. |
| **Automations**<br/>Scheduled runs, or runs triggered by new pull requests, pushes and failed CI checks. | **Import past sessions**<br/>Bring in conversations from other agent tools and chat exports, read-only. | **Spotlight search**<br/>Search chats, messages, files and folders. Type `>` for commands. |

<p align="center"><img src="docs/images/muster-agent-updates.png" alt="Settings, Updates: version 0.2.1 is ready with an Update and relaunch button" width="60%"/></p>

## Install

1. **Download** the newest `Muster-Agent-<version>-arm64.dmg` from
   [the latest release](https://github.com/musterhq/muster-code/releases/latest). All Muster Agent
   releases are [tagged `agent-v…`](https://github.com/musterhq/muster-code/releases?q=agent-v).
   A `.zip` of the same app is attached too, and `SHA256SUMS` lets you check the download
   (`shasum -a 256 -c SHA256SUMS --ignore-missing`).
2. **Drag** **Muster Agent** onto **Applications**.
3. **First open: right-click, then Open.** Builds are signed with the self-signed "Muster Agent
   Self-Signed" identity but are not notarized by Apple, so macOS blocks the first launch.
   Right-click **Muster Agent** in Applications, choose **Open**, then **Open** again (on recent macOS:
   System Settings > Privacy & Security > **Open Anyway**). Or clear the quarantine flag once:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/Muster Agent.app"
   ```

   The signing identity stays the same from one release to the next, so macOS keeps the permissions
   you grant (Screen Recording, Accessibility) across updates.
4. **Updates arrive automatically.** The app checks GitHub Releases, verifies the download against
   its published SHA-256 and code signature, and accepts it only if it is signed by the same
   identity. The update installs when you restart.

**Requirements:** macOS 14 (Sonoma) or later and a model provider (see [Your providers](#your-providers)).
The download is **Apple silicon only** for now. Intel Macs run from a clone (below). Docker Desktop is
optional and only needed for sandboxes.

## Run Muster Agent on another Mac (from source)

A fresh clone builds and runs with no sibling checkouts and no environment variables: the few
Muster core sources the app bundles are vendored in `packages/agent-app/vendor/` (see its README).

### Prerequisites

- macOS 14 (Sonoma) or later. Apple silicon and Intel both work: npm installs the matching Electron
  build and node-pty is compiled for the local architecture.
- Node.js 24 (pinned in `packages/agent-app/.nvmrc` and `.node-version`, so `nvm use`, `fnm use` or
  `mise` pick it up), with the npm that ships with it.
- git.
- Xcode Command Line Tools (`xcode-select --install`), used to compile node-pty for the integrated
  terminal. Without them the install still succeeds and falls back to node-pty's prebuilt binary.

### One command

```sh
git clone https://github.com/musterhq/muster-code.git && cd muster-code \
  && cd packages/agent-app && npm ci && npm start
```

Or let the helper check prerequisites first (macOS, Node 24 with an nvm/fnm/mise switch if one is
installed, git, Xcode tools), then run `npm ci` and `npm start`:

```sh
git clone https://github.com/musterhq/muster-code.git && cd muster-code \
  && ./packages/agent-app/scripts/run-mac.sh
```

`npm ci` installs the exact locked dependencies, downloads Electron (about 100 MB), and its
`postinstall` step rebuilds node-pty for Electron. After that, `npm start` builds `dist/` and opens
the app; later runs only need `npm start` from `packages/agent-app`.

### First launch

Muster Agent looks for providers you are already signed in to on that Mac and uses them directly.
If it finds none, it opens guided setup to sign in or add one. Settings and chats live in
`~/Library/Application Support/Muster Agent`; pass `--user-data-dir=/some/dir` (for example
`npx electron . --user-data-dir=/tmp/muster-test`) to run an isolated profile.

### Optional capabilities

- Sandboxes: install and start Docker Desktop. Without it, sandboxed runs are unavailable and the
  rest of the app works normally.
- Computer use: grant Screen Recording and Accessibility in System Settings > Privacy & Security
  when macOS prompts (for a dev run the permission is attributed to Electron or your terminal).

### Build a local .app

```sh
cd packages/agent-app
npm run build && node scripts/package-preview.mjs   # -> release/Muster Agent Preview.app
```

Without `MUSTER_SIGN_IDENTITY` the bundle is ad hoc signed, so Gatekeeper blocks a copy moved to
another Mac: right-click the app and choose Open the first time, or clear the quarantine flag with
`xattr -dr com.apple.quarantine "Muster Agent Preview.app"`. Developer ID signing and notarization
are covered in `packages/agent-app/docs/RELEASE.md`.

### Troubleshooting

- Wrong Node version (`EBADENGINE` warning, or build errors): run `nvm use` / `fnm use` in
  `packages/agent-app`, or install Node 24, then `rm -rf node_modules && npm ci`.
- The terminal pane fails to start, or `postinstall` printed a node-pty warning: install Xcode
  Command Line Tools, then `npm run rebuild:native`. Set `MUSTER_SKIP_NATIVE_REBUILD=1` to skip the
  rebuild during `npm ci` (for example on CI).
- Electron download failed during install: re-run `npm ci`, or just `npm start` (Electron retries the
  download on first launch).
- Contributors with their own Muster core checkouts can override the vendored sources with
  `MUSTER_CORE_CLIENT_ENTRY`, `MUSTER_RUNTIME_SOURCE_ROOT` and `MUSTER_SANDBOX_SOURCE_ROOT`; the
  build log prints which source each bundle used. `npm run vendor:sync` refreshes `vendor/` from them.

## What's in this repository

This repository holds two apps: **Muster Agent** (above) and **Muster Code**, a Code-OSS-based IDE
with the Muster agent built in.

- `packages/agent-app/` — Muster Agent, the standalone Electron agent app. Developer notes are in
  [its README](packages/agent-app/README.md).
- `product/` — the Muster Code distribution overlay (branding, Open VSX gallery, Muster as the
  default chat agent, proposed-API grants).
- `packages/builtin/` — the built-in Muster layer for Muster Code: default chat participant, agent
  thread sessions, model provider, threads view, board, live diff, inline completions. Bundled into
  the app as `muster.muster-code`.
- `scripts/assemble.sh` — builds `dist/Muster Code.app` from a prebuilt Code-OSS binary + overlay +
  built-in layer, with no editor compile step.
- Engine: `@musterhq/core` (the open-source muster) linked from the sibling checkout.

### Build Muster Code

```
pnpm install
pnpm assemble          # → dist/Muster Code.app
open "dist/Muster Code.app"
```

Dev launch (isolated profile): `MUSTER_CODE_DEV_SOCK=/tmp/mc-dev.sock "dist/Muster Code.app/Contents/MacOS/Muster Code" --user-data-dir /tmp/mc-udd /tmp/mc-sample`

Base: Code-OSS 1.126 (Electron 42, Node 24 with node:sqlite), from prebuilt Code-OSS release binaries.
