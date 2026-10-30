// Devices (#363) idle and leak budget, in the real renderer under headless Chrome (fictional bridge, canvas-drawn
// frames). Prints JSON: animation frames and long tasks while a device view sits idle (flat and 3D), and JS heap,
// live WebGL engines and DOM nodes across 50 open/close cycles of the 3D view.
//   SHOTS_FILE=scripts/readme-shots/device-perf.mjs SHOTS_TMP=<dir> node scripts/readme-shots/shoot.mjs --probe device-perf
const IPHONE = '6B1F0C4A-2E7D-4C55-9A0B-1F2E3D4C5B6A';
const idle = async (ctx, label) => {
  const r = await ctx.evaluate(`
    let raf = 0; const orig = window.requestAnimationFrame; window.requestAnimationFrame = cb => { raf++; return orig(cb); };
    let long = 0; const obs = new PerformanceObserver(list => { long += list.getEntries().length; }); try { obs.observe({type: 'longtask', buffered: false}); } catch {}
    await new Promise(r => setTimeout(r, 4000));
    window.requestAnimationFrame = orig; obs.disconnect();
    return {raf, longTasks: long};`);
  return {label, ...r};
};
// Main-thread cost of a live stream: 150 frames at 30 fps into the open view. Script and task time come from CDP's
// Performance metrics (seconds of main-thread work over the run), commits from React's DevTools hook.
const streaming = async (ctx, label) => {
  await ctx.cdp.call('Performance.enable', {timeMethod: 'threadTicks'});
  const metric = async () => Object.fromEntries((await ctx.cdp.call('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  await ctx.evaluate(`window.__commits = 0`);
  const a = await metric();
  const t0 = Date.now();
  await ctx.evaluate(`await window.__devicePump(150, 30)`);
  const wall = (Date.now() - t0) / 1000;
  const b = await metric();
  const commits = await ctx.evaluate(`return window.__commits`);
  const ms = key => +(((b[key] ?? 0) - (a[key] ?? 0)) * 1000).toFixed(1);
  return {label, wallS: +wall.toFixed(2), scriptMs: ms('ScriptDuration'), taskMs: ms('TaskDuration'), layoutMs: ms('LayoutDuration'), styleMs: ms('RecalcStyleDuration'), reactCommits: commits, mainThreadPct: +(ms('TaskDuration') / (wall * 10)).toFixed(1)};
};
const heap = async (ctx) => {
  await ctx.cdp.call('HeapProfiler.collectGarbage');
  const {usedSize} = await ctx.cdp.call('Runtime.getHeapUsage');
  const dom = await ctx.evaluate(`return document.getElementsByTagName('*').length`);
  return {heapMB: +(usedSize / 1048576).toFixed(2), dom};
};
// React commits: count every commit through the DevTools hook (installed before React loads).
const COMMIT_HOOK = `window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {supportsFiber: true, renderers: new Map(), inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; }, onCommitFiberRoot() { window.__commits = (window.__commits || 0) + 1; }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}};`;
export const SHOTS = [{name: 'device-perf', local: true, opts: {devices: 'live'}, settle: 100, async run(ctx) {
  await ctx.cdp.call('Emulation.setFocusEmulationEnabled', {enabled: true});
  await ctx.cdp.call('Page.addScriptToEvaluateOnNewDocument', {source: COMMIT_HOOK});
  await ctx.cdp.call('Page.reload');
  await ctx.sleep(1500);
  const out = {};
  await ctx.store(`s.openTab({id:'device:${IPHONE}',kind:'device',deviceId:'${IPHONE}',title:'iPhone'})`);
  await ctx.sleep(2500);
  out.flatIdle = await idle(ctx, 'flat view, frames stopped');
  out.flatStream = await streaming(ctx, 'flat view, 30 fps');
  // 3D on.
  await ctx.evaluate(`document.querySelector('[aria-label="3D view"]').click()`);
  await ctx.sleep(3000);
  out.threeIdle = await idle(ctx, '3D view, frames stopped');
  out.threeStream = await streaming(ctx, '3D view, 30 fps');
  out.before = await heap(ctx);
  for (let i = 0; i < 50; i++) {
    await ctx.evaluate(`document.querySelector('[aria-label="Flat view"]')?.click()`); await ctx.sleep(60);
    await ctx.evaluate(`document.querySelector('[aria-label="3D view"]')?.click()`); await ctx.sleep(140);
  }
  await ctx.sleep(1500);
  out.after50 = await heap(ctx);
  for (let i = 0; i < 50; i++) {
    await ctx.evaluate(`document.querySelector('[aria-label="Flat view"]')?.click()`); await ctx.sleep(60);
    await ctx.evaluate(`document.querySelector('[aria-label="3D view"]')?.click()`); await ctx.sleep(140);
  }
  await ctx.sleep(1500);
  out.after100 = await heap(ctx);
  out.webglCanvases = await ctx.evaluate(`return document.querySelectorAll('.device-3d canvas').length`);
  // PiP: another tab in front, the device plays in its card.
  await ctx.store(`s.openTab({id:'files:f-taskboard',kind:'files',folderId:'f-taskboard',title:'taskboard'})`);
  await ctx.sleep(1500);
  out.pipStream = await streaming(ctx, 'PiP card, 30 fps');
  console.log('DEVICE_PERF ' + JSON.stringify(out));
}}];
