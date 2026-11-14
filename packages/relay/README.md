# @muster/relay

The dev relay for the Muster phone link (#326). It forwards end-to-end encrypted frames between a paired phone and a desktop
and never holds keys or reads content. See [docs/mobile/DESIGN.md](../../docs/mobile/DESIGN.md) §2 and §8.

Development and tests only. Where the production relay runs (Muster-hosted, inside Muster Server, or both) is not decided yet.

```sh
npm start                      # ws://127.0.0.1:7480
MUSTER_RELAY_TLS_CERT=cert.pem MUSTER_RELAY_TLS_KEY=key.pem MUSTER_RELAY_HOST=0.0.0.0 npm start   # wss:// on the network
```

Without a certificate the relay listens on loopback only, to sit behind a TLS tunnel or proxy (for example
`cloudflared tunnel --url http://localhost:7480`, which gives a free `https://….trycloudflare.com` address; use it as
`wss://….trycloudflare.com`). It refuses plain `ws://` on any other address, and the desktop and phone refuse `ws://`
relay addresses off the local network. Every socket is pinged every 25 s and dropped after a missed pong; a desktop
that does not register within 10 s is closed; messages larger than one Noise message (87,384 base64 characters) are refused.

A desktop registers its route by signing a fresh challenge with its Ed25519 route key; the route id is the hash of that public
key, so the relay never holds anything that would let it, or someone watching a `ws://` link, register the route itself.

`startRelay({test: true})` is for tests only: it records every forwarded payload in `frames` and honours `intercept` (change,
drop or duplicate a payload). Without the flag both are inert. The workflow tests in
`packages/agent-app/tests/mobile-326.test.ts` start it in-process.
