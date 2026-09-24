# Changelog

All notable changes to Muster Agent. Each `## <version>` section becomes the notes of the
`agent-v<version>` GitHub Release (`.github/workflows/agent-app-release.yml`).

## 0.2.0

First downloadable build of Muster Agent, the standalone desktop app for running coding agents on
your own folders. It is plain Electron, with no editor or extension host.

- Chats: streaming agent turns with tool calls and diffs shown inline, steering and stopping a run
  mid-turn, chat search, and import from Codex.
- Providers: detects the model providers already signed in on your Mac (Codex, Claude Code, OpenCode
  or a configured gateway) and uses them directly; guided setup when none are found. You pick default
  models per user, project or folder.
- Workspaces: folders and projects with a file tree, integrated terminal, git history, an embedded
  browser, and previews for PDFs, spreadsheets and images.
- Projects: tasks and decisions that persist, run through linked agent chats, plus portable exports.
- Automations, memory, skills and plugins, parallel runs, and optional Docker sandboxes and computer use.
- Reliability: crash-safe storage with versioned schema migrations and automatic backups, protection
  for your own processes, and a first-run guide.
- Distribution: signed macOS builds for Apple silicon (arm64) and Intel (x64) as `.dmg` and `.zip`,
  with SHA-256 checksums.
