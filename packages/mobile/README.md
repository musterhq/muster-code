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
