# Integrated acceptance plan

Only test a stable staged build. Reuse one scenario's evidence across the relevant cards; do not rerun an unaffected scenario. A fix invalidates only checks that exercise its changed contract. Automated behavioral tests complement, but do not replace, normal user/operator flow evidence.

| Scenario | Cards | Normal/happy path | Negative and edge path | Regression/stress | Required evidence |
|---|---|---|---|---|---|
| Q1 Composer/context/inference | 101,103,104,201,203 | Type prompt; attach file, filename with spaces, folder; return known markers; inspect included context | Empty submit, missing ref, Unicode/IME, long message, draft/task switch, remove attachment | Large message, repeated context references, midstream switch; no typing/scroll interference | Exact entered text, inferred markers, shelf/inspector, elapsed/context availability, replay state |
| Q2 Realtime edits | 102,202,401 | Prompt edits across a 500-line file and a second file; review whole-file diff while streaming | Decline proposed change; preserve dirty buffer; cancel mid-patch; add/delete/move; undo | Both review modes, both editor layouts, full-file tails, rapid chunks | Native screenshots, file contents/git diff, retained dirty marker, applied/undone outcome |
| Q3 Browser to source | 103,203,301,302 | Navigate fixture; pick element; edit text/style; attach to chat; apply to local source; reload | Invalid URL, refused port, missing page, redirect, subframe failure, stale tab, take control | Back/forward, overlapping navigation, screenshot context, tab switch/reopen | Browser state, snapshot/ref in composer, actual local source diff, final rendered result |
| Q4 Theme/accessibility | 201,202,203,401 | Select each of five palettes, text size, density, custom accent; reset | Invalid accent, bounds, narrow panel, keyboard-only navigation | Theme switching during retained messages/diff, reduced motion, zoom | Native settings/actions, persisted choices, readable semantic diff colors; no hidden essential controls |
| Q5 Managed terminals | 501 | Create/reveal task terminal; enter harmless command; inspect/search output | Empty text, stale/closed terminal, mismatched task reuse, missing directory | Large bounded output, repeat open/close, preserve native shell behavior | Native terminal/output, command and task identity, status/search result |
| Q6 Recovery | 101,102,104,201 | Reload completed task and reopen full activity/usage | Reload/disconnect during a dispatched task; do not replay writes automatically | Queue/remove/stop, pending approval ownership; event duplicate/late arrival | Explicit run state, stable transcript, provider dispatch/turn identity, no duplicate filesystem action |
| Q7 Interaction stress | 201,203,301,303 | Use browser console and chat while output arrives | Failed load during activity; close loading tab | 450 console messages, large DOM/text, 500-line diff, rapid stream fragments; typing and scroll remain usable | Defined input size/event count, latency observations, bounded collections, absence of hangs/errors |

Test workspace: `/tmp/muster-qa-20260913`. Isolated app profile: `/tmp/muster-qa-profile-20260913`. No real project files are modified by inference tests. Provider model/effort are explicit. Usage is sampled at milestone boundaries, not per interaction.

Baseline real inference: submitted “Reply with READY only. Do not use tools.” through native composer; received “READY”; native run completed in 7 seconds. This baseline does not certify later agent changes.

## Expanded primary workflows

Q8 Agent workspace: real user-typed delegation with two bounded Luna workers; inspect hierarchy, task prompts, parent↔child messages, status, per-agent changes/usage; test supported steer/stop, duplicate/late events, failed child, reopen and large child/event lists. Distinguish observed provider state from client-managed state.

Q9 Thread management: real catalog search/filter/pagination, empty search, invalid/stale IDs, pin/rename/archive/restore/fork/open, cross-project scope explicitly selected, active/archived state and history continuity. Never delete the user’s existing threads for QA.
