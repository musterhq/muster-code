# Provider connections

## MUS-SPEC-02-678A — Router completions with partial usage metadata

- **Precondition:** Two independent chats use a configured Responses provider authenticated by a credential helper. The router sends completed responses whose input-token details omit `cached_tokens`.
- **Action:** Send two successive messages in each chat through Muster's provider adapter and the real coding client.
- **Expected result:** Every turn completes with its answer and no reconnect notification. Each turn sends one authenticated request; the two chats retain distinct thread identities. Existing nonzero cache and reasoning usage counts are preserved.
- **Test:** `packages/agent-app/tests/router-usage-workflow.test.ts` — `router usage compatibility: two independent chats complete successive turns without reconnecting`
- **Environment:** Local mock Responses router and installed coding client; no remote account required.
- **Known gaps:** Does not assert upstream provider availability or repair provider-owned signed thinking history. Transport-proxy configurations retain their original connection path and are not normalized.
- **Evidence:** 2026-10-23, unchanged main: both linked workflow cases fail with `missing field cached_tokens`; implementation: 2/2 pass with the installed client, 0 skipped. Receipts: `~/.muster-work/review/678/red.log` and `green.log`. Four isolated live turns across Advisor and Intelligent Planner also completed without reconnects.

## MUS-SPEC-02-678B — Genuine stream failures remain failures after compatibility handling

- **Precondition:** A configured Responses router has completed one turn with partial usage metadata, then ends the next stream without a terminal event.
- **Action:** Send the next message in the same chat through Muster's provider adapter and the real coding client.
- **Expected result:** The first turn completes without reconnecting. The truncated turn fails and is never reported as completed; an explicit terminal event is required. Requests remain authenticated and retain the selected model.
- **Test:** `packages/agent-app/tests/router-usage-workflow.test.ts` — `router usage compatibility: a genuinely truncated stream still fails`
- **Environment:** Local mock Responses router and installed coding client; no remote account required.
- **Known gaps:** Does not cover arbitrary malformed upstream event schemas.
- **Evidence:** 2026-10-23, unchanged main: fails on the initial completed response with `missing field cached_tokens`; implementation: the first turn completes and the genuinely truncated second turn fails, preserving thread identity. Receipts: `~/.muster-work/review/678/red.log` and `green.log`.
