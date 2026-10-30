/**
 * #772-#775, #789: the muster_office agent tools. An agent-mode chat uses them with Muster's own documents,
 * spreadsheets, presentations and PDF skills:
 *
 *  - office_setup  installs the office libraries on first use (docx, exceljs, pptxgenjs, pdf-lib, jszip, pdfjs-dist) and
 *                  answers with the command that runs a script with them importable from any folder.
 *  - office_render renders a .docx/.xlsx/.pptx/.pdf (and the older and OpenDocument formats) to page PNGs through
 *                  office-render.ts. The first render of an office file downloads LibreOffice when there is none; the
 *                  chat's tool row shows the progress while it runs. The answer lists the image paths and carries the
 *                  first pages as images, so the agent can look at them.
 *
 * Same shape as the canvas tools: a 127.0.0.1 endpoint guarded by a bearer token in a 0600 file, plus a stdio MCP
 * server and launcher written at start that the coding client spawns per chat with the chat id in its environment.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { sandboxLauncherScript } from './sandbox-agent-tools.ts';
import { launcherFile } from './launcher-script.ts';
import type { OfficeLibrariesProgress, OfficeLibrariesReady } from './office-libraries.ts';
import { describeVersions } from './office-libraries.ts';
import type { OfficeRuntimeProgress } from './office-runtime.ts';
import type { RenderOfficeResult } from './office-render.ts';

export const OFFICE_MCP = 'muster_office';
export const OFFICE_SKILL_NAMES = ['documents', 'spreadsheets', 'presentations', 'pdf'] as const;
const MAX_BODY = 64 * 1024;
/** Long enough for a first LibreOffice download on a slow line. */
export const OFFICE_TOOL_TIMEOUT_SEC = 1800;
const MAX_INLINE_PAGES = 8;
const KEEP_RENDERS_PER_CHAT = 12;

/** The turn note: which skill to read for each file type, and the tools. `skillsDir` holds Muster's own skills. */
export function officeNote(skillsDir: string): string {
  const skill = (name: string) => path.join(skillsDir, name, 'SKILL.md');
  return `Office files: for Word (.docx), Excel (.xlsx), PowerPoint (.pptx) or PDF work, first read Muster's skill for that type and follow it: documents ${skill('documents')}, spreadsheets ${skill('spreadsheets')}, presentations ${skill('presentations')}, pdf ${skill('pdf')}. They take precedence over any other documents, spreadsheets, presentations or PDF skill. Call ${OFFICE_MCP} office_setup once before writing a script (it answers with the command that runs scripts with docx, exceljs, pptxgenjs, pdf-lib, jszip and pdfjs-dist importable), and ${OFFICE_MCP} office_render to turn a file into page images you look at before you reply.`;
}

/** Finds the note in a run's instructions (its skill paths vary), for routes that do not offer these tools. */
export const OFFICE_NOTE_PATTERN = /Office files: for Word \(\.docx\)[^\n]*/;

export const OFFICE_TOOL_SPECS = [
  { name: 'office_setup', description: 'Make sure the office libraries (docx, exceljs, pptxgenjs, pdf-lib, jszip, pdfjs-dist) are installed, downloading them the first time. Answers with the command that runs a Node script with them importable (import or require) from any folder.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'office_render', description: 'Render a .docx, .xlsx, .pptx, .pdf (or .doc, .xls, .ppt, .odt, .ods, .odp) file to one PNG per page so you can check the layout. The first render of an office file may download LibreOffice (progress shows in the chat). Answers with the PDF and page image paths and shows the first pages.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'The file: absolute, or relative to the chat\'s working folder' },
      max_pages: { type: 'integer', minimum: 1, maximum: 50, description: 'Pages to render (default 20)' },
      inline_pages: { type: 'integer', minimum: 0, maximum: MAX_INLINE_PAGES, description: 'Pages to show as images in this answer (default 3); the rest are listed by path' },
    }, required: ['path'] } },
] as const;
export const OFFICE_TOOL_NAMES = new Set<string>(OFFICE_TOOL_SPECS.map(spec => spec.name));

export type OfficeToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };
export interface OfficeToolResult { content: OfficeToolContent[]; isError?: boolean }
const text = (value: string, isError = false): OfficeToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

export interface OfficeToolDeps {
  libraries: { ensure(onProgress?: (progress: OfficeLibrariesProgress) => void): Promise<OfficeLibrariesReady> };
  render(file: string, outDir: string, options: { maxPages: number; onProgress(progress: OfficeRuntimeProgress): void }): Promise<RenderOfficeResult>;
  /** <agent-data>/office-renders: page images go to <chat>/<file>-<time>/ under it. */
  rendersDir: string;
  /** The chat's working folder, for relative paths; undefined when the chat has none. */
  cwd(chatId: string): string | undefined;
  /** What the chat's running tool row shows while it waits (null clears it). */
  progress(chatId: string, message: string | null): void;
}

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
export function runtimeProgressText(progress: OfficeRuntimeProgress): string {
  if (progress.phase === 'downloading') return `Downloading LibreOffice for the first render… ${mb(progress.received)} of ${mb(progress.total)}${progress.total ? ` (${Math.floor(progress.received / progress.total * 100)}%)` : ''}`;
  if (progress.phase === 'verifying') return 'Checking the LibreOffice download…';
  return 'Installing LibreOffice…';
}
export function librariesProgressText(progress: OfficeLibrariesProgress): string {
  return progress.phase === 'downloading' ? `Downloading the office libraries… ${progress.done} of ${progress.total} packages` : 'Installing the office libraries…';
}

async function pruneRenders(dir: string): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  const folders = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const name of folders.slice(0, Math.max(0, folders.length - KEEP_RENDERS_PER_CHAT))) await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
}

/** Runs one office tool call for a chat. Exported for tests. */
export async function runOfficeTool(deps: OfficeToolDeps, chatId: string, tool: string, input: unknown): Promise<OfficeToolResult> {
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const int = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
  try {
    switch (tool) {
      case 'office_setup': {
        const ready = await deps.libraries.ensure(progress => deps.progress(chatId, librariesProgressText(progress)));
        return text([
          `Office libraries ready (${describeVersions(ready.versions)}).`,
          `Run scripts with: ${JSON.stringify(ready.node)} <script.mjs|script.cjs> [args]`,
          'import { Document, Packer } from "docx" and require("docx") both work from any folder with that command. Keep scripts and outputs in the working folder.',
          `Modules folder: ${ready.modules}`,
        ].join('\n'));
      }
      case 'office_render': {
        const raw = typeof args.path === 'string' ? args.path.trim() : '';
        if (!raw) return text('office_render needs a path.', true);
        const base = deps.cwd(chatId);
        if (!path.isAbsolute(raw) && !base) return text('Pass an absolute path: this chat has no working folder.', true);
        const file = path.resolve(base ?? '/', raw);
        const chatDir = path.join(deps.rendersDir, chatId);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outDir = path.join(chatDir, `${stamp}-${path.basename(file).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)}`);
        const result = await deps.render(file, outDir, { maxPages: int(args.max_pages, 20, 1, 50), onProgress: progress => deps.progress(chatId, runtimeProgressText(progress)) });
        void pruneRenders(chatDir);
        const inline = Math.min(result.pages.length, int(args.inline_pages, 3, 0, MAX_INLINE_PAGES));
        const lines = [
          `Rendered ${path.basename(file)}: ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}${result.pages.length < result.pageCount ? ` (first ${result.pages.length} rendered)` : ''}.`,
          `PDF: ${result.pdf}`,
          ...result.pages.map((page, index) => `Page ${index + 1}: ${page}`),
          inline === 0 ? 'Open the page images by path to look at them.' : inline < result.pages.length ? `Pages 1-${inline} are shown below; open the others by path to look at them.` : 'Every page is shown below.',
          'Check each page: text cut off or overflowing, overlapping shapes, wrong fonts, bad page or slide breaks, empty pages. Fix the script and render again until it is clean.',
        ];
        const images: OfficeToolContent[] = [];
        for (const page of result.pages.slice(0, inline)) images.push({ type: 'image', data: (await fs.promises.readFile(page)).toString('base64'), mimeType: 'image/png' });
        return { content: [{ type: 'text', text: lines.join('\n') }, ...images] };
      }
      default: return text(`Unknown office tool ${tool}.`, true);
    }
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  } finally {
    deps.progress(chatId, null);
  }
}

/** The stdio MCP server, written as plain CommonJS at start so no build entry is needed. Tool specs are baked in. */
export function officeMcpServerSource(): string {
  return `'use strict';
const fs=require('node:fs');
const TOOLS=${JSON.stringify(OFFICE_TOOL_SPECS)};
const endpointFile=process.argv[2],chatId=process.env.MUSTER_CHAT_ID||'';
const text=(t,isError)=>({content:[{type:'text',text:t}],...(isError?{isError:true}:{})});
// node:http, not fetch: fetch gives up waiting for response headers after five minutes, and a first LibreOffice
// download can take longer than that before the host answers.
const http=require('node:http');
function call(tool,args){
  const {url,token}=JSON.parse(fs.readFileSync(endpointFile,'utf8'));
  const body=JSON.stringify({chatId,tool,arguments:args});
  return new Promise((resolve,reject)=>{
    const request=http.request(url,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),authorization:'Bearer '+token}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>{if(response.statusCode!==200)return reject(new Error('office host answered '+response.statusCode));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){reject(error);}});
      response.on('error',reject);
    });
    request.setTimeout(${OFFICE_TOOL_TIMEOUT_SEC * 1000},()=>request.destroy(new Error('timed out')));
    request.on('error',reject);request.end(body);
  });
}
const write=line=>{process.stdout.write(line+'\\n');};
async function handle(message){
  const respond=body=>{if(message.id!==undefined&&message.id!==null)write(JSON.stringify({jsonrpc:'2.0',id:message.id,...body}));};
  switch(message.method){
    case 'initialize':respond({result:{protocolVersion:typeof (message.params||{}).protocolVersion==='string'?message.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'${OFFICE_MCP}',title:'Muster office files',version:'1.0.0'},instructions:'Installs the office libraries for scripts and renders Word, Excel, PowerPoint and PDF files to page images for review.'}});return;
    case 'ping':respond({result:{}});return;
    case 'tools/list':respond({result:{tools:TOOLS}});return;
    case 'tools/call':{const name=typeof (message.params||{}).name==='string'?message.params.name:'';let result;try{result=await call(name,(message.params||{}).arguments||{});}catch(error){result=text('Muster office tools are not reachable: '+(error&&error.message||String(error))+'. Is Muster still open?',true);}respond({result});return;}
    default:if(typeof message.method==='string'&&message.method.startsWith('notifications/'))return;respond({error:{code:-32601,message:'Method not found: '+String(message.method)}});
  }
}
let buffer='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;if(buffer.length>8*1024*1024)buffer='';let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;let message;try{message=JSON.parse(line);}catch{write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}));continue;}void handle(message);}});
process.stdin.on('end',()=>process.exit(0));
`;
}

export interface OfficeToolHostOptions { dir: string; execPath: string; deps: OfficeToolDeps; knownChat(chatId: string): boolean }
/** Local endpoint the per-chat office MCP servers post to. */
export class OfficeToolHost {
  readonly launcher: string;
  private server?: http.Server;
  private token = randomBytes(32);
  private disposed = false;
  constructor(private options: OfficeToolHostOptions) { this.launcher = launcherFile(path.join(options.dir, 'muster-office-mcp')); }
  async start(): Promise<string> {
    fs.mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    const server = http.createServer((request, response) => void this.handle(request, response));
    // A first LibreOffice download can take many minutes; the request stays open until it is done.
    server.requestTimeout = 0; server.headersTimeout = 60_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    server.unref();
    const { port } = server.address() as { port: number };
    const endpoint = path.join(this.options.dir, 'office-endpoint.json'), script = path.join(this.options.dir, 'muster-office-mcp.cjs');
    fs.writeFileSync(endpoint, JSON.stringify({ url: `http://127.0.0.1:${port}/v1/call`, token: this.token.toString('hex') }), { mode: 0o600 });
    fs.chmodSync(endpoint, 0o600);
    fs.writeFileSync(script, officeMcpServerSource(), { mode: 0o600 });
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
    reply(200, await this.call(body.chatId, body.tool, body.arguments));
  }
  async call(chatId: unknown, tool: unknown, args: unknown): Promise<OfficeToolResult> {
    if (this.disposed) return text('Muster is closing.', true);
    if (typeof chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(chatId)) return text('This office server was started without a chat.', true);
    if (!this.options.knownChat(chatId)) return text('This chat no longer exists.', true);
    if (typeof tool !== 'string' || !OFFICE_TOOL_NAMES.has(tool)) return text(`Unknown office tool ${String(tool)}.`, true);
    return runOfficeTool(this.options.deps, chatId, tool, args);
  }
  dispose(): void { this.disposed = true; this.server?.close(); this.server = undefined; }
}
