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
| [MUS-SPEC-10-473A](10-terminal-and-processes.md#mus-spec-10-473a) | run_background starts an agent-owned process; after the turn ends and it exits, one follow-up with the name, exit code and output is queued; a Workspace chat gets a Full access error. | [`run_background starts an agent-owned process mid-turn; its exit after the turn queues one follow-up`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-473B](10-terminal-and-processes.md#mus-spec-10-473b) | One follow-up per process with its exit code and the last 40 output lines; a repeat exit queues nothing. | [`a process that exits after the turn ended queues exactly one continuation with its code and last 40 lines`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-473C](10-terminal-and-processes.md#mus-spec-10-473c) | An exit during a running turn, including a later turn, queues no follow-up. | [`no continuation when the chat is still mid-turn at exit (the agent sees it itself), and not later either`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-473D](10-terminal-and-processes.md#mus-spec-10-473d) | User-owned processes, stopped processes, stopped turns and deleted or archived chats never queue a follow-up. | [`never for a user-started process, a user-stopped process, a user-stopped turn, a deleted or archived chat`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-10-473E](10-terminal-and-processes.md#mus-spec-10-473e) | stop_background refuses the user's command, stops the agent's own process, and a stopped process sends no follow-up. | [`stop_background stops only the agent’s own process, and a stopped process sends no follow-up`](../../../packages/agent-app/tests/process-continuations.test.ts) |

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
A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

|---|---|---|
