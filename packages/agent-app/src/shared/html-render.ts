/**
 * Agent pages shown inline in the transcript (`render_html`) and the theme they are drawn in. Pure: shared by main (the
 * tool, the served document), the renderer (the card, the frame) and the tests.
 *
 * Portions adapted from T3 Code (https://github.com/pingdotgg/t3code), packages/shared/src/htmlRender.ts at commit
 * 13aa882c22d584de5388dfce3b3ca413387ba059: the theme-variable contract (names that follow the app's tokens, live updates
 * through a parent message, a fragment for the first paint), the page layout and theme guidance given to the agent, the
 * file-name rules and the strict readers of frame messages. Copyright (c) 2026 T3 Tools Inc., MIT License; see
 * THIRD-PARTY-NOTICES.md and licenses/t3code-MIT.txt.
 */

export const HTML_RENDER_TOOL = 'render_html';
export const PREVIEW_OPEN_TOOL = 'preview_open';
export const PREVIEW_CLOSE_TOOL = 'preview_close';
/** One page, inline CSS and JS. Bigger dashboards belong in a file opened with preview_open. */
export const HTML_RENDER_MAX_BYTES = 512_000;
export const HTML_RENDER_MAX_TITLE = 160;
/** How the tool result names the stored page, so the transcript card finds it again after a restart. */
export const HTML_RENDER_REF = /\bmuster-html:([a-f0-9]{32})\b/;
export const htmlRenderRef = (id: string) => `muster-html:${id}`;

export interface HtmlRenderRecord {
  id: string;
  chatId: string;
  title: string;
  html: string;
  /** The agent asked for network access (remote scripts, images, fonts, fetch over https). */
  networkRequested: boolean;
  /** Granted: by the person on the card, or up front in a Full access chat. Never by the page itself. */
  networkAllowed: boolean;
  createdAt: string;
}
/** What the renderer gets: everything but the chat binding. */
export type HtmlRenderView = Omit<HtmlRenderRecord, 'chatId'>;

/** A page title made safe for a header and a file name. */
export function htmlRenderTitle(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return text.slice(0, HTML_RENDER_MAX_TITLE) || 'Page';
}

/** A render_html tool row on any route: Codex/OpenCode/HTTP (`tool: render_html` on muster_browser) or a raw Claude name. */
export function isHtmlRenderTool(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  const server = [data.server, data.serverName, data.namespace].find(value => typeof value === 'string') as string | undefined;
  const tool = [data.tool, data.toolName, data.name].find(value => typeof value === 'string') as string | undefined;
  if (!tool) return false;
  if (tool === 'mcp__muster_browser__render_html' || tool === 'muster_browser_render_html') return true;
  return tool === HTML_RENDER_TOOL && (!server || /^muster[_-]browser$/i.test(server));
}
/** The stored page a render_html tool row points at: its id from the result text, never from model arguments alone. */
export function htmlRenderIdOf(data: Record<string, unknown> | undefined): string | undefined {
  const result = data?.result;
  const text = typeof result === 'string' ? result : (() => { try { return JSON.stringify(result ?? ''); } catch { return ''; } })();
  return HTML_RENDER_REF.exec(text)?.[1] ?? (typeof data?.output === 'string' ? HTML_RENDER_REF.exec(data.output)?.[1] : undefined);
}

// ---- theme ----------------------------------------------------------------------------------------------------------

export type HtmlRenderAppearance = 'light' | 'dark';
export interface HtmlRenderTheme { appearance: HtmlRenderAppearance; variables: Record<string, string> }

/** The variables a page can read. Names follow common design-token names so agent-written CSS needs no Muster knowledge. */
export const HTML_RENDER_VARIABLES = [
  '--background', '--foreground', '--muted', '--muted-foreground', '--card', '--card-foreground', '--border', '--ring',
  '--accent', '--accent-foreground', '--success', '--warning', '--destructive', '--info',
  '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--radius', '--font-sans', '--font-mono',
] as const;

const VARIABLE_NAME = /^--[a-z0-9-]{1,40}$/;
/** Only known-safe custom properties and values that cannot close a rule or a tag. */
export function sanitizeHtmlRenderTheme(input: unknown): HtmlRenderTheme | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const {appearance, variables} = input as {appearance?: unknown; variables?: unknown};
  if (!variables || typeof variables !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(variables as Record<string, unknown>).slice(0, 64)) {
    if (VARIABLE_NAME.test(name) && typeof value === 'string') out[name] = value.replace(/[;{}<>\\]/g, '').slice(0, 300);
  }
  return {appearance: appearance === 'light' ? 'light' : 'dark', variables: out};
}

/** Fallbacks for a page opened outside the app (a download): the stock Light and Dark palettes. */
export const HTML_RENDER_FALLBACK: Readonly<Record<HtmlRenderAppearance, Record<string, string>>> = {
  light: {'--background': '#ffffff', '--foreground': '#1f2328', '--muted': '#f2f3f5', '--muted-foreground': '#626a73', '--card': '#f7f8fa', '--card-foreground': '#1f2328', '--border': '#dfe2e6', '--ring': '#3b82f6',
    '--accent': '#2563eb', '--accent-foreground': '#ffffff', '--success': '#15803d', '--warning': '#b45309', '--destructive': '#dc2626', '--info': '#2563eb',
    '--chart-1': '#2563eb', '--chart-2': '#0d9488', '--chart-3': '#d97706', '--chart-4': '#9333ea', '--chart-5': '#e11d48', '--chart-6': '#65a30d'},
  dark: {'--background': '#1b1c1f', '--foreground': '#e6e7ea', '--muted': '#26282c', '--muted-foreground': '#9aa0a8', '--card': '#222327', '--card-foreground': '#e6e7ea', '--border': '#33363b', '--ring': '#60a5fa',
    '--accent': '#60a5fa', '--accent-foreground': '#0b1220', '--success': '#34d399', '--warning': '#fbbf24', '--destructive': '#f87171', '--info': '#60a5fa',
    '--chart-1': '#60a5fa', '--chart-2': '#2dd4bf', '--chart-3': '#fbbf24', '--chart-4': '#c084fc', '--chart-5': '#fb7185', '--chart-6': '#a3e635'},
};

export const THEME_FRAGMENT_KEY = 'muster-theme';
export const htmlRenderThemeFragment = (theme: HtmlRenderTheme) => `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
/** Parent to page: the theme changed. The page accepts it only from its parent window. */
export const htmlRenderThemeMessage = (theme: HtmlRenderTheme) => ({muster: 'report-theme', theme}) as const;

// ---- frame messages (page to parent) --------------------------------------------------------------------------------

/** The page's content height, clamped. Anything else is ignored. */
export function readReportHeight(data: unknown): number | undefined {
  const value = data as {muster?: unknown; height?: unknown} | null;
  if (!value || value.muster !== 'report-height' || typeof value.height !== 'number' || !Number.isFinite(value.height) || value.height < 0) return undefined;
  return Math.min(100_000, Math.ceil(value.height));
}
/** A link the reader clicked: http(s) only (never file:, javascript:, data: or a custom scheme), bounded. */
export function readReportLink(data: unknown): {url: string; external: boolean} | undefined {
  const value = data as {muster?: unknown; url?: unknown; metaKey?: unknown; ctrlKey?: unknown} | null;
  if (!value || value.muster !== 'report-link' || typeof value.url !== 'string' || value.url.length > 4096) return undefined;
  let url: URL;
  try { url = new URL(value.url); } catch { return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  return {url: url.href, external: value.metaKey === true || value.ctrlKey === true};
}

// ---- agent guidance -------------------------------------------------------------------------------------------------

export const HTML_RENDER_THEME_GUIDE = 'The page gets Muster\'s live theme as CSS custom properties on :root that follow the user\'s light/dark and colour theme: --background (the card surface), --foreground, --muted, --muted-foreground, --card, --card-foreground, --border, --ring, --accent, --accent-foreground, --success, --warning, --destructive, --info, --chart-1 to --chart-6 (categorical series colours: use these for charts so they read in both themes), --radius, --font-sans, --font-mono. A base stylesheet already sets html background, text colour and font from them; never hard-code a white or black page.';
export const HTML_RENDER_LAYOUT_GUIDE = 'Use a fluid width (the card is about 720px wide, less on narrow windows), no outer card, border, banner title or page padding (the card has a header and pads the page), fixed pixel heights for charts, and no 100vh heights: the frame grows to fit the page.';
export const HTML_RENDER_NETWORK_GUIDE = 'The page has no network by default: inline everything (CSS, JS, data: URLs). Only if it truly needs a CDN library, remote images or fetch over https, pass network: true; the user is asked once on the card (Full access chats allow it automatically). Plain http, file: and other schemes never load.';
