/**
 * Review follow-ups (a) and (b). A server that has a secret (bearer token or secret environment) must reach Codex as a
 * complete server definition in the per-thread config (a `mcp_servers.<k>.http_headers` entry alone is rejected by real
 * Codex: "invalid transport"), and no `-c` argument may ever carry a lent secret or a token again.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createMcpDomain } from '../src/runtime/domains/mcp.ts';
import { createDomainHooks } from '../src/runtime/domains/hooks.ts';
import { SecretStore } from '../src/runtime/secret-store.ts';
import { splitSecretOverrides } from '../src/runtime/thread-config.ts';
import type { DomainContext } from '../src/runtime/domains/types.ts';
import type { McpServer } from '../src/shared/domains/mcp-protocol.ts';
import type { Chat } from '../src/shared/protocol.ts';

const TOKEN = 'bearer_probe_ZZ_0123456789', ENVTOKEN = 'env_probe_YY_0123456789';

test('a server with a token reaches Codex as a whole definition in the thread config, and no -c argument carries the token', async t => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'muster-bearer-')), db = new DatabaseSync(':memory:');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  db.exec('CREATE TABLE extensions_installed (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const box = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (d: Buffer) => d.toString() };
  const store = new SecretStore(dataDir, () => box); t.after(() => store.close());
  const running = { id: 'c1', title: 'c', status: 'running', mode: 'agent', model: 'm', pinned: false, archived: false, draft: '', updatedAt: '' } as Chat;
  const registry = createDomainHooks();
  const ctx = { dataDir, db: () => db, hooks: registry.hooks, store: { snapshot: () => ({ folders: [], projects: [], chats: [running] }), folder: () => undefined, project: () => undefined }, invoke: async () => undefined } as unknown as DomainContext;
  const domain = createMcpDomain(ctx); t.after(() => domain.dispose?.());
  const call = <T>(name: string, input?: Record<string, unknown>) => domain.handlers[name]!(input ?? {}) as Promise<T>;
  const http = await call<McpServer>('mcp.servers.add', { name: 'probe', transport: 'http', url: 'http://127.0.0.1:1/mcp', auth: { kind: 'bearer', token: TOKEN } });
  const stdio = await call<McpServer>('mcp.servers.add', { name: 'tool', transport: 'stdio', command: process.execPath, args: [], env: { PLAIN: 'x' }, auth: { kind: 'env', name: 'API_TOKEN', token: ENVTOKEN } });
  const overrides = (await registry.resolveRunOptions(running)).configOverrides ?? {};
  const { args, threadConfig } = splitSecretOverrides(overrides);
  const argText = JSON.stringify(args);
  assert.ok(!argText.includes(TOKEN) && !argText.includes(ENVTOKEN), 'no -c argument carries a token');
  const servers = (threadConfig as { mcp_servers: Record<string, Record<string, unknown> & { http_headers?: Record<string, string>; env?: Record<string, string> }> }).mcp_servers;
  const h = servers[http.configKey]!, s = servers[stdio.configKey]!;
  assert.equal(h.url, 'http://127.0.0.1:1/mcp', 'the url travels with the header so the definition is valid on its own');
  assert.equal(h.http_headers?.Authorization, `Bearer ${TOKEN}`);
  assert.ok(typeof s.command === 'string' && s.command.length > 0, 'the command travels with the secret environment');
  assert.equal(s.env?.API_TOKEN, ENVTOKEN);
  assert.ok(!Object.keys(args).some(k => k.startsWith(`mcp_servers.${http.configKey}.`)), 'nothing of this server is left in the arguments to merge');
});

test('guard: the vendored Codex client still sends the thread config on start and resume', async () => {
  const src = await readFile(resolve(import.meta.dirname, '../vendor/muster-core/packages/core/src/codex-app-server.ts'), 'utf8');
  const sends = src.match(/\.\.\.\(this\.threadConfig \? \{ config: this\.threadConfig \} : \{\}\)/g) ?? [];
  assert.ok(sends.length >= 2, 'thread/start and thread/resume send `config`; a re-sync of the vendored core must keep this patch (see vendor/README.md)');
});
