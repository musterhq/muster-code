# Muster mobile app: design

Status: phases 1 and 2 built (issue #326); later phases planned below. This document is the plan of record for the phone app: how a phone reaches the
person's desktop Muster from anywhere, how the traffic is protected, which stack the app uses, the screens, the phases and the
threat model. The acceptance cases live in [docs/spec/clauses/23-mobile.md](../spec/clauses/23-mobile.md).

Related issues: #326 (this app and its checklist), #155 (two-way gateway channels; the needs-you feed shares its idea of
"answer in place"), #147 (remote connections; a paired phone is one more kind of connection), #803/#808 (several Muster Servers
in one list), #840 (dictation).

## 1. Goals and non-goals

Goals:

- See and steer the agents running on *your own* desktop Muster from a phone, at home or away, without opening ports on the
  router and without trusting whoever carries the bytes.
- Answer approvals and questions in place, the moment an agent needs you.
- The phone never gets more power than the desktop: it is read-only until the person says otherwise on the desktop, it can be
  revoked from the desktop in one click, and it never raises a chat's access level.
- Reuse the desktop's protocol types and TypeScript, so a runtime change does not need a second implementation.

Non-goals for now:

- Running agents *on* the phone. The phone is a remote control; work runs on the desktop (or on a Muster Server).
- A second account system. The phone pairs with one desktop by QR; Muster Server accounts are a later, separate path.
- Hosting a production relay. Phase 1 ships the relay *protocol*, the desktop client and a dev relay for tests. Where the
  production relay runs (Muster-hosted, self-hosted next to Muster Server, or both) is a later decision, recorded in §9.

## 2. Connection model

### 2.1 Options considered

| Option | How the phone reaches the desktop | Works away from home | Who can read traffic | Verdict |
|---|---|---|---|---|
| A. Muster Server as the hub | Desktop and phone both sign in to a Muster Server; the server runs (or proxies to) the runtime | Yes, if the server is public | The server operator, unless we add E2E on top | Right for teams already running a server, wrong as the only path: most people don't run one, and the desktop's own chats are not on the server |
| B. Desktop-embedded endpoint through a relay | The desktop keeps one outbound WebSocket to a relay; the phone connects to the same relay; the relay forwards opaque frames | Yes, no port forwarding, works behind NAT and CGNAT | Nobody but the two ends, with E2E encryption | **Chosen as the default path** |
| C. Direct LAN, relay fallback | Phone dials the desktop's LAN address when on the same network, else the relay | Yes (via fallback) | Nobody (same E2E) | **Chosen as an optimisation on top of B** (phase 2): lower latency and no relay hop at home |

### 2.2 The chosen model

```
 phone (Expo app)                     relay (dumb pipe)                     desktop runtime (mobile domain)
 ───────────────                     ─────────────────                     ──────────────────────────────
 WebSocket  ── /v1/phone/<route> ──▶  route table: <route> → desktop link  ◀── /v1/desktop (one outbound WS,
   Noise IK handshake + frames  ◀──▶  forwards base64 ciphertext only        authenticated by a route secret)
                                       never sees keys, never sees JSON        Noise responder, device registry,
                                                                               command allowlist, event fan-out
```

- **The desktop dials out.** When phone access is on, the runtime opens one WebSocket to the relay and registers a *route*.
  The route id is `sha256(routeSecret)` (first 16 bytes, hex); only the desktop knows the secret, so only it can register that
  route, and the relay keeps no account or database (it re-derives the id on every registration).
- **The phone dials the route.** It opens `/v1/phone/<route>`; the relay tells the desktop `open(c)` and then forwards
  `data(c, base64)` both ways. The relay closes the phone's socket with 4404 when the desktop is offline.
- **Everything inside is end-to-end encrypted** (§3). The relay sees the route id, connection timing and sizes, and nothing
  else.
- **Same protocol over every transport.** LAN (phase 2) and a relay mounted inside Muster Server (phase 3) carry the exact same
  Noise frames, so the session code does not change by transport.
- **Muster Server is still a path.** A phone signed in to a Muster Server through the existing web UI keeps working. When a
  server is in the desktop's list (#808), it can also *host the relay* (`/relay/v1/...`), which is how a team avoids a third
  party (phase 3).
- **On the same network, no relay hop** (phase 2, §2.3).
- **Not on a shared server yet.** On Muster Server the `mobile.*` commands are desktop-only for every role (MUS-SPEC-23-3C):
  a phone paired with the shared runtime would bypass per-person project access. Per-person pairing on a server is phase 3.
- **The desktop is the source of truth.** The phone holds no chat database: it caches the last chat list and the open chat
  for display while offline, and the desktop's runtime decides every command.

### 2.3 Direct on the same network, with relay fallback (phase 2)

```
 phone ── ws://192.168.1.20:<port>/v1/phone/<route> ──▶ desktop LAN listener ─┐
   │        (same base64 Noise messages as the relay)                         ├─▶ the same session code: handshake,
   └──────── wss://relay/v1/phone/<route> ─────────────▶ relay ─▶ relay link ──┘    registry, access checks, allowlist
```

- **The desktop listens** on its private-network addresses while phone access is on, on one port it keeps across restarts
  (so a phone's saved addresses still work), and follows the computer's addresses every 30 seconds as networks change.
  Settings › Integrations › Phone shows the addresses and turns this off (`mobile.lan.set`).
- **The phone learns the addresses** from the pairing link (`l=host:port,…`, at most four) and from every `hello`, which
  carries the desktop's current list, so the saved record follows DHCP and network changes.
- **The phone tries the LAN first.** Reconnecting, it races a whole session (socket, Noise handshake, hello) on each LAN
  address for up to 3 seconds and uses the first that finishes; otherwise the relay. Pairing races only the socket (1.5 s):
  once message 1 is sent the one-time code may be taken, so a pairing never retries on the relay after that.
- **Any LAN failure means "use the relay"**, a 4403 "revoked" close included: something else may be answering at that
  address, and only a desktop that proved its static key in the handshake may say anything about this phone. The relay
  path's own rules (4403 shows revoked, MUS-SPEC-23-9B) are unchanged.

**Binding, and why the listener does not weaken §8.** The listener carries exactly the relay's payloads into the same session
code, so the handshake, the registry, the per-command access checks and the allowlist are not duplicated anywhere. What it
adds is a socket on the local network, and that socket is narrowed as far as it goes:

| Choice | Why |
|---|---|
| One listener per **literal private-network address** of a real interface: RFC 1918 IPv4, then unique-local IPv6, at most four | Never `0.0.0.0`/`::` (that would include public and VPN interfaces), never a public address, never loopback, link-local (a phone can't use our zone id), carrier-grade NAT (VPN overlays such as Tailscale) or container and VM bridges (`docker0`, `br-*`, `vmnet*`, `bridge*`…) |
| Off while phone access is off, and switchable | Nothing listens on a computer that never paired a phone, or whose owner turned it off |
| Only `GET /v1/phone/<this desktop's route>` upgrades; everything else is 404 | No other endpoint, no desktop registration, no HTTP content |
| `Host` must be the literal address it was reached on; an `Origin`, if sent, must be that same address | A DNS-rebinding page sends a name; a web page on another site sends its own origin. React Native sends the target as its origin |
| Messages over one Noise message (87,384 base64 characters) close the socket (1009); missed pongs drop it, and so does a phone that stops reading while 8 MB waits for it; 64 sockets at most | The relay's own limits; the session code still caps unauthenticated connections (32) and times out stalled handshakes (10 s) for both paths |
| Plain `ws://` | Everything inside is Noise ciphertext, the same reason a `ws://` relay is allowed on a private network (MUS-SPEC-23-6B). A LAN attacker gets what a malicious relay gets: sizes, timing and the power to drop. The phone accepts LAN addresses only as literal private addresses (from the QR or a verified hello), so it never dials a name or a public host in clear |

On the phone, Android needs cleartext allowed for `ws://` (`expo-build-properties`, `usesCleartextTraffic`) and iOS asks
for local-network access (`NSLocalNetworkUsageDescription`); the only cleartext the app ever opens is `ws://` to a literal
private address, which the link parser and the stored record both enforce.

## 3. End-to-end encryption

### 3.1 Choice: Noise `IK` (and `IKpsk1` for pairing) over X25519, ChaCha20-Poly1305 and SHA-256

| Candidate | Mutual authentication | Forward secrecy | Replay protection | Dependencies | Verdict |
|---|---|---|---|---|---|
| libsodium sealed boxes | No: anyone with the public key can seal, so the sender is unauthenticated | No: a stolen static key decrypts recorded traffic | No: needs our own counters | A native libsodium module on the phone | Rejected |
| libsodium `crypto_box` per message | Yes (static-static) | No | No | Native module | Rejected |
| TLS with pinned self-signed certs | Server only, unless client certs | Yes | Yes | Hard to terminate inside the app through a relay; no TLS library over arbitrary frames in RN | Rejected |
| **Noise Protocol Framework, IK** | Yes: both static keys | Yes: ephemeral X25519 per session | Yes: per-direction counters | Node built-ins on the desktop; audited pure-JS `@noble/*` on the phone | **Chosen** |

Why Noise `IK`:

- The phone learns the desktop's static key from the QR, so the phone is an initiator that *knows* the responder: that is the
  `IK` pattern (`-> e, es, s, ss` / `<- e, ee, se`). One round trip, then encrypted frames.
- The phone's static key travels encrypted in the first message, so the relay can't even see *which* phone is connecting.
- Every session has fresh ephemerals: a key stolen later does not decrypt recorded sessions.
- Transport messages use per-direction 64-bit counters as nonces: a replayed, dropped or reordered frame fails to decrypt and
  the session closes (the WebSocket under it is ordered, so this only happens under attack).
- **Pairing uses `IKpsk1`**: the 32-byte one-time code from the QR is mixed in as the pre-shared key in the first message, so
  the desktop can tell at once whether the initiator really saw the QR (a wrong code fails to decrypt message 1, before
  anything is stored). After pairing, sessions use plain `IK` and the desktop accepts only static keys in its device registry.
- Primitives: X25519, ChaCha20-Poly1305 (IETF, 96-bit nonce = 32 zero bits + 64-bit little-endian counter), SHA-256 with
  HMAC-based HKDF, exactly as the Noise spec (revision 34) defines `Noise_IK_25519_ChaChaPoly_SHA256`. The desktop uses Node's
  `crypto` (no new dependency in the app); the phone uses `@noble/curves`, `@noble/ciphers` and `@noble/hashes` (audited,
  pure JS, no native module, ~60 KB together). The protocol code itself (`src/shared/mobile/noise.ts`) is one TypeScript file
  shared by both sides, with the primitives injected.
- Frames larger than a Noise message (65,535 bytes) are split into chunks with a one-byte continuation flag.

### 3.2 Keys

| Key | Where it lives | Lifetime |
|---|---|---|
| Desktop static X25519 key pair | Desktop secret store (Keychain / Windows credential store / keyring via Electron safeStorage). Never written in clear; pairing is refused without secure storage | Until "Reset phone access" (rotating it unpairs every phone) |
| Route secret | Desktop secret store | Rotated with the static key |
| One-time pairing code | Desktop memory only | 5 minutes, single use, invalidated after 5 wrong attempts |
| Phone static X25519 key pair | Phone Keychain (iOS) / Keystore-backed EncryptedSharedPreferences (Android) via `expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (not in backups) | Until the app unpairs or is deleted |
| Session keys | Memory on both ends | One connection |

## 4. Pairing, device registry and access

### 4.1 Pairing by QR

1. Desktop: Settings › Integrations › Phone › **Pair a phone**. The runtime turns phone access on (connects to the relay),
   creates a one-time code and shows a QR of
   `muster://pair?v=1&r=<relay URL>&d=<route>&k=<desktop public key>&c=<one-time code>&n=<desktop name>` (base64url).
   The same link can be copied, for a phone that can't scan.
2. Phone: scan (expo-camera barcode scanner) or paste. The app makes its static key pair, connects to the relay route and runs
   `IKpsk1` with the code. Message 1's encrypted payload names the phone (`"Dhairya's iPhone"`, platform).
3. Desktop: a valid message 1 consumes the code, adds the phone to the registry as **read-only**, and answers with the
   desktop's name. The Settings list shows the phone at once.
4. Phone: stores `{relay URL, route, desktop public key, own key pair, desktop name}` in secure storage. Every later
   connection is a plain `IK` session.

### 4.2 Registry and access levels

Each paired phone has: id, name, platform, public key, **access** (`read-only` by default, or `act`), paired-at, last-seen.

| Access | The phone may | The phone may not |
|---|---|---|
| `read-only` (default) | List chats, open one, watch its live stream, see the needs-you feed | Send, steer, answer, approve, start a chat |
| `act` | All of the above, plus send, steer, answer questions, approve or decline one request, start a chat (phase 2) | Change a chat's access level, approve "for the whole session", widen anything the desktop chat does not already allow |

- Access is checked **on the desktop** for every command; the phone's own UI hides what it can't do, but that is cosmetic.
- **Never above the desktop chat's access.** A message from the phone runs with the chat's existing access level; the phone
  has no command that changes it. "Approve for this session" is desktop-only, because it widens what later requests may do.
- **Revoke** removes the phone from the registry and closes its live sessions immediately; its next handshake fails because
  its static key is unknown. Changing access to read-only takes effect on the next command.

## 5. App stack

### 5.1 React Native with Expo vs a PWA served by Muster Server

| | React Native + Expo | PWA from Muster Server |
|---|---|---|
| Reaches the *desktop* app anywhere | Yes, through the relay with E2E | Only if each person runs a public server; the desktop's own chats are not on it |
| Push notifications on iOS | APNs, reliable | Web Push only for home-screen PWAs (iOS 16.4+), fragile |
| Keys in Keychain/Keystore | Yes (`expo-secure-store`) | No: IndexedDB, no hardware-backed storage |
| QR scan, camera, photos, files, microphone | Native modules, consistent | Browser APIs, inconsistent on iOS |
| Reuses TypeScript and protocol types | Yes (shared `src/shared/mobile`) | Yes |
| Reuses the desktop's renderers (Markdown, code, diffs, Mermaid, KaTeX, charts) | Through a WebView bundle (§5.4) | Directly |
| Store presence (TestFlight / Play) | Yes | No |
| Effort | A new package and CI job | Smallest |

**Decision: React Native with Expo** (SDK 58, React Native 0.88, React 19.3). The PWA stays what it is today (Muster Server's
web UI works on phones for teams), but the mobile app is the path that works for everyone with only a desktop.

### 5.2 Package layout

`packages/mobile` (`@muster/mobile`) is a standalone pnpm project (its own lockfile, outside the IDE workspace, like
`packages/agent-app` is a standalone npm project), so React Native's dependency tree never touches the other packages.

```
packages/mobile/
  app/                    Expo Router routes (thin: each renders a screen from src/screens)
    _layout.tsx           providers: secure storage, connection, theme
    index.tsx             chats list, or pairing when not paired
    pair.tsx              scan / paste the pairing link
    chat/[id].tsx         one chat with its live stream and composer
    needs-you.tsx         approvals and questions across chats
    settings.tsx          this phone, the desktop it is paired with, unpair
  src/
    connection/           MobileClient wiring: noble crypto suite, RN WebSocket, secure storage
    screens/              PairScreen, ChatsScreen, ChatScreen, NeedsYouScreen, SettingsScreen
    components/           TimelineRow, ApprovalCard, QuestionCard, Composer, StatusDot
    theme.ts              colors and spacing from Muster's design tokens
  tests/                  jest-expo + @testing-library/react-native, Node only
```

The protocol and session code is **not** copied into the app: `packages/agent-app/src/shared/mobile/*` is imported through a
path alias (`@muster/shared/mobile/*`), resolved by TypeScript `paths`, jest `moduleNameMapper` and Metro `watchFolders`.

### 5.3 Native modules

| Module | Why | Phase |
|---|---|---|
| `expo-router` | File-based navigation, deep link `muster://pair` | 1 |
| `expo-secure-store` | Phone key pair and pairing record in Keychain / Keystore | 1 |
| `expo-crypto` | Secure random bytes for keys and ephemerals (`@noble/*` are given this source) | 1 |
| `expo-camera` | QR scanning (its built-in barcode scanner) | 1 |
| `react-native-webview` | Rich rendering bundle (§5.4) | 4 |
| `expo-notifications` | APNs / FCM tokens and notification taps | 3 |
| `expo-image-picker`, `expo-document-picker`, `expo-file-system` | Attach photos and files (read as bytes, uploaded through the session) | 2 |
| `expo-build-properties` | Android: allow `ws://` to the desktop's private address (§2.3) | 2 |
| `expo-audio` | Dictation recording (#840) | 4 |

### 5.4 Rendering replies

- **Phase 1:** text with code fences shown monospaced, tool rows as one line with status, approval and question cards native.
- **Phase 4:** one offline WebView bundle built from the desktop renderer's own pieces (`react-markdown` + `remark-gfm` +
  `remark-math`, Shiki, the inline diff, Mermaid, KaTeX, Vega-Lite, sandboxed `render_html` pages). Built by esbuild from
  `packages/agent-app/src/renderer` into `packages/mobile/assets/rich/` at build time; the app posts a message's Markdown to it
  and gets back a measured height. No network in the WebView; `originWhitelist` limited to the bundle; pages keep the same
  sandbox rules as on the desktop.

### 5.5 Push notifications

Push needs a sender holding the APNs key and FCM credentials, so it needs a small **push relay service**, separate from the
data relay:

1. The phone gets its APNs/FCM token (`expo-notifications`) and sends it to the desktop *through the encrypted session*.
2. The desktop registers with the push relay an **opaque push id** (random, per phone) mapped to that token. The relay learns
   the token and the opaque id, not which desktop or person it is.
3. When a chat needs the person (approval, question, failed run, finished run), the desktop calls the push relay with the
   opaque id and a **generic payload only**: `{"title": "Muster", "body": "An agent needs you", "data": {"n": "<random
   notification id>"}}`. No chat title, no command, no file name, no text.
4. Tapping the notification opens the app, which connects over the E2E session and asks the desktop what notification `n` is,
   then opens that chat or card.
5. Revoking a phone deletes its push id at the relay. Rate limits per push id stop a stolen id from spamming.

A Muster Server can host the push relay for its team; otherwise it is the same production hosting decision as the data relay.

## 6. Screens and flows (mapped to #326)

| #326 checklist item | Screen / flow | Phase |
|---|---|---|
| Pair by QR, E2E, works away from home | **Pair**: scan or paste; shows the desktop name; error states for expired code, offline desktop, wrong code | 1 |
| Chats list | **Chats**: title, folder or project, status dot (running, waiting, failed), needs-you badge, pull to refresh, live updates | 1 |
| Open a chat with its live stream | **Chat**: timeline (user, assistant streaming, tool one-liners, notices), approval and question cards in place | 1 |
| Send and steer | **Composer**: Send when idle; while running, Send steers the running turn (same rule as the desktop's follow-up mode) | 1 |
| Attach photos and files | Composer + button: photo library, camera, files; uploaded through the session as attachments | 2 |
| Needs-you feed, answer in place | **Needs you** tab: every pending approval and question across chats; Approve / Decline / answer without opening the chat | 1 (feed) / 3 (push) |
| Push notifications | Generic push → tap → card (§5.5) | 3 |
| Start a new chat (folder/project, provider, model) | **New chat** sheet: folder or project from the desktop list, provider and model from the desktop's catalog | 2 |
| Projects: tasks, runs, Inbox | **Projects** tab: task list with status, runs, Inbox items with their actions | 3 |
| Dictation (#840) | Mic in the composer; transcribed by the desktop's dictation backend, through the session | 4 |
| Rich replies | WebView rich bundle (§5.4) | 4 |
| Read-only by default, revoke from desktop | Desktop Settings › Integrations › Phone: list, access switch, Revoke; phone shows "Read only" in its composer | 1 |
| TestFlight / Play internal testing | EAS build profiles and store listings | 5 |

## 7. Phases

Each phase ships on its own and has acceptance cases in clause 23.

**Phase 1: pair, connect, read, steer, approve.**
Desktop: `mobile.*` runtime commands (status, pair start/cancel, devices list/revoke/set access, relay config), the Noise
responder, the device registry, the relay client, the phone command bridge with its allowlist. Dev relay in
`packages/relay` (tests and local development only). Phone: pairing, chats list, chat with live stream, send, steer,
approve/decline, answer questions, needs-you feed, settings with unpair. CI type-checks the app and runs its unit tests.
Acceptance: MUS-SPEC-23-1A..1E (pairing, registry, revocation, read-only), 2A..2E (chats, stream, send, steer, approve,
answer through the relay), 3A (relay sees only ciphertext), 4A..4D (mobile screens).

**Phase 2: start work from the phone (built).** New chat in a folder or project with provider and model (`chat.options`,
`chat.create`: act only, the place, provider and model re-checked on the desktop and access checked again right before the
chat is made); attachments (photos, camera and files, chunked upload through the session: `upload.start`, `upload.chunk`,
`upload.finish`, `upload.cancel`, `upload.discard`, then `chat.send` with the attachment ids; staged on the desktop like its
own attachments, so a photo reaches the agent as an image input); direct LAN connection with relay fallback (§2.3).
Acceptance: MUS-SPEC-23-11A..11C (new chat), 12A..12C (attachments), 13A..13D (LAN), plus 14A..14C (pairing fixes found on a
Galaxy S25: one attempt at a time, AA contrast, `muster://pair` deep links).

**Phase 3: needs-you everywhere.** Push relay and generic pushes; Projects (tasks, runs, Inbox) read and act; a relay mounted
in Muster Server. Acceptance: an approval on the desktop produces exactly one generic push whose payload holds no chat text;
tapping it opens the card; approving from the card unblocks the run; revoking removes the push id.

**Phase 4: rich replies and dictation.** WebView rich bundle (Markdown, code, diffs, Mermaid, charts, maths, pages);
dictation through the desktop's backend. Acceptance: a reply with each rich kind renders in the bundle in a jest WebView test
and on a device; a recorded clip is transcribed into the composer.

**Phase 5: distribution.** EAS build profiles, TestFlight and Play internal testing tracks, crash reporting without content,
store listings. Acceptance: a signed build installs from TestFlight and Play internal testing and pairs with a release desktop.

## 8. Security

### 8.1 Threat model

| Threat | What the attacker has | Mitigation |
|---|---|---|
| **Malicious or compromised relay** | Every byte between phone and desktop | Noise IK end to end: the relay sees ciphertext, route ids, sizes and timing only. It can drop or delay (denial of service), not read, change or replay: tampering fails the AEAD tag, replays fail the counter. It can't impersonate the desktop without the desktop's static private key, nor a phone without the phone's. Tested: the dev relay's log of forwarded frames contains no plaintext (MUS-SPEC-23-3A). |
| **Someone claims the desktop's route** | The route id | Registration needs the route secret (the id is its hash). Even a hijacked route can't finish a handshake without the desktop's static key. |
| **Stolen pairing QR (photo over the shoulder, screenshot)** | The one-time code and the desktop's public key | The code lasts 5 minutes, works once and dies after 5 wrong tries; the new phone shows up in the desktop list at once, read-only, and one click revokes it. Pairing needs the Settings page open on the desktop. |
| **Lost or stolen phone** | The device, maybe unlocked | Keys are in Keychain/Keystore, this-device-only and only when unlocked, never in backups. The phone is read-only unless the person granted `act`. Revoke from desktop Settings ends its sessions and future handshakes. Phase 3 adds an optional app lock (Face ID / biometric) before `act` commands. |
| **Malicious phone app build / modified client** | A paired key pair | The desktop enforces access per command with an allowlist; the phone can't reach any runtime command outside it, can't raise access, and can't approve for a session. |
| **Push provider (Apple/Google) or push relay** | Push payloads | Payloads are generic ("An agent needs you" + random id); the content is fetched over the E2E session. |
| **Network attacker on the LAN path** | LAN traffic, and the ability to answer at the desktop's LAN address | The same Noise session as over the relay (§2.3): it can read nothing and can't finish a handshake without the desktop's key. A fake answer or a forged "revoked" close at the LAN address only makes the phone use the relay. Tested: MUS-SPEC-23-13A, 13B. |
| **Someone else on the same network** | The desktop's LAN port | It answers only the phone route of this desktop, with a literal Host and no foreign Origin, behind the same handshake, registry and caps as the relay; off when phone access is off or the switch is off. Tested: MUS-SPEC-23-13B, 13C. |
| **A phone uploading too much or out of order** | A paired phone with act access | Uploads are capped at 20 MB, two at a time, in order, each chunk at most 32 KB and never past the declared size, checked against a SHA-256 before staging; only files that phone uploaded can be sent or removed from it. Tested: MUS-SPEC-23-12B. |

### 8.2 Rules

- Pairing is refused when the desktop has no secure storage (same rule as API keys); nothing secret is written in clear.
- The desktop never trusts the phone's UI state: every command is checked against the device's current access and the
  bridge's allowlist, and inputs are re-validated (lengths, ids, decisions).
- Read-only by default; access changes only on the desktop.
- Revocation is immediate and closes live sessions.
- The phone gets only what it renders: the bridge maps runtime types to slim wire types (no file paths beyond folder names,
  no provider credentials, no settings).
- Logs never contain frame contents or keys.

## 9. Open decisions

- **Production relay hosting.** Options: a Muster-hosted relay (simplest for people, needs an operator and abuse limits), a
  relay inside Muster Server (teams), or both. The relay is stateless and holds no keys, so this is an operations decision,
  not a security one. Until it is made, the relay URL is a setting and phase 1 is used with a self-run relay.
- **Push relay hosting**: same decision, plus APNs/FCM credentials ownership.
- **App lock** before `act` commands: on by default or opt-in (phase 3).

## 10. Building and verifying

- No simulators, Xcode or Gradle builds are needed for phase 1 work: the app's screens and the phone client run under jest in
  Node, and the end-to-end workflow tests drive a Node "phone" (the same `MobileClient` with Node crypto) against the real
  desktop runtime through the dev relay.
- CI (`.github/workflows/mobile-ci.yml`) installs the app, type-checks it and runs its unit tests.
- Next step for real devices: EAS build profiles (`eas.json`: development, preview, production), a development build on a
  physical iPhone and Android phone, then TestFlight and Play internal testing (phase 5). What only a real device can verify
  is listed in the phase 1 PR: camera QR scanning, Keychain/Keystore behaviour, backgrounding and reconnect, and WebSocket
  behaviour on cellular networks.
