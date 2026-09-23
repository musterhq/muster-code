const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const gatewayModels = new Set(['codex/gpt-5.6-terra', 'codex/gpt-5.6-luna', 'codex/gpt-5.6-sol', 'codex/gpt-6-astra', 'claude/claude-fable-5']);
const modelMatches = (provider, model) => provider === 'openai' ? /^(?:gpt-[a-zA-Z0-9.-]+|o[1-9][a-zA-Z0-9.-]*)$/.test(model) : gatewayModels.has(model);

// Only configuration references are forwarded. Inline credentials are never
// accepted, logged or copied; Codex itself invokes the existing auth helper.
function profileOverrides(profile, text) {
  const provider = profile === 'openai-direct' ? 'openai' : profile === 'hybrow-gateway' ? 'hybrow' : undefined;
  if (!provider) throw new Error('Unsupported Muster provider profile.');
  const allowed = new Set(['model_provider', 'model_catalog_json',
    'agents.default_subagent_model', 'agents.default_subagent_reasoning_effort', 'agents.max_concurrent_threads_per_session',
    ...['name', 'base_url', 'wire_api', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms',
      'auth.command', 'auth.args', 'auth.timeout_ms', 'auth.refresh_interval_ms'].map(k => 'model_providers.hybrow.' + k)]);
  const values = new Map(); let section = '';
  for (const line of text.split(/\r?\n/)) {
    const table = /^\s*\[([\w.]+)\]\s*(?:#.*)?$/.exec(line);
    if (table) { section = table[1]; continue; }
    const field = /^\s*([\w]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!field) { if (line.trim() && !line.trim().startsWith('#')) throw new Error('Unsupported multiline provider profile configuration.'); continue; }
    const key = section ? section + '.' + field[1] : field[1];
    if (allowed.has(key)) values.set(key, field[2]);
    else if (!['model', 'model_reasoning_effort'].includes(key)) throw new Error('Unsupported provider profile field; inline authentication is not accepted.');
  }
  const string = key => { try { return JSON.parse(values.get(key)); } catch { throw new Error('Invalid provider profile configuration.'); } };
  if (string('model_provider') !== provider) throw new Error('Provider profile identity mismatch.');
  if (typeof string('model_catalog_json') !== 'string') throw new Error('Provider catalog is required.');
  if (values.has('agents.default_subagent_model') && !modelMatches(provider, string('agents.default_subagent_model'))) throw new Error('Executor model does not match the selected provider.');
  if (provider === 'hybrow') {
    if (string('model_providers.hybrow.base_url') !== 'https://router.hybrowlabs.com/v1' || string('model_providers.hybrow.wire_api') !== 'responses') throw new Error('Hybrow requires the approved Responses endpoint.');
    if (!string('model_providers.hybrow.auth.command') || !Array.isArray(string('model_providers.hybrow.auth.args'))) throw new Error('Hybrow requires the existing authentication helper.');
  }
  // A per-session sub-agent cap in the profile is not forwarded: Muster imposes no
  // worker limit of its own, so Codex's own default applies (a cap of 1 made every
  // second worker fail as "Agent failed", F51).
  values.delete('agents.max_concurrent_threads_per_session');
  return [...values].map(([key, value]) => key + '=' + value).concat(provider === 'openai' ? ['forced_login_method="chatgpt"'] : ['model_providers.hybrow.requires_openai_auth=false']);
}

function launch(profile, args) {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  let overrides;
  try { overrides = profileOverrides(profile, readFileSync(join(home, profile + '.config.toml'), 'utf8')); }
  catch { throw new Error('Cannot load validated ' + profile + ' configuration. Check the existing profile and helper; no provider fallback was attempted.'); }
  if (args[0] !== 'app-server') throw new Error('Muster provider launcher only supports app-server.');
  const provider = profile === 'openai-direct' ? 'openai' : 'hybrow';
  let selectedModel;
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '-c' && args[i + 1].startsWith('model=')) {
    try { selectedModel = JSON.parse(args[i + 1].slice(6)); } catch { throw new Error('Invalid selected model.'); }
    if (!modelMatches(provider, selectedModel)) throw new Error('Selected model does not match the provider.');
  }
  const command = process.env.MUSTER_CODEX_COMMAND || join(homedir(), '.local/bin/codex');
  if (!existsSync(command)) throw new Error('Existing Codex CLI not found. Set MUSTER_CODEX_COMMAND to its executable.');
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

module.exports = { profileOverrides };
if (require.main === module) {
  try { launch(process.argv[2], process.argv.slice(3)); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
