/**
 * Browser harness for the 3D viewer: mounts the real <ModelViewer> with the real stylesheet and theme tokens against a
 * bridge stub that serves model files over HTTP Range requests. Driven by run.mjs through the DevTools protocol so the
 * budgets (long tasks, first frame, idle rAF, open/close leaks) and the state screenshots are reproducible without launching
 * Electron. Not shipped.
 */
import React from 'react';
import '../../src/renderer/components/file-preview.css';
import {createRoot, type Root} from 'react-dom/client';
import {ModelViewerPane} from '../../src/renderer/components/LazyModel';
import {TipProvider} from '../../src/renderer/components/Tooltip';
import {installWindowActivity} from '../../src/renderer/windowActivity';
import {BUILT_IN_THEMES, MUSTER_DARK, MUSTER_LIGHT, applyThemeTokens} from '../../src/shared/theme';

installWindowActivity();
const params = new URLSearchParams(location.search);
const delay = Number(params.get('delay') ?? 0);
let chunkCalls = 0;

(window as any).muster = {
  subscribe: () => () => {},
  async invoke(command: string, input: any) {
    if (command === 'files.modelChunk') {
      chunkCalls++;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const response = await fetch(`/models/${input.path}`, {headers: {Range: `bytes=${input.offset}-${input.offset + input.length - 1}`}});
      if (response.status === 404) throw new Error('ENOENT: no such file');
      const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1] ?? response.headers.get('content-length') ?? 0);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {size: total, offset: input.offset, bytes};
    }
    if (command === 'files.read') return {path: input.path, text: await (await fetch(`/models/${input.path}`)).text(), truncated: false};
    return undefined;
  },
};

const longTasks: Array<{start: number; duration: number}> = [];
try { new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push({start: e.startTime, duration: e.duration}); }).observe({entryTypes: ['longtask']}); } catch { /* unsupported */ }
let rafCount = 0;
const nativeRaf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (cb: FrameRequestCallback) => { rafCount++; return nativeRaf(cb); };

let root: Root | null = null;
let openedAt = 0;
const stage = () => document.getElementById('stage')!;

function applyTheme(id: string): void {
  const all = [MUSTER_DARK, MUSTER_LIGHT, ...BUILT_IN_THEMES];
  const theme = all.find(t => t.id === id) ?? MUSTER_DARK;
  document.documentElement.setAttribute('data-theme', theme.base);
  applyThemeTokens(document.documentElement, theme);
}

type Opened = {ms: number; state: string; firstFrameMs: number | null};
(window as any).harness = {
  applyTheme,
  setSize(width: number, height: number) { const s = stage(); s.style.width = `${width}px`; s.style.height = `${height}px`; },
  open(path: string, options: {variant?: 'tab' | 'inline'; revision?: number} = {}): Promise<Opened> {
    const started = performance.now();
    openedAt = started;
    root?.unmount(); root = createRoot(stage());
    root.render(<TipProvider><ModelViewerPane source={{kind: 'file', folderId: 'f', path}} variant={options.variant ?? 'tab'} onOpenInTab={() => {}}/></TipProvider>);
    return new Promise(resolve => {
      const check = () => {
        const state = stage().querySelector('.rich-block')?.getAttribute('data-status');
        if (state === 'ready' || state === 'error') { observer.disconnect(); resolve({ms: performance.now() - started, state, firstFrameMs: performance.now() - started}); }
      };
      const observer = new MutationObserver(check);
      observer.observe(stage(), {attributes: true, subtree: true, childList: true, attributeFilter: ['data-status']});
      check();
    });
  },
  close() { root?.unmount(); root = null; },
  click(selector: string) { (stage().querySelector(selector) as HTMLElement | null)?.click(); },
  async counters() { const {Engine} = await import('../../src/renderer/three-engine'); return {raf: rafCount, longTasks: longTasks.slice(), chunkCalls, engines: Engine.live.size, renders: [...Engine.live].map(e => e.stats.frames), now: performance.now(), openedAt}; },
  resetCounters() { rafCount = 0; longTasks.length = 0; chunkCalls = 0; },
  async glInfo() { const {Engine} = await import('../../src/renderer/three-engine'); const e = [...Engine.live][0]; return e ? {geometries: e.stats.geometries, textures: e.stats.textures, drawCalls: e.stats.drawCalls, triangles: e.stats.triangles, frames: e.stats.frames} : null; },
  async debug() { const {Engine} = await import('../../src/renderer/three-engine'); const e = [...Engine.live][0]!; const out: unknown[] = []; for (let i = 0; i < 6; i++) { const c = e.canvas, r = e.container.getBoundingClientRect(); out.push({vp: e.viewport, frames: e.stats.frames, canvas: [c.width, c.height], css: [c.clientWidth, c.clientHeight], box: [r.width, r.height], dpr: devicePixelRatio}); await new Promise(res => setTimeout(res, 120)); } return out; },
  async engineCycles(count: number, withModel: boolean) {
    const {Engine} = await import('../../src/renderer/three-engine');
    const {BoxGeometry, Mesh, MeshStandardMaterial} = await import('three');
    let last: unknown = null;
    for (let i = 0; i < count; i++) {
      const host = document.createElement('div'); host.style.cssText = 'width:300px;height:200px'; document.body.appendChild(host);
      const engine = new Engine({container: host});
      if (withModel) engine.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
      engine.renderNow();
      const before = {...engine.renderer.info!.memory};
      engine.dispose(); host.remove();
      last = {before, after: {...engine.renderer.info!.memory}};
    }
    return {live: Engine.live.size, last};
  },
  async rawCycles(count: number, mode: string) {
    const THREE = await import('three');
    for (let i = 0; i < count; i++) {
      if (mode === 'canvas') { const c = document.createElement('canvas'); const gl = c.getContext('webgl2')!; gl.getExtension('WEBGL_lose_context')?.loseContext(); }
      else {
        const r = new THREE.WebGLRenderer({antialias: true});
        if (mode === 'render') { const sc = new THREE.Scene(); sc.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())); sc.add(new THREE.HemisphereLight()); const cam = new THREE.PerspectiveCamera(); cam.position.z = 3; r.setSize(100, 100); r.render(sc, cam); }
        r.dispose(); r.forceContextLoss();
      }
    }
  },
  drag(dx: number, dy: number) {
    const canvas = stage().querySelector('canvas')!, r = canvas.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const fire = (type: string, cx: number, cy: number, buttons: number) => canvas.dispatchEvent(new PointerEvent(type, {pointerId: 1, pointerType: 'mouse', button: 0, buttons, clientX: cx, clientY: cy, bubbles: true}));
    fire('pointerdown', x, y, 1);
    for (let i = 1; i <= 6; i++) fire('pointermove', x + dx * i / 6, y + dy * i / 6, 1);
    fire('pointerup', x + dx, y + dy, 0);
  },
};
document.body.dataset.harness = 'ready';
