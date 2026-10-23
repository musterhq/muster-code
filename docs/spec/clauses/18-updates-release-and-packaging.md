# MUS-SPEC-18: Updates, release and packaging

Muster ships as a signed desktop app for macOS, Windows and Linux and updates itself.

What the user can do:
- check for updates, pick an update channel, and install an update with a restart;
- see what is new in a release.

Boundaries:
- An update is verified before it is installed; a failed or partial download never replaces the running app.
- Release builds are made by the GitHub release workflow, never by hand.

## Acceptance cases

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-18-89A](18-updates-release-and-packaging.md#mus-spec-18-89a) | No package in the dependency report has the license UNKNOWN, and the license bundle records buffers as MIT with its source and the MIT terms. | [`no bundled dependency has an unknown license`](../../../packages/agent-app/tests/dependency-discipline.test.ts) |

### Third-party licenses

<a id="mus-spec-18-89a"></a>
#### MUS-SPEC-18-89A: Every bundled dependency has a known license

- Precondition: The committed dependency report and license bundle, which cover every package built into the app. `buffers@0.1.1` (pulled in by the XLSX reader) ships no license field and no license file.
- Action: Read the dependency report and the license bundle.
- Expected result: No package in the report has the license UNKNOWN. `buffers` is recorded as MIT. Its entry in the license bundle says where the license was confirmed and gives the MIT terms with the author's copyright line.
- Test: `packages/agent-app/tests/dependency-discipline.test.ts::no bundled dependency has an unknown license`
- Environment: Node test runner, no network.
- Known gaps: The test reads the committed files; it does not rebuild the bundles. They are regenerated with `node scripts/dependency-report.mjs`.
- Evidence: UNVERIFIED
