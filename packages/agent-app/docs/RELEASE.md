# Muster Agent release lifecycle (PER-09)

## Publishing a release (GitHub)

1. Bump `version` in `packages/agent-app/package.json` and add a `## <version>` section to
   `CHANGELOG.md` (it becomes the release notes; without one GitHub generates them).
2. Tag and push: `git tag agent-v<version> && git push origin agent-v<version>`
   (`agent-v<version>-beta.1` style tags publish a prerelease on the beta channel).
   Or run **Muster Agent Release** from the Actions tab with an existing tag.
3. `.github/workflows/agent-app-release.yml` builds on `macos-15` (arm64) and `macos-15-intel` (x64):
   `npm ci`, typecheck, unit and renderer tests, then `scripts/package-release.mjs`. It publishes the
   GitHub Release "Muster Agent <version>" with `Muster-Agent-<version>-{arm64,x64}.{dmg,zip}` and
   `SHA256SUMS`. The IDE's `release.yml` reacts only to `v*` tags.

Signing is chosen from repository secrets (never printed; the PKCS#12 goes into a throwaway keychain
that is deleted at the end of the job):

| Mode | Secrets | Result |
| --- | --- | --- |
| Developer ID + notarization | `MUSTER_SIGN_IDENTITY`, `MUSTER_SIGN_P12_BASE64`, `MUSTER_SIGN_P12_PASSWORD`, `MUSTER_NOTARY_APPLE_ID`, `MUSTER_NOTARY_TEAM_ID`, `MUSTER_NOTARY_PASSWORD` (app-specific password) | Opens normally; full release |
| Self-signed | `MUSTER_SELF_SIGN_P12_BASE64`, `MUSTER_SELF_SIGN_P12_PASSWORD` (identity "Muster Agent Self-Signed") | Stable identity (macOS keeps granted permissions across updates), not notarized; prerelease |
| Ad hoc | none | Not notarized; prerelease |

Unnotarized builds need right-click > Open the first time, or
`xattr -dr com.apple.quarantine "/Applications/Muster Agent.app"`.

Locally, `node scripts/package-release.mjs` does the same for this Mac's architecture into
`release-dist/`. `MUSTER_SIGN_P12=<file.p12> MUSTER_SIGN_P12_PASSWORD_FILE=<file>` signs with a
PKCS#12 through a temporary keychain (never the login keychain). Self-signed builds use
`scripts/macos/entitlements-self-signed.plist`, which adds `disable-library-validation` because a
self-signed certificate has no Team ID.

## Build and package

```sh
npm run build
node scripts/package-preview.mjs          # release/Muster Agent Preview.app
```

The packager sets the bundle identity (`dev.themuster.agent.preview`, version from
`package.json`), strips Electron's App Transport Security exception and sample app,
ships only built files (no source maps, no tests) and writes the update channel into
`Info.plist`.

## Signing and notarization

No credentials live in this repository. The packager reads two optional
environment variables and uses the macOS keychain for everything secret.

| Variable | Meaning |
| --- | --- |
| `MUSTER_SIGN_IDENTITY` | A Developer ID Application identity in the login keychain, for example `Developer ID Application: Example Ltd (TEAMID)`. Enables the hardened runtime (`--options runtime`), secure timestamps and `scripts/macos/entitlements.plist`. |
| `MUSTER_NOTARY_PROFILE` | The name of a notarytool keychain profile. Requires `MUSTER_SIGN_IDENTITY`. |

One-time setup on the release machine:

```sh
xcrun notarytool store-credentials muster-notary \
  --apple-id <apple-id> --team-id <TEAMID>    # prompts for an app-specific password, stored in the keychain
```

Release build:

```sh
MUSTER_SIGN_IDENTITY="Developer ID Application: Example Ltd (TEAMID)" \
MUSTER_NOTARY_PROFILE=muster-notary \
MUSTER_UPDATE_CHANNEL=stable \
node scripts/package-preview.mjs
```

Signing goes inside out: node-pty's `spawn-helper` and `pty.node`, each Electron
framework and helper app, and then the bundle. `codesign --verify --deep --strict`
must pass. With a notary profile the app is zipped, submitted with
`notarytool submit --wait`, stapled, and checked with `spctl --assess`.
Without a signing identity the build is ad hoc signed and runs only on the build machine.

Entitlements (`scripts/macos/entitlements.plist`) are limited to what Electron's
V8 needs: `allow-jit` and `allow-unsigned-executable-memory`. Library validation stays
on because every native binary is signed with the same identity.

## Update channels

`src/main/update-channel.ts` defines the channels `stable`, `beta` and `preview`.

- The build's channel comes from `MUSTER_UPDATE_CHANNEL` at package time (`Info.plist`
  key `MusterUpdateChannel`, default `preview`). A user choice overrides it.
- A feed is optional. With `MUSTER_UPDATE_BASE_URL` (HTTPS, no credentials) the
  manifest for a build is `<base>/<channel>/<platform>-<arch>/latest.json`:

  ```json
  {"channel":"stable","version":"0.3.0","url":"https://…/Muster-Agent-0.3.0-arm64.zip","sha256":"<64 hex>","notes":"…"}
  ```

- Without a feed URL the app makes no update request. A manifest is accepted only
  for the build's channel, over HTTPS, with a SHA-256 for the download.

## Upgrade and rollback (PER-08)

`src/runtime/schema-migrations.ts` versions the SQLite schema with `PRAGMA user_version`.
Opening an older database first writes a consistent copy (`VACUUM INTO`) to
`<userData>/agent-data/backups/muster-agent.sqlite.v<from>.<timestamp>.bak` (the newest
three are kept). Each step then runs in its own transaction, so a failed step rolls
back to the last good version and the error names the backup. A database written by
a newer app is left untouched. To roll back after a bad upgrade, quit the app and
call `restoreSchemaBackup(dbPath, backupPath)`. It moves the current database and its
WAL aside as `.rolled-back` and puts the backup in place.

Settings imports keep their own pre-import backup (`settings.import`).

## Dependencies and licenses (PER-10)

`node scripts/dependency-report.mjs` (after `npm run build`) writes:

- `dist/renderer/THIRD-PARTY-LICENSES.txt`: the full license text of every
  package bundled into the renderer, main process and runtime, plus the adapted
  sources in `licenses/`. The packager ships it inside the app.
- `perf/dependency-sizes.json`: bundled bytes per dependency and per output. Commit
  it with any dependency change, so reviewers can see the size and startup cost.

The build removes renderer outputs that the current build did not produce, such as
Shiki grammar and theme chunks from older builds, so packaging never ships them.
