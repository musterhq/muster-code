import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentService } from '../src/runtime/service.ts';
import type { ProviderAdapter } from '../src/runtime/provider.ts';
import { AgentStore } from '../src/runtime/store.ts';

const waitForQuestion = async (service: ReturnType<typeof createAgentService>, chatId: string) => {
  for (let i = 0; i < 100; i += 1) {
    const item = (await service.invoke('chat.select', { id: chatId })).find(candidate => candidate.kind === 'question');
    if (item) return item;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Question did not arrive');
};

test('requestUserInput is rendered as a stable question and responds once with provider envelope', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-question-'));
  let providerAnswer: unknown;
  const provider: ProviderAdapter = {
    info: () => [{ id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', models: [] }],
    run: async input => {
      providerAnswer = await input.onRequest('item/tool/requestUserInput', { itemId: 'provider-question-1', questions: [{ id: 'choice', header: 'Direction', question: 'Which route?', options: [{ label: 'Ship', description: 'Continue' }, { label: 'Wait' }] }] });
      return { status: 'completed', finalMessage: 'done' };
    },
    stop: async () => true,
    dispose() {},
  };
  const service = createAgentService({ dataDir, provider, onEvent() {} });
  try {
    const chat = await service.invoke('chat.create', {});
    await service.invoke('chat.send', { id: chat.id, text: 'ask me', requestId: randomUUID() });
    const item = await waitForQuestion(service, chat.id);
    assert.equal(item.status, 'pending');
    assert.equal((item.data as { questions: unknown[] }).questions.length, 1);
    await service.invoke('question.respond', { id: item.id, answers: { choice: { answers: ['Ship'] } } });
    await assert.rejects(service.invoke('question.respond', { id: item.id, answers: { choice: { answers: ['Wait'] } } }), /no longer pending/);
    for (let i = 0; i < 100; i += 1) {
      if ((await service.invoke('app.snapshot', undefined)).chats[0]?.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.deepEqual(providerAnswer, { answers: { choice: { answers: ['Ship'] } } });
    assert.equal((await service.invoke('chat.select', { id: chat.id })).find(candidate => candidate.id === item.id)?.status, 'answered');
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('stop settles a pending question and restart does not restore it as active', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-question-stop-'));
  const provider: ProviderAdapter = {
    info: () => [{ id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', models: [] }],
    run: async input => { await input.onRequest('item/tool/requestUserInput', { itemId: 'provider-question-stop', questions: [{ id: 'answer', header: 'Answer', question: 'Continue?', options: [] }] }); return { status: 'completed', finalMessage: 'done' }; },
    stop: async () => true,
    dispose() {},
  };
  const service = createAgentService({ dataDir, provider, onEvent() {} });
  const chat = await service.invoke('chat.create', {});
  try {
    await service.invoke('chat.send', { id: chat.id, text: 'pause', requestId: randomUUID() });
    const item = await waitForQuestion(service, chat.id);
    await service.invoke('chat.stop', { id: chat.id });
    assert.equal((await service.invoke('chat.select', { id: chat.id })).find(candidate => candidate.id === item.id)?.status, 'interrupted');
    await service.dispose();
    const reopened = createAgentService({ dataDir, provider, onEvent() {} });
    try { assert.equal((await reopened.invoke('chat.select', { id: chat.id })).find(candidate => candidate.id === item.id)?.status, 'interrupted'); }
    finally { await reopened.dispose(); }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('question validation rejects duplicate IDs and empty answers without opening a request', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-question-validation-'));
  let validationPassed = false;
  const provider: ProviderAdapter = {
    info: () => [{ id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', models: [] }],
    run: async input => {
      await assert.rejects(input.onRequest('item/tool/requestUserInput', { itemId: 'duplicate', questions: [
        { id: 'same', header: 'One', question: 'First?', options: [] },
        { id: 'same', header: 'Two', question: 'Second?', options: [] },
      ] }), /unique/);
      validationPassed = true;
      return { status: 'completed', finalMessage: 'done' };
    },
    stop: async () => true,
    dispose() {},
  };
  const service = createAgentService({ dataDir, provider, onEvent() {} });
  try {
    const chat = await service.invoke('chat.create', {});
    await service.invoke('chat.send', { id: chat.id, text: 'validate', requestId: randomUUID() });
    for (let i = 0; i < 100 && !validationPassed; i += 1) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(validationPassed, true);
    assert.equal((await service.invoke('chat.select', { id: chat.id })).some(item => item.kind === 'question'), false);
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('actual wire flags preserve freeform secret input without persisting its value', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-question-wire-'));
  let providerAnswer: unknown;
  const provider: ProviderAdapter = {
    info: () => [{ id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', models: [] }],
    run: async input => {
      providerAnswer = await input.onRequest('item/tool/requestUserInput', { itemId: 'wire-secret', questions: [{ id: 'token', header: 'Token', question: 'Enter token', isOther: false, isSecret: true, options: null }] });
      return { status: 'completed', finalMessage: 'accepted' };
    },
    stop: async () => true,
    dispose() {},
  };
  const service = createAgentService({ dataDir, provider, onEvent() {} });
  try {
    const chat = await service.invoke('chat.create', {});
    await service.invoke('chat.send', { id: chat.id, text: 'secret', requestId: randomUUID() });
    const item = await waitForQuestion(service, chat.id);
    const question = ((item.data as { questions: Array<Record<string, unknown>> }).questions)[0];
    assert.equal(question.isSecret, true);
    assert.equal(question.isOther, false);
    assert.deepEqual(question.options, []);
    await service.invoke('question.respond', { id: item.id, answers: { token: { answers: ['  top-secret  '] } } });
    assert.deepEqual(providerAnswer, { answers: { token: { answers: ['  top-secret  '] } } });
    const answered = (await service.invoke('chat.select', { id: chat.id })).find(candidate => candidate.id === item.id)!;
    assert.deepEqual((answered.data as { answers: Record<string, {answers: string[]}> }).answers.token.answers, ['[redacted]']);
    await service.dispose();
    const reopened = createAgentService({ dataDir, provider, onEvent() {} });
    try {
      const restored = (await reopened.invoke('chat.select', { id: chat.id })).find(candidate => candidate.id === item.id)!;
      assert.deepEqual((restored.data as { answers: Record<string, {answers: string[]}> }).answers.token.answers, ['[redacted]']);
    } finally { await reopened.dispose(); }
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

const questionProvider = (answers: unknown[]): ProviderAdapter => ({
  info: () => [{ id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', models: [] }],
  run: async input => { answers.push(await input.onRequest('item/tool/requestUserInput', { itemId: `q-${answers.length}`, questions: [{ id: 'go', header: 'Go', question: 'Proceed?', options: [{ label: 'Yes' }] }] })); return { status: 'completed', finalMessage: 'done' }; },
  stop: async () => true,
  dispose() {},
});

test('dismiss sends the provider a cancel, never empty answers', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-question-dismiss-'));
  const answers: unknown[] = [];
  const service = createAgentService({ dataDir, provider: questionProvider(answers), onEvent() {} });
  try {
    const chat = await service.invoke('chat.create', {});
    await service.invoke('chat.send', { id: chat.id, text: 'ask', requestId: randomUUID() });
    const item = await waitForQuestion(service, chat.id);
    await service.invoke('question.dismiss', { id: item.id });
    for (let i = 0; i < 100 && !answers.length; i += 1) await new Promise(resolve => setTimeout(resolve, 2));
    const response = answers[0] as Record<string, unknown>;
    assert.equal('answers' in response, false);
    assert.equal(response.action, 'cancel');
    assert.equal((await service.invoke('chat.select', { id: chat.id })).find(candidate => candidate.id === item.id)?.status, 'dismissed');
    await assert.rejects(service.invoke('question.dismiss', { id: item.id }), /no longer pending/);
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('expiry sends a cancel and a restart keeps the question as expired with its reason', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-question-expiry-'));
  const answers: unknown[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = createAgentService({ dataDir, provider: questionProvider(answers), onEvent() {} });
  try {
    const chat = await service.invoke('chat.create', {});
    await service.invoke('chat.send', { id: chat.id, text: 'ask', requestId: randomUUID() });
    let item;
    for (let i = 0; i < 200 && !item; i += 1) { item = (await service.invoke('chat.select', { id: chat.id })).find(candidate => candidate.kind === 'question'); if (!item) await new Promise(resolve => setImmediate(resolve)); }
    assert.ok(item);
    t.mock.timers.tick(10 * 60_000);
    for (let i = 0; i < 200 && !answers.length; i += 1) await new Promise(resolve => setImmediate(resolve));
    assert.equal((answers[0] as Record<string, unknown>).action, 'cancel');
    assert.equal((await service.invoke('chat.select', { id: chat.id })).find(candidate => candidate.id === item.id)?.status, 'expired');
    t.mock.timers.reset();
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a question left open across a restart is restored as expired and cannot be answered', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-question-restart-'));
  const store = new AgentStore(dataDir);
  const chat = store.createChat({ model: 'claude/claude-fable-5', mode: 'agent' });
  const item = store.appendItem(chat.id, 'question', 'The provider needs your input.', 'pending', { method: 'item/tool/requestUserInput', questions: [] });
  store.close();
  const service = createAgentService({ dataDir, provider: questionProvider([]), onEvent() {} });
  try {
    const restored = (await service.invoke('chat.select', { id: chat.id })).find(candidate => candidate.id === item.id)!;
    assert.equal(restored.data?.expiredReason, 'restart');
    assert.notEqual(restored.status, 'pending');
    await assert.rejects(service.invoke('question.dismiss', { id: item.id }), /no longer pending/);
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});
