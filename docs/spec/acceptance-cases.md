# Acceptance cases: how to write, link and check them

This file is the authoring convention. The behaviour itself is not here: it lives in the clause files, as acceptance cases with stable IDs. [test-traceability.md](test-traceability.md) is an index only.

## Where a case lives

- File: the clause file for the area, `docs/spec/clauses/NN-<area>.md`. The files are listed in the [clause index](README.md#clause-index).
- Section: `## Acceptance cases`. Every clause file has this heading. A case heading anywhere else is an error.
- The section starts with an index table, one row per case (see [Index row](#index-row)). The case blocks follow. A `###` heading may group cases by topic.
- Pick the next free group number or letter in the clause file on `main` and in any open PR that edits the same file. When two PRs touch one clause file, each adds its own cases and keeps the other's when it merges `main`.

## Case ID

`MUS-SPEC-<NN>-<n><L>`

- `NN`: the two-digit clause number. It must match the file name.
- `<n>`: a topic group inside the clause, `1`, `2`, `3`, and so on.
- `<L>`: one case in the group, `A`, `B`, `C`, and so on.
- Example: `MUS-SPEC-04-1A`. Its anchor is the ID in lower case with `.` written as `-`: `mus-spec-04-1a`.
- An ID is never reused and never renumbered. A removed case keeps its ID retired.

## Case block

The anchor line, then the heading, then exactly seven fields. No other field, no `Status` or `Result` line, no loose text.

```markdown
<a id="mus-spec-04-1a"></a>
#### MUS-SPEC-04-1A: Short title in plain words

- Precondition: the state before the action.
- Action: what is done.
- Expected result: what must be true afterwards.
- Test: `packages/agent-app/tests/context-window-668.test.ts::exact test name`
- Environment: what the test needs to run (runtime, services, network).
- Known gaps: what the test does not show. Write "None known." if there is none.
- Evidence: UNVERIFIED
```

Rules:

- Plain language, about 10th-grade level. One case checks one behaviour.
- **Test** is the exact path from the repository root, then `::`, then the exact test name, in backticks: `` `packages/agent-app/tests/<file>::<exact test name>` ``. No wildcard, no absolute path, no `..`. The name is everything after the first `::`, and it may hold spaces. The file must exist, and exactly one plain `test('name', …)` or `it('name', …)` call (or a named `check()` in a DOM suite) must have that string as its first argument. No match, two matches, or a skipped form (`test.skip`, `test.todo`, `test.only`, `xit`, or an options object that sets `skip`, `todo` or `only` to `true`, a string or a number) is an error. A `{skip}` variable decided at run time is not seen. A `describe` name is not joined to the test name.
- **Not written yet.** Only for a case on an open issue that no PR has started: `Test: not written yet (#<issue>)`, with `Evidence: UNVERIFIED`. The PR that starts the issue replaces it with a real test.
- **A link is not coverage.** The index row says what the assertions check, not what the test is called.
- Links inside `docs/spec/` are relative. A case block holds no URL, except the run URL in a `ci;` Evidence receipt.
- **Evidence** is one of:
  - `UNVERIFIED`, optionally `UNVERIFIED: <reason>`;
  - `local; <command>; exit N; P passed, F failed, S skipped; commit <40 hex>`;
  - `ci; <GitHub Actions run URL>; exit N; P passed, F failed, S skipped; commit <40 hex>`.

  Exit 0 needs 0 failed and at least 1 passed. `commit` is the commit the run used. A receipt goes stale when the tested code changes, so new cases are usually written `UNVERIFIED` and the exact-head results go in the PR body.

## Index row

One row per case in the table at the top of `## Acceptance cases`:

```markdown
| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-04-1A](04-context-window-and-compaction.md#mus-spec-04-1a) | One line of what the assertions check. | [`exact test name`](../../../packages/agent-app/tests/context-window-668.test.ts) |
```

The first link goes to the case in the same file. The last cell links to the test file with the exact test name, or says `not written yet (#<issue>)`. Both links are relative.

## Test comment

Directly above the `test(` or `it(` call, a line comment:

```ts
// Spec: MUS-SPEC-04-1A (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-1a)
test('exact test name', () => { … });
```

- The path is exact, from the repository root. No `*`.
- It may be one line of a longer `//` comment block that ends on the line before the call. A blank line or a code line between the comment and the call breaks the link. A `/* */` comment is not read.
- One test may carry several `// Spec:` lines when it proves several cases. Each of those cases must name that test.

## DOM suites: named checks

DOM suites (`packages/agent-app/tests/*.tsx`) are plain scripts with no `test()` calls. To link one behaviour in a DOM suite, wrap it in a named check from [`tests/dom-check.ts`](../../packages/agent-app/tests/dom-check.ts):

```tsx
import {check} from './dom-check.ts';

// Spec: MUS-SPEC-01-2A (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-2a)
await check('Enter sends the draft and clears the composer', async () => {
  // drive the real components and assert on the screen
});
```

`check()` runs the body, prints `ok - <name>` or `not ok - <name>`, and rethrows a failure, so the suite still exits non-zero. The checker reads `check('name', …)` only in a file that imports `./dom-check`. Existing suites keep their shape; add `check()` when you link a behaviour.

## Commands

From the repository root:

```sh
node scripts/check-spec.mjs        # exit 0 when the spec and its links are valid; exit 1 lists each problem
```

From `packages/agent-app`, the checker's own tests:

```sh
node --max-old-space-size=1536 --experimental-transform-types --import ./tests/pin-device-platform.mjs --test tests/check-spec.test.ts
```

The checker runs in the Muster Agent CI workflow on every PR that touches the app or the spec.

## What the checker proves, and what it does not

- It proves that each case has the seven fields in the right form, that its ID matches its file and anchor and is unique, that its Test names exactly one non-skipped test that exists, that the test's `// Spec:` comment and the case name each other, and that the index rows link correctly.
- It does not run any test. It cannot show that a case passed or that the assertions check what the case says. The reviewer does that, and Evidence records a real run.
- It cannot tell whether an issue is open or whether a PR has started it. The reviewer checks `not written yet` cases.
- The test scan is light: it blanks comments and strings, then reads `test(`, `it(` and `check(` calls. Limits: only a call with a plain string name can be linked (a name built with `${…}`, `+`, a variable or `test.each` cannot); a skip set at run time (`t.skip()`, a `describe.skip` around the test, a config file) is not seen; a regular expression literal holding a quote can confuse the scan. Folders named `node_modules`, `dist` and `.git` are not scanned.
