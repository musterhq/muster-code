## Summary

<!-- What changes and why, in plain words. Link the issue: Fixes #123 -->

## Cases

<!-- The acceptance cases this PR adds or changes, in docs/spec/clauses/NN-<area>.md (see docs/spec/README.md). One row per case, with its result on this PR's exact head. -->

| Case | Test (file › name) | Red before | Green on this head |
|---|---|---|---|
| MUS-SPEC-NN-1A |  | ✗ | ✓ |

## Red: the tests fail without the change

<!-- The real failing run: command, failure, and the commit it ran on (tests committed before the code, or run against main). -->

```
```

## Green: the same tests pass with the change

<!-- Command, exit code, counts (passed / failed / skipped) and the commit SHA of this head. -->

```
```

## Screenshots

<!-- Required for anything visible: before and after, from the real components or the real app. Delete only if nothing is visible. -->

## Checklist

- [ ] Cases written first, in the clause file for the area, with Evidence UNVERIFIED
- [ ] Every case names one test that drives the user's workflow, and that test carries its `// Spec:` comment
- [ ] Every one of those tests failed before the change (red output above)
- [ ] `node scripts/check-spec.mjs` passes
- [ ] Typecheck and the related suites pass locally
- [ ] Screenshots for visible changes
- [ ] CHANGELOG updated if behaviour changed
