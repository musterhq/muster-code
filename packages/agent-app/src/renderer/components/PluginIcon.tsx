import React from 'react';
import type { ItemIcon } from '../../shared/protocol';
import { monogram } from '../../shared/item-icon';
import './plugin-icon.css';

/**
 * 16px manifest icon (plugin/skill) or deterministic monogram. Images render only
 * through <img>, so a manifest SVG can never run script or fetch.
 */
/** Monogram letter size: 8.5px at the 16px default, scaled with the icon so a 28px avatar isn't a speck. */
export function monogramFontSize(size: number): number {
  return Math.max(6, Math.round(size * 0.53 * 10) / 10);
}

export function PluginIcon({ icon, name, seed = name, brandColor, shape = 'square', size = 16, className }: { icon?: ItemIcon; name: string; seed?: string; brandColor?: string; shape?: 'square' | 'skill' | 'round'; size?: number; className?: string }): React.ReactElement {
  // A logo the browser cannot draw (a truncated or undecodable file) drops out: a pair keeps the variant that still draws, else the monogram.
  const [broken, setBroken] = React.useState<ReadonlySet<string>>(() => new Set());
  const drawable = icon?.kind === 'image' ? [icon.dataUrl, icon.darkDataUrl].filter((src): src is string => !!src && !broken.has(src)) : [];
  const value = icon && (icon.kind !== 'image' || drawable.length) ? icon : monogram(name, seed, brandColor);
  const extra = className ? ` ${className}` : '';
  if (value.kind === 'image') {
    const tone = `${value.monochrome ? ' is-monochrome' : ''}${value.monochromeLight ? ' is-monochrome-light' : ''}`;
    const onError = (src: string) => () => setBroken(previous => new Set(previous).add(src));
    const image = (src: string, className: string) => <img key={src} className={`item-icon is-${shape}${className}${extra}`} src={src} alt="" aria-hidden="true" draggable={false} width={size} height={size} style={{ width: size, height: size }} onError={onError(src)} />;
    // CS-C3-2: a manifest dark logo is its own <img>; CSS shows exactly one of the pair for the current theme.
    if (drawable.length === 2) return <>{image(value.dataUrl, `${tone} is-theme-light`)}{image(value.darkDataUrl!, ' is-theme-dark')}</>;
    if (drawable[0] === value.dataUrl) return image(drawable[0], tone);
    // Only the dark logo still draws: it may be a white mark, so the light theme gets the monogram instead.
    return <>{image(drawable[0], ' is-theme-dark')}{monogramTile(monogram(name, seed, brandColor) as { text: string; hue: number }, ' is-theme-light')}</>;
  }
  return monogramTile(value, '');
  function monogramTile(tile: { text: string; hue: number }, theme: string): React.ReactElement {
    return <span key="monogram" className={`item-icon item-monogram is-${shape}${theme}${extra}`} aria-hidden="true" style={{ '--h': tile.hue, width: size, height: size, fontSize: monogramFontSize(size) } as React.CSSProperties}>{tile.text}</span>;
  }
}
