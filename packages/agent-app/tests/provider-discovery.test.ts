import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {authStage, diagnoseProvider, redactDiagnostics, stageForMessage} from '../src/runtime/provider-diagnostics.ts';
import {codexAccountEmail} from '../src/runtime/provider-discovery.ts';
import {parseRateLimits, recordProviderRateLimits, liveProviderUsage, sessionRateLimits} from '../src/runtime/provider-usage.ts';
import {mergeShellEnv, parseShellEnv, importLoginShellEnv} from '../src/runtime/login-shell-env.ts';

const jwt = (claims: object) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const NOW = Date.parse('2026-09-22T12:00:00Z');

test('auth.json maps to missing, expired and refreshable sign-in stages', () => {
  assert.equal(authStage(null, NOW, 'codex login').stage, 'auth-missing');
  assert.equal(authStage(null, NOW, 'codex login').command, 'codex login');
  assert.equal(authStage('{not json', NOW, 'codex login').stage, 'auth-missing');
  assert.equal(authStage(JSON.stringify({OPENAI_API_KEY: 'sk-x'}), NOW, 'codex login').stage, 'auth-missing', 'the direct route needs a ChatGPT sign-in');
  assert.equal(authStage(JSON.stringify({OPENAI_API_KEY: 'sk-x'}), NOW, 'codex login', false).stage, 'ok');
  const past = jwt({exp: NOW / 1000 - 3600}), future = jwt({exp: NOW / 1000 + 3600});
  const expired = authStage(JSON.stringify({tokens: {access_token: past, account_id: 'acct'}}), NOW, 'codex login');
  assert.equal(expired.stage, 'auth-expired'); assert.match(expired.hint!, /codex login/);
  assert.equal(authStage(JSON.stringify({tokens: {access_token: past, refresh_token: 'r', account_id: 'acct'}}), NOW, 'codex login').stage, 'ok', 'the CLI refreshes an expired access token itself');
  assert.equal(authStage(JSON.stringify({tokens: {access_token: future}}), NOW, 'codex login').stage, 'auth-missing', 'no account id');
  assert.equal(authStage(JSON.stringify({tokens: {access_token: future, account_id: 'acct'}}), NOW, 'codex login').stage, 'ok');
});

test('error text maps onto stages', () => {
  assert.equal(stageForMessage('The endpoint rejected the API key (HTTP 401). Paste a valid key and check again.'), 'auth-missing');
  assert.equal(stageForMessage('LOCAL_KEY is not available to Muster. Paste the key in Muster'), 'auth-missing');
  assert.equal(stageForMessage('The endpoint did not return a valid model catalog.'), 'catalog-unreadable');
  assert.equal(stageForMessage('Could not reach this endpoint. Check its URL and whether the service is running.'), 'transport');
  assert.equal(stageForMessage('Your session expired'), 'auth-expired');
});

test('diagnostics are redacted: no emails, tokens or home paths', () => {
  const out = redactDiagnostics('user a.b@example.com at /Users/me/.codex key sk-abcdefghijklmnop token eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz0123', '/Users/me');
  assert.ok(!out.includes('example.com')); assert.ok(!out.includes('/Users/me')); assert.ok(!out.includes('sk-abcdefghijklmnop')); assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9abc'));
  assert.match(out, /~\/\.codex/);
});

test('codex-family diagnosis stops at the first failing stage with a fix', async t => {
  const home = await mkdtemp(join(tmpdir(), 'muster-diag-')); t.after(() => rm(home, {recursive: true, force: true}));
  const directory = join(home, 'app'), codexHome = join(home, '.codex'), cli = join(home, 'bin', 'codex');
  await mkdir(join(directory, 'resources'), {recursive: true}); await mkdir(codexHome); await mkdir(join(home, 'bin'));
  const base = {name: 'OpenAI Direct', available: false, identityMasked: '', models: []};
  const env = {MUSTER_CODEX_COMMAND: cli, PATH: ''};
  const run = (id: string) => diagnoseProvider({...base, id}, {home, env, directory, now: () => NOW, version: async () => 'codex-cli 9.9.9', dataDir: home});
  let result = await run('openai-direct');
  assert.equal(result.stage, 'executable-missing'); assert.equal(result.version, null);
  await writeFile(cli, '#!/bin/sh\necho codex-cli\n'); await chmod(cli, 0o755);
  result = await run('openai-direct');
  assert.equal(result.stage, 'executable-missing'); assert.match(result.summary, /launcher/);
  await writeFile(join(directory, 'resources', 'codex-openai-direct.sh'), '#!/bin/sh\n'); await chmod(join(directory, 'resources', 'codex-openai-direct.sh'), 0o755);
  result = await run('openai-direct');
  assert.equal(result.stage, 'profile-invalid'); assert.equal(result.version, 'codex-cli 9.9.9');
  const catalog = join(home, 'models.json');
  await writeFile(join(directory, 'resources', 'codex-profile.cjs'), `exports.profileOverrides=(p,t)=>{if(!t.includes('ok'))throw new Error('bad profile');return ['model_catalog_json='+JSON.stringify(${JSON.stringify(catalog)})];};`);
  await writeFile(join(codexHome, 'openai-direct.config.toml'), 'ok = true\n');
  result = await run('openai-direct');
  assert.equal(result.stage, 'catalog-unreadable');
  await writeFile(catalog, JSON.stringify({models: [{slug: 'gpt-5'}]}));
  result = await run('openai-direct');
  assert.equal(result.stage, 'auth-missing'); assert.equal(result.command, 'codex login');
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({tokens: {access_token: jwt({exp: NOW / 1000 - 10}), account_id: 'acct', id_token: jwt({email: 'person@example.com'})}}));
  result = await run('openai-direct');
  assert.equal(result.stage, 'auth-expired');
  assert.ok(!result.diagnostics.includes(home), 'home is redacted'); assert.ok(!result.diagnostics.includes('person@example.com'));
  assert.equal(await codexAccountEmail(codexHome), 'person@example.com', 'reveal reads the account email from auth.json');
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({tokens: {access_token: jwt({exp: NOW / 1000 + 600}), account_id: 'acct'}}));
  result = await run('openai-direct');
  assert.equal(result.stage, 'ok'); assert.match(result.diagnostics, /stage: ok/);
  // The gateway authenticates upstream itself, so no local sign-in is required.
  await writeFile(join(directory, 'resources', 'codex-hybrow-gateway.sh'), '#!/bin/sh\n'); await chmod(join(directory, 'resources', 'codex-hybrow-gateway.sh'), 0o755);
  await writeFile(join(codexHome, 'hybrow-gateway.config.toml'), 'ok = true\n'); await rm(join(codexHome, 'auth.json'));
  assert.equal((await run('hybrow')).stage, 'ok');
});

test('custom endpoint and environment-key diagnosis', async () => {
  const custom = {id: 'custom_1', name: 'Local', available: false, identityMasked: '', models: [], custom: true, endpoint: 'http://127.0.0.1:1/v1', status: 'configured' as const};
  assert.equal((await diagnoseProvider(custom, {env: {}, home: '/nowhere', now: () => NOW})).stage, 'catalog-unreadable');
  assert.equal((await diagnoseProvider({...custom, detail: 'LOCAL_KEY is not set in Muster’s environment.'}, {env: {}, home: '/nowhere', now: () => NOW})).stage, 'auth-missing');
  const envKey = {id: 'env-openai', name: 'OpenAI', available: false, identityMasked: '', models: [], status: 'not-detected' as const};
  const result = await diagnoseProvider(envKey, {env: {}, home: '/nowhere', now: () => NOW});
  assert.equal(result.stage, 'auth-missing'); assert.match(result.hint!, /shell profile/);
});

test('rate limits normalize from app-server events and session logs', async t => {
  const live = parseRateLimits('openai-direct', {rateLimits: {primary: {usedPercent: 42.26, windowDurationMins: 300, resetsAt: NOW / 1000 + 600}, secondary: {usedPercent: 140, windowDurationMins: 10080}, planType: 'pro'}}, 'live', NOW)!;
  assert.equal(live.primary!.usedPercent, 42.3); assert.equal(live.primary!.windowMinutes, 300);
  assert.equal(live.primary!.resetsAt, new Date(NOW + 600_000).toISOString());
  assert.equal(live.secondary!.usedPercent, 100, 'clamped'); assert.equal(live.secondary!.resetsAt, null); assert.equal(live.planType, 'pro');
  assert.equal(parseRateLimits('x', {rateLimits: {primary: {usedPercent: 'lots'}}}, 'live'), undefined, 'malformed is not shown as 0%');
  assert.equal(recordProviderRateLimits('hybrow', 'item/started', {}), undefined);
  recordProviderRateLimits('hybrow', 'account/rateLimits/updated', {rateLimits: {primary: {usedPercent: 5, windowDurationMins: 300}}});
  assert.equal(liveProviderUsage('hybrow')?.primary?.usedPercent, 5);

  const root = await mkdtemp(join(tmpdir(), 'muster-usage-')); t.after(() => rm(root, {recursive: true, force: true}));
  const day = join(root, '2026', '09', '22'); await mkdir(day, {recursive: true});
  const line = (at: string, used: number) => JSON.stringify({timestamp: at, type: 'event_msg', payload: {type: 'token_count', rate_limits: {primary: {used_percent: used, window_minutes: 300, resets_in_seconds: 60}}}});
  const direct = join(day, 'rollout-a.jsonl'), gateway = join(day, 'rollout-b.jsonl');
  await writeFile(direct, [JSON.stringify({type: 'session_meta', payload: {model_provider: 'openai', instructions: 'x'.repeat(20_000)}}), line('2026-09-22T10:00:00Z', 10), line('2026-09-22T10:05:00Z', 12), '{"partial'].join('\n'));
  await writeFile(gateway, [JSON.stringify({type: 'session_meta', payload: {model_provider: 'hybrow'}}), line('2026-09-22T11:00:00Z', 70)].join('\n'));
  await utimes(direct, new Date(NOW - 5000), new Date(NOW - 5000));
  const found = sessionRateLimits(root);
  assert.equal(found.get('openai')?.primary?.usedPercent, 12, 'newest line wins, long session_meta is tolerated');
  assert.equal(found.get('openai')?.primary?.resetsAt, new Date(Date.parse('2026-09-22T10:05:00Z') + 60_000).toISOString());
  assert.equal(found.get('hybrow')?.source, 'session-log');
});

test('login shell environment fills gaps without overriding launcher values', async () => {
  const output = 'banner from zshrc\n__MUSTER_ENV_7f3a__A=1\0OPENAI_API_KEY=sk-shell\0PATH=/opt/homebrew/bin:/usr/bin\0SHLVL=2\0__MUSTER_ENV_7f3a__';
  const parsed = parseShellEnv(output);
  assert.equal(parsed.OPENAI_API_KEY, 'sk-shell'); assert.equal(parsed.SHLVL, undefined);
  const target: NodeJS.ProcessEnv = {A: 'keep', PATH: '/usr/bin:/bin'};
  const added = mergeShellEnv(target, parsed);
  assert.equal(target.A, 'keep'); assert.equal(target.OPENAI_API_KEY, 'sk-shell'); assert.equal(target.PATH, '/usr/bin:/bin:/opt/homebrew/bin');
  assert.deepEqual(added.sort(), ['OPENAI_API_KEY', 'PATH']);
  const env: NodeJS.ProcessEnv = {};
  const names = await importLoginShellEnv({shell: '/bin/zsh', env, run: (_file, args, options, done) => { assert.equal(options.timeout, 3000); assert.equal(args[0], '-ilc'); done(null, output); }});
  assert.ok(names.includes('OPENAI_API_KEY'));
  assert.deepEqual(await importLoginShellEnv({shell: '/bin/zsh', env: {}, run: (_f, _a, _o, done) => done(new Error('timed out'), '')}), []);
});
