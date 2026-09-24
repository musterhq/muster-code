import {chmodSync,cpSync,existsSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='darwin') throw new Error('The native preview package requires macOS.');
if(!existsSync(path.join(root,'dist/main/index.cjs'))) throw new Error('Build Agent Mode before packaging.');
const {version}=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`package.json version "${version}" is not a CFBundleVersion.`);
const electron=createRequire(import.meta.url)('electron');
const app=path.join(root,'release/Muster Agent Preview.app');
rmSync(app,{recursive:true,force:true});
mkdirSync(path.dirname(app),{recursive:true});
execFileSync('ditto',[path.resolve(electron,'../../..'),app]);
const plist=path.join(app,'Contents/Info.plist');
const plistBuddy=(command,{optional=false}={})=>{try{execFileSync('/usr/libexec/PlistBuddy',['-c',command,plist],{stdio:'pipe'});}catch(error){if(!optional)throw error;}};
// Identity: a unique bundle id keeps preview builds from colliding with Electron's own defaults or a future release channel.
for(const [key,value] of Object.entries({CFBundleIdentifier:'dev.themuster.agent.preview',CFBundleName:'Muster Agent',CFBundleDisplayName:'Muster Agent',CFBundleShortVersionString:version,CFBundleVersion:version})){plistBuddy(`Delete :${key}`,{optional:true});plistBuddy(`Add :${key} string ${value}`);}
// Never ship Electron's permissive App Transport Security exception; the app loads only local files.
plistBuddy('Delete :NSAppTransportSecurity',{optional:true});
for(const command of [
  'Delete :CFBundleURLTypes',
  'Add :CFBundleURLTypes array',
  'Add :CFBundleURLTypes:0 dict',
  'Add :CFBundleURLTypes:0:CFBundleURLName string dev.themuster.agent.chat',
  'Add :CFBundleURLTypes:0:CFBundleURLSchemes array',
  'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string muster',
]) plistBuddy(command,{optional:command.startsWith('Delete')});
// PER-09: the build's update channel (src/main/update-channel.ts). The feed URL is optional and never a secret.
const channel=process.env.MUSTER_UPDATE_CHANNEL?.trim()||'preview';
if(!['stable','beta','preview'].includes(channel)) throw new Error(`MUSTER_UPDATE_CHANNEL must be stable, beta or preview (got "${channel}").`);
for(const [key,value] of Object.entries({MusterUpdateChannel:channel,...(process.env.MUSTER_UPDATE_BASE_URL?{MusterUpdateBaseURL:process.env.MUSTER_UPDATE_BASE_URL}:{})})){
  if(key==='MusterUpdateBaseURL'&&!/^https:\/\/[^\s@]+$/.test(value)) throw new Error('MUSTER_UPDATE_BASE_URL must be an https URL without credentials.');
  plistBuddy(`Delete :${key}`,{optional:true});plistBuddy(`Add :${key} string ${value}`);
}
// Electron's sample app must not ride along in a product bundle.
rmSync(path.join(app,'Contents/Resources/default_app.asar'),{force:true});
const resources=path.join(app,'Contents/Resources/app');mkdirSync(resources,{recursive:true});
const distRoot=path.join(root,'dist');
const shipped=source=>{const relative=path.relative(distRoot,source);return relative!=='tests'&&!relative.startsWith('tests'+path.sep)&&!relative.endsWith('.map');};
cpSync(distRoot,path.join(resources,'dist'),{recursive:true,filter:shipped});
// Interactive terminals: node-pty's JS plus its Electron-built binary and spawn-helper (mode preserved).
const pty=path.join(root,'node_modules/node-pty'),ptyOut=path.join(resources,'node_modules/node-pty');
const ptyNative=['build/Release',`prebuilds/${process.platform}-${process.arch}`].map(dir=>path.join(pty,dir)).find(dir=>existsSync(path.join(dir,'pty.node')));
if(!ptyNative) throw new Error('node-pty has no native build. Run `npm run rebuild:native` before packaging.');
cpSync(path.join(pty,'lib'),path.join(ptyOut,'lib'),{recursive:true,filter:source=>!/\.(test\.js|map)$/.test(source)});
for(const name of ['package.json','LICENSE'])cpSync(path.join(pty,name),path.join(ptyOut,name));
for(const name of ['pty.node','spawn-helper'])cpSync(path.join(ptyNative,name),path.join(ptyOut,'build/Release',name));
chmodSync(path.join(ptyOut,'build/Release/spawn-helper'),0o755);
writeFileSync(path.join(resources,'package.json'),JSON.stringify({name:'muster-agent',productName:'Muster Agent',version,main:'dist/main/index.cjs'}));
// PER-09 signing and notarization (docs/RELEASE.md). No secret is read from or written to the repo:
//   MUSTER_SIGN_IDENTITY   "Developer ID Application: … (TEAMID)" in the login keychain → hardened runtime + timestamp.
//   MUSTER_NOTARY_PROFILE  a `xcrun notarytool store-credentials` keychain profile → submit, wait, staple.
// Without them the build is ad hoc signed for local use, as before.
const identity=process.env.MUSTER_SIGN_IDENTITY?.trim(),notaryProfile=process.env.MUSTER_NOTARY_PROFILE?.trim();
if(notaryProfile&&!identity) throw new Error('MUSTER_NOTARY_PROFILE needs MUSTER_SIGN_IDENTITY: Apple notarizes only Developer ID signed, hardened builds.');
if(identity){
  const entitlements=path.join(root,'scripts/macos/entitlements.plist');
  const sign=target=>execFileSync('codesign',['--force','--timestamp','--options','runtime','--entitlements',entitlements,'--sign',identity,target],{stdio:'pipe'});
  // Inside-out: nested native code first, the bundle last (no --deep, which Apple discourages for distribution).
  for(const target of [path.join(ptyOut,'build/Release/spawn-helper'),path.join(ptyOut,'build/Release/pty.node')]) sign(target);
  const frameworks=path.join(app,'Contents/Frameworks');
  for(const name of readdirSync(frameworks).sort((a,b)=>Number(b.endsWith('.framework'))-Number(a.endsWith('.framework')))) sign(path.join(frameworks,name));
  sign(app);
  execFileSync('codesign',['--verify','--deep','--strict','--verbose=2',app],{stdio:'pipe'});
  if(notaryProfile){
    const zip=path.join(path.dirname(app),'Muster Agent Preview.zip');
    rmSync(zip,{force:true});
    execFileSync('ditto',['-c','-k','--keepParent',app,zip]);
    execFileSync('xcrun',['notarytool','submit',zip,'--keychain-profile',notaryProfile,'--wait'],{stdio:'inherit'});
    execFileSync('xcrun',['stapler','staple',app],{stdio:'inherit'});
    execFileSync('spctl',['--assess','--type','execute','--verbose',app],{stdio:'inherit'});
    rmSync(zip,{force:true});
  }
} else {
  execFileSync('codesign',['--force','--deep','--sign','-',app],{stdio:'pipe'});
}
console.log(app);
