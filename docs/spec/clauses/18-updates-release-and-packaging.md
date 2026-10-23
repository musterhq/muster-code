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
| [MUS-SPEC-18-561A](18-updates-release-and-packaging.md#mus-spec-18-561a) | After a failed first read a 15-second retry is scheduled, and when it runs the update status appears. | [`the update status is read again after a failed first read`](../../../packages/agent-app/tests/update-status-retry-dom.tsx) |

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

