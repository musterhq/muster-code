# Test traceability index

This file is an **index only**. It is not the specification. Each tested behaviour is an acceptance case in its clause file; the authoring rules are in [acceptance-cases.md](acceptance-cases.md).

Each case links both ways: the case names its test by exact path and name, and the test carries a `// Spec: <ID> (docs/spec/clauses/NN-name.md#<anchor>)` comment directly above its `test(` call. `node scripts/check-spec.mjs` checks both links. A link is not coverage and not a pass. Results are in the case Evidence or the PR body, not here.

## Clauses with cases

One row per clause file that has at least one case. The checker reports a clause with cases that is missing here, and a row for a clause with none.

| Clause | Area |
|---|---|
| `MUS-SPEC-03` | [Providers, models and accounts](clauses/03-providers-models-and-accounts.md) |
| `MUS-SPEC-04` | [Context window and compaction](clauses/04-context-window-and-compaction.md) |
| `MUS-SPEC-12` | [Projects, orgs, tasks and check-out](clauses/12-projects-orgs-and-tasks.md) |
| `MUS-SPEC-22` | [Engineering standards](clauses/22-engineering-standards.md) |
