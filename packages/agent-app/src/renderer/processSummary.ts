import {useCallback,useSyncExternalStore} from 'react';
import {invoke,subscribe} from './bridge.ts';
import {mergeProcessSummary,type ListeningPort,type ProcessPortsSnapshot,type ProcessSummarySnapshot,type TerminalInfo} from '../shared/process-protocol.ts';
import type {TimelineItem} from '../shared/protocol.ts';
import {classifyTool,commandLabel} from './components/toolPresentation.ts';

export interface ProcessSummaryState {summary:ProcessSummarySnapshot|null;loading:boolean;error:boolean}
const initial=():ProcessSummaryState=>({summary:null,loading:true,error:false});
let state=initial(),epoch=0,readId=0,applied=0;
let unsubscribe:(()=>void)|undefined;
const listeners=new Set<()=>void>();
const update=(next:ProcessSummaryState)=>{state=next;for(const listener of listeners)listener();};
export const getProcessSummaryState=():ProcessSummaryState=>state;

/** A single metadata reader for any number of overview/sidebar consumers. */
export function refreshProcessSummary():void {
  if(!listeners.size)return;
  const generation=epoch,request=++readId,priorApplied=applied;
  void invoke('processes.summary',{}).then(next=>{
    if(generation!==epoch||!listeners.size)return;
    const summary=mergeProcessSummary(state.summary,next);
    if(summary!==state.summary||state.loading||state.error){applied++;update({summary,loading:false,error:false});}
  }).catch(()=>{
    // An older failed read cannot invalidate a newer authoritative report.
    if(generation===epoch&&listeners.size&&request===readId&&priorApplied===applied)update({...state,loading:false,error:true});
  });
}

export function subscribeProcessSummary(listener:()=>void):()=>void {
  listeners.add(listener);
  if(listeners.size===1){
    const generation=++epoch;
    unsubscribe=subscribe(event=>{
      if(generation!==epoch)return;
      if(event.type==='processMetadata'){
        const summary=mergeProcessSummary(state.summary,event.summary);
        if(summary!==state.summary||state.loading||state.error){applied++;update({summary,loading:false,error:false});}
      }else if(event.type==='snapshot')refreshProcessSummary();
    });
    refreshProcessSummary();
  }
  let released=false;
  return()=>{
    if(released)return;released=true;listeners.delete(listener);
    if(!listeners.size){epoch++;unsubscribe?.();unsubscribe=undefined;state=initial();}
  };
}

export function useProcessSummary():ProcessSummaryState {
  return useSyncExternalStore(subscribeProcessSummary,getProcessSummaryState);
}

/** S3-E: the right-pane Terminal is ONE list (shells, your commands, the agent's commands and
 * servers). The "view" is only a focus hint: which kind of row to reveal when the tab opens. */
export type TerminalPaneView='terminals'|'commands'|'agent';
const views=new Map<string,TerminalPaneView>(),viewListeners=new Set<()=>void>();
export const terminalPaneView=(chatId:string):TerminalPaneView=>views.get(chatId)??'terminals';
export function setTerminalPaneView(chatId:string,view:TerminalPaneView):void {views.set(chatId,view);for(const listener of viewListeners)listener();}
export function subscribeTerminalPaneView(listener:()=>void):()=>void {viewListeners.add(listener);return()=>{viewListeners.delete(listener);};}

/** Where interactive terminals live: the right-pane Terminal tab, or a resizable bottom
 * panel under the conversation (Codex/Cursor style). Remembered per window (sessionStorage),
 * seeded for new windows from the last choice (localStorage). */
export interface TerminalDockState {placement:'pane'|'panel';open:boolean;height:number}
export const DOCK_MIN=160,DOCK_DEFAULT=260;
const DOCK_KEY='muster.terminalDock';
function readDock():TerminalDockState {
  for(const store of [()=>sessionStorage,()=>localStorage]){
    try{const value=JSON.parse(store().getItem(DOCK_KEY)??'null');if(value&&(value.placement==='pane'||value.placement==='panel'))return {placement:value.placement,open:value.open===true,height:Number.isFinite(value.height)?Math.max(DOCK_MIN,Math.min(2000,value.height)):DOCK_DEFAULT};}catch{}
  }
  return {placement:'pane',open:false,height:DOCK_DEFAULT};
}
let dock:TerminalDockState|undefined;const dockListeners=new Set<()=>void>();
export const terminalDock=():TerminalDockState=>dock??=readDock();
export function setTerminalDock(patch:Partial<TerminalDockState>,persist=true):void {
  const current=terminalDock(),next={...current,...patch};
  if(next.placement!==current.placement||next.open!==current.open||next.height!==current.height){dock=next;for(const listener of dockListeners)listener();}
  if(persist)for(const store of [()=>sessionStorage,()=>localStorage])try{store().setItem(DOCK_KEY,JSON.stringify(next));}catch{}
}
export function subscribeTerminalDock(listener:()=>void):()=>void {dockListeners.add(listener);return()=>{dockListeners.delete(listener);};}

/** Ends every running PTY for a chat. Used when its Terminal resource tab closes (Codex/VS Code parity:
 * closing a terminal ends its shell instead of leaving it running with no visible indication). */
export function killChatTerminals(chatId:string):void {
  void invoke('terminal.list',{chatId}).then((rows:TerminalInfo[])=>Promise.all(
    rows.filter(row=>row.status==='running').map(row=>invoke('terminal.kill',{id:row.id}).catch(()=>{})),
  )).catch(()=>{});
}

export interface AgentCommand {item:TimelineItem;command:string;output:string;running:boolean}
const agentCache=new WeakMap<readonly TimelineItem[],AgentCommand[]>();
/** The agent's shell commands from a timeline: running first, then the 20 newest finished. */
export function agentCommands(items:readonly TimelineItem[]|undefined):AgentCommand[] {
  if(!items)return [];
  const cached=agentCache.get(items);if(cached)return cached;
  const running:AgentCommand[]=[],finished:AgentCommand[]=[];
  for(let index=items.length-1;index>=0;index--){
    const item=items[index];if(item.kind!=='tool')continue;
    const tool=classifyTool(item.data);if(tool.kind!=='command')continue;
    const name=typeof item.data?.name==='string'?item.data.name:tool.subject||'Tool';
    const output=typeof item.data?.output==='string'?item.data.output:item.text.startsWith(name)?item.text.slice(name.length).replace(/^\n/,''):item.text;
    const row={item,command:commandLabel(tool.subject||name),output,running:item.status==='running'};
    if(row.running)running.push(row);else if(finished.length<20)finished.push(row);
  }
  const result=[...running,...finished];agentCache.set(items,result);return result;
}

/** S3-E / DF-F38: listening ports per conversation, polled every few seconds while something shows
 * them (the Terminal list, the summary card). Main caches the lsof scan, so readers are cheap. */
export interface PortsState {ports:ListeningPort[];supported:boolean}
const PORT_POLL_MS=4000,EMPTY_PORTS:PortsState={ports:[],supported:true};
const portStates=new Map<string,PortsState>(),portListeners=new Map<string,Set<()=>void>>(),portTimers=new Map<string,ReturnType<typeof setInterval>>();
const samePorts=(a:ListeningPort[],b:ListeningPort[])=>a.length===b.length&&a.every((port,index)=>port.id===b[index].id&&port.owner===b[index].owner&&JSON.stringify(port.source)===JSON.stringify(b[index].source));
export const listeningPorts=(chatId:string):PortsState=>portStates.get(chatId)??EMPTY_PORTS;
export function refreshListeningPorts(chatId:string):Promise<void> {
  if(!portListeners.get(chatId)?.size)return Promise.resolve();
  if(typeof document!=='undefined'&&document.visibilityState==='hidden')return Promise.resolve();
  return invoke('processes.ports',{chatId}).then((reply:ProcessPortsSnapshot|undefined)=>{
    // An older runtime (or a test host) may not answer this command: treat it as no port data, never a crash.
    const next:ProcessPortsSnapshot=reply&&Array.isArray(reply.ports)?reply:{...(reply??{}),ports:[],supported:false} as ProcessPortsSnapshot;
    const current=portStates.get(chatId);
    if(current&&current.supported===next.supported&&samePorts(current.ports,next.ports))return;
    portStates.set(chatId,{ports:next.ports,supported:next.supported});
    for(const listener of portListeners.get(chatId)??[])listener();
  },()=>{});
}
export function subscribeListeningPorts(chatId:string,listener:()=>void):()=>void {
  let set=portListeners.get(chatId);if(!set){set=new Set();portListeners.set(chatId,set);}
  set.add(listener);
  if(set.size===1){void refreshListeningPorts(chatId);portTimers.set(chatId,setInterval(()=>void refreshListeningPorts(chatId),PORT_POLL_MS));}
  return()=>{
    const current=portListeners.get(chatId);if(!current)return;current.delete(listener);
    if(!current.size){portListeners.delete(chatId);clearInterval(portTimers.get(chatId));portTimers.delete(chatId);portStates.delete(chatId);}
  };
}
export function useListeningPorts(chatId:string|undefined):PortsState {
  const subscribeFor=useCallback((listener:()=>void)=>chatId?subscribeListeningPorts(chatId,listener):()=>{},[chatId]);
  return useSyncExternalStore(subscribeFor,()=>chatId?listeningPorts(chatId):EMPTY_PORTS);
}
/** A listener's local URL: loopback for wildcard/loopback binds, otherwise the bound address. */
export function portURL(port:Pick<ListeningPort,'port'|'address'>):string {
  const host=!port.address||port.address==='*'||port.address==='0.0.0.0'||port.address==='::'||port.address==='127.0.0.1'||port.address==='::1'?'localhost':port.address.includes(':')?`[${port.address}]`:port.address;
  return `http://${host}:${port.port}`;
}
