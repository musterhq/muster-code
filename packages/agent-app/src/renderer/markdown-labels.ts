/** Light emphasis for plain-text replies: a leading "Label:" is shown in bold.
 *
 * A conservative remark plugin for assistant replies. It never changes the text, only wraps the label (colon
 * included) of a paragraph or list item in a `strong.md-label`. A label is 1-4 words, under 32 characters,
 * starts with a letter, holds only letters, digits, spaces and - & ' /, and is followed by whitespace or the end
 * of the paragraph. So "Note:", "Root cause:" and "Next step:" match; "10:30", "https://x", "src/app.py:12",
 * "Run `ls`: now" and "Here is what I found in the logs: x" do not. Only a paragraph's first text node is
 * considered: code, links and existing emphasis are never inside or before it. */
import type {Paragraph, Parent, PhrasingContent, Root, Strong, Text} from 'mdast';

const LABEL = /^(\p{L}[\p{L}\p{N}'’&/-]*(?: [\p{L}\p{N}'’&/-]+){0,3}):(?=\s|$)/u;
const MAX_LABEL = 32;

/** The label at the start of `text` including its colon, or null. */
export function leadingLabel(text: string): string | null {
  const match = LABEL.exec(text);
  if (!match) return null;
  const label = `${match[1]}:`;
  return label.length < MAX_LABEL ? label : null;
}

/** Source positions for a piece of the first text node, so the streaming fade (markdown-fade.ts) can still map it. */
function piece<T extends Text | Strong>(node: T, original: Text, from: number, length: number): T {
  const p = original.position, start = p?.start.offset;
  if (!p || start === undefined || p.end.offset === undefined || p.end.offset - start !== original.value.length) return node;
  const point = (offset: number) => ({line: p.start.line, column: p.start.column + offset, offset: start + offset});
  node.position = {start: point(from), end: point(from + length)};
  return node;
}

function emphasize(paragraph: Paragraph): void {
  const first = paragraph.children[0];
  if (!first || first.type !== 'text') return;
  const label = leadingLabel(first.value);
  if (!label) return;
  const strong = piece<Strong>({type: 'strong', data: {hProperties: {className: ['md-label']}}, children: [piece<Text>({type: 'text', value: label}, first, 0, label.length)]}, first, 0, label.length);
  const rest = first.value.slice(label.length);
  paragraph.children.splice(0, 1, strong, ...(rest ? [piece<Text>({type: 'text', value: rest}, first, label.length, rest.length)] : []));
}

export function remarkLeadingLabels() {
  return (tree: Root) => {
    const walk = (node: Parent) => {
      for (const child of node.children) {
        if (child.type === 'paragraph') emphasize(child);
        else if (child.type === 'blockquote' || child.type === 'list' || child.type === 'listItem') walk(child);
      }
    };
    walk(tree);
  };
}
