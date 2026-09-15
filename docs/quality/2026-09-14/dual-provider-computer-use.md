# Dual-provider selection and computer-use boundary

## Live Hybrow Routing Verification

On 14 September 2026, the coordinator created a separate empty chat through the
installed native UI, selected Hybrow Codex Terra at Medium effort, and sent one
harmless request to reply only `ROUTE_OK` without using tools or reading files.
The UI returned `ROUTE_OK` and showed Complete in approximately six seconds.
The existing conversation and unsent draft were not overwritten.

Independent read-only session verification found exactly one matching session:

- Thread: `01a0a0e9-0fce-7452-974e-9ce252a95708`.
- Turn: `01a0a0e9-10a5-78d0-8bba-a73815cc80ed`.
- Recorded provider: `hybrow`.
- Recorded model: `codex/gpt-5.6-terra`.
- Outcome: `task_complete`; no failure event or request ID found.
- Installed launcher binds `hybrow-gateway.config.toml` and validates the
  Responses endpoint `https://router.hybrowlabs.com/v1`.

This supersedes the earlier unverified native picker/live-inference statements
for this one Hybrow Terra path. It is not a test of every listed model, browser
tools, resumed tasks, authoritative billing, or full desktop computer use.
The gateway's final upstream account/model fallback is not observable in this
local evidence. Do not interpret the reply's contents as model-identity proof.

## Later Deployment Checkpoint: Green Restoration

Subsequent picker repair: the shared model menu is now a direct child of the
document body, outside the glass composer's fixed-position containing block.
Placement measures the menu, chooses available space above/below, clamps it to
the viewport and allows internal scrolling. This addresses the native symptom
where only the first Direct options were visible and Hybrow fell below the
window. Focused placement/fixture tests passed (22); the subsequent structural
regression test file passed (21); typecheck passed. These overlapping counts
must not be summed. The canonical app was updated while stopped, with a signed
recovery copy retained in the same Trash directory below. Current extension
SHA-256 is `47532ec3c7609c773a92fcdadda491f568ea1578f5676ac873720599a40b592c`.
The prior hash below describes the green-restoration checkpoint only.
The coordinator verified the repaired menu in the browser fixture: it opens
above the composer and all five Hybrow options are visible within the viewport.
The native app reopened and remained running with no new crash report; the
computer-use connection returned `noWindowsAvailable` during the final native
menu interaction, so that final interactive check remains unverified. The
fixture explicitly says "Offline preview: no model requests" and does not
establish live inference or billing behavior.

On 14 September 2026 the combined current source was assembled and promoted to
`dist/Muster Code.app`. This supersedes the earlier not-installed checkpoint
below, not its limitations on native desktop computer use or live inference.

- Restored the original forest-green/sage `Muster Dark` default while retaining
  all five themes and explicit saved theme preferences.
- Worker validation: 107 tests passed, 4 skipped; builtin typecheck passed.
- A stale packaged theme manifest was caught and repaired before promotion.
  Coordinator verified source/generated/packaged default and all five themes,
  matching built/staged extension SHA-256, and deep strict code signature.
- Extension SHA-256: `04ef4fcaadfa1331a3a5c2ecb61a4febce9a36e5cf7f3c2b7cc1790026208fe2`.
- Native app opened successfully at the canonical path. Its actual model picker
  displayed OpenAI Direct and Hybrow OmniRoute, including Codex Terra/Luna/Sol/
  Astra and Hybrow Claude Fable. Existing conversation and unsent draft remained
  visible; no model selection was changed and no prompt was submitted.
- The green offline fixture rendered readable chat/composer/diff surfaces;
  message expansion worked. This is not an exhaustive visual regression pass.
- Five obsolete bundles were moved recoverably to
  `/Users/dhairya/.Trash/Muster-Code-bundles-20260914-20260914-222152/`.
  The old canonical is `canonical-old - Muster Code.app` in that directory.
  No profile or credential files were moved. Only one application remains in
  the repository's `dist` tree.
- Additional older visual elements remain unspecified by the user. Do not
  revert backend features or guess at layout removals. Live provider inference,
  provider billing attribution, and full native desktop control are not newly
  verified by this deployment.

## User intent

Retain separately identifiable OpenAI Direct and Hybrow connections in Muster
Code. A selection must change the actual provider/model dispatch, not only a
model label. Preserve browser tools, approvals, existing tasks and user changes.
This work targets Muster Code, not the signed ChatGPT desktop application.

## Computer-use answer

Not all computer-use capabilities from the ChatGPT/Codex app transfer to Muster.

| Capability | Evidence and current boundary |
| --- | --- |
| Muster browser automation | Implemented MCP bridge exposes navigation, snapshots, clicks, typing, screenshots, console inspection, evaluation and tabs. Source wiring exists; the new provider integration still needs its own verification. |
| Codex file and shell tools | Supplied by the existing Codex app-server integration, subject to the selected permissions. |
| Full native macOS desktop control | Not implemented or verified in Muster through a supported bridge. A browser screenshot is not desktop-control parity. |
| Existing Codex computer-use plugin | Host-specific availability must be checked; sharing Codex configuration alone is not proof that the first-party host tools are usable from Muster. |
| OMP computer use | Not part of this implementation. |

The existing audit in `../2026-09-13/host-capabilities.md` identified private
native authorization/IPC boundaries. Do not copy host credentials, spoof a host
identity, connect directly to private CUA IPC, or claim full desktop support from
the presence of installed binaries.

## Source evidence

- `packages/builtin/src/browser-mcp.ts`: browser tool schemas and socket bridge.
- `packages/builtin/src/browser-tools.ts`: browser command implementation and
  user-take-control behavior.
- `packages/builtin/src/extension.ts`: registration of BrowserToolServer and
  setBrowserMcp wiring.
- `packages/builtin/src/codex.ts`: browser MCP overrides on Codex turns.

The installed app-server schema separately exposes `modelProvider` on
`thread/start` and `thread/resume`. Its `turn/start` accepts a model override but
does not expose a provider override. Routing therefore needs deliberate task
ownership/resume handling; changing a model ID alone is insufficient.

## Acceptance boundaries

1. Keep provider identity with the selected model and persisted task.
2. Never send gateway-prefixed IDs to the direct OpenAI provider.
3. Reject mismatches and missing routing configuration rather than silently
   falling back to another provider or billing account.
4. Preserve browser MCP and approval overrides on both provider paths.
5. Verify new, resumed, legacy, busy and failed tasks, not only dropdown labels.
6. Clearly distinguish routing attribution from authoritative billing records.
   A direct parent with Hybrow children has mixed usage.
7. Treat automated source tests, extension build and native app smoke tests as
   separate evidence. The existing Terra handoff records an unresolved QA
   startup crash; do not overwrite or restart a running app as a workaround.

No native CUA parity, packaged-app deployment or successful live gateway browser
session is claimed by this audit.

## Implementation checkpoint

The source patch now groups the Agent-pane picker into OpenAI Direct and Hybrow
OmniRoute, and shows the provider beside the selected model. Provider-qualified
IDs are translated to native model IDs before dispatch. Existing Claude Code
configuration is retained separately.

Each provider uses its own launcher and catalog cache. Launchers read the
existing owner-managed profile, validate allowed configuration references, and
set the actual provider when starting/resuming a task. They do not pass
`--profile` to `app-server`, which the installed CLI does not support. Auth stays
with the existing helper; no key is embedded in the extension.

Task persistence and busy-task guards retain provider identity. Switching to a
different provider requires a new task once a backend thread exists. Browser
MCP overrides, approvals and provider-configured Luna subagents are preserved.

Worker verification (commands run from `packages/builtin`):

- `pnpm typecheck`: passed.
- `pnpm build`: passed; built extension is in `packages/builtin/dist-ext`.
- `git diff --check`: passed.
- `MUSTER_PROVIDER_SMOKE=1 node --test --import tsx test/provider-*.test.ts`:
  17/17 passed, including four real initialize/config-read checks across source
  and built Direct/Hybrow launchers. No model inference or task was started.
- Earlier focused checks: 30/30 passed, including pane rendering, dispatch,
  busy-state, failed-task, reload/resume and cache tests. These overlap the
  provider suite and must not be added together as a unique-test count.

Independent review found no actionable defects in the frozen routing, launcher,
profile helper, cache, build/resource paths and associated tests; source and
bundled resources match. Native app launch, live model inference, native thread
resume and gateway-driven browser actions remain
unverified. The known QA startup crash is not fixed by this patch. Nothing was
assembled into an app, installed, restarted, committed or deployed.
