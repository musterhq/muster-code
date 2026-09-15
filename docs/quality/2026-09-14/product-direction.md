# Muster Code product and delivery contract

Muster should make agent-led work easier to understand and control while keeping code and complete diffs close at hand. Its value is durable task context, visible delegation and messages, coherent project/worktree ownership, and direct everyday controls. A different color scheme alone does not establish that value.

The editor core remains in place while its surrounding interaction model is simplified. The current release must preserve full-file realtime diff behavior, keyboard editing, terminals, language tooling, and extensions. Replacing Code-OSS with a different editor runtime is a separate measured architectural decision, not an incidental visual change.

## Interaction rules

- One discoverable Go To surface routes files, symbols, lines, tasks, terminals, browser, review, appearance and word wrap; no second file index. Existing familiar file navigation and inline-edit shortcuts keep their meaning.
- Code and full diffs remain available throughout agent work. Chat patch previews default open for this user, with explicit collapse state retained. A chat preview never substitutes for the full-file review surface.
- Context chips survive task switching and reload. Expanding an inspector must not hide the composer. Errors preserve the draft and show which action failed.
- Graphite and violet are default. Five palettes remain available. Glass is limited to isolated chrome, uses subtle transparency, and becomes opaque for reduced transparency, high contrast or unsupported filters. No animated blur behind transcript text.
- Small transitions acknowledge state changes without delaying controls; reduced motion disables decorative motion. Keyboard focus, escape, return-to-source and text wrapping are core flows, not settings archaeology.
- Worktrees open in separate Muster windows initially to preserve per-window live-edit ownership. No concurrent edits through the existing single controller. No automatic merge, discarded dirty work, or inferred replay of failed writes.

## Performance and verification

Measure cold/open/idle resource behavior separately from active inference. External browser/platform stalls are recorded separately from product regressions. Do not compare a full Electron IDE against PX0 self-reported read-only benchmarks as equivalent workloads.

Keep local state writes bounded and avoid whole-transcript persistence for unchanged draft events. Polling, model calls and service discovery must have a concrete consumer; no hidden per-keystroke model requests, startup worktree enumeration loops or duplicate indexing.

Each changed feature needs applicable happy, negative, edge, normal human, context latency, interaction, visual regression, functional regression and stress evidence. Record N/A only with a concrete reason. Existing passing checks are retained until the changed dependency makes them stale. Prefer one integrated build and targeted retests of observed failures. Fixture checks establish component behavior; native API, microphone, actual model and full-file diff checks require the staged desktop app.

## Model allocation

Direct Luna High is the default engineering lane because the existing batch passed 69 built-in checks with that workflow, and a larger model is not needed for every edit. The coordinator reviews contracts, finds missing cases, integrates and tests through the UI. Escalate a specific failed design or repair to a stronger model only after a precise retask fails; do not raise all workers or run duplicate implementations.

Subscription usage is account-wide, not a per-task cash price. The latest checkpoint is 22% used / 78% remaining. Do not attribute the whole change to this task. Spark currently reports its short window exhausted, so it is not the active implementation choice. No reset credit was redeemed.

The aborted routed trials demonstrated an unknown-model metadata fallback: a 121,600 effective context window was almost entirely consumed by startup context. Avoid repeating that experiment. User canceled the Orca requirement; new implementation uses direct collaboration agents, not another router/harness loop.
