# Muster Agent release lifecycle (PER-09)

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
