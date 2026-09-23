/**
 * C3.b4 / CR-19: the `muster_terminal` agent tool set — `read_thread_terminal`, Codex's way of letting the agent see
 * the user's terminal. It is read-only (no input, no signals), offered only to chats the user explicitly allowed
 * (per chat, off by default, revocable), and every byte is ANSI-stripped and secret-redacted before it leaves.
 *
 * Same shape as the mailbox and browser bridges: a stdio MCP server Codex spawns per chat posts to a 127.0.0.1
 * endpoint in the main process (bearer token in a 0600 file), which owns the terminals.
 */
import {randomBytes,timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type {McpToolResult} from './sandbox-registry.ts';
import {sandboxLauncherScript,textResult} from './sandbox-agent-tools.ts';
import {redactSecrets} from './secret-redaction.ts';

export const TERMINAL_MCP='muster_terminal';
export const TERMINAL_MCP_LAUNCHER_ENV='MUSTER_TERMINAL_MCP_LAUNCHER';
export const TERMINAL_READ_TOOL='read_thread_terminal';
/** Newest output returned per call, across all of the chat's terminals. */
export const TERMINAL_READ_MAX_BYTES=16*1024;
export const TERMINAL_EMPTY='[terminal has no output yet]';
export const TERMINAL_NOT_ALLOWED='The user has not allowed this chat to read their terminal. Ask them to turn on "Let the agent read this chat’s terminal" if you need its output.';
const MAX_BODY=16*1024;
export const TERMINAL_TOOL_SPECS=[
  {name:TERMINAL_READ_TOOL,description:'Read the newest output of the user’s terminal(s) in this chat (read-only, secrets redacted).',inputSchema:{type:'object',properties:{}}},
] as const;

export interface TerminalTailInput {title:string;status:string;text:string;truncated:boolean}

/** The tool's answer: refusal without consent, the empty marker, or each terminal's redacted tail within one byte budget. */
export function readTerminalForAgent(input:{allowed:boolean;tails:readonly TerminalTailInput[];maxBytes?:number}):McpToolResult {
  if(!input.allowed)return textResult(TERMINAL_NOT_ALLOWED,true);
  let budget=input.maxBytes??TERMINAL_READ_MAX_BYTES;
  const parts:string[]=[];let truncated=false;
  for(const tail of input.tails){
    const text=tail.text.replace(/\s+$/,'');
    if(!text)continue;
    if(budget<=0){truncated=true;break;}
    let body=redactSecrets(text);
    if(Buffer.byteLength(body,'utf8')>budget){
      // Keep the newest bytes; cut on a line boundary where one is near.
      const buffer=Buffer.from(body,'utf8');
      body=buffer.subarray(buffer.length-budget).toString('utf8').replace(/^�+/,'');
      const newline=body.indexOf('\n');if(newline>=0&&newline<256)body=body.slice(newline+1);
      truncated=true;
    }
    truncated||=tail.truncated;
    budget-=Buffer.byteLength(body,'utf8');
    parts.push(`--- ${tail.title} (${tail.status}) ---\n${body}`);
  }
  if(!parts.length)return textResult(TERMINAL_EMPTY);
  return textResult(`${parts.join('\n\n')}${truncated?'\n\nnote: output is truncated to the latest terminal buffer kept by the app':''}`);
}

/** The stdio MCP server, written as plain CommonJS at start so no build entry is needed. */
export function terminalMcpServerSource():string {
  return `'use strict';
const fs=require('node:fs');
const TOOLS=${JSON.stringify(TERMINAL_TOOL_SPECS)};
const endpointFile=process.argv[2],chatId=process.env.MUSTER_CHAT_ID||'';
const text=(t,isError)=>({content:[{type:'text',text:t}],...(isError?{isError:true}:{})});
async function call(tool){
  const {url,token}=JSON.parse(fs.readFileSync(endpointFile,'utf8'));
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({chatId,tool}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('terminal host answered '+response.status);
  return await response.json();
}
const write=line=>{process.stdout.write(line+'\\n');};
async function handle(message){
  const respond=body=>{if(message.id!==undefined&&message.id!==null)write(JSON.stringify({jsonrpc:'2.0',id:message.id,...body}));};
  switch(message.method){
    case 'initialize':respond({result:{protocolVersion:typeof (message.params||{}).protocolVersion==='string'?message.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'${TERMINAL_MCP}',title:'Muster terminal',version:'1.0.0'},instructions:'Read-only access to the user’s terminal in this chat.'}});return;
    case 'ping':respond({result:{}});return;
    case 'tools/list':respond({result:{tools:TOOLS}});return;
    case 'tools/call':{const name=typeof (message.params||{}).name==='string'?message.params.name:'';let result;try{result=await call(name);}catch(error){result=text('Muster’s terminal is not reachable: '+(error&&error.message||String(error))+'. Is Muster still open?',true);}respond({result});return;}
    default:if(typeof message.method==='string'&&message.method.startsWith('notifications/'))return;respond({error:{code:-32601,message:'Method not found: '+String(message.method)}});
  }
}
let buffer='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;if(buffer.length>1024*1024)buffer='';let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;let message;try{message=JSON.parse(line);}catch{write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}));continue;}void handle(message);}});
process.stdin.on('end',()=>process.exit(0));
`;
}

/** Main-process endpoint. `allowed` re-checks consent on every call (the run option is only the first gate). */
export class TerminalToolHost {
  readonly launcher:string;
  private server?:http.Server;
  private starting?:Promise<string>;
  private token=randomBytes(32);
  private disposed=false;
  constructor(private options:{dir:string;execPath:string;allowed(chatId:string):Promise<boolean>;tails(chatId:string):readonly TerminalTailInput[]}) {this.launcher=path.join(options.dir,'muster-terminal-mcp');}
  start():Promise<string> {return this.starting??=this.listen();}
  private async listen():Promise<string> {
    fs.mkdirSync(this.options.dir,{recursive:true,mode:0o700});
    const server=http.createServer((request,response)=>void this.handle(request,response));
    this.server=server;
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
    server.unref();
    const {port}=server.address() as {port:number};
    const endpoint=path.join(this.options.dir,'terminal-endpoint.json'),script=path.join(this.options.dir,'muster-terminal-mcp.cjs');
    fs.writeFileSync(endpoint,JSON.stringify({url:`http://127.0.0.1:${port}/v1/call`,token:this.token.toString('hex')}),{mode:0o600});
    fs.chmodSync(endpoint,0o600);
    fs.writeFileSync(script,terminalMcpServerSource(),{mode:0o600});
    fs.writeFileSync(this.launcher,sandboxLauncherScript(this.options.execPath,script,endpoint),{mode:0o700});
    fs.chmodSync(this.launcher,0o700);
    return this.launcher;
  }
  private authorized(header:string|undefined):boolean {
    const presented=Buffer.from(/^Bearer ([a-f0-9]{64})$/.exec(header??'')?.[1]??'','hex');
    return presented.length===this.token.length&&timingSafeEqual(presented,this.token);
  }
  private async handle(request:http.IncomingMessage,response:http.ServerResponse):Promise<void> {
    const reply=(status:number,body:unknown)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(body));};
    if(request.method!=='POST'||request.url!=='/v1/call'||!this.authorized(request.headers.authorization)){reply(403,{error:'Forbidden'});return;}
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of request){size+=(chunk as Buffer).length;if(size>MAX_BODY){reply(413,{error:'Too large'});return;}chunks.push(chunk as Buffer);}
    let body:{chatId?:unknown;tool?:unknown};
    try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{reply(400,{error:'Invalid JSON'});return;}
    reply(200,await this.call(body.chatId,body.tool));
  }
  async call(chatId:unknown,tool:unknown):Promise<McpToolResult> {
    if(this.disposed)return textResult('Muster is closing.',true);
    if(typeof chatId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(chatId))return textResult('This terminal server was started without a chat.',true);
    if(tool!==TERMINAL_READ_TOOL)return textResult(`Unknown terminal tool ${String(tool)}.`,true);
    let allowed=false;
    try{allowed=await this.options.allowed(chatId);}catch{allowed=false;}
    try{return readTerminalForAgent({allowed,tails:allowed?this.options.tails(chatId):[]});}
    catch(error){return textResult(error instanceof Error?error.message:String(error),true);}
  }
  dispose():void {this.disposed=true;this.server?.close();this.server=undefined;}
}
