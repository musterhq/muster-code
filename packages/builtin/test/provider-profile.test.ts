import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildSync } from "esbuild";

const { profileOverrides } = require("../resources/codex-profile.cjs");
const direct = 'model_provider="openai"\nmodel_catalog_json="/catalog.json"\n[agents]\ndefault_subagent_model="gpt-5.6-luna"\n';

test("profiles reject wrong provider, inline credentials, endpoint drift and malformed config", () => {
  assert.ok(profileOverrides("openai-direct", direct).includes('agents.default_subagent_model="gpt-5.6-luna"'));
  assert.ok(profileOverrides("openai-direct", direct).includes('forced_login_method="chatgpt"'));
  assert.throws(() => profileOverrides("openai-direct", direct.replace('"openai"', '"hybrow"')), /mismatch/);
  assert.throws(() => profileOverrides("hybrow-gateway", 'model_provider="hybrow"\nmodel_catalog_json="/catalog"\n[model_providers.hybrow]\nbase_url="https://invalid.example"\nwire_api="responses"'), /endpoint/);
  assert.throws(() => profileOverrides("openai-direct", direct + '\ninline_key="fixture-only"'), /inline authentication/);
  assert.throws(() => profileOverrides("openai-direct", direct + '\n['), /multiline/);
  assert.throws(() => profileOverrides("openai-direct", direct.replace('gpt-5.6-luna', 'codex/gpt-5.6-luna')), /Executor model/);
});

test("bundled routing resolves packaged executable resources at extension root", () => {
  const compiled = buildSync({ entryPoints: ["src/provider-routing.ts"], bundle: true, platform: "node", format: "cjs", write: false }).outputFiles[0]!.text;
  const module = { exports: {} as any }; new Function("require", "module", "exports", "__dirname", compiled)(require, module, module.exports, resolve("dist-ext"));
  const route = module.exports.routeForModelId("hybrow:codex/gpt-5.6-luna");
  assert.equal(route.command, resolve("dist-ext/resources/codex-hybrow-gateway.sh")); assert.ok(existsSync(route.command));
});

test("launcher verifies resume ownership and suppresses missing-thread fallback before dispatch", { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "muster-provider-test-"));
  const executable = join(directory, "fake-codex");
  writeFileSync(join(directory, "openai-direct.config.toml"), direct);
  writeFileSync(executable, `#!${process.execPath}\nconst {createInterface}=require('node:readline');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);let result={};let error;
if(m.method==='thread/read'){if(m.params.threadId==='missing')error={code:-1,message:'thread not found'};else result={thread:{modelProvider:m.params.threadId==='wrong'?'hybrow':'openai'}};}
if(m.method==='thread/resume'){if(m.params.threadId==='fails')error={code:-1,message:'thread not found'};else result={thread:{id:m.params.threadId,modelProvider:m.params.modelProvider},modelProvider:m.params.modelProvider,model:m.params.model};}
if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,...(error?{error}:{result})})+'\\n');});\n`, { mode: 0o755 });
  const child = spawn(resolve("resources/codex-openai-direct.sh"), ["app-server", "--stdio", "-c", 'model="gpt-5.5"'], { env: { ...process.env, CODEX_HOME: directory, MUSTER_CODEX_COMMAND: executable, MUSTER_PROVIDER_NODE: process.execPath }, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout }); let id = 0; const pending = new Map<number, (value: any) => void>();
  lines.on("line", line => { const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id); });
  const request = (threadId: string) => new Promise<any>(resolve => { const seq = ++id; pending.set(seq, resolve); child.stdin.write(JSON.stringify({ id: seq, method: "thread/resume", params: { threadId } }) + "\n"); });
  try {
    const correct = await request("correct"); assert.equal(correct.result.modelProvider, "openai"); assert.equal(correct.result.model, "gpt-5.5"); assert.equal(correct.result.thread.id, "correct");
    for (const thread of ["wrong", "missing", "fails"]) { const reply = await request(thread); assert.ok(reply.error, "resume must fail closed"); assert.doesNotMatch(reply.error.message, /thread not found|unknown thread|no such thread/i, "core must not attempt its missing-thread fallback"); }
  } finally { lines.close(); child.kill(); rmSync(directory, { recursive: true, force: true }); }
});
