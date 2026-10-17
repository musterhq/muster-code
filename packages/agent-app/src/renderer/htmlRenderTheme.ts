/**
 * #html-preview: the active Muster theme as the CSS variables an agent page reads (shared/html-render.ts). Read from the live
 * tokens through richTheme.ts, so Light, Dark, System, the built-in and imported colour themes all reach the page, and a theme
 * change reaches an open page through one message (no reload).
 */
import {useMemo} from 'react';
import type {HtmlRenderTheme} from '../shared/html-render';
import {readRichTheme, token, useRichThemeSignature} from './richTheme';

export function readHtmlRenderTheme(): HtmlRenderTheme {
  const theme = readRichTheme();
  const [c1, c2, c3, c4, c5, c6] = theme.palette;
  return {
    appearance: theme.dark ? 'dark' : 'light',
    variables: {
      // The page sits on the card's own surface, so it reads as part of the reply.
      '--background': theme.surface, '--foreground': theme.text, '--muted': theme.fill, '--muted-foreground': theme.textDim,
      '--card': theme.bg, '--card-foreground': theme.text, '--border': theme.line, '--ring': token('focus-ring', theme.accent),
      '--accent': theme.accent, '--accent-foreground': theme.onPalette[0] ?? theme.bg,
      '--success': token('ok', theme.accent), '--warning': token('warn', theme.accent), '--destructive': theme.danger, '--info': token('info', theme.accent),
      '--chart-1': c1 ?? theme.accent, '--chart-2': c2 ?? theme.accent, '--chart-3': c3 ?? theme.accent, '--chart-4': c4 ?? theme.accent, '--chart-5': c5 ?? theme.accent, '--chart-6': c6 ?? theme.accent,
      '--font-sans': theme.font, '--font-mono': theme.mono, '--radius': '8px',
    },
  };
}

/** Re-read only when the theme actually changes (richThemeSignature), never per render. */
export function useHtmlRenderTheme(): HtmlRenderTheme {
  const signature = useRichThemeSignature();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readHtmlRenderTheme(), [signature]);
}
