/** Marks the rich fences (```mermaid, ```chart, ```html-report) whose closing fence has not arrived yet.
 *
 * While a reply streams, the text ends mid-fence and the fenced block runs to the end of the text. Such a block must stay an
 * ordinary code block (Mermaid cannot parse half a diagram); it becomes a RichBlock when the closing fence arrives. The mark
 * is `data-fence-open="true"` on the `<code>` element, read by MessageBody's `Pre`. Nothing else about the tree changes. */
import type {Code, Parent, Root, RootContent} from 'mdast';
import {fenceIsClosed, richKindOfFence} from '../shared/rich-fence';

interface FileLike { value?: unknown }

function walk(node: Root | RootContent, source: string): void {
  if (node.type === 'code') {
    const code = node as Code;
    const start = code.position?.start.offset, end = code.position?.end.offset;
    if (richKindOfFence(code.lang ?? undefined) && start !== undefined && end !== undefined && !fenceIsClosed(source, start, end)) {
      const data = (code.data ??= {}) as {hProperties?: Record<string, unknown>};
      data.hProperties = {...data.hProperties, 'data-fence-open': 'true'};
    }
    return;
  }
  if ('children' in node) for (const child of (node as Parent).children) walk(child as RootContent, source);
}

export function remarkRichFences() {
  return (tree: Root, file: FileLike): void => {
    const source = typeof file.value === 'string' ? file.value : String(file.value ?? '');
    walk(tree, source);
  };
}
