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
