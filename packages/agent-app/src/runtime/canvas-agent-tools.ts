/**
 * The muster_canvas agent tool set (WRK-12): lets an agent-mode chat create, read and update the canvases bound to
 * it. Same shape as the sandbox tools (runtime/sandbox-agent-tools.ts): a 127.0.0.1 endpoint guarded by a bearer
 * token in a 0600 file, plus a stdio MCP server and launcher written at start that Codex spawns per chat.
 * A chat can only see and change its own canvases; the chat id comes from the per-chat server's environment.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { McpToolResult } from './sandbox-registry.ts';
import { sandboxLauncherScript, textResult } from './sandbox-agent-tools.ts';
import type { CanvasStore } from './canvases.ts';
import type { Canvas } from '../shared/domains/artifacts-protocol.ts';

export const CANVAS_MCP = 'muster_canvas';
const MAX_BODY = 3 * 1024 * 1024;
export const CANVAS_NOTE = `Canvases: when the user asks for a document, plan, snippet or page they will iterate on with you, put it in a canvas with the ${CANVAS_MCP} tools (canvas_create, then canvas_update) instead of pasting it into the reply. The user edits the same canvas; always canvas_read before canvas_update and pass base_version so you never overwrite their edits.`;

export const CANVAS_TOOL_SPECS = [
  { name: 'canvas_list', description: 'List the canvases in this chat (id, title, kind, version).', inputSchema: { type: 'object', properties: {} } },
  { name: 'canvas_read', description: 'Read a canvas: its current version number and full content.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'canvas_create', description: 'Create a canvas the user sees in the right pane and can edit. kind is markdown (default), code (set language) or html (previewed in a sandbox with scripts disabled).',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, kind: { type: 'string', enum: ['markdown', 'code', 'html'] }, language: { type: 'string' }, content: { type: 'string' } }, required: ['title', 'content'] } },
  { name: 'canvas_update', description: 'Replace a canvas\'s content (and optionally its title). Pass base_version from canvas_read; if the user changed it since, the update is refused and you get the current content to merge. Each update becomes a version the user can diff and restore.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' }, title: { type: 'string' }, base_version: { type: 'integer', minimum: 1 }, note: { type: 'string', description: 'Short summary of the change, shown in the version history' } }, required: ['id', 'content'] } },
] as const;
export const CANVAS_TOOL_NAMES = new Set<string>(CANVAS_TOOL_SPECS.map(spec => spec.name));

export interface CanvasToolTarget { store: CanvasStore; chatId: string; folderId?: string; changed(canvas: Canvas, created: boolean): void }
const str = (args: Record<string, unknown>, key: string): string | undefined => typeof args[key] === 'string' ? args[key] as string : undefined;
const describe = (canvas: Canvas) => `${canvas.id} · ${canvas.kind}${canvas.language ? ` (${canvas.language})` : ''} · version ${canvas.version} · ${canvas.title}`;

/** Runs one canvas tool call for a chat. Exported for tests. */
export function runCanvasTool(target: CanvasToolTarget, tool: string, input: unknown): McpToolResult {
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const own = (id: unknown): Canvas => {
    const canvas = target.store.get(id);
    if (canvas.chatId !== target.chatId) throw new Error('That canvas belongs to another chat.');
    return canvas;
  };
  try {
    switch (tool) {
      case 'canvas_list': {
        const canvases = target.store.list(target.chatId);
        return textResult(canvases.length ? canvases.map(canvas => `${canvas.id} · ${canvas.kind} · version ${canvas.version} · ${canvas.title}`).join('\n') : 'This chat has no canvases yet.');
      }
      case 'canvas_read': {
        const canvas = own(args.id);
        return textResult(`${describe(canvas)}\n---\n${canvas.content}`);
      }
      case 'canvas_create': {
        const canvas = target.store.create({ title: str(args, 'title'), kind: args.kind, language: args.language, content: str(args, 'content') ?? '', chatId: target.chatId, ...(target.folderId ? { folderId: target.folderId } : {}) }, 'agent');
        target.changed(canvas, true);
        return textResult(`Created canvas ${describe(canvas)}. The user now sees it in the right pane.`);
      }
      case 'canvas_update': {
        const current = own(args.id);
        if (typeof args.content !== 'string') return textResult('canvas_update needs string content.', true);
        const result = target.store.update(current.id, { content: args.content, ...(str(args, 'title') ? { title: str(args, 'title') } : {}), ...(args.base_version !== undefined ? { baseVersion: args.base_version } : {}), note: str(args, 'note') ?? 'Agent update' }, 'agent');
        if (result.conflict) return textResult(`Not updated: the canvas changed since version ${String(args.base_version)} (the user may have edited it). Merge your change into the current content and retry with base_version ${result.canvas.version}.\n---\n${result.canvas.content}`, true);
        if (result.canvas.version !== current.version) target.changed(result.canvas, false);
        return textResult(result.canvas.version === current.version ? `No change: canvas ${current.id} already has that content.` : `Updated canvas ${describe(result.canvas)}.`);
      }
      default: return textResult(`Unknown canvas tool ${tool}.`, true);
    }
  } catch (error) { return textResult(error instanceof Error ? error.message : String(error), true); }
}

/** The stdio MCP server, written as plain CommonJS at start so no build entry is needed. Tool specs are baked in. */
export function canvasMcpServerSource(): string {
  return `'use strict';
const fs=require('node:fs');
const TOOLS=${JSON.stringify(CANVAS_TOOL_SPECS)};
const endpointFile=process.argv[2],chatId=process.env.MUSTER_CHAT_ID||'';
const text=(t,isError)=>({content:[{type:'text',text:t}],...(isError?{isError:true}:{})});
async function call(tool,args){
  const {url,token}=JSON.parse(fs.readFileSync(endpointFile,'utf8'));
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({chatId,tool,arguments:args}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('canvas host answered '+response.status);
  return await response.json();
}
const write=line=>{process.stdout.write(line+'\\n');};
async function handle(message){
  const respond=body=>{if(message.id!==undefined&&message.id!==null)write(JSON.stringify({jsonrpc:'2.0',id:message.id,...body}));};
  switch(message.method){
    case 'initialize':respond({result:{protocolVersion:typeof (message.params||{}).protocolVersion==='string'?message.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'${CANVAS_MCP}',title:'Muster canvas',version:'1.0.0'},instructions:'Creates and updates canvases the user co-edits in Muster.'}});return;
    case 'ping':respond({result:{}});return;
    case 'tools/list':respond({result:{tools:TOOLS}});return;
    case 'tools/call':{const name=typeof (message.params||{}).name==='string'?message.params.name:'';let result;try{result=await call(name,(message.params||{}).arguments||{});}catch(error){result=text('Muster canvases are not reachable: '+(error&&error.message||String(error))+'. Is Muster still open?',true);}respond({result});return;}
    default:if(typeof message.method==='string'&&message.method.startsWith('notifications/'))return;respond({error:{code:-32601,message:'Method not found: '+String(message.method)}});
  }
}
let buffer='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;if(buffer.length>8*1024*1024)buffer='';let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;let message;try{message=JSON.parse(line);}catch{write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}));continue;}void handle(message);}});
process.stdin.on('end',()=>process.exit(0));
`;
}

export interface CanvasToolHostOptions { dir: string; execPath: string; resolve(chatId: string): CanvasToolTarget }
/** Local endpoint the per-chat canvas MCP servers post to. */
export class CanvasToolHost {
  readonly launcher: string;
  private server?: http.Server;
  private token = randomBytes(32);
  private disposed = false;
  constructor(private options: CanvasToolHostOptions) { this.launcher = path.join(options.dir, 'muster-canvas-mcp'); }
  async start(): Promise<string> {
    fs.mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    const server = http.createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    server.unref();
    const { port } = server.address() as { port: number };
    const endpoint = path.join(this.options.dir, 'canvas-endpoint.json'), script = path.join(this.options.dir, 'muster-canvas-mcp.cjs');
    fs.writeFileSync(endpoint, JSON.stringify({ url: `http://127.0.0.1:${port}/v1/call`, token: this.token.toString('hex') }), { mode: 0o600 });
    fs.chmodSync(endpoint, 0o600);
    fs.writeFileSync(script, canvasMcpServerSource(), { mode: 0o600 });
    fs.writeFileSync(this.launcher, sandboxLauncherScript(this.options.execPath, script, endpoint), { mode: 0o700 });
    fs.chmodSync(this.launcher, 0o700);
    return this.launcher;
  }
  private authorized(header: string | undefined): boolean {
    const presented = Buffer.from(/^Bearer ([a-f0-9]{64})$/.exec(header ?? '')?.[1] ?? '', 'hex');
    return presented.length === this.token.length && timingSafeEqual(presented, this.token);
  }
  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.method !== 'POST' || request.url !== '/v1/call' || !this.authorized(request.headers.authorization)) { reply(403, { error: 'Forbidden' }); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > MAX_BODY) { reply(413, { error: 'Too large' }); return; } chunks.push(chunk as Buffer); }
    let body: { chatId?: unknown; tool?: unknown; arguments?: unknown };
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, { error: 'Invalid JSON' }); return; }
    reply(200, this.call(body.chatId, body.tool, body.arguments));
  }
  call(chatId: unknown, tool: unknown, args: unknown): McpToolResult {
    if (this.disposed) return textResult('Muster is closing.', true);
    if (typeof chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(chatId)) return textResult('This canvas server was started without a chat.', true);
    if (typeof tool !== 'string' || !CANVAS_TOOL_NAMES.has(tool)) return textResult(`Unknown canvas tool ${String(tool)}.`, true);
    let target: CanvasToolTarget;
    try { target = this.options.resolve(chatId); } catch (error) { return textResult(error instanceof Error ? error.message : String(error), true); }
    return runCanvasTool(target, tool, args);
  }
  dispose(): void { this.disposed = true; this.server?.close(); this.server = undefined; }
}
