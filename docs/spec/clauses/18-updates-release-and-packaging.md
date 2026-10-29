# MUS-SPEC-18: Updates, release and packaging

Muster ships as a signed desktop app for macOS, Windows and Linux and updates itself.

What the user can do:
- check for updates, pick an update channel, and install an update with a restart;
- see what is new in a release.

Boundaries:
- An update is verified before it is installed; a failed or partial download never replaces the running app.
- Release builds are made by the GitHub release workflow, never by hand.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-18-479L](18-updates-release-and-packaging.md#mus-spec-18-479l) | An update never restarts Muster while a turn is running. | [`an update install waits for running work, says so once, and installs when it finishes`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-18-89A](18-updates-release-and-packaging.md#mus-spec-18-89a) | No package in the dependency report has the license UNKNOWN, and the license bundle records buffers as MIT with its source and the MIT terms. | [`no bundled dependency has an unknown license`](../../../packages/agent-app/tests/dependency-discipline.test.ts) |
| [MUS-SPEC-18-561A](18-updates-release-and-packaging.md#mus-spec-18-561a) | After a failed first read a 15-second retry is scheduled, and when it runs the update status appears. | [`the update status is read again after a failed first read`](../../../packages/agent-app/tests/update-status-retry-dom.tsx) |

### Updates wait for running work

<a id="mus-spec-18-479l"></a>
#### MUS-SPEC-18-479L: An update waits until running chats finish, then installs

- Precondition: Two turns are running when an update install is requested.
- Action: Request the install twice, then let the turns finish one at a time, then request it again.
- Expected result: The install waits and says "Muster will update when the running work finishes." once. It runs once when the last turn ends, and runs at once when nothing is running.
- Test: `packages/agent-app/tests/auto-resume.test.ts::an update install waits for running work, says so once, and installs when it finishes`
- Environment: Node test runner; a fake gate with fake notices; no Electron and no real updater.
- Known gaps: Tests the gate on its own; the app's main process wiring is not run.
- Evidence: UNVERIFIED

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

### Update status

<a id="mus-spec-18-561a"></a>
#### MUS-SPEC-18-561A: The update status is read again after a failed first read

- Precondition: The runtime is still starting, so the first read of the update status fails.
- Action: A component that shows the update status is drawn, the first read fails, and then the scheduled retry runs.
- Expected result: At first no status is shown and one retry is scheduled. When the retry runs, the status (ready) is shown, so the update button is not missing for the whole session.
- Test: `packages/agent-app/tests/update-status-retry-dom.tsx::the update status is read again after a failed first read`
- Environment: Node and linkedom: a DOM suite with the real update status hook and a fake bridge; the 15-second timer is run by hand, so it does not wait.
- Known gaps: The retry timer is run by the test, not waited for. Retries stop after 8 failed attempts; that limit is not tested.
- Evidence: UNVERIFIED
