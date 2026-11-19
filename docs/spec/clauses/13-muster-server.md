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
| [MUS-SPEC-13-803F](13-muster-server.md#mus-spec-13-803f) | Settings › Integrations lists each server as a one-line row with name, URL, account and status, its actions in a "…" menu, a Retry on an unreachable row, and Add server opening the add flow. | [`the Integrations list shows every server with its actions, and Add server opens the add flow`](../../../packages/agent-app/tests/muster-server-list-dom.tsx) |
| [MUS-SPEC-13-803G](13-muster-server.md#mus-spec-13-803g) | A server added with an API token shows the person the token belongs to, marked as a token; a password sign-in keeps its username. | [`a server added with an API token shows the person the token belongs to`](../../../packages/agent-app/tests/muster-server-multi.test.ts) |
| [MUS-SPEC-13-803H](13-muster-server.md#mus-spec-13-803h) | A new server is named after its one org, else its host; a name given with Rename is kept. | [`a new server is named after its one org, else its host, and Rename still wins`](../../../packages/agent-app/tests/muster-server-multi.test.ts) |
| [MUS-SPEC-13-803I](13-muster-server.md#mus-spec-13-803i) | After a server is added, the status line names that server, and the Projects line names the server it is about. | [`after adding a server the status line names the server just added, and the Projects line names its own server`](../../../packages/agent-app/tests/muster-server-list-dom.tsx) |
| [MUS-SPEC-13-804A](13-muster-server.md#mus-spec-13-804a) | The app signs in to a real Muster Server and lists and opens its project. | [`signs in with a password and lists and opens the seeded project on a real server`](../../../packages/agent-app/tests/server-e2e/server-workflows.e2e.ts) |
| [MUS-SPEC-13-804B](13-muster-server.md#mus-spec-13-804b) | A task made in the app or by someone else appears in the app. | [`creates a task in a server project and sees it appear, and sees a task someone else made arrive live`](../../../packages/agent-app/tests/server-e2e/server-workflows.e2e.ts) |
| [MUS-SPEC-13-804C](13-muster-server.md#mus-spec-13-804c) | The app rides out the server going away and coming back. | [`handles the server going away and coming back: the error is shown, then reads, the live socket and the sign-in resume`](../../../packages/agent-app/tests/server-e2e/server-workflows.e2e.ts) |
| [MUS-SPEC-13-804D](13-muster-server.md#mus-spec-13-804d) | Two real servers serve two app profiles at once without mixing their work. | [`two servers at once: two app profiles, each signed in to its own server, see only their own server’s work`](../../../packages/agent-app/tests/server-e2e/server-workflows.e2e.ts) |
| [MUS-SPEC-13-804E](13-muster-server.md#mus-spec-13-804e) | One app profile lists two real servers in Settings and shows both. | not written yet (#803) |
| [MUS-SPEC-13-890A](13-muster-server.md#mus-spec-13-890a) | Both Multica servers are listed online with their address, kind and “· API token” account; each token is in the secret store, in no file, never in the window, and only ever sent to its own server. | [`two Multica servers added with personal access tokens are both listed online, each token kept in the secret store and sent only to its own server`](../../../packages/agent-app/tests/multica-integration.test.ts) |
| [MUS-SPEC-13-890B](13-muster-server.md#mus-spec-13-890b) | A bad address, a refused token (in Multica’s words), a missing token (browser sign-in offered) and a closed port each give their own stage and sentence. | [`Test connection to a Multica server says what is wrong: a bad address, a token Multica refuses, a server that does not answer`](../../../packages/agent-app/tests/multica-integration.test.ts) |
| [MUS-SPEC-13-890C](13-muster-server.md#mus-spec-13-890c) | A server answering 302 to another address gets its own token, the other address gets no request at all, and the test fails. | [`a Multica server that redirects never passes the token on: the redirect target receives nothing and the test fails`](../../../packages/agent-app/tests/multica-integration.test.ts) |
| [MUS-SPEC-13-890D](13-muster-server.md#mus-spec-13-890d) | Where no sign-in window can open, no sign-in is started; Multica’s instruction is shown word for word as a notice and the token field under Other ways to connect is open. | [`where no sign-in window can open, Connect on a Multica address opens the token field with Multica’s instructions`](../../../packages/agent-app/tests/multica-connect-dom.tsx) |
| [MUS-SPEC-13-890E](13-muster-server.md#mus-spec-13-890e) | A refused token shows Multica’s sentence and saves nothing; a good one saves the address, token and kind, and the row reads “Acme · Multica” without showing the token. | [`a refused Multica token shows Multica’s words; a good one adds the server, listed as Multica`](../../../packages/agent-app/tests/multica-connect-dom.tsx) |
| [MUS-SPEC-13-890F](13-muster-server.md#mus-spec-13-890f) | Multica’s instruction is a status notice, not an error line; the steps are Multica’s three; the token field has focus; Connect with token is primary and Connect secondary; the Integrations description names all three server kinds. | [`the Multica connect step reads as guidance: no error colour, Multica’s own steps, the token field focused and Connect with token primary`](../../../packages/agent-app/tests/multica-connect-dom.tsx) |
| [MUS-SPEC-13-894A](13-muster-server.md#mus-spec-13-894a) | Connect opens Multica’s /login with a 127.0.0.1 cli_callback and a random state; after the redirect back, one 90-day token named “Muster Agent on …” is made with the sign-in token, checked with /api/me, stored as the server’s token, and the server is connected as the person. | [`signing in on a Multica server’s own page connects it: the sign-in comes back to a loopback listener, is swapped for a personal access token and stored like a pasted one`](../../../packages/agent-app/tests/multica-signin.test.ts) |
| [MUS-SPEC-13-894B](13-muster-server.md#mus-spec-13-894b) | A callback with the wrong state is answered 400, no token is made, and the sign-in still finishes with the right one. | [`a Multica sign-in callback with the wrong state is refused and makes no token`](../../../packages/agent-app/tests/multica-signin.test.ts) |
| [MUS-SPEC-13-894C](13-muster-server.md#mus-spec-13-894c) | Two callbacks at once make one token; a callback after success finds nothing listening. | [`only the first Multica sign-in callback counts: a second one is ignored and makes no second token`](../../../packages/agent-app/tests/multica-signin.test.ts) |
| [MUS-SPEC-13-894D](13-muster-server.md#mus-spec-13-894d) | After Cancel, and after the time limit, nothing listens on the callback port any more; the timed-out sign-in ends with a sentence that names the token fallback. | [`cancelling or timing out a Multica sign-in shuts its loopback listener`](../../../packages/agent-app/tests/multica-signin.test.ts) |
| [MUS-SPEC-13-894E](13-muster-server.md#mus-spec-13-894e) | Neither the sign-in token nor the new personal access token appears in any answer or event the window gets, in the server files, or in a request to any other address. | [`neither Multica token ever reaches the window, the server files or another address`](../../../packages/agent-app/tests/multica-signin.test.ts) |
| [MUS-SPEC-13-894F](13-muster-server.md#mus-spec-13-894f) | A server that cannot make the token ends with Multica’s own words; one that never sends the sign-in back ends at the time limit; both name the paste-a-token fallback. | [`a Multica server too old for sign-in from Muster ends with Multica’s words and points to the token fallback`](../../../packages/agent-app/tests/multica-signin.test.ts) |
| [MUS-SPEC-13-894G](13-muster-server.md#mus-spec-13-894g) | Connect on a Multica address starts the sign-in and opens the window on Multica’s page; Connect is primary; the steps say to sign in on your server’s page; the token path stays under Other ways to connect; a failed sign-in shows Multica’s words and opens the token path; success closes the window. | [`Connect on a Multica address opens Multica’s sign-in page in the window, and a failed sign-in points to the token path`](../../../packages/agent-app/tests/multica-signin-dom.tsx) |
| [MUS-SPEC-13-894H](13-muster-server.md#mus-spec-13-894h) | The sign-in window on a Multica page is isolated like the others, may go only to its own loopback callback beyond the page’s origin, and closing it before the callback reports the sign-in as abandoned. | [`the Multica sign-in window goes only to its own loopback callback, and closing it early abandons the sign-in`](../../../packages/agent-app/tests/multica-signin.test.ts) |

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
- Expected result: All three are listed, in the order added, with name, URL, signed-in account ("Olivia Owner · API token" for the token, the display name and username for a password) and status "online". Each token sits under its own secret-store entry, no token is in a config file, and each server only ever receives its own token.
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
- Expected result: Each server is a row with its name, URL, signed-in account and status. A row shows at most one button, Use for Projects, and only on a connected server that does not feed Projects. Rename, Re-authenticate, Disconnect (when connected) and Remove are in the row's "…" menu. The unreachable row shows its error and a Retry that checks only that server. Add server shows the existing address form.
- Test: `packages/agent-app/tests/muster-server-list-dom.tsx::the Integrations list shows every server with its actions, and Add server opens the add flow`
- Environment: linkedom DOM through scripts/test-renderer.mjs; stubbed bridge; no network.
- Known gaps: Uses a stubbed bridge, not the real runtime. Layout and styling are not checked.
- Evidence: UNVERIFIED

<a id="mus-spec-13-803g"></a>
#### MUS-SPEC-13-803G: A token sign-in shows whose token it is

- Precondition: Two fake Muster Servers added through the Settings add flow with API tokens (probe, then save with the token), and one added with a password.
- Action: Check the servers and list them, then read the list again after a restart.
- Expected result: The token servers show "QA Owner 1 · API token" and "QA Owner 2 · API token", the person each server says the token belongs to. The password server shows "Mel Member (@mel)". The account is still there after a restart, before any check.
- Test: `packages/agent-app/tests/muster-server-multi.test.ts::a server added with an API token shows the person the token belongs to`
- Environment: Node test runner; fake servers through an injected fetch; no network.
- Known gaps: Muster Servers only; a Paperclip-compatible token shows the person when its server answers who-am-I.
- Evidence: UNVERIFIED

<a id="mus-spec-13-803h"></a>
#### MUS-SPEC-13-803H: A new server is named after its org

- Precondition: Two fake Muster Servers added with tokens: one reports the org name "QA Org 1", the other reports none.
- Action: Check them, list them and their projects, rename the first, check again, then restart.
- Expected result: The first is named "QA Org 1" and its projects are labelled with it. The second is named by host and port. After Rename the first keeps "Staging" through later checks and a restart.
- Test: `packages/agent-app/tests/muster-server-multi.test.ts::a new server is named after its one org, else its host, and Rename still wins`
- Environment: Node test runner; fake servers through an injected fetch; no network.
- Known gaps: A server with several orgs is named by host. Which org name a server reports is up to the server.
- Evidence: UNVERIFIED

<a id="mus-spec-13-803i"></a>
#### MUS-SPEC-13-803I: The status line names the server just added

- Precondition: Settings › Integrations with servers listed and the one feeding Projects connected.
- Action: Open Add server, enter a second server's address and connect.
- Expected result: The add flow closes and the new server has its row. A status line says "Connected to" and the new server's name. No line still says the first server is the one connected, and the Projects line says "Projects, Roster and Inbox sync from" and the name of its own server.
- Test: `packages/agent-app/tests/muster-server-list-dom.tsx::after adding a server the status line names the server just added, and the Projects line names its own server`
- Environment: linkedom DOM through scripts/test-renderer.mjs; stubbed bridge; no network.
- Known gaps: Uses a stubbed bridge, not the real runtime.
- Evidence: UNVERIFIED

<a id="mus-spec-13-804a"></a>
#### MUS-SPEC-13-804A: The app client signs in to a real server and opens its project

- Precondition: A real Muster Server built from packages/server is running on a temp data dir, with an org name, an owner, a member and one project the member can edit.
- Action: Sign in from the app with a wrong password, then with the right one; list the server's projects; read the Projects workspace.
- Expected result: The wrong password is refused and nothing connects. The right one connects as the member. The project list holds only the seeded project with its open link. The workspace shows that project under the org name with no tasks.
- Test: `packages/agent-app/tests/server-e2e/server-workflows.e2e.ts::signs in with a password and lists and opens the seeded project on a real server`
- Environment: Real Muster Server processes from packages/server on loopback; the app runtime's own client with real fetch and WebSocket. Run by npm run test:server-e2e and the Muster Server e2e workflow.
- Known gaps: The secret store cipher stands in for the OS keychain, and the desktop's own workspace is empty. The Settings screen itself is not rendered.
- Evidence: UNVERIFIED

<a id="mus-spec-13-804b"></a>
#### MUS-SPEC-13-804B: A task created on a real server appears in the app

- Precondition: The member is signed in to the real server from the app.
- Action: Create a task from the app; open it; with the Projects screen visible, have the owner create another task with the server CLI.
- Expected result: The new task is in the project list and its detail shows its title and description. The live socket is up, a change event arrives, and the owner's task shows in the member's list.
- Test: `packages/agent-app/tests/server-e2e/server-workflows.e2e.ts::creates a task in a server project and sees it appear, and sees a task someone else made arrive live`
- Environment: Real Muster Server processes from packages/server on loopback; the app runtime's own client with real fetch and WebSocket. Run by npm run test:server-e2e and the Muster Server e2e workflow.
- Known gaps: Agents are not run: no task is started, so no model provider is involved.
- Evidence: UNVERIFIED

<a id="mus-spec-13-804c"></a>
#### MUS-SPEC-13-804C: The app rides out a real server restart

- Precondition: The member is signed in, has read the project and holds the live socket.
- Action: Kill the server process; read the workspace and try to create a task; start the server again on the same data dir and port.
- Expected result: While the server is away the socket drop is noticed, the last read stays on screen marked as unreachable, a new task is refused, and the sign-in is kept. After the restart reads resume with no new sign-in, earlier tasks are still there, the live socket comes back and new tasks can be made.
- Test: `packages/agent-app/tests/server-e2e/server-workflows.e2e.ts::handles the server going away and coming back: the error is shown, then reads, the live socket and the sign-in resume`
- Environment: Real Muster Server processes from packages/server on loopback; the app runtime's own client with real fetch and WebSocket. Run by npm run test:server-e2e and the Muster Server e2e workflow.
- Known gaps: The server is killed with SIGKILL; a clean stop and a slow network are not tested.
- Evidence: UNVERIFIED

<a id="mus-spec-13-804d"></a>
#### MUS-SPEC-13-804D: Two real servers at once

- Precondition: Two real Muster Servers run side by side on different ports, each with its own org and project.
- Action: Sign in one app profile to each server, create a task on each at the same time, then stop the second server.
- Expected result: Each profile sees its own org name, project and task and never the other server's. The first profile keeps working when the second server stops.
- Test: `packages/agent-app/tests/server-e2e/server-workflows.e2e.ts::two servers at once: two app profiles, each signed in to its own server, see only their own server’s work`
- Environment: Real Muster Server processes from packages/server on loopback; the app runtime's own client with real fetch and WebSocket. Run by npm run test:server-e2e and the Muster Server e2e workflow.
- Known gaps: Each profile holds one server. One profile with both servers in its Settings list is MUS-SPEC-13-804E.
- Evidence: UNVERIFIED

<a id="mus-spec-13-804e"></a>
#### MUS-SPEC-13-804E: One app profile with two real servers in its Settings list

- Precondition: Two real Muster Servers are running, each with its own org and project.
- Action: Add both servers to one app profile's Settings list and open Projects.
- Expected result: Both orgs and their projects show side by side, each read from its own server with its own sign-in.
- Test: not written yet (#803)
- Environment: Real Muster Server processes from packages/server on loopback, as MUS-SPEC-13-804D.
- Known gaps: Today's client holds one server per profile. The pending test in server-workflows.e2e.ts names #803.
- Evidence: UNVERIFIED

### Multica servers in Settings › Integrations

<a id="mus-spec-13-890a"></a>
#### MUS-SPEC-13-890A: Two Multica servers added with tokens

- Precondition: Two Multica servers on loopback, each with its own personal access token, and nothing in Settings › Integrations.
- Action: Connect each one with “Connect with token”, rename the second, then check every server.
- Expected result: Test connection recognises the address as Multica and lists its workspaces as orgs (“Connected to Multica. 2 workspaces.”). Both servers are listed online, with their address, the kind Multica and “Dana Founder · API token”. Each token is in the secret store under its own entry and in neither servers.json nor server.json, and the connection view the window reads does not hold it. Every request that carried a token went to the server that issued it.
- Test: `packages/agent-app/tests/multica-integration.test.ts::two Multica servers added with personal access tokens are both listed online, each token kept in the secret store and sent only to its own server`
- Environment: Node test runner; the runtime’s musterServer and paperclip handlers; two fake Multica servers on loopback HTTP (tests/fixtures/multica-fake-server.ts); a fake secret store.
- Known gaps: The fake server is modelled on real Multica answers but is not Multica itself. The keychain is faked; the real secret store’s encryption is the one Paperclip tokens already use and is not retested here.
- Evidence: UNVERIFIED

<a id="mus-spec-13-890b"></a>
#### MUS-SPEC-13-890B: Test connection says what is wrong with a Multica server

- Precondition: A fake Multica server on loopback, and a closed loopback port.
- Action: Test connection with an address that is not a URL, with a wrong token, with no token, and against the closed port.
- Expected result: The bad address fails at the config stage saying it is not a valid URL. The wrong token fails at the auth stage, names Multica, and includes Multica’s own error (“invalid token”). With no token the answer says Multica needs a personal access token and offers browser sign-in (case MUS-SPEC-13-894A runs it). The closed port fails at the network stage saying nothing answered.
- Test: `packages/agent-app/tests/multica-integration.test.ts::Test connection to a Multica server says what is wrong: a bad address, a token Multica refuses, a server that does not answer`
- Environment: Node test runner; the runtime’s paperclip.test handler; a fake Multica server on loopback HTTP.
- Known gaps: Does not cover a TLS failure or a slow server timing out.
- Evidence: UNVERIFIED

<a id="mus-spec-13-890c"></a>
#### MUS-SPEC-13-890C: A redirect never carries a Multica token away

- Precondition: A fake Multica server whose API answers 302 to a second fake server.
- Action: Test connection with the first server’s token.
- Expected result: The token goes to the first server only. The redirect is not followed, so the second server receives no request at all, and the test fails at the network stage.
- Test: `packages/agent-app/tests/multica-integration.test.ts::a Multica server that redirects never passes the token on: the redirect target receives nothing and the test fails`
- Environment: Node test runner; the runtime’s paperclip.test handler; two fake Multica servers on loopback HTTP.
- Known gaps: The redirect is refused outright, so its message says the server is not reachable rather than naming the redirect.
- Evidence: UNVERIFIED

<a id="mus-spec-13-890d"></a>
#### MUS-SPEC-13-890D: Where no sign-in window can open, Connect on a Multica address asks for a token

- Precondition: Settings › Integrations with no servers, where no sign-in window can open (the browser host); the address is a Multica server that needs a token.
- Action: Type the address and press Connect.
- Expected result: No browser sign-in is started and no sign-in window opens. A notice shows Multica’s instruction to create a personal access token, Other ways to connect is open with the token field on screen, and its hint says a Multica token starts with mul_.
- Test: `packages/agent-app/tests/multica-connect-dom.tsx::where no sign-in window can open, Connect on a Multica address opens the token field with Multica’s instructions`
- Environment: DOM suite (linkedom) rendering the real ServerList and ConnectionPanel with a stubbed bridge.
- Known gaps: The runtime answer is stubbed here; case MUS-SPEC-13-890B checks the runtime gives that answer.
- Evidence: UNVERIFIED

<a id="mus-spec-13-890e"></a>
#### MUS-SPEC-13-890E: A Multica token is refused in Multica’s words, or added

- Precondition: The token field is open for a Multica address.
- Action: Paste a wrong token and press Connect with token, then paste a good one and press it again.
- Expected result: The wrong token shows Multica’s own refusal and nothing is saved. The good token is saved as a custom server of kind multica for its first workspace, and the list shows the row named “Acme · Multica”, signed in as “Dana Founder · API token”. The token is not shown anywhere on screen.
- Test: `packages/agent-app/tests/multica-connect-dom.tsx::a refused Multica token shows Multica’s words; a good one adds the server, listed as Multica`
- Environment: DOM suite (linkedom) rendering the real ServerList and ConnectionPanel with a stubbed bridge.
- Known gaps: The runtime answers are stubbed; MUS-SPEC-13-890A covers the runtime side.
- Evidence: UNVERIFIED

<a id="mus-spec-13-890f"></a>
#### MUS-SPEC-13-890F: The Multica connect step reads as guidance

- Precondition: Connect was just pressed on a Multica address that needs a token, where no sign-in window can open (the browser host).
- Action: Look at the connect panel and the Integrations section description.
- Expected result: The instruction is a status notice, not shown in the error colour, and no error line repeats it. “How connecting works” lists Multica’s steps (create a personal access token in Multica › Settings › Tokens, starting with mul_; paste it and press Connect with token; the workspaces, projects and issues appear under Projects) and no step mentions a sign-in window. The token field has focus, Connect with token is the primary button and Connect is secondary. The Integrations description reads “Connect your team’s servers (Muster Server or Multica): their projects, tasks and agents show up in the app.”
- Test: `packages/agent-app/tests/multica-connect-dom.tsx::the Multica connect step reads as guidance: no error colour, Multica’s own steps, the token field focused and Connect with token primary`
- Environment: DOM suite (linkedom) rendering the real components with a stubbed bridge.
- Known gaps: Colours are not measured: the check is that the notice uses the notice style rather than the error class. The section description is read from its source list, not from the rendered Settings page.
- Evidence: UNVERIFIED

### Signing in to a Multica server on its own page

<a id="mus-spec-13-894a"></a>
#### MUS-SPEC-13-894A: Signing in on Multica’s page connects the server

- Precondition: A fake Multica server on loopback that signs people in on its /login page, the way Multica’s web app does for its own command-line tool, and nothing in Settings › Integrations.
- Action: Start the sign-in for the address (what Connect does), let a stand-in for the sign-in window open the page it is given and follow Multica’s redirect, then wait for the sign-in to finish.
- Expected result: The page is Multica’s /login with `cli_callback` set to Muster’s own listener on 127.0.0.1, on a random port, and a random 32-character `cli_state`. Multica’s redirect reaches Muster’s listener there, whose page says you are signed in. With the sign-in token, Muster asks Multica for one personal access token named “Muster Agent on” this computer, for 90 days, then checks the new token with /api/me. The sign-in ends signed in as the person. The new token is the server’s stored token (the same entry a pasted token uses), the sign-in token is stored nowhere, and the connection is a Multica server with workspaces to read.
- Test: `packages/agent-app/tests/multica-signin.test.ts::signing in on a Multica server’s own page connects it: the sign-in comes back to a loopback listener, is swapped for a personal access token and stored like a pasted one`
- Environment: Node test runner; the runtime’s paperclip and musterServer handlers with real timers; a fake Multica server on loopback HTTP (tests/fixtures/multica-fake-server.ts); a fake secret store; the stand-in window is fetch following redirects.
- Known gaps: The fake server’s /login redirects at once; Multica’s real page asks for an email code or Google first, and its web app performs the redirect in the page. The real Electron window is covered by MUS-SPEC-13-894H with Electron faked.
- Evidence: local; tests/multica-signin.test.ts (loopback Multica fixture); exit 0; 7 passed, 0 failed, 0 skipped; commit 186b925218d30dbef548bd1d42b3335d0b030bbf

<a id="mus-spec-13-894b"></a>
#### MUS-SPEC-13-894B: A callback with the wrong state is refused

- Precondition: A Multica sign-in is waiting for its callback.
- Action: Call the loopback callback with a sign-in token and the wrong state, then let the real page finish.
- Expected result: The wrong call is answered 400 and no personal access token is made from it. The sign-in keeps waiting and then finishes normally with the right state.
- Test: `packages/agent-app/tests/multica-signin.test.ts::a Multica sign-in callback with the wrong state is refused and makes no token`
- Environment: Node test runner; the runtime’s paperclip handlers; a fake Multica server on loopback HTTP.
- Known gaps: That the comparison takes constant time is checked by reading the code, not measured.
- Evidence: local; tests/multica-signin.test.ts (loopback Multica fixture); exit 0; 7 passed, 0 failed, 0 skipped; commit 186b925218d30dbef548bd1d42b3335d0b030bbf

<a id="mus-spec-13-894c"></a>
#### MUS-SPEC-13-894C: Only the first callback counts

- Precondition: A Multica sign-in is waiting, and a sign-in token with the right state is at hand.
- Action: Call the callback twice at the same moment, then once more after the sign-in finished.
- Expected result: Exactly one call is answered as signed in and Multica makes exactly one personal access token. The other call is refused. After the sign-in finished nothing listens on the callback port.
- Test: `packages/agent-app/tests/multica-signin.test.ts::only the first Multica sign-in callback counts: a second one is ignored and makes no second token`
- Environment: Node test runner; the runtime’s paperclip handlers; a fake Multica server on loopback HTTP.
- Known gaps: None known.
- Evidence: local; tests/multica-signin.test.ts (loopback Multica fixture); exit 0; 7 passed, 0 failed, 0 skipped; commit 186b925218d30dbef548bd1d42b3335d0b030bbf

<a id="mus-spec-13-894d"></a>
#### MUS-SPEC-13-894D: Cancel and the time limit shut the listener

- Precondition: A Multica sign-in is waiting, once with the normal limit and once with a limit of a fraction of a second.
- Action: Press Cancel on the first; let the second run out of time.
- Expected result: After Cancel the callback port no longer accepts a connection, and the sign-in reads cancelled. After the time limit the port no longer accepts a connection either, and the sign-in fails with a sentence that says Multica did not send the sign-in back in time and names pasting a personal access token under Other ways to connect.
- Test: `packages/agent-app/tests/multica-signin.test.ts::cancelling or timing out a Multica sign-in shuts its loopback listener`
- Environment: Node test runner; the runtime’s paperclip handlers with real timers and a shortened time limit; a fake Multica server on loopback HTTP.
- Known gaps: The real limit is 5 minutes; the test shortens it. Closing the window is covered by MUS-SPEC-13-894H (the window reports it) and the main process then cancels, which is not run here.
- Evidence: local; tests/multica-signin.test.ts (loopback Multica fixture); exit 0; 7 passed, 0 failed, 0 skipped; commit 186b925218d30dbef548bd1d42b3335d0b030bbf

<a id="mus-spec-13-894e"></a>
#### MUS-SPEC-13-894E: Neither token reaches the window or another address

- Precondition: A Multica sign-in that finishes.
- Action: Record every answer the window’s commands get (start, status, the connection view, the server list) and every event the runtime sends, then read the server files and every request each fake server received.
- Expected result: Neither the sign-in token nor the new personal access token appears in any of those answers or events, nor in servers.json or server.json. Only the Multica server received either token, the sign-in token only on the call that makes the personal access token. A second fake server on another port received nothing.
- Test: `packages/agent-app/tests/multica-signin.test.ts::neither Multica token ever reaches the window, the server files or another address`
- Environment: Node test runner; the runtime’s paperclip and musterServer handlers; two fake Multica servers on loopback HTTP.
- Known gaps: That the sign-in token is dropped from memory after the swap is checked by reading the code. Logs are not captured; the code writes neither token to a log.
- Evidence: local; tests/multica-signin.test.ts (loopback Multica fixture); exit 0; 7 passed, 0 failed, 0 skipped; commit 186b925218d30dbef548bd1d42b3335d0b030bbf

<a id="mus-spec-13-894f"></a>
#### MUS-SPEC-13-894F: A server too old for this sign-in falls back clearly

- Precondition: Two fake Multica servers: one whose page sends the sign-in back but that has no /api/tokens, and one whose page ignores `cli_callback`.
- Action: Sign in on each.
- Expected result: The first ends failed with Multica’s own answer (“404 page not found”), says the server may be too old to sign in from Muster, and names pasting a personal access token under Other ways to connect; nothing is stored. The second ends at the time limit with the sentence of MUS-SPEC-13-894D. Neither is left connected.
- Test: `packages/agent-app/tests/multica-signin.test.ts::a Multica server too old for sign-in from Muster ends with Multica’s words and points to the token fallback`
- Environment: Node test runner; the runtime’s paperclip handlers with a shortened time limit; fake Multica servers on loopback HTTP.
- Known gaps: Which Multica release added `cli_callback` is not checked; the behaviour is shown for a server without it.
- Evidence: local; tests/multica-signin.test.ts (loopback Multica fixture); exit 0; 7 passed, 0 failed, 0 skipped; commit 186b925218d30dbef548bd1d42b3335d0b030bbf

<a id="mus-spec-13-894g"></a>
#### MUS-SPEC-13-894G: Connect on a Multica address opens Multica’s sign-in page

- Precondition: Settings › Integrations in the desktop app with no servers; the address is a Multica server that needs a sign-in.
- Action: Enter the hostname without a scheme and press Connect. Retry after a failed sign-in and complete it.
- Expected result: The browser sign-in is started for the address and the sign-in window opens on the page the runtime returned (Multica’s /login). Connect is the primary button. “How connecting works” says to sign in on your server’s own page in the window, and Other ways to connect still holds the token field. While waiting, the panel says to sign in on your Multica page and offers Cancel. A failed sign-in shows Multica’s words as the error and opens Other ways to connect; a successful one closes the sign-in window.
- Test: `packages/agent-app/tests/multica-signin-dom.tsx::Connect on a Multica address opens Multica’s sign-in page in the window, and a failed sign-in points to the token path`
- Environment: DOM suite (linkedom) rendering the real ServerList and ConnectionPanel with a stubbed bridge.
- Known gaps: The runtime answers are stubbed; MUS-SPEC-13-894A to 894F cover the runtime side.
- Evidence: local; multica-signin-dom (real renderer components, stubbed bridge); exit 0; 1 passed, 0 failed, 0 skipped; commit 186b925218d30dbef548bd1d42b3335d0b030bbf

<a id="mus-spec-13-894h"></a>
#### MUS-SPEC-13-894H: The Multica sign-in window is isolated and goes only to its own callback

- Precondition: The sign-in window code with Electron faked.
- Action: Open the window on a Multica /login page whose `cli_callback` is a 127.0.0.1 port; navigate to that callback, to another path and another port on 127.0.0.1, and off the origin; close one window before the callback and one after.
- Expected result: The window has the same isolation as the other sign-in windows (its own partition, no Node, context isolation, the sandbox) and is titled “Sign in to Multica”. Its own callback is allowed and sent nowhere else; another loopback path or port and another site are refused in the window. A page without `cli_callback` may not go to 127.0.0.1 at all. Closing the window before its callback reports the sign-in as abandoned once; closing it after does not.
- Test: `packages/agent-app/tests/multica-signin.test.ts::the Multica sign-in window goes only to its own loopback callback, and closing it early abandons the sign-in`
- Environment: Node test runner; the main-process ServerSignInWindows with a fake Electron runtime.
- Known gaps: The main process’s reaction (cancel the waiting sign-in when it is this window’s) is wiring in src/main/index.ts and is not run here.
- Evidence: local; tests/multica-signin.test.ts (loopback Multica fixture); exit 0; 7 passed, 0 failed, 0 skipped; commit 186b925218d30dbef548bd1d42b3335d0b030bbf
