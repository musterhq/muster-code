import {flushSync} from 'react-dom';

let active: ViewTransition | undefined;
/** Snapshot the viewport once so text does not reflow on every animation frame. */
export function transitionLayout(change:()=>void):void {
  active?.skipTransition();
  window.dispatchEvent(new window.Event('muster:layout-start')); 
  if (!document.startViewTransition || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    change();
    window.dispatchEvent(new window.Event('muster:layout-end'));
    return;
  }
  const transition=document.startViewTransition(()=>flushSync(change));
  active=transition;
  void transition.finished.catch(()=>{}).finally(()=>{if(active===transition){active=undefined;window.dispatchEvent(new window.Event('muster:layout-end'));}});
}
