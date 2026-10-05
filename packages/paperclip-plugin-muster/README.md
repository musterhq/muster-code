# Muster for Paperclip

A thin [Paperclip](https://github.com/paperclipai/paperclip) plugin that complements Muster Agent's local check-out workflow inside Paperclip's own web UI. MIT licensed. Built on the Paperclip plugin SDK (`@paperclipai/plugin-sdk`, MIT); see `NOTICE`.

The plugin is optional polish. Muster Agent checks a task out with Paperclip's ordinary primitives (reassign to the human, comments, documents), so everything works without it. The plugin only makes that state easier to see.

It does not run work on desktops, does not reassign anything, does not call out to the network and stores nothing of its own.

## What you get

| Where | What |
| --- | --- |
| Task page, **Muster** tab | Who has the task checked out, on which device, since when, last activity, an **Open in Muster** button, and the latest local work summary. |
| Task page, **Receipts** tab | The task's "Local work log" document as a table: files +/-, tests, tokens, model, cost (personal or org), with totals. |
| **My work** page and sidebar link | Your active tasks across projects grouped by project, tasks checked out in Muster marked, plus tasks that @mention you. |
| Hourly job | One reminder comment, @mentioning the assignee, when a Muster check-out has had no Muster activity for N hours (default 24). |

## How "checked out" is derived

There is no server-side lease. A task is checked out when **both** hold:

1. its human assignee (`assigneeUserId`) is the user who posted the latest Muster check-out comment, and
2. no later release or hand-back comment from that user exists.

Muster Agent posts its comments as the signed-in user ("via Muster · local") and appends a machine-readable marker, an HTML comment that Paperclip's renderer hides:

```
<!-- muster:checkout device="Dhairya's MacBook" device-id="mbp-1" by="Dhairya" at="2026-10-05T09:00:00Z" -->
<!-- muster:activity at="2026-10-05T10:12:00Z" -->   progress, decision, evidence and cost comments
<!-- muster:release at="2026-10-05T11:00:00Z" -->    the user let go of the task
<!-- muster:handback at="2026-10-05T11:00:00Z" -->   the user finished and handed back to review
```

- Attribute values are double-quoted; write a literal `"` as `&quot;` and `&` as `&amp;`. `device` and `by` are display text; `device-id` is opaque.
- Timing comes from each comment's server timestamp (`createdAt`), never from the `at` attribute, so a skewed desktop clock cannot fake activity.
- A comment that ends with the visible sign-off `via Muster` also counts as activity even without a marker.
- Only comments written by a human user count. Markers inside agent-authored comments are ignored, so an agent cannot start or extend a check-out. The one exception is `<!-- muster:reminder -->`, which is read only from the plugin's own (non-human) comments.
- If the task is reassigned to someone else or an agent, or closed, the tab shows "No longer held" and the reminder job skips it.

### Local work log document

Muster keeps one issue document with key `local-work-log` (title "Local work log"; a document titled that way under any key also works). One `##` section per entry:

```markdown
## 2026-10-05T09:14:00Z · Add retry to the uploader
- Device: Dhairya's MacBook
- Files: +120 -34 (6 files)
- Tests: 14 passed, 1 failed
- Tokens: 12,400 in / 3,100 out
- Model: claude-sonnet-5-5
- Cost: $0.42 (personal)
- Summary: Retries with backoff; added tests for the 429 path.
```

`Cost source: org` on its own line works too, and an entry may be a fenced ```json block (one object or an array) with the fields `at, title, device, filesAdded, filesRemoved, filesChanged, tests, tokensIn, tokensOut, model, costUsd, costSource, summary`. Unknown bullets are kept but not shown.

### Open in Muster

The button is a plain link (the host's launchers only open http(s)), so Muster Agent must register the `muster://` scheme:

```
muster://task/<companyId>/<issueId>?host=<URL-encoded Paperclip origin>&identifier=<MUS-12>
```

## Capabilities declared, and why

| Capability | Why |
| --- | --- |
| `issues.read` | Read the task (assignee, status) and list tasks for the reminder job and the mention scan. |
| `issue.comments.read` | Read Muster's check-out comments. |
| `issue.documents.read` | Read the "Local work log" document. |
| `issue.comments.create` | Post the idle reminder. Written as the plugin, never as a person. |
| `companies.read` | The hourly job walks the companies. |
| `jobs.schedule` | The hourly reminder job (`0 * * * *`). |
| `ui.detailTab.register` | The Muster and Receipts tabs. |
| `ui.page.register` | The My work page. |
| `ui.sidebar.register` | The My work sidebar link. |

Deliberately absent: `http.outbound`, `secrets.read-ref`, any `plugin.state.*`, `api.routes.register`, `webhooks.receive`, and every write capability except the reminder comment (no issue update, assign, checkout, wakeup or document write). The config holds one number, no secrets.

## Configuration

Plugin settings, per company:

- **Idle check-out reminder (hours)**, default 24, minimum 1. One reminder per idle stretch; new Muster activity re-arms it. The task is never reassigned.

**Save the settings once for each company you want reminders in**, even with the default value. Paperclip only lets scheduled jobs act on companies whose plugin settings exist, and the job logs "company context is required" for the rest and carries on.

## Install (self-hosted admin)

Needs an **instance admin**. Plugin workers and UI are trusted code that runs on the Paperclip server and in every user's browser, so only install what you have read.

```bash
git clone https://github.com/musterhq/muster-code
cd muster-code/packages/paperclip-plugin-muster
npm ci
npm run build
paperclipai plugin install "$PWD"        # absolute local path
paperclipai plugin list                  # musterhq.muster  status=ready
```

Then, as the same admin, open the plugin's settings page and save the settings for each company (see above), or call `POST /api/plugins/musterhq.muster/config` with `{"companyId": "...", "configJson": {"leaseExpiryHours": 24}}`. The server must be able to read the path, so on Docker or a remote host mount or copy the built folder first. After rebuilding, run `paperclipai plugin disable musterhq.muster && paperclipai plugin enable musterhq.muster` to reload the worker (the dev watcher did not always pick up a rebuild in testing).

**Task tabs need the classic task page.** In Paperclip 2026.1001.0 the default task page ("task chat shell") does not render plugin detail tabs. Turn on **Settings, Experimental, Classic task interface** (`enableClassicTaskInterface`) to see the Muster and Receipts tabs on tasks. The My work page, sidebar link and the reminder job do not depend on it.

### Cloud-managed Paperclip

On cloud-managed instances (the server has `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` or `PAPERCLIP_MANAGED_CONFIG` set), both npm and local-path installs return **403**; only plugins baked into the platform image are allowed. This plugin cannot be installed there. Muster Agent's check-out still works, because it never needed the plugin. Ask the platform operator to bundle it, or run self-hosted.

### Install from npm

Once published: `paperclipai plugin install @musterhq/paperclip-plugin-muster`. The package is currently `private`; publish it before using this form.

## Develop

```bash
npm ci
npm run dev          # esbuild watch for worker, manifest and ui
npm test             # vitest: markers, check-out derivation, work-log parser, worker data, hourly job
npm run typecheck
npm run build
```

This package is standalone npm, excluded from the repo's pnpm workspace (like `packages/agent-app` and `packages/server`). CI: `.github/workflows/paperclip-plugin-muster-ci.yml`.

## Known limits of the Paperclip plugin API

- **Run pages have no plugin tab surface** in 2026.1001.0. The Receipts slot also declares `run` (so it will light up when the host adds it), but today receipts show on the task page only.
- **Plugin comments do not mention-notify**: the reminder carries a `[@name](user://id)` mention, but a comment written by a plugin is system-authored and was not observed to create an inbox item. It is visible on the task and in the Mentions list on My work.
- Host data calls from plugin UI do not carry the viewer's identity, so My work reads your own tasks with your own browser session (`assigneeUserId=me`) and uses the worker only for check-out state and mention scanning.
- Mention scanning reads comments of the 40 most recently updated open tasks you are not assigned to; it is not a search index.
- A status-export webhook for the OSS Manager "Customers" project was left out to keep capabilities minimal (it would need `webhooks.receive`, `issue.documents.write`, `projects.read` and a secret ref).
