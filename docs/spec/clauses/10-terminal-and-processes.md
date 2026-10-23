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
