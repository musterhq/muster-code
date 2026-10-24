/**
 * The `muster_background` agent tool set: start a long-running command (build, test run, deploy, server) as an
 * agent-owned process of this chat, check on it, or stop it. The process outlives the turn; when it exits after the
 * turn ended, process-continuations.ts queues one follow-up with its exit code and output tail, so the agent can keep a
 * "report back when it finishes" promise instead of dropping it.
 *
 * Offered only in Agent mode with Full access (ProcessSessions re-checks that on every start: Read-only and Workspace
 * chats cannot run it, and Full access never prompts). Same shape as the terminal and browser bridges: a stdio MCP
 * server the provider spawns per chat posts to a 127.0.0.1 endpoint in the main process (bearer token in a 0600 file).
 */
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type {McpToolResult} from './sandbox-registry.ts';
import {sandboxLauncherScript,textResult} from './sandbox-agent-tools.ts';
import {launcherFile} from './launcher-script.ts';
import {ChatBinding,CHAT_BINDING_REFUSED,CHAT_TOKEN_HEADER,registerChatTokenIssuer} from './governance/chat-binding.ts';
import {outputTail,PROCESS_TAIL_LINES} from './process-continuations.ts';
import {type ProcessListSnapshot,type ProcessPurpose,type ProcessRef,type ProcessSnapshot,type ProcessStart} from '../shared/process-protocol.ts';

export const BACKGROUND_MCP='muster_background';
export const BACKGROUND_MCP_LAUNCHER_ENV='MUSTER_BACKGROUND_MCP_LAUNCHER';
export const BACKGROUND_RUN_TOOL='run_background',BACKGROUND_READ_TOOL='read_background',BACKGROUND_STOP_TOOL='stop_background';
/** Added to the developer instructions of chats that get the tool. */
export const BACKGROUND_TOOL_NOTE=`For a long build, test run or deploy that you would otherwise promise to "report back" on, start it with the ${BACKGROUND_MCP} ${BACKGROUND_RUN_TOOL} tool: Muster wakes this chat with its exit code and last ${PROCESS_TAIL_LINES} lines when it ends after your turn.`;
const MAX_BODY=64*1024,PURPOSES:readonly ProcessPurpose[]=['command','build','test','server','task'];
export const BACKGROUND_TOOL_SPECS=[
  {name:BACKGROUND_RUN_TOOL,description:'Start a long-running shell command (build, tests, deploy, dev server) in this chat’s folder and return at once with its id. It keeps running after your turn ends; when it exits, Muster sends you its exit code and output tail as a new message.',
    inputSchema:{type:'object',properties:{command:{type:'string',description:'Shell command line, run in the chat’s folder.'},label:{type:'string',description:'Short name shown to the user.'},purpose:{type:'string',enum:[...PURPOSES]}},required:['command']}},
  {name:BACKGROUND_READ_TOOL,description:'Status, exit code and newest output lines of a background process you started (omit id to list them).',
    inputSchema:{type:'object',properties:{id:{type:'string'},lines:{type:'number',description:`Lines of output to return (default ${PROCESS_TAIL_LINES}, at most 400).`}}}},
  {name:BACKGROUND_STOP_TOOL,description:'Stop a background process you started.',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id']}},
] as const;

/** What the tools need from ProcessSessions. */
export interface BackgroundProcesses {
  start(input:ProcessStart,options:{owner:'agent'}):Promise<ProcessSnapshot>;
  list(input:{chatId:string}):Promise<ProcessListSnapshot>;
  stop(input:ProcessRef):Promise<ProcessSnapshot>;
}
const describe=(s:ProcessSnapshot)=>`${s.processId} "${s.label}" ${s.status}${s.exitCode!==null?` (exit code ${s.exitCode})`:s.signal?` (signal ${s.signal})`:''}${s.queued?` — queued: ${s.queued}`:''}${s.error?` — ${s.error}`:''}`;
const str=(value:unknown,max:number)=>typeof value==='string'&&value.trim()&&value.length<=max?value:undefined;

/** One tool call for a chat. Errors (no Full access, too many processes, unknown id) come back as tool errors. */
export async function callBackgroundTool(processes:BackgroundProcesses,chatId:string,tool:unknown,args:Record<string,unknown>={}):Promise<McpToolResult> {
  try{
    const owned=async()=>(await processes.list({chatId})).sessions.filter(s=>s.owner==='agent');
    const find=async(id:unknown)=>{const s=(await owned()).find(s=>s.processId===id);if(!s)throw new Error(`No background process ${String(id)} that you started in this chat.`);return s;};
    if(tool===BACKGROUND_RUN_TOOL){
      const command=str(args.command,32768);if(!command)return textResult('Give the command to run.',true);
      const purpose=PURPOSES.includes(args.purpose as ProcessPurpose)?args.purpose as ProcessPurpose:'command';
      const label=(str(args.label,160)??command.replace(/\s+/g,' ')).slice(0,80);
      const s=await processes.start({chatId,requestId:`agent-${randomUUID()}`,command,label,purpose},{owner:'agent'});
      return textResult(`Started ${describe(s)}. It keeps running after your turn; if it ends after your turn ends, Muster sends you its exit code and last ${PROCESS_TAIL_LINES} lines. Use ${BACKGROUND_READ_TOOL} to check on it now.`);
    }
    if(tool===BACKGROUND_READ_TOOL){
      if(args.id===undefined){const all=await owned();return textResult(all.length?all.map(describe).join('\n'):'You have no background processes in this chat.');}
      const s=await find(args.id),n=Math.min(Math.max(Math.floor(Number(args.lines)||PROCESS_TAIL_LINES),1),400);
      const tail=outputTail(s.output,n);
      return textResult(`${describe(s)}\n${tail?`--- last ${n} lines ---\n${tail}`:'[no output yet]'}`);
    }
    if(tool===BACKGROUND_STOP_TOOL){const s=await find(args.id);return textResult(`Stopping ${describe(await processes.stop({chatId,processId:s.processId}))}.`);}
    return textResult(`Unknown background tool ${String(tool)}.`,true);
  }catch(error){return textResult(error instanceof Error?error.message:String(error),true);}
}

/** The stdio MCP server, written as plain CommonJS at start so no build entry is needed. */
export function backgroundMcpServerSource():string {
  return `'use strict';
const fs=require('node:fs');
const TOOLS=${JSON.stringify(BACKGROUND_TOOL_SPECS)};
const endpointFile=process.argv[2],chatId=process.env.MUSTER_CHAT_ID||'',chatToken=process.env.MUSTER_CHAT_TOKEN||'';
const text=(t,isError)=>({content:[{type:'text',text:t}],...(isError?{isError:true}:{})});
async function call(tool,args){
  const {url,token}=JSON.parse(fs.readFileSync(endpointFile,'utf8'));
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token,'${CHAT_TOKEN_HEADER}':chatToken},body:JSON.stringify({chatId,tool,args}),signal:AbortSignal.timeout(30000)});
  if(response.status===403){const refused=await response.json().catch(()=>({}));if(refused&&typeof refused.error==='string'&&refused.error!=='Forbidden')return text(refused.error,true);}
  if(!response.ok)throw new Error('background host answered '+response.status);
  return await response.json();
}
const write=line=>{process.stdout.write(line+'\\n');};
async function handle(message){
  const respond=body=>{if(message.id!==undefined&&message.id!==null)write(JSON.stringify({jsonrpc:'2.0',id:message.id,...body}));};
  const params=message.params||{};
  switch(message.method){
    case 'initialize':respond({result:{protocolVersion:typeof params.protocolVersion==='string'?params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'${BACKGROUND_MCP}',title:'Muster background processes',version:'1.0.0'},instructions:${JSON.stringify(BACKGROUND_TOOL_NOTE)}}});return;
    case 'ping':respond({result:{}});return;
    case 'tools/list':respond({result:{tools:TOOLS}});return;
    case 'tools/call':{const name=typeof params.name==='string'?params.name:'';const args=params.arguments&&typeof params.arguments==='object'?params.arguments:{};let result;try{result=await call(name,args);}catch(error){result=text('Muster is not reachable: '+(error&&error.message||String(error))+'. Is Muster still open?',true);}respond({result});return;}
    default:if(typeof message.method==='string'&&message.method.startsWith('notifications/'))return;respond({error:{code:-32601,message:'Method not found: '+String(message.method)}});
  }
}
let buffer='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;if(buffer.length>1024*1024)buffer='';let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;let message;try{message=JSON.parse(line);}catch{write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}));continue;}void handle(message);}});
process.stdin.on('end',()=>process.exit(0));
`;
}

/** Main-process endpoint for the stdio server. */
export class BackgroundToolHost {
  readonly launcher:string;
  private server?:http.Server;
  private starting?:Promise<string>;
  private token=randomBytes(32);
  private binding=new ChatBinding();
  private unregister?:()=>void;
  private disposed=false;
  constructor(private options:{dir:string;execPath:string;processes:BackgroundProcesses}) {this.launcher=launcherFile(path.join(options.dir,'muster-background-mcp'));}
  start():Promise<string> {return this.starting??=this.listen();}
  private async listen():Promise<string> {
    fs.mkdirSync(this.options.dir,{recursive:true,mode:0o700});
    const server=http.createServer((request,response)=>void this.handle(request,response));
    this.server=server;
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
    server.unref();
    const {port}=server.address() as {port:number};
    const endpoint=path.join(this.options.dir,'background-endpoint.json'),script=path.join(this.options.dir,'muster-background-mcp.cjs');
    fs.writeFileSync(endpoint,JSON.stringify({url:`http://127.0.0.1:${port}/v1/call`,token:this.token.toString('hex')}),{mode:0o600});
    fs.chmodSync(endpoint,0o600);
    fs.writeFileSync(script,backgroundMcpServerSource(),{mode:0o600});
    fs.writeFileSync(this.launcher,sandboxLauncherScript(this.options.execPath,script,endpoint),{mode:0o700});
    fs.chmodSync(this.launcher,0o700);
    this.unregister=registerChatTokenIssuer(BACKGROUND_MCP,chatId=>this.chatToken(chatId));
    return this.launcher;
  }
  /** The value for the run's MUSTER_CHAT_TOKEN: an HMAC of the chat id under this host's own secret. */
  chatToken(chatId:string):string {return this.binding.token(chatId);}
  private authorized(header:string|undefined):boolean {
    const presented=Buffer.from(/^Bearer ([a-f0-9]{64})$/.exec(header??'')?.[1]??'','hex');
    return presented.length===this.token.length&&timingSafeEqual(presented,this.token);
  }
  private async handle(request:http.IncomingMessage,response:http.ServerResponse):Promise<void> {
    const reply=(status:number,body:unknown)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(body));};
    if(request.method!=='POST'||request.url!=='/v1/call'||!this.authorized(request.headers.authorization)){reply(403,{error:'Forbidden'});return;}
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of request){size+=(chunk as Buffer).length;if(size>MAX_BODY){reply(413,{error:'Too large'});return;}chunks.push(chunk as Buffer);}
    let body:{chatId?:unknown;tool?:unknown;args?:unknown};
    try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{reply(400,{error:'Invalid JSON'});return;}
    if(!this.binding.verify(body.chatId,request.headers[CHAT_TOKEN_HEADER])){reply(403,{error:CHAT_BINDING_REFUSED});return;}
    reply(200,await this.call(body.chatId,body.tool,body.args));
  }
  async call(chatId:unknown,tool:unknown,args?:unknown):Promise<McpToolResult> {
    if(this.disposed)return textResult('Muster is closing.',true);
    if(typeof chatId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(chatId))return textResult('This background-process server was started without a chat.',true);
    return callBackgroundTool(this.options.processes,chatId,tool,args&&typeof args==='object'&&!Array.isArray(args)?args as Record<string,unknown>:{});
  }
  dispose():void {this.disposed=true;this.unregister?.();this.unregister=undefined;this.server?.close();this.server=undefined;}
}
