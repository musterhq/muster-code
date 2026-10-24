# MUS-SPEC-13: Muster Server

Muster Server runs the Muster agent runtime on a machine a team shares. People sign in from a browser or connect the desktop app.

What the user can do:
- deploy the server, sign in, and invite, manage and revoke people with roles;
- give people access to Projects, and see usage, cost and audit records;
- connect chat channels (Slack, Telegram, Mattermost) so people can talk to agents there.

Boundaries:
- A person sees only the Projects they have access to.
- A guest, a revoked user or an unlinked sender is refused, visibly.
- Action buttons ignore a second click while the first is still running.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-13-575A](13-muster-server.md#mus-spec-13-575a) | Server status and kind words named like object keys map to the defaults. | [`a server status or kind named like an Object.prototype member falls back to the default`](../../../packages/agent-app/tests/paperclip-map-bughunt.test.ts) |

<a id="mus-spec-13-575a"></a>
#### MUS-SPEC-13-575A: A server value named like an object key falls back to the default

- Precondition: Server data whose status or kind is constructor, toString, hasOwnProperty or __proto__.
- Action: Map an agent, a run, an attention item and an approval.
- Expected result: The agent is idle, the run is failed, the item is kind other with "Needs your attention.", and the approval has a text title.
- Test: `packages/agent-app/tests/paperclip-map-bughunt.test.ts::a server status or kind named like an Object.prototype member falls back to the default`
- Environment: Node test runner; no network.
- Known gaps: Tests the mapping functions. It does not read from a live server.
- Evidence: UNVERIFIED
