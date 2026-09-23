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
  const value = icon ?? monogram(name, seed, brandColor);
  const extra = className ? ` ${className}` : '';
  if (value.kind === 'image') {
    const tone = `${value.monochrome ? ' is-monochrome' : ''}${value.monochromeLight ? ' is-monochrome-light' : ''}`;
    const image = (src: string, className: string) => <img className={`item-icon is-${shape}${className}${extra}`} src={src} alt="" aria-hidden="true" draggable={false} width={size} height={size} style={{ width: size, height: size }} />;
    // CS-C3-2: a manifest dark logo is its own <img>; CSS shows exactly one of the pair for the current theme.
    if (value.darkDataUrl) return <>{image(value.dataUrl, `${tone} is-theme-light`)}{image(value.darkDataUrl, ' is-theme-dark')}</>;
    return image(value.dataUrl, tone);
  }
  return <span className={`item-icon item-monogram is-${shape}${extra}`} aria-hidden="true" style={{ '--h': value.hue, width: size, height: size, fontSize: monogramFontSize(size) } as React.CSSProperties}>{value.text}</span>;
}
