# Changelog

All notable changes to Muster Agent. Each `## <version>` section becomes the notes of the
`agent-v<version>` GitHub Release (`.github/workflows/agent-app-release.yml`).

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
