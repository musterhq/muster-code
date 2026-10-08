/** Differential update downloads from electron-builder block maps (Windows NSIS installer, Linux AppImage).
 *
 * electron-builder splits each installer into content-defined chunks and writes a block map: the chunk sizes and a
 * checksum of each chunk. The setup.exe's map ships beside it (`<file>.blockmap`, gzip); an AppImage carries its own at
 * the end of the file (deflate, followed by its 4-byte big-endian length). Comparing the map of a file we already have
 * (the running AppImage, or the last verified Windows installer) with the new one tells which byte ranges to fetch;
 * the rest is copied locally. Nothing here is trusted: the rebuilt file must still match the release's SHA256SUMS
 * entry, and on any doubt the caller downloads the whole file instead. */
import {promises as fs} from 'node:fs';
import {gunzipSync,inflateRawSync} from 'node:zlib';

export interface BlockMapFile {name:string;offset:number;checksums:string[];sizes:number[]}
export interface BlockMap {version:string;files:BlockMapFile[]}
export type DifferentialOp={kind:'copy';from:number;length:number}|{kind:'download';start:number;length:number};
export interface DifferentialPlan {ops:DifferentialOp[];downloadBytes:number;totalBytes:number;requests:number}

/** Bounds that keep a malformed or hostile map from costing much before the checksum rejects the result. */
const MAX_MAP_BYTES=64*1024*1024,MAX_CHUNKS=4_000_000;

export function parseBlockMap(data:Uint8Array,format:'gzip'|'deflate'):BlockMap {
  const text=(format==='gzip'?gunzipSync(data,{maxOutputLength:MAX_MAP_BYTES}):inflateRawSync(data,{maxOutputLength:MAX_MAP_BYTES})).toString('utf8');
  const map=JSON.parse(text) as BlockMap;
  const file=map?.files?.[0];
  if(!file||!Array.isArray(file.checksums)||!Array.isArray(file.sizes)||file.checksums.length!==file.sizes.length||file.sizes.length>MAX_CHUNKS)throw new Error('The block map is malformed.');
  if(file.sizes.some(size=>!Number.isSafeInteger(size)||size<=0)||file.checksums.some(sum=>typeof sum!=='string'))throw new Error('The block map is malformed.');
  return {version:String(map.version),files:[{name:String(file.name),offset:Number(file.offset)||0,checksums:file.checksums,sizes:file.sizes}]};
}

/** The block map appended to an AppImage: [file bytes][deflated map][uint32 BE map length]. `size` is the file's length. */
export function embeddedMapRange(size:number,tail:Uint8Array):{start:number;end:number;covered:number} {
  if(tail.byteLength<4)throw new Error('The AppImage has no block map.');
  const length=new DataView(tail.buffer,tail.byteOffset,tail.byteLength).getUint32(tail.byteLength-4);
  const start=size-4-length;
  if(length===0||length>MAX_MAP_BYTES||start<=0)throw new Error('The AppImage has no block map.');
  return {start,end:size-4,covered:start};
}

/** Reads the block map embedded in a local AppImage. */
export async function readEmbeddedBlockMap(file:string):Promise<{map:BlockMap;covered:number}> {
  const handle=await fs.open(file,'r');
  try{
    const {size}=await handle.stat();
    const tail=Buffer.alloc(4);await handle.read(tail,0,4,size-4);
    const range=embeddedMapRange(size,tail);
    const data=Buffer.alloc(range.end-range.start);await handle.read(data,0,data.length,range.start);
    return {map:parseBlockMap(data,'deflate'),covered:range.covered};
  }finally{await handle.close();}
}

const total=(map:BlockMap)=>map.files[0]!.sizes.reduce((sum,size)=>sum+size,0);

/** Which bytes of the new file to download and which to copy from the old one, in new-file order.
 *  Downloads separated by less than `mergeGap` copied bytes become one request (fewer round trips). */
export function planDifferential(oldMap:BlockMap,newMap:BlockMap,{mergeGap=256*1024}:{mergeGap?:number}={}):DifferentialPlan {
  const old=oldMap.files[0]!,next=newMap.files[0]!;
  const known=new Map<string,number>();
  for(let i=0,offset=old.offset;i<old.checksums.length;offset+=old.sizes[i]!,i++){const key=`${old.checksums[i]}:${old.sizes[i]}`;if(!known.has(key))known.set(key,offset);}
  const ops:DifferentialOp[]=[];
  for(let i=0,offset=next.offset;i<next.checksums.length;offset+=next.sizes[i]!,i++){
    const size=next.sizes[i]!,from=known.get(`${next.checksums[i]}:${size}`),last=ops.at(-1);
    if(from!==undefined){
      if(last?.kind==='copy'&&last.from+last.length===from)last.length+=size;else ops.push({kind:'copy',from,length:size});
    }else if(last?.kind==='download'&&last.start+last.length===offset)last.length+=size;else ops.push({kind:'download',start:offset,length:size});
  }
  // A copy squeezed between two downloads and shorter than mergeGap is cheaper to download than to split the request.
  const merged:DifferentialOp[]=[];
  for(let i=0;i<ops.length;i++){
    const op=ops[i]!,prev=merged.at(-1),after=ops[i+1];
    if(op.kind==='copy'&&prev?.kind==='download'&&after?.kind==='download'&&op.length<=mergeGap){prev.length+=op.length+after.length;i++;continue;}
    if(op.kind==='download'&&prev?.kind==='download'){prev.length+=op.length;continue;}
    merged.push({...op});
  }
  const downloads=merged.filter(op=>op.kind==='download');
  return {ops:merged,downloadBytes:downloads.reduce((sum,op)=>sum+op.length,0),totalBytes:total(newMap),requests:downloads.length};
}

/** Worth doing: not too many requests, and a real saving over fetching the whole file. */
export function differentialWorthIt(plan:DifferentialPlan):boolean {
  return plan.requests<=400&&plan.downloadBytes<=plan.totalBytes*0.8;
}
