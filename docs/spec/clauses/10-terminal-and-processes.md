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
