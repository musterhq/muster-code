import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import {commandText, parseKillIntent, userProcessThreat, type UserProcessTarget} from '../src/runtime/user-process-guard.ts';

const dev: UserProcessTarget = {pgid: 4100, label: 'npm run dev', pids: [4101, 4102], ports: [5173], names: ['npm', 'node']};
const shell: UserProcessTarget = {pgid: 5200, label: 'terminal zsh', pgids: [5300], pids: [5301], ports: [3000], names: ['zsh', 'python3']};
const groups = [dev, shell];
const flagged = (command: unknown) => userProcessThreat(command, groups);

test('kill-type commands aimed at user processes are flagged', () => {
  for (const command of [
    'kill 4101', 'kill -9 4100', 'kill -TERM -- -4100', 'kill -s KILL 4102', 'sudo kill -9 4101',
    'kill -9 $(lsof -t -i:5173)', 'kill -9 `lsof -ti:5173`', 'kill $(lsof -t -iTCP:5173 -sTCP:LISTEN)', 'kill "$(lsof -t -i :5173)"',
    'lsof -ti:5173 | xargs kill', 'lsof -ti:5173 2>/dev/null | xargs -r kill -9', 'lsof -t -i tcp:3000 | xargs kill',
    'fuser -k 5173/tcp', 'fuser -k -n tcp 3000', 'npx kill-port 5173', 'npx -y kill-port 3000',
    'pkill node', 'pkill -9 -f "npm run dev"', 'killall node', 'killall -9 python3', 'pkill -g 4100',
    'kill -9 $(pgrep -f "run dev")', 'pgrep node | xargs kill', 'kill -- -5300',
    'cd app && kill 4101 && npm start', 'echo stopping; kill 4101', 'kill -9 -1',
  ]) assert.ok(flagged(command), `expected a threat for: ${command}`);
  assert.ok(flagged(['/bin/zsh', '-lc', 'lsof -ti:5173 | xargs kill -9']), 'argv form');
  assert.ok(flagged(['kill', '-9', '4101']), 'plain argv');
  assert.ok(flagged('bash -c "kill 4101"'), 'nested shell');
});

test('unrelated and harmless commands are allowed', () => {
  for (const command of [
    'kill 999', 'kill -9 12345', 'kill $$', 'kill $(cat .agent.pid)', 'kill %1', 'kill -l',
    'lsof -i:5173', 'lsof -ti:5173; kill 999', 'lsof -ti:8080 | xargs kill', 'fuser 5173/tcp', 'fuser -k 8080/tcp',
    'pkill -f vitest-worker', 'killall ruby', 'npx kill-port 8080', 'npm run dev', 'echo "kill 4101"', "grep -r 'kill 4101' src",
    'git commit -m "skill"', 'ls', '',
  ]) assert.equal(flagged(command), null, `expected no threat for: ${command}`);
  // Nothing user-owned: nothing to protect.
  assert.equal(userProcessThreat('kill 4101', []), null);
  // Killing the agent's own server is fine even with a user dev server running.
  assert.equal(userProcessThreat('lsof -ti:8080 | xargs kill -9', [dev]), null);
});

test('the threat names the user process and its port', () => {
  assert.equal(flagged('lsof -ti:5173 | xargs kill')!.message, 'This would stop your dev server (npm run dev, port 5173), which you started in Muster.');
  assert.match(flagged('kill -- -5300')!.message, /^This would stop your terminal \(zsh, port 3000\)/);
  const both = flagged('kill 4101 5301')!;
  assert.deepEqual(both.groups.map(group => group.pgid), [4100, 5200]);
  assert.match(both.message, /and 1 more of your process,/);
  assert.equal(parseKillIntent('npm test'), null);
  assert.deepEqual(parseKillIntent('kill -9 4101')!.pids, [4101]);
  assert.equal(commandText(['/bin/zsh', '-lc', 'kill 1']), 'kill 1');
});

const info: ProviderAdapter['info'] = () => [{id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', models: []}];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('Full access auto-accepts ordinary commands but holds a kill of the user dev server for approval', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-guard-'));
  const answers: unknown[] = [];
  let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  const provider: ProviderAdapter = {info, run: async input => {
    answers.push(await input.onRequest('item/commandExecution/requestApproval', {command: ['/bin/zsh', '-lc', 'npm run build']}));
    answers.push(await input.onRequest('item/fileChange/requestApproval', {changes: []}));
    answers.push(await input.onRequest('item/commandExecution/requestApproval', {command: ['/bin/zsh', '-lc', 'lsof -ti:5173 | xargs kill -9']}));
    finish(); return {status: 'completed', finalMessage: 'done'};
  }, stop: async () => true, dispose() {}};
  const service = createAgentService({dataDir, provider, onEvent() {}, userProcesses: () => [{pgid: 4100, label: 'npm run dev', chatId: 'x'}], userProcessTargets: async () => [{...dev, chatId: 'x'} as UserProcessTarget]});
  try {
    const chat = await service.invoke('chat.create', {});
    await service.invoke('chat.setPermissionMode', {id: chat.id, permissionMode: 'full', acknowledgeFullAccess: true});
    await service.invoke('chat.send', {id: chat.id, text: 'restart things', requestId: randomUUID()});
    let card;
    for (let i = 0; i < 50 && !card; i++) { await flush(); card = (await service.invoke('chat.select', {id: chat.id})).find(item => item.kind === 'approval' && item.status === 'pending'); }
    assert.ok(card, 'the kill became an approval card');
    assert.deepEqual(answers, [{decision: 'accept'}, {decision: 'accept'}]);
    assert.equal(card.data?.reason, 'This would stop your dev server (npm run dev, port 5173), which you started in Muster.');
    assert.equal(card.data?.protectsUserProcess, true);
    // "Approve for this session" is never forwarded for a protected command.
    await service.invoke('approval.respond', {id: card.id, approved: true, decision: 'acceptForSession'});
    await done;
    assert.deepEqual(answers[2], {decision: 'accept'});
  } finally { await service.dispose(); await rm(dataDir, {recursive: true, force: true}); }
});

test('Workspace access names the user process on the card; unrelated commands keep the plain card', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-guard-'));
  const answers: unknown[] = [];
  let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  const provider: ProviderAdapter = {info, run: async input => {
    answers.push(await input.onRequest('item/commandExecution/requestApproval', {command: 'pkill -f "npm run dev"'}));
    finish(); return {status: 'completed', finalMessage: 'done'};
  }, stop: async () => true, dispose() {}};
  const service = createAgentService({dataDir, provider, onEvent() {}, userProcesses: () => [{pgid: 4100, label: 'npm run dev', chatId: 'x'}]});
  try {
    const chat = await service.invoke('chat.create', {});
    await service.invoke('chat.send', {id: chat.id, text: 'stop it', requestId: randomUUID()});
    let card;
    for (let i = 0; i < 50 && !card; i++) { await flush(); card = (await service.invoke('chat.select', {id: chat.id})).find(item => item.kind === 'approval' && item.status === 'pending'); }
    assert.ok(card);
    assert.equal(card.data?.reason, 'This would stop your dev server (npm run dev), which you started in Muster.');
    await service.invoke('approval.respond', {id: card.id, approved: false, decision: 'decline'});
    await done;
    assert.deepEqual(answers, [{decision: 'decline'}]);
  } finally { await service.dispose(); await rm(dataDir, {recursive: true, force: true}); }
});
