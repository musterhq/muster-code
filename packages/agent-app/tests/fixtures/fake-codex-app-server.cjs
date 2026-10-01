// A tiny stand-in for `codex app-server --stdio`: answers the handshake, records its argv, environment and every request.
const fs = require('node:fs');
const log = process.env.FAKE_CODEX_LOG;
const note = line => fs.appendFileSync(log, JSON.stringify(line) + '\n');
note({ argv: process.argv.slice(2), secretEnv: process.env.LEAK_PROBE ?? null });
let buf = '';
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method) note({ method: m.method, params: m.params });
    const send = o => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
    if (m.id === undefined) continue;
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake/0', codexHome: '/tmp' } });
    else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'thr-1' } } });
    else if (m.method === 'turn/start') {
      send({ id: m.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed' } } }), 20);
    } else send({ id: m.id, result: {} });
  }
});
