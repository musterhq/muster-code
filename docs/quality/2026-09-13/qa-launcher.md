# Disposable native QA launcher · 13 September 2026

Use `scripts/dev/launch-qa.sh` only with a frozen staged app bundle and an explicitly disposable workspace/profile:

```sh
scripts/dev/launch-qa.sh \
  'dist/verified/Muster Code.app' \
  /tmp/muster-qa-workspace \
  /tmp/muster-qa-profile \
  '/tmp/Muster Code QA.app'
```

The workspace must already exist, and the profile must be new. The launcher preserves the caller's absolute workspace spelling for the CLI (so `/tmp/...` remains `/tmp/...`), while using `realpath` only for root-path safety checks. It refuses a missing workspace, root workspace/profile paths, an existing profile, the source bundle as the destination, or an existing QA destination. It does not remove, kill, or modify any installed/running app or any user path. To rerun, choose a new disposable destination/profile or remove the explicitly named QA copy through a separate operator action.

The script copies the staged app with `ditto` and preserves its root/helper bundle IDs, CFBundle names, `product.json` application/data-folder identity, signatures, helper executables, and runtime resources. It compares those critical files byte-for-byte against the source and runs strict deep code-sign verification on the copy before proceeding. The copied app remains the same product identity and visible name; its unique filesystem path, fresh profile, and disposable workspace provide isolation without rewriting provider identity or re-signing.

It launches through the copied app's real CLI at `Contents/Resources/app/bin/muster-code` with `--new-window --user-data-dir <qa-profile> <qa-workspace>`. `--new-window` and the fresh profile/workspace scope the invocation to the explicit disposable paths while leaving product identity unchanged. For copy-only validation, set `MUSTER_QA_VALIDATE_ONLY=1`; this runs the byte and signature checkpoints and exits without launching.

Validation performed without launching: `zsh -n scripts/dev/launch-qa.sh`, `MUSTER_QA_VALIDATE_ONLY=1` copy/checkpoint validation, usage-path check, and `git diff --check`. Native QA must use a fresh disposable profile/workspace and a new copy path such as `/tmp/muster-qa-20260913-*`.
