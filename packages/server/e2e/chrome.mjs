// Headless Chrome over CDP for the E2E: --headless=new, a temporary --user-data-dir removed on close, no visible window.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
const CANDIDATES = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
export const chromePath = () => CANDIDATES.find(p => p && existsSync(p));

export async function launch({ width = 1440, height = 900, port = 9339, profileRoot = tmpdir() } = {}) {
  const exe = chromePath();
  if (!exe) throw new Error('Chrome not found; set CHROME_PATH.');
  const profile = mkdtempSync(join(profileRoot, 'muster-server-e2e-chrome-'));
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-gpu', '--disable-background-networking', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 80 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch {} if (!target) await sleep(250); }
  if (!target) { proc.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true }); throw new Error('Chrome did not start.'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let n = 0; const pending = new Map(); const console = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') console.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
    if (m.method === 'Runtime.exceptionThrown') console.push(`EXCEPTION: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
  };
  const call = (method, params = {}) => new Promise(r => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await call('Runtime.enable'); await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return {
    console,
    async goto(url, waitMs = 2500) { await call('Page.navigate', { url }); await sleep(waitMs); },
    async eval(expr) {
      const r = await call('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
      return r.result?.result?.value;
    },
    async shot(file) { const { result } = await call('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(result.data, 'base64')); return file; },
    async close() { try { ws.close(); } catch {} proc.kill('SIGTERM'); await sleep(700); try { proc.kill('SIGKILL'); } catch {} rmSync(profile, { recursive: true, force: true }); },
    pid: proc.pid,
  };
}

/** In-page helpers. */
export const H = `
const w=ms=>new Promise(r=>setTimeout(r,ms));
const all=s=>[...document.querySelectorAll(s)];
const txt=e=>(e?.textContent??'').replace(/\\s+/g,' ').trim();
const byText=(s,t)=>all(s).find(e=>txt(e).includes(t));
const until=async(fn,ms=10000)=>{const t=Date.now();while(Date.now()-t<ms){try{const v=fn();if(v)return v;}catch{}await w(150);}return null;};
const setVal=async(el,v)=>{const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));await w(150);};
`;
