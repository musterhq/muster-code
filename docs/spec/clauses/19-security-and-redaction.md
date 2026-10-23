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
| [MUS-SPEC-19-575A](19-security-and-redaction.md#mus-spec-19-575a) | Redacting 60,000 name-like characters takes under 400 ms. | [`redacting a long run of name-like characters is not quadratic`](../../../packages/agent-app/tests/sanitize-bughunt.test.ts) |
| [MUS-SPEC-19-575B](19-security-and-redaction.md#mus-spec-19-575b) | URL credentials, including a password with an @, are masked; plain URLs are not. | [`credentials in a URL are still redacted`](../../../packages/agent-app/tests/sanitize-bughunt.test.ts) |
| [MUS-SPEC-19-575C](19-security-and-redaction.md#mus-spec-19-575c) | Four long inputs of repeated secret words each redact in under 400 ms. | [`a long run of secret words stays linear`](../../../packages/agent-app/tests/sanitize-bughunt.test.ts) |

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
