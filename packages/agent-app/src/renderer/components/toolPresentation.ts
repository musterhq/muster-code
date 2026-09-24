import {computerAction,type ComputerAction} from '../../shared/computer-use.ts';
import {countPatch,itemPatches} from '../patchModel.ts';
export type ToolKind = 'read' | 'edit' | 'search' | 'list' | 'command' | 'subagent' | 'mcp' | 'computer' | 'generic';
export interface FileStat {path:string;adds:number;dels:number}
export interface ToolPresentation {kind:ToolKind;verb:string;runningVerb:string;subject:string;paths?:string[];/** Reads that only looked at images (Codex "Viewed 4 images"). */images?:string[];files?:FileStat[];adds?:number;dels?:number;plan?:boolean;/** The plan's own markdown text (ExitPlanMode, or a native plan item) when it wasn't submitted as a steps array. */planText?:string;computer?:ComputerAction}
const string=(value:unknown):string=>typeof value==='string'?value:'';
const objects=(value:unknown):Record<string,unknown>[]=>Array.isArray(value)?value.filter(v=>v&&typeof v==='object'):[];
export function classifyTool(data:Record<string,unknown>|undefined):ToolPresentation {
 const type=string(data?.type),subject=string(data?.name);
 if(type==='commandExecution'){
  const actions=objects(data?.commandActions);
  if(actions.length && actions.every(action=>action.type==='read')){const paths=[...new Set(actions.map(action=>string(action.path)||string(action.name)).filter(Boolean))];return readOf(paths);}
  if(actions.length && actions.every(action=>action.type==='search'))return {kind:'search',verb:'Searched',runningVerb:'Searching',subject:actions.map(action=>[string(action.query),string(action.path)].filter(Boolean).join(' in ')).join(', ')};
  if(actions.length && actions.every(action=>action.type==='listFiles'))return {kind:'list',verb:'Listed files',runningVerb:'Listing files',subject:actions.map(action=>string(action.path)).filter(Boolean).join(', ')};
  return {kind:'command',verb:'Ran',runningVerb:'Running',subject:string(data?.command)||subject};
 }
 if(type==='fileChange'){const files=fileStats(data),paths=files.map(file=>file.path);return {kind:'edit',verb:'Edited',runningVerb:'Editing',subject:paths.join(', ')||subject,paths,files,adds:files.reduce((n,file)=>n+file.adds,0),dels:files.reduce((n,file)=>n+file.dels,0)};}
 if(type==='fileRead'){const path=string(data?.path)||subject;return path?readOf([path]):{kind:'read',verb:'Read',runningVerb:'Reading',subject};}
 if(type==='imageView'){const path=string(data?.path)||subject;return {kind:'read',verb:'Viewed image',runningVerb:'Viewing image',subject:path,paths:path?[path]:[],images:path?[path]:[]};}
 if(type==='webSearch')return {kind:'search',verb:'Searched',runningVerb:'Searching',subject:string(data?.query)||subject};
 if(type==='todoList'||type==='plan'||PLAN_TOOLS.has(string(data?.tool))||PLAN_TOOLS.has(subject)){
  const steps=planSteps(data),text=steps.length?undefined:planText(data);
  return {kind:'list',verb:'Updated plan',runningVerb:'Updating plan',subject:steps.length?planSummary(steps):(text?planPreview(text):''),plan:true,...(text?{planText:text}:{})};
 }
 // Claude's plan-mode exit: the drafted plan is markdown in the `plan` argument, not a steps array.
 if(EXIT_PLAN_TOOLS.has(string(data?.tool).toLowerCase())||EXIT_PLAN_TOOLS.has(subject.toLowerCase())){
  const text=planText(data);
  return {kind:'list',verb:'Proposed plan',runningVerb:'Drafting plan',subject:text?planPreview(text):'',plan:true,...(text?{planText:text}:{})};
 }
 if(type==='collabAgentToolCall'){
  let named='';
  const raw=data?.receiverAgents;
  try {
   const parsed=typeof raw==='string'?JSON.parse(raw):raw;
   if(Array.isArray(parsed)) named=parsed.map(entry=>entry&&typeof entry==='object'&&typeof entry.name==='string'?entry.name:'').filter(Boolean).slice(0,3).join(', ');
  } catch {}
  return {kind:'subagent',verb:data?.tool==='wait'?'Waited for agents':'Agent action',runningVerb:data?.tool==='wait'?'Waiting for agents':'Working with agents',subject:named||string(data?.prompt)||string(data?.tool)||subject};
 }
 // CUA-04: computer and browser use read as actions ("Clicked “Send” in Mail"), never as a generic MCP call.
 const action=type==='mcpToolCall'||type==='dynamicToolCall'?computerAction(data):undefined;
 if(action){const where=action.target==='computer'&&action.app&&action.label.endsWith(` in ${action.app}`)?` in ${action.app}`:'';return {kind:'computer',verb:action.verb,runningVerb:action.runningVerb,subject:`${action.object}${where}`.trim(),computer:action};}
 if(type==='mcpToolCall'||type==='dynamicToolCall')return {kind:'mcp',verb:'Used',runningVerb:'Using',subject:string(data?.title)||[string(data?.server)||string(data?.namespace),string(data?.tool)].filter(Boolean).join(' / ')||subject};
 return {kind:'generic',verb:'Ran tool',runningVerb:'Running tool',subject};
}
export const IMAGE_PATH=/\.(?:png|jpe?g|gif|webp|bmp|avif|heic|svg)$/i;
function readOf(paths:string[]):ToolPresentation {
 if(paths.length&&paths.every(path=>IMAGE_PATH.test(path)))return {kind:'read',verb:paths.length===1?'Viewed image':`Viewed ${paths.length} images`,runningVerb:'Viewing',subject:paths.join(', '),paths,images:paths};
 return {kind:'read',verb:'Read',runningVerb:'Reading',subject:paths.join(', '),paths};
}
/** Display-only unwrapping; copying retains the exact command. */
export function commandLabel(raw:string):string {
 const shell=raw.match(/^(?:\/\S+\/)?(?:zsh|bash|sh)\s+-[a-z]*c\s+([\s\S]+)$/);const wrapped=shell?shell[1]:raw;
 return /^(['"])[\s\S]*\1$/.test(wrapped)?wrapped.slice(1,-1):wrapped;
}

/** Count body lines of a unified patch with the same parser the inline diff renders. */
export function diffStats(diff:string):{adds:number;dels:number} {
 return countPatch(diff);
}
/** Per-file +/- for a fileChange item; repeated paths merge in first-seen order. Codex add/delete bodies are whole files. */
export function fileStats(data:Record<string,unknown>|undefined):FileStat[] {
 const files=new Map<string,FileStat>();
 for(const change of itemPatches(data)){const file=files.get(change.path)??{path:change.path,adds:0,dels:0};file.adds+=change.adds;file.dels+=change.dels;files.set(change.path,file);}
 return [...files.values()];
}
/** F60: a started tool the provider has blocked on an approval card is waiting, not running (runtime sets `awaitingApproval`). */
export const APPROVAL_WAIT_LABEL='Waiting for approval';
export function awaitingApproval(item:{status?:string;data?:Record<string,unknown>}):boolean {return item.status==='running'&&typeof item.data?.awaitingApproval==='string';}
export const basename=(path:string)=>path.split('/').filter(Boolean).at(-1)||path;
/**
 * VS Code-style disambiguation: every path gets the shortest path-segment suffix that is
 * unique among the set ("package.json" for the only one, "apps/api/package.json" only extends
 * as far as it needs to — "api/package.json" — to stop colliding with the others). A path that
 * runs out of segments before becoming unique (it sits at the shallowest depth of a collision)
 * keeps its shortest form; the deeper sibling is the one that grows.
 */
export function uniqueFileLabels(paths:readonly string[]):Map<string,string> {
 const segments=paths.map(path=>path.split('/').filter(Boolean));
 const labels=new Map<string,string>();
 paths.forEach((path,index)=>{
  const parts=segments[index];
  let depth=1,label=parts.slice(-depth).join('/')||path;
  while(depth<parts.length&&paths.some((other,otherIndex)=>otherIndex!==index&&(segments[otherIndex].slice(-depth).join('/')||other)===label)){
   depth++;label=parts.slice(-depth).join('/')||path;
  }
  labels.set(path,label);
 });
 return labels;
}
/** Folder-relative target for a tool path, or undefined when it is outside every attached folder. */
export function resolveToolPath(path:string,folders:readonly {id:string;path:string}[],chatFolderId?:string):{folderId:string;path:string}|undefined {
 const normalized=path.replaceAll('\\','/');
 for(const folder of folders){const root=folder.path.replaceAll('\\','/').replace(/\/$/,'');if(normalized.startsWith(root+'/'))return {folderId:folder.id,path:normalized.slice(root.length+1)};}
 if(normalized.startsWith('/')||/^[A-Za-z]:\//.test(normalized)||normalized.split('/').some(part=>part==='..'||part==='.'||part===''))return undefined;
 const folderId=chatFolderId??(folders.length===1?folders[0].id:undefined);
 return folderId?{folderId,path:normalized}:undefined;
}
export function formatToolDuration(ms:number):string {
 if(ms<1000)return `${Math.max(0,Math.round(ms))}ms`;
 if(ms<10000)return `${(ms/1000).toFixed(1)}s`;
 const s=Math.round(ms/1000);return s<60?`${s}s`:`${Math.floor(s/60)}m ${s%60}s`;
}
const lastLines=(text:string,count:number)=>text.replace(/\s+$/,'').split('\n').filter(line=>line.trim()).slice(-count);
export interface CommandOutcome {exitCode?:number;duration?:string;failed:boolean;suffix:string;excerpt:string[]}
/** Collapsed-row facts for a command: exit code, duration, and on failure the last stderr/output lines. */
export function commandOutcome(data:Record<string,unknown>|undefined,status:string|undefined,output=''):CommandOutcome {
 const exitCode=typeof data?.exitCode==='number'?data.exitCode:undefined;
 const duration=typeof data?.durationMs==='number'&&status!=='running'?formatToolDuration(data.durationMs):undefined;
 const failed=status==='failed'||(exitCode!=null&&exitCode!==0&&status!=='running');
 const suffix=failed?(exitCode!=null?`failed (exit ${exitCode})`:'failed'):status==='interrupted'?'interrupted':status==='cancelled'?'cancelled':'';
 const source=string(data?.stderr)||output||(()=>{const error=data?.error;if(typeof error==='string'){try{const parsed=JSON.parse(error);return typeof parsed==='string'?parsed:typeof parsed?.message==='string'?parsed.message:error;}catch{return error;}}return '';})();
 return {exitCode,duration,failed,suffix,excerpt:failed?lastLines(source,2):[]};
}
export type PlanStatus='pending'|'in_progress'|'completed';
export interface PlanStep {text:string;status:PlanStatus}
const PLAN_TOOLS=new Set(['update_plan','TodoWrite','todo_write','todowrite']);
/** Claude's plan-mode exit tool: its sole argument is the drafted plan as markdown, not a steps list. */
const EXIT_PLAN_TOOLS=new Set(['exitplanmode','exit_plan_mode']);
const planStatus=(value:unknown,completed:unknown):PlanStatus=>{const v=string(value).replace(/[-\s]/g,'_').replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase();return completed===true||v==='completed'||v==='done'?'completed':v==='in_progress'||v==='active'||v==='running'?'in_progress':'pending';};
/** Plan steps from provider data (Codex todoList/plan items, Claude TodoWrite arguments); never raw JSON. */
export function planSteps(data:Record<string,unknown>|undefined):PlanStep[] {
 const parse=(value:unknown):unknown=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return undefined;}};
 const candidates=[data?.items,data?.plan,data?.todos,...[parse(data?.arguments),parse(data?.result)].flatMap(value=>value&&typeof value==='object'?[(value as Record<string,unknown>).todos,(value as Record<string,unknown>).plan,(value as Record<string,unknown>).items]:[])];
 for(const candidate of candidates){
  const steps=objects(candidate).map(step=>({text:string(step.text)||string(step.step)||string(step.content)||string(step.title),status:planStatus(step.status,step.completed)})).filter(step=>step.text);
  if(steps.length)return steps.slice(0,100);
 }
 return [];
}
export function planSummary(steps:readonly PlanStep[]):string {
 if(!steps.length)return '';const done=steps.filter(step=>step.status==='completed').length;return `${done} of ${steps.length} done`;
}
/** A plan's raw markdown when the provider sent prose rather than a steps array (ExitPlanMode's
 * `plan` argument, or a native plan item whose `plan` field is a string). */
export function planText(data:Record<string,unknown>|undefined):string {
 if(typeof data?.plan==='string'&&data.plan.trim())return data.plan;
 const parse=(value:unknown):unknown=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return undefined;}};
 for(const value of [parse(data?.arguments),parse(data?.result)]){
  const plan=value&&typeof value==='object'?(value as Record<string,unknown>).plan:undefined;
  if(typeof plan==='string'&&plan.trim())return plan;
 }
 return '';
}
/** First line (or a short lead) of a plan's markdown, for the collapsed tool row's subject. */
export function planPreview(text:string):string {
 const line=text.split('\n').map(l=>l.trim()).find(Boolean)?.replace(/^#+\s*/,'')??'';
 return line.length>80?line.slice(0,79)+'…':line;
}
