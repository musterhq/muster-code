## Summary

<!-- What changes and why. Link the issue: Fixes #123 -->

## Spec

<!-- Link the spec in this PR: docs/specs/<issue>-<slug>.md. Every change has one (see docs/specs/README.md). -->

## Acceptance criteria → tests

<!-- One row per acceptance criterion in the spec. Each test drives the user's workflow, not internals. -->

| AC | Test (file › name) | Red before | Green after |
|----|--------------------|------------|-------------|
| AC1 |  | ✗ | ✓ |

## Red: the tests fail without the change

<!-- Paste the failing run (tests committed before the code, or run against main). -->

```
```

## Green: the same tests pass with the change

```
```

## Screenshots

<!-- Required for anything visible: before and after, from the real components or the real app. Delete only if nothing is visible. -->

## Checklist

- [ ] Spec written first, with numbered acceptance criteria
- [ ] Every AC has a workflow test, and every one of those tests failed before the change
- [ ] No test only checks implementation details, mocks the code under test, or is snapshot-only
- [ ] Typecheck and the related suites pass locally
- [ ] Screenshots for visible changes
- [ ] CHANGELOG updated if behaviour changed
