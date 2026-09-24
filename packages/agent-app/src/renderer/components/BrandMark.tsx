import React from 'react';

export interface BrandMarkProps {
  size?: number;
  className?: string;
}

/**
 * The Muster mark (muster/website/public/assets/brand/muster-mark.png) as an inline vector on the
 * logo's own 512 grid: four rounded-corner paths, each running straight in from one edge and turning
 * through a rounded bend away from the centre, framing a purple point where they converge.
 */
export function BrandMark({ size = 18, className }: BrandMarkProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" stroke="currentColor" strokeWidth={44}
      strokeLinecap="butt" className={className} aria-hidden="true" focusable="false">
      <path d="M204 0 V104 A100 100 0 0 1 104 204 H0" />
      <path d="M308 0 V104 A100 100 0 0 0 408 204 H512" />
      <path d="M204 512 V408 A100 100 0 0 0 104 308 H0" />
      <path d="M308 512 V408 A100 100 0 0 1 408 308 H512" />
      <circle cx="256" cy="256" r="50" stroke="none" fill="#5B4BFF" />
    </svg>
  );
}
