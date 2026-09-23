import type {DatabaseSync} from 'node:sqlite';
import type {ProjectEventsPage} from '../shared/project-events.ts';
export type {ProjectEventsPage,ProjectFeedEvent} from '../shared/project-events.ts';

/** PRJ-07: sequenced, replayable Project change feed.
 *
 * Every projectChanged event gets a per-Project sequence number and a durable
 * row. A client remembers the last sequence it applied; after a reconnect, a
 * hidden window or a dropped event it asks for everything after that number and
 * gets the missed events in order. Only the newest RETAINED events per Project
 * are kept; asking from before that window answers `reset`, meaning "reload the
 * Project work state" (the snapshot), never a silent partial replay. */
export const PROJECT_EVENTS_RETAINED=500;
export const PROJECT_EVENTS_PAGE=200;
export class ProjectEventLog {
  private ready=false;
  private appended=0;
  constructor(private db:DatabaseSync,private retained=PROJECT_EVENTS_RETAINED) {}
  private init():void {
    if(this.ready)return;
    this.db.exec('CREATE TABLE IF NOT EXISTS project_events (project_id TEXT NOT NULL, seq INTEGER NOT NULL, task_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (project_id, seq)) WITHOUT ROWID');
    this.ready=true;
  }
  /** Record one change and return its sequence number. */
  append(projectId:string,taskId='',at=new Date().toISOString()):number {
    this.init();
    const row=this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM project_events WHERE project_id = ?').get(projectId) as {seq:number};
    const seq=Number(row.seq)+1;
    this.db.prepare('INSERT INTO project_events (project_id, seq, task_id, at) VALUES (?, ?, ?, ?)').run(projectId,seq,taskId,at);
    if(++this.appended%50===0||seq%this.retained===0)this.db.prepare('DELETE FROM project_events WHERE project_id = ? AND seq <= ?').run(projectId,seq-this.retained);
    return seq;
  }
  latest(projectId:string):number {
    this.init();
    return Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM project_events WHERE project_id = ?').get(projectId) as {seq:number}).seq);
  }
  /** Events after `after`, oldest first. */
  since(projectId:string,after:number,limit=PROJECT_EVENTS_PAGE):ProjectEventsPage {
    this.init();
    if(!Number.isSafeInteger(after)||after<0)throw new Error('Invalid event cursor.');
    const bounds=this.db.prepare('SELECT COALESCE(MIN(seq),0) AS oldest, COALESCE(MAX(seq),0) AS latest FROM project_events WHERE project_id = ?').get(projectId) as {oldest:number;latest:number};
    const oldest=Number(bounds.oldest),latest=Number(bounds.latest);
    // Nothing between the cursor and the oldest retained row may be missing.
    if(after>latest||(latest>0&&after<oldest-1))return {events:[],latest,reset:true,more:false};
    const size=Math.max(1,Math.min(PROJECT_EVENTS_PAGE,Math.floor(limit)));
    const rows=this.db.prepare('SELECT seq, task_id, at FROM project_events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(projectId,after,size) as {seq:number;task_id:string;at:string}[];
    const events=rows.map(row=>({seq:Number(row.seq),projectId,taskId:row.task_id,at:row.at}));
    return {events,latest,reset:false,more:events.length>0&&events.at(-1)!.seq<latest};
  }
}

