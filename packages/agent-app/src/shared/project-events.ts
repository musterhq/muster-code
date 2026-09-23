/** PRJ-07: sequenced Project change feed shared by the runtime log and its clients. */
export interface ProjectFeedEvent {seq:number; projectId:string; taskId:string; at:string}
export interface ProjectEventsPage {
  events:ProjectFeedEvent[];
  /** Highest sequence the server has issued for this Project (0 when none). */
  latest:number;
  /** True when the client's cursor is older than the retained window, or ahead of the server: reload the snapshot. */
  reset:boolean;
  /** True when more events follow; ask again after the last one returned. */
  more:boolean;
}


/** Client side: decides whether a live event applies in order or reveals a gap that needs replay. */
export class ProjectEventCursor {
  private seen=new Map<string,number>();
  last(projectId:string):number|undefined {return this.seen.get(projectId);}
  /** Baseline from a snapshot read (project.work) or the first event. */
  reset(projectId:string,latest:number):void {this.seen.set(projectId,latest);}
  /** 'apply' in-order, 'duplicate' already seen, 'gap' events were missed (replay from last()). */
  observe(projectId:string,seq:number|undefined):'apply'|'duplicate'|'gap' {
    if(seq===undefined)return 'apply';
    const last=this.seen.get(projectId);
    if(last===undefined){this.seen.set(projectId,seq);return 'apply';}
    if(seq<=last)return 'duplicate';
    if(seq===last+1){this.seen.set(projectId,seq);return 'apply';}
    return 'gap';
  }
  /** Apply a replay page; returns true when the client must reload the snapshot instead. */
  replayed(projectId:string,page:ProjectEventsPage):boolean {
    if(page.reset){this.seen.set(projectId,page.latest);return true;}
    const last=page.events.at(-1);if(last)this.seen.set(projectId,last.seq);
    return false;
  }
}

/** Replay everything after the cursor (paging until caught up). `changed` is true when the client
 * must refresh: missed events arrived or the server asked for a snapshot reload. */
export async function replayProjectEvents(projectId:string,cursor:ProjectEventCursor,fetchPage:(after:number)=>Promise<ProjectEventsPage>):Promise<{changed:boolean;reset:boolean;events:ProjectFeedEvent[]}> {
  const events:ProjectFeedEvent[]=[];
  for(let pages=0;pages<50;pages++){
    const after=cursor.last(projectId)??0;
    const page=await fetchPage(after);
    if(cursor.replayed(projectId,page))return {changed:true,reset:true,events};
    events.push(...page.events);
    if(!page.more)break;
  }
  return {changed:events.length>0,reset:false,events};
}
