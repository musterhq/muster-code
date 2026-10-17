import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document});
let reads=0;
(window as any).muster={subscribe:()=>()=>{},async invoke(command:string){
  if(command==='updates.status'){reads++;if(reads===1)throw new Error('runtime starting');return {phase:'ready',autoCheck:true,latest:{version:'9.9.9'}};}
}};
const timers:Function[]=[];const realSet=globalThis.setTimeout;
(globalThis as any).setTimeout=(fn:Function,ms?:number,...a:any[])=>ms===15000?(timers.push(fn),0):(realSet as any)(fn,ms,...a);
const React=await import('react');const {createRoot}=await import('react-dom/client');
const {useUpdateStatus}=await import('../src/renderer/updates');
function Probe(){const s=useUpdateStatus();return <p id="p">{s?.phase??'none'}</p>;}
const root=createRoot(document.getElementById('root')!);root.render(<Probe/>);
await delay(50);
assert.equal(document.getElementById('p')!.textContent,'none');
assert.equal(timers.length,1,'a failed first status read schedules a retry');
timers[0]();await delay(50);
assert.equal(document.getElementById('p')!.textContent,'ready','the retry fills in the update status');
console.log('update-status-retry-dom: ok');process.exit(0);
