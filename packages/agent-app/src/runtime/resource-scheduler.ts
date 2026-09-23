import {execFileSync} from 'node:child_process';
import os from 'node:os';

/** PER-06: CPU/RAM-aware admission for concurrent agents and heavy builds.
 *
 * Fixed caps (4 owned commands, 3 live browser pages, per-Project concurrency)
 * bound counts, not cost. This scheduler adds the machine's actual state:
 * - heavy jobs (builds, test suites) run one at a time by default;
 * - while memory pressure is high (little available RAM) or the CPU is
 *   saturated, new automated agent runs and heavy jobs queue instead of
 *   starting, and drain in FIFO order as pressure clears;
 * - something always makes progress: with nothing of that kind running, one
 *   request is admitted even under pressure, so the queue cannot deadlock on
 *   memory held by other apps.
 * One instance per process (shared across the main and runtime bundles). */
export interface ResourceSample {freeBytes:number; totalBytes:number; load1:number; cpus:number}
export interface ResourcePolicy {
  maxAgents:number; maxHeavy:number;
  /** High pressure below this much available memory... */
  minFreeBytes:number;
  /** ...or below this fraction of total memory. */
  minFreeRatio:number;
  /** High CPU pressure above this 1-minute load per logical CPU. */
  maxLoadPerCpu:number;
}
export type ResourceKind='agent'|'heavy';
export interface ResourcePressure {level:'ok'|'high'; reason?:string; sample:ResourceSample}
export interface ResourceLease {kind:ResourceKind; label:string; release():void}
export interface ResourceSnapshot {running:Record<ResourceKind,number>; queued:{kind:ResourceKind;label:string;since:number}[]; pressure:ResourcePressure; policy:ResourcePolicy}
export interface ResourceSchedulerOptions {
  sample?:()=>ResourceSample; policy?:Partial<ResourcePolicy>; pollMs?:number; now?:()=>number;
  /** Agent runs are counted by their owner (running chats), not by leases. */
  countAgents?:()=>number;
}

const GiB=1024**3;
/** Defaults sized from the machine: a 24 GB laptop gets 6 concurrent automated agents and 1 heavy job. */
export function defaultResourcePolicy(totalBytes=os.totalmem()):ResourcePolicy {
  return {maxAgents:Math.max(2,Math.min(8,Math.floor(totalBytes/GiB/4))),maxHeavy:1,minFreeBytes:Math.min(2*GiB,Math.max(512*1024**2,totalBytes*0.06)),minFreeRatio:0.06,maxLoadPerCpu:1.5};
}

let cachedDarwin:{at:number;level:number}|undefined;
/** Available memory: macOS reports free pages only (os.freemem ignores reclaimable cache), so use the
 * kernel's memorystatus level (percent of memory available) there, sampled at most once a second. */
export function systemResourceSample(now=Date.now()):ResourceSample {
  const totalBytes=os.totalmem(),cpus=Math.max(1,os.availableParallelism?.()??os.cpus().length),load1=os.loadavg()[0]??0;
  let freeBytes=os.freemem();
  if(process.platform==='darwin'){
    try{
      if(!cachedDarwin||now-cachedDarwin.at>1000){
        const level=Number(execFileSync('/usr/sbin/sysctl',['-n','kern.memorystatus_level'],{encoding:'utf8',timeout:500}).trim());
        if(Number.isFinite(level)&&level>=0&&level<=100)cachedDarwin={at:now,level};
      }
      if(cachedDarwin)freeBytes=Math.max(freeBytes,Math.round(totalBytes*cachedDarwin.level/100));
    }catch{/* Fall back to os.freemem. */}
  }
  return {freeBytes,totalBytes,load1,cpus};
}

export function classifyPressure(sample:ResourceSample,policy:ResourcePolicy):ResourcePressure {
  const gib=(n:number)=>`${(n/GiB).toFixed(1)} GB`;
  if(sample.freeBytes<policy.minFreeBytes||sample.freeBytes<sample.totalBytes*policy.minFreeRatio)
    return {level:'high',reason:`Memory pressure is high (${gib(sample.freeBytes)} of ${gib(sample.totalBytes)} available)`,sample};
  if(sample.load1/sample.cpus>policy.maxLoadPerCpu)
    return {level:'high',reason:`CPU is saturated (load ${sample.load1.toFixed(1)} on ${sample.cpus} cores)`,sample};
  return {level:'ok',sample};
}

interface Waiter {kind:ResourceKind; label:string; since:number; resolve:(lease:ResourceLease)=>void; reject:(error:Error)=>void; onQueued?:(reason:string)=>void; reason?:string; cleanup:()=>void}

export class ResourceScheduler {
  readonly policy:ResourcePolicy;
  private sampleFn:()=>ResourceSample; private pollMs:number; private now:()=>number;
  private held:Record<ResourceKind,number>={agent:0,heavy:0};
  private queue:Waiter[]=[];
  private poller?:ReturnType<typeof setInterval>;
  countAgents?:()=>number;
  constructor(options:ResourceSchedulerOptions={}) {
    this.sampleFn=options.sample??(()=>systemResourceSample());
    const base=defaultResourcePolicy(options.sample?options.sample().totalBytes:os.totalmem());
    this.policy={...base,...options.policy};
    this.pollMs=Math.max(10,options.pollMs??2000);
    this.now=options.now??Date.now;
    this.countAgents=options.countAgents;
  }
  pressure():ResourcePressure {return classifyPressure(this.sampleFn(),this.policy);}
  private running(kind:ResourceKind):number {return kind==='agent'?Math.max(this.held.agent,this.countAgents?.()??0):this.held.heavy;}
  private limit(kind:ResourceKind):number {return kind==='agent'?this.policy.maxAgents:this.policy.maxHeavy;}
  /** Why `kind` cannot start right now, or undefined when it can. */
  blocked(kind:ResourceKind,pressure=this.pressure()):string|undefined {
    const running=this.running(kind);
    if(running>=this.limit(kind))return kind==='heavy'?'Waiting for the running build or test to finish':`Waiting for a free agent slot (${running} of ${this.limit(kind)} running)`;
    // Progress guarantee: the first job of a kind always starts.
    if(pressure.level==='high'&&running>0)return `${pressure.reason}; waiting to start`;
    return undefined;
  }
  /** Admission without a lease (agent runs are counted by countAgents). */
  admits(kind:ResourceKind):{ok:boolean;reason?:string} {
    if(this.queue.some(waiter=>waiter.kind===kind))return {ok:false,reason:'Earlier work is queued first'};
    const reason=this.blocked(kind);return reason?{ok:false,reason}:{ok:true};
  }
  private lease(kind:ResourceKind,label:string):ResourceLease {
    this.held[kind]++;let released=false;
    return {kind,label,release:()=>{if(released)return;released=true;this.held[kind]--;this.drain();}};
  }
  tryAcquire(kind:ResourceKind,label='work'):ResourceLease|undefined {
    return this.admits(kind).ok?this.lease(kind,label):undefined;
  }
  /** Resolves with a lease once admitted; rejects if `signal` aborts while queued. */
  acquire(kind:ResourceKind,options:{label?:string;signal?:AbortSignal;onQueued?:(reason:string)=>void}={}):Promise<ResourceLease> {
    const label=options.label??'work';
    if(options.signal?.aborted)return Promise.reject(new Error('Cancelled while queued.'));
    const now=this.admits(kind);
    if(now.ok)return Promise.resolve(this.lease(kind,label));
    return new Promise((resolve,reject)=>{
      const abort=()=>{this.queue=this.queue.filter(item=>item!==waiter);this.schedulePoll();reject(new Error('Cancelled while queued.'));};
      const waiter:Waiter={kind,label,since:this.now(),resolve,reject,onQueued:options.onQueued,reason:now.reason,cleanup:()=>options.signal?.removeEventListener('abort',abort)};
      options.signal?.addEventListener('abort',abort,{once:true});
      this.queue.push(waiter);waiter.onQueued?.(now.reason??'Queued');
      this.schedulePoll();
    });
  }
  /** Admit queued work in FIFO order per kind while resources allow. */
  drain():number {
    let admitted=0;
    if(!this.queue.length){this.schedulePoll();return 0;}
    const pressure=this.pressure();
    for(const kind of ['heavy','agent'] as const){
      while(true){
        const next=this.queue.find(item=>item.kind===kind);
        if(!next)break;
        const reason=this.blocked(kind,pressure);
        if(reason){if(reason!==next.reason){next.reason=reason;next.onQueued?.(reason);}break;}
        this.queue=this.queue.filter(item=>item!==next);next.cleanup();
        next.resolve(this.lease(kind,next.label));admitted++;
      }
    }
    this.schedulePoll();
    return admitted;
  }
  private schedulePoll():void {
    if(this.queue.length&&!this.poller){this.poller=setInterval(()=>this.drain(),this.pollMs);this.poller.unref?.();}
    else if(!this.queue.length&&this.poller){clearInterval(this.poller);this.poller=undefined;}
  }
  snapshot():ResourceSnapshot {
    return {running:{agent:this.running('agent'),heavy:this.held.heavy},queued:this.queue.map(({kind,label,since})=>({kind,label,since})),pressure:this.pressure(),policy:{...this.policy}};
  }
  dispose():void {
    for(const waiter of this.queue.splice(0)){waiter.cleanup();waiter.reject(new Error('Shutting down.'));}
    this.schedulePoll();
  }
}

const SHARED=Symbol.for('muster.resourceScheduler');
/** The process-wide scheduler; main and runtime bundles share it through a global symbol. */
export function sharedResourceScheduler():ResourceScheduler {
  const holder=globalThis as unknown as Record<symbol,ResourceScheduler|undefined>;
  return holder[SHARED]??=new ResourceScheduler();
}
