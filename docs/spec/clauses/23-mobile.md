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
| [MUS-SPEC-23-1A](23-mobile.md#mus-spec-23-1a) | A Pair a phone on the desktop returns a link; a phone pairing with it through the relay is listed by mobile.status as read-only and its first hello reports read-only. | [`a phone pairs with the QR link through the relay and is listed read-only`](../../../packages/agent-app/tests/mobile-326.test.ts) |
| [MUS-SPEC-23-1B](23-mobile.md#mus-spec-23-1b) | Reusing a used code, using an expired code and using a wrong code all fail, and none of them adds a device. | [`a pairing code works once, expires, and a wrong code stores nothing`](../../../packages/agent-app/tests/mobile-326.test.ts) |
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
| [MUS-SPEC-23-4A](23-mobile.md#mus-spec-23-4a) | Pairing and a session between the phone's noble crypto and the desktop's Node crypto succeed both ways. | [`the phone crypto pairs and talks with the desktop crypto`](../../../packages/mobile/tests/crypto-interop.test.ts) |
| [MUS-SPEC-23-4B](23-mobile.md#mus-spec-23-4b) | A pasted pairing link pairs and stores the record; a malformed link shows an error and stores nothing. | [`pairs from a pasted link and rejects a malformed one`](../../../packages/mobile/tests/pair-screen.test.tsx) |
| [MUS-SPEC-23-4C](23-mobile.md#mus-spec-23-4c) | Rows show the title, place and status; a chat waiting on the person shows a needs-you badge; a chats event updates the list. | [`lists chats with status and needs-you, and updates live`](../../../packages/mobile/tests/chats-screen.test.tsx) |
| [MUS-SPEC-23-4D](23-mobile.md#mus-spec-23-4d) | Item events grow the reply on screen; the composer sends when the chat is idle and steers while it runs. | [`streams a reply, sends when idle and steers while running`](../../../packages/mobile/tests/chat-screen.test.tsx) |
| [MUS-SPEC-23-4E](23-mobile.md#mus-spec-23-4e) | Approve and Decline on an approval card call approval.respond with accept or decline; a read-only phone shows the card without the buttons and says why. | [`approves or declines in place, and read-only hides the actions`](../../../packages/mobile/tests/chat-screen.test.tsx) |
| [MUS-SPEC-23-4F](23-mobile.md#mus-spec-23-4f) | The feed lists approvals and questions across chats; choosing an option on a question answers it from the feed. | [`the needs-you feed answers a question without opening the chat`](../../../packages/mobile/tests/needs-you-screen.test.tsx) |
| [MUS-SPEC-23-5A](23-mobile.md#mus-spec-23-5a) | Settings › Integrations › Phone shows a QR for the pairing link, lists a paired phone as read-only with an access switch, and Revoke removes it. | [`Phone settings show the pairing QR, list the phone read-only, and revoke it`](../../../packages/agent-app/tests/mobile-settings-326-dom.tsx) |

### Pairing, the device registry and access

<a id="mus-spec-23-1a"></a>
#### MUS-SPEC-23-1A: A phone pairs by the QR link and is listed read-only

- Precondition: Desktop runtime with secure storage and the relay address set; no phones paired.
- Action: Start pairing on the desktop (mobile.pair.start), then pair a Node phone with the returned link through the dev relay.
- Expected result: The link is a muster://pair link holding the relay, route, desktop key and a one-time code. The phone completes the handshake and learns the desktop name; mobile.status lists exactly one device with the phone's name and platform, access read-only and connected; the phone's hello says read-only; pairing is no longer open.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a phone pairs with the QR link through the relay and is listed read-only`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: Scanning the QR with a camera is not exercised; the phone is given the link text.
- Evidence: UNVERIFIED

<a id="mus-spec-23-1b"></a>
#### MUS-SPEC-23-1B: A pairing code works once, expires, and a wrong code stores nothing

- Precondition: A desktop with one pairing started.
- Action: Pair one phone; try a second phone with the same link; start a new pairing and try a phone with a changed code; start another pairing and let it pass its expiry (a short test expiry).
- Expected result: Only the first phone is paired. The reused link, the wrong code and the expired code each fail on the phone with a pairing error, and the device list still has exactly one phone.
- Test: `packages/agent-app/tests/mobile-326.test.ts::a pairing code works once, expires, and a wrong code stores nothing`
- Environment: Node test runner; the real agent service with a fake provider, the dev relay from packages/relay on 127.0.0.1, and a Node phone built from the same MobileClient and Noise code the app uses, with Node crypto.
- Known gaps: The 5-minute production expiry and the 5-wrong-tries limit are shortened or counted in the test, not waited out.
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
- Expected result: The malformed link shows "This is not a Muster pairing link" and nothing is stored. The valid link calls pairing with the parsed link, saves the record and the screen reports it is paired with the desktop name.
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
- Action: Press Pair a phone; the bridge then reports one paired phone; switch it to Can act; press Revoke and confirm.
- Expected result: A QR (an SVG of dark modules) and the pairing link show with the time it expires. The phone row shows its name and "Read only". Switching calls mobile.devices.setAccess with act. Revoke calls mobile.devices.revoke with its id and the row goes away.
- Test: `packages/agent-app/tests/mobile-settings-326-dom.tsx::Phone settings show the pairing QR, list the phone read-only, and revoke it`
- Environment: DOM suite (linkedom) with a stubbed window.muster bridge; no runtime.
- Known gaps: The QR is not decoded by a scanner in the test; its module count and finder patterns are checked instead. Screenshots come from the real component.
- Evidence: UNVERIFIED
