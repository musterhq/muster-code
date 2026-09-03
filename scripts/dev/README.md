# Dev harness scripts

All talk to a running Muster Code launched with `MUSTER_CODE_DEV_SOCK=/tmp/mc-dev.sock` (see docs/HANDOFF.md).

- `sock.py '{"cmd":...}'` — one dev-socket command (60 s timeout, output truncated to 300 chars); `sock2.py` — same with a 540 s timeout for `chat` turns. Both export `call(msg)` for use from Python.
- `mcp.py` — `Shim()` spawns the browser MCP shim exactly as Codex does (reads the launcher/socket from the latest Muster.log) and exposes `call(tool, args)`.
- `mcp-test.py` — the browser-tools regression: navigate, click, type+submit, select, hover, link click, back, reload, bad port, bad ref. Serve the test site first: `cd scripts/dev/site && python3 -m http.server 8765 --bind 127.0.0.1`.
- `site/` — the test page (`#btn` writes to `#out`, console log/warn/error on load, `data-source` on `.lead` for the picker).

Dev-socket commands: `state`, `text`, `pane` (state; `input` types into the composer and `probe` then reports the rendered menu rows, chips and marks — wait ~2 s, timers in an occluded window are throttled), `suggest` (kind/query → items + ms), `expand`, `threads`, `query`, `exec`, `chat` (text/mode/newTab/access/thread/build/buildModel), `event`.
