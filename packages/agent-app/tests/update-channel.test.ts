import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkForUpdate,compareVersions,parseUpdateManifest,resolveUpdateChannel,updateFeedURL} from '../src/main/update-channel.ts';

const sha='a'.repeat(64);
test('PER-09: channel resolution: user choice, then the build, then the environment, then preview',()=>{
  assert.equal(resolveUpdateChannel({userChoice:'beta',bundle:'stable'}),'beta');
  assert.equal(resolveUpdateChannel({userChoice:'nightly',bundle:'stable'}),'stable');
  assert.equal(resolveUpdateChannel({env:{MUSTER_UPDATE_CHANNEL:'beta'}}),'beta');
  assert.equal(resolveUpdateChannel({}),'preview');
});

test('PER-09: versions order with prerelease tags',()=>{
  assert.ok(compareVersions('0.3.0','0.2.9')>0);assert.ok(compareVersions('1.2.0-beta.2','1.2.0')<0);
  assert.ok(compareVersions('1.2.0-beta.10','1.2.0-beta.2')>0);assert.equal(compareVersions('0.2.0','0.2.0'),0);
  assert.throws(()=>compareVersions('latest','0.1.0'),/Invalid version/);
});

test('PER-09: feeds and manifests are HTTPS-only, credential-free and carry a SHA-256',()=>{
  assert.equal(updateFeedURL('https://updates.example.test/muster/','beta','darwin','arm64'),'https://updates.example.test/muster/beta/darwin-arm64/latest.json');
  assert.throws(()=>updateFeedURL('http://updates.example.test','stable'),/HTTPS/);
  assert.throws(()=>updateFeedURL('https://user:token@updates.example.test','stable'),/credentials/);
  const manifest=parseUpdateManifest({channel:'beta',version:'0.3.0-beta.1',url:'https://updates.example.test/Muster.zip',sha256:sha.toUpperCase()},'beta');
  assert.equal(manifest.sha256,sha);
  assert.throws(()=>parseUpdateManifest({channel:'stable',version:'0.3.0',url:'https://x.test/a.zip',sha256:sha},'beta'),/not "beta"/);
  assert.throws(()=>parseUpdateManifest({channel:'beta',version:'0.3.0',url:'http://x.test/a.zip',sha256:sha},'beta'),/HTTPS/);
  assert.throws(()=>parseUpdateManifest({channel:'beta',version:'0.3.0',url:'https://x.test/a.zip'},'beta'),/SHA-256/);
});

test('PER-09: no feed configured means no request; a newer manifest is offered',async()=>{
  let fetched='';
  assert.deepEqual(await checkForUpdate({current:'0.2.0',channel:'preview',fetchJson:async url=>{fetched=url;return {};}}),{channel:'preview',current:'0.2.0',available:false,disabledReason:'No update feed is configured for this build.'});
  assert.equal(fetched,'');
  const result=await checkForUpdate({current:'0.2.0',channel:'preview',base:'https://u.example.test',fetchJson:async url=>{fetched=url;return {channel:'preview',version:'0.2.1',url:'https://u.example.test/m.zip',sha256:sha};}});
  assert.equal(result.available,true);assert.match(fetched,/\/preview\/.+\/latest\.json$/);
});

test('PER-09: the packager is notarization-ready without secrets in the repo',()=>{
  const script=readFileSync(new URL('../scripts/package-preview.mjs',import.meta.url),'utf8');
  for(const needle of ["'--options','runtime'",'--timestamp','notarytool','stapler','MUSTER_SIGN_IDENTITY','MUSTER_NOTARY_PROFILE','MusterUpdateChannel'])assert.ok(script.includes(needle),needle);
  assert.ok(!/APPLE_ID_PASSWORD|app-specific|--password/.test(script),'credentials live in a keychain profile, never in the script');
  const entitlements=readFileSync(new URL('../scripts/macos/entitlements.plist',import.meta.url),'utf8');
  assert.ok(entitlements.includes('com.apple.security.cs.allow-jit'));assert.ok(!entitlements.includes('disable-library-validation'));
});
