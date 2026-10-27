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
| [MUS-SPEC-15-398C](15-settings-and-themes.md#mus-spec-15-398c) | The sidebar collapses at 900 and returns when widened. | [`at 900 pixels the sidebar steps aside and returns when widened`](../../../packages/agent-app/tests/responsive-nav.test.ts) |
| [MUS-SPEC-15-398B](15-settings-and-themes.md#mus-spec-15-398b) | Both surfaces add the parent folder's name (the parent path when those also match) so the folders and chats can be told apart. | [`duplicate folder names and search results show their parent folders`](../../../packages/agent-app/tests/ui-sweep-dom.tsx) |
| [MUS-SPEC-15-398A](15-settings-and-themes.md#mus-spec-15-398a) | Only the destination has an active highlight. | [`only the visible destination is highlighted after leaving a draft`](../../../packages/agent-app/tests/ui-sweep-dom.tsx) |
| [MUS-SPEC-15-622A](15-settings-and-themes.md#mus-spec-15-622a) | All 27 built-in themes are loaded; every colour token of each parses, and each meets the contrast minimums on its text and background pairs, with the new ones at 4.5:1 on every pair. | [`contrast: every theme meets WCAG AA on its text/background pairs (the six new ones on every pair at 4.5:1)`](../../../packages/agent-app/tests/theme.test.ts) |
| [MUS-SPEC-15-572A](15-settings-and-themes.md#mus-spec-15-572a) | A theme with extra fields or padded token values is refused. | [`a custom theme list with extra fields or untrimmed token values is rejected, not stored as given`](../../../packages/agent-app/tests/protocol-bughunt.test.ts) |

### Built-in themes

<a id="mus-spec-15-622a"></a>
#### MUS-SPEC-15-622A: Every built-in theme loads and keeps text readable

- Precondition: The app has its built-in theme list: the Muster Light and Dark pair, six classic themes and 19 more themes.
- Action: For each built-in theme, work out its full set of colours (the theme's own values on top of its base) and check each colour value and each text-on-background pair.
- Expected result: There are 27 built-in themes. Every colour token of every theme is a readable colour value. Every theme meets the contrast minimums on its text and background pairs, and every theme other than the Muster pair reaches 4.5:1 on every pair.
- Test: `packages/agent-app/tests/theme.test.ts::contrast: every theme meets WCAG AA on its text/background pairs (the six new ones on every pair at 4.5:1)`
- Environment: Node test runner; no window, network or provider.
- Known gaps: Checks the colour numbers, not how a theme looks on screen. It does not show that the theme picker lists each theme; the Settings screen test (`tests/settings-shell.tsx`) lists the names but is not linked here.
- Evidence: UNVERIFIED

<a id="mus-spec-15-572a"></a>
#### MUS-SPEC-15-572A: A custom theme list with extra fields is rejected

- Precondition: A valid custom theme with an id, a name, a base and one colour token.
- Action: Validate the setting with an extra field on the theme, an extra token, or a token value padded with spaces.
- Expected result: The valid theme is accepted as given. Each bad form is refused with an error that names customThemes.
- Test: `packages/agent-app/tests/protocol-bughunt.test.ts::a custom theme list with extra fields or untrimmed token values is rejected, not stored as given`
- Environment: Node test runner; no network.
- Known gaps: Tests the settings validator. It does not save through the Settings screen.
- Evidence: UNVERIFIED

<a id="mus-spec-15-398a"></a>
#### MUS-SPEC-15-398A: Only the visible destination is highlighted after leaving a draft

- Precondition: A new-chat draft is open.
- Action: Navigate to Inbox, then Memory.
- Expected result: Only the destination has an active highlight.
- Test: `packages/agent-app/tests/ui-sweep-dom.tsx::only the visible destination is highlighted after leaving a draft`
- Environment: Node and linkedom with the real renderer and a fixture bridge; responsive navigation uses a window media-query fixture. No desktop app or network.
- Known gaps: Does not exercise a live provider or imported history database. Visual layout is checked separately in a browser harness.
- Evidence: UNVERIFIED

<a id="mus-spec-15-398b"></a>
#### MUS-SPEC-15-398B: Duplicate folder names and search results show their parent folders

- Precondition: Two folders have the same basename and each holds a chat with the same title.
- Action: Read the sidebar and open chat search.
- Expected result: Both surfaces add the parent folder's name (the parent path when those also match) so the folders and chats can be told apart.
- Test: `packages/agent-app/tests/ui-sweep-dom.tsx::duplicate folder names and search results show their parent folders`
- Environment: Node and linkedom with the real renderer and a fixture bridge; responsive navigation uses a window media-query fixture. No desktop app or network.
- Known gaps: Does not exercise a live provider or imported history database. Visual layout is checked separately in a browser harness.
- Evidence: UNVERIFIED

<a id="mus-spec-15-398c"></a>
#### MUS-SPEC-15-398C: At 900 pixels the sidebar steps aside and returns when widened

- Precondition: The sidebar is visible in a wide window.
- Action: Open at 900 pixels, then widen to 1200.
- Expected result: The sidebar collapses at 900 and returns when widened.
- Test: `packages/agent-app/tests/responsive-nav.test.ts::at 900 pixels the sidebar steps aside and returns when widened`
- Environment: Node and linkedom with the real renderer and a fixture bridge; responsive navigation uses a window media-query fixture. No desktop app or network.
- Known gaps: Does not exercise a live provider or imported history database. Visual layout is checked separately in a browser harness.
- Evidence: UNVERIFIED
