# Muster specification

This folder is the specification of Muster: what the app does, area by area, and the tests that prove it. Every fix and feature starts here and is finished when its cases pass.

## How to read it

- The spec is split into one **clause file** per product area, in [`clauses/`](clauses/). Each starts with a short plain-words description of the area: what the user can do and where its boundaries are.
- Below that, under `## Acceptance cases`, each checkable behaviour is an **acceptance case** with a stable ID such as `MUS-SPEC-04-1A`. A case says what is set up, what is done, what must be true afterwards, which test proves it, and what that test does not show.
- Clause IDs are `MUS-SPEC-01` to `MUS-SPEC-22`. A case ID adds a topic group number and a letter: `MUS-SPEC-<NN>-<n><L>`. IDs are never reused or renumbered.
- [acceptance-cases.md](acceptance-cases.md) has the authoring rules and the case template. [test-traceability.md](test-traceability.md) is an index only: it lists the clauses that have cases.
- `node scripts/check-spec.mjs` checks the case schema, the test links both ways and the index rows. It runs in CI.
- A link is not coverage. A case whose test was not run on the exact head is `UNVERIFIED`.

## The order

Every change follows these steps, in one PR:

1. **Cases first.** Write or edit the acceptance cases in the clause file for the area, with `Evidence: UNVERIFIED`. This is the specification of the change.
2. **Failing tests.** Write the tests the cases name, each with its `// Spec:` comment directly above the `test(` call. Run them and record the real RED output: command, failure, commit. Don't invent a test-first history.
3. **Code.** Write the change until the same tests pass, unchanged. Record the real GREEN output. If a test has to change, the case changes first.
4. **One PR.** The case, the test and the code land together. The PR body lists each affected case ID with its result on the exact head (command, exit code, counts, commit SHA), or `UNVERIFIED`.
5. **Review.** The reviewer reads the case first, then checks that the test's assertions match the Expected result and that the Known gaps are honest. A link or a green check on another head is not a pass.

Anything visible also gets before and after screenshots from the real components or the app.

## What counts as a test of a case

A test proves what the user experiences. It drives the same path the user does:

- **Runtime behaviour.** Use the agent service with a fake provider: send a message, stop, restart, hit a limit. Then assert on what the user sees: timeline rows, queued messages, notices, files on disk.
- **UI behaviour.** Render the real components in a DOM suite (`tests/*.tsx`, run by `scripts/test-renderer.mjs`). Click, type and press keys, then assert on what is on screen. Wrap each linked behaviour in a named `check()` (see [acceptance-cases.md](acceptance-cases.md#dom-suites-named-checks)).
- **Main-process and IPC behaviour.** Call the real handler with real files in a temp folder.

These don't count:

- a test that already passes on `main` (it doesn't prove the change);
- asserting on a private helper's return value when the user-facing path is testable;
- mocking the unit under test, or asserting only that a mock was called;
- a snapshot with no assertion about behaviour.

A unit test for a tricky pure function, such as a parser or a regex, is welcome in addition to the workflow tests, never instead of them. When a case can only be tested at that level, say so in its Known gaps.

## Clause index

| ID | Area | Clause file |
|---|---|---|
| `MUS-SPEC-01` | Chat and composer | [01-chat-and-composer.md](clauses/01-chat-and-composer.md) |
| `MUS-SPEC-02` | Turns, streaming and the message queue | [02-turns-streaming-and-queue.md](clauses/02-turns-streaming-and-queue.md) |
| `MUS-SPEC-03` | Providers, models and accounts | [03-providers-models-and-accounts.md](clauses/03-providers-models-and-accounts.md) |
| `MUS-SPEC-04` | Context window and compaction | [04-context-window-and-compaction.md](clauses/04-context-window-and-compaction.md) |
| `MUS-SPEC-05` | Access modes, approvals and tool permissions | [05-access-modes-and-approvals.md](clauses/05-access-modes-and-approvals.md) |
| `MUS-SPEC-06` | Sandbox and scoped computers | [06-sandbox.md](clauses/06-sandbox.md) |
| `MUS-SPEC-07` | Files, editor and search | [07-files-editor-and-search.md](clauses/07-files-editor-and-search.md) |
| `MUS-SPEC-08` | Git, changes and review | [08-git-changes-and-review.md](clauses/08-git-changes-and-review.md) |
| `MUS-SPEC-09` | Browser and previews | [09-browser-and-previews.md](clauses/09-browser-and-previews.md) |
| `MUS-SPEC-10` | Terminal and background processes | [10-terminal-and-processes.md](clauses/10-terminal-and-processes.md) |
| `MUS-SPEC-11` | Memory | [11-memory.md](clauses/11-memory.md) |
| `MUS-SPEC-12` | Projects, orgs, tasks and check-out | [12-projects-orgs-and-tasks.md](clauses/12-projects-orgs-and-tasks.md) |
| `MUS-SPEC-13` | Muster Server | [13-muster-server.md](clauses/13-muster-server.md) |
| `MUS-SPEC-14` | Sub-agents, skills, plugins and automations | [14-agents-skills-plugins-and-automations.md](clauses/14-agents-skills-plugins-and-automations.md) |
| `MUS-SPEC-15` | Settings and themes | [15-settings-and-themes.md](clauses/15-settings-and-themes.md) |
| `MUS-SPEC-16` | Notifications and attention | [16-notifications-and-attention.md](clauses/16-notifications-and-attention.md) |
| `MUS-SPEC-17` | Usage, cost and the ledger | [17-usage-cost-and-ledger.md](clauses/17-usage-cost-and-ledger.md) |
| `MUS-SPEC-18` | Updates, release and packaging | [18-updates-release-and-packaging.md](clauses/18-updates-release-and-packaging.md) |
| `MUS-SPEC-19` | Security and redaction | [19-security-and-redaction.md](clauses/19-security-and-redaction.md) |
| `MUS-SPEC-20` | Performance | [20-performance.md](clauses/20-performance.md) |
| `MUS-SPEC-21` | Visuals and artifacts | [21-visuals-and-artifacts.md](clauses/21-visuals-and-artifacts.md) |
| `MUS-SPEC-22` | Engineering standards | [22-engineering-standards.md](clauses/22-engineering-standards.md) |
