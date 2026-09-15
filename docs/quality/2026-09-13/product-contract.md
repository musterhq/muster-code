# Muster IDE product contract

The target is a replacement for the user’s daily Codex and Cursor workflow, not merely a chat/diff feature. Primary flows include thread/project management, agent spawning, a sub-agent workspace, inspecting each agent’s assignment/status/messages/changes, parent-to-child communication, interruption/steering, context/files/folders/browser handoff, and integrated terminals.

Graphite is the default visual direction. Other themes stay customizable. Existing realtime/full-file diff behavior is protected.

Every control must operate on actual runtime objects or state clearly that the capability is unavailable. Fork relations, native spawned-agent relations and client-managed worker relations must be distinguished. Never label a local chat tab as a provider-spawned child without evidence.

Keep usage-conscious execution: Luna High implements; parent orchestrates/reviews/live-tests. No recursive delegation or repeated broad passes. Milestone usage samples only. Reuse acceptance evidence for unaffected features; retest concrete failures after the relevant fix.

No whole-product completion claim until applicable normal, happy, negative, edge, context-latency, interaction, UI-regression, regression and stress checks have evidence. Unknown or externally blocked capabilities remain open on the board.
