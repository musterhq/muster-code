import type {Chat,Snapshot} from '../shared/protocol.ts';
import {chatGroup,compareChats,type ChatSort} from './chatNavigation.ts';

export const NAV_HISTORY_LIMIT=50;

/** Bounded back/forward stacks over chat selection. Pure: the store binding lives in menuActions. */
export class NavHistory {
  private current:string|null=null;
  private readonly back:string[]=[];
  private readonly forward:string[]=[];
  private navigating=false;
  private readonly listeners=new Set<()=>void>();
  constructor(private readonly limit=NAV_HISTORY_LIMIT){}

  /** Observe the active chat. Programmatic back/forward moves are not recorded as new entries. */
  track(id:string|null):void {
    if(id===this.current)return;
    if(this.navigating){this.current=id;return;}
    if(this.current!==null){
      this.back.push(this.current);
      if(this.back.length>this.limit)this.back.splice(0,this.back.length-this.limit);
      this.forward.length=0;
    }
    this.current=id;
    this.emit();
  }
  get canBack():boolean {return this.back.length>0;}
  get canForward():boolean {return this.forward.length>0;}

  /** Pop the nearest still-valid entry; entries for chats that no longer exist are discarded. */
  goBack(valid:(id:string)=>boolean=()=>true):string|null {return this.move(this.back,this.forward,valid);}
  goForward(valid:(id:string)=>boolean=()=>true):string|null {return this.move(this.forward,this.back,valid);}

  /** Run a selection without recording it; the tracked current id is updated by the store notification. */
  suppressed<T>(run:()=>T):T {
    this.navigating=true;
    try {return run();} finally {this.navigating=false;}
  }
  subscribe(listener:()=>void):()=>void {this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}

  private move(from:string[],to:string[],valid:(id:string)=>boolean):string|null {
    let target:string|undefined;
    while((target=from.pop())!==undefined&&!valid(target));
    if(target===undefined){this.emit();return null;}
    if(this.current!==null)to.push(this.current);
    if(to.length>this.limit)to.splice(0,to.length-this.limit);
    this.current=target;
    this.emit();
    return target;
  }
  private emit():void {for(const listener of this.listeners)listener();}
}

export interface NavHistoryDeps {
  subscribe(listener:()=>void):()=>void;
  activeChatId():string|null;
  exists(id:string):boolean;
  select(id:string):void;
}

export interface NavHistoryHandle {
  history:NavHistory;
  goBack():boolean;
  goForward():boolean;
  dispose():void;
}

/** Bind a history to a store-like source; selection made through goBack/goForward is suppressed from recording. */
export function installNavHistory(deps:NavHistoryDeps,history=new NavHistory()):NavHistoryHandle {
  history.track(deps.activeChatId());
  const unsubscribe=deps.subscribe(()=>history.track(deps.activeChatId()));
  const go=(id:string|null)=>{
    if(id===null)return false;
    history.suppressed(()=>deps.select(id));
    return true;
  };
  return {
    history,
    goBack:()=>go(history.goBack(deps.exists)),
    goForward:()=>go(history.goForward(deps.exists)),
    dispose:unsubscribe,
  };
}

/** Sidebar row order (pinned, folders, projects, loose chats, then archived) for Ctrl+Tab and Cmd+1…9. */
export function chatOrder(snapshot:Pick<Snapshot,'chats'|'folders'|'projects'>,sort:ChatSort):Chat[] {
  const sorted=[...snapshot.chats].sort(compareChats(sort));
  const group=(id:string)=>sorted.filter(chat=>chatGroup(chat,snapshot)===id);
  return [
    ...group('pinned'),
    ...snapshot.folders.flatMap(folder=>group(`folder:${folder.id}`)),
    ...snapshot.projects.flatMap(project=>group(`project:${project.id}`)),
    ...group('chats'),
    ...group('snoozed'),
    ...group('archived'),
  ];
}

/** Neighbour in the visible order, wrapping; null when there is nothing else to go to. */
export function neighbourChat(order:readonly Chat[],activeId:string|null,step:1|-1):Chat|null {
  if(order.length<2&&!(order.length===1&&order[0].id!==activeId))return null;
  const index=activeId?order.findIndex(chat=>chat.id===activeId):-1;
  if(index<0)return step===1?order[0]:order[order.length-1];
  return order[(index+step+order.length)%order.length];
}
