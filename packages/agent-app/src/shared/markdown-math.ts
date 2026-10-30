/* Portions adapted from T3 Code (https://github.com/pingdotgg/t3code, commit fa4f3a2), packages/shared/src/markdownMath.ts. Copyright (c) 2026 T3 Tools Inc., MIT License; see THIRD-PARTY-NOTICES.md and licenses/t3code-MIT.txt. */
/**
 * Maths in replies: `$…$`, `$$…$$`, `\(…\)` and `\[…\]`, read by remark-math on the patched tokenizer in
 * patched-packages/ (prices and shell variables stay text, an unfinished formula stays text while a reply streams,
 * TeX pipes stay inside a table cell). Pure (no DOM), so node tests drive the same parser the renderer uses.
 */
/// <reference types="mdast-util-to-hast" />
import type {Root, RootContent} from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import {unified} from 'unified';

/** remark-math's options for replies: a single `$` opens inline maths (the tokenizer keeps `$5 and $10` as text). */
export const REMARK_MATH_OPTIONS = {singleDollarTextMath: true} as const;

const mathParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath, REMARK_MATH_OPTIONS).freeze();

/** The Markdown tree a reply's renderer builds, maths included. */
export function parseMarkdownWithMath(source: string): Root {
  return mathParser.parse(source);
}

export interface MarkdownMathRange { start: number; end: number; source: string; tex: string; display: boolean; inTable: boolean }

/** Closed formulas, with the source as written (delimiters included). */
export function markdownMathRanges(source: string, tree?: Root): MarkdownMathRange[] {
  const ranges: MarkdownMathRange[] = [];
  if (!mayContainMath(source)) return ranges;
  const visit = (node: Root | RootContent, inTable = false): void => {
    const table = inTable || node.type === 'tableCell';
    if (node.type === 'math' || node.type === 'inlineMath' || (node.type === 'code' && node.lang === 'math')) {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const authored = source.slice(start, end);
      if (node.type === 'code') {
        const open = /^[ \t]*(`{3,}|~{3,})/.exec(authored)?.[1];
        const close = /\n[ \t>]*(`{3,}|~{3,})[ \t\r]*$/.exec(authored)?.[1];
        if (!open || !close || open[0] !== close[0] || close.length < open.length) return;
      }
      const display = node.type !== 'inlineMath' || /^(?:\$\$|\\\[)/.test(authored);
      ranges.push({start, end, source: authored, tex: node.value, display, inTable: table});
    } else if ('children' in node) for (const child of node.children) visit(child as RootContent, table);
  };
  visit(tree ?? parseMarkdownWithMath(source));
  return ranges;
}

/** Text without these characters skips maths parsing entirely. */
export function mayContainMath(text: string): boolean {
  return text.includes('$') || text.includes('\\(') || text.includes('\\[') || /(?:`{3,}|~{3,})[ \t]*math\b/.test(text);
}

/** remark-math marks a formula's `<code>` with `language-math` plus `math-inline` or `math-display`. */
export function mathKind(className: string | undefined): 'inline' | 'display' | null {
  if (!className?.includes('language-math')) return null;
  if (className.includes('math-display')) return 'display';
  return className.includes('math-inline') ? 'inline' : null;
}
