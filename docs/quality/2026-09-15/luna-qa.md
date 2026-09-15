# Luna QA — 2026-09-15

## Outcome

Unit verification passed. The disposable QA bundle assembled successfully, but the
fresh-profile launch did not leave a visible Muster Code process or window after
startup, so native GUI checks were blocked.

## Build

- Build path: `dist/integration-20260915b/Muster Code.app`
- QA copy: `/tmp/Muster Code QA 20260915.app`
- Bundle identifier: `dev.themuster.code`
- Bundle version: `1.126.04524`
- QA workspace: `/tmp/muster-qa-20260915-workspace`
- QA profile: `/tmp/muster-qa-20260915-profile`
- Launch output: `/tmp/muster-qa-20260915.stdout`
- Launch errors: `/tmp/muster-qa-20260915.stderr` (empty)

## Verification commands

1. `pnpm --filter @muster-code/builtin typecheck` — PASS.
2. `cd packages/builtin && node --test --import tsx test/*.test.ts` — PASS:
   134 passed, 0 failed, 4 skipped.
   The first sandboxed attempt hit the known `/tmp/.git/hooks` operation-permitted
   restriction; the mandated retry outside the sandbox passed.
3. `MUSTER_CODE_DIST="$ROOT/dist/integration-20260915" zsh scripts/assemble.sh` —
   blocked by sandbox filesystem permissions while unpacking the base bundle.
4. `MUSTER_CODE_DIST="$ROOT/dist/integration-20260915b" zsh scripts/assemble.sh` —
   PASS; ad-hoc signing completed.
5. `zsh scripts/dev/launch-qa.sh ...` — copied and invoked the QA bundle, but no
   visible application window remained after startup.

## Screenshots

Existing offline Graphite evidence was confirmed and not regenerated:

- `docs/quality/2026-09-15/evidence/graphite-agents-720.png`
- `docs/quality/2026-09-15/evidence/graphite-stress-720.png`

## Native checks

Not verified because the QA app did not remain open:

- Graphite appearance in the fresh profile.
- Luna streaming markdown prompt with heading, three-row table, and fenced
  TypeScript block.
- Slash-command name readability.
- Luna computer-use prompt listing open applications.
- Computer-use permission-dialog behavior.

No new crash report appeared for this launch. Existing Muster diagnostic reports
were older than the QA run; no crash path can be attributed to this attempt.
