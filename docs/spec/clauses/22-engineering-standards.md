# MUS-SPEC-22: Engineering standards

How Muster itself is built and checked: the spec, its tests, typechecking and CI. These rules are for everyone who changes Muster, people and agents alike.

What the standards require:
- every change starts as acceptance cases in this folder, then tests that fail without the change, then the change (see [README.md](../README.md#the-order));
- every case names exactly one real test, and that test names the case back;
- typecheck, the unit suite and the renderer suite pass on every PR.

Boundaries:
- The checker proves the links and the case format. It does not run tests or judge what they assert; review does that.
- Release and packaging are clause [18](18-updates-release-and-packaging.md).

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-22-1A](22-engineering-standards.md#mus-spec-22-1a) | A case and its test that name each other pass, and the checker reports the case count. | [`a case and its test that name each other pass`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-1B](22-engineering-standards.md#mus-spec-22-1b) | A case missing one of the seven fields fails and names the case and the field. | [`a case missing one of its seven fields fails and names the field`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-1C](22-engineering-standards.md#mus-spec-22-1c) | A case ID whose clause number differs from its file fails. | [`a case ID whose clause number does not match its file fails`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-2F](22-engineering-standards.md#mus-spec-22-2f) | Only skip, todo or only set to true, a string or a number skips a test; a run-time skip variable, skip: false and only: false still link; test.skip and test.only do not. | [`a run-time skip variable or skip: false still links; skip: true and test.skip do not`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-1D](22-engineering-standards.md#mus-spec-22-1d) | The same case ID twice fails, and two tests with one name fail. | [`the same case ID twice, or two tests with one name, fail`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-2G](22-engineering-standards.md#mus-spec-22-2g) | A Spec comment separated from its test by a blank line does not link. | [`a blank line between the Spec comment and the test breaks the link`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-2A](22-engineering-standards.md#mus-spec-22-2a) | A case naming a test that does not exist fails with the missing name. | [`a case whose test does not exist fails`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-2B](22-engineering-standards.md#mus-spec-22-2b) | A test marked skip cannot prove a case. | [`a skipped test cannot prove a case`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-2C](22-engineering-standards.md#mus-spec-22-2c) | A linked test with no Spec comment above it fails, naming the case. | [`a test without its Spec comment fails the link back`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-2D](22-engineering-standards.md#mus-spec-22-2d) | A Spec comment naming a case that does not exist fails. | [`a Spec comment that points at a case that does not exist fails`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-2E](22-engineering-standards.md#mus-spec-22-2e) | A DOM suite links a case through a named check in a file that imports dom-check. | [`a DOM suite links through a named check in a file that imports dom-check`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-3A](22-engineering-standards.md#mus-spec-22-3a) | A passing receipt with failures or no passes is refused; a real passing receipt is accepted. | [`a passing receipt must report zero failures and at least one pass`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-3B](22-engineering-standards.md#mus-spec-22-3b) | A not-written-yet case passes only with UNVERIFIED evidence. | [`a not-written-yet case passes only with UNVERIFIED evidence and an issue number`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-3C](22-engineering-standards.md#mus-spec-22-3c) | The traceability index must list exactly the clauses that have cases. | [`a clause with cases must be listed in the traceability index, and one without must not`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-4A](22-engineering-standards.md#mus-spec-22-4a) | The real Muster spec in this repository passes the checker. | [`the real Muster spec passes the checker`](../../../packages/agent-app/tests/check-spec.test.ts) |
| [MUS-SPEC-22-5A](22-engineering-standards.md#mus-spec-22-5a) | Every `tests/*.tsx` file in the repository is either a suite run by `npm run test:renderer` or excluded with a stated reason, and every listed name has a file. | [`every tests/*.tsx file is a renderer suite or is excluded with a reason`](../../../packages/agent-app/tests/renderer-suites.test.ts) |
| [MUS-SPEC-22-5B](22-engineering-standards.md#mus-spec-22-5b) | The guard names a stray DOM suite, a stale list entry, a name in both lists and a duplicate. | [`the guard names a stray suite, a stale entry, a name in both lists and a duplicate`](../../../packages/agent-app/tests/renderer-suites.test.ts) |

### Case format

<a id="mus-spec-22-1a"></a>
#### MUS-SPEC-22-1A: A linked case passes

- Precondition: A clause file with one complete case, and a test file whose test carries that case's Spec comment.
- Action: Run the checker on that tree.
- Expected result: It exits 0 and reports 1 case.
- Test: `packages/agent-app/tests/check-spec.test.ts::a case and its test that name each other pass`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-22-1b"></a>
#### MUS-SPEC-22-1B: Every case has all seven fields

- Precondition: A case with no Known gaps field.
- Action: Run the checker.
- Expected result: It exits 1 and the message names the case and "Known gaps".
- Test: `packages/agent-app/tests/check-spec.test.ts::a case missing one of its seven fields fails and names the field`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: Only one missing field is tried; the others go through the same rule.
- Evidence: UNVERIFIED

<a id="mus-spec-22-1c"></a>
#### MUS-SPEC-22-1C: A case ID belongs to its clause file

- Precondition: Case MUS-SPEC-03-1A written in clause file 04.
- Action: Run the checker.
- Expected result: It exits 1 and the message names the case and clause 04.
- Test: `packages/agent-app/tests/check-spec.test.ts::a case ID whose clause number does not match its file fails`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-22-1d"></a>
#### MUS-SPEC-22-1D: IDs and test names are unique

- Precondition: A clause file holding the same case twice; then a test file with two tests of one name.
- Action: Run the checker on each.
- Expected result: Both exit 1: the first says duplicate case ID, the second says 2 tests are named the same.
- Test: `packages/agent-app/tests/check-spec.test.ts::the same case ID twice, or two tests with one name, fail`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: None known.
- Evidence: UNVERIFIED

### Links between cases and tests

<a id="mus-spec-22-2a"></a>
#### MUS-SPEC-22-2A: A case must name a real test

- Precondition: A case whose Test names a test that is not in its file.
- Action: Run the checker.
- Expected result: It exits 1 and the message quotes the missing test name.
- Test: `packages/agent-app/tests/check-spec.test.ts::a case whose test does not exist fails`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-22-2b"></a>
#### MUS-SPEC-22-2B: A skipped test does not count

- Precondition: The linked test is declared with an options object holding skip.
- Action: Run the checker.
- Expected result: It exits 1 and says the test is skipped.
- Test: `packages/agent-app/tests/check-spec.test.ts::a skipped test cannot prove a case`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: A skip decided at run time, such as t.skip() inside the test, is not seen.
- Evidence: UNVERIFIED

<a id="mus-spec-22-2c"></a>
#### MUS-SPEC-22-2C: A test names its case back

- Precondition: The linked test exists but has no Spec comment above it.
- Action: Run the checker.
- Expected result: It exits 1 and the message names the case and the missing Spec line.
- Test: `packages/agent-app/tests/check-spec.test.ts::a test without its Spec comment fails the link back`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-22-2d"></a>
#### MUS-SPEC-22-2D: A Spec comment must point at a real case

- Precondition: A test carries a Spec comment for MUS-SPEC-04-9Z, which no clause defines.
- Action: Run the checker.
- Expected result: It exits 1 and the message names MUS-SPEC-04-9Z.
- Test: `packages/agent-app/tests/check-spec.test.ts::a Spec comment that points at a case that does not exist fails`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-22-2e"></a>
#### MUS-SPEC-22-2E: DOM suites link through named checks

- Precondition: A DOM suite imports dom-check and wraps a behaviour in check('name', …) with the case's Spec comment.
- Action: Run the checker on a case whose Test names that check.
- Expected result: It exits 0.
- Test: `packages/agent-app/tests/check-spec.test.ts::a DOM suite links through a named check in a file that imports dom-check`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: Does not run the DOM suite.
- Evidence: UNVERIFIED

<a id="mus-spec-22-2f"></a>
#### MUS-SPEC-22-2F: A test is skipped only by a fixed skip setting

- Precondition: Seven forms of the linked test: a run-time `{skip}` variable, `skip: false`, `only: false`, `skip: true`, `todo: 'later'`, `test.skip` and `test.only`.
- Action: Run the checker on each.
- Expected result: The first three exit 0. The last four exit 1.
- Test: `packages/agent-app/tests/check-spec.test.ts::a run-time skip variable or skip: false still links; skip: true and test.skip do not`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: A skip decided while the test runs, such as a `{skip}` variable or t.skip(), is not seen.
- Evidence: UNVERIFIED

<a id="mus-spec-22-2g"></a>
#### MUS-SPEC-22-2G: A Spec comment must touch its test

- Precondition: The Spec comment is followed by a blank line, then the test.
- Action: Run the checker.
- Expected result: It exits 1 and says the comment must sit directly above a test call.
- Test: `packages/agent-app/tests/check-spec.test.ts::a blank line between the Spec comment and the test breaks the link`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: None known.
- Evidence: UNVERIFIED

### Evidence and the index

<a id="mus-spec-22-3a"></a>
#### MUS-SPEC-22-3A: A passing receipt must be a real pass

- Precondition: One case whose Evidence says exit 0 with 0 passed and 2 failed; another with 3 passed and 0 failed.
- Action: Run the checker on each.
- Expected result: The first exits 1 and names Evidence. The second exits 0.
- Test: `packages/agent-app/tests/check-spec.test.ts::a passing receipt must report zero failures and at least one pass`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: The checker cannot tell whether the receipt came from a real run; review does.
- Evidence: UNVERIFIED

<a id="mus-spec-22-3b"></a>
#### MUS-SPEC-22-3B: A case with no test yet cannot claim a pass

- Precondition: A case whose Test is "not written yet (#701)", once with UNVERIFIED Evidence and once with a passing receipt.
- Action: Run the checker on each.
- Expected result: The UNVERIFIED one exits 0; the one claiming a pass exits 1.
- Test: `packages/agent-app/tests/check-spec.test.ts::a not-written-yet case passes only with UNVERIFIED evidence and an issue number`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: The checker cannot tell whether issue #701 is open; review does.
- Evidence: UNVERIFIED

<a id="mus-spec-22-3c"></a>
#### MUS-SPEC-22-3C: The index lists exactly the clauses with cases

- Precondition: A clause with a case that the index does not list; then a clause with no cases that the index lists.
- Action: Run the checker on each.
- Expected result: Both exit 1 and the message names test-traceability and MUS-SPEC-04.
- Test: `packages/agent-app/tests/check-spec.test.ts::a clause with cases must be listed in the traceability index, and one without must not`
- Environment: Node test runner; the checker runs as a child process on a temp folder.
- Known gaps: None known.
- Evidence: UNVERIFIED

### The real spec

<a id="mus-spec-22-4a"></a>
#### MUS-SPEC-22-4A: Muster's own spec passes

- Precondition: This repository's docs/spec and tests.
- Action: Run the checker on the repository root.
- Expected result: It exits 0.
- Test: `packages/agent-app/tests/check-spec.test.ts::the real Muster spec passes the checker`
- Environment: Node test runner; the checker runs as a child process on the repository.
- Known gaps: CI also runs the checker directly; this test keeps the unit suite honest when CI is skipped locally.
- Evidence: UNVERIFIED

### Renderer suites run in CI

<a id="mus-spec-22-5a"></a>
#### MUS-SPEC-22-5A: Every DOM suite runs in CI or says why not

- Precondition: The `tests/*.tsx` files of the app, the `suites` list in `scripts/renderer-suites.mjs` that `npm run test:renderer` runs, and its `excluded` map.
- Action: Compare the files with the two lists.
- Expected result: Every `tests/*.tsx` file is in `suites` or in `excluded` with a reason, and every name in either list has a file. A DOM suite that nobody lists fails the unit suite, which CI runs on every PR.
- Test: `packages/agent-app/tests/renderer-suites.test.ts::every tests/*.tsx file is a renderer suite or is excluded with a reason`
- Environment: Node test runner; reads the real `tests` folder.
- Known gaps: Proves the suite is listed, not that it passes; the renderer step of CI runs it. A suite in `excluded` is not run by anything.
- Evidence: UNVERIFIED

<a id="mus-spec-22-5b"></a>
#### MUS-SPEC-22-5B: The guard names what is wrong

- Precondition: A file list with a stray DOM suite, a list with a name that has no file, a name in both lists, and a name listed twice.
- Action: Ask the guard for the problems.
- Expected result: Each of the four is reported by name; a file list that matches the lists reports none.
- Test: `packages/agent-app/tests/renderer-suites.test.ts::the guard names a stray suite, a stale entry, a name in both lists and a duplicate`
- Environment: Node test runner; pure function over made-up lists.
- Known gaps: None known.
- Evidence: UNVERIFIED

