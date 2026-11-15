#!/usr/bin/env node
/**
 * #329: a stand-in for the `glab` CLI. `glab auth status --hostname H` succeeds only for hosts listed in FAKE_GLAB_HOSTS.
 * `glab api --hostname H --include --method M PATH [--input -]` forwards to FAKE_GLAB_API (the local fake GitLab) with an
 * `x-via: glab` header instead of a token, and prints the response the way `glab api --include` does: status line, headers,
 * blank line, body. Every invocation's argv is appended to FAKE_GLAB_LOG (one JSON line each).
 */
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_GLAB_LOG) fs.appendFileSync(process.env.FAKE_GLAB_LOG, `${JSON.stringify(args)}\n`);
const flag = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
// Exact host names, compared whole (a Set, never a substring match).
const hosts = new Set((process.env.FAKE_GLAB_HOSTS || '').split(',').filter(Boolean));
const host = flag('--hostname') || 'gitlab.com';

if (args[0] === 'auth' && args[1] === 'status') {
  if (hosts.has(host)) { process.stderr.write(`${host}\n  ✓ Logged in to ${host} as fake\n`); process.exit(0); }
  process.stderr.write(`${host}\n  x ${host}: api call failed: 401 Unauthorized\n`); process.exit(1);
}
if (args[0] === 'api') {
  if (!hosts.has(host)) { process.stderr.write('glab: 401 Unauthorized\n'); process.exit(1); }
  const method = flag('--method') || 'GET';
  const path = args.filter((arg, i) => i > 0 && !arg.startsWith('-') && !['--hostname', '--method', '--input', '-H', '--header'].includes(args[i - 1])).pop();
  const chunks = [];
  const go = async () => {
    const body = args.includes('--input') ? Buffer.concat(chunks).toString('utf8') : undefined;
    const response = await fetch(`${process.env.FAKE_GLAB_API}/gitlab/${host}/api/v4/${path}`, {method, headers: {'x-via': 'glab', ...(body ? {'content-type': 'application/json'} : {})}, ...(body ? {body} : {})});
    const text = await response.text();
    process.stdout.write(`HTTP/1.1 ${response.status} ${response.statusText}\r\nContent-Type: ${response.headers.get('content-type') || 'application/json'}\r\n\r\n${text}`);
    process.exit(response.status >= 200 && response.status < 300 ? 0 : 1);
  };
  if (args.includes('--input')) { process.stdin.on('data', chunk => chunks.push(chunk)); process.stdin.on('end', () => void go()); }
  else void go();
} else {
  process.stderr.write(`fake glab: unsupported ${args.join(' ')}\n`); process.exit(2);
}
