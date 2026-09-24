import React from 'react';
import {Tooltip} from '@base-ui/react/tooltip';
import './tooltip.css';

/**
 * UX-07: the one tooltip in the app. Icon buttons carry a styled tip with the action name, its shortcut
 * as keycaps, and, when disabled, why. Replaces native `title=` on the controls that use it (keep
 * `aria-label` on the trigger: the tip is supplementary, never the accessible name).
 *
 * Disabled buttons receive no pointer events, so a trigger that can carry a disabled reason is wrapped in
 * a non-focusable span that owns the hover instead.
 */
export interface TipProps {
  label: React.ReactNode;
  /** Display keycaps, e.g. '⌘B' or ['⌘', '['] — shown after the label. */
  shortcut?: string | readonly string[];
  /** Shown instead of the shortcut while the trigger is disabled. */
  disabledReason?: string | null;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactElement;
}

export function TipProvider({children}: {children: React.ReactNode}): React.ReactElement {
  // A short grouped delay: once one tip is showing, neighbours open instantly while you scan a toolbar.
  return <Tooltip.Provider delay={450} closeDelay={0} timeout={500}>{children}</Tooltip.Provider>;
}

function keycaps(shortcut: TipProps['shortcut']): string[] {
  if (!shortcut) return [];
  if (Array.isArray(shortcut)) return [...shortcut];
  return [shortcut as string];
}

export function Tip({label, shortcut, disabledReason, side = 'bottom', children}: TipProps): React.ReactElement {
  const disabled = Boolean((children.props as {disabled?: boolean}).disabled);
  const reason = disabled ? disabledReason ?? null : null;
  const keys = reason ? [] : keycaps(shortcut);
  // Wrap whenever a reason may apply, so toggling `disabled` never remounts (and never drops focus from) the button.
  const trigger = disabledReason ? <span className="tip-anchor">{children}</span> : children;
  return <Tooltip.Root>
    {/* data-tip mirrors a plain-text label on the trigger, so tests and audits can see which controls carry a tip. */}
    <Tooltip.Trigger render={trigger} data-tip={typeof label === 'string' ? label : undefined}/>
    <Tooltip.Portal>
      <Tooltip.Positioner side={side} sideOffset={6} collisionPadding={8} className="tip-positioner">
        <Tooltip.Popup className="tip">
          <span className="tip-label">{label}</span>
          {keys.length>0&&<span className="tip-keys" aria-hidden="true">{keys.map(key=><kbd key={key}>{key}</kbd>)}</span>}
          {reason&&<span className="tip-reason">{reason}</span>}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>;
}
