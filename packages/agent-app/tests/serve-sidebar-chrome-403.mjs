import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),baseline=process.argv[process.argv.indexOf('--baseline')+1];
const useBaseline=process.argv.includes('--baseline');
const outdir=path.join(root,useBaseline?'dist/review-403-before':'dist/review-403-after');
const changed=new Set(['src/runtime/chat-title.ts','src/renderer/chatNavigation.ts','src/renderer/newChatDraft.ts','src/renderer/store.ts','src/renderer/styles.css','src/renderer/components/Sidebar.tsx','src/renderer/components/TimelineNavigation.tsx']);
const plugins=useBaseline?[{name:'baseline-source',setup(build){build.onLoad({filter:/\.(tsx?|css)$/},args=>{const file=path.relative(root,args.path);if(!changed.has(file))return;return {contents:execFileSync('git',['show',`${baseline}:packages/agent-app/${file}`],{cwd:root,encoding:'utf8'}),loader:file.endsWith('.tsx')?'tsx':file.endsWith('.css')?'css':'ts'};});}}]:[];
await mkdir(outdir,{recursive:true});
await build({entryPoints:[path.join(root,'tests/sidebar-chrome-403.browser.tsx')],outfile:path.join(outdir,'fixture.js'),bundle:true,plugins,platform:'browser',format:'esm',jsx:'automatic',loader:{'.woff2':'file','.woff':'file','.ttf':'file'},define:{'process.env.NODE_ENV':'"production"'}});
const server=createServer(async(req,res)=>{
 const name=path.basename(new URL(req.url,'http://localhost').pathname);
 if(!name){res.setHeader('Content-Type','text/html');res.end('<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');return;}
 try{res.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(await readFile(path.join(outdir,name)));}catch{res.writeHead(404);res.end();}
});
server.listen(0,'127.0.0.1',()=>console.log(`Review fixture: http://127.0.0.1:${server.address().port}`));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
