import React from 'react';
import {Menu} from '@base-ui/react/menu';

/**
 * UX-08 / UX-21: the one menu primitive. Every dropdown, toolbar popover and overflow menu is a Base UI Menu
 * (roving focus, typeahead, Escape/outside-click close, focus returned to the trigger, nested-submenu grace)
 * rendered through this popup so they share one geometry: 4px offset, 8px collision padding, the `.ui-menu`
 * surface and item metrics in styles.css. Native OS menus remain only for right-click context menus.
 */
export {Menu};

export interface MenuPopupProps extends Omit<React.ComponentProps<typeof Menu.Popup>, 'className'> {
  className?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  positionerClassName?: string;
}

export function MenuPopup({className, side = 'bottom', align = 'start', sideOffset = 4, positionerClassName, children, ...popup}: MenuPopupProps): React.ReactElement {
  return <Menu.Portal>
    <Menu.Positioner side={side} align={align} sideOffset={sideOffset} collisionPadding={8} className={`ui-menu-positioner${positionerClassName ? ` ${positionerClassName}` : ''}`}>
      <Menu.Popup {...popup} className={`ui-menu${className ? ` ${className}` : ''}`}>{children}</Menu.Popup>
    </Menu.Positioner>
  </Menu.Portal>;
}
