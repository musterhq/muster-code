import {buildDiffRows, diffStats, foldContext} from './diffModel';
const scope = globalThis as unknown as {onmessage:((event:MessageEvent)=>void)|null;postMessage:(message:unknown)=>void};
scope.onmessage = async event => {
  try {
    const {before, after, ignoreWhitespace} = event.data as {before:string;after:string;ignoreWhitespace?:boolean};
    const limit = (value:string) => {
      let count = 0, end = value.length;
      for (let i = 0; i < value.length; i++) if (value[i] === '\n' && ++count === 10000) {end = i + 1;break;}
      return {text:value.slice(0,end),limited:end<value.length};
    };
    const a = limit(before), b = limit(after);
    const all = buildDiffRows(a.text,b.text,ignoreWhitespace);
    let revision:string|null = null;
    try {
      const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([before,after])));
      revision=Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
    } catch {/* Show the diff, but never mark unknown content as viewed. */}
    scope.postMessage({all,folded:foldContext(all),stats:diffStats(all),limited:a.limited||b.limited,revision});
  } catch(error) {scope.postMessage({error:error instanceof Error ? error.message : 'Could not compute this diff. Open the file to inspect its contents.'});}
};
