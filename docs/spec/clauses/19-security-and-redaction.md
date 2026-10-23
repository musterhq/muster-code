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
| [MUS-SPEC-19-571A](19-security-and-redaction.md#mus-spec-19-571a) | A password with an @ is fully masked in git error text. | [`credential redaction masks a password that contains an @`](../../../packages/agent-app/tests/review-bughunt.test.ts) |

<a id="mus-spec-19-571a"></a>
#### MUS-SPEC-19-571A: A git error message hides a password that contains an @

- Precondition: A git error line that holds a URL with user:p@ssw0rd as its credentials.
- Action: Run the line through the git text redaction.
- Expected result: No part of the password is left, the host and path are kept, and a plain URL with an @ in its query is unchanged.
- Test: `packages/agent-app/tests/review-bughunt.test.ts::credential redaction masks a password that contains an @`
- Environment: Node test runner; no network.
- Known gaps: Unit test of redactGitText. It does not run a real failing git command.
- Evidence: UNVERIFIED
