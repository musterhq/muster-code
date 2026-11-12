# Muster mobile app

See and steer the agents on your own computer from a phone (#326). Expo SDK 58, React Native 0.88, Expo Router. The design,
phases and threat model are in [docs/mobile/DESIGN.md](../../docs/mobile/DESIGN.md); acceptance cases in
[docs/spec/clauses/23-mobile.md](../../docs/spec/clauses/23-mobile.md).

The phone link (protocol, Noise handshake, encrypted channel, client) is shared with the desktop app and lives in
`packages/agent-app/src/shared/mobile`; `src/shared.ts` is the app's one import point for it.

```sh
pnpm install --ignore-workspace   # standalone project, its own lockfile
pnpm typecheck
pnpm test                         # jest-expo in Node: screens and crypto interop; no simulator
```

Phase 1 is tested in Node only. Next steps for real devices: EAS build profiles (development, preview, production), a
development build on a physical iPhone and Android phone paired through `packages/relay` (`npm start` there, then set its
address in Settings › Integrations › Phone on the computer), then TestFlight and Play internal testing.

## Test on an Android phone with the APK

CI builds a testing APK (release build signed with the debug keystore; not a store build) in the
[Mobile Android APK](../../.github/workflows/mobile-android-apk.yml) workflow, on pull requests that touch this package and
on demand (Actions › Mobile Android APK › Run workflow). Download the `muster-<sha>.apk` artifact from the run and install
it on the phone (allow installs from your browser or file manager, or `adb install -r muster-<sha>.apk`).

The phone needs a relay it can reach over `wss://`. To test from anywhere with a free tunnel (no account needed):

```sh
cd packages/relay && npm start                       # ws://127.0.0.1:7480, loopback only
cloudflared tunnel --url http://localhost:7480       # prints https://<random>.trycloudflare.com
```

1. On the computer, open Muster › Settings › Integrations › Phone and set the relay address to the tunnel's address with
   `wss://` in place of `https://` (for example `wss://<random>.trycloudflare.com`).
2. Press Pair a phone. In the app, scan the QR (or paste its link). The QR carries the relay address, so the app needs no
   relay setting of its own.
3. Both screens show a 6-digit check code. If they match, press Add phone on the computer.
4. The phone is read-only at first; switch it to Can act on the computer to send, steer or answer from it.

The quick tunnel's address changes each time `cloudflared` starts; set the new one in Settings and pair again.

