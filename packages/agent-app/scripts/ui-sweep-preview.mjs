// #398: isolated renderer fixture, never the desktop app. Ctrl-C stops this server.
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {relative} from 'node:path';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const baseline=process.argv.includes('--baseline');
const outdir=new URL(`../dist/ui-sweep-preview${baseline?'-main':''}/`,import.meta.url);
await build({entryPoints:[new URL('../tests/ui-sweep.browser.tsx',import.meta.url).pathname],outdir:outdir.pathname,bundle:true,platform:'browser',format:'esm',jsx:'automatic',plugins:baseline?[{name:'main-renderer',setup(b){b.onLoad({filter:/src\/renderer\/.*\.(tsx?|css)$/},args=>{const file=relative(new URL('../../..',import.meta.url).pathname,args.path);return {contents:execFileSync('git',['show',`origin/main:${file}`],{encoding:'utf8'}),loader:args.path.endsWith('.css')?'css':args.path.endsWith('.tsx')?'tsx':'ts'};});}}]:[],loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
const server=createServer(async(req,res)=>{try{const name=req.url.split('?')[0].slice(1);if(!name){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="/ui-sweep.browser.css"></head><body><div id="root"></div><script type="module" src="/ui-sweep.browser.js"></script></body></html>');return;}if(!['ui-sweep.browser.js','ui-sweep.browser.css'].includes(name)){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('css')?'text/css':'text/javascript');res.end(await readFile(new URL(name,outdir)));}catch{res.writeHead(500).end();}});
server.listen(0,'127.0.0.1',()=>console.log(`Preview: http://127.0.0.1:${server.address().port}`));
