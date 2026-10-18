import type {Parent, Root} from 'mdast';

/** Preserve soft breaks in paragraphs, including list items and quoted prose. */
export function remarkProseBreaks() {
  return (tree: Root) => {
    const walk = (parent: Parent, prose = false) => {
      if (parent.type === 'table') return;
      prose ||= parent.type === 'paragraph';
      for (const child of parent.children) if ('children' in child) walk(child, prose);
      if (!prose) return;
      parent.children = parent.children.flatMap((child): Parent['children'] => {
        if (child.type !== 'text' || !/[\r\n]/.test(child.value)) return [child];
        return child.value.split(/\r\n|\r|\n/).flatMap((value, line): Parent['children'] => [
          ...(line ? [{type: 'break' as const}] : []),
          {type: 'text', value},
        ]);
      });
    };
    walk(tree);
  };
}
