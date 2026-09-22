import React, {useEffect, useState} from 'react';
import {normalizeCodeLanguage} from './codeLanguage';

type Token = {content: string; color?: string};
type WorkerResult = {rows: Token[][] | null};
type Pending = {resolve: (result: WorkerResult) => void; reject: (error: Error) => void};

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, Pending>();

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
  };
  worker.onerror = () => {
    for (const task of pending.values()) task.reject(new Error('Syntax highlighting unavailable'));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

function requestHighlight(source: string, language: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, {resolve, reject});
    try { getWorker().postMessage({id, source, language: normalizeCodeLanguage(language)}); }
    catch (error) {pending.delete(id); reject(error instanceof Error ? error : new Error(String(error)));}
  });
}

/** Lazy worker rendering keeps TextMate initialization and tokenization off the UI thread. */
export function useHighlightedTokens(source: string, language: string, delay = 220): Token[][] | null {
  const [highlighted, setHighlighted] = useState<{language: string; rows: Token[][]} | null>(null);
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
        if (result.rows) setHighlighted({language: normalizedLanguage, rows: result.rows});
        else setHighlighted(null);
      }).catch(() => {if (active) setHighlighted(null);});
    }, delay);
    return () => {active = false; window.clearTimeout(timer);};
  }, [source, normalizedLanguage, delay]);
  return highlighted?.language === normalizedLanguage ? highlighted.rows : null;
}

export function HighlightedCode({source, language, className}: {source: string; language: string; className?: string}): React.ReactElement {
  const rows = useHighlightedTokens(source, language);
  if (!rows) return <code className={className}>{source}</code>;
  const lines = source.split('\n');
  const lineCount = Math.max(lines.length, rows.length);
  return <code className={className}>{Array.from({length: lineCount}, (_, index) => <React.Fragment key={index}>{index > 0 && '\n'}{(rows[index] ?? [{content: lines[index] ?? ''}]).map((token, tokenIndex) => token.color
    ? <span key={tokenIndex} style={{color: token.color}}>{token.content}</span>
    : <React.Fragment key={tokenIndex}>{token.content}</React.Fragment>)}</React.Fragment>)}</code>;
}

export function HighlightedSourceTable({source, language, targetLine}: {source: string; language: string; targetLine?: number}): React.ReactElement {
  const rows = useHighlightedTokens(source, language, 0);
  const lines = source === '' ? [] : source.split('\n');
  return <table className="code-table source-code-table"><tbody>{lines.map((line, index) => <tr key={index} data-line={index + 1} className={index + 1 === targetLine ? 'file-line-target' : undefined}>
    <td className="code-no">{index + 1}</td>
    <td className="code-line">{(rows?.[index] ?? [{content: line}]).map((token, tokenIndex) => token.color
      ? <span key={tokenIndex} style={{color: token.color}}>{token.content}</span>
      : <React.Fragment key={tokenIndex}>{token.content}</React.Fragment>)}</td>
  </tr>)}</tbody></table>;
}
