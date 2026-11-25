const assert = require('node:assert/strict');
const {mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {once} = require('node:events');
const {createServer} = require('node:http');
const {DatabaseSync} = require('node:sqlite');
const test = require('node:test');

// Spec: MUS-SPEC-18-899A (docs/spec/clauses/18-updates-release-and-packaging.md#mus-spec-18-899a)
test('new profiles count once through retries and updates', async t => {
  const root = mkdtempSync(join(tmpdir(), 'muster-installs-'));
  const db = join(root, 'installs.sqlite');
  const {default: worker} = await import('../../../services/install-counter/worker.mjs');
  const {reportFirstLaunch} = await import('../src/main/first-launch.ts');
  const schema = readFileSync(join(__dirname, '../../../services/install-counter/schema.sql'), 'utf8');
  function openDatabase() {
    const sql = new DatabaseSync(db);
    sql.exec(schema);
    return sql;
  }
  let sql = openDatabase();
  const total = () => sql.prepare('SELECT count(*) AS total FROM installs').get().total;
  const binding = {prepare: query => ({
    bind: digest => ({run: () => sql.prepare(query).run(new Uint8Array(digest))}),
  })};
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(new URL(req.url, 'http://localhost'), {
      method: req.method, headers: req.headers, body: Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, {DB: binding});
    res.writeHead(response.status).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    sql.close();
    rmSync(root, {recursive: true, force: true});
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/first-launch`;
  const launch = (profile, fetcher = fetch, disabled = false) => reportFirstLaunch({
    userData: join(root, profile), endpoint, disabled, fetcher,
  });
  mkdirSync(join(root, 'existing', 'agent-data'), {recursive: true});
  await launch('existing');
  await launch('opt-out', fetch, true);
  assert.equal(total(), 0);

  mkdirSync(join(root, 'damaged'));
  writeFileSync(join(root, 'damaged', 'install-count.pending'), 'unrelated file contents');
  let damagedRequests = 0;
  await launch('damaged', async () => { damagedRequests++; return new Response(null, {status: 400}); });
  assert.equal(damagedRequests, 0);

  let requests = 0;
  await launch('fresh', async (...args) => {
    assert.equal((await fetch(...args)).status, 204);
    requests++;
    throw new Error('response lost after commit');
  });
  assert.equal(requests, 1);
  assert.equal(total(), 1);
  mkdirSync(join(root, 'fresh', 'agent-data'));
  sql.close();
  sql = openDatabase();
  await launch('fresh', async (...args) => { requests++; return fetch(...args); });
  await launch('fresh', async (...args) => { requests++; return fetch(...args); });
  assert.equal(requests, 2);
  assert.equal(total(), 1);
  await launch('another');
  assert.equal(total(), 2);
});
