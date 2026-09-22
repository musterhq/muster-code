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
