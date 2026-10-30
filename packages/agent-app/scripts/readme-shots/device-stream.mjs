// Devices (#363) stream probe, in the real renderer under headless Chrome: the same animated home screen played at
// 60 fps as MJPEG (before) and as H.264 in the simulator helper's AVCC form (after), decoded by the renderer's own
// path. Prints frames presented per second, send-to-screen latency and main-thread time; `stream-sequence` also saves a
// screencast frame sequence of the H.264 stream to $SEQ_DIR.
//   SHOTS_FILE=scripts/readme-shots/device-stream.mjs SHOTS_TMP=<dir> [SEQ_DIR=<dir>] node scripts/readme-shots/shoot.mjs --probe stream-compare stream-sequence
import {mkdirSync, writeFileSync} from 'node:fs';
const IPHONE = '6B1F0C4A-2E7D-4C55-9A0B-1F2E3D4C5B6A';
const open = async (ctx) => {
  await ctx.cdp.call('Emulation.setFocusEmulationEnabled', {enabled: true});
  await ctx.cdp.call('Emulation.setDeviceMetricsOverride', {width: 1280, height: 800, deviceScaleFactor: 2, mobile: false});
  await ctx.store(`s.openTab({id:'device:${IPHONE}',kind:'device',deviceId:'${IPHONE}',title:'iPhone'})`);
  await ctx.sleep(2500);
};
const metrics = async (ctx) => Object.fromEntries((await ctx.cdp.call('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
const run = async (ctx, kind) => {
  const prepared = await ctx.evaluate(`return await window.__devicePrepare(${JSON.stringify(kind)}, 240)`);
  await ctx.sleep(500);
  const a = await metrics(ctx), t0 = Date.now();
  const played = await ctx.evaluate(`return await window.__devicePlay(60)`);
  const seconds = (Date.now() - t0) / 1000, b = await metrics(ctx);
  const ms = key => +(((b[key] ?? 0) - (a[key] ?? 0)) * 1000).toFixed(1);
  return {kind, ...prepared, ...played, scriptMs: ms('ScriptDuration'), taskMs: ms('TaskDuration'), mainThreadPct: +(ms('TaskDuration') / (seconds * 10)).toFixed(1)};
};
export const SHOTS = [
  {name: 'stream-compare', local: true, opts: {devices: 'live'}, settle: 200, async run(ctx) {
    await ctx.cdp.call('Performance.enable', {timeMethod: 'threadTicks'});
    await open(ctx);
    const before = await run(ctx, 'jpeg');
    // A fresh page for the H.264 run, so the MJPEG run's state cannot help or hurt it.
    await ctx.cdp.call('Page.reload'); await ctx.sleep(1500); await open(ctx);
    const after = await run(ctx, 'h264');
    const status = await ctx.evaluate(`return document.querySelector('.device-view')?.getAttribute('data-state')`);
    console.log('DEVICE_STREAM ' + JSON.stringify({before, after, viewState: status}));
  }},
  {name: 'stream-sequence', local: true, opts: {devices: 'live'}, settle: 200, async run(ctx) {
    await open(ctx);
    await ctx.evaluate(`return await window.__devicePrepare('h264', 120)`);
    const dir = process.env.SEQ_DIR; if (dir) mkdirSync(dir, {recursive: true});
    const frames = [];
    ctx.cdp.on(m => { if (m.method === 'Page.screencastFrame') { frames.push({data: m.params.data, t: m.params.metadata.timestamp}); void ctx.cdp.call('Page.screencastFrameAck', {sessionId: m.params.sessionId}); } });
    const box = await ctx.evaluate(`const b=document.querySelector('.device-stage').getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height}`);
    await ctx.cdp.call('Page.startScreencast', {format: 'jpeg', quality: 85, everyNthFrame: 1});
    await ctx.evaluate(`return await window.__devicePlay(60)`);
    await ctx.cdp.call('Page.stopScreencast');
    if (dir) frames.forEach((f, i) => writeFileSync(`${dir}/frame-${String(i).padStart(3, '0')}.jpg`, Buffer.from(f.data, 'base64')));
    const span = frames.length > 1 ? frames.at(-1).t - frames[0].t : 0;
    console.log('DEVICE_SEQUENCE ' + JSON.stringify({frames: frames.length, seconds: +span.toFixed(2), capturedFps: span ? +(frames.length / span).toFixed(1) : 0, stage: box}));
  }},
];
