# @muster/relay

The dev relay for the Muster phone link (#326). It forwards end-to-end encrypted frames between a paired phone and a desktop
and never holds keys or reads content. See [docs/mobile/DESIGN.md](../../docs/mobile/DESIGN.md) §2 and §8.

Development and tests only. Where the production relay runs (Muster-hosted, inside Muster Server, or both) is not decided yet.

```sh
npm start                      # ws://127.0.0.1:7480
MUSTER_RELAY_HOST=0.0.0.0 npm start   # reachable from a phone on the same network
```

The workflow tests in `packages/agent-app/tests/mobile-326.test.ts` start it in-process.
