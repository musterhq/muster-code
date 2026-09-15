# Release pipeline

## Day-to-day

Every push to `main` runs **CI** (`.github/workflows/ci.yml`): typecheck, build, webview script checks, and tests.

## Shipping a version

1. Bump `version` in the root `package.json` (and commit on `main`).
2. Tag and push:

```bash
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

3. **Release** (`.github/workflows/release.yml`) runs on `macos-latest`:
   - Verifies the tree (same gates as CI)
   - Runs `scripts/package.sh` (assemble → zip → dmg; signs/notarizes when GitHub secrets are set)
   - Opens a GitHub Release with:
     - **Auto-generated notes** from merged PRs (`generate_release_notes`)
     - A **commit list** since the previous tag (custom body in the workflow)

### Optional signing secrets

Set in the repo **Settings → Secrets and variables → Actions**:

| Secret | Purpose |
|--------|---------|
| `MUSTER_SIGN_IDENTITY` | `Developer ID Application: … (TEAMID)` |
| `MUSTER_NOTARY_PROFILE` | Keychain profile from `xcrun notarytool store-credentials` |

Without these, CI still produces ad-hoc signed artifacts (fine for internal QA, blocked by Gatekeeper elsewhere).

### Re-run a tag manually

**Actions → Release → Run workflow** and pass an existing tag (e.g. `v0.2.0`).
