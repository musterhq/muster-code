/* Portions adapted from T3 Code (https://github.com/pingdotgg/t3code, commit fa4f3a2), apps/web/src/components/chat/MathTypeset.tsx. Copyright (c) 2026 T3 Tools Inc., MIT License; see THIRD-PARTY-NOTICES.md and licenses/t3code-MIT.txt. */
/** KaTeX lives in this lazily loaded chunk, so it is only fetched once a reply holds a formula (#785). */
import katex from 'katex';
import React from 'react';

const MAX_ENTRIES = 1000, MAX_BYTES = 4 * 1024 * 1024;
// Virtualised conversations remount messages while scrolling; cached markup keeps that from typesetting the same formulas
// again. Least recently used first out, capped by count and by size. "" records a parse error.
const cache = new Map<string, string>();
let cachedBytes = 0;
const sizeOf = (key: string, html: string) => (key.length + html.length) * 2;

function remember(key: string, html: string): void {
  cache.set(key, html);
  cachedBytes += sizeOf(key, html);
  for (const [oldest, value] of cache) {
    if (cache.size <= MAX_ENTRIES && cachedBytes <= MAX_BYTES) break;
    cache.delete(oldest);
    cachedBytes -= sizeOf(oldest, value);
  }
}

export function typeset(tex: string, display: boolean): string {
  const key = `${display ? 'display' : 'inline'}:${tex}`;
  const cached = cache.get(key);
  if (cached !== undefined) { cache.delete(key); cache.set(key, cached); return cached; }
  let html = '';
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      output: 'htmlAndMathml',
      throwOnError: true,
      // No \href, \url, \htmlClass or any other command that emits active HTML.
      trust: false,
      strict: 'ignore',
      maxSize: 20,
      maxExpand: 1000,
    });
  } catch { /* unfinished or unsupported TeX stays readable as its source */ }
  remember(key, html);
  return html;
}

export default function MathTypeset({tex, display, fallback}: {tex: string; display: boolean; fallback: React.ReactNode}): React.ReactNode {
  const html = typeset(tex, display);
  if (!html) return fallback;
  // KaTeX escapes the TeX it renders, and `trust: false` keeps it from emitting links or attributes.
  return <span className="md-math-typeset" dangerouslySetInnerHTML={{__html: html}}/>;
}
