/**
 * A local MCP tool host for one named tool set (Wave 4, G40): a loopback HTTP endpoint that turns MCP tool calls from a
 * per-chat stdio server into calls on a runner, plus the stdio MCP server and launcher a provider spawns per chat.
 * Same shape as the mailbox, sandbox and browser bridges: 127.0.0.1 only, a bearer token in a 0600 file, and one call at a
 * time per chat. The chat id in the call is the caller's identity, bound to it by a per-chat HMAC (MUSTER_CHAT_TOKEN) that only the
 * run's own MCP process is given, so one chat's tools cannot speak as another chat. The runner decides what that chat may do.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launcherFile, nodeLauncherScript } from '../launcher-script.ts';
import type { McpToolResult } from '../sandbox-registry.ts';

export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export type ToolRunner = (chatId: string, tool: string, args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult;
const MAX_BODY = 256 * 1024, CALL_TIMEOUT_MS = 60_000;
export const toolText = (text: string, isError = false): McpToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/** The stdio MCP server as plain CommonJS, so no build entry is needed. The tool specs are baked in. */
export function mcpServerSource(name: string, title: string, specs: readonly ToolSpec[], timeoutMs = CALL_TIMEOUT_MS): string {
  return `'use strict';
const fs=require('node:fs');
const TOOLS=${JSON.stringify(specs)};
const endpointFile=process.argv[2],chatId=process.env.MUSTER_CHAT_ID||'',chatToken=process.env.MUSTER_CHAT_TOKEN||'';
const text=(t,isError)=>({content:[{type:'text',text:t}],...(isError?{isError:true}:{})});
async function call(tool,args){
  const {url,token}=JSON.parse(fs.readFileSync(endpointFile,'utf8'));
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token,'x-muster-chat-token':chatToken},body:JSON.stringify({chatId,tool,arguments:args}),signal:AbortSignal.timeout(${Math.max(1000, Math.floor(timeoutMs))})});
  if(!response.ok)throw new Error('Muster answered '+response.status);
  return await response.json();
}
const write=line=>{process.stdout.write(line+'\\n');};
async function handle(message){
  const respond=body=>{if(message.id!==undefined&&message.id!==null)write(JSON.stringify({jsonrpc:'2.0',id:message.id,...body}));};
  switch(message.method){
    case 'initialize':respond({result:{protocolVersion:typeof (message.params||{}).protocolVersion==='string'?message.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:${JSON.stringify(name)},title:${JSON.stringify(title)},version:'1.0.0'}}});return;
    case 'ping':respond({result:{}});return;
    case 'tools/list':respond({result:{tools:TOOLS}});return;
    case 'tools/call':{const n=typeof (message.params||{}).name==='string'?message.params.name:'';let result;try{result=await call(n,(message.params||{}).arguments||{});}catch(error){result=text('Muster is not reachable: '+(error&&error.message?error.message:String(error)),true);}respond({result});return;}
    default:if(typeof message.method==='string'&&message.method.startsWith('notifications/'))return;respond({error:{code:-32601,message:'Method not found: '+String(message.method)}});
  }
}
let buffer='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;if(buffer.length>8*1024*1024)buffer='';let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;let message;try{message=JSON.parse(line);}catch{continue;}void handle(message);}});
process.stdin.on('end',()=>process.exit(0));
`;
}

export class ToolHost {
  readonly launcher: string;
  readonly names: Set<string>;
  private server?: http.Server;
  private starting?: Promise<string>;
  private token = randomBytes(32);
  private queues = new Map<string, Promise<unknown>>();
  private disposed = false;
  constructor(private options: { dir: string; name: string; title: string; specs: readonly ToolSpec[]; execPath: string; run: ToolRunner; /** How long the MCP process waits for one call (default 60 s). Match the provider's tool timeout. */ timeoutMs?: number; /** Largest call body (default 256 KB). */ maxBody?: number }) {
    this.launcher = launcherFile(path.join(options.dir, `${options.name}-mcp`));
    this.names = new Set(options.specs.map(s => s.name));
  }
  start(): Promise<string> { return this.starting ??= this.listen(); }
  private async listen(): Promise<string> {
    const { dir, name } = this.options;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const server = http.createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    server.unref();
    const { port } = server.address() as { port: number };
    const endpoint = path.join(dir, `${name}-endpoint.json`), script = path.join(dir, `${name}-mcp.cjs`);
    fs.writeFileSync(endpoint, JSON.stringify({ url: `http://127.0.0.1:${port}/v1/call`, token: this.token.toString('hex') }), { mode: 0o600 });
    fs.chmodSync(endpoint, 0o600);
    fs.writeFileSync(script, mcpServerSource(name, this.options.title, this.options.specs, this.options.timeoutMs), { mode: 0o600 });
    fs.writeFileSync(this.launcher, nodeLauncherScript(this.options.execPath, script, endpoint), { mode: 0o700 });
    fs.chmodSync(this.launcher, 0o700);
    return this.launcher;
  }
  /** The value for the run's MUSTER_CHAT_TOKEN: an HMAC of the chat id under this host's secret. */
  chatToken(chatId: string): string { return createHmac('sha256', this.token).update(chatId).digest('hex'); }
  private boundTo(chatId: unknown, header: string | string[] | undefined): boolean {
    if (typeof chatId !== 'string' || typeof header !== 'string' || !/^[a-f0-9]{64}$/.test(header)) return false;
    const want = Buffer.from(this.chatToken(chatId), 'hex'), got = Buffer.from(header, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  }
  private authorized(header: string | undefined): boolean {
    const presented = Buffer.from(/^Bearer ([a-f0-9]{64})$/.exec(header ?? '')?.[1] ?? '', 'hex');
    return presented.length === this.token.length && timingSafeEqual(presented, this.token);
  }
  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.method !== 'POST' || request.url !== '/v1/call' || !this.authorized(request.headers.authorization)) { reply(403, { error: 'Forbidden' }); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > (this.options.maxBody ?? MAX_BODY)) { reply(413, { error: 'Too large' }); return; } chunks.push(chunk as Buffer); }
    let body: { chatId?: unknown; tool?: unknown; arguments?: unknown };
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, { error: 'Invalid JSON' }); return; }
    if (!this.boundTo(body.chatId, request.headers['x-muster-chat-token'])) { reply(403, { error: 'Forbidden' }); return; }
    reply(200, await this.call(body.chatId, body.tool, body.arguments));
  }
  /** Calls for one chat run one at a time, so a retry never races its first attempt. */
  call(chatId: unknown, tool: unknown, args: unknown): Promise<McpToolResult> {
    if (typeof chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(chatId)) return Promise.resolve(toolText('These tools were started without a chat.', true));
    if (typeof tool !== 'string' || !this.names.has(tool)) return Promise.resolve(toolText(`Unknown tool ${String(tool)}.`, true));
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (this.disposed) return toolText('Muster is closing.', true);
      try { return await this.options.run(chatId, tool, input); } catch (error) { return toolText(error instanceof Error ? error.message : String(error), true); }
    });
    this.queues.set(chatId, next);
    void next.finally(() => { if (this.queues.get(chatId) === next) this.queues.delete(chatId); });
    return next;
  }
  dispose(): void { this.disposed = true; this.server?.close(); this.server = undefined; }
}
