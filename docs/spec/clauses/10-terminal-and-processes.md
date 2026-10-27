# MUS-SPEC-10: Terminal and background processes

The terminal dock gives the user shells in the chat's folder. Background processes are commands and services the agent or the user leaves running.

What the user can do:
- open, split, rename and close terminals, and let the agent read or use a terminal when allowed;
- see running processes and listening ports, read their output, and stop or restart them;
- find a process's output again after a restart.

Boundaries:
- Quitting Muster stops the processes it started, unless the user chose to keep one.
- Output is kept within a size limit; older output is dropped with a marker, never silently.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-10-455A](10-terminal-and-processes.md#mus-spec-10-455a) | The user-process note lists the chat's folder first, forbids touching only the listed local process groups, allows remote hosts and services, and is empty when nothing is running. | [`the agent is told which live processes belong to the user`](../../../packages/agent-app/tests/dogfood-runtime-fixes.test.ts) |
| [MUS-SPEC-10-455B](10-terminal-and-processes.md#mus-spec-10-455b) | The rule text says local machine only, names the user's terminals, Commands-tab commands and dev servers, and lists the allowed exceptions. | [`the process-ownership rule is scoped to local processes and names the allowed exceptions`](../../../packages/agent-app/tests/dogfood-runtime-fixes.test.ts) |
| [MUS-SPEC-10-634A](10-terminal-and-processes.md#mus-spec-10-634a) | A terminal whose start finishes after its pane was closed is sent a kill request. | [`a terminal that finishes starting after its pane closed is shut down`](../../../packages/agent-app/tests/processes-components.tsx) |
| [MUS-SPEC-10-634B](10-terminal-and-processes.md#mus-spec-10-634b) | When opening a terminal fails with the internal call wrapper in the message, the pane shows only the plain sentence. | [`a terminal error shows as plain text without the internal call wrapper`](../../../packages/agent-app/tests/processes-components.tsx) |
| [MUS-SPEC-10-473A](10-terminal-and-processes.md#mus-spec-10-473a) | run_background starts an agent-owned process; after the turn ends and it exits, one follow-up with the name, exit code and output is queued; a Workspace chat gets a Full access error. | [`run_background starts an agent-owned process mid-turn; its exit after the turn queues one follow-up`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-473B](10-terminal-and-processes.md#mus-spec-10-473b) | One follow-up per process with its exit code and the last 40 output lines; a repeat exit queues nothing. | [`a process that exits after the turn ended queues exactly one continuation with its code and last 40 lines`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-473C](10-terminal-and-processes.md#mus-spec-10-473c) | An exit during a running turn, including a later turn, queues no follow-up. | [`no continuation when the chat is still mid-turn at exit (the agent sees it itself), and not later either`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-473D](10-terminal-and-processes.md#mus-spec-10-473d) | User-owned processes, stopped processes, stopped turns and deleted or archived chats never queue a follow-up. | [`never for a user-started process, a user-stopped process, a user-stopped turn, a deleted or archived chat`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-473E](10-terminal-and-processes.md#mus-spec-10-473e) | stop_background refuses the user's command, stops the agent's own process, and a stopped process sends no follow-up. | [`stop_background stops only the agent’s own process, and a stopped process sends no follow-up`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-642A](10-terminal-and-processes.md#mus-spec-10-642a) | With the terminal dock open, moving through five chats starts no shell and shows the empty state with New terminal; opening Terminal starts exactly one shell for that chat, and opening it again adds none. | [`browsing chats with the terminal dock open starts no shell; opening Terminal starts exactly one`](../../../packages/agent-app/tests/processes-components.tsx) |
| [MUS-SPEC-10-407A](10-terminal-and-processes.md#mus-spec-10-407a) | Stop closes the app-server and its real tool child. | [`closing the stopped app-server ends the dev server it started`](../../../packages/agent-app/tests/runtime-quality-407.test.ts) |
| [MUS-SPEC-10-407B](10-terminal-and-processes.md#mus-spec-10-407b) | A tool child that ignores SIGTERM is gone even when its CLI parent exits first. | [`Stop ends a tool child even when the CLI exits before its child`](../../../packages/agent-app/tests/runtime-quality-407.test.ts) |
| [MUS-SPEC-10-407C](10-terminal-and-processes.md#mus-spec-10-407c) | Startup reaps a saved process only when the recorded start time matches, even if the same command is still at that PID. | [`startup leaves a saved PID alive when its recorded process start time differs`](../../../packages/agent-app/tests/runtime-quality-407.test.ts) |
| [MUS-SPEC-10-407D](10-terminal-and-processes.md#mus-spec-10-407d) | An oversized stdout line fails a turn instead of forwarding or buffering its payload. | [`an oversized app-server output line fails the turn with a bounded error`](../../../packages/agent-app/tests/runtime-quality-407.test.ts) |
| [MUS-SPEC-10-407E](10-terminal-and-processes.md#mus-spec-10-407e) | An app-server closing stdin fails the request without an uncaught EPIPE in the host. | [`a closed app-server input fails the request without an uncaught pipe error`](../../../packages/agent-app/tests/runtime-quality-407.test.ts) |

### What the agent may stop

<a id="mus-spec-10-455a"></a>
#### MUS-SPEC-10-455A: The agent is told which live processes are the user's, and only local ones

- Precondition: The user has two terminals running in Muster, one in the chat's folder and one in another folder.
- Action: Build the note that tells the agent about the user's live processes. Build it again with no processes.
- Expected result: The note lists both process groups, the one in the chat's folder first. It tells the agent never to signal, kill or restart the listed process groups. It says remote hosts (ssh, servers), systemd or launchd services and anything the user explicitly asks for are allowed. With no processes the note is empty.
- Test: `packages/agent-app/tests/dogfood-runtime-fixes.test.ts::the agent is told which live processes belong to the user`
- Environment: Node test runner; no provider or network.
- Known gaps: Calls the note builder directly, not through a running turn. It does not show a model obeying the note.
- Evidence: UNVERIFIED

<a id="mus-spec-10-455b"></a>
#### MUS-SPEC-10-455B: The ownership rule covers local processes only

- Precondition: A chat in Agent mode.
- Action: Read the process-ownership rule that goes into the agent's instructions.
- Expected result: The rule says it covers the local machine only and names in-app terminals, Commands-tab commands and dev servers as the user's. It says it does not apply to remote hosts (ssh, servers), systemd or launchd services, or anything the user explicitly asks for.
- Test: `packages/agent-app/tests/dogfood-runtime-fixes.test.ts::the process-ownership rule is scoped to local processes and names the allowed exceptions`
- Environment: Node test runner; no provider or network.
- Known gaps: A unit test of the rule's wording. It does not show how a model follows the rule.
- Evidence: UNVERIFIED

### Terminal panes

<a id="mus-spec-10-634a"></a>
#### MUS-SPEC-10-634A: A shell that starts after its pane closed does not keep running

- Precondition: A terminal pane asks for a new shell, and the shell's start is still pending.
- Action: Close the pane, then let the start finish.
- Expected result: The shell that was created is closed by the app (a kill request for that terminal id is sent), so nothing keeps running with no pane to show it.
- Test: `packages/agent-app/tests/processes-components.tsx::a terminal that finishes starting after its pane closed is shut down`
- Environment: DOM suite (`linkedom`); the app's calls are faked, so no real shell starts.
- Known gaps: Shows that a kill request is sent, not that a real shell process ends. The session-level tests in `tests/terminal-pty.test.ts` (20 open and close rounds leave no sessions; closing an ended terminal; the cap of 12) need a built `node-pty` and are not linked here.
- Evidence: UNVERIFIED

<a id="mus-spec-10-634b"></a>
#### MUS-SPEC-10-634B: Terminal errors read as plain text

- Precondition: Opening a terminal fails with the message "Error invoking remote method 'muster:invoke': Error: Close a terminal before opening another (maximum 12)."
- Action: Show the terminal pane for a chat.
- Expected result: The pane shows "Close a terminal before opening another (maximum 12)." and nothing of the internal wrapper text.
- Test: `packages/agent-app/tests/processes-components.tsx::a terminal error shows as plain text without the internal call wrapper`
- Environment: DOM suite (`linkedom`); the app's calls are faked.
- Known gaps: Uses one error message, the terminal cap. Other error texts are not checked.
- Evidence: UNVERIFIED

### Background processes the agent starts

<a id="mus-spec-10-473a"></a>
#### MUS-SPEC-10-473A: A background process the agent started wakes the chat when it exits

- Precondition: A chat in Agent mode with Full access, mid-turn.
- Action: The agent starts a build with run_background and reads its output. The turn ends while the build runs, then the build exits with code 1.
- Expected result: The process is listed as agent-owned and read_background shows its output. After the exit, exactly one follow-up message is queued: it names the process, gives the exit code and includes the output. A Read only or Workspace chat gets a tool error naming Full access instead.
- Test: `packages/agent-app/tests/process-continuations.test.ts::run_background starts an agent-owned process mid-turn; its exit after the turn queues one follow-up`
- Environment: Node test runner; real child processes on a temp folder; no provider or network.
- Known gaps: The follow-up goes to a recording queue, not the real chat queue. The provider's own shell background jobs are not covered.
- Evidence: UNVERIFIED

<a id="mus-spec-10-473b"></a>
#### MUS-SPEC-10-473B: One follow-up per process, with the exit code and the last 40 lines

- Precondition: A chat whose turn ended while an agent-owned process was still running.
- Action: The process exits with code 2 after printing 60 lines, and the exit is reported twice.
- Expected result: One follow-up is queued, with a request ID that is safe to store. It names the process and the exit code and holds lines 21 to 60 only. The second report queues nothing.
- Test: `packages/agent-app/tests/process-continuations.test.ts::a process that exits after the turn ended queues exactly one continuation with its code and last 40 lines`
- Environment: Node test runner; no provider or network.
- Known gaps: Drives the continuation module with a fake chat list and fake exits, not a real process. MUS-SPEC-10-473A is the end-to-end case.
- Evidence: UNVERIFIED

<a id="mus-spec-10-473c"></a>
#### MUS-SPEC-10-473C: No follow-up while the agent is still in the turn

- Precondition: An agent-owned process is running in a chat.
- Action: The process exits during the turn that started it, and in a later turn.
- Expected result: No follow-up is queued, because the agent sees the exit itself in that turn.
- Test: `packages/agent-app/tests/process-continuations.test.ts::no continuation when the chat is still mid-turn at exit (the agent sees it itself), and not later either`
- Environment: Node test runner; no provider or network.
- Known gaps: Fake chat list and fake exits, not a real process.
- Evidence: UNVERIFIED

<a id="mus-spec-10-473d"></a>
#### MUS-SPEC-10-473D: No follow-up for the user's processes, stopped work or gone chats

- Precondition: Processes started by the user, a process the user stopped, a chat whose turn the user stopped, and a deleted and an archived chat.
- Action: Each process exits after its chat's turn ended.
- Expected result: No follow-up is queued for any of them.
- Test: `packages/agent-app/tests/process-continuations.test.ts::never for a user-started process, a user-stopped process, a user-stopped turn, a deleted or archived chat`
- Environment: Node test runner; no provider or network.
- Known gaps: Fake chat list and fake exits, not a real process.
- Evidence: UNVERIFIED

<a id="mus-spec-10-473e"></a>
#### MUS-SPEC-10-473E: The agent can stop only its own background processes

- Precondition: A user-started command and an agent-started process in the same chat.
- Action: The agent asks stop_background to stop each one, and the turn ends.
- Expected result: The user's command is refused ("No background process") and keeps running as the user's. The agent's process stops and no follow-up is queued for it.
- Test: `packages/agent-app/tests/process-continuations.test.ts::stop_background stops only the agent’s own process, and a stopped process sends no follow-up`
- Environment: Node test runner; real child processes on a temp folder; no provider or network.
- Known gaps: Uses the real process registry; the follow-up queue is a recording stub.
- Evidence: UNVERIFIED

### When a terminal starts

<a id="mus-spec-10-642a"></a>
#### MUS-SPEC-10-642A: Switching chats does not start a shell

- Precondition: The bottom terminal dock is open and no chat has a terminal.
- Action: Move through five chats one after another. Then press "Open Terminal" for the current chat, and press it once more.
- Expected result: No shell is started while moving through the chats; each chat shows "No terminal is open" with a New terminal button. Opening Terminal starts exactly one shell, for the current chat, and reloads that chat's terminal list once. Opening it again does not start a second shell.
- Test: `packages/agent-app/tests/processes-components.tsx::browsing chats with the terminal dock open starts no shell; opening Terminal starts exactly one`
- Environment: DOM suite (`linkedom`); the app's calls are faked, so no real shell starts.
- Known gaps: Counts the create requests the screen sends, not real shells. The Show panel button in the Terminal pane and the retry after a failed open are asserted in the same suite but outside this check, and the first also passes on `main`, so they are not linked. The suite `tests/terminal-load-retry-dom.tsx` was changed to ask for a terminal first; it is not linked here.
- Evidence: UNVERIFIED

### Runtime ownership and unanswered requests

<a id="mus-spec-10-407a"></a>
#### MUS-SPEC-10-407A: Stop closes the app-server and its real tool child.

- Precondition: An app-server turn has started a long-running child command.
- Action: Stop the turn and close its owned session.
- Expected result: The run settles and the child process is gone.
- Test: `packages/agent-app/tests/runtime-quality-407.test.ts::closing the stopped app-server ends the dev server it started`
- Environment: Node test runner, temporary folders and owned child processes.
- Known gaps: A fake app-server speaks the real stdio protocol. POSIX process-group check; Windows requires CI.
- Evidence: local; cd packages/agent-app && node --experimental-transform-types --test tests/runtime-quality-407.test.ts; exit 0; 6 passed, 0 failed, 0 skipped; commit e1d4ec882cfdc8399da27908cdbc9ad3166ac23e

<a id="mus-spec-10-407b"></a>
#### MUS-SPEC-10-407B: A tool child that ignores SIGTERM is gone even when its CLI parent exits first.

- Precondition: A CLI started a child that ignores SIGTERM and does not hold the parent output pipes.
- Action: Stop the turn.
- Expected result: The run reports Stopped and the child is killed rather than surviving a cancelled escalation timer.
- Test: `packages/agent-app/tests/runtime-quality-407.test.ts::Stop ends a tool child even when the CLI exits before its child`
- Environment: Node test runner, temporary folders and owned child processes.
- Known gaps: Real Node parent and child processes through the common JSON-lines path and all five CLI adapters. The launcher substitutes a local script for the external CLI; POSIX check.
- Evidence: local; cd packages/agent-app && node --experimental-transform-types --test tests/runtime-quality-407.test.ts; exit 0; 6 passed, 0 failed, 0 skipped; commit e1d4ec882cfdc8399da27908cdbc9ad3166ac23e

<a id="mus-spec-10-407c"></a>
#### MUS-SPEC-10-407C: Startup reaps a saved process only when the recorded start time matches, even if the same command is still at that PID.

- Precondition: A saved service PID points at a real process with the same command.
- Action: Start the service runner with a different recorded start time, then the matching start time.
- Expected result: Mismatched and legacy records leave the process alive; the matching owned group is stopped. Newly started services record the OS start time.
- Test: `packages/agent-app/tests/runtime-quality-407.test.ts::startup leaves a saved PID alive when its recorded process start time differs`
- Environment: Node test runner, temporary folders and owned child processes.
- Known gaps: Real child and PID file; a mismatched timestamp simulates PID reuse without exhausting the PID space. POSIX check.
- Evidence: local; cd packages/agent-app && node --experimental-transform-types --test tests/runtime-quality-407.test.ts; exit 0; 6 passed, 0 failed, 0 skipped; commit e1d4ec882cfdc8399da27908cdbc9ad3166ac23e

<a id="mus-spec-10-407d"></a>
#### MUS-SPEC-10-407D: An oversized stdout line fails a turn instead of forwarding or buffering its payload.

- Precondition: An app-server responds to a turn with a 17 MiB JSON output line.
- Action: Run the turn through the stdio client.
- Expected result: The turn fails with an oversized-line error and no giant final message.
- Test: `packages/agent-app/tests/runtime-quality-407.test.ts::an oversized app-server output line fails the turn with a bounded error`
- Environment: Node test runner, temporary folders and owned child processes.
- Known gaps: A fake app-server process; no network. The cap is exercised across multiple stream chunks.
- Evidence: local; cd packages/agent-app && node --experimental-transform-types --test tests/runtime-quality-407.test.ts; exit 0; 6 passed, 0 failed, 0 skipped; commit e1d4ec882cfdc8399da27908cdbc9ad3166ac23e

<a id="mus-spec-10-407e"></a>
#### MUS-SPEC-10-407E: An app-server closing stdin fails the request without an uncaught EPIPE in the host.

- Precondition: An app-server closes its input after reading initialize.
- Action: Let the client send its next message.
- Expected result: The request fails normally and the host records no uncaught pipe error.
- Test: `packages/agent-app/tests/runtime-quality-407.test.ts::a closed app-server input fails the request without an uncaught pipe error`
- Environment: Node test runner, temporary folders and owned child processes.
- Known gaps: Separate Node host and fake app-server processes; POSIX file-descriptor close. Windows requires CI.
- Evidence: local; cd packages/agent-app && node --experimental-transform-types --test tests/runtime-quality-407.test.ts; exit 0; 6 passed, 0 failed, 0 skipped; commit e1d4ec882cfdc8399da27908cdbc9ad3166ac23e
