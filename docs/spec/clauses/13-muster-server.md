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
| [MUS-SPEC-13-803A](13-muster-server.md#mus-spec-13-803a) | Three servers added one after another are all listed with name, URL, signed-in account and status; each token is stored apart and sent only to its own server. | [`three Muster Servers added one after another are all listed, each with its own token`](../../../packages/agent-app/tests/muster-server-multi.test.ts) |
| [MUS-SPEC-13-803B](13-muster-server.md#mus-spec-13-803b) | Renaming, disconnecting, re-authenticating and removing one server leaves the others connected and readable. | [`rename, disconnect, re-authenticate and remove act on one server and leave the others working`](../../../packages/agent-app/tests/muster-server-multi.test.ts) |
| [MUS-SPEC-13-803C](13-muster-server.md#mus-spec-13-803c) | Projects from every connected server are listed at once, each labelled with its server; Projects, Roster and Inbox say which server they sync from. | [`projects from every connected server are listed at once and labelled with their server`](../../../packages/agent-app/tests/muster-server-multi.test.ts) |
| [MUS-SPEC-13-803D](13-muster-server.md#mus-spec-13-803d) | An existing single-server setup becomes the first entry of the list with the same token, origin, orgs and account, and keeps working without signing in again. | [`an existing single-server setup moves into the list on first launch with nothing lost`](../../../packages/agent-app/tests/muster-server-multi.test.ts) |
| [MUS-SPEC-13-803E](13-muster-server.md#mus-spec-13-803e) | A server that cannot be reached shows its own error, the others stay online and keep listing projects, and Retry brings it back. | [`an unreachable server shows its own error and a retry, and the others stay usable`](../../../packages/agent-app/tests/muster-server-multi.test.ts) |
| [MUS-SPEC-13-803F](13-muster-server.md#mus-spec-13-803f) | Settings › Integrations lists each server as a row with name, URL, account and status, the row actions, a Retry on an unreachable row, and Add server opening the add flow. | [`the Integrations list shows every server with its actions, and Add server opens the add flow`](../../../packages/agent-app/tests/muster-server-list-dom.tsx) |

<a id="mus-spec-13-575a"></a>
#### MUS-SPEC-13-575A: A server value named like an object key falls back to the default

- Precondition: Server data whose status or kind is constructor, toString, hasOwnProperty or __proto__.
- Action: Map an agent, a run, an attention item and an approval.
- Expected result: The agent is idle, the run is failed, the item is kind other with "Needs your attention.", and the approval has a text title.
- Test: `packages/agent-app/tests/paperclip-map-bughunt.test.ts::a server status or kind named like an Object.prototype member falls back to the default`
- Environment: Node test runner; no network.
- Known gaps: Tests the mapping functions. It does not read from a live server.
- Evidence: UNVERIFIED

<a id="mus-spec-13-803a"></a>
#### MUS-SPEC-13-803A: Several Muster Servers in one list

- Precondition: A fresh data folder and three fake Muster Servers at different addresses.
- Action: Connect the first with a token, the second and the third with a password, then list the servers and check them.
- Expected result: All three are listed, in the order added, with name, URL, signed-in account and status "online". Each token sits under its own secret-store entry, no token is in a config file, and each server only ever receives its own token.
- Test: `packages/agent-app/tests/muster-server-multi.test.ts::three Muster Servers added one after another are all listed, each with its own token`
- Environment: Node test runner; fake servers through an injected fetch; no network.
- Known gaps: The browser-approval sign-in for a second server uses the same storage path but is not driven here.
- Evidence: UNVERIFIED

<a id="mus-spec-13-803b"></a>
#### MUS-SPEC-13-803B: Row actions touch one server only

- Precondition: Three connected fake Muster Servers.
- Action: Rename the second, disconnect the first, re-authenticate the first, then remove the third.
- Expected result: The rename shows only on the second. The disconnected first keeps its name and URL with status "disconnected" and its token is forgotten while the others stay online. Re-authenticating brings it back under the same entry. Removing the third deletes its entry and its token. The first and second still list their projects.
- Test: `packages/agent-app/tests/muster-server-multi.test.ts::rename, disconnect, re-authenticate and remove act on one server and leave the others working`
- Environment: Node test runner; fake servers through an injected fetch; no network.
- Known gaps: Revoking a browser-approval key on Disconnect is covered by the sign-in suite, not here.
- Evidence: UNVERIFIED

<a id="mus-spec-13-803c"></a>
#### MUS-SPEC-13-803C: Server features say which server they belong to

- Precondition: Two connected fake Muster Servers, each with its own projects.
- Action: List projects across servers, list them for one server, and read the Projects, Roster and Inbox connection.
- Expected result: Projects from both servers come back in one list, each with the server's id and name. Asking for one server returns only its projects. The Projects, Roster and Inbox view names the one server it syncs from, and choosing the other server moves it there.
- Test: `packages/agent-app/tests/muster-server-multi.test.ts::projects from every connected server are listed at once and labelled with their server`
- Environment: Node test runner; fake servers through an injected fetch; no network.
- Known gaps: Tasks, Roster, Inbox and runs still sync from one chosen server at a time (follow-up). Projects and orgs read from every server.
- Evidence: UNVERIFIED

<a id="mus-spec-13-803d"></a>
#### MUS-SPEC-13-803D: The old single server moves into the list

- Precondition: A data folder from the single-server build: server.json with a Muster Server link, a legacy token entry, org ticks and the signed-in person.
- Action: Start the runtime and read the list, the connection and the projects.
- Expected result: The list has one entry with the same URL, account, token entry and org settings. It feeds Projects, Roster and Inbox, the same token goes to the same origin with no new sign-in, and server.json is left as it was.
- Test: `packages/agent-app/tests/muster-server-multi.test.ts::an existing single-server setup moves into the list on first launch with nothing lost`
- Environment: Node test runner; fake server through an injected fetch; no network.
- Known gaps: Older paperclip.json and muster-server.json files reach the list through the earlier server.json migration, covered in server-unify.test.ts.
- Evidence: UNVERIFIED

<a id="mus-spec-13-803e"></a>
#### MUS-SPEC-13-803E: One unreachable server does not block the others

- Precondition: Two connected fake Muster Servers. The second stops answering.
- Action: Check all servers, list projects, then bring the second back and retry only it.
- Expected result: The second shows status "unreachable" with its own error while the first is "online". The project list still has the first server's projects and an error entry for the second only. Retry on the second turns it "online" and its projects come back.
- Test: `packages/agent-app/tests/muster-server-multi.test.ts::an unreachable server shows its own error and a retry, and the others stay usable`
- Environment: Node test runner; fake servers through an injected fetch; no network.
- Known gaps: Uses a thrown fetch for "unreachable". It does not wait for a real network timeout.
- Evidence: UNVERIFIED

<a id="mus-spec-13-803f"></a>
#### MUS-SPEC-13-803F: The Integrations list of servers

- Precondition: Settings › Integrations with three servers: one online, one unreachable, one disconnected.
- Action: Render the list, rename one, retry the unreachable one and press Add server.
- Expected result: Each server is a row with its name, URL, signed-in account and status. Every row has Rename, Re-authenticate, Disconnect (when connected) and Remove. The unreachable row shows its error and a Retry that checks only that server. Add server shows the existing address form.
- Test: `packages/agent-app/tests/muster-server-list-dom.tsx::the Integrations list shows every server with its actions, and Add server opens the add flow`
- Environment: linkedom DOM through scripts/test-renderer.mjs; stubbed bridge; no network.
- Known gaps: Uses a stubbed bridge, not the real runtime. Layout and styling are not checked.
- Evidence: UNVERIFIED
