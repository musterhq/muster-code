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
