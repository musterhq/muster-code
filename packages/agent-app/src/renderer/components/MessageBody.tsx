import {copyText} from '../clipboard';
import { advanceFade, createFadeState, rehypeStreamFade, type FadeState } from '../markdown-fade';
import { Check, Code, Copy, Quote, WrapText, X } from 'lucide-react';
import {addComposerContext} from '../composerContext';
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import {ResourceLink, type ResourceContext} from './ResourceLink';
import {MarkdownTable} from './MarkdownTable';
import remarkGfm from 'remark-gfm';
import { createIncrementalMarkdownPlugin } from '../markdown-incremental';
import {markdownHeadingId} from './markdownAnchors';
import {HighlightedCode} from './HighlightedCode';
import {inferMarkdownCodeLanguages} from './codeLanguage';

import './message-body.css';

const HAS_PROTOCOL = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_PROTOCOL = /^(https?|mailto):/i;

/** Allow http(s)/mailto and relative refs; drop javascript:, data:, etc. */
export function safeUrl(url: string): string | null {
  const value = url.trim();
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (HAS_PROTOCOL.test(value) && !/^[^:]+:\d+(?::\d+)?$/.test(value)) return SAFE_PROTOCOL.test(value) ? value : null;
  return value;
}

type CopyState = 'idle' | 'copied' | 'error';

export function CopyButton({
  getText,
  label,
}: {
  getText: () => string;
  label: string;
}): React.ReactElement {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = () => {
    copyText(getText()).then(
      () => setState('copied'),
      () => setState('error'),
    );
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setState('idle');
    }, 1500);
  };

  return (
    <button
      type="button"
      className="md-copy"
      data-state={state}
      aria-label={state === 'error' ? `${label} failed` : state === 'copied' ? `${label} copied` : label}
      title={label}
      onClick={onClick}
    >
      {state === 'copied' ? <Check size={13} /> : state === 'error' ? <X size={13} /> : <Copy size={13} />}
    </button>
  );
}

/** Flatten a fenced code block's children to the literal source text. */
function codeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(codeText).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(children)) {
    return codeText(children.props.children);
  }
  return '';
}

const LANGUAGE_NAMES: Record<string, string> = {
  text: 'Plain text', txt: 'Plain text', plaintext: 'Plain text', plain: 'Plain text',
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX', js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript', cjs: 'JavaScript',
  sh: 'Shell', shell: 'Shell', bash: 'Bash', zsh: 'Zsh', console: 'Terminal', shellsession: 'Terminal', ps1: 'PowerShell', powershell: 'PowerShell',
  py: 'Python', python: 'Python', rb: 'Ruby', ruby: 'Ruby', go: 'Go', rs: 'Rust', rust: 'Rust', java: 'Java', kt: 'Kotlin', kotlin: 'Kotlin', swift: 'Swift',
  c: 'C', h: 'C', cpp: 'C++', 'c++': 'C++', cs: 'C#', csharp: 'C#', php: 'PHP', sql: 'SQL', json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  ini: 'INI', xml: 'XML', html: 'HTML', css: 'CSS', scss: 'SCSS', md: 'Markdown', markdown: 'Markdown', diff: 'Diff', patch: 'Diff', dockerfile: 'Dockerfile',
  graphql: 'GraphQL', proto: 'Protocol Buffers', lua: 'Lua', r: 'R', scala: 'Scala', dart: 'Dart', elixir: 'Elixir', ex: 'Elixir', vue: 'Vue', svelte: 'Svelte', make: 'Makefile', makefile: 'Makefile',
};
/** The fence's language as people say it ("Plain text", "TypeScript"), not its short tag. */
export function languageLabel(lang?: string): string {
  if (!lang) return 'Plain text';
  const key = lang.toLowerCase();
  return LANGUAGE_NAMES[key] ?? (lang.length <= 4 ? lang.toUpperCase() : lang[0]!.toUpperCase() + lang.slice(1));
}

function Pre({ children }: { children?: React.ReactNode }): React.ReactElement {
  const child = Array.isArray(children) ? children[0] : children;
  const [wrap, setWrap] = useState(false);
  if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(child)) {
    const lang = /language-([\w+-]+)/.exec(child.props.className ?? '')?.[1];
    // The fence's closing newline is not a code line (QA: a blank line trailed every block).
    const text = codeText(child.props.children).replace(/\r?\n$/, '');
    return (
      <div className="md-code">
        <div className="md-code-head">
          <span className="md-code-lang"><Code size={13} aria-hidden="true" />{languageLabel(lang)}</span>
          <span className="md-code-actions">
            <button type="button" className="md-copy md-code-wrap" aria-pressed={wrap} aria-label={wrap ? 'Stop wrapping lines' : 'Wrap long lines'} title={wrap ? 'Stop wrapping lines' : 'Wrap long lines'} onClick={() => setWrap(value => !value)}><WrapText size={13} aria-hidden="true" /></button>
            <CopyButton getText={() => text} label="Copy code" />
          </span>
        </div>
        <pre className={`md-code-body${wrap ? ' is-wrapped' : ''}`}><HighlightedCode source={text} language={lang ?? 'text'}/></pre>
      </div>
    );
  }
  return <pre>{children}</pre>;
}

function Heading({
  level,
  children,
  node: _node,
  id: providedId,
  ...props
}: {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children?: React.ReactNode;
  node?: unknown;
} & React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement {
  const tag = `h${level}` as keyof React.JSX.IntrinsicElements;
  const id = providedId ?? markdownHeadingId(codeText(children));
  return React.createElement(tag, {
    ...props,
    id,
    tabIndex: -1,
  }, children);
}

const components: Components = {
  pre: Pre,
  table: ({node: _node, ...props}) => <MarkdownTable {...props}/>,
  a: ({ children, href }) => <ResourceLink href={href}>{children}</ResourceLink>,
  h1: ({node, children, ...props}) => <Heading level={1} node={node} {...props}>{children}</Heading>,
  h2: ({node, children, ...props}) => <Heading level={2} node={node} {...props}>{children}</Heading>,
  h3: ({node, children, ...props}) => <Heading level={3} node={node} {...props}>{children}</Heading>,
  h4: ({node, children, ...props}) => <Heading level={4} node={node} {...props}>{children}</Heading>,
  h5: ({node, children, ...props}) => <Heading level={5} node={node} {...props}>{children}</Heading>,
  h6: ({node, children, ...props}) => <Heading level={6} node={node} {...props}>{children}</Heading>,
};

/**
 * CMP-18: selecting text in an assistant reply offers "Quote", which adds it to the composer
 * as a quote chip that links back to the message. Its own state, so the Markdown never re-renders.
 */
function SelectionQuote({ container }: { container: React.RefObject<HTMLDivElement | null> }): React.ReactElement | null {
  const [offer, setOffer] = useState<{ text: string; itemId: string; left: number; top: number } | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    const body = container.current;
    if (!body) return;
    const read = () => {
      const selection = window.getSelection?.(), value = selection?.toString().trim() ?? '';
      const row = body.closest<HTMLElement>('[data-item-id]');
      if (!selection || !value || !selection.rangeCount || !row || !body.closest('.msg-assistant') || !body.contains(selection.anchorNode) || !body.contains(selection.focusNode)) { setOffer(null); return; }
      const rect = selection.getRangeAt(0).getBoundingClientRect(), box = body.getBoundingClientRect();
      setNote(''); setOffer({ text: value, itemId: row.dataset.itemId ?? '', left: Math.max(0, Math.min(rect.left - box.left + rect.width / 2, box.width)), top: Math.max(0, rect.top - box.top) });
    };
    const clear = () => { if (!window.getSelection?.()?.toString().trim()) setOffer(null); };
    body.addEventListener('mouseup', read); body.addEventListener('keyup', read);
    document.addEventListener('selectionchange', clear);
    return () => { body.removeEventListener('mouseup', read); body.removeEventListener('keyup', read); document.removeEventListener('selectionchange', clear); };
  }, [container]);
  if (!offer) return note ? <span className="md-quote-note" role="status">{note}</span> : null;
  const quote = () => {
    const words = offer.text.replace(/\s+/g, ' ');
    const label = `“${words.length > 48 ? `${words.slice(0, 47)}…` : words}”`;
    if (addComposerContext({ type: 'quote', label, text: offer.text, source: { kind: 'assistant', itemId: offer.itemId, at: new Date().toISOString() } })) { window.getSelection?.()?.removeAllRanges(); setOffer(null); return; }
    copyText(offer.text.split('\n').map(line => `> ${line}`).join('\n')).then(() => { setOffer(null); setNote('Quote copied'); }, () => setNote('Could not quote'));
  };
  return <button type="button" className="md-quote" style={{ left: offer.left, top: offer.top }} onMouseDown={event => event.preventDefault()} onClick={quote} aria-label="Quote in reply" title="Quote in reply"><Quote size={12} />Quote</button>;
}

function MessageBodyContent({ text, resourceContext, animate = false }: { text: string; resourceContext?: ResourceContext; animate?: boolean }): React.ReactElement {
  const remarkPlugins = React.useMemo(() => [remarkGfm, createIncrementalMarkdownPlugin()], []);
  const renderedText = React.useMemo(() => inferMarkdownCodeLanguages(text), [text]);
  // Streaming fade (markdown-fade.ts): text that arrives after the first render fades in.
  const fade = useRef<FadeState | null>(null);
  fade.current = animate ? (fade.current ? advanceFade(fade.current, renderedText) : createFadeState(renderedText)) : null;
  const rehypePlugins = React.useMemo(() => [rehypeStreamFade(() => fade.current)], []);
  const renderers = React.useMemo<Components>(() => {
    // ReactMarkdown renders duplicate headings in one pass. Keep fragment targets
    // deterministic while avoiding collisions that would jump to the wrong section.
    const headingCounts = new Map<string, number>();
    const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) => ({node, children, ...props}: any) => {
      const base = markdownHeadingId(codeText(children));
      const occurrence = headingCounts.get(base) ?? 0;
      headingCounts.set(base, occurrence + 1);
      const id = occurrence === 0 ? base : `${base}-${occurrence + 1}`;
      return <Heading level={level} node={node} id={id} {...props}>{children}</Heading>;
    };
    return {
      ...components,
      h1: heading(1), h2: heading(2), h3: heading(3),
      h4: heading(4), h5: heading(5), h6: heading(6),
      ...(resourceContext ? {
        a: ({ children, href }: any) => <ResourceLink href={href} context={resourceContext}>{children}</ResourceLink>,
        // Opening a local document must not trigger remote requests or arbitrary file reads.
        img: ({alt}: any) => <span className="md-unavailable-link">[Image: {alt || 'image'} — preview unavailable]</span>,
      } : {}),
    } as Components;
  }, [text, resourceContext?.folderId, resourceContext?.path]);
  const body = useRef<HTMLDivElement>(null);
  return (
    <div className="md-body" ref={body}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        skipHtml
        urlTransform={safeUrl}
        components={renderers}
      >
        {renderedText}
      </ReactMarkdown>
      <SelectionQuote container={body} />
    </div>
  );
}

// Composer drafts and streaming updates in another message must not reparse an
// unchanged Markdown document. Link previews still subscribe to scope changes.
export const MessageBody = React.memo(MessageBodyContent, (previous, next) =>
  previous.text === next.text &&
  previous.animate === next.animate &&
  previous.resourceContext?.folderId === next.resourceContext?.folderId &&
  previous.resourceContext?.path === next.resourceContext?.path,
);
