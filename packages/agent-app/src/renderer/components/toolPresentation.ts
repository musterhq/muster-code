export type ToolKind = 'read' | 'edit' | 'search' | 'list' | 'command' | 'subagent' | 'mcp' | 'generic';
export interface ToolPresentation {kind:ToolKind;verb:string;runningVerb:string;subject:string;paths?:string[]}
const string=(value:unknown):string=>typeof value==='string'?value:'';
const objects=(value:unknown):Record<string,unknown>[]=>Array.isArray(value)?value.filter(v=>v&&typeof v==='object'):[];
export function classifyTool(data:Record<string,unknown>|undefined):ToolPresentation {
 const type=string(data?.type),subject=string(data?.name);
 if(type==='commandExecution'){
  const actions=objects(data?.commandActions);
  if(actions.length && actions.every(action=>action.type==='read')){const paths=[...new Set(actions.map(action=>string(action.path)||string(action.name)).filter(Boolean))];return {kind:'read',verb:'Read',runningVerb:'Reading',subject:paths.join(', '),paths};}
  if(actions.length && actions.every(action=>action.type==='search'))return {kind:'search',verb:'Searched',runningVerb:'Searching',subject:actions.map(action=>[string(action.query),string(action.path)].filter(Boolean).join(' in ')).join(', ')};
  if(actions.length && actions.every(action=>action.type==='listFiles'))return {kind:'list',verb:'Listed files',runningVerb:'Listing files',subject:actions.map(action=>string(action.path)).filter(Boolean).join(', ')};
  return {kind:'command',verb:'Ran',runningVerb:'Running',subject:string(data?.command)||subject};
 }
 if(type==='fileChange'){const paths=[...new Set(objects(data?.changes).map(change=>string(change.path)).filter(Boolean))];return {kind:'edit',verb:'Edited',runningVerb:'Editing',subject:paths.join(', ')||subject,paths};}
 if(type==='fileRead')return {kind:'read',verb:'Read',runningVerb:'Reading',subject:string(data?.path)||subject};
 if(type==='webSearch')return {kind:'search',verb:'Searched',runningVerb:'Searching',subject:string(data?.query)||subject};
 if(type==='todoList')return {kind:'list',verb:'Updated plan',runningVerb:'Updating plan',subject};
 if(type==='collabAgentToolCall')return {kind:'subagent',verb:data?.tool==='wait'?'Waited for agents':'Agent action',runningVerb:data?.tool==='wait'?'Waiting for agents':'Working with agents',subject:string(data?.prompt)||string(data?.tool)||subject};
 if(type==='mcpToolCall'||type==='dynamicToolCall')return {kind:'mcp',verb:'Used',runningVerb:'Using',subject:[string(data?.server)||string(data?.namespace),string(data?.tool)].filter(Boolean).join(' / ')||subject};
 return {kind:'generic',verb:'Ran tool',runningVerb:'Running tool',subject};
}
/** Display-only unwrapping; copying retains the exact command. */
export function commandLabel(raw:string):string {
 const shell=raw.match(/^(?:\/\S+\/)?(?:zsh|bash|sh)\s+-[a-z]*c\s+([\s\S]+)$/);const wrapped=shell?shell[1]:raw;
 return /^(['"])[\s\S]*\1$/.test(wrapped)?wrapped.slice(1,-1):wrapped;
}
