import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentService } from '../src/runtime/service.ts';
import type { ProviderAdapter } from '../src/runtime/provider.ts';

test('model selection is persisted, affects the next run, and rejects unavailable models', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-model-selection-'));
  const calls: string[] = [];
  const provider: ProviderAdapter = {
    info: () => [{ id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', models: [
      { id: 'claude/claude-fable-5', name: 'Fable' },
      { id: 'codex/gpt-5.6-terra', name: 'Terra' },
    ] }],
    run: async input => { calls.push(input.chat.model); return { status: 'completed', finalMessage: 'done' }; },
    stop: async () => true,
    dispose() {},
  };
  const service = createAgentService({ dataDir, provider, onEvent() {} });
  try {
    const chat = await service.invoke('chat.create', {});
    await service.invoke('chat.update', { id: chat.id, model: 'codex/gpt-5.6-terra' });
    assert.equal((await service.invoke('app.snapshot', undefined)).chats[0]?.model, 'codex/gpt-5.6-terra');
    await assert.rejects(service.invoke('chat.update', { id: chat.id, model: 'missing/model' }), /unavailable/);
    assert.equal((await service.invoke('app.snapshot', undefined)).chats[0]?.model, 'codex/gpt-5.6-terra');
    await service.invoke('chat.send', { id: chat.id, text: 'use selected model', requestId: randomUUID() });
    for (let i = 0; i < 100; i += 1) {
      if ((await service.invoke('app.snapshot', undefined)).chats[0]?.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.deepEqual(calls, ['codex/gpt-5.6-terra']);
    await service.dispose();
    const reopened = createAgentService({ dataDir, provider, onEvent() {} });
    try {
      assert.equal((await reopened.invoke('app.snapshot', undefined)).chats[0]?.model, 'codex/gpt-5.6-terra');
    } finally {
      await reopened.dispose();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('busy chats reject model changes before provider dispatch completes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-model-busy-'));
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const provider: ProviderAdapter = {
    info: () => [{ id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', models: [
      { id: 'claude/claude-fable-5', name: 'Fable' }, { id: 'codex/gpt-5.6-terra', name: 'Terra' },
    ] }],
    run: async input => { started(); await running; return { status: 'completed', finalMessage: 'done' }; },
    stop: async () => true,
    dispose() {},
  };
  const service = createAgentService({ dataDir, provider, onEvent() {} });
  try {
    const chat = await service.invoke('chat.create', {});
    await service.invoke('chat.send', { id: chat.id, text: 'busy', requestId: randomUUID() });
    await began;
    await assert.rejects(service.invoke('chat.update', { id: chat.id, model: 'codex/gpt-5.6-terra' }), /Stop this run/);
    release();
  } finally {
    release();
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});
