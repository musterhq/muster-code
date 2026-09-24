import React, {useEffect, useState} from 'react';
import {normalizeCodeLanguage} from './codeLanguage';

type Token = {content: string; color?: string};
type WorkerResult = {rows: Token[][] | null};
type HighlightedSnapshot = {sourceLines: string[]; rows: Token[][]};
type Pending = {resolve: (result: WorkerResult) => void; reject: (error: Error) => void};

let worker: Worker | undefined;
let nextId = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, Pending>();
/** The worker (grammars, wasm engine, token cache) is released after this long without a request. */
export const HIGHLIGHT_WORKER_IDLE_MS = 60_000;

/** Terminate the shared highlight worker; the next request recreates it lazily. */
export function releaseHighlightWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  worker?.terminate();
  worker = undefined;
}
function scheduleIdleRelease(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  if (pending.size) return;
  idleTimer = setTimeout(() => { idleTimer = undefined; if (!pending.size) releaseHighlightWorker(); }, HIGHLIGHT_WORKER_IDLE_MS);
}

function getWorker(): Worker {
  if (worker) return worker;
  // This module is bundled into renderer/main.js, so the worker entry is a
  // sibling of that output (esbuild does not preserve this source directory).
  worker = new Worker(new URL('./syntax-highlight-worker.js', import.meta.url), {type: 'module', name: 'muster-code-highlighter'});
  worker.onmessage = (event: MessageEvent<{id: number; rows: Token[][] | null}>) => {
    const task = pending.get(event.data.id);
    if (!task) return;
    pending.delete(event.data.id);
    task.resolve({rows: event.data.rows});
    scheduleIdleRelease();
  };
  worker.onerror = () => {
    for (const task of pending.values()) task.reject(new Error('Syntax highlighting unavailable'));
    pending.clear();
    releaseHighlightWorker();
  };
  return worker;
}

function requestHighlight(source: string, language: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, {resolve, reject});
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
    try { getWorker().postMessage({id, source, language: normalizeCodeLanguage(language)}); }
    catch (error) {pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); scheduleIdleRelease();}
  });
}

/** Lazy worker rendering keeps TextMate initialization and tokenization off the UI thread. */
export function useHighlightedTokens(source: string, language: string, delay = 220): HighlightedSnapshot | null {
  const [highlighted, setHighlighted] = useState<{language: string; sourceLines: string[]; rows: Token[][]} | null>(null);
  const normalizedLanguage = normalizeCodeLanguage(language);
  useEffect(() => {
    let active = true;
    // Streaming code fences often change every token. Wait for a short pause so
    // one long reply does not enqueue repeated syntax passes. Keep the last
    // same-language token rows visible while the newest stream is highlighted;
    // this avoids flashing the entire block back to plain text on every delta.
    const timer = window.setTimeout(() => {
      void requestHighlight(source, normalizedLanguage).then(result => {
        if (!active) return;
        if (result.rows) setHighlighted({language: normalizedLanguage, sourceLines: source.split('\n'), rows: result.rows});
        else setHighlighted(null);
      }).catch(() => {if (active) setHighlighted(null);});
    }, delay);
    return () => {active = false; window.clearTimeout(timer);};
  }, [source, normalizedLanguage, delay]);
  return highlighted?.language === normalizedLanguage ? highlighted : null;
}

export const HighlightedCode = React.memo(function HighlightedCode({source, language, className}: {source: string; language: string; className?: string}): React.ReactElement {
  const highlighted = useHighlightedTokens(source, language);
  if (!highlighted) return <code className={className}>{source}</code>;
  const lines = source.split('\n');
  return <code className={className}>{lines.map((line, index) => <React.Fragment key={index}>{index > 0 && '\n'}{((highlighted.sourceLines[index]===line ? highlighted.rows[index] : undefined) ?? [{content: line}]).map((token, tokenIndex) => token.color
    ? <span key={tokenIndex} style={{color: token.color}}>{token.content}</span>
    : <React.Fragment key={tokenIndex}>{token.content}</React.Fragment>)}</React.Fragment>)}</code>;
});

export function HighlightedSourceTable({source, language, targetLine}: {source: string; language: string; targetLine?: number}): React.ReactElement {
  const highlighted = useHighlightedTokens(source, language, 0);
  const lines = source === '' ? [] : source.split('\n');
  return <table className="code-table source-code-table"><tbody>{lines.map((line, index) => <tr key={index} data-line={index + 1} className={index + 1 === targetLine ? 'file-line-target' : undefined}>
    <td className="code-no">{index + 1}</td>
    <td className="code-line">{((highlighted?.sourceLines[index]===line ? highlighted.rows[index] : undefined) ?? [{content: line}]).map((token, tokenIndex) => token.color
      ? <span key={tokenIndex} style={{color: token.color}}>{token.content}</span>
      : <React.Fragment key={tokenIndex}>{token.content}</React.Fragment>)}</td>
  </tr>)}</tbody></table>;
}
