import {invoke} from './bridge';
/** Write-only, main-frame validated native clipboard capability. */
export function copyText(text:string):Promise<void>{return invoke('clipboard.write',{text});}
