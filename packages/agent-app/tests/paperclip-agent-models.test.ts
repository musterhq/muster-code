// #307: a server agent shows its own adapter and model, never Muster's default; the Work locally mapping says when the local model differs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mapAgent } from '../src/runtime/paperclip-map.ts';
import { mapAgentToLocal } from '../src/runtime/checkout/tiers.ts';
import { engineLabel, friendlyModel, MODEL_NOT_SHARED, runtimeName } from '../src/shared/agent-engine.ts';

// Real 2026.916 shapes: adapterConfig.env is redacted, the model stays in adapterConfig.model.
const row = (over: Record<string, unknown>) => ({ id: 'a1', companyId: 'c', name: 'Agent', role: 'engineer', status: 'idle', runtimeConfig: {}, ...over });
const REDACTED_ENV = { ANTHROPIC_API_KEY: { type: 'plain', value: '***REDACTED***' } };

test('each server agent keeps its own adapter and model', () => {
  const claude = mapAgent(row({ adapterType: 'claude_local', adapterConfig: { model: 'claude-opus-4-7', env: REDACTED_ENV } }));
  assert.deepEqual([claude.adapter, claude.model], ['claude_local', 'claude-opus-4-7']);
  const codex = mapAgent(row({ adapterType: 'codex_local', adapterConfig: { model: 'gpt-5.4-codex' } }));
  assert.deepEqual([codex.adapter, codex.model], ['codex_local', 'gpt-5.4-codex']);
  const hermes = mapAgent(row({ adapterType: 'hermes_local', adapterConfig: { model: 'hermes-4' } }));
  assert.equal(hermes.model, 'hermes-4');
  for (const adapterType of ['process', 'openclaw_gateway']) assert.equal(mapAgent(row({ adapterType, adapterConfig: { command: '/usr/bin/true' } })).model, null, `${adapterType} has no model`);
  assert.equal(mapAgent(row({ adapterType: 'claude_local', adapterConfig: { model: '  ' } })).model, null);
  assert.equal(JSON.stringify(claude).includes('REDACTED'), false, 'no env reaches the agent');
});

test('labels name the runtime and the model, and say when the server does not share one', () => {
  assert.equal(engineLabel('claude_local', 'claude-opus-4-7'), 'Claude Code · Opus 4.7');
  assert.equal(engineLabel('claude_local', 'claude-sonnet-4-5-20250929'), 'Claude Code · Sonnet 4.5');
  assert.equal(engineLabel('codex_local', 'gpt-5.4-codex'), 'Codex · gpt-5.4-codex');
  assert.equal(engineLabel('process', null), `Process · ${MODEL_NOT_SHARED}`);
  assert.equal(engineLabel('openclaw_gateway', undefined), `OpenClaw · ${MODEL_NOT_SHARED}`);
  assert.equal(runtimeName('hermes_local'), 'Hermes');
  assert.equal(runtimeName('some_new_local'), 'some new');
  assert.equal(friendlyModel(''), null);
  for (const l of [engineLabel('process', null), engineLabel('claude_local', null)]) assert.ok(!/terra/i.test(l), 'never Muster\'s default');
});

const prov = (id: string, name: string, models: [string, string][], available = true) => ({ id, name, available, models: models.map(([id, name]) => ({ id, name })) });
const HYBROW = prov('hybrow', 'Hybrow', [['terra', 'Terra'], ['luna', 'Luna']]);
const CLAUDE = prov('claude-code', 'Claude Code', [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]);

test('Work locally: the real model maps to the closest local model and the label says so', () => {
  const opus = mapAgentToLocal({ adapter: 'claude_local', model: 'claude-opus-4-7' }, [HYBROW, CLAUDE])!;
  assert.deepEqual([opus.providerId, opus.model], ['claude-code', 'opus']);
  assert.equal(opus.summary, 'Opus on server → Claude Code · Opus here');
  const exact = mapAgentToLocal({ adapter: 'claude_local', model: 'sonnet' }, [HYBROW, CLAUDE])!;
  assert.equal(exact.summary, 'Claude Code · Sonnet', 'same model: no arrow');
  assert.equal(exact.exact, true);
});

test('Work locally: a model that is not available here is said, not silently defaulted', () => {
  const codex = mapAgentToLocal({ adapter: 'codex_local', model: 'gpt-5.4-codex' }, [HYBROW, CLAUDE])!;
  assert.equal(codex.providerId, 'hybrow');
  assert.match(codex.summary, /^Codex is not set up here \(gpt-5\.4-codex on server\) → Hybrow · .+ here$/);
  const none = mapAgentToLocal({ adapter: 'process', model: null }, [HYBROW])!;
  assert.match(none.summary, /^No model on the server → Hybrow · Terra here$/);
  const unshared = mapAgentToLocal({ adapter: 'claude_local', model: null }, [HYBROW, CLAUDE])!;
  assert.equal(unshared.providerId, 'claude-code');
  assert.match(unshared.summary, /^Model not shared by the server → Claude Code · .+ here$/);
  assert.equal(mapAgentToLocal({ adapter: 'claude_local', model: 'x' }, [prov('c', 'C', [['m', 'm']], false)]), null);
});
