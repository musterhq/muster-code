/** File references in replies become links, as Codex writes them: `src/app.py:342` or "fleet_status.py (line 134)".
 *
 * A remark plugin for chat replies. Inline code that is only a path, and plain-text paths with a known extension,
 * become links marked `data-auto-file`; ResourceLink resolves them inside the conversation's folders and leaves
 * anything it cannot find as ordinary text. URLs, code blocks and existing links are never touched. */
import type {Link, Parent, Root, RootContent, Text} from 'mdast';

const EXTENSIONS = 'tsx?|jsx?|mjs|cjs|py|pyi|rb|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|php|sql|jsonc?|ya?ml|toml|ini|cfg|conf|mdx?|txt|rst|sh|bash|zsh|fish|ps1|css|scss|less|html?|vue|svelte|lua|r|scala|dart|exs?|erl|proto|graphql|gql|gradle|xml|plist|lock|env|tf|tfvars|hcl|ipynb|csv|tsv|log|pdf|docx|xlsx|pptx|png|jpe?g|gif|svg';
const NAMES = 'Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Justfile|Caddyfile|Brewfile';
const PATH = `(?:\\.{0,2}/)?(?:[\\w@.+-]+/)*(?:[\\w@.+-]+\\.(?:${EXTENSIONS})|(?:${NAMES}))`;
/** A whole inline-code value: path, then `:12`, `:12-20`, `:12:5`, `#L12` or " (line 12)". */
const CODE_REF = new RegExp(`^(${PATH})(?::(\\d+)(?:[-:]\\d+)?|#L(\\d+)(?:-L?\\d+)?| \\(line (\\d+)\\))?$`);
/** The same inside prose, bounded so e-mail addresses, URLs and version numbers are not matched. */
const TEXT_REF = new RegExp(`(?<![\\w@/:.\\-])(${PATH})(?::(\\d+)(?:[-:]\\d+)?|#L(\\d+)(?:-L?\\d+)?| \\(line (\\d+)\\))?(?![\\w/@-]|\\.\\w)`, 'g');

export interface FileMention { path: string; line?: number }

const toMention = (path: string, a?: string, b?: string, c?: string): FileMention | null => {
  if (path.includes('://') || path.length > 240) return null;
  const line = Number(a ?? b ?? c);
  return {path, ...(Number.isInteger(line) && line > 0 ? {line} : {})};
};

export function parseCodeReference(value: string): FileMention | null {
  const match = CODE_REF.exec(value.trim());
  return match ? toMention(match[1]!, match[2], match[3], match[4]) : null;
}

export function findTextReferences(text: string): Array<FileMention & {start: number; end: number; text: string}> {
  const found: Array<FileMention & {start: number; end: number; text: string}> = [];
  for (const match of text.matchAll(TEXT_REF)) {
    const mention = toMention(match[1]!, match[2], match[3], match[4]);
    if (mention && match.index !== undefined) found.push({...mention, start: match.index, end: match.index + match[0].length, text: match[0]});
  }
  return found;
}

/** What a code-form reference reads as: the file name, plus "(line N)". */
export function mentionLabel(mention: FileMention): string {
  const name = mention.path.split('/').filter(Boolean).pop() ?? mention.path;
  return mention.line ? `${name} (line ${mention.line})` : name;
}

const hrefOf = (mention: FileMention) => `${mention.path}${mention.line ? `:${mention.line}` : ''}`;
const linkNode = (mention: FileMention, label: string): Link => ({
  type: 'link', url: hrefOf(mention), children: [{type: 'text', value: label}],
  data: {hProperties: {dataAutoFile: 'true', title: hrefOf(mention)}},
});

const SKIP = new Set(['link', 'linkReference', 'code', 'html', 'definition', 'heading']);

export function remarkFileLinks() {
  return (tree: Root) => {
    const walk = (parent: Parent) => {
      const next: RootContent[] = [];
      let changed = false;
      for (const child of parent.children as RootContent[]) {
        if (child.type === 'inlineCode') {
          const mention = parseCodeReference(child.value);
          if (mention) { next.push(linkNode(mention, mentionLabel(mention))); changed = true; continue; }
        }
        if (child.type === 'text') {
          const refs = findTextReferences(child.value);
          if (refs.length) {
            let at = 0;
            for (const ref of refs) {
              if (ref.start > at) next.push({type: 'text', value: child.value.slice(at, ref.start)} as Text);
              next.push(linkNode(ref, ref.text));
              at = ref.end;
            }
            if (at < child.value.length) next.push({type: 'text', value: child.value.slice(at)} as Text);
            changed = true;
            continue;
          }
        }
        if ('children' in child && !SKIP.has(child.type)) walk(child as Parent);
        next.push(child);
      }
      if (changed) parent.children = next as Parent['children'];
    };
    walk(tree);
  };
}
