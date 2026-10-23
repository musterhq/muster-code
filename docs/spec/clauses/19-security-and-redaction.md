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
| [MUS-SPEC-19-577A](19-security-and-redaction.md#mus-spec-19-577a) | Clone URLs with a token as the username are refused. | [`clone URLs whose username is a token are rejected`](../../../packages/agent-app/tests/clone-url-token.test.ts) |

<a id="mus-spec-19-577a"></a>
#### MUS-SPEC-19-577A: A clone URL that carries a token as the username is refused

- Precondition: Thirteen clone URLs whose username is a token: GitHub and GitLab token prefixes, token-style names, a 40-hex string, an encoded form and the ssh forms.
- Action: Validate each URL.
- Expected result: Each is refused with "Remove the token from the URL".
- Test: `packages/agent-app/tests/clone-url-token.test.ts::clone URLs whose username is a token are rejected`
- Environment: Node test runner; no network.
- Known gaps: Tests the validator. It does not run a clone. Two other tests in the file (ordinary usernames stay accepted; plugin sources and redaction) pass on main and are not linked.
- Evidence: UNVERIFIED
