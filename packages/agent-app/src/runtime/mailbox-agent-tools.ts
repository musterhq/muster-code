/**
 * The muster_mailbox agent tool set (SBX-12/SBX-17): a local HTTP endpoint that turns MCP tool calls into mailbox
 * commands sent as the calling chat, plus the stdio MCP server and launcher Codex spawns per chat. Same shape as the
 * sandbox and browser bridges: 127.0.0.1 only, bearer token in a 0600 file, one call at a time per chat.
 */
import {randomBytes, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type {McpToolResult} from './sandbox-registry.ts';
import {sandboxLauncherScript, textResult} from './sandbox-agent-tools.ts';

export const MAILBOX_MCP = 'muster_mailbox';
const MAX_BODY = 256 * 1024;
const TO = 'chat:<id>, project, task:<id>, agent:<subagent thread id> or user';
/** Kept terse: every schema below rides in each mailbox-enabled turn (see tests/context-budget.test.ts). */
export const MAILBOX_TOOL_SPECS = [
  {name: 'mailbox_send', description: `Send durable mail to another agent. to: ${TO}. request=true expects a reply before reply_within_minutes.`,
    inputSchema: {type: 'object', properties: {to: {type: 'string'}, body: {type: 'string'}, subject: {type: 'string'}, request: {type: 'boolean'}, reply_within_minutes: {type: 'number'}, expires_in_minutes: {type: 'number'}, idempotency_key: {type: 'string'}, wake: {type: 'boolean', description: 'Start a turn in an idle recipient chat'}}, required: ['to', 'body']}},
  {name: 'mailbox_reply', description: 'Reply to a message in your inbox (message_id like "#12").', inputSchema: {type: 'object', properties: {message_id: {type: 'string'}, body: {type: 'string'}, idempotency_key: {type: 'string'}}, required: ['message_id', 'body']}},
  {name: 'mailbox_ack', description: 'Acknowledge an inbox message once handled.', inputSchema: {type: 'object', properties: {message_id: {type: 'string'}}, required: ['message_id']}},
  {name: 'mailbox_inbox', description: 'List unacknowledged mail and who you can address; with message_id, the full message.', inputSchema: {type: 'object', properties: {message_id: {type: 'string'}}}},
] as const;
export const MAILBOX_TOOL_NAMES = new Set<string>(MAILBOX_TOOL_SPECS.map(spec => spec.name));
export type MailboxToolRunner = (chatId: string, tool: string, args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult;

/** The stdio MCP server, written as plain CommonJS at start so no build entry is needed. Tool specs are baked in. */
export function mailboxMcpServerSource(): string {
  return `'use strict';
const fs=require('node:fs');
const TOOLS=${JSON.stringify(MAILBOX_TOOL_SPECS)};
const endpointFile=process.argv[2],chatId=process.env.MUSTER_CHAT_ID||'';
const text=(t,isError)=>({content:[{type:'text',text:t}],...(isError?{isError:true}:{})});
async function call(tool,args){
  const {url,token}=JSON.parse(fs.readFileSync(endpointFile,'utf8'));
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({chatId,tool,arguments:args}),signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error('mailbox host answered '+response.status);
  return await response.json();
}
const write=line=>{process.stdout.write(line+'\\n');};
async function handle(message){
  const respond=body=>{if(message.id!==undefined&&message.id!==null)write(JSON.stringify({jsonrpc:'2.0',id:message.id,...body}));};
  switch(message.method){
    case 'initialize':respond({result:{protocolVersion:typeof (message.params||{}).protocolVersion==='string'?message.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'${MAILBOX_MCP}',title:'Muster mailbox',version:'1.0.0'},instructions:'Durable mail between this chat, other agents in its project, and the user.'}});return;
    case 'ping':respond({result:{}});return;
    case 'tools/list':respond({result:{tools:TOOLS}});return;
    case 'tools/call':{const name=typeof (message.params||{}).name==='string'?message.params.name:'';let result;try{result=await call(name,(message.params||{}).arguments||{});}catch(error){result=text('Muster’s mailbox is not reachable: '+(error&&error.message||String(error))+'. Is Muster still open?',true);}respond({result});return;}
    default:if(typeof message.method==='string'&&message.method.startsWith('notifications/'))return;respond({error:{code:-32601,message:'Method not found: '+String(message.method)}});
  }
}
let buffer='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;if(buffer.length>8*1024*1024)buffer='';let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;let message;try{message=JSON.parse(line);}catch{write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}));continue;}void handle(message);}});
process.stdin.on('end',()=>process.exit(0));
`;
}

/** Local endpoint the per-chat mailbox MCP servers post to. The chat id in the call is the sender identity. */
export class MailboxToolHost {
  readonly launcher: string;
  private server?: http.Server;
  private starting?: Promise<string>;
  private token = randomBytes(32);
  private queues = new Map<string, Promise<unknown>>();
  private disposed = false;
  constructor(private options: {dir: string; execPath: string; run: MailboxToolRunner}) { this.launcher = path.join(options.dir, 'muster-mailbox-mcp'); }
  start(): Promise<string> { return this.starting ??= this.listen(); }
  private async listen(): Promise<string> {
    fs.mkdirSync(this.options.dir, {recursive: true, mode: 0o700});
    const server = http.createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    server.unref();
    const {port} = server.address() as {port: number};
    const endpoint = path.join(this.options.dir, 'mailbox-endpoint.json'), script = path.join(this.options.dir, 'muster-mailbox-mcp.cjs');
    fs.writeFileSync(endpoint, JSON.stringify({url: `http://127.0.0.1:${port}/v1/call`, token: this.token.toString('hex')}), {mode: 0o600});
    fs.chmodSync(endpoint, 0o600);
    fs.writeFileSync(script, mailboxMcpServerSource(), {mode: 0o600});
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
  /** Calls for one chat run one at a time, so an idempotent retry never races its first attempt. */
  call(chatId: unknown, tool: unknown, args: unknown): Promise<McpToolResult> {
    if (typeof chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(chatId)) return Promise.resolve(textResult('This mailbox server was started without a chat.', true));
    if (typeof tool !== 'string' || !MAILBOX_TOOL_NAMES.has(tool)) return Promise.resolve(textResult(`Unknown mailbox tool ${String(tool)}.`, true));
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (this.disposed) return textResult('Muster is closing.', true);
      try { return await this.options.run(chatId, tool, input); } catch (error) { return textResult(error instanceof Error ? error.message : String(error), true); }
    });
    this.queues.set(chatId, next);
    void next.finally(() => { if (this.queues.get(chatId) === next) this.queues.delete(chatId); });
    return next;
  }
  dispose(): void { this.disposed = true; this.server?.close(); this.server = undefined; }
}
