# MUS-SPEC-23: Mobile app and phone access

People pair a phone with their desktop Muster and see and steer their agents from it, at home or away. The design is in [docs/mobile/DESIGN.md](../../mobile/DESIGN.md) (issue #326).

What the user can do:
- pair a phone by scanning a QR (or pasting its link) from Settings › Integrations › Phone on the desktop;
- see the desktop's chats, open one and watch its turn stream live;
- send a message, steer a running turn, approve or decline a request and answer a question, once the desktop allows the phone to act;
- see everything that needs them across chats in one feed;
- revoke a phone, or change it between read only and act, from the desktop.

Boundaries:
- The phone talks to the desktop through a relay with end-to-end encryption (Noise IK); the relay sees only ciphertext.
- A new phone is read-only. The phone can never raise a chat's access level or approve for a whole session.
- Pairing needs secure storage on the desktop and a one-time code that expires.
- Production relay hosting, push notifications, new chats, attachments, Projects, dictation and rich rendering are later phases (see the design).

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-23-1A](23-mobile.md#mus-spec-23-1a) | A Pair a phone on the desktop returns a link; a phone pairing with it through the relay, once confirmed on the desktop, is listed by mobile.status as read-only and its hello reports read-only. | [`a phone pairs with the QR link through the relay and is listed read-only`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-1B](23-mobile.md#mus-spec-23-1b) | Reusing a used code (told it was already used), using an expired code and using a wrong code all fail, and none of them adds a device. | [`a pairing code works once, expires, and a wrong code stores nothing`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-1C](23-mobile.md#mus-spec-23-1c) | Revoke closes the phone's live session and its next connection with the saved record fails. | [`revoking a phone closes its session and refuses its next connection`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-1D](23-mobile.md#mus-spec-23-1d) | Read-only phones can list chats and open one; send, steer, approve and answer are refused with a reason until access is set to act on the desktop. | [`a read-only phone can read but cannot send, steer or answer until the desktop allows it`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-1E](23-mobile.md#mus-spec-23-1e) | When the computer has no secure storage, Pair a phone fails with a reason and no key file is written. | [`without secure storage pairing is refused and no key is written`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-2A](23-mobile.md#mus-spec-23-2a) | The phone's chat list carries the chat and its status; opening the chat and starting a turn delivers the user message and the streaming reply as item events, in order. | [`a paired phone lists chats and watches a turn stream live`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-2B](23-mobile.md#mus-spec-23-2b) | Send starts a turn from the phone; a second message while it runs steers the same turn. | [`a phone sends a message and steers the running turn`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-2C](23-mobile.md#mus-spec-23-2c) | The phone approves an approval request and the run continues; approve for the whole session is refused from the phone. | [`a phone approves a request in place and the run continues; approve for session is refused`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-2D](23-mobile.md#mus-spec-23-2d) | The phone answers a provider question and the agent receives the chosen option. | [`a phone answers a question and the agent receives the answer`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-2E](23-mobile.md#mus-spec-23-2e) | needs.list returns pending approvals and questions across chats with the chat title, and empties when they are answered. | [`the needs-you feed lists pending approvals and questions across chats`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-3A](23-mobile.md#mus-spec-23-3a) | No frame the relay forwards contains chat text, a chat title, a command or JSON. | [`the relay forwards only ciphertext: no chat text, title or command in any frame`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-3B](23-mobile.md#mus-spec-23-3b) | Changing one byte of a frame, or sending an old frame again, fails decryption and closes the session without running the command. | [`a tampered or replayed frame is rejected and closes the session`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-3C](23-mobile.md#mus-spec-23-3c) | Every mobile.* command, including confirm, reject, link and reset, is desktop only on Muster Server, for every role. | [`phone pairing commands are desktop only on Muster Server, even for the owner`](../../../packages/server/tests/policy.test.ts) |
| [MUS-SPEC-23-4A](23-mobile.md#mus-spec-23-4a) | Pairing and a session between the phone's noble crypto and the desktop's Node crypto succeed both ways. | [`the phone crypto pairs and talks with the desktop crypto`](../../../packages/mobile/tests/crypto-interop.test.ts) |
| [MUS-SPEC-23-4B](23-mobile.md#mus-spec-23-4b) | A pasted pairing link pairs, shows the check code and stores the record only once the desktop confirms; a malformed link shows an error and stores nothing. | [`pairs from a pasted link and rejects a malformed one`](../../../packages/mobile/tests/pair-screen.test.tsx) |
| [MUS-SPEC-23-4C](23-mobile.md#mus-spec-23-4c) | Rows show the title, place and status; a chat waiting on the person shows a needs-you badge; a chats event updates the list. | [`lists chats with status and needs-you, and updates live`](../../../packages/mobile/tests/chats-screen.test.tsx) |
| [MUS-SPEC-23-4D](23-mobile.md#mus-spec-23-4d) | Item events grow the reply on screen; the composer sends when the chat is idle and steers while it runs. | [`streams a reply, sends when idle and steers while running`](../../../packages/mobile/tests/chat-screen.test.tsx) |
| [MUS-SPEC-23-4E](23-mobile.md#mus-spec-23-4e) | Approve and Decline on an approval card call approval.respond with accept or decline; a read-only phone shows the card without the buttons and says why. | [`approves or declines in place, and read-only hides the actions`](../../../packages/mobile/tests/chat-screen.test.tsx) |
| [MUS-SPEC-23-4F](23-mobile.md#mus-spec-23-4f) | The feed lists approvals and questions across chats; choosing an option on a question answers it from the feed. | [`the needs-you feed answers a question without opening the chat`](../../../packages/mobile/tests/needs-you-screen.test.tsx) |
| [MUS-SPEC-23-5A](23-mobile.md#mus-spec-23-5a) | Settings › Integrations › Phone shows a QR for the pairing link, a pending phone with its check code to add or reject, lists a paired phone as read-only with platform and key fingerprint and an access switch, and Revoke removes it. | [`Phone settings show the pairing QR, list the phone read-only, and revoke it`](../../../packages/agent-app/tests/mobile-settings-326-dom.tsx) |
| [MUS-SPEC-23-6A](23-mobile.md#mus-spec-23-6a) | The relay registers a route only after a fresh Ed25519 signature over its own nonce; a replayed or forged registration is refused and the live registration stays; a relay not started for tests records nothing. | [`the relay registers a route only for a fresh signature; a replayed or forged registration is refused and the live one stays`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-6B](23-mobile.md#mus-spec-23-6b) | mobile.relay.set and the phone's link parser accept wss:// anywhere and ws:// only for loopback and private-network addresses. | [`a relay address must be wss:// except on loopback and private networks`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-6C](23-mobile.md#mus-spec-23-6c) | Started without the test flag, the relay refuses a plain ws:// listener off loopback and serves wss:// when given a certificate. | [`the relay serves plain ws:// only on loopback unless it is a test relay, and wss:// with a certificate`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-7A](23-mobile.md#mus-spec-23-7a) | After the handshake the phone and the desktop show the same 6-digit check code; the phone can do nothing and cannot reconnect until the desktop adds it; then it is listed with platform, paired-at and key fingerprint and a notice says a phone paired. | [`a new phone waits for the check code to be confirmed on the desktop and cannot act or reconnect until then`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-7B](23-mobile.md#mus-spec-23-7b) | A second phone using a code another phone already took is told the code was used and to check the desktop list; rejecting the pending phone disconnects it and adds nothing. | [`a second phone using a taken code is told to check the desktop list, and the owner can reject the first`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-7C](23-mobile.md#mus-spec-23-7c) | mobile.status carries the pairing expiry and the pending phone, never the code or the link; mobile.pair.link returns the link. | [`mobile.status never carries the pairing link or code`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-8A](23-mobile.md#mus-spec-23-8a) | When the stored key exists but cannot be decrypted, pairing fails with a clear message and the key is left as it was; Reset phone access rotates the keys and route and clears the phones. | [`an unreadable phone key is refused, never replaced, and Reset phone access rotates it`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-8B](23-mobile.md#mus-spec-23-8b) | Settings asks before resetting, then calls mobile.reset. | [`Reset phone access asks first, then rotates the keys`](../../../packages/agent-app/tests/mobile-settings-326-dom.tsx) |
| [MUS-SPEC-23-9A](23-mobile.md#mus-spec-23-9a) | A first message that does not decrypt closes with 4400 (bad frame); one that decrypts but whose phone key is not paired closes with 4403 (revoked). | [`a first message that does not decrypt closes with 4400, and only an unknown key closes with 4403`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-9B](23-mobile.md#mus-spec-23-9b) | The app's link policy retries with backoff after a 4400 close and goes to the revoked state only after a 4403. | [`a 4400 close retries and only 4403 shows the phone as revoked`](../../../packages/mobile/tests/reconnect.test.ts) |
| [MUS-SPEC-23-10A](23-mobile.md#mus-spec-23-10a) | After the handshake alone the phone is not connected and its last-seen time is unchanged; its first valid encrypted request marks it connected and updates last-seen. | [`a phone counts as connected only after its first valid encrypted message`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-10B](23-mobile.md#mus-spec-23-10b) | A connection that sends nothing is closed after the handshake timeout; connections beyond the pending cap are closed at once; six wrong codes close their own connections but the right code still pairs. | [`stalled handshakes time out, pending connections are capped, and wrong codes do not end the pairing`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-10C](23-mobile.md#mus-spec-23-10c) | If a phone's access drops to read-only, or its session ends, while a request is in flight, the runtime command is not called. | [`access and the session are checked again right before the runtime command runs`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-10D](23-mobile.md#mus-spec-23-10d) | A handshake message or transport message over 65,535 bytes throws without any decryption attempt. | [`frames over 65,535 bytes are refused before decrypting`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-10E](23-mobile.md#mus-spec-23-10e) | Approval details reach the phone with the folder name instead of the working directory's full path, and changed files relative to it. | [`the phone gets folder names and relative file paths, never full paths`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-10F](23-mobile.md#mus-spec-23-10f) | The relay closes a desktop that does not register in time and a socket that stops answering pings, and closes a phone that sends a message over 87,384 characters without forwarding it. | [`the relay closes unregistered and silent sockets and refuses oversized messages`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-10G](23-mobile.md#mus-spec-23-10g) | The desktop completes the pairing handshake and seals and opens frames inside Electron, whose BoringSSL has no ChaCha20-Poly1305. | [`the desktop pairing handshake and frames work inside Electron, not only in Node`](../../packages/agent-app/tests/mobile-326.test.ts) |

### Pairing, the device registry and access

<a id="mus-spec-23-1a"></a>
#### MUS-SPEC-23-1A: A phone pairs by the QR link and is listed read-only

- Precondition: Desktop runtime with secure storage and the relay address set; no phones paired.
- Action: Start pairing on the desktop (mobile.pair.start), pair a Node phone with the returned link through the dev relay, and confirm its check code on the desktop (mobile.pair.confirm).
- Expected result: The link is a muster://pair link holding the relay, route, desktop key and a one-time code. The phone completes the handshake and learns the desktop name; after the confirmation mobile.status lists exactly one device with the phone's name and platform, access read-only and connected; the phone's hello says read-only; pairing is no longer open.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a phone pairs with the QR link through the relay and is listed read-only`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: Scanning the QR with a camera is not exercised; the phone is given the link text.
- Evidence: UNVERIFIED

<a id="mus-spec-23-1b"></a>
#### MUS-SPEC-23-1B: A pairing code works once, expires, and a wrong code stores nothing

- Precondition: A desktop with one pairing started.
- Action: Pair one phone; try a second phone with the same link; start a new pairing and try a phone with a changed code; start another pairing and let it pass its expiry (a short test expiry).
- Expected result: Only the first phone is paired. The reused link, the wrong code and the expired code each fail on the phone with a pairing error (the reused one says the code was already used), and the device list still has exactly one phone.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a pairing code works once, expires, and a wrong code stores nothing`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: The 5-minute production expiry is shortened in the test, not waited out.
- Evidence: UNVERIFIED

<a id="mus-spec-23-1c"></a>
#### MUS-SPEC-23-1C: Revoking a phone ends its session at once and refuses it later

- Precondition: A paired phone with a live session.
- Action: Revoke it on the desktop (mobile.devices.revoke), then reconnect with the saved pairing record.
- Expected result: The live session closes on the phone with a revoked reason; the device list is empty; the reconnect fails and no command reaches the runtime.
- Test: `packages/agent-app/tests/mobile-326.test.ts::revoking a phone closes its session and refuses its next connection`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-1d"></a>
#### MUS-SPEC-23-1D: A read-only phone reads but cannot act until the desktop allows it

- Precondition: A paired phone (read-only) and a chat.
- Action: From the phone: list chats, open the chat, then send a message. On the desktop set the phone's access to act (mobile.devices.setAccess) and send again.
- Expected result: While read-only, listing and opening work and the send is refused with "read only" and no user message is added. After the change the phone gets an access event and the same send starts a run whose user message appears in the desktop timeline.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a read-only phone can read but cannot send, steer or answer until the desktop allows it`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-1e"></a>
#### MUS-SPEC-23-1E: Without secure storage pairing is refused

- Precondition: A desktop runtime whose secret store has no OS encryption.
- Action: Start pairing.
- Expected result: mobile.pair.start fails with a message about secure storage; mobile.status reports secureStorage false; no secrets.json entry for the phone keys exists.
- Test: `packages/agent-app/tests/mobile-326.test.ts::without secure storage pairing is refused and no key is written`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: None known.
- Evidence: UNVERIFIED

### Chats, streaming, steering and answering from the phone

<a id="mus-spec-23-2a"></a>
#### MUS-SPEC-23-2A: A phone lists chats and watches a turn stream live

- Precondition: A paired phone with act access and one chat with a fake provider that streams its reply in two pieces.
- Action: List chats, open the chat, send a message from the desktop and let the provider stream "Hello " then "world".
- Expected result: The list holds the chat with its title. Item events for that chat arrive with the user message and an assistant item whose text grows to "Hello world"; a chats event reports the chat running and then completed.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a paired phone lists chats and watches a turn stream live`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: Delivery timing on a slow cellular link is not measured.
- Evidence: UNVERIFIED

<a id="mus-spec-23-2b"></a>
#### MUS-SPEC-23-2B: A phone sends a message and steers the running turn

- Precondition: A paired phone with act access and a chat whose fake provider waits until released.
- Action: From the phone, send "fix the build"; while the run waits, steer with "also run the tests".
- Expected result: The provider receives "fix the build" as the prompt and "also run the tests" through steer; the desktop timeline has both user messages, the second marked as steered; the phone's steer result is steered.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a phone sends a message and steers the running turn`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-2c"></a>
#### MUS-SPEC-23-2C: A phone approves a request in place

- Precondition: A paired phone with act access; a chat in Ask for approval whose provider asks to run a command.
- Action: From the phone, try approval.respond with acceptForSession, then approve once.
- Expected result: The session-wide approval is refused with a reason and the request stays pending; the plain approval reaches the provider as accept, the card is approved on the desktop and the run completes.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a phone approves a request in place and the run continues; approve for session is refused`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-2d"></a>
#### MUS-SPEC-23-2D: A phone answers a question

- Precondition: A paired phone with act access; a chat whose provider asks a question with options A and B.
- Action: From the phone, answer B.
- Expected result: The provider receives B for that question, the question card reads answered on the desktop and the run completes.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a phone answers a question and the agent receives the answer`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: Secret (masked) questions are not answerable from the phone in phase 1 and are not tried.
- Evidence: UNVERIFIED

<a id="mus-spec-23-2e"></a>
#### MUS-SPEC-23-2E: The needs-you feed lists what waits for the person

- Precondition: A paired phone; two chats, one waiting on an approval and one on a question.
- Action: List needs from the phone; answer both from the desktop; list again.
- Expected result: The first list has two entries naming each chat, the kind and a short summary (the command, the question). The second list is empty, and a needs event told the phone each time it changed.
- Test: `packages/agent-app/tests/mobile-326.test.ts::the needs-you feed lists pending approvals and questions across chats`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: None known.
- Evidence: UNVERIFIED

### What the relay can see

<a id="mus-spec-23-3a"></a>
#### MUS-SPEC-23-3A: The relay forwards only ciphertext

- Precondition: The dev relay records every payload it forwards in either direction.
- Action: Pair a phone, list chats, open a chat, send a message with a marker word, stream a reply with another marker and approve a command with a third marker.
- Expected result: Hundreds of bytes flow, and no recorded payload, decoded from base64 as UTF-8, contains any marker, the chat title, the phone name or a JSON brace-quote sequence; every payload is valid base64.
- Test: `packages/agent-app/tests/mobile-326.test.ts::the relay forwards only ciphertext: no chat text, title or command in any frame`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: Traffic analysis (sizes and timing) is out of scope and stays visible to a relay, as the design says.
- Evidence: UNVERIFIED

<a id="mus-spec-23-3b"></a>
#### MUS-SPEC-23-3B: A tampered or replayed frame closes the session

- Precondition: A paired phone with act access and a live session through a relay that can be told to tamper or replay.
- Action: Send a message with one ciphertext byte flipped; on a fresh session, replay an earlier frame.
- Expected result: Each time the desktop closes the session, the phone sees it close, and the timeline has no user message from the tampered or replayed frame.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a tampered or replayed frame is rejected and closes the session`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-3c"></a>
#### MUS-SPEC-23-3C: Muster Server does not pair phones yet

- Precondition: Muster Server's command policy.
- Action: Classify and authorize each mobile.* command (status, relay, pairing start, link, confirm, reject and cancel, revoke, access and reset) as owner, admin, member and viewer.
- Expected result: Each is classed desktop and refused as desktop-only for every role, so no server member can pair a phone with the shared runtime and bypass per-person project access.
- Test: `packages/server/tests/policy.test.ts::phone pairing commands are desktop only on Muster Server, even for the owner`
- Environment: Node test runner on the server policy module.
- Known gaps: Pairing phones per person on a server is phase 3 of the design.
- Evidence: UNVERIFIED

### The phone app

<a id="mus-spec-23-4a"></a>
#### MUS-SPEC-23-4A: The phone's crypto talks with the desktop's

- Precondition: The app's noble-based Noise primitives and the desktop's Node-based ones, in one jest process.
- Action: Run the IKpsk1 pairing handshake with the phone on noble and the desktop on Node, exchange a frame each way (one larger than a Noise message), then a plain IK session.
- Expected result: Both handshakes finish with matching keys, frames decrypt both ways in order, the large frame comes back whole, and a frame sealed for the wrong direction fails.
- Test: `packages/mobile/tests/crypto-interop.test.ts::the phone crypto pairs and talks with the desktop crypto`
- Environment: jest (jest-expo preset) in Node with @testing-library/react-native; the screen is given a fake connection with the MobileClient interface.
- Known gaps: Not checked against the published Noise test vectors; interop between two independent primitive sets is checked instead.
- Evidence: UNVERIFIED

<a id="mus-spec-23-4b"></a>
#### MUS-SPEC-23-4B: The pair screen pairs from a pasted link

- Precondition: The pair screen with a fake pairing function and an in-memory secure store.
- Action: Paste "hello" and press Pair; then paste a valid link and press Pair.
- Expected result: The malformed link shows "This is not a Muster pairing link" and nothing is stored. The valid link calls pairing with the parsed link and shows the check code ("123 456") with an instruction to confirm it on the computer; nothing is stored yet. When the desktop confirms, the record is saved and the screen reports it is paired with the desktop name.
- Test: `packages/mobile/tests/pair-screen.test.tsx::pairs from a pasted link and rejects a malformed one`
- Environment: jest (jest-expo preset) in Node with @testing-library/react-native; the screen is given a fake connection with the MobileClient interface.
- Known gaps: The camera scanner is not rendered in jest; a real device check is listed in the PR.
- Evidence: UNVERIFIED

<a id="mus-spec-23-4c"></a>
#### MUS-SPEC-23-4C: The chats list shows status and needs-you, live

- Precondition: The chats screen with a fake connection holding two chats, one waiting on an approval.
- Action: Render, then emit a chats event that renames one chat and marks it running.
- Expected result: Both titles show, the waiting chat has a "Needs you" badge, and after the event the new title and "Running" show without a reload.
- Test: `packages/mobile/tests/chats-screen.test.tsx::lists chats with status and needs-you, and updates live`
- Environment: jest (jest-expo preset) in Node with @testing-library/react-native; the screen is given a fake connection with the MobileClient interface.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-4d"></a>
#### MUS-SPEC-23-4D: The chat screen streams, sends and steers

- Precondition: The chat screen for one idle chat with a fake connection, access act.
- Action: Type and press Send; emit a running status and item events that stream "Hello world"; type again and press Send.
- Expected result: The first press calls chat.send with the text and clears the field. The reply shows "Hello world" after the events. While running the button reads Steer and the second press calls chat.steer.
- Test: `packages/mobile/tests/chat-screen.test.tsx::streams a reply, sends when idle and steers while running`
- Environment: jest (jest-expo preset) in Node with @testing-library/react-native; the screen is given a fake connection with the MobileClient interface.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-4e"></a>
#### MUS-SPEC-23-4E: Approval cards act in place on the phone

- Precondition: The chat screen with a pending command approval, first with access act, then read-only.
- Action: Press Approve; render read-only.
- Expected result: approval.respond is called with the item and accept. Read-only shows the command and "Read only: allow this phone to act in Settings on your computer" and no Approve button; the composer is disabled.
- Test: `packages/mobile/tests/chat-screen.test.tsx::approves or declines in place, and read-only hides the actions`
- Environment: jest (jest-expo preset) in Node with @testing-library/react-native; the screen is given a fake connection with the MobileClient interface.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-4f"></a>
#### MUS-SPEC-23-4F: The needs-you feed answers without opening the chat

- Precondition: The needs-you screen with a fake connection holding one approval and one question.
- Action: Press the option "B" on the question.
- Expected result: Both entries show with their chat titles; question.respond is called with that question's id and B; a needs event that removes it removes the row.
- Test: `packages/mobile/tests/needs-you-screen.test.tsx::the needs-you feed answers a question without opening the chat`
- Environment: jest (jest-expo preset) in Node with @testing-library/react-native; the screen is given a fake connection with the MobileClient interface.
- Known gaps: None known.
- Evidence: UNVERIFIED

### On the desktop

<a id="mus-spec-23-5a"></a>
#### MUS-SPEC-23-5A: Settings shows the pairing QR, the phones and Revoke

- Precondition: The Phone panel with a stubbed bridge: relay address set, no phones.
- Action: Press Pair a phone; the bridge then reports a pending phone; press Add phone; the bridge then reports one paired phone; switch it to Can act; press Revoke and confirm.
- Expected result: A QR (an SVG of dark modules) and the pairing link (from mobile.pair.link) show with the time it expires. The pending phone shows its name, platform and check code; Add phone calls mobile.pair.confirm with that code. The phone row shows its name, platform, key fingerprint and "Read only". Switching calls mobile.devices.setAccess with act. Revoke calls mobile.devices.revoke with its id and the row goes away.
- Test: `packages/agent-app/tests/mobile-settings-326-dom.tsx::Phone settings show the pairing QR, list the phone read-only, and revoke it`
- Environment: DOM suite (linkedom) with a stubbed window.muster bridge; no runtime.
- Known gaps: The QR is not decoded by a scanner in the test; its module count and finder patterns are checked instead. Screenshots come from the real component.
- Evidence: UNVERIFIED

### Relay registration and addresses (security review)

<a id="mus-spec-23-6a"></a>
#### MUS-SPEC-23-6A: Only the desktop that holds the route key can register its route

- Precondition: A desktop registered with the dev relay; the test holds the desktop's route signing key.
- Action: Open a second desktop connection and answer its challenge with a signature made for an earlier nonce; open a third and send the desktop's route key with a bad signature; then pair a phone. Separately, run pairing traffic through a relay started without the test flag.
- Expected result: Both forged registrations are closed without a registered reply, the route still reaches the real desktop and the phone pairs through it. Nothing the desktop sends lets anyone register the route again (the signature covers a one-time nonce). The relay started without the test flag has an empty frames list.
- Test: `packages/agent-app/tests/mobile-326.test.ts::the relay registers a route only for a fresh signature; a replayed or forged registration is refused and the live one stays`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: A relay operator can still drop traffic (denial of service); that is out of scope, as the design says.
- Evidence: UNVERIFIED

<a id="mus-spec-23-6b"></a>
#### MUS-SPEC-23-6B: A relay address must use wss:// off the local network

- Precondition: A desktop runtime.
- Action: Set the relay to ws://relay.example.com, ws://192.168.1.5:7480, ws://127.0.0.1:7480 and wss://relay.example.com; parse pairing links with ws://relay.example.com and wss://relay.example.com.
- Expected result: ws://relay.example.com is refused with a message asking for wss://, by the desktop and by the phone's parser; the private, loopback and wss:// addresses are accepted.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a relay address must be wss:// except on loopback and private networks`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: Hostnames that resolve to private addresses are treated as public (only literal private IPs and localhost may use ws://).
- Evidence: UNVERIFIED

<a id="mus-spec-23-6c"></a>
#### MUS-SPEC-23-6C: The relay serves wss:// except on loopback

- Precondition: packages/relay, started without the test flag.
- Action: Start it on 0.0.0.0 without a certificate; start it on 127.0.0.1 without one; start it on 127.0.0.1 with a certificate and key and make an HTTPS request to it.
- Expected result: The 0.0.0.0 start is refused with a message about TLS. The loopback start gives a ws:// address (for a TLS tunnel or proxy in front). The start with a certificate gives a wss:// address and answers over TLS.
- Test: `packages/agent-app/tests/mobile-326.test.ts::the relay serves plain ws:// only on loopback unless it is a test relay, and wss:// with a certificate`
- Environment: Node test runner on the dev relay from packages/relay; a self-signed test certificate.
- Known gaps: Whether a tunnel in front of a loopback relay uses TLS is up to the tunnel; the desktop and phone refuse ws:// relay addresses off the local network (6B).
- Evidence: UNVERIFIED

### Confirming a pairing (security review)

<a id="mus-spec-23-7a"></a>
#### MUS-SPEC-23-7A: A new phone waits for the check code to be confirmed on the desktop

- Precondition: A desktop with pairing started.
- Action: Pair a phone; compare check codes; call chats.list from it; reconnect with its record; confirm with a wrong code, then with the right one.
- Expected result: Both sides have the same 6-digit check code, also in mobile.status as the pending phone with its name, platform and fingerprint. Until confirmed, chats.list is refused as pending, the device list is empty and a reconnect is refused. A wrong code is refused. After the right one the phone gets the paired event, is listed read-only with its platform, paired-at and a fingerprint matching its key, and the runtime emits the notice "A phone named … paired at …".
- Test: `packages/agent-app/tests/mobile-326.test.ts::a new phone waits for the check code to be confirmed on the desktop and cannot act or reconnect until then`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: The owner's comparison of the two codes is a human step; the test compares them itself.
- Evidence: UNVERIFIED

<a id="mus-spec-23-7b"></a>
#### MUS-SPEC-23-7B: A taken code is reported, and the owner can reject the phone that took it

- Precondition: A desktop with pairing started; a first phone (the attacker) has used the code and waits for confirmation.
- Action: Pair a second phone with the same link; reject the pending phone on the desktop.
- Expected result: The second phone fails with a message saying the code was already used and to check the phone list on the computer. After Reject the first phone's connection closes, the device list is empty and pairing is no longer open.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a second phone using a taken code is told to check the desktop list, and the owner can reject the first`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-7c"></a>
#### MUS-SPEC-23-7C: The pairing code never leaves the desktop's QR panel

- Precondition: A desktop with pairing started.
- Action: Read mobile.status, then mobile.pair.link.
- Expected result: The serialized status contains neither the link nor the base64 code and has an expiry; mobile.pair.link returns the link that holds the code.
- Test: `packages/agent-app/tests/mobile-326.test.ts::mobile.status never carries the pairing link or code`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: None known.
- Evidence: UNVERIFIED

### Keys that cannot be read, and reset (security review)

<a id="mus-spec-23-8a"></a>
#### MUS-SPEC-23-8A: An unreadable phone key is refused, never replaced; Reset rotates it

- Precondition: A desktop with a paired phone, then a secret store that can no longer decrypt.
- Action: Start pairing; then call mobile.reset; start pairing again; reconnect the old phone.
- Expected result: Pairing fails saying the key can't be read and to use Reset phone access; the stored key entry is byte-for-byte unchanged. After reset the device list is empty, a new pairing link has a different route and desktop key, and the old phone can no longer reach the desktop.
- Test: `packages/agent-app/tests/mobile-326.test.ts::an unreadable phone key is refused, never replaced, and Reset phone access rotates it`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-8b"></a>
#### MUS-SPEC-23-8B: Reset phone access asks first

- Precondition: The Phone panel with one paired phone.
- Action: Press Reset phone access, then Reset now.
- Expected result: The first press only asks (no call); Reset now calls mobile.reset and the phone list is empty.
- Test: `packages/agent-app/tests/mobile-settings-326-dom.tsx::Reset phone access asks first, then rotates the keys`
- Environment: DOM suite (linkedom) with a stubbed window.muster bridge; no runtime.
- Known gaps: None known.
- Evidence: UNVERIFIED

### Close codes and reconnecting (security review)

<a id="mus-spec-23-9a"></a>
#### MUS-SPEC-23-9A: Only an unknown phone key closes as revoked

- Precondition: A desktop with one paired phone.
- Action: Connect with the phone's record but the wrong desktop key; connect with a key pair that was never paired.
- Expected result: The first fails with closed, not revoked; the second fails with revoked.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a first message that does not decrypt closes with 4400, and only an unknown key closes with 4403`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-9b"></a>
#### MUS-SPEC-23-9B: The phone retries after a bad-frame close and shows revoked only on 4403

- Precondition: connectPhone over a fake socket that the far end closes with a given code.
- Action: Close with 4400, then with 4403; also feed a live connection's close reasons.
- Expected result: 4400 and a bad-frame close lead to retry; 4403 and the revoked reason lead to revoked.
- Test: `packages/mobile/tests/reconnect.test.ts::a 4400 close retries and only 4403 shows the phone as revoked`
- Environment: jest (jest-expo preset) in Node with @testing-library/react-native.
- Known gaps: The provider's timers and AppState handling are not rendered; the policy function they call is tested.
- Evidence: UNVERIFIED

### Hardening (security review)

<a id="mus-spec-23-10a"></a>
#### MUS-SPEC-23-10A: A phone counts as connected only after a valid encrypted message

- Precondition: A paired phone, disconnected.
- Action: Run only the session handshake by hand; read mobile.status; send a hello request; read mobile.status.
- Expected result: After the handshake connected is false and last-seen is the earlier value; after hello it is connected with a newer last-seen.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a phone counts as connected only after its first valid encrypted message`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-10b"></a>
#### MUS-SPEC-23-10B: Stalled handshakes time out, pending connections are capped, wrong codes do not end the pairing

- Precondition: A desktop with pairing started; test seams shorten the handshake timeout and lower the pending cap.
- Action: Open a phone connection that sends nothing; open more silent connections than the cap; try six wrong codes, then the right one.
- Expected result: The silent connection closes after the timeout; the one over the cap closes at once; each wrong code fails; the right code then pairs (pending) normally.
- Test: `packages/agent-app/tests/mobile-326.test.ts::stalled handshakes time out, pending connections are capped, and wrong codes do not end the pairing`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: The production values (10 s, 32 pending, 20 failed pairing attempts a minute) are not waited out.
- Evidence: UNVERIFIED

<a id="mus-spec-23-10c"></a>
#### MUS-SPEC-23-10C: Access is checked again right before a command runs

- Precondition: A bridge context whose snapshot read flips the phone to read-only, then one whose session has ended.
- Action: Send chat.send through the bridge in each case.
- Expected result: Both are refused (read-only, then closed) and the runtime's chat.send is never called.
- Test: `packages/agent-app/tests/mobile-326.test.ts::access and the session are checked again right before the runtime command runs`
- Environment: Node test runner; the shared modules are called directly.
- Known gaps: Calls the bridge directly; the race itself is simulated, not timed.
- Evidence: UNVERIFIED

<a id="mus-spec-23-10d"></a>
#### MUS-SPEC-23-10D: Oversized frames are refused before decrypting

- Precondition: Noise and the channel with a crypto wrapper that counts decryptions.
- Action: Read a 70,000-byte handshake message; open a 70,000-byte transport message.
- Expected result: Both throw and the decryption count stays 0.
- Test: `packages/agent-app/tests/mobile-326.test.ts::frames over 65,535 bytes are refused before decrypting`
- Environment: Node test runner; the shared modules are called directly.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-23-10e"></a>
#### MUS-SPEC-23-10E: The phone gets folder names, not full paths

- Precondition: Approval timeline items with an absolute working directory and absolute and relative file paths.
- Action: Map them to the phone's items.
- Expected result: cwd is the folder name; files inside the folder are relative; files outside are their base name; no mapped item contains the home path.
- Test: `packages/agent-app/tests/mobile-326.test.ts::the phone gets folder names and relative file paths, never full paths`
- Environment: Node test runner; the shared modules are called directly.
- Known gaps: Maps items directly; the end-to-end path is covered by 2C.
- Evidence: UNVERIFIED

<a id="mus-spec-23-10f"></a>
#### MUS-SPEC-23-10F: The relay closes unregistered and silent sockets and refuses oversized messages

- Precondition: The dev relay with a short register timeout and keep-alive interval (test seams), and a registered desktop.
- Action: Open a desktop connection and never register; open a raw WebSocket that never answers pings; from a phone connection send one message of 87,385 characters.
- Expected result: The unregistered desktop is closed with 4408; the silent socket is closed after a missed pong; the phone is closed with 1009 and the desktop never receives the oversized message.
- Test: `packages/agent-app/tests/mobile-326.test.ts::the relay closes unregistered and silent sockets and refuses oversized messages`
- Environment: Node test runner on the dev relay from packages/relay on 127.0.0.1; raw sockets for the silent peer.
- Known gaps: The production intervals (10 s to register, 25 s ping, 10 s pong) are not waited out.
- Evidence: UNVERIFIED

<a id="mus-spec-23-10g"></a>
#### MUS-SPEC-23-10G: The desktop's phone crypto works inside Electron

- Precondition: The Electron binary the app ships with; Electron's BoringSSL has no chacha20-poly1305 cipher in node:crypto.
- Action: In Electron's own Node (ELECTRON_RUN_AS_NODE), run an IKpsk1 pairing handshake between two parties using the desktop's nodeNoiseCrypto, then seal and open a transport frame.
- Expected result: The pairing request and welcome decrypt on the other side and the frame opens; nothing throws "Unknown cipher".
- Test: `packages/agent-app/tests/mobile-326.test.ts::the desktop pairing handshake and frames work inside Electron, not only in Node`
- Environment: Node test runner spawning the electron binary from node_modules with ELECTRON_RUN_AS_NODE=1.
- Known gaps: Runs the crypto in Electron's Node mode, not in the packaged app; a real phone pairing is checked by hand on a Samsung Galaxy S25 through Expo Go.
- Evidence: UNVERIFIED
