# Muster IDE execution Kanban

Full Codex/Cursor replacement IDE: thread/project management and real agent orchestration are primary, with preserved editing/browser/terminal workflows.

No feature is Done until parent live QA and applicable tests have evidence. An N/A requires a reason.

| ID | Priority | Status | Owner | Outcome | Dependencies |
|---|---|---|---|---|---|
| MC-001 | P0 | QA | Orchestrator | Baseline staged app and release contract | None |
| MC-101 | P0 | QA | runtime | Durable activity and recoverable runs | MC-001 |
| MC-102 | P0 | QA | runtime | Approval, checkpoint and queue correctness | MC-001 |
| MC-103 | P1 | QA | runtime | Exact context metadata and attachment reliability | MC-001 |
| MC-104 | P1 | QA | runtime | Reported per-turn usage ledger | MC-101 |
| MC-201 | P0 | QA | frontend | Chat interactions, long content and rendering | MC-001 |
| MC-202 | P1 | QA | frontend | Customizable themes and icons | MC-001 |
| MC-203 | P1 | In Progress | frontend | Context, activity and usage inspection UI | MC-101, MC-103, MC-104 |
| MC-301 | P0 | QA | browser | Browser navigation and diagnostics | MC-001 |
| MC-302 | P1 | QA | browser | Browser picks, visual edits and context handoff | MC-301, MC-103 |
| MC-303 | P1 | QA | browser | Browser stress and lifecycle cleanup | MC-301 |
| MC-401 | P0 | QA | Orchestrator | Realtime full-file and multi-file diff regression gate | MC-102, MC-202 |
| MC-501 | P1 | QA | browser (terminal wave) | Agent-owned terminal workspace | MC-101 |
| MC-601 | P2 | Design | Unassigned Luna High | Independent agent workspaces | MC-102, MC-401 |
| MC-701 | P0 | Ready | Orchestrator | Integrated human-flow and stress acceptance | All implementation cards |
| MC-801 | P0 | In Progress | runtime | Real agent orchestration and event graph | MC-101, MC-102 |
| MC-802 | P0 | In Progress | frontend | Agent workspace and sub-agent screen | MC-801 |
| MC-803 | P0 | In Progress | browser (threads wave) | Codex-grade thread and project management | MC-101 |
| MC-804 | P1 | In Progress | frontend | Evidence-backed IDE/harness parity matrix | None |
| MC-805 | P0 | Ready | Orchestrator | End-to-end agent and thread workflow gate | MC-801, MC-802, MC-803 |

[Interactive board](kanban.html) · [Authoritative criteria and checks](kanban.json) · [Acceptance plan](qa-plan.md)
