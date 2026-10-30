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
| [MUS-SPEC-13-804A](13-muster-server.md#mus-spec-13-804a) | The app signs in to a real Muster Server and lists and opens its project. | [`signs in with a password and lists and opens the seeded project on a real server`](../../../packages/agent-app/tests/server-e2e/server-workflows.e2e.ts) |
| [MUS-SPEC-13-804B](13-muster-server.md#mus-spec-13-804b) | A task made in the app or by someone else appears in the app. | [`creates a task in a server project and sees it appear, and sees a task someone else made arrive live`](../../../packages/agent-app/tests/server-e2e/server-workflows.e2e.ts) |
| [MUS-SPEC-13-804C](13-muster-server.md#mus-spec-13-804c) | The app rides out the server going away and coming back. | [`handles the server going away and coming back: the error is shown, then reads, the live socket and the sign-in resume`](../../../packages/agent-app/tests/server-e2e/server-workflows.e2e.ts) |
| [MUS-SPEC-13-804D](13-muster-server.md#mus-spec-13-804d) | Two real servers serve two app profiles at once without mixing their work. | [`two servers at once: two app profiles, each signed in to its own server, see only their own server’s work`](../../../packages/agent-app/tests/server-e2e/server-workflows.e2e.ts) |
| [MUS-SPEC-13-804E](13-muster-server.md#mus-spec-13-804e) | One app profile lists two real servers in Settings and shows both. | not written yet (#803) |

<a id="mus-spec-13-575a"></a>
#### MUS-SPEC-13-575A: A server value named like an object key falls back to the default

- Precondition: Server data whose status or kind is constructor, toString, hasOwnProperty or __proto__.
- Action: Map an agent, a run, an attention item and an approval.
- Expected result: The agent is idle, the run is failed, the item is kind other with "Needs your attention.", and the approval has a text title.
- Test: `packages/agent-app/tests/paperclip-map-bughunt.test.ts::a server status or kind named like an Object.prototype member falls back to the default`
- Environment: Node test runner; no network.
- Known gaps: Tests the mapping functions. It does not read from a live server.
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
