import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Archive,Cpu,Layers,Play,Plus,RotateCw,Server,Square,Trash2} from 'lucide-react';
import {SCOPED_COMPUTER_LIMIT_BOUNDS,type ScopedComputerEvent,type ScopedComputerExportManifest,type ScopedComputerLayer,type ScopedComputerLayerId,type ScopedComputerLayerSource,type ScopedComputerLimits,type ScopedComputerRef,type ScopedComputerRestartPolicy,type ScopedComputerService,type ScopedComputerServices,type ScopedComputerStatus,type ScopedComputerUsage} from '../../shared/scoped-computer-protocol';
import {invoke,subscribe} from '../bridge';
import {formatBytes} from '../scopedComputerText';

const message=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);
export const MEMORY_CHOICES=[256,512,1024,2048,4096,8192,16384];
export const CPU_CHOICES=[0.25,0.5,1,1.5,2,3,4,6,8];
export const PROCESS_CHOICES=[64,128,256,512,1024,2048,4096];
const RESTART_LABEL:Record<ScopedComputerRestartPolicy,string>={never:'Never restart','on-failure':'Restart on failure',always:'Always restart'};
const SERVICE_STATE_LABEL:Record<ScopedComputerService['state'],string>={starting:'Starting',running:'Running',stopped:'Stopped',exited:'Exited',failed:'Failed',lost:'Lost',backoff:'Restarting'};
/** Percent of a limit, clamped for the meter; null when either side is unknown. */
export function usagePercent(used:number|null,limit:number|null):number|null {return used===null||!limit?null:Math.max(0,Math.min(100,Math.round(used/limit*100)));}
/** Parses `NAME=value` lines; blank lines and `#` comments are skipped. Throws on a malformed line. */
export function parseEnvLines(text:string):Record<string,string> {
  const env:Record<string,string>={};
  for(const raw of text.split('\n')){const line=raw.trim();if(!line||line.startsWith('#'))continue;const at=line.indexOf('=');if(at<1)throw new Error(`Use NAME=value (line “${line.slice(0,40)}”).`);env[line.slice(0,at).trim()]=line.slice(at+1);}
  return env;
}
const withMax=(choices:number[],value:number)=>choices.includes(value)?choices:[...choices,value].sort((a,b)=>a-b);

/**
 * Sandbox settings under the terminal: resource limits with live usage (SBX-08), supervised services with their boot
 * generation (SBX-15), read-only tool/skill layers and whole-workspace archive export (SBX-16).
 */
export function SandboxControls({scope,computer,busy,onStatus}:{scope:ScopedComputerRef;computer:ScopedComputerStatus|undefined;busy:boolean;onStatus:(status:ScopedComputerStatus)=>void}) {
  const [error,setError]=useState(''),[working,setWorking]=useState('');
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const act=async<T,>(label:string,task:()=>Promise<T>,apply?:(value:T)=>void)=>{
    if(working)return;setWorking(label);setError('');
    try {const value=await task();if(alive.current)apply?.(value);}catch(cause){if(alive.current)setError(message(cause));}finally{if(alive.current)setWorking('');}
  };
  const disabled=busy||!!working||!computer||computer.state==='recovery-needed';
  return <section className="sbx-controls" aria-label="Sandbox settings">
    {error&&<p className="sbx-error" role="alert">{error}</p>}
    <ResourcesSection scope={scope} computer={computer} disabled={disabled} working={working} act={act} onStatus={onStatus}/>
    <ServicesSection scope={scope} computer={computer} disabled={disabled} act={act}/>
    <LayersSection scope={scope} computer={computer} disabled={disabled} working={working} act={act} onStatus={onStatus}/>
    <ExportSection scope={scope} disabled={disabled} working={working} act={act}/>
  </section>;
}
type Act=<T,>(label:string,task:()=>Promise<T>,apply?:(value:T)=>void)=>Promise<void>;

function ResourcesSection({scope,computer,disabled,working,act,onStatus}:{scope:ScopedComputerRef;computer?:ScopedComputerStatus;disabled:boolean;working:string;act:Act;onStatus:(status:ScopedComputerStatus)=>void}) {
  const current:ScopedComputerLimits|undefined=computer?{memoryMiB:computer.limits.memoryMiB,cpus:computer.limits.cpus,processes:computer.limits.processes}:undefined;
  const [draft,setDraft]=useState<ScopedComputerLimits>();
  useEffect(()=>{setDraft(current);},[current?.memoryMiB,current?.cpus,current?.processes]);
  const [usage,setUsage]=useState<ScopedComputerUsage>();
  const running=computer?.state==='running';
  useEffect(()=>{
    if(!running){setUsage(undefined);return;}
    let stopped=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try {const value=await invoke('computer.usage',{scope});if(!stopped)setUsage(value);}catch {}if(!stopped)timer=setTimeout(()=>void poll(),2000);};
    void poll();return()=>{stopped=true;clearTimeout(timer);};
  },[scope.kind,scope.id,running]);
  const changed=!!draft&&!!current&&(draft.memoryMiB!==current.memoryMiB||draft.cpus!==current.cpus||draft.processes!==current.processes);
  const memory=usagePercent(usage?.memoryBytes??null,usage?.memoryLimitBytes??null),cpu=usage?.cpuPercent!=null&&current?Math.min(100,Math.round(usage.cpuPercent/current.cpus)):null,pids=usagePercent(usage?.pids??null,current?.processes??null);
  return <div className="sbx-section" role="group" aria-label="Resources">
    <h3><Cpu size={13} aria-hidden="true"/>Resources <small>enforced by the container’s cgroup</small></h3>
    {draft&&<div className="sbx-limit-row">
      <label>Memory<select aria-label="Memory limit" value={draft.memoryMiB} disabled={disabled} onChange={event=>setDraft({...draft,memoryMiB:Number(event.target.value)})}>{withMax(MEMORY_CHOICES,draft.memoryMiB).filter(v=>v>=SCOPED_COMPUTER_LIMIT_BOUNDS.memoryMiB.min).map(v=><option key={v} value={v}>{v>=1024?`${v/1024} GB`:`${v} MB`}</option>)}</select></label>
      <label>CPUs<select aria-label="CPU limit" value={draft.cpus} disabled={disabled} onChange={event=>setDraft({...draft,cpus:Number(event.target.value)})}>{withMax(CPU_CHOICES,draft.cpus).map(v=><option key={v} value={v}>{v}</option>)}</select></label>
      <label>Processes<select aria-label="Process limit" value={draft.processes} disabled={disabled} onChange={event=>setDraft({...draft,processes:Number(event.target.value)})}>{withMax(PROCESS_CHOICES,draft.processes).map(v=><option key={v} value={v}>{v}</option>)}</select></label>
      <button className="is-primary" disabled={disabled||!changed} title="Recreates the container with the new limits; /workspace files are kept" onClick={()=>void act('limits',()=>invoke('computer.setLimits',{scope,limits:draft}),onStatus)}>{working==='limits'?'Applying…':'Apply'}</button>
    </div>}
    {changed&&<p className="sbx-hint">Applying recreates the container. Anything running stops; files in /workspace are kept.</p>}
    <div className="sbx-meters" aria-live="polite">
      <Meter label="Memory" percent={memory} text={usage?.memoryBytes!=null?`${formatBytes(usage.memoryBytes)} of ${formatBytes(usage.memoryLimitBytes??current!.memoryMiB*1024**2)}`:running?'measuring…':'not running'}/>
      <Meter label="CPU" percent={cpu} text={usage?.cpuPercent!=null?`${usage.cpuPercent.toFixed(1)}% of ${current?.cpus} CPU${current?.cpus===1?'':'s'}`:running?'measuring…':'not running'}/>
      <Meter label="Processes" percent={pids} text={usage?.pids!=null?`${usage.pids} of ${current?.processes}`:running?'measuring…':'not running'}/>
    </div>
  </div>;
}
function Meter({label,percent,text}:{label:string;percent:number|null;text:string}) {
  return <div className="sbx-meter"><span className="sbx-meter-label">{label}</span>
    <span className="sbx-meter-track" role="meter" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent??0} aria-valuetext={text}><span className={`sbx-meter-fill${percent!==null&&percent>=90?' is-high':''}`} style={{width:`${percent??0}%`}}/></span>
    <span className="sbx-meter-text">{text}</span></div>;
}

function ServicesSection({scope,computer,disabled,act}:{scope:ScopedComputerRef;computer?:ScopedComputerStatus;disabled:boolean;act:Act}) {
  const [data,setData]=useState<ScopedComputerServices>();
  const [adding,setAdding]=useState(false),[open,setOpen]=useState<string>();
  const [form,setForm]=useState({name:'',command:'',cwd:'/workspace',env:'',restart:'on-failure' as ScopedComputerRestartPolicy,start:true});
  const load=useCallback(()=>{invoke('computer.services.list',{scope}).then(setData,()=>{});},[scope.kind,scope.id]);
  useEffect(()=>{load();},[load,computer?.state,computer?.bootGeneration]);
  useEffect(()=>subscribe(raw=>{const event=raw as unknown as ScopedComputerEvent;if(event.type==='computerServices'&&event.computerId===computer?.id)setData({computerId:event.computerId,bootGeneration:event.bootGeneration,services:event.services});}),[computer?.id]);
  // Output tails are not pushed; refresh them while a row is expanded.
  useEffect(()=>{if(!open)return;const timer=setInterval(load,2000);return()=>clearInterval(timer);},[open,load]);
  const running=computer?.state==='running';
  const register=()=>void act('service',async()=>invoke('computer.services.register',{scope,service:{name:form.name,command:form.command,cwd:form.cwd,env:parseEnvLines(form.env),restart:form.restart},start:form.start}),()=>{setAdding(false);setForm(current=>({...current,name:'',command:'',env:''}));load();});
  return <div className="sbx-section" role="group" aria-label="Services">
    <h3><Server size={13} aria-hidden="true"/>Services <small>{data?`boot ${data.bootGeneration}`:''}</small>
      <button className="sbx-mini" disabled={disabled} onClick={()=>setAdding(value=>!value)}><Plus size={11}/>Register</button></h3>
    {adding&&<form className="sbx-service-form" onSubmit={event=>{event.preventDefault();register();}}>
      <input type="text" aria-label="Service name" placeholder="Name (e.g. dev server)" value={form.name} onChange={event=>{const value=event.target.value;setForm(current=>({...current,name:value}));}}/>
      <input type="text" aria-label="Service command" placeholder="Command (e.g. npm run dev)" value={form.command} onChange={event=>{const value=event.target.value;setForm(current=>({...current,command:value}));}}/>
      <input type="text" aria-label="Service folder" placeholder="/workspace" value={form.cwd} onChange={event=>{const value=event.target.value;setForm(current=>({...current,cwd:value}));}}/>
      <textarea aria-label="Service environment" rows={2} placeholder={'NAME=value per line'} value={form.env} onChange={event=>{const value=event.target.value;setForm(current=>({...current,env:value}));}}/>
      <select aria-label="Restart policy" value={form.restart} onChange={event=>{const value=event.target.value as ScopedComputerRestartPolicy;setForm(current=>({...current,restart:value}));}}>{(Object.keys(RESTART_LABEL) as ScopedComputerRestartPolicy[]).map(key=><option key={key} value={key}>{RESTART_LABEL[key]}</option>)}</select>
      <label className="sbx-check"><input type="checkbox" checked={form.start} onChange={event=>{const value=event.target.checked;setForm(current=>({...current,start:value}));}}/>Start now</label>
      <button type="submit" className="is-primary" disabled={disabled||!form.name.trim()||!form.command.trim()}>Register</button>
      <p className="sbx-hint">Restart policies are opt-in. “On failure” restarts after a non-zero exit or a sandbox restart that stopped it; “Always” after any exit. Backoff doubles per restart; five within a minute stops supervision.</p>
    </form>}
    {data?.services.length?<ul className="sbx-services">{data.services.map(service=>{
      const up=service.state==='running'||service.state==='backoff'||service.state==='starting';
      const stale=data.bootGeneration>service.bootGeneration;
      return <li key={service.id} className={`sbx-service is-${service.state}`}>
        <div className="sbx-service-head">
          <button className="sbx-service-name" aria-expanded={open===service.id} onClick={()=>setOpen(value=>value===service.id?undefined:service.id)}>{service.name}{service.role==='browser'?' · browser':''}</button>
          <span className={`sbx-pill is-${service.state}`}>{SERVICE_STATE_LABEL[service.state]}</span>
          <span className="sbx-service-meta" title={stale?'Last started before the most recent sandbox restart':'Started in the current sandbox boot'}>{RESTART_LABEL[service.restart]} · boot {service.bootGeneration}{stale?' (earlier)':''}{service.restarts?` · ${service.restarts} restart${service.restarts===1?'':'s'}`:''}</span>
          {up?<button className="icon-button" aria-label={`Stop ${service.name}`} disabled={disabled} onClick={()=>void act('service',()=>invoke('computer.services.stop',{scope,serviceId:service.id}),load)}><Square size={11}/></button>
            :<button className="icon-button" aria-label={`Start ${service.name}`} disabled={disabled||!running} title={running?'Start':'Start the sandbox first'} onClick={()=>void act('service',()=>invoke('computer.services.start',{scope,serviceId:service.id}),load)}>{service.startedAt?<RotateCw size={11}/>:<Play size={11}/>}</button>}
          {service.role!=='browser'&&<button className="icon-button" aria-label={`Remove ${service.name}`} disabled={disabled} onClick={()=>void act('service',()=>invoke('computer.services.remove',{scope,serviceId:service.id}),setData)}><Trash2 size={11}/></button>}
        </div>
        <code className="sbx-service-command">{service.cwd&&service.cwd!=='/workspace'?`cd ${service.cwd} && `:''}{service.command.split('\n')[0]}</code>
        {service.reason&&<p className="sbx-run-note">{service.reason}</p>}
        {open===service.id&&<pre className="sbx-service-output" aria-label={`${service.name} output`}>{service.output||'No output captured in this session.'}</pre>}
      </li>;})}</ul>
      :<p className="sbx-empty">No services. Register a long-running command (a dev server, a database) to keep it supervised in this sandbox.</p>}
  </div>;
}

function LayersSection({scope,computer,disabled,working,act,onStatus}:{scope:ScopedComputerRef;computer?:ScopedComputerStatus;disabled:boolean;working:string;act:Act;onStatus:(status:ScopedComputerStatus)=>void}) {
  const [info,setInfo]=useState<{sources:ScopedComputerLayerSource[];active:ScopedComputerLayer[]}>();
  const [chosen,setChosen]=useState<ScopedComputerLayerId[]>([]);
  const activeKey=(computer?.layers??[]).map(layer=>`${layer.id}@${layer.version}`).join(',');
  useEffect(()=>{invoke('computer.layers.sources',{scope}).then(value=>{setInfo(value);setChosen(value.active.map(layer=>layer.id));},()=>{});},[scope.kind,scope.id,activeKey]);
  if(!info)return null;
  const active=new Set(info.active.map(layer=>layer.id)),changed=chosen.length!==active.size||chosen.some(id=>!active.has(id));
  return <div className="sbx-section" role="group" aria-label="Read-only layers">
    <h3><Layers size={13} aria-hidden="true"/>Read-only layers <small>versioned tools and skills</small></h3>
    <ul className="sbx-layers">{info.sources.map(source=>{const mounted=info.active.find(layer=>layer.id===source.id);return <li key={source.id}>
      <label className="sbx-check"><input type="checkbox" disabled={disabled||(!source.available&&!mounted)} checked={chosen.includes(source.id)} onChange={event=>setChosen(list=>event.target.checked?[...list,source.id]:list.filter(id=>id!==source.id))}/>{source.label}</label>
      <span className="sbx-service-meta">{mounted?`${mounted.target} · v${mounted.version}`:source.available?'available':source.reason??'unavailable'}</span>
    </li>;})}</ul>
    <div className="sbx-limit-row">
      <button disabled={disabled||(!changed&&!chosen.length)} title="Snapshots the chosen sources (a new version when their content changed) and recreates the container with them mounted read-only" onClick={()=>void act('layers',()=>invoke('computer.layers.set',{scope,layers:chosen}),onStatus)}>{working==='layers'?'Applying…':changed||!chosen.length?'Apply':'Refresh versions'}</button>
    </div>
  </div>;
}

function ExportSection({scope,disabled,working,act}:{scope:ScopedComputerRef;disabled:boolean;working:string;act:Act}) {
  const [saved,setSaved]=useState<{savedTo:string;manifest:ScopedComputerExportManifest}>();
  return <div className="sbx-section" role="group" aria-label="Export">
    <h3><Archive size={13} aria-hidden="true"/>Export</h3>
    <div className="sbx-limit-row"><button disabled={disabled} onClick={()=>void act('export',()=>invoke('computer.export',{scope}),value=>{if(value)setSaved(value);})}>{working==='export'?'Exporting…':'Export workspace archive…'}</button></div>
    {saved&&<p className="sbx-hint" role="status">Saved {saved.savedTo.split('/').at(-1)} · {saved.manifest.files.toLocaleString()} files, {saved.manifest.directories.toLocaleString()} folders{saved.manifest.symlinks?`, ${saved.manifest.symlinks} links (kept as links)`:''} · {formatBytes(saved.manifest.bytes)} → {formatBytes(saved.manifest.archiveBytes)} · manifest saved beside it</p>}
  </div>;
}
