/* Portions adapted from T3 Code (https://github.com/pingdotgg/t3code, commit fa4f3a2), apps/web/src/components/files/MermaidViewer.tsx. Copyright (c) 2026 T3 Tools Inc., MIT License; see THIRD-PARTY-NOTICES.md and licenses/t3code-MIT.txt. */
/**
 * What a standalone Mermaid file (.mmd, .mermaid) may hold before it is drawn. Mermaid lays out its DOM before its SVG is
 * sanitized, so anything that could make it fetch, run or reconfigure itself is refused by reading the text first: URLs and
 * url(), @import, raw HTML or markup declarations, %%{ }%% configuration, node metadata (@{ }) and img:/image: keys. Front
 * matter may carry only a title (config in front matter is the same as a %%{ }%% block, and YAML cannot be checked lexically).
 * Pure: shared by the file preview and its tests.
 */

const FRONT_MATTER = /^\uFEFF?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/%%\s*\{/, 'a %%{ }%% configuration block'],
  [/<\/?[A-Za-z]|<[!?]/, 'raw HTML'],
  [/@\s*\{/, 'node metadata (@{ })'],
  [/\b(?:img|image)\s*:/i, 'an img: or image: key'],
  [/url\s*\(|@import/i, 'a stylesheet resource (url() or @import)'],
  [/\b(?:https?|data|blob|file|ftp|javascript):/i, 'a URL'],
  [/\/\/[a-z0-9.-]+\.[a-z]{2,}/i, 'a URL'],
];

/** Why this file is not drawn (one plain phrase), or undefined when it is safe to hand to Mermaid. */
export function mermaidFileProblem(text: string): string | undefined {
  const front = FRONT_MATTER.exec(text);
  if (front) {
    const lines = front[1]!.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
    if (lines.some(line => !/^title:\s*\S/.test(line))) return 'front matter other than a title';
  } else if (/^\uFEFF?\s*---/.test(text)) return 'front matter other than a title';
  // The whole text, front matter included: a title holding a URL is refused too.
  // Class annotations (<<interface>>) and line breaks in labels (<br>) are Mermaid syntax, not markup.
  const checked = text.replace(/<<[\w\s-]{1,40}>>/g, '').replace(/<br\s*\/?>/gi, '');
  for (const [pattern, reason] of RULES) if (pattern.test(checked)) return reason;
  return undefined;
}

/** The sentence the preview shows for a refused file. */
export const mermaidFileRefusal = (reason: string) => `This diagram contains ${reason}, so Muster does not draw it. Its source is shown below.`;
