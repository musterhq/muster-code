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
| [MUS-SPEC-19-674A](19-security-and-redaction.md#mus-spec-19-674a) | Values under key names longer than 70 characters are redacted. | [`a secret whose key name is longer than 70 characters is redacted`](../../../packages/agent-app/tests/secret-redaction-long-names.test.ts) |

<a id="mus-spec-19-674a"></a>
#### MUS-SPEC-19-674A: A secret with a very long key name is redacted

- Precondition: Text with secret values under key names longer than 70 characters: dotted, hyphen-prefixed, JSON and .env styles.
- Action: Redact the text.
- Expected result: Each value becomes [redacted] and the key name is kept.
- Test: `packages/agent-app/tests/secret-redaction-long-names.test.ts::a secret whose key name is longer than 70 characters is redacted`
- Environment: Node test runner; no network.
- Known gaps: Unit test of the redactor. It does not export a chat or save a memory. The time-limit test in the same file passes on main, so it is not linked.
- Evidence: UNVERIFIED
