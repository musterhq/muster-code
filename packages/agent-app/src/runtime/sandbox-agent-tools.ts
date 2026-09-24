/**
 * The muster_sandbox agent tool set (SBX-01 fallback, see domains/sandbox.ts): a local HTTP endpoint that turns MCP
 * tool calls into scoped-computer work, plus the stdio MCP server and launcher Codex spawns per chat. Mirrors the
 * browser bridge in main/agent-tools: 127.0.0.1 only, bearer token in a 0600 file, one call at a time per chat.
 */
import {randomBytes, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type {McpToolResult, SandboxAgentTarget} from './sandbox-registry.ts';

export const SANDBOX_MCP = 'muster_sandbox';
export const SANDBOX_EXEC_MAX_MS = 30 * 60_000;
const MAX_BODY = 4 * 1024 * 1024;
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
export const textResult = (text: string, isError = false): McpToolResult => ({content: [{type: 'text', text}], ...(isError ? {isError: true} : {})});

export const SANDBOX_TOOL_SPECS = [
  {name: 'sandbox_exec', description: 'Run a shell command inside this chat’s Linux container (sh -lc, cwd /workspace, unprivileged user, no network unless the user granted egress). Returns exit code, stdout and stderr. This is the only way to run commands; the host shell is read-only for this chat.',
    inputSchema: {type: 'object', properties: {command: {type: 'string', description: 'Shell command line'}, timeout_seconds: {type: 'integer', minimum: 1, maximum: SANDBOX_EXEC_MAX_MS / 1000, description: 'Default 600'}}, required: ['command']}},
  {name: 'sandbox_read', description: 'Read a UTF-8 text file from /workspace (path relative to /workspace).', inputSchema: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']}},
  {name: 'sandbox_write', description: 'Create or overwrite a file under /workspace with the given content (parent folders are created). Edits must go through this tool; the host folder is read-only for this chat.', inputSchema: {type: 'object', properties: {path: {type: 'string'}, content: {type: 'string'}}, required: ['path', 'content']}},
  {name: 'sandbox_list', description: 'List a folder under /workspace (path relative to /workspace; empty for the root).', inputSchema: {type: 'object', properties: {path: {type: 'string'}}}},
] as const;
export const SANDBOX_TOOL_NAMES = new Set<string>(SANDBOX_TOOL_SPECS.map(spec => spec.name));

const str = (args: Record<string, unknown>, key: string): string => typeof args[key] === 'string' ? args[key] as string : '';
/** Runs one tool call against a chat's sandbox. Exported for tests. */
export async function runSandboxTool(target: SandboxAgentTarget, tool: string, input: unknown): Promise<McpToolResult> {
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  try {
    switch (tool) {
      case 'sandbox_exec': {
        const command = str(args, 'command');
        if (!command.trim()) return textResult('sandbox_exec needs a command.', true);
        const seconds = typeof args.timeout_seconds === 'number' && Number.isFinite(args.timeout_seconds) ? Math.min(Math.max(1, Math.floor(args.timeout_seconds)), SANDBOX_EXEC_MAX_MS / 1000) : 600;
        const result = await target.exec(command, seconds * 1000);
        const parts = [`exit code: ${result.exitCode ?? 'none'} (${result.state})${result.reason ? ` — ${result.reason}` : ''}`];
        if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
        if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
        if (result.truncated) parts.push('[output truncated to the last 64 KiB]');
        return textResult(parts.join('\n'), result.state !== 'completed');
      }
      case 'sandbox_read': {
        const file = await target.read(str(args, 'path'));
        return textResult(file.truncated ? `${file.text}\n[truncated]` : file.text);
      }
      case 'sandbox_write': {
        if (typeof args.content !== 'string') return textResult('sandbox_write needs string content.', true);
        await target.write(str(args, 'path'), args.content);
        return textResult(`Wrote ${Buffer.byteLength(args.content)} bytes to /workspace/${str(args, 'path')}.`);
      }
      case 'sandbox_list': {
        const entries = await target.list(str(args, 'path'));
        return textResult(entries.length ? entries.map(entry => `${entry.kind === 'directory' ? 'd' : entry.kind === 'symlink' ? 'l' : '-'} ${String(entry.size).padStart(9)} ${entry.name}`).join('\n') : '(empty)');
      }
      default: return textResult(`Unknown sandbox tool ${tool}.`, true);
    }
  } catch (error) { return textResult(error instanceof Error ? error.message : String(error), true); }
}

/** Launcher script Codex runs as the MCP server (config overrides cannot carry an args array). */
export function sandboxLauncherScript(execPath: string, script: string, endpoint: string): string {
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} ${shellQuote(script)} ${shellQuote(endpoint)}\n`;
}
/** The stdio MCP server, written as plain CommonJS at start so no build entry is needed. Tool specs are baked in. */
export function sandboxMcpServerSource(): string {
  return `'use strict';
const fs=require('node:fs');
const TOOLS=${JSON.stringify(SANDBOX_TOOL_SPECS)};
const endpointFile=process.argv[2],chatId=process.env.MUSTER_CHAT_ID||'';
const text=(t,isError)=>({content:[{type:'text',text:t}],...(isError?{isError:true}:{})});
async function call(tool,args){
  const {url,token}=JSON.parse(fs.readFileSync(endpointFile,'utf8'));
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({chatId,tool,arguments:args}),signal:AbortSignal.timeout(${SANDBOX_EXEC_MAX_MS + 30_000})});
  if(!response.ok)throw new Error('sandbox host answered '+response.status);
  return await response.json();
}
const write=line=>{process.stdout.write(line+'\\n');};
async function handle(message){
  const respond=body=>{if(message.id!==undefined&&message.id!==null)write(JSON.stringify({jsonrpc:'2.0',id:message.id,...body}));};
  switch(message.method){
    case 'initialize':respond({result:{protocolVersion:typeof (message.params||{}).protocolVersion==='string'?message.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'${SANDBOX_MCP}',title:'Muster sandbox',version:'1.0.0'},instructions:'Runs commands and edits files inside this chat’s Linux container.'}});return;
    case 'ping':respond({result:{}});return;
    case 'tools/list':respond({result:{tools:TOOLS}});return;
    case 'tools/call':{const name=typeof (message.params||{}).name==='string'?message.params.name:'';let result;try{result=await call(name,(message.params||{}).arguments||{});}catch(error){result=text('Muster’s sandbox is not reachable: '+(error&&error.message||String(error))+'. Is Muster still open?',true);}respond({result});return;}
    default:if(typeof message.method==='string'&&message.method.startsWith('notifications/'))return;respond({error:{code:-32601,message:'Method not found: '+String(message.method)}});
  }
}
let buffer='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;if(buffer.length>8*1024*1024)buffer='';let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;let message;try{message=JSON.parse(line);}catch{write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}));continue;}void handle(message);}});
process.stdin.on('end',()=>process.exit(0));
`;
}

export interface SandboxToolHostOptions {dir: string; execPath: string; resolve(chatId: string): Promise<SandboxAgentTarget>}
/** Local endpoint the per-chat MCP servers post to. */
export class SandboxToolHost {
  readonly launcher: string;
  private server?: http.Server;
  private token = randomBytes(32);
  private queues = new Map<string, Promise<unknown>>();
  private disposed = false;
  constructor(private options: SandboxToolHostOptions) { this.launcher = path.join(options.dir, 'muster-sandbox-mcp'); }
  async start(): Promise<string> {
    fs.mkdirSync(this.options.dir, {recursive: true, mode: 0o700});
    const server = http.createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    const {port} = server.address() as {port: number};
    const endpoint = path.join(this.options.dir, 'sandbox-endpoint.json'), script = path.join(this.options.dir, 'muster-sandbox-mcp.cjs');
    fs.writeFileSync(endpoint, JSON.stringify({url: `http://127.0.0.1:${port}/v1/call`, token: this.token.toString('hex')}), {mode: 0o600});
    fs.chmodSync(endpoint, 0o600);
    fs.writeFileSync(script, sandboxMcpServerSource(), {mode: 0o600});
    fs.writeFileSync(this.launcher, sandboxLauncherScript(this.options.execPath, script, endpoint), {mode: 0o700});
    fs.chmodSync(this.launcher, 0o700);
    return this.launcher;
  }
  private authorized(header: string | undefined): boolean {
    const presented = Buffer.from(/^Bearer ([a-f0-9]{64})$/.exec(header ?? '')?.[1] ?? '', 'hex');
    return presented.length === this.token.length && timingSafeEqual(presented, this.token);
  }
  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => { response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(body)); };
    if (request.method !== 'POST' || request.url !== '/v1/call' || !this.authorized(request.headers.authorization)) { reply(403, {error: 'Forbidden'}); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > MAX_BODY) { reply(413, {error: 'Too large'}); return; } chunks.push(chunk as Buffer); }
    let body: {chatId?: unknown; tool?: unknown; arguments?: unknown};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, {error: 'Invalid JSON'}); return; }
    reply(200, await this.call(body.chatId, body.tool, body.arguments));
  }
  /** Calls for one chat run one at a time (the container takes one command at a time anyway). */
  call(chatId: unknown, tool: unknown, args: unknown): Promise<McpToolResult> {
    if (typeof chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(chatId)) return Promise.resolve(textResult('This sandbox server was started without a chat.', true));
    if (typeof tool !== 'string' || !SANDBOX_TOOL_NAMES.has(tool)) return Promise.resolve(textResult(`Unknown sandbox tool ${String(tool)}.`, true));
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (this.disposed) return textResult('Muster is closing.', true);
      let target: SandboxAgentTarget;
      try { target = await this.options.resolve(chatId); } catch (error) { return textResult(error instanceof Error ? error.message : String(error), true); }
      return runSandboxTool(target, tool, args);
    });
    this.queues.set(chatId, next);
    void next.finally(() => { if (this.queues.get(chatId) === next) this.queues.delete(chatId); });
    return next;
  }
  dispose(): void { this.disposed = true; this.server?.close(); this.server = undefined; }
}
