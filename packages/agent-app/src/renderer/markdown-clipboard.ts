/* Portions adapted from T3 Code (https://github.com/pingdotgg/t3code, commit fa4f3a2), apps/web/src/markdown-clipboard.ts. Copyright (c) 2026 T3 Tools Inc., MIT License; see THIRD-PARTY-NOTICES.md and licenses/t3code-MIT.txt. */
/**
 * Copying from a rendered reply (#785). A formula is KaTeX glyphs on screen and a diagram is an SVG, so the browser's own copy
 * would give garbled symbols or nothing. Elements that stand for source carry it in `data-markdown-copy` (MarkdownMath, and
 * the wrapper MessageBody puts round a drawn fence); a selection that touches one is turned back into the Markdown it came
 * from, with those elements as their source. Any other selection is left to the browser.
 */

const SKIPPED_TAGS = new Set(['BUTTON', 'INPUT', 'SCRIPT', 'STYLE', 'TEMPLATE']);
// App chrome inside a reply: a code block's language label and actions, a table's toolbar, the Quote offer.
const SKIPPED_CLASS_NAMES = ['select-none', 'sr-only', 'md-code-head', 'md-table-toolbar', 'md-quote', 'md-quote-note'];
const SANITIZED_HTML_SELECTOR = ['button', 'input', 'script', 'style', 'svg', '[aria-hidden="true"]', ...SKIPPED_CLASS_NAMES.map(name => `.${name}`)].join(', ');
const SOURCE_SELECTOR = '[data-markdown-copy]';
// The wrapper MarkdownMath puts on every formula it renders, and MessageBody's on every drawn fence.
const MATH_SELECTOR = '[data-markdown-math]';
const RICH_SELECTOR = '[data-markdown-rich]';

export interface MarkdownClipboardPayload { text: string; html: string }

function isSkippedElement(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName) || element.localName === 'svg') return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  return SKIPPED_CLASS_NAMES.some(name => element.classList.contains(name));
}

function wrapInlineMarker(content: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
  const core = match?.[2] ?? '';
  if (!core) return content;
  return `${match?.[1] ?? ''}${marker}${core}${marker}${match?.[3] ?? ''}`;
}

// Highlighter spans or newlines identify block code even when its pre wrapper was not copied.
function isBlockCodeElement(element: Element, content: string): boolean {
  if (content.includes('\n')) return true;
  for (const child of element.childNodes) if (child.nodeType === Node.ELEMENT_NODE && (child as Element).classList.contains('line')) return true;
  return false;
}

function wrapInlineCode(code: string): string {
  const longestRun = [...(code.match(/`+/g) ?? [])].reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(1, longestRun + (longestRun > 0 ? 1 : 0)));
  const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${code}${pad}${fence}`;
}

function codeFenceFor(code: string): string {
  const longestRun = [...(code.match(/`{3,}/g) ?? [])].reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function resolveCodeBlockLanguage(pre: Element): string | null {
  const declared = pre.closest('[data-language]')?.getAttribute('data-language') ?? /(?:^|\s)language-(\S+)/.exec(pre.querySelector('code')?.className ?? '')?.[1] ?? null;
  return declared && declared !== 'text' ? declared : null;
}

/** A fenced block as Markdown, with a fence longer than any backtick run inside it. */
export function serializeCodeBlockToMarkdown(source: string, language: string | null | undefined): string {
  const code = source.replace(/\n$/, '');
  const fence = codeFenceFor(code);
  return `${fence}${language ?? ''}\n${code}\n${fence}\n\n`;
}

function serializeCodeBlock(pre: Element): string {
  return serializeCodeBlockToMarkdown(pre.textContent ?? '', resolveCodeBlockLanguage(pre));
}

function serializeTableCell(cell: Element): string {
  return serializeChildren(cell).replace(/\n+/g, ' ').trim().replaceAll('|', '\\|');
}

function tableSeparatorFor(headerCells: Element[]): string {
  return `| ${headerCells.map(cell => {
    const align = (cell as HTMLElement).style?.textAlign || cell.getAttribute('align') || '';
    return align === 'center' ? ':---:' : align === 'right' ? '---:' : '---';
  }).join(' | ')} |`;
}

function serializeTable(table: Element): string {
  const rows = [...table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr')];
  if (!rows.length) return '';
  const lines: string[] = [];
  let emittedSeparator = false;
  for (const row of rows) {
    const cells = [...row.children].filter(cell => cell.tagName === 'TH' || cell.tagName === 'TD');
    if (!cells.length) continue;
    lines.push(`| ${cells.map(serializeTableCell).join(' | ')} |`);
    if (!emittedSeparator) { lines.push(tableSeparatorFor(cells)); emittedSeparator = true; }
  }
  return `${lines.join('\n')}\n\n`;
}

function serializeListItem(item: Element, ordered: boolean, index: number): string {
  const checkbox = item.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
  const task = checkbox ? `[${(checkbox as HTMLInputElement).checked ? 'x' : ' '}] ` : '';
  const bullet = ordered ? `${index}. ` : '- ';
  let content = serializeChildren(item).replace(/\n{3,}/g, '\n\n').trim();
  if (!item.querySelector(':scope > p')) content = content.replace(/\n{2,}/g, '\n');
  // Continuations align after the bullet; task boxes belong to the item text.
  const indent = ' '.repeat(bullet.length);
  const [first = '', ...rest] = content.split('\n');
  return [`${bullet}${task}${first}`, ...rest.map(line => (line.length > 0 ? `${indent}${line}` : line))].join('\n');
}

function serializeList(list: Element, ordered: boolean): string {
  const start = Number.parseInt(list.getAttribute('start') ?? '1', 10) || 1;
  const items = [...list.children].filter(child => child.tagName === 'LI');
  if (!items.length) return '';
  return `${items.map((item, index) => serializeListItem(item, ordered, start + index)).join('\n')}\n\n`;
}

function serializeBlockquote(quote: Element): string {
  const content = serializeChildren(quote).replace(/\n{3,}/g, '\n\n').trim();
  if (!content) return '';
  return `${content.split('\n').map(line => (line.length > 0 ? `> ${line}` : '>')).join('\n')}\n\n`;
}

function serializeAnchor(anchor: Element): string {
  const content = serializeChildren(anchor);
  const href = anchor.getAttribute('href') ?? '';
  if (!/^https?:\/\//i.test(href)) return content;
  const label = content.trim();
  if (!label) return '';
  if (label === href) return href;
  return `[${label}](${href})`;
}

function serializeChildren(node: Node): string {
  let out = '';
  for (const child of node.childNodes) out += serializeNode(child);
  return out;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    if (text.includes('\n') && text.trim().length === 0) return '\n';
    return text;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as Element;
  const markdownCopy = element.getAttribute('data-markdown-copy');
  if (markdownCopy !== null) return markdownCopy;
  if (isSkippedElement(element)) return '';
  const headingLevel = /^H([1-6])$/.exec(element.tagName)?.[1];
  if (headingLevel) return `${'#'.repeat(Number(headingLevel))} ${serializeChildren(element).trim()}\n\n`;
  switch (element.tagName) {
    case 'BR': return '\n';
    case 'HR': return '---\n\n';
    case 'P': return `${serializeChildren(element).trim()}\n\n`;
    case 'PRE': return serializeCodeBlock(element);
    case 'CODE': {
      const content = element.textContent ?? '';
      return isBlockCodeElement(element, content) ? content : wrapInlineCode(content);
    }
    case 'STRONG': case 'B': return wrapInlineMarker(serializeChildren(element), '**');
    case 'EM': case 'I': return wrapInlineMarker(serializeChildren(element), '*');
    case 'DEL': case 'S': return wrapInlineMarker(serializeChildren(element), '~~');
    case 'A': return serializeAnchor(element);
    case 'IMG': {
      const alt = element.getAttribute('alt') ?? '', src = element.getAttribute('src') ?? '';
      return alt && src ? `![${alt}](${src})` : '';
    }
    case 'UL': return serializeList(element, false);
    case 'OL': return serializeList(element, true);
    case 'BLOCKQUOTE': return serializeBlockquote(element);
    case 'TABLE': return serializeTable(element);
    case 'DIV': case 'SECTION': case 'ARTICLE': {
      const content = serializeChildren(element);
      return content && !content.endsWith('\n') ? `${content}\n` : content;
    }
    default: return serializeChildren(element);
  }
}

function tidyMarkdown(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/[ \t]+(?=\n)/g, '').replace(/\n{3,}/g, '\n\n')))
    .join('')
    .trim();
}

/** A copied fragment of a rendered reply, back as Markdown. */
export function serializeRenderedMarkdownFragment(container: Node): string {
  return tidyMarkdown(serializeChildren(container));
}

export function mathWrapperOf(element: Element | null): Element | null {
  return element?.closest(MATH_SELECTOR) ?? null;
}

/** A table cell's text with each formula as its TeX (the table's Copy as Markdown / CSV). */
export function cellSourceText(cell: Element): string {
  if (!cell.querySelector(MATH_SELECTOR)) return cell.textContent ?? '';
  const copy = cell.cloneNode(true) as Element;
  for (const wrapper of copy.querySelectorAll(MATH_SELECTOR)) wrapper.replaceWith(wrapper.getAttribute('data-markdown-copy')?.trim() ?? '');
  return copy.textContent ?? '';
}

function sourceHtml(source: string, block: boolean): Element {
  const code = document.createElement('code');
  code.textContent = source.trim();
  if (!block) return code;
  const pre = document.createElement('pre');
  pre.append(code);
  return pre;
}

function sanitizedHtmlFrom(container: Element): string {
  for (const rich of container.querySelectorAll(RICH_SELECTOR)) rich.replaceWith(sourceHtml(rich.getAttribute('data-markdown-copy') ?? '', true));
  for (const wrapper of container.querySelectorAll(MATH_SELECTOR)) wrapper.replaceWith(sourceHtml(wrapper.getAttribute('data-markdown-copy') ?? '', wrapper.getAttribute('data-markdown-math') === 'display'));
  for (const node of container.querySelectorAll(SANITIZED_HTML_SELECTOR)) node.remove();
  return `<meta charset="utf-8">${container.innerHTML}`;
}

const elementOf = (node: Node | null): Element | null => (!node ? null : node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement);

/**
 * What to put on the clipboard for a selection in a reply, or null to leave the copy to the browser (nothing selected, or
 * nothing in it that stands for source).
 */
export function markdownClipboardPayload(selection: Selection | null): MarkdownClipboardPayload | null {
  if (!selection || selection.isCollapsed) return null;
  const texts: string[] = [], htmls: string[] = [];
  let touchesSource = false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (range.collapsed) continue;
    const ancestor = elementOf(range.commonAncestorContainer);
    // Inside a drawn fence: its source, whatever part of the drawing was selected.
    const rich = ancestor?.closest(RICH_SELECTOR)?.getAttribute('data-markdown-copy');
    if (rich != null) {
      touchesSource = true;
      const text = rich.trim();
      if (!text) continue;
      texts.push(text);
      htmls.push(`<meta charset="utf-8">${sourceHtml(text, true).outerHTML}`);
      continue;
    }
    // A range inside a formula clones only KaTeX's glyphs, not the wrapper holding the TeX.
    const math = mathWrapperOf(ancestor);
    if (math) {
      touchesSource = true;
      const text = math.getAttribute('data-markdown-copy')?.trim() ?? '';
      texts.push(text);
      htmls.push(`<meta charset="utf-8">${sourceHtml(text, math.getAttribute('data-markdown-math') === 'display').outerHTML}`);
      continue;
    }
    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    if (container.querySelector(SOURCE_SELECTOR)) touchesSource = true;
    if (ancestor?.closest('pre')) {
      const text = range.toString();
      if (text) { texts.push(text); htmls.push(sanitizedHtmlFrom(container)); }
      continue;
    }
    const text = serializeRenderedMarkdownFragment(container);
    if (!text) continue;
    texts.push(text);
    htmls.push(sanitizedHtmlFrom(container));
  }
  if (!touchesSource || !texts.length) return null;
  return {text: texts.join('\n\n'), html: htmls.join('')};
}
