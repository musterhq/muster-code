# MUS-SPEC-19: Security and redaction

Muster keeps the user's secrets out of transcripts, logs, memory and exports.

What the user can do:
- store keys and tokens in the system secret store;
- approve or decline when an agent asks for a secret;
- type a secret or sudo password on a private card when an agent needs one, once or remembered for a folder;
- share or export a chat with secrets redacted.

Boundaries:
- A known secret value is replaced by a placeholder before it is shown, saved or sent to a model.
- The renderer never gets raw keys; it asks the main process to use them.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-19-154A](19-security-and-redaction.md#mus-spec-19-154a) | A secret saved in the secret store, printed by the agent in a command's output and in its reply, is not in the saved thread; the thread shows the mask with the secret's name. | [`a stored secret an agent prints is masked with its name in the saved thread`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154B](19-security-and-redaction.md#mus-spec-19-154b) | A secret in an environment variable, printed by the agent, is not in the saved thread; the thread shows the mask with the variable name. | [`an environment secret an agent prints is masked with its variable name in the saved thread`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154C](19-security-and-redaction.md#mus-spec-19-154c) | A Markdown, JSON and HTML export hold the mask and not the value, for a secret saved after it appeared in the chat. | [`exports mask a secret that was saved after it appeared in the chat`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154D](19-security-and-redaction.md#mus-spec-19-154d) | An export masks a stored secret that this run of the app has not read yet. | [`exports mask a stored secret that was not read in this session`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154E](19-security-and-redaction.md#mus-spec-19-154e) | The chat title made from a first message holding a stored secret does not hold the value. | [`a chat title made from a message holding a stored secret does not contain the value`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-564A](19-security-and-redaction.md#mus-spec-19-564a) | On Windows, `file://host/share`, `\\host\share` and `//host/share` references are refused with "Choose a file". | [`Windows network (UNC) paths are not opened from transcript references`](../../../packages/agent-app/tests/open-with.test.ts) |
| [MUS-SPEC-19-571A](19-security-and-redaction.md#mus-spec-19-571a) | A password with an @ is fully masked in git error text. | [`credential redaction masks a password that contains an @`](../../../packages/agent-app/tests/review-bughunt.test.ts) |
| [MUS-SPEC-19-575A](19-security-and-redaction.md#mus-spec-19-575a) | Redacting 60,000 name-like characters takes under 400 ms. | [`redacting a long run of name-like characters is not quadratic`](../../../packages/agent-app/tests/sanitize-bughunt.test.ts) |
| [MUS-SPEC-19-575B](19-security-and-redaction.md#mus-spec-19-575b) | URL credentials, including a password with an @, are masked; plain URLs are not. | [`credentials in a URL are still redacted`](../../../packages/agent-app/tests/sanitize-bughunt.test.ts) |
| [MUS-SPEC-19-575C](19-security-and-redaction.md#mus-spec-19-575c) | Four long inputs of repeated secret words each redact in under 400 ms. | [`a long run of secret words stays linear`](../../../packages/agent-app/tests/sanitize-bughunt.test.ts) |
| [MUS-SPEC-19-577A](19-security-and-redaction.md#mus-spec-19-577a) | Clone URLs with a token as the username are refused. | [`clone URLs whose username is a token are rejected`](../../../packages/agent-app/tests/clone-url-token.test.ts) |
| [MUS-SPEC-19-674A](19-security-and-redaction.md#mus-spec-19-674a) | Values under key names longer than 70 characters are redacted. | [`a secret whose key name is longer than 70 characters is redacted`](../../../packages/agent-app/tests/secret-redaction-long-names.test.ts) |
| [MUS-SPEC-19-710A](19-security-and-redaction.md#mus-spec-19-710a) | A folder swapped for a link at the file open creates no file outside, even temporarily empty. | [`a workspace write raced at file creation leaves no empty file outside`](../../../packages/agent-app/tests/workspace-write-race-710.test.ts) |
| [MUS-SPEC-19-710B](19-security-and-redaction.md#mus-spec-19-710b) | A folder swapped at parent creation creates no empty folder outside. | [`a workspace write raced at parent creation leaves no folder outside`](../../../packages/agent-app/tests/workspace-write-race-710.test.ts) |
| [MUS-SPEC-19-710C](19-security-and-redaction.md#mus-spec-19-710c) | An edit raced at its write open creates nothing outside and keeps an existing outside file unchanged. | [`a workspace edit raced at file open leaves nothing outside and preserves outside files`](../../../packages/agent-app/tests/workspace-write-race-710.test.ts) |
| [MUS-SPEC-19-406A](19-security-and-redaction.md#mus-spec-19-406a) | A chat uses MCP credentials through a private config file; process arguments never contain the credentials and the file is removed afterwards. | [`a chat can use its MCP credentials without exposing them in Claude process arguments`](../../../packages/agent-app/tests/hardening-406.test.ts) |
| [MUS-SPEC-19-406B](19-security-and-redaction.md#mus-spec-19-406b) | MCP credentials without a secret prefix reach the chat through thread config, never launch arguments. | [`a coding-client chat receives unmarked MCP credentials through stdin instead of command arguments`](../../../packages/agent-app/tests/hardening-406.test.ts) |
| [MUS-SPEC-19-406C](19-security-and-redaction.md#mus-spec-19-406c) | Provider endpoint host and port edits clear the old stored key and environment binding before discovery; a path edit retains them. | [`editing a provider endpoint never sends its old stored key to the new origin`](../../../packages/agent-app/tests/hardening-406.test.ts) |
| [MUS-SPEC-19-406D](19-security-and-redaction.md#mus-spec-19-406d) | Memory endpoint host, port and scheme edits clear encrypted and session-only keys before a connection test; same-origin edits retain them. | [`editing the memory endpoint never sends the old key to a different origin`](../../../packages/agent-app/tests/memory-run.test.ts) |
| [MUS-SPEC-19-406E](19-security-and-redaction.md#mus-spec-19-406e) | Every external action in every workflow uses a full commit SHA and records its version in a trailing comment. | [`every external workflow action is pinned to a full commit with its version recorded`](../../../packages/agent-app/tests/hardening-406.test.ts) |
| [MUS-SPEC-19-406F](19-security-and-redaction.md#mus-spec-19-406f) | The mandatory release guard refuses missing or ad-hoc signing and accepts the three supported identity modes before packaging. | [`the macOS release refuses ad-hoc signing before it packages a build`](../../../packages/agent-app/tests/hardening-406.test.ts) |
| [MUS-SPEC-19-842A](19-security-and-redaction.md#mus-spec-19-842a) | The card shows the name, reason, who asks and a deadline, and counts as a request. The tool result holds a file path and how to pass it to a command, never the value. The file is 0600 and holds the value; it is removed when the run ends. | [`an agent on a CLI route asks for a secret on a private card and gets a file reference, never the value`](../../../packages/agent-app/tests/secret-requests-842.test.ts) |
| [MUS-SPEC-19-842B](19-security-and-redaction.md#mus-spec-19-842b) | The tool result has no value; the next command sees the value in its environment; output that prints it reaches the model as `••••(NAME)`; no timeline event holds it. Read-only does not offer the tool. | [`on an HTTP route the secret is set in the environment of the next commands and masked in what the model reads`](../../../packages/agent-app/tests/secret-requests-842.test.ts) |
| [MUS-SPEC-19-842C](19-security-and-redaction.md#mus-spec-19-842c) | The saved thread shows `••••(NAME)` and never the value; Markdown, JSON and HTML exports hold no value; the next turn sent to the provider (prompt, instructions, overrides) holds no value; no file under the data folder (SQLite database, WAL, output logs) holds it. | [`a requested secret never lands in the timeline database, output logs, exports or the next prompt`](../../../packages/agent-app/tests/secret-requests-842.test.ts) |
| [MUS-SPEC-19-842D](19-security-and-redaction.md#mus-spec-19-842d) | Read-only: the tool answers with an error naming read-only, no card is posted, no sudo helper is set and the instructions do not mention request_secret. Full access: the card is posted and the tool waits until the person answers. | [`a read-only chat cannot request a secret; Full access still shows the card and waits for the person`](../../../packages/agent-app/tests/secret-requests-842.test.ts) |
| [MUS-SPEC-19-842E](19-security-and-redaction.md#mus-spec-19-842e) | The agent is told it was declined (no value, no environment) and the card is Dismissed; the unanswered one tells the agent there was no answer, the card is Expired and a late answer is refused. | [`a declined or unanswered secret request tells the agent so and the card says what happened`](../../../packages/agent-app/tests/secret-requests-842.test.ts) |
| [MUS-SPEC-19-842F](19-security-and-redaction.md#mus-spec-19-842f) | Without Remember nothing is stored. With Remember one encrypted entry is stored and the file has no plain value. The later request is answered at once from it and the card says the saved value was used. Forget removes it. | [`one-time is the default; "Remember for this folder" keeps it encrypted and answers the next request in that folder`](../../../packages/agent-app/tests/secret-requests-842.test.ts) |
| [MUS-SPEC-19-842G](19-security-and-redaction.md#mus-spec-19-842g) | The instructions tell agents to use `sudo -A`. The card shows the sudo prompt and offers keychain storage, off by default. The helper prints the password to stdout only and exits 0; unanswered, it prints nothing, exits non-zero and the card is Expired. No saved file or timeline row holds the password. | [`sudo -A in an agent shell asks through the card, prints the password only to sudo, and times out cleanly`](../../../packages/agent-app/tests/secret-requests-842.test.ts) |
| [MUS-SPEC-19-842H](19-security-and-redaction.md#mus-spec-19-842h) | The card offers 1Password. A failed lookup is an error naming 1Password and leaves the card open. The right one gives the agent the value; the card records the source and holds no value. | [`a secret can be picked from 1Password by reference; the value goes from op to the agent only`](../../../packages/agent-app/tests/secret-requests-842.test.ts) |
| [MUS-SPEC-19-842I](19-security-and-redaction.md#mus-spec-19-842i) | The server lists request_secret and ask_user, not the sudo channel, and the provider tool timeout is at least 300 seconds. | [`the secret request tool sits beside ask_user in the muster_ask server and the run waits long enough for a person`](../../../packages/agent-app/tests/secret-requests-842.test.ts) |
| [MUS-SPEC-19-842J](19-security-and-redaction.md#mus-spec-19-842j) | The field is a password field with autocomplete off; Remember is unchecked; Send is disabled until a value is typed; one secret.answer call carries the value with remember false; the field is cleared; Decline sends secret.decline. | [`the secret card takes a masked value, sends it once and clears the field`](../../../packages/agent-app/tests/secret-request-card-842-dom.tsx) |
| [MUS-SPEC-19-842K](19-security-and-redaction.md#mus-spec-19-842k) | The sudo card offers keychain storage; the 1Password reference is sent instead of a value; an answered card says Sent privately with no field; a saved-value card offers Forget; an expired card says No answer in time. | [`a sudo card, a 1Password pick and a settled card read plainly and never show a value`](../../../packages/agent-app/tests/secret-request-card-842-dom.tsx) |
| [MUS-SPEC-19-147A](19-security-and-redaction.md#mus-spec-19-147a) | Relative paths with `..`, absolute paths, newlines and links that lead out of the folder are refused for reads and writes; names holding quotes, `;` and `$(…)` are written literally and run nothing. | [`remote file paths stay inside the folder and are never run by the shell`](../../../packages/agent-app/tests/ssh-workspaces-147.test.ts) |

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

### Paths from replies

<a id="mus-spec-19-564a"></a>
#### MUS-SPEC-19-564A: A network share link in a reply is refused on Windows

- Precondition: The app runs on Windows and a reply holds a link to a file on a network share (UNC path).
- Action: Resolve each of the three forms of that link the way the files domain does before it inspects or opens a file.
- Expected result: Each one throws "Choose a file on this computer." so Windows never contacts the share.
- Test: `packages/agent-app/tests/open-with.test.ts::Windows network (UNC) paths are not opened from transcript references`
- Environment: Node test runner; no network, no provider. The Windows rule is switched on by a parameter, so it runs on any system.
- Known gaps: Tests the path check on its own, not a click on a link in a reply.
- Evidence: UNVERIFIED

<a id="mus-spec-19-571a"></a>
#### MUS-SPEC-19-571A: A git error message hides a password that contains an @

- Precondition: A git error line that holds a URL with user:p@ssw0rd as its credentials.
- Action: Run the line through the git text redaction.
- Expected result: No part of the password is left, the host and path are kept, and a plain URL with an @ in its query is unchanged.
- Test: `packages/agent-app/tests/review-bughunt.test.ts::credential redaction masks a password that contains an @`
- Environment: Node test runner; no network.
- Known gaps: Unit test of redactGitText. It does not run a real failing git command.
- Evidence: UNVERIFIED

<a id="mus-spec-19-575a"></a>
#### MUS-SPEC-19-575A: Redacting 60,000 name-like characters takes milliseconds

- Precondition: Server text made of 30,000 repeats of "a-".
- Action: Redact the text.
- Expected result: It finishes in under 400 ms.
- Test: `packages/agent-app/tests/sanitize-bughunt.test.ts::redacting a long run of name-like characters is not quadratic`
- Environment: Node test runner; no network.
- Known gaps: A time limit, so a very slow machine could trip it. On main it took about 3 s.
- Evidence: UNVERIFIED

<a id="mus-spec-19-575b"></a>
#### MUS-SPEC-19-575B: A URL password that contains an @ is fully redacted

- Precondition: Server text with clone URLs that carry user:password, one with a password that contains an @, and a plain URL with an @ in its query.
- Action: Redact the text.
- Expected result: The credentials become [redacted] and the host and path are kept. Nothing after the first @ of the password is left. The plain URL is unchanged.
- Test: `packages/agent-app/tests/sanitize-bughunt.test.ts::credentials in a URL are still redacted`
- Environment: Node test runner; no network.
- Known gaps: Unit test of the redactor. It does not read text from a live server.
- Evidence: UNVERIFIED

<a id="mus-spec-19-575c"></a>
#### MUS-SPEC-19-575C: Long runs of secret words are redacted in linear time

- Precondition: Four hostile inputs of 40,000 to 60,000 characters built from KEY, TOKEN. and KEY= repeats.
- Action: Redact each input.
- Expected result: Each one finishes in under 400 ms.
- Test: `packages/agent-app/tests/sanitize-bughunt.test.ts::a long run of secret words stays linear`
- Environment: Node test runner; no network.
- Known gaps: A time limit, so a very slow machine could trip it. On main the run took over 600 ms.
- Evidence: UNVERIFIED

<a id="mus-spec-19-577a"></a>
#### MUS-SPEC-19-577A: A clone URL that carries a token as the username is refused

- Precondition: Thirteen clone URLs whose username is a token: GitHub and GitLab token prefixes, token-style names, a 40-hex string, an encoded form and the ssh forms.
- Action: Validate each URL.
- Expected result: Each is refused with "Remove the token from the URL".
- Test: `packages/agent-app/tests/clone-url-token.test.ts::clone URLs whose username is a token are rejected`
- Environment: Node test runner; no network.
- Known gaps: Tests the validator. It does not run a clone. Two other tests in the file (ordinary usernames stay accepted; plugin sources and redaction) pass on main and are not linked.
- Evidence: UNVERIFIED

<a id="mus-spec-19-674a"></a>
#### MUS-SPEC-19-674A: A secret with a very long key name is redacted

- Precondition: Text with secret values under key names longer than 70 characters: dotted, hyphen-prefixed, JSON and .env styles.
- Action: Redact the text.
- Expected result: Each value becomes [redacted] and the key name is kept.
- Test: `packages/agent-app/tests/secret-redaction-long-names.test.ts::a secret whose key name is longer than 70 characters is redacted`
- Environment: Node test runner; no network.
- Known gaps: Unit test of the redactor. It does not export a chat or save a memory. The time-limit test in the same file passes on main, so it is not linked.
- Evidence: UNVERIFIED

### Workspace writes

<a id="mus-spec-19-710a"></a>
#### MUS-SPEC-19-710A: A workspace write raced at file creation leaves no empty file outside

- Precondition: A Workspace chat folder has a plain subfolder d beside a separate outside folder. The requested file does not exist.
- Action: Run write_file with new content while a racer swaps d for a link to the outside folder at the file open and restores it before cleanup.
- Expected result: A folder swapped for a link at the file open creates no file outside, even temporarily empty. A successful call writes the requested content inside the chat folder.
- Test: `packages/agent-app/tests/workspace-write-race-710.test.ts::a workspace write raced at file creation leaves no empty file outside`
- Environment: Node test runner; real temporary folders; filesystem/child-process hooks force the race at the mutation boundary; the native helper is built locally when present.
- Known gaps: Does not cover a process able to move a pinned directory outside the workspace or to add hard links after the handle check; that process already has access outside. No desktop UI is involved.
- Evidence: local; ~/.muster-work/review/710/green.txt; exit 0; 4 passed, 0 failed, 0 skipped; commit db2dcfbd0197ba0406bb3135b41764e4ff8a15e2

<a id="mus-spec-19-710b"></a>
#### MUS-SPEC-19-710B: A workspace write raced at parent creation leaves no folder outside

- Precondition: A Workspace chat folder has a plain subfolder d beside a separate outside folder. The requested file does not exist.
- Action: Run write_file with new content while a racer attempts to swap d for a link to the outside folder at parent creation and restores it before cleanup.
- Expected result: A folder swapped at parent creation creates no empty folder outside. A successful call writes the requested content inside the chat folder.
- Test: `packages/agent-app/tests/workspace-write-race-710.test.ts::a workspace write raced at parent creation leaves no folder outside`
- Environment: Node test runner; real temporary folders; filesystem/child-process hooks force the race at the mutation boundary; the native helper is built locally when present.
- Known gaps: Does not cover a process able to move a pinned directory outside the workspace or to add hard links after the handle check; that process already has access outside. Windows can block the parent rename itself while the helper holds its descendant directory; the same assertions still check the completed write and the outside folder. No desktop UI is involved.
- Evidence: local; ~/.muster-work/review/710/green.txt; exit 0; 4 passed, 0 failed, 0 skipped; commit db2dcfbd0197ba0406bb3135b41764e4ff8a15e2

<a id="mus-spec-19-710c"></a>
#### MUS-SPEC-19-710C: A workspace edit raced at file open leaves nothing outside and preserves outside files

- Precondition: A Workspace chat folder has a plain subfolder d beside a separate outside folder. The file d/x.txt contains before; outside/keep.txt contains keep.
- Action: Run edit_file replacing before with after while a racer swaps d for a link to the outside folder at the file open and restores it before cleanup.
- Expected result: An edit raced at its write open creates nothing outside and keeps an existing outside file unchanged. A successful call writes the requested content inside the chat folder; a refused edit keeps the original content.
- Test: `packages/agent-app/tests/workspace-write-race-710.test.ts::a workspace edit raced at file open leaves nothing outside and preserves outside files`
- Environment: Node test runner; real temporary folders; filesystem/child-process hooks force the race at the mutation boundary; the native helper is built locally when present.
- Known gaps: Does not cover a process able to move a pinned directory outside the workspace or to add hard links after the handle check; that process already has access outside. No desktop UI is involved.
- Evidence: local; ~/.muster-work/review/710/green.txt; exit 0; 4 passed, 0 failed, 0 skipped; commit db2dcfbd0197ba0406bb3135b41764e4ff8a15e2

### Process credentials, endpoint changes and release integrity

<a id="mus-spec-19-406a"></a>
#### MUS-SPEC-19-406A: A chat can use its MCP credentials without exposing them in Claude process arguments

- Precondition: A chat has an MCP server with a stored API key and a per-chat token.
- Action: Run a Claude chat through a real fixture child that reads its MCP configuration.
- Expected result: A chat uses MCP credentials through a private config file; process arguments never contain the credentials and the file is removed afterwards.
- Test: `packages/agent-app/tests/hardening-406.test.ts::a chat can use its MCP credentials without exposing them in Claude process arguments`
- Environment: Node test runner; real child process standing in for the provider CLI.
- Known gaps: Does not contact a live provider.
- Evidence: UNVERIFIED

<a id="mus-spec-19-406b"></a>
#### MUS-SPEC-19-406B: A coding-client chat receives unmarked MCP credentials through stdin instead of command arguments

- Precondition: A chat has MCP environment secrets and an authorization header without a secret prefix.
- Action: Send a chat through the provider adapter and inspect the launch handed to its core transport.
- Expected result: MCP credentials without a secret prefix reach the chat through thread config, never launch arguments.
- Test: `packages/agent-app/tests/hardening-406.test.ts::a coding-client chat receives unmarked MCP credentials through stdin instead of command arguments`
- Environment: Node test runner; provider adapter with a recording core transport.
- Known gaps: The core transport is a stand-in; existing argv tests cover its stdin wire format.
- Evidence: UNVERIFIED

<a id="mus-spec-19-406c"></a>
#### MUS-SPEC-19-406C: Editing a provider endpoint never sends its old stored key to the new origin

- Precondition: A custom provider has a stored encrypted API key.
- Action: Edit the endpoint path, then the host and port, checking the connection after each save.
- Expected result: Provider endpoint host and port edits clear the old stored key and environment binding before discovery; a path edit retains them.
- Test: `packages/agent-app/tests/hardening-406.test.ts::editing a provider endpoint never sends its old stored key to the new origin`
- Environment: Node test runner; real provider settings and secret store; recording HTTP transport.
- Known gaps: Does not open the settings UI.
- Evidence: UNVERIFIED

<a id="mus-spec-19-406d"></a>
#### MUS-SPEC-19-406D: Editing the memory endpoint never sends the old key to a different origin

- Precondition: Memory has an encrypted or session-only API key.
- Action: Save endpoint edits through the memory domain and test each connection; also supply a replacement key explicitly.
- Expected result: Memory endpoint host, port and scheme edits clear encrypted and session-only keys before a connection test; same-origin edits retain them.
- Test: `packages/agent-app/tests/memory-run.test.ts::editing the memory endpoint never sends the old key to a different origin`
- Environment: Node test runner; memory domain and real settings store; recording HTTP transport.
- Known gaps: Does not open the settings UI.
- Evidence: UNVERIFIED

<a id="mus-spec-19-406e"></a>
#### MUS-SPEC-19-406E: Every external workflow action is pinned to a full commit with its version recorded

- Precondition: The repository contains CI and release workflows.
- Action: Parse every workflow and inspect each action and reusable-workflow reference.
- Expected result: Every external action in every workflow uses a full commit SHA and records its version in a trailing comment.
- Test: `packages/agent-app/tests/hardening-406.test.ts::every external workflow action is pinned to a full commit with its version recorded`
- Environment: Node test runner; YAML parser.
- Known gaps: Does not execute GitHub Actions.
- Evidence: UNVERIFIED

<a id="mus-spec-19-406f"></a>
#### MUS-SPEC-19-406F: The macOS release refuses ad-hoc signing before it packages a build

- Precondition: The macOS build reports a signing mode.
- Action: Parse the release workflow and execute only its signing guard for each supported and refused mode.
- Expected result: The mandatory release guard refuses missing or ad-hoc signing and accepts the three supported identity modes before packaging.
- Test: `packages/agent-app/tests/hardening-406.test.ts::the macOS release refuses ad-hoc signing before it packages a build`
- Environment: Node test runner; local bash; no release run.
- Known gaps: Does not build or sign an installer.
- Evidence: UNVERIFIED

### Private secret and sudo requests

<a id="mus-spec-19-842a"></a>
#### MUS-SPEC-19-842A: An agent on a CLI route asks for a secret on a private card and gets a file reference

- Precondition: A chat runs on a CLI route (Codex, Claude Code, OpenCode, Grok) that loads the muster_ask MCP server.
- Action: The agent calls request_secret with a name and a reason through the real MCP server; the person types the value on the card.
- Expected result: The card shows the name, reason, who asks and a deadline, and counts as a request. The tool result holds a file path and how to pass it to a command, never the value. The file is 0600 and holds the value; it is removed when the run ends.
- Test: `packages/agent-app/tests/secret-requests-842.test.ts::an agent on a CLI route asks for a secret on a private card and gets a file reference, never the value`
- Environment: Node test runner; the agent service with a fake provider; the real muster_ask MCP server process.
- Known gaps: A command the agent runs that prints the file still shows the value to that CLI; Muster masks it only in what it saves.
- Evidence: UNVERIFIED

<a id="mus-spec-19-842b"></a>
#### MUS-SPEC-19-842B: On an HTTP route the secret goes into the environment of the next commands

- Precondition: An HTTP route with Full access offers request_secret beside run_command.
- Action: The agent calls request_secret, then runs a command that uses the variable and one that prints it.
- Expected result: The tool result has no value; the next command sees the value in its environment; output that prints it reaches the model as `••••(NAME)`; no timeline event holds it. Read-only does not offer the tool.
- Test: `packages/agent-app/tests/secret-requests-842.test.ts::on an HTTP route the secret is set in the environment of the next commands and masked in what the model reads`
- Environment: Node test runner; the HTTP tool executor with a stubbed service answer; a real shell.
- Known gaps: The service answer is stubbed here; case 842C covers the service side.
- Evidence: UNVERIFIED

<a id="mus-spec-19-842c"></a>
#### MUS-SPEC-19-842C: A requested secret never lands in the database, output logs, exports or the next prompt

- Precondition: A chat on a route that takes run environment.
- Action: The person answers a request; the agent prints the value in a command and repeats it in its reply; the person sends another message.
- Expected result: The saved thread shows `••••(NAME)` and never the value; Markdown, JSON and HTML exports hold no value; the next turn sent to the provider (prompt, instructions, overrides) holds no value; no file under the data folder (SQLite database, WAL, output logs) holds it.
- Test: `packages/agent-app/tests/secret-requests-842.test.ts::a requested secret never lands in the timeline database, output logs, exports or the next prompt`
- Environment: Node test runner; the agent service with a fake provider; a temp data folder.
- Known gaps: Values shorter than 4 characters are not masked.
- Evidence: UNVERIFIED

<a id="mus-spec-19-842d"></a>
#### MUS-SPEC-19-842D: Read-only chats cannot request a secret; Full access still asks the person

- Precondition: One chat with Read-only access and one with Full access.
- Action: The agent requests a secret in each.
- Expected result: Read-only: the tool answers with an error naming read-only, no card is posted, no sudo helper is set and the instructions do not mention request_secret. Full access: the card is posted and the tool waits until the person answers.
- Test: `packages/agent-app/tests/secret-requests-842.test.ts::a read-only chat cannot request a secret; Full access still shows the card and waits for the person`
- Environment: Node test runner; the agent service with a fake provider.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-19-842e"></a>
#### MUS-SPEC-19-842E: A declined or unanswered request tells the agent so

- Precondition: A chat with a short request deadline.
- Action: The person declines one request; another gets no answer.
- Expected result: The agent is told it was declined (no value, no environment) and the card is Dismissed; the unanswered one tells the agent there was no answer, the card is Expired and a late answer is refused.
- Test: `packages/agent-app/tests/secret-requests-842.test.ts::a declined or unanswered secret request tells the agent so and the card says what happened`
- Environment: Node test runner; the agent service with a fake provider; a 150 ms deadline.
- Known gaps: None.
- Evidence: UNVERIFIED

<a id="mus-spec-19-842f"></a>
#### MUS-SPEC-19-842F: One-time by default; Remember keeps it encrypted for the folder

- Precondition: A chat in a folder; a keychain stand-in.
- Action: Answer once without Remember, once with Remember; request again in a later run; then Forget.
- Expected result: Without Remember nothing is stored. With Remember one encrypted entry is stored and the file has no plain value. The later request is answered at once from it and the card says the saved value was used. Forget removes it.
- Test: `packages/agent-app/tests/secret-requests-842.test.ts::one-time is the default; "Remember for this folder" keeps it encrypted and answers the next request in that folder`
- Environment: Node test runner; the agent service with a fake provider; a SecretStore with a stand-in keychain.
- Known gaps: No Settings list of remembered values yet; Forget is on the card.
- Evidence: UNVERIFIED

<a id="mus-spec-19-842g"></a>
#### MUS-SPEC-19-842G: sudo -A asks through the card and times out cleanly

- Precondition: A chat with Workspace access on macOS or Linux; a short sudo deadline. No real sudo runs.
- Action: Run the SUDO_ASKPASS helper from the run environment the way `sudo -A` does; answer once; leave the next one unanswered.
- Expected result: The instructions tell agents to use `sudo -A`. The card shows the sudo prompt and offers keychain storage, off by default. The helper prints the password to stdout only and exits 0; unanswered, it prints nothing, exits non-zero and the card is Expired. No saved file or timeline row holds the password.
- Test: `packages/agent-app/tests/secret-requests-842.test.ts::sudo -A in an agent shell asks through the card, prints the password only to sudo, and times out cleanly`
- Environment: Node test runner; the agent service with a fake provider; the real askpass helper process.
- Known gaps: Does not run sudo. A `sudo` without -A in a terminal-less shell fails instead of asking.
- Evidence: UNVERIFIED

<a id="mus-spec-19-842h"></a>
#### MUS-SPEC-19-842H: A secret can be picked from 1Password by reference

- Precondition: A stand-in `op` CLI that answers one reference.
- Action: Answer with a missing reference, then with the right one.
- Expected result: The card offers 1Password. A failed lookup is an error naming 1Password and leaves the card open. The right one gives the agent the value; the card records the source and holds no value.
- Test: `packages/agent-app/tests/secret-requests-842.test.ts::a secret can be picked from 1Password by reference; the value goes from op to the agent only`
- Environment: Node test runner; the agent service with a fake provider; a shell script standing in for op.
- Known gaps: Does not contact the real 1Password app. No item browser: the person pastes an op:// reference.
- Evidence: UNVERIFIED

<a id="mus-spec-19-842i"></a>
#### MUS-SPEC-19-842I: request_secret sits beside ask_user and the run waits for a person

- Precondition: A chat on a CLI route.
- Action: Start a run and read the muster_ask server it is given.
- Expected result: The server lists request_secret and ask_user, not the sudo channel, and the provider tool timeout is at least 300 seconds.
- Test: `packages/agent-app/tests/secret-requests-842.test.ts::the secret request tool sits beside ask_user in the muster_ask server and the run waits long enough for a person`
- Environment: Node test runner; the agent service with a fake provider.
- Known gaps: Does not start a real provider CLI.
- Evidence: UNVERIFIED

<a id="mus-spec-19-842j"></a>
#### MUS-SPEC-19-842J: The secret card takes a masked value and sends it once

- Precondition: The card for a pending request in a folder chat.
- Action: Type a value and press Send privately; press Decline.
- Expected result: The field is a password field with autocomplete off; Remember is unchecked; Send is disabled until a value is typed; one secret.answer call carries the value with remember false; the field is cleared; Decline sends secret.decline.
- Test: `packages/agent-app/tests/secret-request-card-842-dom.tsx::the secret card takes a masked value, sends it once and clears the field`
- Environment: DOM suite (linkedom) with the real PendingQuestion component; stubbed bridge.
- Known gaps: Does not open the Electron window.
- Evidence: UNVERIFIED

<a id="mus-spec-19-842k"></a>
#### MUS-SPEC-19-842K: sudo, 1Password and settled secret cards read plainly

- Precondition: Cards for a sudo request, a 1Password pick and settled states.
- Action: Render each; pick 1Password and send a reference; press Forget on a saved-value card.
- Expected result: The sudo card offers keychain storage; the 1Password reference is sent instead of a value; an answered card says Sent privately with no field; a saved-value card offers Forget; an expired card says No answer in time.
- Test: `packages/agent-app/tests/secret-request-card-842-dom.tsx::a sudo card, a 1Password pick and a settled card read plainly and never show a value`
- Environment: DOM suite (linkedom) with the real PendingQuestion component; stubbed bridge.
- Known gaps: Does not open the Electron window.
- Evidence: UNVERIFIED

### SSH workspaces (#147)

<a id="mus-spec-19-147a"></a>
#### MUS-SPEC-19-147A: Remote file paths stay inside the folder and are never run by the shell

- Precondition: A remote folder with a link to a file outside it and a link to a folder outside it.
- Action: Read `../outside.txt`, `/etc/passwd`, a name with a newline and the outward links; write through the outward links; create and save files whose names hold shell syntax.
- Expected result: Every outside read and write is refused with a sentence and the outside files are unchanged; the shell-syntax names exist with their literal names and no marker file was created anywhere.
- Test: `packages/agent-app/tests/ssh-workspaces-147.test.ts::remote file paths stay inside the folder and are never run by the shell`
- Environment: Node test runner with the real agent service, a temp data folder and a temp HOME; a stand-in `ssh` and `ssh-keyscan` on PATH (`tests/fixtures/fake-ssh/`) that run the remote commands under /bin/sh on this machine. No network, no real host.
- Known gaps: The check is done by the host’s /bin/sh (`cd -P`/`pwd -P`); a link swapped in between the check and the write is not covered.
- Evidence: UNVERIFIED
