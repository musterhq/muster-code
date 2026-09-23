import assert from 'node:assert/strict';
import {test} from 'node:test';
import {discoverCards,isHiddenUnsupported,isSystemSkill,normalizeName} from '../src/renderer/marketplaceCatalog.ts';
import type {MarketplacePackage} from '../src/shared/domains/extensions-protocol.ts';

const logo={kind:'image' as const,dataUrl:'data:image/png;base64,AA=='};
const caps={mcpServers:[],apps:[],hooks:[],skills:[],commands:[],agents:[]};
const pkg=(source:string,name:string,extra:Partial<MarketplacePackage>={}):MarketplacePackage=>({id:`${source}:${name}`,sourceId:source,sourceLabel:source,name,kind:'plugin',displayName:name[0].toUpperCase()+name.slice(1),version:'1.0.0',capabilities:caps,compatibility:{format:'codex',supported:true,unsupported:[],notes:[]},...extra});
const plugin=(name:string,extra:object={})=>({id:`/cache/${name}`,name,version:'1',provenance:'openai-curated',path:`/cache/${name}`,skills:[],mcpServers:[],apps:[],readError:null,...extra});
const skill=(name:string,path:string)=>({id:path,name,provenance:'~/.codex/skills',path,readme:null,readError:null});

test('one card per package across curated sources; installed anywhere means Manage; logos are reused',()=>{
  const catalog=[
    pkg('openai-curated','figma'),pkg('openai-curated-remote','figma',{icon:logo}),
    pkg('openai-curated','github'),pkg('openai-curated-remote','github'),
    pkg('claude','google-calendar',{displayName:'Google Calendar'}),pkg('openai-curated','google_calendar',{displayName:'Google Calendar'}),
    pkg('claude','hookify',{compatibility:{format:'claude',supported:false,unsupported:['hooks'],notes:[]}}),
    pkg('claude','pdf',{kind:'skill'}),
    pkg('mine','linear',{installed:{version:'1.0.0',updateAvailable:false}}),
  ];
  const cards=discoverCards({catalog,installed:[{id:'linear',name:'linear',kind:'plugin',version:'1.0.0',path:'/x',sourceId:'mine',packageId:'mine:linear',sha256:'',installedAt:'',state:'Ready',manifest:null,previous:[]}],plugins:[plugin('github',{icon:logo,displayName:'GitHub'}) as any],skills:[skill('pdf','/Users/me/.codex/skills/pdf'),skill('imagegen','/Users/me/.codex/skills/.system/imagegen')]});
  assert.deepEqual(cards.map(card=>card.pkg.name),['figma','github','google-calendar','hookify','pdf','linear'],'no duplicate cards');
  const by=(name:string)=>cards.find(card=>card.pkg.name===name)!;
  assert.equal(by('figma').pkg.sourceId,'openai-curated-remote','the copy with a logo wins');
  assert.deepEqual(by('figma').sources,['openai-curated','openai-curated-remote']);
  assert.deepEqual(by('github').installedAs,{kind:'codex',id:'/cache/github'},'installed in Codex → Manage');
  assert.equal(by('github').icon,logo,'the Codex manifest logo replaces a letter avatar');
  assert.deepEqual(by('pdf').installedAs,{kind:'skill',id:'/Users/me/.codex/skills/pdf'});
  assert.deepEqual(by('linear').installedAs,{kind:'installed',id:'linear'});
  assert.equal(by('figma').installedAs,undefined);
  assert.deepEqual(cards.filter(isHiddenUnsupported).map(card=>card.pkg.name),['hookify'],'unsupported sits behind the filter');
});

test('.system skills are internal, and names normalize across separators',()=>{
  assert.equal(isSystemSkill(skill('imagegen','/Users/me/.codex/skills/.system/imagegen')),true);
  assert.equal(isSystemSkill(skill('.system','/Users/me/.codex/skills/.system')),true);
  assert.equal(isSystemSkill(skill('pdf','/Users/me/.codex/skills/pdf')),false);
  assert.equal(normalizeName('Google-Calendar'),normalizeName('google_calendar'));
});
