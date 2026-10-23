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
| [MUS-SPEC-10-642A](10-terminal-and-processes.md#mus-spec-10-642a) | With the terminal dock open, moving through five chats starts no shell and shows the empty state with New terminal; opening Terminal starts exactly one shell for that chat, and opening it again adds none. | [`browsing chats with the terminal dock open starts no shell; opening Terminal starts exactly one`](../../../packages/agent-app/tests/processes-components.tsx) |

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
