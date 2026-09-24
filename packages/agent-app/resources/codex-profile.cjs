const { readFileSync, existsSync, statSync } = require('node:fs');
const { join, delimiter, isAbsolute } = require('node:path');
const { homedir } = require('node:os');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

// Generic Codex route launcher. A route is either
//   * a profile file `<CODEX_HOME>/<name>.config.toml` naming its own `model_provider`, or
//   * a `[model_providers.<id>]` table the user already has in `<CODEX_HOME>/config.toml`
//     (selected with MUSTER_CODEX_PROVIDER; Codex reads that table itself).
// No provider id, endpoint, model list or helper path is assumed: everything comes from
// the user's own Codex configuration. Only configuration references are forwarded; inline
// credentials are never accepted, logged or copied, and Codex itself invokes any auth helper.

const PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROFILE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const OPENAI_MODEL = /^(?:gpt-[a-zA-Z0-9.-]+|o[1-9][a-zA-Z0-9.-]*)$/;
const PROVIDER_FIELDS = ['name', 'base_url', 'wire_api', 'env_key', 'env_key_instructions', 'query_params', 'env_http_headers',
  'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms', 'requires_openai_auth',
  'auth.command', 'auth.args', 'auth.timeout_ms', 'auth.refresh_interval_ms', 'auth.cwd'];
const AGENT_FIELDS = ['agents.default_subagent_model', 'agents.default_subagent_reasoning_effort', 'agents.max_concurrent_threads_per_session'];
/** Keys that would carry a credential inline. `env_key` / `env_http_headers` only name environment variables. */
const inlineSecret = key => { const last = key.split('.').pop(); return !/^env_/.test(last) && (/(?:^|_)(?:api_?key|key|token|secret|password|bearer|credentials?)$/i.test(last) || /^(?:http_)?headers$/i.test(last)); };

/** `a.b."c d"` → ['a','b','c d']; undefined when it is not a plain dotted key. */
function keyPath(raw) {
  const parts = []; const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y; let at = 0;
  while (at < raw.length) { pattern.lastIndex = at; const match = pattern.exec(raw); if (!match) return undefined; parts.push(match[1] ?? match[2] ?? match[3]); at = pattern.lastIndex; if (!match[4]) break; }
  return at >= raw.length && parts.length ? parts : undefined;
}
/** Net bracket depth of a TOML value fragment, ignoring brackets inside strings and comments. */
function depth(text) {
  let level = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\' && quote === '"') i++; else if (c === quote) quote = ''; continue; }
    if (c === '#') break;
    if (c === '"' || c === "'") quote = c; else if (c === '[' || c === '{') level++; else if (c === ']' || c === '}') level--;
  }
  return level;
}

/** Every `key = value` of a Codex TOML file as `dotted.path → raw value`. Multi-line values are only
 *  recorded (in `multiline`) so a caller can refuse them where it needs the value. */
function parseToml(text) {
  const values = new Map(), multiline = new Set(); let section = [], skip = 0, skipKey = '', triple = '';
  for (const line of text.split(/\r?\n/)) {
    if (triple) { if (line.includes(triple)) { triple = ''; multiline.add(skipKey); } continue; }
    if (skip > 0) { skip += depth(line); if (skip <= 0) { skip = 0; multiline.add(skipKey); } continue; }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const array = /^\[\[\s*(.+?)\s*\]\]\s*(?:#.*)?$/.exec(trimmed);
    if (array) { section = ['[[' + array[1] + ']]']; continue; }
    const table = /^\[\s*([^\[\]]+?)\s*\]\s*(?:#.*)?$/.exec(trimmed);
    if (table) { const path = keyPath(table[1]); if (!path) throw new Error('Unsupported multiline provider profile configuration.'); section = path; continue; }
    const eq = trimmed.indexOf('=');
    const key = eq > 0 ? keyPath(trimmed.slice(0, eq).trim()) : undefined;
    if (!key) throw new Error('Unsupported multiline provider profile configuration.');
    const full = [...section, ...key].join('.'), value = trimmed.slice(eq + 1).trim();
    const quotes = /^("""|''')/.exec(value)?.[1];
    if (quotes && !value.slice(3).includes(quotes)) { triple = quotes; skipKey = full; continue; }
    const open = depth(value);
    if (open > 0) { skip = open; skipKey = full; continue; }
    values.set(full, value.replace(/\s+#[^"']*$/, ''));
  }
  return { values, multiline };
}
const json = (values, key) => { if (!values.has(key)) return undefined; try { return JSON.parse(values.get(key)); } catch { throw new Error('Invalid provider profile configuration.'); } };

/** Model ids listed in a Codex model catalog file; undefined when it cannot be read. */
function catalogIds(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return undefined;
  try {
    if (statSync(path).size > 4 * 1024 * 1024) return undefined;
    const models = JSON.parse(readFileSync(path, 'utf8')).models;
    return Array.isArray(models) ? new Set(models.map(entry => entry && (entry.slug ?? entry.model ?? entry.id)).filter(id => typeof id === 'string')) : undefined;
  } catch { return undefined; }
}
/** OpenAI's own route runs OpenAI model ids; any other provider runs what its catalog lists (anything when no catalog is readable). */
const modelMatches = (provider, model, ids) => typeof model === 'string' && (provider === 'openai' ? OPENAI_MODEL.test(model) : !ids || ids.has(model));

/** Validated `-c key=value` overrides for a profile file. The profile names its provider; the file name
 *  `openai-direct` is reserved for OpenAI's own ChatGPT route. */
function profileOverrides(profile, text) {
  if (typeof profile !== 'string' || !PROFILE_NAME.test(profile)) throw new Error('Unsupported Muster provider profile.');
  const { values, multiline } = parseToml(text);
  for (const key of [...values.keys(), ...multiline]) if (inlineSecret(key)) throw new Error('Unsupported provider profile field; inline authentication is not accepted.');
  const provider = json(values, 'model_provider');
  if (typeof provider !== 'string' || !PROVIDER_ID.test(provider)) throw new Error('The profile must name its model_provider.');
  if (profile === 'openai-direct' && provider !== 'openai') throw new Error('Provider profile identity mismatch.');
  const table = `model_providers.${provider}.`;
  const allowed = new Set(['model_provider', 'model_catalog_json', ...AGENT_FIELDS, ...PROVIDER_FIELDS.map(field => table + field)]);
  for (const key of multiline) if (allowed.has(key)) throw new Error('Unsupported multiline provider profile configuration.');
  const catalog = json(values, 'model_catalog_json');
  if (catalog !== undefined && (typeof catalog !== 'string' || !catalog)) throw new Error('Invalid provider catalog path.');
  const executor = json(values, 'agents.default_subagent_model');
  if (executor !== undefined && !modelMatches(provider, executor, catalogIds(catalog))) throw new Error('Executor model does not match the selected provider.');
  if (values.has(table + 'auth.args') && !Array.isArray(json(values, table + 'auth.args'))) throw new Error('The provider auth.args must be an array.');
  // A per-session sub-agent cap in the profile is not forwarded: Muster imposes no
  // worker limit of its own, so Codex's own default applies (a cap of 1 made every
  // second worker fail as "Agent failed", F51).
  const forwarded = [...values].filter(([key]) => allowed.has(key) && key !== 'agents.max_concurrent_threads_per_session');
  const definesTable = forwarded.some(([key]) => key.startsWith(table));
  return forwarded.map(([key, value]) => key + '=' + value).concat(
    provider === 'openai' ? ['forced_login_method="chatgpt"']
      : definesTable && !values.has(table + 'requires_openai_auth') ? [table + 'requires_openai_auth=false'] : []);
}

/** Overrides for a provider table already defined in the user's config.toml. */
function providerOverrides(provider, catalog) {
  if (typeof provider !== 'string' || !PROVIDER_ID.test(provider)) throw new Error('Unsupported Muster provider.');
  if (catalog !== undefined && catalog !== '' && (typeof catalog !== 'string' || !isAbsolute(catalog))) throw new Error('Invalid provider catalog path.');
  return ['model_provider=' + JSON.stringify(provider), ...(catalog ? ['model_catalog_json=' + JSON.stringify(catalog)] : [])];
}

/** The Codex CLI: MUSTER_CODEX_COMMAND, else the first `codex` on PATH or in a standard install location. */
function codexCommand(env = process.env) {
  if (env.MUSTER_CODEX_COMMAND) return env.MUSTER_CODEX_COMMAND;
  const home = homedir();
  const dirs = [...(env.PATH || '').split(delimiter).filter(Boolean), join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global/bin'), join(home, '.bun/bin')];
  return dirs.map(dir => join(dir, 'codex')).find(file => isAbsolute(file) && existsSync(file));
}

function route(selection) {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  if (selection.profile) {
    let overrides;
    try { overrides = profileOverrides(selection.profile, readFileSync(join(home, selection.profile + '.config.toml'), 'utf8')); }
    catch { throw new Error('Cannot load validated ' + selection.profile + ' configuration. Check the profile and its helper; no provider fallback was attempted.'); }
    const provider = JSON.parse(overrides.find(value => value.startsWith('model_provider=')).slice('model_provider='.length));
    const catalog = overrides.find(value => value.startsWith('model_catalog_json='));
    return { provider, overrides, ids: catalogIds(catalog ? JSON.parse(catalog.slice('model_catalog_json='.length)) : undefined) };
  }
  const overrides = providerOverrides(selection.provider, selection.catalog);
  return { provider: selection.provider, overrides, ids: catalogIds(selection.catalog) };
}

function launch(selection, args) {
  const { provider, overrides, ids } = route(selection);
  if (args[0] !== 'app-server') throw new Error('Muster provider launcher only supports app-server.');
  let selectedModel;
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '-c' && args[i + 1].startsWith('model=')) {
    try { selectedModel = JSON.parse(args[i + 1].slice(6)); } catch { throw new Error('Invalid selected model.'); }
    if (!modelMatches(provider, selectedModel, ids)) throw new Error('Selected model does not match the provider.');
  }
  const command = codexCommand();
  if (!command || !existsSync(command)) throw new Error('Codex CLI not found. Install it, or set MUSTER_CODEX_COMMAND to its executable.');
  // Profile identity overrides win over CLI input, while MCP and approval
  // configuration remains intact. No --profile flag: app-server rejects it.
  const child = spawn(command, [...args, ...overrides.flatMap(value => ['-c', value])], { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  const resumes = new Map();
  const write = message => process.stdout.write(JSON.stringify(message) + '\n');
  const fail = (id, message) => write({ id, error: { code: -32000, message } });
  createInterface({ input: process.stdin }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      if (message.method === 'thread/resume') {
        const id = 'muster-provider-check-' + message.id;
        resumes.set(id, message);
        child.stdin.write(JSON.stringify({ id, method: 'thread/read', params: { threadId: message.params.threadId, includeTurns: false } }) + '\n');
        return;
      }
      pending.set(message.id, message.method);
      message.params = { ...message.params, modelProvider: provider, ...(selectedModel ? { model: selectedModel } : {}) };
    }
    child.stdin.write(JSON.stringify(message) + '\n');
  }).on('close', () => child.stdin.end());
  createInterface({ input: child.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (resumes.has(message.id)) {
      const resume = resumes.get(message.id); resumes.delete(message.id);
      const actual = message.result?.thread?.modelProvider;
      if (message.error || actual !== provider) { fail(resume.id, 'Cannot resume: task provider is unavailable or differs from the selection. No fallback was attempted.'); return; }
      resume.params = { ...resume.params, modelProvider: provider, ...(selectedModel ? { model: selectedModel } : {}) };
      pending.set(resume.id, resume.method);
      child.stdin.write(JSON.stringify(resume) + '\n'); return;
    }
    const method = pending.get(message.id);
    if (method) {
      pending.delete(message.id);
      // Core's legacy missing-thread fallback would replay in a new thread.
      if (message.error) { fail(message.id, 'Selected provider could not open this task. No replacement task or provider fallback was attempted.'); return; }
      const actual = message.result?.modelProvider ?? message.result?.thread?.modelProvider;
      if (actual && actual !== provider) { fail(message.id, 'Provider identity mismatch while opening task.'); return; }
    }
    write(message);
  });
  child.on('error', () => { process.stderr.write('Selected provider app-server failed to start.\n'); process.exitCode = 1; process.stdin.destroy(); });
  child.stdin.on('error', () => { process.stderr.write('Selected provider connection closed.\n'); child.kill(); });
  child.on('exit', code => { if (code) process.stderr.write('Selected provider app-server exited; check the profile, catalog and CLI configuration.\n'); process.exit(code ?? 1); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal); });
}

/** argv[2] names a profile (per-profile scripts); otherwise MUSTER_CODEX_PROFILE or MUSTER_CODEX_PROVIDER select the route. */
function selection(argv, env) {
  if (argv[2] && argv[2] !== 'app-server') return { selection: { profile: argv[2] }, args: argv.slice(3) };
  if (env.MUSTER_CODEX_PROFILE) return { selection: { profile: env.MUSTER_CODEX_PROFILE }, args: argv.slice(2) };
  if (env.MUSTER_CODEX_PROVIDER) return { selection: { provider: env.MUSTER_CODEX_PROVIDER, catalog: env.MUSTER_CODEX_CATALOG || undefined }, args: argv.slice(2) };
  throw new Error('No Codex route selected. Set MUSTER_CODEX_PROFILE or MUSTER_CODEX_PROVIDER.');
}

module.exports = { profileOverrides, providerOverrides, parseToml, codexCommand };
if (require.main === module) {
  try { const chosen = selection(process.argv, process.env); launch(chosen.selection, chosen.args); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
