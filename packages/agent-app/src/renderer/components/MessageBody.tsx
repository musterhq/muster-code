import {copyText} from '../clipboard';
import { Check, Copy, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import {ResourceLink} from './ResourceLink';
import {MarkdownTable} from './MarkdownTable';
import remarkGfm from 'remark-gfm';

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

const components: Components = {
  pre: Pre,
  table: ({node: _node, ...props}) => <MarkdownTable {...props}/>,
  a: ({ children, href }) => <ResourceLink href={href}>{children}</ResourceLink>,
};

export function MessageBody({ text }: { text: string }): React.ReactElement {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeUrl}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
