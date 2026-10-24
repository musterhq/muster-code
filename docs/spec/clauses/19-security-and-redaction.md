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
| [MUS-SPEC-19-564A](19-security-and-redaction.md#mus-spec-19-564a) | On Windows, `file://host/share`, `\\host\share` and `//host/share` references are refused with "Choose a file". | [`Windows network (UNC) paths are not opened from transcript references`](../../../packages/agent-app/tests/open-with.test.ts) |
| [MUS-SPEC-19-571A](19-security-and-redaction.md#mus-spec-19-571a) | A password with an @ is fully masked in git error text. | [`credential redaction masks a password that contains an @`](../../../packages/agent-app/tests/review-bughunt.test.ts) |
| [MUS-SPEC-19-575A](19-security-and-redaction.md#mus-spec-19-575a) | Redacting 60,000 name-like characters takes under 400 ms. | [`redacting a long run of name-like characters is not quadratic`](../../../packages/agent-app/tests/sanitize-bughunt.test.ts) |
| [MUS-SPEC-19-575B](19-security-and-redaction.md#mus-spec-19-575b) | URL credentials, including a password with an @, are masked; plain URLs are not. | [`credentials in a URL are still redacted`](../../../packages/agent-app/tests/sanitize-bughunt.test.ts) |
| [MUS-SPEC-19-575C](19-security-and-redaction.md#mus-spec-19-575c) | Four long inputs of repeated secret words each redact in under 400 ms. | [`a long run of secret words stays linear`](../../../packages/agent-app/tests/sanitize-bughunt.test.ts) |
| [MUS-SPEC-19-577A](19-security-and-redaction.md#mus-spec-19-577a) | Clone URLs with a token as the username are refused. | [`clone URLs whose username is a token are rejected`](../../../packages/agent-app/tests/clone-url-token.test.ts) |

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
