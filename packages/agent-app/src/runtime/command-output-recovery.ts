import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {isAbsolute,relative,sep} from 'node:path';

const TAIL_BYTES=2*1024*1024;
const HEADER_BYTES=64*1024;
export interface CompletedCommand {itemId:string;turnId:string;output:string}

/** Only the tool's known output envelope is decoded; arbitrary prose is never a result. */
export function decodeCommandOutput(value:unknown):string|null {
 if(typeof value!=='string'||value.length>TAIL_BYTES)return null;
 const match=/^Chunk ID: [^\n]+\nWall time: [^\n]+\nProcess exited with code -?\d+\n(?:Original token count: \d+\n)?Output:\n/.exec(value);
 if(!match)return null;
 const output=value.slice(match[0].length);
 // The harness can already have truncated this output. Do not call that a full recovery.
 if(/Warning: truncated output|Output truncated|tokens truncated/.test(output))return null;
 return output;
}

export function recoverCommandOutputs(lines:string,commands:readonly CompletedCommand[]):Map<string,string> {
 const requested=new Map(commands.map(command=>[command.itemId,command]));
 const recovered=new Map<string,string>();
 for(const line of lines.split('\n')){
  if(!line||line.length>TAIL_BYTES)continue;
  let row;try{row=JSON.parse(line);}catch{continue;}
  if(row?.type!=='response_item'||row.payload?.type!=='function_call_output')continue;
  const payload=row.payload,command=requested.get(payload.call_id);
  if(!command||payload.internal_chat_message_metadata_passthrough?.turn_id!==command.turnId)continue;
  const output=decodeCommandOutput(payload.output);
  // Reconcile only a missing prefix, never replace conflicting protocol output.
  if(output!==null&&output.length>command.output.length&&output.endsWith(command.output))recovered.set(command.itemId,output);
 }
 return recovered;
}

/** Read at most one bounded tail of the exact app-server supplied, identity-checked thread. */
export async function readOwnedCommandOutputs(input:{sessionsRoot:string;sessionPath:string;threadId:string;commands:readonly CompletedCommand[]}):Promise<Map<string,string>> {
 if(!input.commands.length||!isAbsolute(input.sessionPath)||!input.sessionPath.endsWith('.jsonl'))return new Map();
 const root=await realpath(input.sessionsRoot),file=await realpath(input.sessionPath);
 const rel=relative(root,file);
 if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))return new Map();
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await handle.stat();if(!stat.isFile())return new Map();
  const header=Buffer.alloc(Math.min(HEADER_BYTES,stat.size));
  await handle.read(header,0,header.length,0);
  let identity;try{identity=JSON.parse(header.toString('utf8').split('\n')[0]!);}catch{return new Map();}
  if(identity?.type!=='session_meta'||identity.payload?.id!==input.threadId)return new Map();
  const start=Math.max(0,stat.size-TAIL_BYTES),tail=Buffer.alloc(stat.size-start);
  await handle.read(tail,0,tail.length,start);
  let lines=tail.toString('utf8');if(start>0)lines=lines.slice(lines.indexOf('\n')+1);
  return recoverCommandOutputs(lines,input.commands);
 }finally{await handle.close();}
}
