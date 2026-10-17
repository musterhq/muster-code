/** How a report's HTML is prepared for its sandboxed frame. Pure (no Node), shared by the main process and the screenshot harness. */

/**
 * Runs inside the report (allowed by its CSP's inline-script rule): reports how tall the document is so the inline preview can
 * size itself. It reads nothing but layout and sends one number to the parent, which verifies the sender.
 */
export const REPORT_HEIGHT_SCRIPT = `<script>(()=>{let last=-1;const post=()=>{const h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(h!==last){last=h;try{parent.postMessage({muster:'report-height',height:h},'*')}catch(e){}}};if(typeof ResizeObserver==='function')new ResizeObserver(post).observe(document.documentElement);addEventListener('load',post);addEventListener('DOMContentLoaded',post);post()})()</script>`;

/** A fragment becomes a standards-mode document; the height reporter goes first so it runs before the report's own scripts. */
export function prepareReportHtml(html: string, scripts: boolean): string {
  const doctype = /^\s*<!doctype/i.test(html) ? '' : '<!doctype html>';
  const head = /<head[^>]*>/i.exec(html);
  // The page is served as UTF-8 (header); a declaration inside keeps it right if the document is ever saved and reopened.
  const inject = (/<meta[^>]+charset/i.test(html) ? '' : '<meta charset="utf-8">') + (scripts ? REPORT_HEIGHT_SCRIPT : '');
  if (head) return doctype + html.slice(0, head.index + head[0].length) + inject + html.slice(head.index + head[0].length);
  const root = /<html[^>]*>/i.exec(html);
  if (root) return doctype + html.slice(0, root.index + root[0].length) + `<head>${inject}</head>` + html.slice(root.index + root[0].length);
  const declared = /^\s*<!doctype[^>]*>/i.exec(html);
  if (declared) return declared[0] + inject + html.slice(declared[0].length);
  return `${doctype}${inject}${html}`;
}
