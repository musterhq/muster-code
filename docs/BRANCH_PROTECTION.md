# Branch protection for `main`

Recommended settings (a repository admin applies these under Settings > Branches; nothing in this
repository changes them):

- Require a pull request before merging, with at least one approving review (CODEOWNERS review is on).
- Require status checks to pass before merging, and require branches to be up to date.
- Block force pushes and deletion of `main`.

## Required status checks

These jobs run on every pull request to `main`, regardless of which files changed:

| Check name | Workflow |
| --- | --- |
| `test` | `CI` (`.github/workflows/ci.yml`): typecheck, extension build, webview checks, tests |

## Do not require path-filtered checks

These workflows only run when a PR touches `packages/agent-app/**` (or the workflow file). If they are
marked required, a docs-only or IDE-only PR never starts them and the check stays "Expected" forever,
blocking the merge:

| Check name | Workflow |
| --- | --- |
| `verify` | `Muster Agent CI` (`agent-app-ci.yml`) |
| `linux`, `windows` | `Muster Agent Windows & Linux` (`agent-app-cross-platform.yml`) |

Maintainers should confirm they are green before merging any PR that touches `packages/agent-app`.
If you want them required, first remove the `paths:` filter from their `pull_request` trigger (at the
cost of running macOS/Windows/Linux builds on every PR).

The release workflows (`agent-app-release.yml`, `release.yml`) run on tags and manual dispatch only.

## Workflow safety notes

- No workflow uses `pull_request_target`; PR workflows receive no secrets and default to
  `contents: read`.
- Signing secrets are used only in `agent-app-release.yml` and `release.yml` (tag or manual dispatch).
