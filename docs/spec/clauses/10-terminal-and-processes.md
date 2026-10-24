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
| [MUS-SPEC-10-634A](10-terminal-and-processes.md#mus-spec-10-634a) | A terminal whose start finishes after its pane was closed is sent a kill request. | [`a terminal that finishes starting after its pane closed is shut down`](../../../packages/agent-app/tests/processes-components.tsx) |
| [MUS-SPEC-10-634B](10-terminal-and-processes.md#mus-spec-10-634b) | When opening a terminal fails with the internal call wrapper in the message, the pane shows only the plain sentence. | [`a terminal error shows as plain text without the internal call wrapper`](../../../packages/agent-app/tests/processes-components.tsx) |
| [MUS-SPEC-10-473A](10-terminal-and-processes.md#mus-spec-10-473a) | run_background starts an agent-owned process; after the turn ends and it exits, one follow-up with the name, exit code and output is queued; a Workspace chat gets a Full access error. | [`run_background starts an agent-owned process mid-turn; its exit after the turn queues one follow-up`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-473B](10-terminal-and-processes.md#mus-spec-10-473b) | One follow-up per process with its exit code and the last 40 output lines; a repeat exit queues nothing. | [`a process that exits after the turn ended queues exactly one continuation with its code and last 40 lines`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-473C](10-terminal-and-processes.md#mus-spec-10-473c) | An exit during a running turn, including a later turn, queues no follow-up. | [`no continuation when the chat is still mid-turn at exit (the agent sees it itself), and not later either`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-473D](10-terminal-and-processes.md#mus-spec-10-473d) | User-owned processes, stopped processes, stopped turns and deleted or archived chats never queue a follow-up. | [`never for a user-started process, a user-stopped process, a user-stopped turn, a deleted or archived chat`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-473E](10-terminal-and-processes.md#mus-spec-10-473e) | stop_background refuses the user's command, stops the agent's own process, and a stopped process sends no follow-up. | [`stop_background stops only the agent’s own process, and a stopped process sends no follow-up`](../../../packages/agent-app/tests/process-continuations.test.ts) |

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
