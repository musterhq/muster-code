import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Copy,FolderOpen,RefreshCw} from 'lucide-react';
import type {DiagnosticsReport} from '../../../shared/domains/settings-protocol';
import {invoke} from '../../bridge';
import {copyText} from '../../clipboard';
import {notifyError,notifySuccess} from '../../store';
import {formatBytes} from './sections';

/** On-demand only: nothing is sampled until this panel opens or Refresh is pressed. */
export function DiagnosticsPanel():React.ReactElement {
  const [report,setReport]=useState<DiagnosticsReport|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const ticket=useRef(0);
  const collect=useCallback(async()=>{
    const mine=++ticket.current;setBusy(true);setError('');
    try{const next=await invoke('settings.diagnostics',{});if(mine===ticket.current)setReport(next);}
    catch(cause){if(mine===ticket.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(mine===ticket.current)setBusy(false);}
  },[]);
  useEffect(()=>{void collect();return()=>{ticket.current++;};},[collect]);
  const copy=async()=>{if(!report)return;try{await copyText(report.redactedText);notifySuccess('Redacted diagnostics copied');}catch(cause){notifyError(cause);}};
  const reveal=(target:'dataDir'|'log')=>void invoke('settings.reveal',{target}).catch(cause=>notifyError(cause));
  const totalKB=report?.processes.reduce((sum,process)=>sum+process.memoryKB,0)??0;
  const totalCPU=report?.processes.reduce((sum,process)=>sum+process.cpuPercent,0)??0;
  return <div className="settings-panel" aria-busy={busy}>
    <div className="settings-panel-actions">
      <span className="settings-panel-meta" role="status">{busy?'Collecting…':report?`Collected ${new Date(report.collectedAt).toLocaleTimeString()}`:''}</span>
      <button type="button" className="settings-button secondary" disabled={busy} onClick={()=>void collect()}><RefreshCw size={14}/>Refresh</button>
      <button type="button" className="settings-button" disabled={!report} onClick={()=>void copy()}><Copy size={14}/>Copy redacted diagnostics</button>
    </div>
    {error&&<p className="settings-error" role="alert">{error}</p>}
    {report&&<>
      <section className="preference-group" aria-labelledby="diagnostics-versions">
        <h3 id="diagnostics-versions" className="preference-group-title">Versions</h3>
        <dl className="settings-facts">
          <dt>App</dt><dd>{report.app.name} {report.app.version}</dd>
          <dt>Electron</dt><dd>{report.electron??'Not running in Electron'}</dd>
          <dt>Chromium</dt><dd>{report.chrome??'—'}</dd>
          <dt>Node</dt><dd>{report.node}</dd>
          <dt>Bundled core</dt><dd className={report.coreLifecycle===1?'':'settings-warn'}>{report.coreLifecycle===null?'Run lifecycle missing — long turns fall back to the legacy timeout. Rebuild the app.':`Run lifecycle v${report.coreLifecycle}`}</dd>
          <dt>System</dt><dd>{report.platform} {report.osRelease} · {report.arch}</dd>
        </dl>
      </section>
      <section className="preference-group" aria-labelledby="diagnostics-paths">
        <h3 id="diagnostics-paths" className="preference-group-title">Locations</h3>
        <div className="preference-row"><span className="preference-copy"><strong>App data</strong><code className="settings-path">{report.dataDir}</code></span><button type="button" className="settings-button secondary" onClick={()=>reveal('dataDir')}><FolderOpen size={14}/>Show in Finder</button></div>
        <div className="preference-row"><span className="preference-copy"><strong>Runtime log</strong><code className="settings-path">{report.logPath}</code></span><button type="button" className="settings-button secondary" onClick={()=>reveal('log')}><FolderOpen size={14}/>Show in Finder</button></div>
      </section>
      <section className="preference-group" aria-labelledby="diagnostics-processes">
        <h3 id="diagnostics-processes" className="preference-group-title">Processes</h3>
        {report.processes.length?<table className="settings-table">
          <thead><tr><th scope="col">Process</th><th scope="col">PID</th><th scope="col" className="numeric">Memory</th><th scope="col" className="numeric">CPU</th></tr></thead>
          <tbody>{report.processes.map(process=><tr key={process.pid}><td>{process.type}{process.name?<span className="settings-muted"> · {process.name}</span>:null}</td><td className="numeric">{process.pid}</td><td className="numeric">{formatBytes(process.memoryKB*1024)}</td><td className="numeric">{process.cpuPercent.toFixed(1)}%</td></tr>)}</tbody>
          <tfoot><tr><th scope="row" colSpan={2}>Total</th><td className="numeric">{formatBytes(totalKB*1024)}</td><td className="numeric">{totalCPU.toFixed(1)}%</td></tr></tfoot>
        </table>:<p className="settings-muted">Process metrics are available in the desktop app.</p>}
      </section>
      <p className="settings-footnote">Diagnostics stay on this Mac. The copy masks your home folder, account name and email addresses.</p>
    </>}
  </div>;
}
