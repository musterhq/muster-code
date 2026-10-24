# MUS-SPEC-19: Security and redaction

Muster keeps the user's secrets out of transcripts, logs, memory and exports.

What the user can do:
- store keys and tokens in the system secret store;
- approve or decline when an agent asks for a secret;
- share or export a chat with secrets redacted.

Boundaries:
- A known secret value is replaced by a placeholder before it is shown, saved or sent to a model.
- The renderer never gets raw keys; it asks the main process to use them.

## Acceptance cases

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-19-154A](19-security-and-redaction.md#mus-spec-19-154a) | A secret saved in the secret store, printed by the agent in a command's output and in its reply, is not in the saved thread; the thread shows the mask with the secret's name. | [`a stored secret an agent prints is masked with its name in the saved thread`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154B](19-security-and-redaction.md#mus-spec-19-154b) | A secret in an environment variable, printed by the agent, is not in the saved thread; the thread shows the mask with the variable name. | [`an environment secret an agent prints is masked with its variable name in the saved thread`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154C](19-security-and-redaction.md#mus-spec-19-154c) | A Markdown, JSON and HTML export hold the mask and not the value, for a secret saved after it appeared in the chat. | [`exports mask a secret that was saved after it appeared in the chat`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154D](19-security-and-redaction.md#mus-spec-19-154d) | An export masks a stored secret that this run of the app has not read yet. | [`exports mask a stored secret that was not read in this session`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154E](19-security-and-redaction.md#mus-spec-19-154e) | The chat title made from a first message holding a stored secret does not hold the value. | [`a chat title made from a message holding a stored secret does not contain the value`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |

### Known secret values
<a id="mus-spec-19-154a"></a>
#### MUS-SPEC-19-154A: A stored secret the agent prints is masked in the saved thread

- Precondition: A key is saved in the secret store under the name DEPLOY_TOKEN. Its value looks like no known key format.
- Action: Send a message. The agent runs a command that prints the key and replies with the key.
- Expected result: The thread read back from the saved chat holds `••••(DEPLOY_TOKEN)` where the key was and never the key.
- Test: `packages/agent-app/tests/secret-registry-154.test.ts::a stored secret an agent prints is masked with its name in the saved thread`
- Environment: Node test runner; the agent service with a fake provider; a temp data folder; a stand-in for the system keychain.
- Known gaps: The model still receives the real output. Does not cover the Ledger record, backups, or the chat queue.
- Evidence: UNVERIFIED

<a id="mus-spec-19-154b"></a>
#### MUS-SPEC-19-154B: An environment secret the agent prints is masked in the saved thread

- Precondition: The app starts with an environment variable named MUSTER_TEST_154_API_TOKEN that holds a key in no known key format.
- Action: Send a message. The agent runs a command that prints the variable and replies with its value.
- Expected result: The saved thread holds `••••(MUSTER_TEST_154_API_TOKEN)` where the value was and never the value.
- Test: `packages/agent-app/tests/secret-registry-154.test.ts::an environment secret an agent prints is masked with its variable name in the saved thread`
- Environment: Node test runner; the agent service with a fake provider; a temp data folder.
- Known gaps: Only variables whose names say they hold a secret (KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL) are masked. Variables set after the app started are picked up on the next export or start.
- Evidence: UNVERIFIED

<a id="mus-spec-19-154c"></a>
#### MUS-SPEC-19-154C: Exports mask a secret that was saved after it appeared in the chat

- Precondition: A chat holds a message and a reply that contain a key. The key is saved in the secret store afterwards, under the name DEPLOY_TOKEN.
- Action: Export the chat as Markdown, JSON and HTML.
- Expected result: Each export holds `••••(DEPLOY_TOKEN)` and never the key. The list of what the export leaves out counts the replacement.
- Test: `packages/agent-app/tests/secret-registry-154.test.ts::exports mask a secret that was saved after it appeared in the chat`
- Environment: Node test runner; the agent service with a fake provider; a temp data folder; a stand-in for the system keychain.
- Known gaps: An export made with redaction turned off in the Share sheet keeps the text as written, by the user's choice.
- Evidence: UNVERIFIED

<a id="mus-spec-19-154d"></a>
#### MUS-SPEC-19-154D: Exports mask a stored secret the app has not read yet

- Precondition: A key was saved in the secret store in an earlier session. The app was restarted and nothing has read the key. A chat holds the key in its text.
- Action: Export the chat as Markdown.
- Expected result: The export holds `••••(DEPLOY_TOKEN)` and never the key.
- Test: `packages/agent-app/tests/secret-registry-154.test.ts::exports mask a stored secret that was not read in this session`
- Environment: Node test runner; the agent service with a fake provider; a temp data folder; a stand-in for the system keychain.
- Known gaps: The stored keys are read when the export is made, not when the app starts.
- Evidence: UNVERIFIED

<a id="mus-spec-19-154e"></a>
#### MUS-SPEC-19-154E: A chat title does not hold a stored secret

- Precondition: A key is saved in the secret store. A new chat has the default name.
- Action: Send a first message that holds the key.
- Expected result: The chat's name in the app snapshot does not hold the key.
- Test: `packages/agent-app/tests/secret-registry-154.test.ts::a chat title made from a message holding a stored secret does not contain the value`
- Environment: Node test runner; the agent service with a fake provider; a temp data folder; a stand-in for the system keychain.
- Known gaps: Only titles made by Muster from the first message are covered; a title the user types is theirs.
- Evidence: UNVERIFIED
