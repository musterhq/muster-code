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
