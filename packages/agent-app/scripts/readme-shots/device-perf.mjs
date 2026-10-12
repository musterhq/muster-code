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
const heap = async (ctx) => {
  await ctx.cdp.call('HeapProfiler.collectGarbage');
  const {usedSize} = await ctx.cdp.call('Runtime.getHeapUsage');
  const dom = await ctx.evaluate(`return document.getElementsByTagName('*').length`);
  return {heapMB: +(usedSize / 1048576).toFixed(2), dom};
};
export const SHOTS = [{name: 'device-perf', local: true, opts: {devices: 'live'}, settle: 100, async run(ctx) {
  await ctx.cdp.call('Emulation.setFocusEmulationEnabled', {enabled: true});
  const out = {};
  await ctx.store(`s.openTab({id:'device:${IPHONE}',kind:'device',deviceId:'${IPHONE}',title:'iPhone'})`);
  await ctx.sleep(2500);
  out.flatIdle = await idle(ctx, 'flat view, frames stopped');
  // 3D on.
  await ctx.evaluate(`document.querySelector('[aria-label="3D view"]').click()`);
  await ctx.sleep(3000);
  out.threeIdle = await idle(ctx, '3D view, frames stopped');
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
  console.log('DEVICE_PERF ' + JSON.stringify(out));
}}];
