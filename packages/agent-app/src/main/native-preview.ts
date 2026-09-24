import {createRequire} from 'node:module';
import {existsSync, promises as fs} from 'node:fs';
import path from 'node:path';
import type {BrowserWindow} from 'electron';
import {resolveInside} from '../runtime/paths.ts';

export interface PreviewBounds {x:number;y:number;width:number;height:number}
interface NativePreview {show(handle:Buffer,file:string,x:number,y:number,width:number,height:number):void;hide():void;refresh():void}
export function previewBounds(value:unknown,width:number,height:number):PreviewBounds {
  const v=value as PreviewBounds;
  if(!v || ![v.x,v.y,v.width,v.height].every(n=>typeof n==='number' && Number.isFinite(n)))throw new Error('Invalid preview bounds.');
  const x=Math.max(0,Math.min(width,v.x)),y=Math.max(0,Math.min(height,v.y));
  return {x,y,width:Math.max(0,Math.min(width-x,v.width)),height:Math.max(0,Math.min(height-y,v.height))};
}
/** Main-process-only, local preview capability. Paths never come from an arbitrary URL. */
export class NativePreviewController {
  private binding:NativePreview|undefined;
  private owner=''; private file=''; private sequence=0;
  constructor(private window:BrowserWindow,private modulePath=path.join(__dirname,'quick-look.node')){}
  available():boolean{return process.platform==='darwin' && existsSync(this.modulePath);}
  private native():NativePreview {
    if(!this.available())throw new Error('Native macOS preview is unavailable in this build.');
    return this.binding ??= createRequire(__filename)(this.modulePath) as NativePreview;
  }
  private validOwner(owner:unknown):asserts owner is string {
    if(typeof owner!=='string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(owner))throw new Error('Invalid preview owner.');
  }
  async show(input:{owner:string;folderId:string;path:string;bounds:PreviewBounds},folderRoot:()=>Promise<string>):Promise<void> {
    this.validOwner(input?.owner);
    if(typeof input.path!=='string'||input.path.length>4096 || !/\.(docx?|xlsx?|xlsm|xlsb|pptx?|pdf|odt|ods|odp|rtf|numbers|key|pages|heic|heif|tiff?)$/i.test(input.path))throw new Error('Unsupported native document format.');
    const sequence=++this.sequence;this.owner=input.owner;this.file='';this.binding?.hide();
    const root=await folderRoot();
    const file=await resolveInside(root,input.path),stat=await fs.stat(file);
    if(!stat.isFile()||stat.size>64*1024*1024)throw new Error('Native preview supports regular files up to 64 MiB.');
    if(sequence!==this.sequence || this.owner!==input.owner || this.window.isDestroyed())return;
    this.file=file;this.position(input.owner,input.bounds);this.binding?.refresh();
  }
  position(owner:unknown,bounds:unknown):void {
    this.validOwner(owner);
    if(owner!==this.owner || !this.file || this.window.isDestroyed())return;
    const [width,height]=this.window.getContentSize();
    const rect=previewBounds(bounds,width,height);
    if(rect.width<1 || rect.height<1){this.binding?.hide();return;}
    this.native().show(this.window.getNativeWindowHandle(),this.file,rect.x,rect.y,rect.width,rect.height);
  }
  hide(owner?:unknown):void {
    if(owner!==undefined){this.validOwner(owner);if(owner!==this.owner)return;}
    ++this.sequence; this.owner='';this.file='';this.binding?.hide();
  }
}
