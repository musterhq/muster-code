# Contributing to Muster Agent

Thanks for helping. This repository holds **Muster Agent** (`packages/agent-app`, the Electron desktop
app for macOS, Windows and Linux) and **Muster Code** (the Code-OSS based IDE overlay in `product/`,
`packages/builtin`, `packages/theme`). It is one project with [musterhq/muster](https://github.com/musterhq/muster),
the open-source Muster CLI and core. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

**Licensing:** to be announced; see [#81](https://github.com/musterhq/muster-code/issues/81).
There is no CLA and no DCO sign-off: contributions are accepted under whatever license the repository
carries (inbound = outbound).

## Setup

Muster Agent is a standalone npm project (its own `package-lock.json`); it needs Node 24 (see
`packages/agent-app/.nvmrc`), git, and on macOS the Xcode Command Line Tools (for `node-pty`).

```sh
git clone https://github.com/musterhq/muster-code.git && cd muster-code/packages/agent-app
npm ci
npm start                 # builds dist/ and opens the app
npx electron . --user-data-dir=/tmp/muster-test   # isolated profile, keeps your own chats safe
```

The few Muster core modules the app bundles are vendored in `packages/agent-app/vendor/`; do not edit
them by hand (see `vendor/README.md`, fix them in musterhq/muster and run `npm run vendor:sync`).

The Muster Code IDE layer uses pnpm 10 and Node 22 from the repository root:
`pnpm install && pnpm typecheck && pnpm build && pnpm test`.

## Build, typecheck and test

From `packages/agent-app`:

```sh
npx tsc --noEmit          # typecheck (npm run typecheck)
npm run build             # bundle main, preload and renderer into dist/
npm test                  # unit tests (node --test tests/*.test.ts); build first, some load dist/
npm run test:renderer     # renderer tests
```

CI runs exactly these on every pull request (macOS, plus Windows and Linux packaging with a packaged-app
smoke test). Run them locally before you push. For UI changes, also run the app and try the change.

## Branches and pull requests

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Fork (or branch, if you have access) from the latest `main`. Name branches `type/short-topic`,
   for example `fix/terminal-resize`.
3. Keep PRs small and focused: one concern per PR, tests in the same PR.
4. Fill in the pull request template: summary, how you tested, screenshots for any UI change.
5. `main` requires a pull request and passing checks (see [docs/BRANCH_PROTECTION.md](docs/BRANCH_PROTECTION.md)).
   A maintainer reviews and merges.

## Commit style

Short imperative subject, at most about 72 characters, in the style of the existing history
("Fix model picker overflow", "Windows: terminals get the Windows environment"). Explain the why in the
body when it is not obvious. Reference issues with `Fixes #123` or `Refs #123`.

## Releases

Muster Agent releases are cut by maintainers:

1. Bump `version` in `packages/agent-app/package.json` and add a `## <version>` section to
   `packages/agent-app/CHANGELOG.md` (it becomes the release notes).
2. Tag and push: `git tag agent-v<version> && git push origin agent-v<version>`
   (`agent-v0.3.0-beta.1` publishes a prerelease on the beta channel).
3. `.github/workflows/agent-app-release.yml` builds macOS, Windows and Linux, and publishes the GitHub
   Release with checksums. Details: `packages/agent-app/docs/RELEASE.md`.

The IDE's `release.yml` only reacts to `v*` tags, so the two products never trigger each other.
Please do not bump versions or add tags in a regular PR.

## Good first contributions

- Platform fixes: Windows and Linux behavior (terminals, paths, packaging, the updater), macOS polish.
- Providers: detection and health checks for more model providers, gateways and local servers.
- UI: accessibility, keyboard navigation, layout at small window sizes, empty and error states.
- Tests for anything under `packages/agent-app/tests`, and docs or screenshot fixes.

Look for the `good first issue` and `help wanted` labels. Issues are labelled by area
(`area:app`, `area:providers`, `area:sandbox`, `area:memory`, `area:projects`, `area:updater`, `area:ui`),
type (`type:bug`, `type:feature`, `type:docs`, `type:chore`) and platform (`platform:macos`, `platform:windows`,
`platform:linux`).

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
