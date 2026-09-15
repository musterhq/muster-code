# Native QA memory and artifact baseline · 14 September 2026

## Capture

Captured on 2026-09-14 around 12:52 IST with bounded `ps` RSS inspection while the existing fixed-workspace Muster process was idle/active in its native app. Command:

```sh
ps -axo pid=,ppid=,rss=,etime=,command=
```

The release process tree rooted at PID 74683 was:

| Process role | PID | RSS KB |
|---|---:|---:|
| Main | 74683 | 156,288 |
| GPU helper | 74688 | 82,480 |
| Network helper | 74689 | 47,728 |
| Renderer | 74690 | 133,760 |
| Extension/plugin host | 74705 | 83,376 |
| Renderer | 74706 | 96,512 |
| Utility | 74707 | 69,392 |
| Utility | 74708 | 65,904 |
| **Direct tree total** | **8 processes** | **735,440 KB (~718 MiB)** |

This is RSS, so shared Electron framework pages may be counted in more than one process. It is not a proof of unique physical memory or a full system-memory total. The command excluded ChatGPT, Codex harness, unrelated apps, and crashed QA processes; no QA process remained alive at capture.

The active release tree was `/Users/dhairya/Documents/Codex/2026-04-23-openclaw-docs-live-users-pavankumarmarwaha-codex/muster-code/dist/Muster Code.app` using `/Users/dhairya/Library/Application Support/Muster Code`. No installed or running app was killed or modified by this capture.

## Artifact identity

Current source bundle:

`/Users/dhairya/Documents/Codex/2026-04-23-openclaw-docs-live-users-pavankumarmarwaha-codex/muster-code/dist/integration-20260914/Muster Code.app`

Its copied QA launch artifacts are preserved:

- `/tmp/Muster Code QA 20260914.app` — earlier QA identity; crashed.
- `/tmp/Muster Code Current QA 20260914b.app` — latest QA copy with `dev.themuster.code.qa` and `muster-code-qa-20260914` product identity; crashed at 12:51:55 IST.
- `/tmp/muster-qa-current-20260914-profile-b` and `/tmp/muster-qa-current-20260914-workspace-b` — disposable paths; no user data.

Bundle disk sizes observed: `dist/Muster Code.app` 597 MB, `dist/verified/Muster Code.app` 599 MB, `dist/integration-20260914/Muster Code.app` 600 MB, and the earlier QA copy 599 MB. These are preserved artifacts, not simultaneous RSS measurements. The current launcher identity is documented in `docs/quality/2026-09-13/qa-launcher.md`; it uses a distinct QA bundle/product identity and existing app assets without changing older bundles or LaunchServices.

## Crash gate

The latest local report is `/Users/dhairya/Library/Logs/DiagnosticReports/Muster Code-2026-09-14-125732.ips`; earlier matching reports include `125158`, `124708`, `124058`, `123931`, and `114901`. The latest process path is `/private/tmp/Muster Code Current QA 20260914b.app/Contents/MacOS/Muster Code`, version `1.126.04524`, bundle ID `dev.themuster.code.qa`. It terminates with `EXC_BREAKPOINT/SIGTRAP`, signal code 5, on the main thread. The repeated top stack is `v8::ValueSerializer::Delegate::GetWasmModuleTransferId` through `node::PrincipalRealm::timers_callback_function`, `ElectronMain`, and `start`; the report has no fatal ASI string or code-signing termination reason. `codesign --verify --deep --strict` passes for the source and QA copies, with matching ad-hoc/no-entitlement status. A single authorized observed CLI reproduction captured empty stdout/stderr at `/tmp/muster-qa-crash-20260914.stdout` and `/tmp/muster-qa-crash-20260914.stderr`, exited 0, and still produced the `125732` report; no further relaunches are planned.

The same native frame appears across all QA reports. Making the QA `product.json` application/data identity unique did not prevent the 12:51 or 12:57 crashes, so singleton collision is not established as the cause. Unsigned main executable hashes are identical across `dist`, `dist/verified`, `dist/integration-20260914`, and both QA copies (`d76c0730…`); Electron Framework and helper executables also match. Removing the injected `/*muster-browser*/…/*muster-browser:end*/` block from `out/main.js` produces identical outside-block SHA-256 content for the stable and integration builds (`310fd05d…`). The stable and integration main files differ only in that injected browser module block at this boundary; the workbench/extension resources are separate renderer/extension inputs. The browser block executes only Electron import, map/set/function definitions, and `ipcMain.handle` registration during startup; navigation/view operations are inside callbacks. This narrows the comparison to that block/bootstrap and Electron startup path, but does not prove the stripped native symbol is application JavaScript. No further QA relaunch or cosmetic identity mutation should happen until this deterministic Electron/Node startup crash has an evidence-backed fix.

The controlled binary search isolates the current browser block revision as the actionable resource delta. A disposable copy of the integration app with only that block removed (`/tmp/Muster Code Probe No Browser 20260914.app`, main-file SHA-256 `310fd05d453e263038a2886cbf1ae61a33477d2d7829c3128e09a69d97e7e2ee`) was launched once with profile `/tmp/muster-qa-probe-20260914-profile` and workspace `/tmp/muster-qa-probe-20260914-workspace`; its root PID 86605 and children remained alive after 2:29, with empty captured stdout/stderr and no new report. A second disposable copy restored the stable browser block from the existing release (`/tmp/Muster Code Probe Stable Browser 20260914.app`, main-file SHA-256 `46d9506dd840a9570e366464d38a8b330f5feeb62066ebe7c7b4745266fae5c3`) and remained alive at root PID 86786 after 1:48, using profile `/tmp/muster-qa-probe-stable-20260914-profile` and workspace `/tmp/muster-qa-probe-stable-20260914-workspace`, again with empty stdout/stderr and no new report. The integration browser block is 11,761 bytes versus the stable block's 8,018 bytes; its outside-block content is unchanged. This proves a startup-sensitive difference inside the revised browser block, while the reports provide no safe statement identifying a particular JavaScript construct or native root cause. Do not revert or relaunch automatically: next safe step is an offline source-level bisection of that block (or a minimal feature flag excluding only revised registration) followed by one controlled launch per candidate, preserving these probe copies.

The next narrowed candidate deferred only the revised block's unconditional `ipcMain.handle` registration with `setImmediate`, leaving the handler closure and all browser operations intact. Its disposable copy (`/tmp/Muster Code Probe Deferred Browser 20260914.app`) retained the integration app's original `muster-code`/`.muster-code` product identity; it was launched once with profile `/tmp/muster-qa-probe-deferred-20260914-profile` and workspace `/tmp/muster-qa-probe-deferred-20260914-workspace`, and root PID 89275 with its Electron children remained alive after 17:09. This did not establish a registration fix because it did not exercise the QA identity boundary. A fresh staged app (`dist/integration-20260914-crashfix/Muster Code.app`) was copied once by `scripts/dev/launch-qa.sh` to `/tmp/Muster Code Crashfix QA 20260914.app`, which rewrote identity to `muster-code-qa-20260914`/`dev.themuster.code.qa`; with profile `/tmp/muster-qa-crashfix-20260914-profile` and workspace `/tmp/muster-qa-crashfix-20260914-workspace`, it reproduced the SIGTRAP immediately. The authoritative new report is `/Users/dhairya/Library/Logs/DiagnosticReports/Muster Code-2026-09-14-134349.ips`, with empty captured output at `/tmp/muster-qa-crashfix-20260914.stdout` and `/tmp/muster-qa-crashfix-20260914.stderr`. The unproven source deferral was removed; browser source/tests are back to their pre-candidate behavior. The crash gate remains blocked at the QA product/bundle identity or copied-app boundary, and the failed staged artifact/report are preserved for a same-identity control before any further launch.

That same-identity control was performed once after approval. The exact staged app was copied untouched to `/tmp/Muster Code Probe Current OriginalID 20260914.app`; its original `dev.themuster.code`, `muster-code`, and `.muster-code` identity was verified, with fresh profile `/tmp/muster-qa-originalid-20260914-profile` and workspace `/tmp/muster-qa-originalid-20260914-workspace`. Its real CLI was invoked once with `--new-window`; captured stdout/stderr are both empty, root PID 94664 and its GPU/network/renderer/utility/plugin children remained alive after 44 seconds, and no diagnostic report was emitted. The copied `out/main.js` SHA-256 matches the staged source (`319e566e…`). This rules against the browser block and current extension resources as a sufficient startup cause under the original identity and focuses the remaining failure on QA identity mutation, helper identity/signing, or the launcher-specific copy/signing boundary. The QA crash artifact and report remain preserved; no further relaunch is planned in this lane.

The launcher fix removes those identity and re-sign mutations from `scripts/dev/launch-qa.sh`. It now requires a fresh profile, copies with `ditto`, byte-checks root/product/CLI/main-executable/signature checkpoints plus every Electron helper bundle, verifies the copied signature, and only then launches with the caller's explicit profile/workspace and `--new-window`. Copy-only validation (`MUSTER_QA_VALIDATE_ONLY=1`) passed once against `/tmp/Muster Code QA Validate 20260914.app`; root `Info.plist` and `product.json` hashes matched the staged source exactly (`fb88fbe6…` and `1f0e32c7…`), with original `dev.themuster.code`/`muster-code`/`.muster-code` retained and no process launched. The prior crash artifact remains untouched. The next safe native QA invocation is the documented launcher with a new app/profile/workspace path; do not reuse the crashed QA copy or its profile.

The fixed launcher was then invoked once with the fresh paths `/tmp/Muster Code QA Fixed 20260914.app`, `/tmp/muster-qa-fixed-20260914-profile`, and `/tmp/muster-qa-fixed-20260914-workspace`. It preserved `dev.themuster.code`, `muster-code`, and `.muster-code`; captured stdout/stderr are `/tmp/muster-qa-fixed-20260914.stdout` and `/tmp/muster-qa-fixed-20260914.stderr` (no stderr), and the root PID 96804 with GPU, network, renderer, utility, and plugin children remained alive after 16 seconds. No new diagnostic report was emitted. This is the current disposable native QA artifact for frontend's one focused idle/task-workspace flow pass; it must not be confused with the earlier mutated QA copies.

No startup/polling optimization is claimed: current low-frequency timers and browser polling remain feature-sensitive, and the crash occurs before a reliable application workload baseline can be compared. A future comparison should capture the same fixed workspace, native browser state, extension host, GPU/network helpers, and any CLI process separately, then report RSS with the shared-memory limitation above.
