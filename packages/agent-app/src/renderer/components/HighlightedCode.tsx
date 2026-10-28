import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {normalizeCodeLanguage} from './codeLanguage';
import {BLOCK_LINES, type BlocksRequest, type BlocksResponse, type CloseRequest, type Token} from './highlightProtocol';
import {lineContent, lineStarts, type FindMarks} from './codeLineContent';

interface WorkerResult { rows: Token[][] | null }
interface HighlightedSnapshot { sourceLines: string[]; rows: Token[][] }
interface Pending { resolve: (result: WorkerResult) => void; reject: (error: Error) => void }
interface PendingBlocks { resolve: (result: BlocksResponse) => void; reject: (error: Error) => void }

let worker: Worker | undefined;
let nextId = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, Pending>();
const pendingBlocks = new Map<number, PendingBlocks>();
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
  if (pending.size || pendingBlocks.size) return;
  idleTimer = setTimeout(() => { idleTimer = undefined; if (!pending.size && !pendingBlocks.size) releaseHighlightWorker(); }, HIGHLIGHT_WORKER_IDLE_MS);
}

function getWorker(): Worker {
  if (worker) return worker;
  // This module is bundled into renderer/main.js, so the worker entry is a
  // sibling of that output (esbuild does not preserve this source directory).
  worker = new Worker(new URL('./syntax-highlight-worker.js', import.meta.url), {type: 'module', name: 'muster-code-highlighter'});
  worker.onmessage = (event: MessageEvent<{id: number; rows: Token[][] | null} | BlocksResponse>) => {
    const data = event.data;
    if ('rows' in data) {
      const task = pending.get(data.id);
      if (!task) return;
      pending.delete(data.id);
      task.resolve({rows: data.rows});
    } else {
      const task = pendingBlocks.get(data.id);
      if (!task) return;
      pendingBlocks.delete(data.id);
      task.resolve(data);
    }
    scheduleIdleRelease();
  };
  worker.onerror = () => {
    for (const task of pending.values()) task.reject(new Error('Syntax highlighting unavailable'));
    for (const task of pendingBlocks.values()) task.reject(new Error('Syntax highlighting unavailable'));
    pending.clear();
    pendingBlocks.clear();
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

function postBlocks(request: Omit<BlocksRequest, 'type' | 'id'>): Promise<BlocksResponse> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pendingBlocks.set(id, {resolve, reject});
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
    try { getWorker().postMessage({...request, type: 'blocks', id} satisfies BlocksRequest); }
    catch (error) {pendingBlocks.delete(id); reject(error instanceof Error ? error : new Error(String(error))); scheduleIdleRelease();}
  });
}

let nextDoc = 0;
/** Tokens beyond this many blocks from the viewport are dropped on the main thread and asked for again if scrolled back to. */
const KEPT_BLOCKS = 48;

/**
 * The colours of one source for a windowed view, fetched a block of lines at a time. The worker keeps the document
 * (and the grammar state after the last block it tokenised), so only the blocks the view has mounted, with a block of
 * margin either side, are made and sent. Blocks are made in order, so a jump far down the file waits for the blocks
 * above it; the rows show plain text until theirs arrive.
 */
class TokenWindow {
  private readonly blocks = new Map<number, Token[][]>();
  private readonly asked = new Set<number>();
  private readonly doc = ++nextDoc;
  private opened = false;
  private closed = false;
  private unavailable = false;
  private first = 0;
  private last = 0;
  constructor(readonly source: string, readonly language: string, private readonly changed: () => void) {}

  tokens(line: number): Token[] | undefined {
    return this.blocks.get(Math.floor(line / BLOCK_LINES))?.[line % BLOCK_LINES];
  }

  want(first: number, last: number): void {
    this.first = first; this.last = last;
    if (this.closed || this.unavailable) return;
    const from = Math.max(0, Math.floor(first / BLOCK_LINES) - 1), to = Math.floor(last / BLOCK_LINES) + 1;
    let run: number | undefined;
    for (let block = from; block <= to + 1; block++) {
      const needed = block <= to && !this.blocks.has(block) && !this.asked.has(block);
      if (needed && run === undefined) run = block;
      if (!needed && run !== undefined) { this.send(run, block - 1); run = undefined; }
    }
    this.prune(from, to);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.blocks.clear();
    if (this.opened && worker) worker.postMessage({type: 'close', doc: this.doc} satisfies CloseRequest);
  }

  private send(from: number, to: number): void {
    for (let block = from; block <= to; block++) this.asked.add(block);
    const source = this.opened ? undefined : this.source;
    this.opened = true;
    postBlocks({doc: this.doc, language: this.language, from, to, source}).then(response => {
      if (this.closed) return;
      if ('missing' in response) {
        // The worker released the document (idle, or too many grammars); start it again from the source.
        this.opened = false; this.asked.clear();
        this.want(this.first, this.last);
        return;
      }
      if (!response.blocks) { this.unavailable = true; return; }
      for (const block of response.blocks) this.blocks.set(block.start / BLOCK_LINES, block.rows);
      this.changed();
    }).catch(() => { this.unavailable = true; });
  }

  private prune(from: number, to: number): void {
    if (this.blocks.size <= KEPT_BLOCKS) return;
    const middle = (from + to) / 2;
    const far = [...this.blocks.keys()].sort((a, b) => Math.abs(b - middle) - Math.abs(a - middle));
    for (const block of far.slice(0, this.blocks.size - KEPT_BLOCKS)) { this.blocks.delete(block); this.asked.delete(block); }
  }
}

/** Colours for lines `first`..`last` of `source`, for a view that mounts only some of its rows. `source` '' asks for none.
 *  The returned lookup changes identity whenever new blocks arrive, so rows that use it redraw. */
export function useWindowTokens(source: string, language: string, first: number, last: number): (line: number) => Token[] | undefined {
  const normalized = normalizeCodeLanguage(language);
  const [version, setVersion] = useState(0);
  const session = useRef<TokenWindow | null>(null);
  useEffect(() => {
    if (!source) return;
    const next = new TokenWindow(source, normalized, () => setVersion(count => count + 1));
    session.current = next;
    next.want(first, last);
    return () => { next.close(); if (session.current === next) session.current = null; };
  }, [source, normalized]);
  const firstBlock = Math.floor(first / BLOCK_LINES), lastBlock = Math.floor(last / BLOCK_LINES);
  useEffect(() => { session.current?.want(first, last); }, [firstBlock, lastBlock]);
  return useMemo(() => (line: number) => {
    const current = session.current;
    return current && current.source === source && current.language === normalized ? current.tokens(line) : undefined;
  }, [source, normalized, version]);
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
  return <code className={className}>{lines.map((line, index) => <React.Fragment key={index}>{index > 0 && '\n'}{lineContent(line, highlighted.sourceLines[index]===line ? highlighted.rows[index] : undefined)}</React.Fragment>)}</code>;
});

/** In-file Find over the table: every match is marked, the current one distinguished, and the colours stay. */
export interface TableFind { query: string; matches: readonly number[]; current: number }

export function HighlightedSourceTable({source, language, targetLine, find}: {source: string; language: string; targetLine?: number; find?: TableFind}): React.ReactElement {
  const highlighted = useHighlightedTokens(source, language, 0);
  const lines = source === '' ? [] : source.split('\n');
  const starts = useMemo(() => find?.matches.length ? lineStarts(lines) : [], [source, find?.matches.length]);
  const table = useRef<HTMLTableElement>(null);
  const match = find?.matches[find.current];
  useLayoutEffect(() => { if (match !== undefined) table.current?.querySelector('mark[data-current="true"]')?.scrollIntoView({block: 'center'}); }, [match, find?.query]);
  return <table ref={table} className="code-table source-code-table"><tbody>{lines.map((line, index) => {
    const marks: FindMarks | undefined = find?.matches.length ? {starts: find.matches, length: find.query.length, current: find.current, lineStart: starts[index]} : undefined;
    return <tr key={index} data-line={index + 1} className={index + 1 === targetLine ? 'file-line-target' : undefined}>
      <td className="code-no">{index + 1}</td>
      <td className="code-line">{lineContent(line, highlighted?.sourceLines[index]===line ? highlighted.rows[index] : undefined, marks)}</td>
    </tr>;
  })}</tbody></table>;
}
