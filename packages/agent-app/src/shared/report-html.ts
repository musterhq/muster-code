/* Portions adapted from T3 Code (https://github.com/pingdotgg/t3code, commit 13aa882), the themed page bootstrap. Copyright (c) 2026 T3 Tools Inc., MIT License; see THIRD-PARTY-NOTICES.md and licenses/t3code-MIT.txt. */
/** How a report's HTML is prepared for its sandboxed frame. Pure (no Node), shared by the main process and the screenshot harness. */
import {HTML_RENDER_FALLBACK, THEME_FRAGMENT_KEY} from './html-render.ts';

/**
 * Runs inside the report (allowed by its CSP's inline-script rule): reports how tall the document is so the inline preview can
 * size itself. It reads nothing but layout and sends one number to the parent, which verifies the sender. A document taller
 * than its viewport reports its scroll height (the frame grows to it); otherwise its own box, so a frame never feeds back into
 * a page that sizes itself to the viewport.
 */
export const REPORT_HEIGHT_SCRIPT = `<script>(()=>{let last=-1;const post=()=>{const r=document.documentElement;const h=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(h!==last){last=h;try{parent.postMessage({muster:'report-height',height:h},'*')}catch(e){}}};if(typeof ResizeObserver==='function'){const o=new ResizeObserver(post);o.observe(document.documentElement);addEventListener('DOMContentLoaded',()=>{if(document.body)o.observe(document.body)})}addEventListener('load',post);addEventListener('DOMContentLoaded',post);post()})()</script>`;

const BASE_CSS = 'html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;padding:12px 14px}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}:where(:focus-visible){outline:2px solid var(--ring);outline-offset:-2px}';
const FONTS = {'--font-sans': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif', '--font-mono': '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace', '--radius': '8px'};
const rule = (variables: Record<string, string>, scheme: string) => `:root{color-scheme:${scheme};${Object.entries({...FONTS, ...variables}).map(([name, value]) => `${name}:${value};`).join('')}}`;
/** Before the page's own styles: the stock palettes, so a downloaded page opened on its own still reads in either scheme. */
export const THEME_DEFAULT_CSS = `${rule(HTML_RENDER_FALLBACK.light, 'light')}@media (prefers-color-scheme: dark){${rule(HTML_RENDER_FALLBACK.dark, 'dark')}}${BASE_CSS}`;

/** JSON for a literal inside an inline <script>: `<`, `>` and the JS line separators are escaped, so no value can close the tag. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/[<>\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * The themed page's bootstrap (adapted from T3 Code's html render bootstrap, MIT; see html-render.ts). Runs first in <head>:
 * applies the theme from the URL fragment (first paint already themed), then drops the fragment so the page's own hash routing
 * never sees it; takes later theme changes only from its parent window; and turns a click on an http(s) link into a request to
 * the parent (which opens it only for a focused frame the person just used). It rewrites its own <style> element, so a page's
 * later :root rules still win.
 */
export const THEME_BOOTSTRAP_SCRIPT = `<script>(function(){var s=document.getElementById("muster-theme");if(!s)return;var b=${scriptJson(BASE_CSS)},f=${scriptJson(FONTS)};function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var v={},k,c;for(k in f)v[k]=f[k];for(k in t.variables)if(/^--[a-z0-9-]{1,40}$/.test(k))v[k]=String(t.variables[k]).replace(/[;{}<>\\\\]/g,"");c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(k in v)c+=k+":"+v[k]+";";s.textContent=c+"}"+b;}try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));try{history.replaceState(history.state,"",location.pathname+location.search)}catch(x){}}}catch(e){}addEventListener("message",function(e){var d=e.data;if(e.source===parent&&d&&d.muster==="report-theme")a(d.theme)});document.addEventListener("click",function(e){var l=e.isTrusted&&e.composedPath?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]")}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI)}catch(x){return}if(!/^https?:$/.test(u.protocol))return;if(u.href.split("#")[0]===location.href.split("#")[0])return;e.preventDefault();try{parent.postMessage({muster:"report-link",url:u.href,metaKey:e.metaKey,ctrlKey:e.ctrlKey},"*")}catch(x){}},true)})()</script>`;

export interface PrepareOptions {
  /** Inject Muster's theme variables, the base stylesheet and the theme/link bootstrap (needs scripts). */
  themed?: boolean;
  /** A page that must not run but should fit its frame (a notebook's saved HTML output): only the height reporter is injected, and the
   *  CSP allows that one script by its hash (reportCsp's `measure`), so none of the page's own scripts or handlers run. */
  measure?: boolean;
}

/** The height reporter's script text, as hashed for a measure-only page's CSP. */
export const REPORT_HEIGHT_SOURCE = REPORT_HEIGHT_SCRIPT.slice('<script>'.length, -'</script>'.length);

/** A fragment becomes a standards-mode document; the height reporter (and the theme bootstrap) go first so they run before the report's own scripts. */
export function prepareReportHtml(html: string, scripts: boolean, options: PrepareOptions = {}): string {
  const doctype = /^\s*<!doctype/i.test(html) ? '' : '<!doctype html>';
  // `<head>` and `<html>` with attributes, never `<header>` or `<html-foo>`.
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  const themed = scripts && options.themed === true;
  // The page is served as UTF-8 (header); a declaration inside keeps it right if the document is ever saved and reopened.
  const inject = (/<meta[^>]+charset/i.test(html) ? '' : '<meta charset="utf-8">')
    + (themed && !/<meta\s[^>]*name\s*=\s*["']?viewport/i.test(html) ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : '')
    + (themed ? `<style id="muster-theme">${THEME_DEFAULT_CSS}</style>${THEME_BOOTSTRAP_SCRIPT}` : '')
    + (scripts || options.measure === true ? REPORT_HEIGHT_SCRIPT : '');
  if (head) return doctype + html.slice(0, head.index + head[0].length) + inject + html.slice(head.index + head[0].length);
  const root = /<html(?:\s[^>]*)?>/i.exec(html);
  if (root) return doctype + html.slice(0, root.index + root[0].length) + `<head>${inject}</head>` + html.slice(root.index + root[0].length);
  const declared = /^\s*<!doctype[^>]*>/i.exec(html);
  if (declared) return declared[0] + inject + html.slice(declared[0].length);
  return `${doctype}${inject}${html}`;
}
