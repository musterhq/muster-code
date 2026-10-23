# MUS-SPEC-15: Settings and themes

Settings is where the user sets defaults for the app. Themes set its look.

What the user can do:
- set defaults for models, access, chats, memory, sandbox resources, notifications and updates;
- pick a light, dark or system theme, and an accent;
- move through Settings sections with Back and Forward like other screens.

Boundaries:
- A setting takes effect without a restart, unless the screen says otherwise.
- Unknown or invalid settings values are rejected, not saved.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-15-572A](15-settings-and-themes.md#mus-spec-15-572a) | A theme with extra fields or padded token values is refused. | [`a custom theme list with extra fields or untrimmed token values is rejected, not stored as given`](../../../packages/agent-app/tests/protocol-bughunt.test.ts) |

<a id="mus-spec-15-572a"></a>
#### MUS-SPEC-15-572A: A custom theme list with extra fields is rejected

- Precondition: A valid custom theme with an id, a name, a base and one colour token.
- Action: Validate the setting with an extra field on the theme, an extra token, or a token value padded with spaces.
- Expected result: The valid theme is accepted as given. Each bad form is refused with an error that names customThemes.
- Test: `packages/agent-app/tests/protocol-bughunt.test.ts::a custom theme list with extra fields or untrimmed token values is rejected, not stored as given`
- Environment: Node test runner; no network.
- Known gaps: Tests the settings validator. It does not save through the Settings screen.
- Evidence: UNVERIFIED
