import {copyText} from '../clipboard';
import { Check, Copy, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import {ResourceLink, type ResourceContext} from './ResourceLink';
import {MarkdownTable} from './MarkdownTable';
import remarkGfm from 'remark-gfm';
import { createIncrementalMarkdownPlugin } from '../markdown-incremental';
import {markdownHeadingId} from './markdownAnchors';

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

function Pre({ children }: { children?: React.ReactNode }): React.ReactElement {
  const child = Array.isArray(children) ? children[0] : children;
  if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(child)) {
    const lang = /language-([\w+-]+)/.exec(child.props.className ?? '')?.[1];
    const text = codeText(child.props.children);
    return (
      <div className="md-code">
        <div className="md-code-head">
          <span className="md-code-lang">{lang ?? 'text'}</span>
          <CopyButton getText={() => text} label="Copy code" />
        </div>
        <pre className="md-code-body">{children}</pre>
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

function MessageBodyContent({ text, resourceContext }: { text: string; resourceContext?: ResourceContext }): React.ReactElement {
  const remarkPlugins = React.useMemo(() => [remarkGfm, createIncrementalMarkdownPlugin()], []);
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
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        skipHtml
        urlTransform={safeUrl}
        components={renderers}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// Composer drafts and streaming updates in another message must not reparse an
// unchanged Markdown document. Link previews still subscribe to scope changes.
export const MessageBody = React.memo(MessageBodyContent, (previous, next) =>
  previous.text === next.text &&
  previous.resourceContext?.folderId === next.resourceContext?.folderId &&
  previous.resourceContext?.path === next.resourceContext?.path,
);
