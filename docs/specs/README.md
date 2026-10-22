# Specs and test-driven changes

Every fix and feature in Muster starts as a spec and is finished when that spec's tests pass.

## The order

1. **Spec.** Copy `TEMPLATE.md` to `docs/specs/<issue>-<slug>.md`, in the same PR as the change. Write:
   - the problem;
   - the user's workflow, step by step;
   - numbered acceptance criteria (AC1, AC2…), each one observable by the user or by another part of the app;
   - what is out of scope.
2. **Tests from the spec.** Each acceptance criterion gets one test, named `AC<n>: <criterion>`.
3. **Red.** Commit the tests on their own and run them. Every AC test must fail, because the behaviour doesn't exist yet. Keep that output for the PR.
4. **Green.** Write the change. The same tests pass, unchanged. If a test has to change, the spec changes first.
5. **Screenshots.** Anything visible gets before and after screenshots from the real components or the app.

## What counts as a workflow test

A test proves what the user experiences. It drives the same path the user does:

- **Runtime behaviour.** Use the agent service with a fake provider: send a message, stop, restart, hit a limit. Then assert on what the user sees: timeline rows, queued messages, notices, files on disk.
- **UI behaviour.** Render the real components in a DOM suite (`tests/*.tsx`, run by `scripts/test-renderer.mjs`). Click, type and press keys, then assert on what is on screen.
- **Main-process and IPC behaviour.** Call the real handler with real files in a temp folder.

These don't count as tests of the spec:

- a test that passes on `main` (it doesn't prove the change);
- asserting on a private helper's return value when the user-facing path is testable;
- mocking the unit under test, or asserting only that a mock was called;
- a snapshot with no assertion about behaviour.

A unit test for a tricky pure function, such as a parser or a regex, is welcome in addition to the workflow tests, never instead of them.

## Review

A reviewer checks four things. Each AC has a test, each test failed before the change, each test drives the workflow, and the PR shows the red and green runs. A PR missing any of these goes back to the author.
