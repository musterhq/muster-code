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

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-19-154A](19-security-and-redaction.md#mus-spec-19-154a) | A secret saved in the secret store, printed by the agent in a command's output and in its reply, is not in the saved thread; the thread shows the mask with the secret's name. | [`a stored secret an agent prints is masked with its name in the saved thread`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154B](19-security-and-redaction.md#mus-spec-19-154b) | A secret in an environment variable, printed by the agent, is not in the saved thread; the thread shows the mask with the variable name. | [`an environment secret an agent prints is masked with its variable name in the saved thread`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154C](19-security-and-redaction.md#mus-spec-19-154c) | A Markdown, JSON and HTML export hold the mask and not the value, for a secret saved after it appeared in the chat. | [`exports mask a secret that was saved after it appeared in the chat`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154D](19-security-and-redaction.md#mus-spec-19-154d) | An export masks a stored secret that this run of the app has not read yet. | [`exports mask a stored secret that was not read in this session`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154E](19-security-and-redaction.md#mus-spec-19-154e) | The chat title made from a first message holding a stored secret does not hold the value. | [`a chat title made from a message holding a stored secret does not contain the value`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-154F](19-security-and-redaction.md#mus-spec-19-154f) | A stored secret streamed in a reply that is still running is masked in the saved thread. | [`a stored secret streamed in a reply that is still running is masked in the saved thread`](../../../packages/agent-app/tests/secret-registry-154.test.ts) |
| [MUS-SPEC-19-564A](19-security-and-redaction.md#mus-spec-19-564a) | On Windows, `file://host/share`, `\\host\share` and `//host/share` references are refused with "Choose a file". | [`Windows network (UNC) paths are not opened from transcript references`](../../../packages/agent-app/tests/open-with.test.ts) |
| [MUS-SPEC-19-571A](19-security-and-redaction.md#mus-spec-19-571a) | A password with an @ is fully masked in git error text. | [`credential redaction masks a password that contains an @`](../../../packages/agent-app/tests/review-bughunt.test.ts) |
| [MUS-SPEC-19-575A](19-security-and-redaction.md#mus-spec-19-575a) | Redacting 60,000 name-like characters takes under 400 ms. | [`redacting a long run of name-like characters is not quadratic`](../../../packages/agent-app/tests/sanitize-bughunt.test.ts) |
| [MUS-SPEC-19-575B](19-security-and-redaction.md#mus-spec-19-575b) | URL credentials, including a password with an @, are masked; plain URLs are not. | [`credentials in a URL are still redacted`](../../../packages/agent-app/tests/sanitize-bughunt.test.ts) |
| [MUS-SPEC-19-575C](19-security-and-redaction.md#mus-spec-19-575c) | Four long inputs of repeated secret words each redact in under 400 ms. | [`a long run of secret words stays linear`](../../../packages/agent-app/tests/sanitize-bughunt.test.ts) |
| [MUS-SPEC-19-577A](19-security-and-redaction.md#mus-spec-19-577a) | Clone URLs with a token as the username are refused. | [`clone URLs whose username is a token are rejected`](../../../packages/agent-app/tests/clone-url-token.test.ts) |
| [MUS-SPEC-19-674A](19-security-and-redaction.md#mus-spec-19-674a) | Values under key names longer than 70 characters are redacted. | [`a secret whose key name is longer than 70 characters is redacted`](../../../packages/agent-app/tests/secret-redaction-long-names.test.ts) |

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

<a id="mus-spec-19-154f"></a>
#### MUS-SPEC-19-154F: A stored secret streamed in a reply is masked while the reply is still running

- Precondition: A key is saved in the secret store.
- Action: A reply streams the key, split across several pieces of text, and the turn is still running when the chat is read.
- Expected result: The saved thread shows the mask with the key's name, both while the reply streams and after it finishes; the key itself is never in it.
- Test: `packages/agent-app/tests/secret-registry-154.test.ts::a stored secret streamed in a reply that is still running is masked in the saved thread`
- Environment: Node test runner; the agent service with a fake provider that streams text and holds the turn open; a temp data folder; a stand-in for the system keychain.
- Known gaps: Covers the reply text; tool output that streams uses the same write path but is not asserted separately.
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
