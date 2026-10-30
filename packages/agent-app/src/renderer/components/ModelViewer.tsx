/**
 * Interactive 3D preview for GLB / glTF / OBJ / STL / PLY / FBX. Loaded lazily (three.js lives in this chunk); the
 * file bytes arrive in IPC chunks, are parsed in a Web Worker, and are added to the shared three-engine in small slices.
 * Surfaces: file tab, chat attachment tab, and (inline) any host that renders <ModelViewer variant="inline">.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Camera, Grid3x3, Home, Info} from 'lucide-react';
import {invoke} from '../bridge';
import {isWindowActive, onWindowActivity} from '../windowActivity';
import {Engine, CAMERA_PRESETS, type CameraPreset, type EngineOptions} from '../three-engine';
import {FORMAT_LABEL, MAX_MODEL_BYTES, ModelParseError, modelFormatOf, mountModel, parseInWorker, readAllChunks, readCompanion, type ModelFormat, type ModelHandle, type ModelStats, type ParseHandle} from '../three-engine/model';
import {friendlyFileError} from './filePresentation';
import {FileExitActions} from './FilePreviews';
import {HighlightedSourceTable} from './HighlightedCode';
import {codeLanguageFromPath} from './codeLanguage';
import {RichBlock} from './RichBlock';
import {Tip} from './Tooltip';
import './model-viewer.css';

export type ModelSource =
  | {kind: 'file'; folderId: string; path: string}
  | {kind: 'attachment'; chatId: string; id: string; name: string};

type Phase =
  | {kind: 'loading'; step: 'starting' | 'reading' | 'parsing' | 'building'; fraction: number}
  | {kind: 'ready'}
  | {kind: 'error'; title: string; detail: string; retry: boolean};

const VIEWS: CameraPreset[] = ['front', 'iso', 'top', 'right'];
const TEXT_FORMATS = new Set<ModelFormat>(['obj', 'gltf']);

const nameOf = (source: ModelSource) => (source.kind === 'file' ? source.path.split('/').pop() ?? source.path : source.name);
const pathOf = (source: ModelSource) => (source.kind === 'file' ? source.path : source.name);

const STEP_LABEL = {starting: 'Preparing 3D view', reading: 'Reading file', parsing: 'Preparing model', building: 'Building scene'} as const;

function errorFor(cause: unknown): {title: string; detail: string; retry: boolean} {
  if (cause instanceof ModelParseError) {
    const title = cause.code === 'too-large' ? 'This model is too large to preview' : cause.code === 'unsupported' ? 'This model uses a feature that is not supported yet' : cause.code === 'empty' ? 'This 3D file is empty' : "Couldn't open this 3D model";
    return {title, detail: cause.message, retry: cause.code === 'corrupt'};
  }
  return {title: "Couldn't open this 3D model", detail: friendlyFileError(cause), retry: true};
}

function formatBytes(n: number): string { return n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KiB`; }
function formatSize(size: [number, number, number]): string {
  const f = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  return `${f(size[0])} × ${f(size[1])} × ${f(size[2])}`;
}

/** Seams for tests (a fake GL renderer and an in-process parser); production passes none. */
export interface ModelViewerHooks { engine?: Partial<EngineOptions>; createWorker?: () => Worker }

export function ModelViewer({source, variant = 'tab', revision, onOpenInTab, hooks}: {source: ModelSource; variant?: 'tab' | 'inline'; revision?: unknown; onOpenInTab?: () => void; hooks?: ModelViewerHooks}): React.ReactElement {
  const name = nameOf(source), path = pathOf(source);
  const format = modelFormatOf(path);
  const container = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const handle = useRef<ModelHandle | null>(null);
  const [phase, setPhase] = useState<Phase>({kind: 'loading', step: 'starting', fraction: 0});
  const [stats, setStats] = useState<ModelStats | null>(null);
  const [fileBytes, setFileBytes] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [wireframe, setWireframe] = useState(false);
  const [info, setInfo] = useState(false);
  const [view, setView] = useState<'model' | 'source'>('model');
  const [sourceText, setSourceText] = useState<{text: string; truncated: boolean} | {error: string} | null>(null);
  const wireframeRef = useRef(false);
  wireframeRef.current = wireframe;
  const sourceKey = source.kind === 'file' ? `f:${source.folderId}:${source.path}` : `a:${source.chatId}:${source.id}`;

  // One engine per mounted viewer: created here, disposed on unmount (and on a lost GL context via `attempt`).
  const [engineError, setEngineError] = useState<string | null>(null);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let created: Engine | null = null;
    try {
      created = new Engine({
        container: host, label: `3D model: ${name}`, lighting: 'studio',
        activity: {active: isWindowActive, subscribe: onWindowActivity},
        ...hooks?.engine,
      });
    } catch (cause) {
      setEngineError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setEngineError(null);
    const lost = (event: Event) => { event.preventDefault(); setEngine(null); setPhase({kind: 'error', title: 'The graphics context was lost', detail: 'The system reclaimed the GPU for this view. Reload the preview to continue.', retry: true}); };
    created.canvas.addEventListener('webglcontextlost', lost);
    setEngine(created);
    return () => { created!.canvas.removeEventListener('webglcontextlost', lost); handle.current = null; created!.dispose(); setEngine(null); };
  }, [attempt, name]);

  // Load, parse and mount. Everything async is cancellable; cleanup disposes the model before the engine goes.
  useEffect(() => {
    if (!engine || !format) return;
    let live = true;
    const abort = new AbortController();
    let parsing: ParseHandle | null = null;
    let unTheme = () => {};
    setStats(null); setPhase({kind: 'loading', step: 'reading', fraction: 0}); setInfo(false);
    void (async () => {
      try {
        const read = source.kind === 'file'
          ? (offset: number, length: number) => invoke('files.modelChunk', {folderId: source.folderId, path: source.path, offset, length})
          : (offset: number, length: number) => invoke('attachments.modelChunk', {chatId: source.chatId, id: source.id, offset, length});
        const bytes = await readAllChunks(read, {signal: abort.signal, onProgress: fraction => { if (live) setPhase({kind: 'loading', step: 'reading', fraction}); }});
        if (!live) return;
        setFileBytes(bytes.byteLength);
        setPhase({kind: 'loading', step: 'parsing', fraction: 0});
        const companion = source.kind === 'file'
          ? (companionPath: string) => readCompanion((p, offset, length) => invoke('files.modelChunk', {folderId: source.folderId, path: p, offset, length}), companionPath)
          : async () => null;
        parsing = parseInWorker({format, path, bytes}, companion, hooks?.createWorker);
        const payload = await parsing.promise;
        if (!live) { for (const t of payload.textures) t.image.close(); return; }
        setPhase({kind: 'loading', step: 'building', fraction: 0});
        const mounted = mountModel(engine, payload, {wireframe: wireframeRef.current});
        handle.current = mounted;
        unTheme = engine.onThemeChange(theme => mounted.applyTheme(theme));
        setStats(payload.stats);
        // Ready once the first slice is on screen; the remaining parts stream in over the next frames.
        await new Promise<void>(resolve => engine.afterNextRender(resolve));
        if (live) setPhase({kind: 'ready'});
        await mounted.done;
      } catch (cause) {
        if (!live || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        setPhase({...errorFor(cause), kind: 'error'});
      }
    })();
    return () => {
      live = false; abort.abort(); parsing?.cancel(); unTheme();
      handle.current?.dispose(); handle.current = null;
    };
  }, [engine, sourceKey, revision, format, attempt]);

  useEffect(() => { handle.current?.setWireframe(wireframe); }, [wireframe]);

  // Text formats can also be read as source, so opening a .obj or .gltf never loses the old behaviour.
  useEffect(() => {
    if (view !== 'source' || !format || !TEXT_FORMATS.has(format)) return;
    let live = true;
    setSourceText(null);
    const request = source.kind === 'file' ? invoke('files.read', {folderId: source.folderId, path: source.path}) : invoke('attachments.read', {chatId: source.chatId, id: source.id});
    void request.then(value => { if (live) setSourceText({text: value.text, truncated: value.truncated}); }, cause => { if (live) setSourceText({error: friendlyFileError(cause)}); });
    return () => { live = false; };
  }, [view, sourceKey, format]);

  const exportImage = useCallback(async () => {
    if (!engine) return;
    const blob = await engine.screenshot('image/png');
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `${name.replace(/\.[^.]+$/, '')}.png`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [engine, name]);

  const ready = phase.kind === 'ready';
  const failure = engineError
    ? {title: "3D preview isn't available here", detail: /webgl/i.test(engineError) ? 'This device or session has no WebGL support, so Muster cannot draw 3D views. Open the file in another app instead.' : engineError, retry: false}
    : phase.kind === 'error' ? phase : null;
  const loading = phase.kind === 'loading' && !engineError ? phase : null;
  const label = format ? FORMAT_LABEL[format] : '3D';
  const textFormat = format ? TEXT_FORMATS.has(format) : false;
  const hint = useMemo(() => 'Drag to rotate. Scroll to zoom. Shift-drag to pan. Arrow keys orbit, F returns to the front.', []);

  const exit = source.kind === 'file' ? <FileExitActions folderId={source.folderId} path={source.path}/> : null;
  return <RichBlock
    kind="model" persistent variant={variant}
    title={name} kindLabel={`3D model · ${label}`}
    status={failure ? 'error' : loading ? 'loading' : 'ready'}
    loadingLabel={loading ? `${STEP_LABEL[loading.step]}…` : 'Preparing 3D view…'}
    {...(loading?.step === 'reading' && loading.fraction > 0 ? {loadingDetail: <progress className="model-progress" max={1} value={loading.fraction} aria-label="Reading file"/>} : {})}
    {...(failure ? {error: {message: failure.title, detail: failure.detail, actions: <>{failure.retry && <button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>}{exit}</>}} : {})}
    source={path} copyLabel="Copy path"
    exports={[{id: 'image', label: 'Save image of this view', disabled: view !== 'model', run: exportImage}]}
    {...(variant === 'inline' && onOpenInTab ? {onOpenInTab} : {})}
    description={`${name}. ${hint}`}>
    <div className="model-viewer" data-ready={ready} data-view={view}>
      <div className="model-stage" ref={container} hidden={view === 'source'} aria-describedby={`model-hint-${sourceKey.length}`}>
        <span id={`model-hint-${sourceKey.length}`} className="model-hint">{hint}</span>
      </div>
      {view === 'source' && textFormat && <div className="code-scroll model-source" role="region" aria-label={`Source of ${name}`} tabIndex={0}>
        {sourceText === null ? <p className="file-empty">Loading source…</p> : 'error' in sourceText ? <p className="file-action-error" role="alert">{sourceText.error}</p>
          : <><HighlightedSourceTable source={sourceText.text} language={codeLanguageFromPath(path)}/>{sourceText.truncated && <div className="pane-truncated">Showing the start of the file.</div>}</>}
      </div>}
      {ready && view === 'model' && info && stats && <dl className="model-info" aria-label="Model information">
        <div><dt>Format</dt><dd>{label}{fileBytes ? ` · ${formatBytes(fileBytes)}` : ''}</dd></div>
        <div><dt>Vertices</dt><dd>{stats.vertices.toLocaleString()}</dd></div>
        <div><dt>Triangles</dt><dd>{stats.triangles.toLocaleString()}</dd></div>
        <div><dt>Size</dt><dd>{formatSize(stats.size)}</dd></div>
        <div><dt>Meshes</dt><dd>{stats.meshes.toLocaleString()}</dd></div>
        <div><dt>Materials</dt><dd>{stats.materials}{stats.textures ? ` · ${stats.textures} ${stats.textures === 1 ? 'texture' : 'textures'}` : ''}</dd></div>
        {stats.warnings.map((warning, index) => <div key={index} className="model-warning"><dd role="status">{warning}</dd></div>)}
      </dl>}
      {ready && <div className="model-toolbar" role="toolbar" aria-label="3D view controls">
        {view === 'model' && <>
          <Tip label="Reset view" shortcut="F"><button type="button" className="icon-button" aria-label="Reset view" onClick={() => engine?.snapToFront()}><Home size={14}/></button></Tip>
          <span className="model-segment" role="group" aria-label="Camera angle">
            {VIEWS.map(preset => <button key={preset} type="button" className="model-chip" onClick={() => engine?.setCameraPreset(preset, {refit: true})}>{CAMERA_PRESETS[preset].label}</button>)}
          </span>
          <Tip label={wireframe ? 'Hide wireframe' : 'Show wireframe'}><button type="button" className="icon-button" aria-pressed={wireframe} aria-label="Wireframe" onClick={() => setWireframe(value => !value)}><Grid3x3 size={14}/></button></Tip>
          <Tip label="Save image of this view"><button type="button" className="icon-button" aria-label="Save image of this view" onClick={() => void exportImage()}><Camera size={14}/></button></Tip>
          <Tip label={info ? 'Hide model info' : 'Model info'}><button type="button" className="icon-button" aria-pressed={info} aria-label="Model info" onClick={() => setInfo(value => !value)}><Info size={14}/></button></Tip>
        </>}
        {textFormat && <button type="button" className="model-chip" aria-pressed={view === 'source'} onClick={() => setView(value => (value === 'model' ? 'source' : 'model'))}>{view === 'model' ? 'Source' : '3D view'}</button>}
      </div>}
    </div>
  </RichBlock>;
}

/** Entry used by tabs: a file in a workspace folder, or a chat attachment. */
export function ModelFile({folderId, path, revision}: {folderId: string; path: string; revision?: unknown}): React.ReactElement {
  return <ModelViewer source={{kind: 'file', folderId, path}} revision={revision}/>;
}
export function AttachmentModel({chatId, attachmentId, name}: {chatId: string; attachmentId: string; name: string}): React.ReactElement {
  return <ModelViewer source={{kind: 'attachment', chatId, id: attachmentId, name}}/>;
}
export {MAX_MODEL_BYTES};
