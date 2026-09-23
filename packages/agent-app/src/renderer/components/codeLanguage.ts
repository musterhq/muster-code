const EXTENSION_LANGUAGE: Record<string, string> = {
  bash: 'bash', c: 'c', cc: 'cpp', clj: 'clojure', cljc: 'clojure', cljs: 'clojure',
  coffee: 'coffeescript', cpp: 'cpp', cpt: 'c', cs: 'csharp', css: 'css', cts: 'typescript',
  cxx: 'cpp', dart: 'dart', diff: 'diff', dockerfile: 'dockerfile', ex: 'elixir', exs: 'elixir',
  fish: 'fish', go: 'go', graphql: 'graphql', gql: 'graphql', h: 'c', hpp: 'cpp', htm: 'html',
  html: 'html', hxx: 'cpp', java: 'java', jinja: 'jinja', jl: 'julia', js: 'javascript',
  json: 'json', jsonc: 'jsonc', jsx: 'jsx', kt: 'kotlin', kts: 'kotlin', lua: 'lua',
  make: 'makefile', md: 'markdown', mdx: 'mdx', mjs: 'javascript', mm: 'objective-c',
  mts: 'typescript', php: 'php', pl: 'perl', proto: 'proto', ps1: 'powershell', py: 'python',
  r: 'r', rb: 'ruby', rs: 'rust', sass: 'sass', scala: 'scala', scss: 'scss', sh: 'bash',
  sol: 'solidity', sql: 'sql', svelte: 'svelte', swift: 'swift', tf: 'hcl', tfvars: 'hcl',
  toml: 'toml', ts: 'typescript', tsx: 'tsx', vue: 'vue', xml: 'xml', yaml: 'yaml',
  yml: 'yaml', zsh: 'bash',
};

const LANGUAGE_ALIASES: Record<string, string> = {
  csharp: 'csharp', 'c#': 'csharp', 'c++': 'cpp', js: 'javascript', jsx: 'jsx',
  mjs: 'javascript', node: 'javascript', py: 'python', python3: 'python', sh: 'bash',
  shell: 'bash', shellscript: 'bash', ts: 'typescript', tsx: 'tsx', yml: 'yaml',
  text: 'text', plaintext: 'text', txt: 'text', html: 'html', xml: 'xml', md: 'markdown',
};

/** Resolve common source extensions; unknown files remain readable as unstyled text. */
export function codeLanguageFromPath(path: string): string {
  const extension = path.split(/[./\\]/).pop()?.toLowerCase() ?? '';
  return EXTENSION_LANGUAGE[extension] ?? 'text';
}

export function normalizeCodeLanguage(language: string | undefined): string {
  const value = (language ?? '').trim().toLowerCase();
  if (!value) return 'text';
  return LANGUAGE_ALIASES[value] ?? value;
}

const GENERIC_LANGUAGES = new Set(['', 'text', 'plaintext', 'txt', 'plain']);
const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_LANGUAGE).join('|');
const PATH_REFERENCE = new RegExp(
  `((?:[\\w@.-]+/)*[\\w@-]+\\.(?:${SUPPORTED_EXTENSIONS}))(?=$|[^\\w])`,
  'g',
);
const CODE_FENCE = /(^|\n)([ \t]*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\2\3[ \t]*(?=\n|$)/g;
const ANY_CODE_FENCE = /(`{3,}|~{3,})[\s\S]*?\1/g;

/**
 * Providers sometimes label source snippets `text` even when the same reply
 * names the file being edited. Infer only from a nearby path in prose; explicit
 * language labels and unrelated/plain text blocks retain their authored format.
 */
export function inferMarkdownCodeLanguages(markdown: string): string {
  // Keep offsets stable while preventing paths inside older code snippets from
  // influencing a later fence's language.
  const prose = markdown.replace(ANY_CODE_FENCE, block => block.replace(/[^\n]/g, ' '));
  return markdown.replace(CODE_FENCE, (whole, lineBreak: string, indent: string, fence: string, info: string, body: string, offset: number) => {
    const declared = info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    if (!GENERIC_LANGUAGES.has(declared)) return whole;

    let proseStart = Math.max(0, offset - 600);
    const previousFences = new RegExp(CODE_FENCE.source, 'g');
    for (const previous of markdown.slice(0, offset).matchAll(previousFences)) {
      const previousLanguage = previous[4].trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
      if (!GENERIC_LANGUAGES.has(previousLanguage)) proseStart = Math.max(proseStart, previous.index! + previous[0].length);
    }
    const preceding = prose.slice(proseStart, offset);
    const paths = [...preceding.matchAll(new RegExp(PATH_REFERENCE.source, 'g'))];
    const path = paths.at(-1)?.[1];
    const language = path ? codeLanguageFromPath(path) : 'text';
    if (language === 'text') return whole;
    return `${lineBreak}${indent}${fence}${language}\n${body}\n${indent}${fence}`;
  });
}
