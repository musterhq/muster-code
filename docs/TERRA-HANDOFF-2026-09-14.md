# Muster Code — authoritative Terra handoff

Prepared by the outgoing coordinator on 14 September 2026, after the user explicitly stopped implementation and requested this handoff. This is a continuation package, not a completion report.

**Start here. Do not reread the whole conversation or all historical documents.** Read sections 1–5 for state, sections 21–24 for the complete product and finish standard, and section 25 for preserving the existing agents. A worker should then read only its assigned lane. Use the prompt in section 18 for a new coordinator or section 25 to continue the same task with the same agents. For transcript, composer, motion, and computer/browser polish, read section 28 and `docs/quality/2026-09-15/interaction-atlas.md` instead of re-researching Cursor, Codex, or T3 Code.

## Current visual default — Graphite, not green

The user (15 September 2026) said the green IDE color is bothering them. This
supersedes the 14 September forest-green restoration override. Default product
theme is **Muster Graphite** (charcoal + lavender). Muster Dark (sage) remains
selectable. Do not restore green as the default. Keep all five palettes.
Preserve newer backend features (provider routing, task state, orchestration,
browser tools, inline diffs, computer-use plugin path).

The owner also asked that chat interaction/visualization/movement match Cursor,
and that Muster use Codex computer-use through the signed-in bundled plugin
(not a private CUA socket). Native QA of those flows must use **Luna**.

This records intent. It is not proof of a rebuilt/installed app.

## 1. What the user is actually building

Muster Code is intended to replace the user's daily Codex and Cursor workflow with one polished, lightweight, IDE-native application. It must support reading and editing code as well as supervising agents. It is not intended to be a terminal dashboard, a cosmetic VS Code skin, or merely a chat sidebar with inline diffs.

The desired daily workflow is:

1. Open one unmistakably current Muster application and choose a project.
2. Find a file, task, symbol, command, or setting without digging through menus.
3. Write a prompt and attach files, folders, selections, and browser context. The draft and attachments survive switching tasks and reloads.
4. Run several named tasks concurrently from IDE panels. See each task's state, model, workspace, messages, changes, and subagents.
5. Inspect parent-to-child instructions and child-to-parent responses as they arrive. Steer, stop, open, and review the correct agent.
6. Keep the full file and realtime inline diff visible when wanted. Attribute changes to the correct task/workspace. Preserve complete changes even when a compact preview is truncated.
7. Switch between focused work, task overview, browser inspection, and review without losing reading position or context.
8. Review and integrate work explicitly; handle conflicting changes honestly. No silent overwrite, replay, or merge.
9. Eventually use supported account-backed voice and computer use from Muster, without requiring additional API keys merely to reproduce the user's current Codex workflow.

The user permits a significant redesign. Preserve the working editor/diff/runtime capabilities while changing the surrounding interaction model. Do not confuse permission to redesign with permission to regress existing features.

**Explicit visual requirement: Liquid Glass.** The user repeatedly requested a Mac-like Liquid Glass finish, not merely a recolored VS Code interface or opaque cards with a blur property. This requirement must remain in the design brief, implementation roadmap and visual acceptance criteria. Read section 27 for its exact scope, component expectations and performance/accessibility gates. It is not currently implemented as native Liquid Glass.

### Why this product should exist

The intended advantage is less coordination friction: durable context, comprehensible parallel tasks, clear agent messages and change ownership, accessible review, and simple everyday controls. A different color palette is insufficient. Claims of lower memory, faster interaction, or greater reliability require measurements against a defined workload.

## 2. Latest user instructions and precedence

These excerpts are verbatim from the user; the operational interpretation follows each group.

> "realtime inline diff should not be affected"

> "the full file inline diff feature should not break"

> "the working features should become production grade not regress"

Realtime and full-file diff behavior are protected release gates. Do not remove functionality to make a test pass or a screen look cleaner.

> "I do not like the green theme"

> "Maintain multiple customizable themes for this particular app"

Graphite/charcoal with violet accents is the current default direction. Keep multiple customizable themes. Optional sage and semantic red/green diff colors are different from making the whole product green.

> "the tool usage and 99% work should be luna based your work is looking over their shoulders like their manager every tool can everything you ask them to make because it is then cheaper for me"

> "you can have a swarm of luna and Terra and sol agents based on the changes logical reasoning and complexity"

> "because you are too expensive I will be working with terra agents"

Use Terra as the next coordinator/engineering lead. Delegate most research, implementation, builds, commands, tests, and GUI work to bounded Luna/Terra workers. Sol is available for a difficult design or independent review. Do not keep Astra as the default implementation engine. Model tiers are a practical allocation policy, not a proven universal price/performance ranking.

> "no need to use orca skill"

> "do not check usage until I ask or keep a poll which will be less expensive on my usage because you using that tool is also expensive for me"

The adopted choice was **no usage checks and no polling**. Do not call quota tools, create a usage automation, or redeem reset credits. The earlier request to watch weekly usage is superseded. The earlier instruction to use Orca was also superseded. Do not restart that workflow or change the user's default provider/auth configuration.

> "There should not be any repetitive work."

> "There should not be any rework."

> "If the check passes then you can move on to the next one"

> "Any questions that you might have should be asked mid-conversation."

Retain valid evidence and rerun only affected checks. A precise repair after a discovered defect is necessary; speculative redesigns, duplicate implementations, unchanged retries, and rerunning broad suites after every edit are not. Ask a necessary question while independent work continues; do not save blockers for the end.

> "I do not need terminal based but the IDE based only but multiple thread working concurrent file changing and keeping the file diffs and stuff like that with names of those threads maintaining subagents like I am through you right now the way they are able to message you here"

The final concurrency UX must be IDE-native and task-aware. Separate worktree windows are an interim isolation mechanism, not the final requested experience. Terminal tools can exist, but must not be the main agent-management interface.

Other accepted preferences:

- Elegant, product-friendly, Mac-like controls, transitions, material surfaces, and shortcuts.
- Word wrap and common display/review controls should be easy to discover.
- Full diffs should stay open for this user when requested; allow other users to collapse them.
- Transparency means visible actions, tools, states, messages and reviewable changes. It does not require a large permanent token dashboard or invented access to hidden reasoning.
- A large activity metrics panel was rejected. Keep current action/status/elapsed compact; make usage details optional.
- Context chips and Add Context must align and wrap correctly.
- No recursive agents, competing GUI controllers, unnecessary tools/plugins, or silent downgrade of acceptance standards.

### Historical instructions that must not be revived

`docs/HANDOFF.md` contains old instructions to replicate Cursor exactly. That is historical and superseded by this document. Some lane notes still say the parent owns GUI QA; the latest instruction delegates GUI testing to a worker and leaves the coordinator reviewing evidence. Old usage percentages are historical observations, not permission to fetch new ones.

## 3. Repository and interrupted-state checkpoint

### Exact locations

IDE repository:

`/Users/dhairya/Documents/Codex/2026-04-23-openclaw-docs-live-users-pavankumarmarwaha-codex/muster-code`

Sibling runtime repository:

`/Users/dhairya/Documents/Codex/2026-04-23-openclaw-docs-live-users-pavankumarmarwaha-codex/muster`

At handoff preparation, both branches were **`main`**:

| Repository | HEAD observed | Working changes |
|---|---|---|
| muster-code | `4482bd8` — docs: deep gap analysis vs Cursor 3.18.25 | Many modified and untracked implementation, test, theme and QA files |
| muster | `5de4eae` — claude: --mcp-config passthrough for host MCP servers | `packages/core/src/codex-app-server.ts` and `packages/core/test/codex.test.ts` |

No new commit or merge is claimed for this session. Most work is **uncommitted**, including important new files. Do not reset, clean, stash indiscriminately, checkout over the changes, or replace them with default-branch files. The user's reference to a dev/UI branch expresses the desired integration destination; it does not prove such a branch currently exists. Verify before switching branches. Staying in the current checkout while preserving work is preferable to an unsafe branch move.

All three direct collaboration agents were reported **interrupted** after the user stopped the previous turn:

- `/root/browser`: navigation, integration, packaging, memory baseline, then P0 startup crash diagnosis.
- `/root/frontend`: chat/UI polish and GUI QA, then task-workspace UI.
- `/root/runtime`: core/ownership, workspace hub, then task runtime isolation.

Do not resume these agents automatically while producing or reading the handoff. In a new session, assign new bounded work only after checking the relevant files. Interrupted shell commands may have finished or left child processes; inspect a specific task-owned process only when it matters. Never infer that an absent status means an agent or process is dead.

### Architecture to understand before editing

- Code-OSS/VSCodium ARM64 base, version `1.126.04524`, assembled into a branded Electron application.
- `packages/builtin`: TypeScript extension host and HTML/JavaScript webviews.
- `packages/theme`: five palettes and a Lucide-derived product icon theme.
- `product/muster-inline-diff.js`: injected workbench contribution for full-file realtime diff presentation.
- `product/muster-browser-main.js`: Electron browser integration.
- `product/muster-workbench.css`: native workbench styling.
- `scripts/assemble.sh` and `scripts/patch-workbench.py`: packaging and explicit workbench patch seams.
- `@musterhq/core` is linked from the sibling repository. The extension bundle consumes core's **dist** output. Rebuild core after core source changes before bundling the IDE.
- The normal provider boundary is the installed Codex app-server over JSON-RPC/stdio, using the existing account authentication. Do not introduce a second provider/auth path without a concrete need.

Protected engine files include `live-edit.ts`, `apply-patch.ts`, `line-diff.ts`, and `unified-diff.ts`. They were intentionally left largely untouched; tests were added. The workbench diff contribution has limited review-wording changes and also contains browser/header plumbing, so do not treat it as disposable CSS.

## 4. Stop-ship blocker: the current native QA app crashes

**Fix this before calling the app usable, production-ready, or native-QA complete.**

Observed local reports include:

- `/Users/dhairya/Library/Logs/DiagnosticReports/Muster Code-2026-09-14-124708.ips`
- `/Users/dhairya/Library/Logs/DiagnosticReports/Muster Code-2026-09-14-125158.ips`

The latter identifies:

- Process under `/private/tmp/Muster Code Current QA 20260914b.app/Contents/MacOS/Muster Code`.
- Version `1.126.04524`, bundle ID `dev.themuster.code.qa`.
- `EXC_BREAKPOINT/SIGTRAP`, signal code 5, main thread.
- Repeated symbolized frames around `v8::ValueSerializer::Delegate::GetWasmModuleTransferId`, `node::PrincipalRealm::timers_callback_function`, `ElectronMain`, and `start`.

**Root cause is unknown.** These may be nearest exported symbols in stripped native binaries. Absence of a JavaScript frame is not proof that a main-process JavaScript call could not trigger a native assertion.

Already checked/rejected as sufficient explanations:

- Deep strict codesign verification passed.
- Source and QA copies had matching ad-hoc/no-entitlement status. The proposed simple 'QA lost JIT entitlements' explanation was not supported by that comparison.
- Changing QA product/application/data identity did not resolve the crash.
- Merely renaming/rebuilding the QA app is not a fix.

The last authorized diagnostic task was interrupted before a new result was delivered:

1. Inspect existing application-specific diagnostic fields and captured stdout/stderr for a fatal/assertion message.
2. Compare the working build, integration build and QA copy's native executable/framework hashes, Info.plist, product identity and bootstrap differences.
3. If existing evidence is insufficient, do **one observed failing startup reproduction** through the documented launcher/CLI, with stdout/stderr saved locally.
4. Change one evidence-backed cause and verify it. Do not cycle through GPU/sandbox/profile flags without a diagnosis.

No crash report should be sent to Apple or another service as part of this task unless the user explicitly authorizes that transmission. Read local reports. Do not repeatedly click Reopen or let an automated loop generate crash dialogs.

### Artifacts — do not confuse them

| Path | Meaning |
|---|---|
| `dist/Muster Code.app` | Older release-style build; was running at the memory measurement; not current source |
| `dist/verified/Muster Code.app` | Older intermediate build, frequently mistaken for current |
| `dist/integration-20260913/Muster Code.app` | Earlier integration snapshot |
| `dist/integration-20260914/Muster Code.app` | Newer assembled/signed integration snapshot; not proven to include final interrupted task-workspace changes |
| `/tmp/Muster Code QA 20260914.app` | Earlier disposable QA copy; crashed |
| `/tmp/Muster Code Current QA 20260914b.app` | Renamed/latest observed QA copy; also crashed |

Associated disposable locations include `/tmp/muster-qa-20260914-profile`, `/tmp/muster-qa-20260914-workspace`, `/tmp/muster-qa-current-20260914-profile-b`, and `/tmp/muster-qa-current-20260914-workspace-b`.

The older scratch repository `/tmp/muster-qa-20260913` contains useful prepared fixtures: README marker `MAPLE-47`, `fixtures/notes with spaces.md` marker `ORBIT-29`, and `fixtures/full-file.ts` with 500 exported values. Inspect existence before using it; do not recreate tests in a user project.

At one checkpoint the extension bundle hash was MD5 `f4164fec91ada154aab9e641bf6d3959`. This identifies that snapshot only; it is not a security guarantee or proof of current source equality.

The user saw four identical Muster names/icons in Spotlight and opened older copies. After the crash is fixed, provide one clearly named current preview/launcher with a visible build identifier. Preserve older artifacts and user data. Do not mass-edit LaunchServices or delete old bundles merely to tidy search results.

## 5. Implemented work and its real verification level

| Area | Source implementation | Evidence / remaining limit |
|---|---|---|
| Durable chat/run state | `conversation-state.ts`, `agent-pane.ts`, `codex.ts` | Bounded transcript/activity/usage/context and explicit disconnected/interrupted states; automated checks passed in earlier batch; final native recovery gate open |
| Context retention | `context.ts`, pane/view/polish | References retained; duplicate expansion reduced; metadata and truncation visible; browser fixture removal/reload verified; real file/folder/provider flow not fully certified |
| Readability | `agent-view.ts`, `agent-polish.ts` | Long messages, expansion, follow-at-tail, jump-to-latest and bounded inspectors; fixture checks passed |
| Context alignment | `agent-polish.ts` | Add Context and chips use common 24px controls; wide/narrow browser checks passed |
| Activity presentation | `agent-polish.ts` | Compact action/status/elapsed; token metrics behind Usage details; duplicate model metric and verbose main-flow copy removed |
| Draft write efficiency | `agent-polish.ts` | Duplicate unchanged draft posts suppressed; actual text/context changes still saved; do not assume all persistence paths are now optimal |
| Themes/materials | appearance/settings/themes/polish | Five palettes; Graphite/violet default; opt-in CSS glass with solid accessibility fallbacks; no native Liquid Glass bridge |
| Provider approvals | pane/core adapter | Correct ownership/scoped requests; review versus permission distinction improved; genuine approvals preserved; final Full Access native test open |
| Shared edit lease | `edit-lease.ts`, pane | Parent/descendant lifetime, queued writes and owner-close guard implemented/tested; does not isolate arbitrary native child shell writes |
| Browser navigation | browser modules and main-process browser patch | Generations, timeouts, waiters, redirects/errors/stale events hardened with behavioral tests; native browser-to-source end-to-end gate open |
| Browser context | context/browser modules | Immutable saved selections and inspectable references; native capture-to-provider proof incomplete |
| Agent graph | `agent-orchestration.ts`, `agent-control.ts` | Native collab event graph, messages, changes, capabilities and controls; producer-to-consumer tests improved; live full delegation flow unverified |
| Child patch receipts | graph/polish | Node-local `changeRecords`, escaped diffs, task/turn/item/path identity, missing/truncated states, expansion persistence |
| Parent/child event isolation | sibling `codex-app-server.ts` | Parent text/usage/failure isolation; persistent post-parent child observer/approvals; targeted tests reported passed |
| Task catalog | `thread-catalog.ts`, pane/codex | Search/pagination/pin/rename/archive/fork/read/continue, cwd identity, cold safe management; automated tests passed |
| Managed terminals | terminal modules | Usable commands/output/search/task association; supplementary capability, not final agent-management UX |
| Go To | `navigation.ts`, extension/manifest | Files/commands/symbols/lines/tasks/terminals/browser/review/appearance/wrap/workspaces; Cmd+Alt+G or Ctrl+Alt+G; Cmd+P/Cmd+K protected; focused tests passed |
| Worktree hub | `workspace-registry.ts`, `workspace-hub.ts` | Native Git list/create/open; detached explicit-ref worktree, no merge/delete/agent auto-start; opens new window; registry/host tests passed |
| Concurrent task runtime | `task-runtime-registry.ts` | **Interrupted partial implementation. Not proven integrated or safe to enable.** |
| IDE task grid/splits | `task-workspace-view.ts`, view/polish additions | **Interrupted partial implementation. Frontend paths exist; host contract/payload not proven wired.** |
| Voice/computer-use reuse | capability audit and one voice catalog probe | Research/protocol discovery only; no embedded voice session or standalone native CUA bridge implemented |

### Evidence that can be retained

- Outgoing coordinator ran a consolidated built-in suite: **69/69 passed** before the latest navigation/appearance/task-workspace changes. Log: `docs/quality/2026-09-13/evidence/builtin-tests-sep14.log` if still present locally.
- Core build passed on 14 September after the core adapter changes.
- Navigation integration reported seven focused checks passing plus typecheck, manifest/Python/signature checks.
- Worktree registry: four disposable-repository tests passed; host hub: four host-double tests passed after failure handling improvements.
- Final alignment/compact-usage frontend checkpoint: 16 targeted DOM tests passed. These counts describe separate snapshots/suites and must not be added together as a new total.
- Browser fixture measured three context controls at 24px high on a common baseline. At a 380×620 viewport, row width was 342px and composer bottom 612px. Removal, keyboard activation, reload retention and patch receipt expansion were exercised.
- Older stress fixture: 72 messages, 40 activity events, 80 deltas, 24 references, 20 usage rows. Earlier overflow and disclosure-persistence defects were found and fixed.
- An earlier native minimal prompt returned `READY`; this was an older build, on Sol Medium at that time. It does not certify current Luna inference, concurrency or current native behavior.

A successful build/signature/test suite did **not** prevent the QA startup crash. Keep that distinction explicit.

## 6. Interrupted concurrency work: inspect this before finishing it

The intended host identity is:

```ts
type TaskRuntimeIdentity = {
  taskId: string;
  workspaceId: string;
  cwd: string;
  threadId?: string;
};
```

The current registry source defines lifecycle state, queues, checkpoints, approvals, event deduplication and a generic controller slot. Its snapshot includes status, activeTurnId, generation, isolated, capability, queueLength and pendingApprovalIds.

The new frontend normalizer expects:

```ts
type TaskWorkspaceSnapshot = {
  version: 1;
  activeTaskId: string;
  tasks: Array<{
    taskId: string;
    workspaceId: string;
    cwd: string;
    threadId?: string;
    name: string;
    status: "idle" | "running" | "waiting" | "cancelled" | "completed" | "failed";
    activeTurnId?: string;
    capability: "isolated-worktree" | "shared-checkout-serialized";
    workspaceOwner?: string;
    changes?: Array<{path: string; adds?: number; dels?: number}>;
  }>;
};
```

At handoff read, `agent-view.ts` accepts `taskWorkspace` on state/telemetry and a `taskWorkspace` delta; task overlay code is present in `agent-polish.ts`. A source search did not show `TaskRuntimeRegistry` imported into the host. **Do not infer runtime integration from a rendered card.** The frontend requires `name`; the registry snapshot does not provide it by itself. Define an explicit adapter rather than shape two unrelated fixtures to look compatible.

### Specific review concerns found during handoff preparation

These are inspection findings for the next owner, not completed fixes or executed failure tests:

1. Registry `canonicalPath()` is string cleanup, not filesystem canonicalization. `/tmp` and `/private/tmp`, symlinks and parent segments can refer to the same checkout. A concurrency safety boundary must use validated canonical identity from the host.
2. `canStart()` currently compares workspace IDs/paths but does not itself prove that distinct paths are validated independent worktrees. Caller-supplied `isolated: true` is not evidence.
3. Event workspace/generation fields are optional; `child: true` can bypass the normal turn mismatch check. Verify actual child membership/ownership rather than trusting an arbitrary flag.
4. The existing-worktree hub derives an ID from a truncated base64 encoding of the absolute path. Different paths sharing a long prefix can collide. Fix stable identity before relying on it for isolation.
5. Tests exist for the interrupted registry and view modules, but no completed handoff proves they passed on this final source. Read them; run the appropriate focused tests once after the contract is settled.
6. Existing native Codex children can inherit their parent's cwd. Separate task IDs, process IDs or cards do not isolate filesystem writes. Preserve their graph but report shared ownership honestly.

### Correct concurrency standard

- Only advertise isolated parallel writes when the actual provider dispatch cwd is a distinct validated worktree and its file URIs/controller/checkpoints agree.
- Preserve current serialization for shared-checkout top-level writes until a stronger enforced boundary exists.
- Do not claim that a UI queue prevents two native child shell commands from editing the same file.
- Route approvals, late events, cancellation, reconnect and diffs by verified task/workspace/thread/turn identities.
- Render full transcript only for focused tasks; use bounded inactive previews. Nine visible cards must not require nine duplicate editor engines, browser instances or replayed full histories per token.
- Same relative filename in two isolated worktrees must remain two distinct absolute files and diff owners.
- Real concurrent dispatch, routing, cancellation and full-file review must pass native QA before enabling the feature as ready.

## 7. Appearance, references and memory

User references:

- [Feral UI gradients](https://feralui.dev/gradients): soft material surfaces and gradient composition.
- [PX0](https://px0.ai/): keyboard-first code navigation and a lightweight read-only verification workflow. Its published self-benchmarks are not a like-for-like comparison with a full IDE.
- User Spotlight screenshot: floating frosted surface, thin rim, rounded corners and clear selected rows.
- User multi-pane screenshot: translate the simultaneous-work pattern into named IDE tasks; do not copy terminal UIs or install OpenCode.

Current decision document: `docs/quality/2026-09-14/liquid-glass-decision.md`.

Use existing vanilla webview primitives and material tokens first. A library does not grant AppKit composition. Add a dependency only when its capabilities, bundle cost, maintenance and accessibility justify the migration. No new UI library has been established as necessary.

Distinguish:

- **CSS glass approximation:** webview `backdrop-filter` and translucent surfaces.
- **Native vibrancy:** Electron main-process/macOS material capability.
- **Apple Liquid Glass:** do not claim this is implemented merely because the CSS blurs a background.

Keep transcript, code, diffs and dense content opaque/readable. Limit material effects to controls and navigation. Support reduced transparency, reduced motion, forced colors, high contrast and opaque fallback. Avoid animated blur/refraction during typing, streaming or scrolling.

Primary sources already researched:

- [Apple Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/liquid-glass)
- [NSVisualEffectView](https://developer.apple.com/documentation/appkit/nsvisualeffectview)
- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)

### Memory baseline, not an optimization claim

`docs/quality/2026-09-14/memory-baseline.md` records the older running release tree: eight processes, 735,440 KB RSS, about 718 MiB. Shared pages may be counted multiple times. ChatGPT, unrelated browsers and crashed QA copies were excluded from that tree. No unique-physical-memory or verified memory reduction claim was made.

Compare the same workspace, extension set, browser state, task count and workload before/after. Separate idle, startup and active inference. Installed duplicate bundles consume disk; they are not automatically simultaneous RAM usage. Do not remove working features to hit a made-up memory target. Find concrete unnecessary processes, subscriptions, serialization, indexing or retained payloads, then measure the change.

## 8. Voice and computer use: do not repeat the incorrect conclusion

Installed host inventory from the audit:

- `/Applications/ChatGPT.app`, bundle ID `com.openai.codex`, version `26.908.40834` at the checkpoint.
- Bundled CLI `/Applications/ChatGPT.app/Contents/Resources/codex`, `0.154.0-alpha.6.2`.
- Bundled `@oai/cua` / `@oai/sky` and a native CUA service exist, but their private IPC/auth boundaries are not a stable third-party extension API.

The first audit said embedded account-backed voice was unavailable. That conclusion was too broad and was corrected:

- `app-server generate-ts --experimental` exposes `thread/realtime/start`, `appendAudio`, `appendText`, `appendSpeech`, `listVoices` and `stop`.
- Generated schemas are under `/tmp/muster-schema-experimental-20260914` if retained.
- Transport types include WebSocket, WebRTC SDP, and an existing call.
- A local stdio `thread/realtime/listVoices` probe succeeded without a new API key. Evidence: `docs/quality/2026-09-13/evidence/realtime-catalog.json`.
- **No realtime session, microphone capture, transcription or voice inference was tested.** Catalog success is not proof of entitlement or a production transport.

Read the corrected `host-capabilities.md`, not only its older summary. Follow the installed protocol version and official docs. Do not copy credentials, spoof the first-party host, bypass native sender authorization or silently substitute a separately billed Realtime API. A separate keyed Realtime API is a different option and does not by itself satisfy this user requirement.

Voice is a later capability-gated engineering lane after startup stability. Computer use must similarly distinguish a supported plugin/connector contract from private app internals. A UI mock or recording helper is not an implemented conversational voice/computer-use feature.

## 9. Kanban and immediate order of work

Existing board files are `docs/quality/2026-09-13/kanban.json`, `.md`, and `.html`. JSON was treated as the main board, but it lags the latest interrupted concurrency work and crash details. Reconcile it once against this handoff; do not regenerate the entire roadmap every turn.

Recommended execution order:

| Priority | Work | Exit evidence |
|---|---|---|
| P0 | Diagnose/fix deterministic native QA startup crash | Captured cause, minimal patch, one stable native launch and regression evidence |
| P0 | Preserve realtime/full-file diff and ownership | Native edit/review/undo/dirty-buffer/parent-child cases pass |
| P1 | Finish interrupted runtime/view contract safely | Actual producer-consumer integration and isolated concurrency tests; no false capability |
| P1 | IDE-native task grid/splits, subagents/messages/diffs | Real task operations, focused state persistence, named change ownership, human QA |
| P1 | Current-build identity and reliable launch | User can open the intended build without guessing among duplicate names |
| P1 | Context/readability/navigation/appearance regression closure | Latest source/native build passes affected human flows |
| P1 | Measured RAM/startup/interaction improvements | Matched before/after workload; no feature regression |
| P2 | Native material integration | Supported host boundary, accessibility and performance evidence |
| P2 | Account-backed voice/computer-use feasibility to implementation | Real capability/entitlement/audio/stop/reconnect/permission evidence |

A card should contain:

```text
ID / title / priority / status / owner / owned files
Problem and exact expected behavior
Dependencies and frozen producer/consumer contract
Non-goals and protected behavior
Acceptance cases and evidence location
Current blocker and next concrete action
```

Use Intake → Design → Ready → In Progress → Integration → QA → Done. A stalled card stays in its real state with a blocker, not a fabricated Done. No card becomes Done solely because its agent ended its turn.

## 10. Definition of done and test selection

Every feature needs applicable checks from all of these categories. Mark N/A only with a reason tied to that feature, not to save effort.

| Category | What must be checked |
|---|---|
| Happy path | Intended operation reaches the user-visible outcome through the actual integration |
| Negative path | Invalid input, unavailable service, rejection, failed command, permission denial or missing data does not corrupt state |
| Edge cases | Empty/large/Unicode/long paths, stale IDs, rapid switching, double action, late events and partial results |
| Human flow | Actual typing, attaching, clicking, keyboard use, navigating, reading and returning to work |
| Context latency | Attachment appears promptly, pending/error state is honest, correct material reaches the right request |
| Interaction | Focus, escape, scrolling, panel height, hit targets and feedback remain usable during updates |
| UI regression | Wide/narrow/zoom/theme/contrast/reduced-motion and long content do not hide essential controls |
| Functional regression | Existing editor, realtime/full-file diffs, queue, history, approvals and ownership still work |
| Stress | Bounded event/output/task/file load, no lost state, runaway work, growing observers or unusable input |

Test by risk and boundary, not by test count:

- State machines and routing: behavioral unit tests with interleaved/late/duplicate events.
- Git workspace operations: real disposable repositories, including dirty source and spaces/Unicode.
- DOM: real renderer with injected host doubles; ensure actual producer snapshots reach the consumer.
- Browser fixture: layout/keyboard/persistence/large-output checks, explicitly labeled offline.
- Native app: actual process, extension, provider, browser, editor and permissions interaction.
- Performance: defined workload and meaningful metrics; distinguish transport/tool latency from product latency.

Do not write tests that merely mirror a CSS string or handcrafted contract and then claim the integration works. Static checks can protect a specific style/serialization contract; they are not boot or human-flow proof. Mock success is not native success. A model reply alone is not proof that a file attachment was actually supplied.

Run each meaningful check once after its inputs stabilize. A changed contract, observed failure or affected dependency justifies a targeted rerun. Do not repeatedly run the whole core suite while workers edit.

For new features, do not invent pass criteria such as '<100ms' after seeing results. Define any numerical target with a workload and measurement method first. Until measured, use concrete observable requirements such as 'composer remains reachable and typed characters are retained during the stream.'

## 11. Build, staging and browser discipline

Existing package tools: Node 24-era runtime and pnpm 10.33.2. Use existing dependencies before installing anything.

Typical commands, only when relevant:

```sh
# From sibling muster, after core source changes:
pnpm --filter @musterhq/core build

# From muster-code:
pnpm --filter @muster-code/builtin typecheck
pnpm --filter @muster-code/builtin build

# From packages/builtin, selected affected tests only:
node --test --import tsx test/navigation.test.ts test/workspace-registry.test.ts test/workspace-hub.test.ts

# Generate the offline real-renderer fixture when its source changes:
node scripts/dev/preview-pane.mjs
```

`MUSTER_CODE_DIST` controls assembly destination. Read `scripts/assemble.sh` before invoking it. Do not overwrite a running app. `scripts/dev/launch-qa.sh` creates a disposable named copy; it now has changes around `--new-window` and product identity, but **the startup crash remains unresolved**. Do not present it as a verified launcher simply because syntax/signature checks pass.

Capture exact build path, source revision/dirty snapshot, relevant bundle hash, profile, workspace and launch command. Never mutate a bundle while it is running. Freeze input files before assembly; snapshot work if another lane must continue independently.

The preview is generated in `/tmp/muster-polish-preview` and served at `http://127.0.0.1:4178/`. Scenarios include `?scenario=agents`, `?scenario=agents&state=empty`, and `?scenario=stress`. It is an **offline fixture**, not the full IDE. A task-workspace scenario may have been partially added; inspect before claiming it.

The preview server previously remained listening but returned empty responses because of its process/output lifetime. It was restarted with output redirected to `/tmp/muster-preview-server.log`. PID 68628 is historical, not authority to kill a current process. Recheck the exact task-owned command before touching it.

### Computer-use lessons that save repeated calls

- One GUI owner at a time. All other agents use code/API/CLI checks.
- Use the current documented CUA API; browser IDs and bindings changed after app restarts. Rediscover the relevant browser, not all unrelated user tabs.
- After a reset/compaction, follow the tool's initialization/documentation rule before reusing handles.
- A dead in-app error tab can have a `data:` URL that the tool refuses even for close/goto. Do not retry the same action and print its enormous error repeatedly. Read the documented recovery once and create a fresh tab in the same browser in a separate call if supported.
- Catch errors and return a short relevant summary; do not dump an entire encoded error page or stress DOM into the model.
- Use semantic controls and a fresh state after actions. Avoid stale native accessibility indices.
- Do not use AppleScript or raw OS input as a workaround for a CUA failure.
- Preserve user-owned tabs. Do not let an agent accidentally operate an unrelated YouTube/Chrome tab because a browser ID was reused.
- When preview code is regenerated, refresh the user-visible preview too. Testing a hidden/new tab while the user sees an old page caused avoidable confusion.
- Native launch timeout, missing windows, app crash, server failure and product UI defect are different findings. Record which one actually occurred.

## 12. Delegation and model policy for the next coordinator

Default: **Terra coordinator, Luna High for focused implementation/testing, Terra for nontrivial state/backend work, Sol for difficult diagnosis or independent review.** Use available models and supported reasoning settings; never claim a requested override actually took effect without a supported tool receipt.

The user authorized this mix. No need to ask for routine model selection inside that scope. Do not automatically involve Astra. If an unavailable capability prevents a model switch, say so briefly and use the supported path rather than hacking private control APIs.

The current environment exposed a maximum of three simultaneous child slots. An attempted new agent hit a thread limit, and an attempted app-level model override on an existing multi-agent-v2 child was rejected. The original children were Luna High. **Do not claim this session successfully switched those children to Terra or Sol.** A new Terra session can establish fresh worker allocation through supported collaboration tools.

### Coordinator duties

- Read the compact handoff and relevant evidence once.
- Decide priorities, boundaries, acceptance and integration order.
- Give workers specific files and outcomes; keep ownership disjoint.
- Review handoffs for unsupported claims and missing cases.
- Send precise retasks; do not duplicate the worker's implementation/research/test run.
- Arrange independent review for risk-bearing work and one GUI owner.
- Resolve necessary user questions while work proceeds.
- Keep board and final report honest.

### Worker duties

- Inspect only the relevant previous work and instructions.
- Implement within owned files and preserve existing dirty work.
- Use the smallest useful tool/API/CLI surface; batch independent reads.
- Report contract changes before changing a consumer/producer owned by another worker.
- Run affected checks after stabilizing edits; preserve evidence.
- Stop at a concrete blocker or deliverable, not after endless identical retries.
- Report exactly what is implemented, tested, not tested, and still unsafe to enable.
- No recursive delegation and no quota polling.

### Escalation ladder

1. Luna receives a focused, testable task with known constraints.
2. On a concrete defect, give one precise retask with the failing case and expected behavior.
3. If the design remains wrong or the failure requires deeper reasoning, give Terra the exact files/evidence and unresolved decision. Do not restart the whole project.
4. Use Sol for a bounded complex diagnosis or independent architecture/release review when warranted.
5. Change the approach only after explaining which evidence invalidated the previous one.

Higher reasoning is not automatically cheaper or better. Reduce irrelevant context and duplicate work before increasing model size or effort. Do not run several agents against the same problem just to choose a winner unless an explicit independent review is justified.

## 13. When to plan, create a goal, visualize or research

### Plan

Use a short plan when work crosses ownership boundaries, changes a contract, has a risky migration, or requires ordered integration/testing. State the intended user behavior, protected invariants, files/owners, dependencies and evidence. Five to eight useful steps are often enough.

For a small known defect, use a short implementation note and fix it. Do not enter a long planning cycle, generate a fresh roadmap or ask approval for every reversible edit.

### Goal

A written objective on a Kanban card is useful. An actual persistent goal tool is different: create it **only when the user explicitly asks for a goal** or governing instructions require it. Do not infer permission to create a goal or set a token budget from a broad product request. Do not mark a goal complete because a turn or budget ends.

Good proposed outcome: 'The current QA app launches reliably and the affected native navigation/context/diff flows pass on this exact build.' Bad outcome: 'Make everything perfect.' If the user wants a persistent goal, first make its finish line measurable and preserve unresolved blockers.

### Visualize

Use a small diagram or working UI fixture when it resolves a concrete question: task/worktree ownership, parent-child messages, panel layout, or the difference between focused and grid review. Prefer a source-backed HTML/DOM prototype or a small architecture diagram over decorative image generation.

For a visual design choice, show one coherent recommendation and, only if needed, a small number of meaningful alternatives. Do not create a gallery of mockups while the app cannot launch. Once the direction is selected, implement and test it instead of regenerating alternatives.

### Research

Research when the interface is uncertain, the user explicitly requests it, or a platform/library capability may have changed. Read existing findings first. Use primary official docs or source. Search once for the exact uncertainty and stop after enough evidence supports the decision.

Research must produce a decision, contract, implementation option or a clearly stated limit. Do not collect libraries merely because they look fashionable. Respect relevant installed skills, but the latest user instructions supersede conflicting skill guidance.

## 14. Questions, updates and retasks: what to say

Use concise, factual language. Do not flatter, repeatedly restate the whole plan, or call a fixture a product release.

**Useful progress update:**

> The context row now aligns at wide and narrow widths. Removal and reload retention passed. Native verification is still blocked by the startup crash; the packaging owner is investigating that exact failure.

**Useful mid-conversation question, only if truly unresolved:**

> The runtime can safely run these tasks in separate worktrees. Should the default be automatic isolation, with shared-checkout work as an explicit option? I’m continuing the unrelated launch fix while you decide.

Do not ask that question if the session already supplied a clear answer. Do not ask whether to start the work the user just requested.

**Useful retask:**

> Your report says the panel uses glass, but its background is an opaque 82/18 color mix. Change only that material rule and its accessibility fallbacks. Verify that the transcript stays opaque and reduced transparency removes blur. Keep the already-passing context logic unchanged.

**Useful failure update:**

> The renamed QA copy still traps on startup. Signature checks pass, so renaming/signing alone has not explained the failure. I’m capturing the fatal startup output before another attempt.

**Avoid:** 'All done', 'production-ready', 'fully tested', 'native Liquid Glass', 'safe concurrency' or 'much lighter' without the exact evidence those claims require.

## 15. Integration and release discipline

1. Stabilize producer/consumer contracts before combining lanes.
2. Review the actual diff and untracked files, not only a worker summary.
3. Integrate into the user's actual working branch without losing dirty changes. Keep sibling core changes coordinated.
4. Run the affected tests/typecheck/build once. Preserve earlier valid results.
5. Assemble into a new, identified destination; do not mutate a running bundle.
6. The GUI owner tests that exact app/profile/workspace and records build identity.
7. Repair observed failures with targeted retests, not full repeated passes.
8. Update each card with implemented/verified/blocked status and evidence.
9. Commit or merge only the reviewed intended work at the appropriate boundary; do not claim a merge that did not happen. No push/deploy or external communication is implied by this handoff.
10. A release report states what changed, what passed, what remains blocked and which artifact is current.

The handoff itself does not authorize silently enabling incomplete concurrency or launching known-crashing copies repeatedly.

## 16. Important mistakes to avoid repeating

- Too much coordinator tool work: the user explicitly objected. Delegate commands, research, builds and GUI work; review their evidence.
- Rechecking quota: now prohibited unless asked.
- Treating requested model settings as proof of actual model execution.
- Switching orchestration systems during implementation: the Orca trial added noise and did not deliver the hub/navigation implementation.
- The routed `cx/gpt-5.6-luna` identifier used fallback metadata with a 121,600 effective context window; startup input was about 120,834 tokens, causing immediate compaction. Do not repeat that experiment. Canonical Luna catalog reported 272,000 at that checkpoint, but do not use this historical fact as a reason to restart the router.
- Broad copied context and long tool outputs undermine cost savings even on a smaller model.
- Hand-shaped UI fixtures hid producer/consumer mismatches: `agentWorkspace`, node-local `changeRecords`, and now `taskWorkspace` require real adapters.
- JSON embedded in an HTML script must escape script-breaking content. The malicious patch sample containing `</script>` broke the preview before it was fixed.
- Blur over an opaque surface costs rendering work without producing glass.
- A signed/compiled app can still crash. Do not equate signature success with startup success.
- Old display names and hidden preview tabs left the user looking at obsolete UI.
- A worker that reports completion may be idle: `send_message` does not necessarily start a new turn. Use the supported followup-task mechanism for a new bounded assignment. Do not send repeated instructions blindly during a final-handoff race.
- Do not label a crash investigation complete merely because the failure was described. The diagnosis/fix gate remains open.

## 17. Read only the documents relevant to your lane

| Need | Read next |
|---|---|
| Current authoritative intent/state | This document |
| Crash/artifact/RAM details | `docs/quality/2026-09-14/memory-baseline.md`, `docs/quality/2026-09-13/qa-launcher.md` |
| Board | `docs/quality/2026-09-13/kanban.json` |
| Frontend completed changes/evidence | `docs/quality/2026-09-13/frontend-lane.md` |
| Task/agent graph | `docs/quality/2026-09-13/agent-orchestration.md`, `thread-management.md` |
| Browser | `docs/quality/2026-09-13/browser-lane.md` |
| Worktree hub | `docs/quality/2026-09-14/workspace-hub.md` |
| Concurrency architecture history | `docs/quality/2026-09-13/workspaces-design.md`, then actual new registry/view source |
| Navigation | `docs/quality/2026-09-14/navigation-lane.md` |
| Materials | `docs/quality/2026-09-14/liquid-glass-decision.md` |
| Host capabilities/voice correction | `docs/quality/2026-09-13/host-capabilities.md` |
| Historical product comparison | `docs/quality/2026-09-13/ide-parity.md` |
| Interaction/polish reference | section 28 and `docs/quality/2026-09-15/interaction-atlas.md` |

Historical docs contain stale counts, ownership notes and limitations that were later fixed. Treat them as evidence of their checkpoint, not current truth. This document explicitly marks the unresolved current gates.

## 18. Copy-ready coordinator prompt

```text
You are the Terra coordinator for Muster Code. Read docs/TERRA-HANDOFF-2026-09-14.md sections 1–5 first, then only the lane-specific material needed for the next step. Do not reread the entire conversation or rescan the whole repository.

The goal is a polished, lightweight, Mac-like IDE that replaces my daily Codex/Cursor workflow: named concurrent tasks, subagents and their messages, persistent context, browser integration, and complete realtime inline diffs. The final agent workflow must be IDE-native, not a terminal dashboard. Graphite/violet is the default; keep customizable themes and accessible solid fallbacks.

Use Terra as coordinator. Delegate most commands, research, implementation, builds and testing to bounded Luna/Terra workers. Use Sol only for a specific hard problem or independent review. Do not use Astra by default. No recursive delegation, duplicate implementations, redundant tool calls or repeated broad tests. Do not check usage, create quota polling or redeem credits unless I explicitly ask. Do not revive Orca or alter my default provider/auth configuration.

Preserve all uncommitted work in muster-code and sibling muster. Both were on main at the checkpoint. Do not reset, clean or blindly switch branches. All previous agents were interrupted; inspect relevant files and evidence rather than assuming their last assignment completed.

First priority is the unresolved native QA startup SIGTRAP. Assign one owner to inspect existing crash/fatal output and compare the working and QA bootstrap/native artifacts. Do not repeatedly reopen known-crashing apps. Finish one evidence-backed fix before further native material changes. Other independent work may proceed in new isolated modules, but freeze integration inputs before staging.

The new task-runtime-registry and task-workspace-view are partial and not proven wired. Do not enable parallel writes until actual provider cwd, worktree identity, controllers, events, approvals and full-file diffs are correctly isolated and tested. Native child agents may inherit parent cwd; IDs alone do not isolate files.

Every changed feature needs applicable happy, negative, edge, human-flow, context-latency, interaction, UI-regression, functional-regression and stress evidence. Retain existing valid checks and rerun only affected ones. Assign one GUI owner and review its evidence rather than repeating its tests. Distinguish fixture tests, source checks, native tests and actual model tests.

Ask necessary questions mid-conversation while independent work continues. Give concise factual updates. Keep the Kanban current. Do not call work done or production-ready while the startup, full-file diff or live concurrency gates remain open. Start with a short prioritized plan and concrete worker assignments, then carry out the work.
```

## 19. Copy-ready worker prompts

### A. Focused implementation

```text
Role/model: [Luna High / Terra with appropriate reasoning].
Task: [one observable user outcome].
Own only: [exact files/modules]. Other owners: [names and boundaries].
Read first: [one or two relevant files/docs]. Existing verified behavior: [specific evidence].
Implement: [concrete behavior and producer/consumer contract].
Preserve: [realtime/full-file diffs, context, ownership, cancellation, other relevant invariants].
Do not: [scope exclusions, global config changes, unrelated dependency additions].
Acceptance: [happy, negative and edge cases; identify which human/performance checks need the GUI owner].
Run only affected checks after the files stabilize. No usage checks, recursive agents or repeated broad passes. Report exact changes, evidence, unresolved risks and the next owner. A fixture is not native proof.
```

### B. Startup crash owner

```text
Own the P0 native QA startup crash. Read the crash section of the Terra handoff and the existing local reports/logs. Preserve all app copies and user data. Signature verification and unique product identity already failed to explain the crash; do not repeat those as fixes.

Inspect application-specific diagnostics/fatal stderr and compare only the relevant working-versus-QA native/bootstrap artifacts. If needed, make one instrumented reproduction with local stdout/stderr capture. Do not use a shotgun set of flags or repeated Reopen. Identify the actual cause or state the narrow missing evidence, then implement one minimal fix and its validation. Coordinate a frozen build and native QA with the GUI owner. Do not hand the tool work back to the coordinator.
```

### C. Runtime concurrency owner

```text
Own task-runtime identity and isolated concurrent execution. Start with task-runtime-registry.ts and its tests, the actual AgentPane/LiveEditController seams, and section 6 of the Terra handoff. Preserve the working shared-checkout lease and native full-file diff engine.

Prove canonical worktree/provider cwd identity, per-task controller/queue/checkpoint/approval/event routing, and late-event/cancel/reload handling. Different task IDs are not isolation; native child agents may share parent cwd. Do not enable parallel-write capability until real integration proves it. Test two isolated worktrees editing the same relative filename and verify distinct absolute diffs. Supply one exact snapshot/action contract to the UI owner and test the untouched producer output at the consumer.
```

### D. GUI QA owner

```text
You are the sole GUI owner for this build. Use the documented computer/browser-use tools and the exact staged app/profile/disposable workspace supplied by the integration owner. Verify identity before testing. Do not relaunch a known-crashing build until the crash owner supplies a fix.

Test only changed or affected flows: actual typing/attachments/task switching, context retention, keyboard focus/escape, chip wrapping, panels and optional usage, themes/accessibility, named agents/messages/controls, worktree behavior, and realtime/full-file diffs as applicable. Include negative/edge/stress cases. Preserve screenshots and concise bounds/observations. Distinguish offline fixtures from native/provider tests. Refresh the user-visible preview after a fixture update. Do not inspect or operate unrelated user tabs. Report concrete defects to their owners and retest only the repair.
```

### E. Independent review

```text
Review the specified changed boundary independently; do not implement a competing solution or repeat passed suites. Check actual source and evidence for ownership errors, missing producer/consumer fields, stale events, false capability claims, unhandled failures, unnecessary work, and protected-feature regressions. Return concrete findings with file/function and a failing scenario, or say no actionable issue was found within the stated scope. Do not equate absence of findings with full product certification.
```

### F. Precise retask

```text
The delivered change does not yet satisfy [specific acceptance criterion]. Evidence: [observed result/test/screenshot]. Expected: [exact result]. Repair only [owned files/behavior], preserve [already-passing behavior], and run [affected checks]. Do not restart the whole implementation or broaden the design. If the current contract cannot support the expected result, explain the exact missing capability before adding a workaround.
```

## 20. Required handoff format for every worker

```text
Outcome: implemented / partially implemented / blocked.
Files changed: exact paths.
Behavior: what now happens and why.
Contract: actual producer/action fields and capability boundaries.
Verification: command or human flow, result, build identity and evidence path.
Not verified: explicit remaining native/provider/performance cases.
Risks/blocker: concrete cause or missing evidence; no guessed success.
Next owner/action: one specific step.
Process/artifact cleanup: task-owned resources retained/stopped; do not touch unrelated work.
```

The next coordinator's first deliverable should be a short, truthful execution plan and a repaired startup gate—not another general comparison report or a claim that the IDE is already complete.

## 21. Complete product intention: what the finished application should feel like

The user spends their working day in Codex. Muster must absorb that whole working pattern, while improving the parts of an IDE that make everyday work unnecessarily complicated. The ambition is a personal daily driver that could also persuade other developers to use it because the workflow is clearer and easier—not because it has more settings or a different logo.

Think of three equally important responsibilities:

1. **A real IDE:** code navigation, editing, language assistance, diagnostics, terminals when needed, Git and complete review.
2. **An agent collaboration workspace:** named tasks, concurrent work, parent/child supervision, messages, live activity, recoverable history and attributable changes.
3. **A calm Mac-like product:** consistent materials, clear focus, restrained motion, direct controls, good defaults and visibly reliable behavior.

None of the three compensates for failure in another. Attractive glass around a crashing app is unacceptable. A powerful backend hidden behind confusing terminal panels is also unacceptable. A lightweight application that discards full diffs or useful editor features does not satisfy the brief.

### The end-state screen model

This is the functional composition to aim for, not a claim that every part is currently implemented:

- **Project/task navigation:** a comprehensible sidebar for projects, pinned tasks, recent work, search, archived work and parent/child task relationships. Use actual names, not generated substitutes that lose the user's identity for a task.
- **Central working area:** code, browser, review or task workspace, with predictable split/focus behavior. Full-file inline diffs remain first-class editor content.
- **Task workspace:** a grid/overview of named tasks plus focused detail. Each card identifies its status, model/effort where useful, workspace, latest activity, changed files and children. Card colors can aid recognition but must not be the only status signal.
- **Focused conversation:** readable messages, an always-reachable composer, retained context, visible pending/failed actions, and compact tool/activity summaries. Full details open when requested.
- **Agent relationships:** parent and child messages are inspectable with sender, recipient, order, task identity and status. The user can understand what was asked, what the child is doing, what changed and what it reported back.
- **Review surface:** pin the desired full-file diff while conversations continue. Identify the task/worktree that owns each version. A compact chat receipt can open the complete review; it must not replace or erase it.
- **Command/navigation surface:** a Mac-like quick-access panel that makes files, symbols, tasks, wrap, review, browser and appearance easy to reach. Keyboard shortcuts augment visible controls rather than becoming another language the user must memorize.
- **Settings and tools:** progressive disclosure. Everyday controls are near the work; advanced provider, plugin, permission and diagnostics configuration remains discoverable but does not dominate chat.

The screenshot of nine terminal panes establishes a need for simultaneous awareness and control. It does not require nine heavy terminal emulators or nine full transcript DOM trees. A good implementation allows overview, selection, pinning and two-/multi-pane focus without paying the maximum rendering cost for every inactive task.

### A successful ten-minute acceptance walkthrough

This is a target scenario for the release candidate, not evidence that it already passes:

1. The user opens the clearly identified current Muster app. There is no crash dialog, incorrect old build, unexplained blank window or forced trip to another app.
2. They open an existing project, find a file and toggle word wrap from an obvious control or familiar shortcut.
3. They create a named task, attach a file with spaces/Unicode in its path and a browser selection, type a long prompt, switch away and return. Nothing disappears or becomes ambiguous.
4. They start a main task that delegates bounded work. Child tasks appear with names and accurate ownership. The main-to-child instructions and returning reports are readable in the IDE.
5. Two genuinely isolated tasks change the same relative filename. Each change is attributed to the correct absolute worktree and remains separately reviewable.
6. The user pins the full-file realtime diff and watches changes arrive while continuing a conversation. Switching the selected task does not repaint the wrong file, lose a patch, or steal focus.
7. One child fails or is stopped while another continues. Only the affected child changes state. Pending approvals and the parent's conversation remain correct.
8. The user opens a long message, a tool result and optional usage details. Expanded state is remembered. Nothing pushes the composer offscreen.
9. They change theme/density/material preference. Controls remain readable, aligned, keyboard accessible and responsive. Reduced transparency produces a deliberate solid appearance.
10. They reload/reopen and inspect the same tasks, context and changes. Disconnected work is labeled honestly and does not automatically replay writes. Review/integration happens against the intended branch/worktree.

If this walkthrough fails, explain the specific failing stage. Do not replace it with a screenshot of a scripted dashboard and declare the product usable.

## 22. Required feature catalogue and release boundaries

The product breadth is intentional. Implement it in dependency-ordered increments without pretending the unfinished parts are already there.

| Feature family | Required finished behavior | Current boundary / what remains |
|---|---|---|
| Project management | Open/recent projects, clear cwd, project-scoped work and navigation | Native foundations exist; coherent product-level navigation still needs completion/QA |
| Task lifecycle | Create, name, search, pin, archive/restore, resume, fork and continue with actual history | Catalog/source implementation exists; complete native daily-flow proof open |
| Multiple tasks | Concurrent named tasks, readable overview and focused/split work | New registry/grid is partial; do not enable unsafe concurrency |
| Subagents | Spawn through a verified backend path; parent/child relationships and lifecycle remain visible | Native observed graph exists; full IDE orchestration controls and actual flow need closure |
| Agent messaging | Inspect instructions and responses; correctly direct follow-ups; show failed delivery distinctly | Directional event graph exists; preserve ordering, identity and real delivery/turn-state evidence |
| Context | Files, folders, selections, browser references and other supported sources retain meaning and provenance | Retention/metadata improved; actual provider inclusion and unsupported-source cases need native evidence |
| Composer | Long prompts, wraps, drafts, attachments, queue/cancel, keyboard/IME-friendly behavior | Significant source/fixture progress; do not regress during task-grid work |
| Transcript | Entire messages available, readable markdown/code/tool output, remembered expansion/scroll | Implemented at component level; recovery/native large-session gates remain |
| Streaming transparency | Current work, tool events, statuses and reported reasoning summaries arrive without lag or confusing state | Compact activity exists; multi-task streaming must preserve ownership and responsiveness |
| Full-file diffs | Realtime editor rendering, complete file context, correct hunk/file ownership, review/undo/redo | Core capability is protected; current native crash blocks certification |
| Chat diff receipts | Optional compact previews with complete review access and explicit truncation/missing data | Node-local receipts implemented; task-grid integration must reuse them correctly |
| Always-visible review | User can leave/pin full review open while work continues; collapse preference supported | Chat previews default open; full editor pin/visibility workflow still needs explicit integration/QA |
| Permissions | Full Access does not demand redundant acceptance for already-authorized writes; genuine permission requests still work | Ownership/review wording improved; real native access cases remain open |
| Worktrees | Create/select isolated work safely, retain source changes, show exact base/cwd, explicit integration | New-window hub exists; same-window task-scoped isolation remains incomplete |
| Conflict handling | Same-file task changes are distinguishable; uncertain/conflicting application stops clearly | No automatic merge feature has been completed; never silently apply one task over another |
| Browser | Useful embedded browser, reliable load/history/error/retry, selected page context and source mapping | Navigation/fixture hardening exists; full native browser-to-code workflow not certified |
| Code navigation | Files, symbols, definitions/references, find/search, line navigation and history are easy to access | Reuse existing editor services; Go To hub added; actual native path needs QA |
| Everyday controls | Wrap, appearance, panel visibility, focus/splits and review controls are easy to find | Some hub/settings actions exist; finish the interaction design instead of adding obscure shortcuts |
| Themes | Multiple persistent customizable palettes, accent/density/type controls, light/dark/accessibility | Five palettes and controls exist; native/combinations still need full verification |
| Mac-style surfaces | Coherent floating controls, menus, panels, selection, typography and restrained materials | Current webview CSS is an approximation; native host treatment is a later owned change |
| Icons/branding | Consistent Muster identity; no accidental inherited product identity or ambiguous current launcher | Lucide product icons added; app/icon/build identity remains an unfinished polish issue |
| Tools/plugins/skills | Inspect configured capabilities, availability and failures; use real supported management APIs | Existing tools/settings scaffolding; do not advertise experimental or unsupported operations as working |
| Plan/goal/board modes | Tasks can be understood and tracked without losing their implementation/review context | Existing board/planning infrastructure; exact user-facing integration needs a later acceptance pass |
| Voice | Account-backed live conversation integrated with task context when supported | Experimental app-server discovery only; no working voice session yet |
| Computer use | Supported, permission-aware computer/browser actions with visible activity and stop behavior | Host bundle audit only; no stable standalone third-party CUA bridge established |
| Reliability | No startup crash, lost draft, crossed event/approval, invisible error or accidental replay | Startup crash is P0; several recovery/ownership improvements already implemented |
| Efficiency | Bounded inactive UI, state writes, processes, event buffers and context; measurable RAM/latency | Baseline measured, duplicate draft posts reduced; no overall RAM reduction proven |

Voice, native materials and broader plugin surfaces can have explicit capability/availability states while being built. They must remain visible roadmap requirements rather than silently disappearing from scope. A staged release should state which capabilities are ready and which are unavailable; it must not market incomplete work as the full replacement.

## 23. Standard of visual finish and polish

The user is asking for a level of finish, not just named effects. Apply these standards consistently across the actual application.

### Composition and hierarchy

- The eye can identify project, active task, current work and next action quickly.
- Controls and panels share a spacing/typography/radius system rather than unrelated defaults.
- Headers, tabs, context chips, action rows and menus align optically as well as mathematically.
- Avoid an oversized empty message bubble, a large diagnostic panel at idle, or repeated model/status labels.
- A small pane must remain useful. No horizontal overflow, clipped removal button, inaccessible composer or panel that expands beyond its allocated region.
- Empty, loading, error and completed states are designed states—not blank gaps or generic placeholders.

### Materials and color

- Neutral Graphite with violet accents is the current default; no green-dominated default.
- Glass should make layering clearer. It should not make text harder to read or produce needless GPU work.
- A surface declared translucent must actually be translucent; an opaque color mix with blur behind it is not meaningful glass.
- Use restrained static material effects on appropriate chrome/controls. Do not put gradients or continuously changing blur behind dense content.
- Native vibrancy must be implemented and tested at the host boundary before it is described as native. CSS approximation should look intentional with or without blur support.
- Semantic diff/status colors remain meaningful and accessible across themes.
- Theme customization survives reload and applies consistently; high contrast and reduced transparency are first-class designs.

### Interaction quality

- Clicking, keyboard activation, escape, focus restoration and disabled states all agree.
- An action reacts visibly without unnecessary delay. Animation does not postpone the operation.
- Streaming does not steal focus or scroll the user away from content they are reading.
- Expanding a tool, context reference, message or diff is reversible and its state persists where appropriate.
- Hover, selected, focused, pressed, loading, unavailable and error states are distinguishable without clutter.
- Hit targets and icon/text baselines are consistent. Narrow layouts wrap deliberately rather than shrinking every target beyond usability.
- Long names, long paths, Unicode, code blocks, browser labels and errors have an intentional overflow strategy.
- Shortcuts are additive and discoverable. Preserve established Cmd+P file navigation and Cmd+K inline editing; do not silently assign them unrelated meanings.

### Product language

- Use task/project/file names that match actual state.
- Say 'Stopping' until stopping is confirmed; distinguish queued, dispatched, running, disconnected and completed.
- Do not display fake counts, guessed model selections or a misleading zero for unknown data.
- Keep implementation details out of normal flow unless they help the user decide. Optional inspectors can expose the useful technical detail.
- Error messages say what failed and what remains safe or recoverable. Avoid generic failure toasts that hide the affected task.
- The UI must not imply a backend capability that is disabled or absent.

### Finish rubric for a feature review

Classify each component honestly:

1. **Draft:** code or mock exists; behavior/contracts incomplete.
2. **Integrated:** real host connection exists and focused technical checks pass.
3. **Human-verified:** happy/negative/edge and relevant layout/keyboard/performance flows pass on the intended artifact.
4. **Release-ready:** protected regressions pass, no unresolved blocking defect, evidence and recovery behavior are complete.

Do not advance a feature by aesthetic impression alone. A screenshot cannot prove cancellation or event ownership. A unit test cannot prove the interaction feels usable. The finish standard requires both.

## 24. Past work: retain it instead of starting over

This is the conceptual history of the current changes. Use it to understand why a piece exists before replacing it.

| Earlier problem | Work introduced | What the next owner must preserve |
|---|---|---|
| Chat/context state disappeared or became hard to inspect | Durable run/transcript metadata, draft/context retention, inspectors | Actual context identity, errors and unsent text must survive transitions |
| Long content was clipped and reading position unstable | Expansion, wrapping, saved disclosure state, follow-at-tail behavior | Full content remains accessible; automatic scrolling respects the reader |
| Duplicate context processing and repeated writes wasted work | Single expansion paths and unchanged-draft post deduplication | Do not restore repeated whole-history/state work through a new task grid |
| Dense activity UI hid the composer | Bounded internal scrolling, compact status, optional usage disclosure | Compact defaults and inspectable details without empty expanded panels |
| Context controls looked misaligned | Common 24px row controls, icon/removal boxes, wrapping/focus styles | Existing wide/narrow/remove/reload evidence is useful; keep these constraints |
| Parent and child events could contaminate each other | Core thread/turn filtering and persistent child observation | Child failure/text/usage must not complete or overwrite the parent |
| Parent completion could lose child lifetime/approvals | Shared lease kept until descendants settle, close guard, background observer | Do not release ownership or discard approvals while child work remains |
| Agent workspace UI accepted the wrong data shape | Authoritative agentWorkspace envelope and node-local receipts | Test real adapter output; do not invent graph-level receipt aliases |
| Browser navigation races could cancel or misreport a newer load | Navigation generations, waiters, timeout/redirect/error handling | Retain behavioral race tests when changing the browser shell |
| Task management depended on warm active sessions | Safe cold metadata queries and real history hydration | A user should manage/read a task without paying for an unrelated model turn |
| Native common controls were hard to discover | Go To hub and native command routing | Reuse the editor index/services instead of adding a second backend |
| Worktree management required other tools/windows | Git registry and native hub | Preserve dirty-source invariance; improve same-window UX only with scoped controllers |
| Glass styling was costly but visually opaque | Real translucency and accessibility fallbacks | Keep material semantics explicit and content opaque |
| A malicious sample patch broke fixture HTML | Safe inline JSON serialization | Test script context, not only DOM text escaping |
| Several same-named builds confused the user | QA identity/launcher work | Current build must be obvious, but identity changes did not fix the crash |
| Native QA crashed despite successful builds/signatures | Crash reports and bounded diagnostic work | Startup stability is still unresolved; do not bury it beneath more polish |
| User required true IDE task concurrency | Partial task registry/view contracts | Finish the interrupted work; do not claim it was implemented merely because files exist |

The preservation goal is not to freeze every implementation forever. A replacement is justified when it demonstrably improves the design and retains the tested behavior. Explain which old assumption is invalid, what replaces it and how compatibility is verified. Do not erase useful work simply because a new agent has a different preferred framework.

## 25. Re-invoking the same agents without throwing away context

### Preferred route: continue this exact task, change only the coordinator model

The original coordinator task is:

`01a095ef-a691-7dc0-aa8b-ea39201a2143`

The user can select Terra in the model selector for **this existing task**, then send the continuation prompt below. Keeping the same conversation is the best available way to retain its existing child-agent tree and history. Do not create a new task or fork merely to change the coordinator model.

Do not promise mathematically zero context loss: compaction, application restarts and runtime retention can affect what remains directly available. Durable files, exact contracts, evidence and checkpoint notes make recovery possible without repeating implementation.

### Original agent identities and owned context

| Existing target | Original model | Retained context / last assignment | Current handoff state |
|---|---|---|---|
| `/root/browser` | Luna High | Browser races, native integration, navigation, assembly, QA identity, memory baseline, startup SIGTRAP | Interrupted during bounded crash diagnosis; use existing reports/source, no fresh cosmetic rebuild loop |
| `/root/frontend` | Luna High | Renderer, context/scroll/expansion, themes/materials, alignment, compact usage, browser QA, task grid | Interrupted during task-workspace UI; earlier polish is implemented/fixture-tested |
| `/root/runtime` | Luna High | Core parent/child adapter, edit lifetime, task catalog controls, worktree hub, concurrency registry | Interrupted during task-runtime isolation; new registry not proven host-integrated |

Observed backing IDs, for identification only:

- Browser: `01a09962-25f4-7fe1-9198-3a7446bab35e`.
- Runtime: `01a09961-9680-7a52-8593-11f125a0932f`.
- Frontend backing thread ID was not verified in this handoff; **do not guess it**.

Use the collaboration agent targets in the existing tree. A previous attempt to send app-level input with a model override to a backing child ID returned `direct app-server input is not allowed for multi-agent v2 sub-agents`. Do not repeat that method or bypass it. The backing ID is not proof that normal app task-management tools can control that child.

### Exact supported continuation procedure

1. In this same coordinator task, inspect the collaboration agent inventory once.
2. If these agents are present, use the collaboration **followup-task** operation with their exact target names. That resumes an idle/interrupted agent and preserves its existing conversation, unlike creating a replacement.
3. If an agent is already working on the desired task, send a short coordination message instead of duplicating its assignment.
4. Do not send a message to a completed/idle agent and assume it starts work. Use followup-task for an actual new/resumed assignment.
5. Give only the current delta, relevant acceptance, ownership and checkpoint path. Do not paste this whole master document into all three agents.
6. Require the agent to report any mismatch between its remembered state and the actual files before editing. Source and evidence win over stale recollection.
7. If the original tree is unavailable, stop trying aliases/backing IDs. Read the corresponding durable lane checkpoint and create one replacement worker for that lane through the supported tool. State that it is a replacement rather than claiming its original conversation was preserved.

Tool names can vary by host, but the current session exposes the following operations. These examples are tool arguments, not shell commands:

```json
{"target":"/root/browser","message":"Resume your interrupted P0 startup-crash diagnosis. Read docs/TERRA-HANDOFF-2026-09-14.md section 4 and your existing memory/crash notes; preserve your earlier findings. Inspect existing fatal stderr/ASI and working-versus-QA bootstrap/native differences. One captured reproduction only if necessary; no repeated launches, identity tweaks or usage checks. Deliver an evidence-backed minimal fix or precise missing evidence. Do not touch the frontend/runtime owners' files."}
```

```json
{"target":"/root/runtime","message":"Resume your interrupted task-runtime-registry work using your retained context. Read section 6 of docs/TERRA-HANDOFF-2026-09-14.md and the current registry/tests; do not recreate the workspace hub. Resolve canonical worktree identity, collision risks, actual provider cwd and exact event/approval ownership. Coordinate one real producer/consumer contract with frontend. Keep unsafe parallel writes disabled until host integration and focused tests prove isolation. No usage checks, GUI work or recursive agents."}
```

```json
{"target":"/root/frontend","message":"Resume your interrupted IDE task-workspace UI using your retained context. Preserve the verified context alignment, compact usage, expansion and material fallbacks. Read the current task-workspace-view and runtime contract; build named grid/focused task views with actual capability gating, child messages and attributable diffs. Do not fake concurrent backend work. You are the sole GUI owner, but native testing remains paused until browser supplies a crash-fixed identified build. No usage checks or repeated passed tests."}
```

Do not automatically send all three prompts if only the crash lane is relevant to the current execution step. Parallelize only independent useful work with nonoverlapping ownership and explicit staging boundaries.

### Copy-ready same-task Terra continuation prompt

```text
Continue this existing task as Terra; do not start a new task or fork it. Preserve the current working tree and the original agent conversations.

Read docs/TERRA-HANDOFF-2026-09-14.md for current product intent, finish standard, required features and status. Read sections 1–6 and 21–25 first; do not reprocess every historical document.

Check whether /root/browser, /root/frontend and /root/runtime are still available. Reuse the relevant agents with followup_task, retaining their context and sending only the new delta. Do not use app-level send_message_to_thread on their backing IDs; that path was rejected for these multi-agent-v2 children. If an original agent cannot be recovered, use its lane checkpoint to create one clearly identified replacement without repeating its completed work.

You are the manager and integration lead. Delegate almost all research, tools, coding, builds and tests to Luna/Terra; use Sol only for a bounded hard problem or independent review. Do not check usage, poll quotas, use Orca or restart expensive redundant attempts. Do not claim that changing the coordinator model changed existing child models.

P0 is the native startup crash. The other main unfinished feature is real IDE-native task concurrency with named tasks, child messages and per-task full-file diffs. The existing new-window worktree hub is only interim. Keep shared-checkout writes safe, preserve all working realtime diff behavior, and require actual producer/consumer and native evidence.

The finish must be elegant, Mac-like, responsive, robust and measurably efficient—not a VS Code repaint or a terminal dashboard. Continue from the known changes and evidence. Ask necessary questions mid-conversation. Give precise retasks for actual gaps and never label partial or mocked work production-ready.
```

### When a new coordinator task is unavoidable

Attach or link this master handoff and the relevant lane checkpoint. Supply both repository paths and the actual dirty branch state. State that the original agents may not be addressable from the new tree. Read accessible task history only if a specific missing fact requires it; do not bulk-import every transcript. A fork or new task does not automatically transfer live subagent ownership or unfinished work.

The replacement worker should first produce a short reconciliation: 'These files already exist; these checks remain valid; this is the precise unfinished step.' It must not rebuild the project from scratch or trust old 'Done' statements without their scope.

## 26. Coordinator acceptance checklist before the next handoff

- The product intention and requested finish are still intact; no required feature was silently dropped.
- The current branch, dirty files, sibling dependency and artifact identity are recorded.
- The startup crash is fixed or explicitly remains a blocker with evidence.
- The task-runtime/grid state is described as implemented, integrated, tested or partial with exact limits.
- Full-file realtime diffs and context/approval ownership are protected by relevant evidence.
- Source checks, fixtures, native checks and real model checks are distinguished.
- Each active/interrupted agent has an exact target, current owner scope and a next action.
- No quota checks/polling or unrequested provider/orchestration changes were introduced.
- User-visible preview/current app corresponds to the claimed build; old copies are not mistaken for it.
- New findings update the durable checkpoint once instead of triggering a fresh whole-project plan.
- The user receives a concise report and links, while the next agent receives the detailed technical context needed to continue.

## 27. Liquid Glass — explicit user requirement, not an optional design footnote

The user specifically asked that this handoff mention **Liquid Glass**. Treat it as a defining part of the desired Mac-like product finish, alongside reliability, full-featured review and lightweight operation.

The user does not consider the current flat, dark, VS Code-shaped interface sufficiently finished. The intended result should feel like a deliberately designed Mac application: layered materials, floating controls, coherent depth, refined selection and transitions, and calm readable working content. Merely adding `backdrop-filter` to existing boxes does not satisfy that intention.

### What should receive the treatment

Prioritize a small, coherent family of reusable material components:

1. **Go To / command palette:** Spotlight-like floating panel, clear search field, comfortable rounded geometry, subtle edge highlight, refined selected row, depth over the underlying workspace, predictable keyboard focus and dismissal.
2. **Navigation and task controls:** selected tabs, task/workspace switches, compact segmented controls and appropriate title/header surfaces. Active task identity remains obvious across grid and focused views.
3. **Menus, popovers and settings sheets:** one consistent material, spacing, corner, shadow and focus system. No mixture of unrelated native-looking and default web dropdowns.
4. **Composer and context controls:** a coherent material container with aligned chips and controls, readable input, stable height and clear focused state. The material must not compromise attachment or text legibility.
5. **Task-workspace chrome:** restrained task headers, selection and focused-pane framing. Do not put a separate expensive animated glass effect behind every full transcript in a nine-card grid.

Code, complete diffs, long messages and dense file content should remain reliably readable on solid content surfaces. Liquid Glass is a control/navigation/depth system around the work; it is not a requirement to make every pixel transparent.

### Required visual behavior

- The material should visibly convey translucency and layering where appropriate, with a controlled tint and subtle rim/highlight rather than a thick border around a flat rectangle.
- Selection, elevation, rounding, spacing and typography must form one design language across the application.
- Hover, keyboard focus, press, selected, disabled, loading and inactive-window states need coherent treatment.
- Motion should make a panel opening, selection or focus change understandable. It must not delay the action, animate large blur regions continuously, or draw attention away from streaming work.
- The visual direction is neutral Graphite/violet by default, with the other customizable palettes retained. The user rejected a green-dominated default.
- A material setting should be understandable and persist. Users must be able to choose a solid appearance; OS accessibility preferences take precedence over decorative effects.

### Native capability versus approximation

The next engineer must explicitly distinguish these implementation levels:

| Level | Meaning | How to describe it |
|---|---|---|
| Solid fallback | Deliberate opaque surface with equivalent hierarchy, focus and contrast | Solid / reduced transparency |
| Web material | CSS translucency, backdrop filtering, rim, selection and shadows | Glass-inspired CSS material; do not call it native Liquid Glass |
| Native host material | Verified supported macOS/Electron/AppKit composition through an owned host integration | Name the actual native material capability implemented and tested |
| Native Liquid Glass | Genuine use of the applicable supported platform capability, with evidence on the target OS/runtime | Only claim native Liquid Glass after it really exists and passes QA |

Research the target macOS version, Electron version and documented APIs before choosing the native path. Native vibrancy is not automatically identical to Apple's Liquid Glass. Do not use private frameworks, spoofed host identity or unsupported bundle hooks to claim parity. If the current shell cannot supply the desired native effect, document the exact limitation, build an honest approximation for the interim, and keep the native requirement as an explicit engineering item rather than silently redefining it as complete.

The existing decision document recommends vanilla material tokens for the current webview and a separately owned host investigation for native materials. That recommendation is an implementation starting point, **not permission to dilute the user's Liquid Glass requirement**. A richer library is justified only when it provides a concrete benefit that cannot be achieved cleanly with the existing stack; research its bundle/runtime cost and accessibility before adoption.

### Lightweight and accessibility requirements

- No new UI framework or dependency solely to obtain a blur utility.
- No continuous animation, high-frequency pointer-driven refraction, or full-window shader loop as a default decoration without a demonstrated performance budget.
- Keep the number and area of active blurred surfaces bounded, especially in multi-task mode.
- Compare the same actual workload before/after material changes: idle app, opening the palette, typing, streaming, scrolling a long transcript/full diff, switching tasks and opening several task cards.
- Report observed CPU/GPU/process-memory/interaction effects with their measurement limits. Do not invent savings or infer physical RAM from an unqualified RSS sum.
- Reduced Transparency, Reduce Motion, forced colors, high contrast, unsupported backdrops and non-Mac platforms need a polished solid fallback. Essential state must remain visible without blur, motion or color alone.
- Test both bright and dark backgrounds where native transparency is used, active/inactive window states, light/dark themes, narrow panes, keyboard focus and text contrast.

### Liquid Glass acceptance gate

The feature is not finished until:

1. The actual staged application—not only an offline browser mock—shows the agreed material/interaction treatment on the intended surfaces.
2. Its implementation is identified honestly as CSS, native vibrancy or genuine native Liquid Glass.
3. The palette, task controls, menus/popovers and composer look like parts of the same product.
4. Typing, task switching, streaming and full-file diff review remain smooth and functionally correct.
5. Solid/accessibility variants are intentional and tested.
6. Measured resource use does not introduce an unexplained regression.
7. The native startup crash and other stop-ship defects are resolved; attractive material effects cannot waive those gates.

### Copy-ready Liquid Glass task brief

```text
Liquid Glass is an explicit product requirement from the owner. Deliver a coherent Mac-like material system, not an opaque recolor of VS Code. Start with the Go To palette, navigation/segmented task controls, menus/popovers/sheets and composer/context container. Keep code, full diffs and dense transcript content readable and opaque.

Read docs/TERRA-HANDOFF-2026-09-14.md section 27 and the existing liquid-glass-decision.md. Verify the target runtime's supported native capabilities through primary docs; distinguish native Liquid Glass, native vibrancy and a CSS approximation honestly. Do not install a large UI library or introduce private native APIs without a concrete justified need.

Define reusable material tokens and component states; preserve Graphite/violet defaults and customizable themes. Provide polished solid, reduced-transparency, reduced-motion and high-contrast fallbacks. Avoid continuous blur/refraction animations and unbounded per-card rendering cost.

Coordinate with the native-shell owner and do not modify a running or known-crashing build. Produce one coherent implemented direction, compare its actual interaction/resource behavior against the same baseline, and validate it in the staged app. Do not call the feature complete from a screenshot, a CSS property or a library demo alone.
```

## 28. Interaction and polish atlas: what to copy from Cursor, Codex and T3 Code

The owner asked to pick interactions and nuances from Codex, T3 Code, and Cursor: transitions, effortlessness, polish, completeness. Do not re-clone or re-read those trees unless this section and the atlas conflict with current `packages/builtin/src`.

**Companion (implementation-ready):** `docs/quality/2026-09-15/interaction-atlas.md` — transcript anatomy, streaming semantics, composer/slash/@, motion tokens, color/material, computer/browser-use gaps, a 40-item checklist, and a P0/P1/P2 backlog mapped to Muster files.

**Existing Cursor docs (do not duplicate):** `docs/cursor-ux-spec.md`, `docs/cursor-feature-atlas.md`, `docs/cursor-gap-analysis.md` (2026-09-06; several rows are stale), `docs/cursor-parity-spec.md`, `docs/quality/2026-09-13/ide-parity.md`. Voice/CUA boundary remains section 8 and `docs/quality/2026-09-13/host-capabilities.md`. Liquid Glass remains section 27.

### What to copy (short)

| Surface | Copy from | Muster note |
|---|---|---|
| Grouped tool summaries (`Explored 3 files, 1 search`), command cards (icon, human title, muted argv, clipped output), `Thought Ns` disclosure, mode/model pills, Stop | Cursor 3.x chat (owner screenshots 2026-09-15) + `cursor-ux-spec.md` §4 | Today: flat `.tool` rows, summary always “Reasoning summary”, no duration (`agent-view.ts`) |
| Incremental markdown (stable fenced prefix), incremental highlight, follow-vs-read scroll, human tool verbs, `![alt](screenshotPath)` visualize loop, slash-at-start vs skills anywhere, 150ms ease-out motion | T3 `/tmp/t3code` — see atlas citations | Today: full `innerHTML` flush per rAF (`agent-polish.ts`); local images not rendered |
| Account-backed CUA | Codex host plugin/MCP only | Private `ComputerUseIPC*` / native pipe is **out of bounds** (section 8) |
| Browser computer-use | Muster MCP `browser_*` in `browser-mcp.ts` (20 tools as of this handoff) shaped like T3 `preview_*` | Recording, desktop snapshot, device toolkit still missing; screenshot **save → inline image** is the P0 visualize gap |

### Motion (single Muster table)

`--motion-fast` 120ms, `--motion-ui` 160ms ease-out, `--motion-panel` 180ms, `--motion-ack` 1000ms; `prefers-reduced-motion` → 0ms. Do not copy T3’s 600ms streaming opacity fade. No springs (T3 `apps/web/src` has none). Details in the atlas §D.

### P0 for the next engineer (files)

1. Prefix-stable streaming — `agent-view.ts`, `agent-polish.ts`
2. Render `![alt](path)` — `agent-view.ts` (CSP already allows images)
3. Thought duration + tool group copy — `agent-view.ts`
4. Follow-scroll must not move a reader who scrolled up — `agent-polish.ts` (60px band already exists; protect every `scroll()` call)
5. Visualize loop: `browser_screenshot` `save:true` already returns `screenshotPath` (`browser-tools.ts`); the chat must display the embed

Acceptance: the atlas §G checklist, not a screenshot of a mock.
