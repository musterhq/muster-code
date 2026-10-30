/* Portions adapted from T3 Code (https://github.com/pingdotgg/t3code, commit fa4f3a2), apps/web/src/components/files/NotebookPreview.tsx. Copyright (c) 2026 T3 Tools Inc., MIT License; see THIRD-PARTY-NOTICES.md and licenses/t3code-MIT.txt. */
/**
 * A Jupyter notebook (.ipynb) as a document: Markdown cells through the chat's Markdown renderer, code cells highlighted, and the
 * outputs the notebook saved. Nothing is executed: there is no kernel, and saved HTML outputs are shown in the shared untrusted-HTML
 * frame in its measure-only mode (SandboxedHtml `measure`): served from its own `muster-report://` origin, opaque sandbox, a CSP whose
 * only allowed script is Muster's height reporter, so the frame fits its content while the output's own scripts never run.
 *
 * HTML frames are the expensive part, so only those near the viewport are mounted, at most MAX_FRAMES at a time; a frame that leaves
 * keeps its last height as a placeholder so the page never jumps.
 */
import React, {useEffect, useId, useMemo, useRef, useState} from 'react';
import {notebookOutputDocument, parseNotebook, type NotebookCell, type NotebookOutput} from '../../shared/notebook';
import {useHtmlRenderTheme} from '../htmlRenderTheme';
import {HighlightedCode} from './HighlightedCode';
import {normalizeCodeLanguage} from './codeLanguage';
import {MessageBody} from './MessageBody';
import {ResourceState} from './ResourceState';
import {SandboxedHtml} from './SandboxedHtml';
import {isWebHost} from '../webHost';
import './notebook-preview.css';

/** Most HTML output frames mounted at once, however many outputs a notebook has. */
export const MAX_FRAMES = 16;
/** Cells rendered per "Show more cells" step. */
export const CELL_PAGE = 30;
const FRAME_MARGIN = '200px 0px';
const PLACEHOLDER_HEIGHT = 80;
/** Muster Server's web UI shows outputs in a script-free srcdoc frame that cannot report its height: a taller frame that scrolls. */
const WEB_HEIGHT = 320;

interface ResourceContext {folderId: string; path: string}

export function NotebookPreview({text, name, resourceContext}: {text: string; name: string; resourceContext?: ResourceContext}): React.ReactElement {
  const parsed = useMemo((): {notebook?: ReturnType<typeof parseNotebook>; error?: string} => {
    try { return {notebook: parseNotebook(text)}; } catch (cause) { return {error: cause instanceof Error ? cause.message : String(cause)}; }
  }, [text]);
  if (parsed.error) return <ResourceState kind="error" message="Couldn’t show this notebook" detail={`${parsed.error} Use View source to read the file.`}/>;
  return <NotebookDocument key={text} notebook={parsed.notebook!} name={name} {...(resourceContext ? {resourceContext} : {})}/>;
}

function NotebookDocument({notebook, name, resourceContext}: {notebook: ReturnType<typeof parseNotebook>; name: string; resourceContext?: ResourceContext}): React.ReactElement {
  const [visible, setVisible] = useState(CELL_PAGE);
  const scroll = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set());
  const heights = useRef(new Map<string, number>());
  const instance = useId();
  const language = normalizeCodeLanguage(notebook.language);
  const shown = notebook.cells.slice(0, visible);
  const frameCount = shown.reduce((count, cell) => count + cell.outputs.filter(output => output.kind === 'html').length, 0);

  // Which HTML outputs are near the viewport; the first MAX_FRAMES of them (in document order) get a frame.
  useEffect(() => {
    const root = scroll.current;
    if (!root || !frameCount) return;
    if (typeof IntersectionObserver === 'undefined') {
      setMounted(new Set([...root.querySelectorAll<HTMLElement>('[data-notebook-output]')].slice(0, MAX_FRAMES).map(node => node.dataset.notebookOutput!)));
      return;
    }
    const near = new Map<string, number>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const node = entry.target as HTMLElement, id = node.dataset.notebookOutput!;
        if (entry.isIntersecting) near.set(id, Number(node.dataset.order)); else near.delete(id);
      }
      const next = [...near].sort((a, b) => a[1] - b[1]).slice(0, MAX_FRAMES).map(([id]) => id);
      setMounted(previous => previous.size === next.length && next.every(id => previous.has(id)) ? previous : new Set(next));
    }, {root, rootMargin: FRAME_MARGIN});
    for (const node of root.querySelectorAll('[data-notebook-output]')) observer.observe(node);
    return () => observer.disconnect();
  }, [frameCount]);

  let order = 0;
  return <div className="notebook-preview" role="region" aria-label={`Notebook preview of ${name}`}>
    <div className="notebook-status" role="status">{notebook.cells.length.toLocaleString()} {notebook.cells.length === 1 ? 'cell' : 'cells'} · {notebook.language}</div>
    <p className="notebook-notice">Saved outputs only. Code is never executed.</p>
    <div ref={scroll} className="notebook-scroll" tabIndex={0}>
      <div className="notebook-cells">
        {shown.map((cell, index) => <section key={index} className="notebook-cell" data-kind={cell.kind} aria-label={`Cell ${index + 1}`}>
          <div className="notebook-cell-head">{cell.kind === 'code' ? notebook.language : cell.kind} · {index + 1}</div>
          <CellSource cell={cell} language={language} {...(resourceContext ? {resourceContext} : {})}/>
          {cell.outputs.map((output, outputIndex) => {
            const id = `${index}-${outputIndex}`;
            return <Output key={outputIndex} id={id} order={output.kind === 'html' ? order++ : -1} output={output} label={`Cell ${index + 1} output ${outputIndex + 1}`}
              mounted={mounted.has(id)} heights={heights.current} storeKey={`notebook:${instance}:${id}`}/>;
          })}
        </section>)}
        {notebook.cells.length === 0 && <p className="file-empty">This notebook is empty.</p>}
        {visible < notebook.cells.length && <button type="button" className="notebook-more" onClick={() => setVisible(count => count + CELL_PAGE)}>
          Show more cells ({(notebook.cells.length - visible).toLocaleString()} remaining)
        </button>}
      </div>
    </div>
  </div>;
}

const CellSource = React.memo(function CellSource({cell, language, resourceContext}: {cell: NotebookCell; language: string; resourceContext?: ResourceContext}): React.ReactElement | null {
  if (cell.kind === 'markdown') return <div className="notebook-markdown">
    <MessageBody text={cell.source} asDocument {...(resourceContext ? {resourceContext} : {})}/>
  </div>;
  if (!cell.source.trim()) return null;
  if (cell.kind === 'raw') return <pre className="notebook-raw">{cell.source}</pre>;
  return <div className="notebook-code"><HighlightedCode source={cell.source} language={language}/></div>;
});

function Output({id, order, output, label, mounted, heights, storeKey}: {id: string; order: number; output: NotebookOutput; label: string; mounted: boolean; heights: Map<string, number>; storeKey: string}): React.ReactElement {
  if (output.kind === 'image') return <div className="notebook-output" data-kind="image"><img src={output.text} alt={label} loading="lazy"/></div>;
  if (output.kind === 'text') return <div className="notebook-output" data-kind="text"><pre>{output.text}</pre></div>;
  return <div className="notebook-output" data-kind="html" data-notebook-output={id} data-order={order}
    style={mounted ? undefined : {minHeight: heights.get(id) ?? PLACEHOLDER_HEIGHT}}>
    {mounted && <HtmlOutput html={output.text} label={label} storeKey={storeKey} initialHeight={heights.get(id)} onHeight={height => heights.set(id, height)}/>}
  </div>;
}

function HtmlOutput({html, label, storeKey, initialHeight, onHeight}: {html: string; label: string; storeKey: string; initialHeight: number | undefined; onHeight(height: number): void}): React.ReactElement {
  const theme = useHtmlRenderTheme();
  const page = useMemo(() => notebookOutputDocument(html, theme), [html, theme]);
  const [height, setHeight] = useState(initialHeight);
  return <div className="notebook-html-output" style={{height: height ?? (isWebHost() ? WEB_HEIGHT : PLACEHOLDER_HEIGHT)}}>
    <SandboxedHtml html={page} measure title={label} storeKey={storeKey} debounceMs={150} onHeight={next => { setHeight(next); onHeight(next); }}/>
  </div>;
}
