/* Portions adapted from T3 Code (https://github.com/pingdotgg/t3code, commit fa4f3a2), apps/web/src/components/files/MermaidViewer.tsx and MermaidFilePreview.tsx. Copyright (c) 2026 T3 Tools Inc., MIT License; see THIRD-PARTY-NOTICES.md and licenses/t3code-MIT.txt. */
/**
 * A Mermaid file (.mmd, .mermaid) drawn in its file tab. The tab's own View source / View diagram toggle switches to the source;
 * this view draws the diagram (fit to the pane, zoom and pan), and Expand opens it full size. The text is checked first
 * (shared/mermaid-file.ts): a file holding URLs, configuration, raw HTML or image keys is never handed to Mermaid. A refused or
 * invalid file shows the reason and its source, never a blank pane. Uses the chat's Mermaid renderer, theme and stage unchanged.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {Dialog} from '@base-ui/react/dialog';
import {Maximize2, X} from 'lucide-react';
import {mermaidMeta, MAX_RICH_SOURCE} from '../../shared/rich-fence';
import {libraryMessage} from '../../shared/rich-block';
import {mermaidFileProblem, mermaidFileRefusal} from '../../shared/mermaid-file';
import {readRichTheme, useRichThemeSignature} from '../richTheme';
import {renderMermaid, whenIdle} from '../richRenderers';
import {SvgStage, useZoom, ZoomControls} from './rich/SvgStage';
import type {MermaidResult} from './rich/mermaidRender';
import {ResourceState} from './ResourceState';
import {Tip} from './Tooltip';
import './rich-block.css';
import './notebook-preview.css';

export function MermaidFilePreview({text, name}: {text: string; name: string}): React.ReactElement {
  const problem = useMemo(() => mermaidFileProblem(text), [text]);
  const meta = useMemo(() => mermaidMeta(text), [text]);
  const signature = useRichThemeSignature();
  const [state, setState] = useState<{result?: MermaidResult; error?: string}>({});
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const zoom = useZoom(), fullZoom = useZoom();
  const empty = !text.trim();

  useEffect(() => {
    if (problem || empty) return;
    if (text.length > MAX_RICH_SOURCE.diagram) { setState({error: `This diagram is ${(text.length / 1000).toFixed(0)} KB; the limit is ${MAX_RICH_SOURCE.diagram / 1000} KB.`}); return; }
    let live = true;
    // A theme change keeps the old drawing up until the new one is ready.
    setState(previous => previous.result ? previous : {});
    const cancel = whenIdle(() => {
      void renderMermaid(text, readRichTheme(), signature).then(result => { if (live) setState({result}); }, cause => { if (live) setState({error: libraryMessage(cause)}); });
    });
    return () => { live = false; cancel(); };
  }, [text, signature, problem, empty, attempt]);

  if (empty) return <div className="mermaid-file"><p className="file-empty">This diagram file is empty.</p></div>;
  if (problem || state.error) return <div className="mermaid-file" data-state="error">
    <div className="mermaid-file-error" role="alert">
      <span>{problem ? mermaidFileRefusal(problem) : `Unable to render diagram: ${state.error}`}</span>
      {!problem && <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button>}
    </div>
    <pre className="mermaid-file-source" tabIndex={0} aria-label={`Source of ${name}`}>{text}</pre>
  </div>;
  const result = state.result;
  if (!result) return <div className="mermaid-file"><ResourceState kind="loading" label={`Drawing ${name}`} rows={4}/></div>;
  const title = meta.title || name;
  const label = `${meta.type}: ${title}`;
  return <div className="mermaid-file" data-state="ready">
    <div className="mermaid-file-toolbar" role="toolbar" aria-label="Diagram">
      <span className="mermaid-file-kind">{meta.title ? `${meta.type} · ${meta.title}` : meta.type}</span>
      <ZoomControls zoom={zoom}/>
      <Tip label="Expand diagram"><button type="button" className="rich-action" aria-label="Expand diagram" onClick={() => setExpanded(true)}><Maximize2 size={13} aria-hidden="true"/></button></Tip>
    </div>
    <div className="mermaid-file-stage" data-mermaid-file><SvgStage svg={result.svg} width={result.width} height={result.height} mode="tab" zoom={zoom} label={label}/></div>
    {expanded && <Dialog.Root open onOpenChange={next => { if (!next) setExpanded(false); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="rich-full-backdrop"/>
        <Dialog.Popup className="rich-full mermaid-file-full" aria-label={`${title} (full size)`}>
          <Dialog.Title className="rich-sr">{title}</Dialog.Title>
          <div className="mermaid-file-full-body">
            <div className="mermaid-file-toolbar" role="toolbar" aria-label="Full size diagram">
              <span className="mermaid-file-kind">{title}</span>
              <ZoomControls zoom={fullZoom}/>
              <Dialog.Close className="rich-action" aria-label="Close full size view"><X size={13} aria-hidden="true"/></Dialog.Close>
            </div>
            <div className="mermaid-file-stage"><SvgStage svg={result.svg} width={result.width} height={result.height} mode="fullscreen" zoom={fullZoom} label={label}/></div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>}
  </div>;
}
