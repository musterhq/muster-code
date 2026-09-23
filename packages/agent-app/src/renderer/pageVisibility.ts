import {useSyncExternalStore} from 'react';

/** PER-04: whether the app window is showing (not minimized, hidden or fully occluded).
 * Heavy decoded surfaces (images, PDF canvases) release their memory while it is false. */
export function pageVisible(doc:Pick<Document,'visibilityState'>|undefined=typeof document==='undefined'?undefined:document):boolean {
  return !doc || doc.visibilityState!=='hidden';
}
function subscribe(listener:()=>void):()=>void {
  if(typeof document==='undefined')return()=>{};
  document.addEventListener('visibilitychange',listener);
  return()=>document.removeEventListener('visibilitychange',listener);
}
export function usePageVisible():boolean {
  return useSyncExternalStore(subscribe,()=>pageVisible(),()=>true);
}
/** Drop an <img>'s decoded bitmap now instead of waiting for GC of the detached element. */
export function releaseImage(image:HTMLImageElement|null|undefined):void {
  if(!image)return;
  image.removeAttribute('src');
}
