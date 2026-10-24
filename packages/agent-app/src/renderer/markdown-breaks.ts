import type {Parent, Root, Text} from 'mdast';

/** Preserve soft breaks in paragraphs, including list items and quoted prose.
 *
 * Each line keeps a source position when the text maps 1:1 onto the source, so the
 * streaming fade (markdown-fade.ts) still animates text that arrives on a new line. */
export function remarkProseBreaks() {
  return (tree: Root) => {
    // Runs on every streaming render: children are rebuilt only where a line actually breaks.
    const walk = (parent: Parent, prose: boolean) => {
      if (parent.type === 'table') return;
      prose ||= parent.type === 'paragraph';
      let breaks = false;
      for (const child of parent.children) {
        if ('children' in child) walk(child, prose);
        else if (prose && child.type === 'text' && (child.value.includes('\n') || child.value.includes('\r'))) breaks = true;
      }
      if (breaks) parent.children = parent.children.flatMap((child): Parent['children'] => child.type === 'text' && /[\r\n]/.test(child.value) ? splitLines(child) : [child]);
    };
    walk(tree, false);
  };
}

// A plain <br>. mdast `break` also emits a "\n" text node after each <br>; a node that renders nothing
// still costs React and the DOM on every streaming render, so prose breaks leave it out.
const LINE_BREAK = () => ({type: 'proseBreak', data: {hName: 'br'}}) as unknown as Parent['children'][number];

function splitLines(text: Text): Parent['children'] {
  const start = text.position?.start, end = text.position?.end;
  const mapped = start?.offset !== undefined && end?.offset !== undefined && end.offset - start.offset === text.value.length;
  const out: Parent['children'] = [];
  const newline = /\r\n|\r|\n/g;
  let from = 0, line = start?.line ?? 1, column = start?.column ?? 1;
  for (;;) {
    const match = newline.exec(text.value);
    const to = match ? match.index : text.value.length;
    const value = text.value.slice(from, to);
    out.push(mapped ? {type: 'text', value, position: {
      start: {line, column, offset: start!.offset! + from},
      end: {line, column: column + value.length, offset: start!.offset! + to},
    }} : {type: 'text', value});
    if (!match) return out;
    out.push(LINE_BREAK());
    from = to + match[0].length; line++; column = 1;
  }
}
