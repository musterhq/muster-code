/**
 * EXT-10: the only messages a sandboxed plugin UI frame may send to Muster, and what Muster sends back.
 * Everything else is ignored. The host checks `event.source` is the plugin's own frame before calling this.
 */
export type PluginUiRequest =
  | { type: 'muster:ready' }
  | { type: 'muster:resize'; height: number }
  | { type: 'muster:notify'; message: string }
  | { type: 'muster:openLink'; url: string }
  | { type: 'muster:insertPrompt'; text: string };
export type PluginUiHostMessage = { type: 'muster:context'; theme: 'dark' | 'light'; plugin: string; app: string; chatTitle?: string };
export const PLUGIN_UI_MIN_HEIGHT = 120, PLUGIN_UI_MAX_HEIGHT = 4000;
export const MAX_PLUGIN_NOTICE = 300, MAX_PLUGIN_PROMPT = 4000;

/** Returns the validated request, or null for anything outside the allowlist. */
export function pluginUiRequest(data: unknown): PluginUiRequest | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  switch (message.type) {
    case 'muster:ready': return { type: 'muster:ready' };
    case 'muster:resize': {
      const height = message.height;
      if (typeof height !== 'number' || !Number.isFinite(height)) return null;
      return { type: 'muster:resize', height: Math.round(Math.min(PLUGIN_UI_MAX_HEIGHT, Math.max(PLUGIN_UI_MIN_HEIGHT, height))) };
    }
    case 'muster:notify': {
      if (typeof message.message !== 'string') return null;
      const text = message.message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_PLUGIN_NOTICE);
      return text ? { type: 'muster:notify', message: text } : null;
    }
    case 'muster:openLink': {
      if (typeof message.url !== 'string' || message.url.length > 2048) return null;
      try {
        const url = new URL(message.url);
        if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
        return { type: 'muster:openLink', url: url.href };
      } catch { return null; }
    }
    case 'muster:insertPrompt': {
      if (typeof message.text !== 'string') return null;
      const text = message.text.replace(/\u0000/g, '').slice(0, MAX_PLUGIN_PROMPT);
      return text.trim() ? { type: 'muster:insertPrompt', text } : null;
    }
    default: return null;
  }
}

/** Per-frame rate limit for requests that surface UI (notices, links, prompt inserts). */
export function pluginUiLimiter(windowMs = 2000, now: () => number = Date.now): (kind: string) => boolean {
  const last = new Map<string, number>();
  return kind => {
    if (kind === 'muster:ready' || kind === 'muster:resize') return true;
    const at = now(), previous = last.get(kind);
    if (previous !== undefined && at - previous < windowMs) return false;
    last.set(kind, at);
    return true;
  };
}
