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
| [MUS-SPEC-15-147A](15-settings-and-themes.md#mus-spec-15-147a) | Lists the plain `Host` aliases of ~/.ssh/config (not wildcard patterns) with their HostName, User and Port, marks the one added, and refuses a host, user or alias that starts with `-` or holds other characters; the hosts file is 0600 and holds no key. | [`lists ~/.ssh/config hosts, adds one, and refuses a host that could be read as an ssh option`](../../../packages/agent-app/tests/ssh-workspaces-147.test.ts) |
| [MUS-SPEC-15-147B](15-settings-and-themes.md#mus-spec-15-147b) | The first connect stops at `hostkey-unknown` with the SHA256 fingerprint and writes no known_hosts line; a wrong fingerprint is refused; the right one is written to Muster’s own known_hosts (the user’s file is untouched) and the connection then works; a changed key is reported as changed and cannot be trusted with one click. | [`first connect shows the host key fingerprint and trusts it only after confirmation`](../../../packages/agent-app/tests/ssh-workspaces-147.test.ts) |
| [MUS-SPEC-15-147C](15-settings-and-themes.md#mus-spec-15-147c) | When the host refuses every key, the state is `auth` and the message tells the user to run `ssh-add`; every ssh Muster starts runs with BatchMode=yes and StrictHostKeyChecking=yes. | [`a host that wants a passphrase or password asks for ssh-add and never prompts`](../../../packages/agent-app/tests/ssh-workspaces-147.test.ts) |
| [MUS-SPEC-15-147D](15-settings-and-themes.md#mus-spec-15-147d) | Settings › Environments lists the config hosts with an Add button, shows a host waiting for its key with the fingerprint and a Trust button, sends the shown fingerprint, and offers a folder path field for a connected host. | [`the SSH workspaces panel adds a config host and shows the fingerprint before trusting`](../../../packages/agent-app/tests/ssh-workspaces-147-dom.tsx) |
| [MUS-SPEC-15-147E](15-settings-and-themes.md#mus-spec-15-147e) | Trust asks ssh again before writing anything: a changed key is refused after a disconnect and after a restart, Muster’s known_hosts keeps the old key and nothing connects; a host behind a jump host is refused instead of scanned directly. | [`a changed host key is refused after a disconnect or a restart, and a jump host is never scanned directly`](../../../packages/agent-app/tests/ssh-workspaces-147.test.ts) |

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

### SSH workspace hosts (#147)

<a id="mus-spec-15-147a"></a>
#### MUS-SPEC-15-147A: Hosts come from ~/.ssh/config or are added by hand, and a host can never be read as an ssh option

- Precondition: A temp HOME whose ~/.ssh/config has `devbox` (HostName, User, Port), a `*.corp` pattern and a two-alias `Host gpu-1 gpu-2` line.
- Action: List the config hosts, add `devbox`, add a hand-typed `build.example.com` host, then try `-oProxyCommand=…` as a host, `-x` as a user and an alias that is not in the config.
- Expected result: The list has devbox, gpu-1 and gpu-2 (no pattern), devbox with its HostName, User and Port; after adding, devbox reads as added. The option-like host, the option-like user and the unknown alias are refused with a sentence. The hosts file is mode 0600 and holds no private key.
- Test: `packages/agent-app/tests/ssh-workspaces-147.test.ts::lists ~/.ssh/config hosts, adds one, and refuses a host that could be read as an ssh option`
- Environment: Node test runner with the real agent service, a temp data folder and a temp HOME; a stand-in `ssh` and `ssh-keyscan` on PATH (`tests/fixtures/fake-ssh/`) that run the remote commands under /bin/sh on this machine. No network, no real host.
- Known gaps: `Include` files and `Match` blocks of ~/.ssh/config are not read for the list (ssh itself still applies them when it connects).
- Evidence: UNVERIFIED

<a id="mus-spec-15-147b"></a>
#### MUS-SPEC-15-147B: A host key is trusted only after the user saw its fingerprint

- Precondition: A saved config host whose key is in no known_hosts file.
- Action: Connect; try to add a folder; trust with a wrong fingerprint; trust with the shown one; connect again; then the host offers another key.
- Expected result: Connect returns `hostkey-unknown` with the key type and fingerprint; adding a folder is refused; the wrong fingerprint is refused; after trusting the shown one the state is `connected` and Muster’s known_hosts holds the key while the user’s known_hosts is unchanged. With a new key the state is `hostkey-changed` and trusting the new fingerprint is refused.
- Test: `packages/agent-app/tests/ssh-workspaces-147.test.ts::first connect shows the host key fingerprint and trusts it only after confirmation`
- Environment: Node test runner with the real agent service, a temp data folder and a temp HOME; a stand-in `ssh` and `ssh-keyscan` on PATH (`tests/fixtures/fake-ssh/`) that run the remote commands under /bin/sh on this machine. No network, no real host.
- Known gaps: A host reached through ProxyJump cannot be scanned; the user is told to connect once in a terminal. That message is not driven here.
- Evidence: UNVERIFIED

<a id="mus-spec-15-147c"></a>
#### MUS-SPEC-15-147C: A host that wants a passphrase or password asks for ssh-add and Muster never prompts

- Precondition: A trusted host that refuses every key the agent offers.
- Action: Connect.
- Expected result: The state is `auth` and its detail names `ssh-add`; each logged ssh call carries `BatchMode=yes` and `StrictHostKeyChecking=yes`.
- Test: `packages/agent-app/tests/ssh-workspaces-147.test.ts::a host that wants a passphrase or password asks for ssh-add and never prompts`
- Environment: Node test runner with the real agent service, a temp data folder and a temp HOME; a stand-in `ssh` and `ssh-keyscan` on PATH (`tests/fixtures/fake-ssh/`) that run the remote commands under /bin/sh on this machine. No network, no real host.
- Known gaps: A real ssh agent and an encrypted key are not used; the stand-in reports the refusal the way OpenSSH words it.
- Evidence: UNVERIFIED

<a id="mus-spec-15-147d"></a>
#### MUS-SPEC-15-147D: The SSH workspaces panel adds a config host and shows the fingerprint before trusting

- Precondition: Settings › Environments with a stubbed bridge: one config entry not yet added, then a host whose connect returns `hostkey-unknown`.
- Action: Add the config host, press Connect, press Trust, type a folder path and press Open.
- Expected result: `remote.hosts.save` gets `{source:"config", host:"devbox"}`; the fingerprint is on screen before trusting; `remote.hosts.trust` gets exactly that fingerprint; `remote.folder.add` gets the host id and typed path.
- Test: `packages/agent-app/tests/ssh-workspaces-147-dom.tsx::the SSH workspaces panel adds a config host and shows the fingerprint before trusting`
- Environment: linkedom DOM suite in `scripts/test-renderer.mjs` with the real Settings panel and a stubbed bridge. No Electron, no ssh.
- Known gaps: Stubbed bridge: the runtime side is covered by the other #147 cases. Layout is not checked.
- Evidence: UNVERIFIED

<a id="mus-spec-15-147e"></a>
#### MUS-SPEC-15-147E: A changed host key is never trusted from a stale state

- Precondition: A config host whose key the user trusted in Muster; the host then offers another key.
- Action: Disconnect, then trust the new fingerprint; start Muster again on the same data folder and trust the new fingerprint again; separately, trust a host reached through a jump host.
- Expected result: Both trusts are refused as a changed key, Muster’s known_hosts still holds only the old key, the saved trusted fingerprint is the old one, and no command ran on the host with the new key. The jump-host trust is refused with the "connect once in a terminal" sentence and ssh-keyscan is never run for it.
- Test: `packages/agent-app/tests/ssh-workspaces-147.test.ts::a changed host key is refused after a disconnect or a restart, and a jump host is never scanned directly`
- Environment: Node test runner with the real agent service, a temp data folder and a temp HOME; a stand-in `ssh` and `ssh-keyscan` on PATH (`tests/fixtures/fake-ssh/`). The service is disposed and created again on the same data folder. No network, no real host.
- Known gaps: Real OpenSSH accepts a host when any known_hosts file holds a matching key; the stand-in models that rule, it is not checked against a real sshd here.
- Evidence: UNVERIFIED
