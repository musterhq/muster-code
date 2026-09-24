/** Streaming fade-in for Markdown replies.
 *
 * While a reply grows, each render's newly arrived text becomes its own `span.md-fade` that
 * animates in once (message-body.css). Spans are only ever appended while the text grows: the
 * JSX runtime keys siblings by tag and count (span-0, span-1, …), so folding old spans back into
 * text would shift every later key and make React reuse finished elements for new text. A remount
 * (switching chats, reopening) renders plain text again. Only text nodes whose value maps 1:1 onto
 * the source (no escapes or entities) are split; code and pre are never touched. */
import type {Element, ElementContent, Root, Text} from 'hast';

export interface FadeState {
  /** Source length when the message first rendered: text before this never fades. */
  base: number;
  /** Stretch starts (renderedText offsets), ascending. */
  starts: number[];
  text: string;
}

export function createFadeState(text: string): FadeState {
  return {base: text.length, starts: [], text};
}

/** Records a new render of `text`. Growth appends a stretch; anything else (an edit, a replacement) resets. */
export function advanceFade(state: FadeState, text: string): FadeState {
  if (text === state.text) return state;
  if (!text.startsWith(state.text)) return createFadeState(text);
  return {base: state.base, starts: [...state.starts, state.text.length], text};
}

/** Offsets where a text node should be split, and whether each piece fades. */
export function fadePieces(start: number, end: number, state: FadeState): Array<{from: number; to: number; fade: boolean}> {
  if (end <= state.base) return [{from: start, to: end, fade: false}];
  const cuts = [state.base, ...state.starts].filter(offset => offset > start && offset < end);
  const bounds = [start, ...cuts, end];
  const pieces: Array<{from: number; to: number; fade: boolean}> = [];
  for (let i = 0; i < bounds.length - 1; i++) pieces.push({from: bounds[i]!, to: bounds[i + 1]!, fade: bounds[i]! >= state.base});
  return pieces.filter(piece => piece.to > piece.from);
}

const SKIP = new Set(['code', 'pre', 'svg', 'math']);

/** rehype plugin; `read` returns the current state (null = no animation). */
export function rehypeStreamFade(read: () => FadeState | null) {
  return () => (tree: Root) => {
    const state = read();
    if (!state || (!state.starts.length && state.base >= state.text.length)) return;
    const walk = (parent: Root | Element) => {
      const next: Array<ElementContent | Root['children'][number]> = [];
      let changed = false;
      for (const child of parent.children) {
        if (child.type === 'element') { if (!SKIP.has(child.tagName)) walk(child); next.push(child); continue; }
        if (child.type !== 'text') { next.push(child); continue; }
        const text = child as Text, start = text.position?.start.offset, end = text.position?.end.offset;
        if (start === undefined || end === undefined || end - start !== text.value.length || end <= state.base) { next.push(child); continue; }
        for (const piece of fadePieces(start, end, state)) {
          const value = text.value.slice(piece.from - start, piece.to - start);
          if (!piece.fade) { next.push({type: 'text', value}); continue; }
          const line = text.position!.start.line;
          next.push({type: 'element', tagName: 'span', properties: {className: ['md-fade']}, children: [{type: 'text', value}],
            position: {start: {line, column: piece.from, offset: piece.from}, end: {line, column: piece.to, offset: piece.to}}});
        }
        changed = true;
      }
      if (changed) (parent as Element).children = next as ElementContent[];
    };
    walk(tree);
  };
}
