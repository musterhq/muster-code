import type {ScopedComputerExecution,ScopedComputerState} from '../shared/scoped-computer-protocol';

// CSI, OSC (BEL or ST terminated) and two-byte escapes.
const ANSI=/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** Terminal output as plain text: escapes removed, and a carriage return redraws its line (progress bars keep the last frame). */
export function terminalText(text:string):string {
  if(!text.includes('\x1b')&&!text.includes('\r'))return text;
  return text.replace(ANSI,'').split('\n').map(line=>{const clean=line.endsWith('\r')?line.slice(0,-1):line,cut=clean.lastIndexOf('\r');return cut===-1?clean:clean.slice(cut+1);}).join('\n');
}
export function formatBytes(bytes:number):string {
  if(bytes<1024)return `${bytes} B`;
  const units=['KB','MB','GB','TB'];let value=bytes/1024,unit=0;
  while(value>=1024&&unit<units.length-1){value/=1024;unit++;}
  return `${value<10?value.toFixed(1):Math.round(value)} ${units[unit]}`;
}
export const COMPUTER_STATE_LABEL:Record<ScopedComputerState,string>={'not-created':'Not created',running:'Ready',stopped:'Stopped',unavailable:'Unavailable','recovery-needed':'Needs attention',unknown:'Unknown'};
export function runLabel(run:Pick<ScopedComputerExecution,'state'|'exitCode'>&{restored?:boolean}):string {
  switch(run.state){
    case 'running':return 'Running';
    case 'completed':return 'Done';
    case 'failed':return run.exitCode===null?'Failed':`Exit ${run.exitCode}`;
    case 'cancelled':return 'Stopped';
    case 'timed-out':return 'Timed out';
    case 'recovery-needed':return run.restored?'Ended when Muster closed':'Needs attention';
  }
}
export const TIMEOUTS=[{label:'1 min',ms:60_000},{label:'5 min',ms:300_000},{label:'30 min',ms:1_800_000},{label:'1 hour',ms:3_600_000},{label:'2 hours',ms:7_200_000}] as const;
