import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {MUSTER_THEMES} from '../src/appearance.js';
import {MUSTER_ICON_CODES} from '../src/muster-icons.js';
test('all five palettes preserve full-file diff semantic colors and icon fonts are bundled',()=>{
  const root=resolve(process.cwd(),'../theme');const manifest=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
  assert.equal(manifest.contributes.configurationDefaults['diffEditor.renderSideBySide'],false);
  assert.equal(manifest.contributes.configurationDefaults['workbench.colorTheme'],'Muster Graphite');
  assert.equal(MUSTER_THEMES[0].name,'Muster Dark');
  assert.deepEqual(MUSTER_THEMES[0].colors,['#121918','#18201F','#9BD7C4']);
  assert.equal(MUSTER_THEMES[1].name,'Muster Graphite');
  assert.deepEqual(MUSTER_THEMES[1].colors,['#141414','#181818','#81A1C1']);
  const graphite=JSON.parse(readFileSync(resolve(root,'themes/muster-graphite-color-theme.json'),'utf8'));
  assert.equal(graphite.colors['button.background'],'#81A1C1');
  assert.equal(graphite.colors['textLink.foreground'],'#81A1C1');
  const recovered=JSON.parse(readFileSync(resolve(root,'themes/muster-dark-color-theme.json'),'utf8'));
  assert.deepEqual({sideBar:recovered.colors['sideBar.background'],editor:recovered.colors['editor.background'],emphasis:recovered.colors['activityBarBadge.background']},{sideBar:'#121918',editor:'#18201F',emphasis:'#9BD7C4'});
  for(const theme of MUSTER_THEMES){const entry=manifest.contributes.themes.find((t:any)=>t.label===theme.name);assert.ok(entry);const data=JSON.parse(readFileSync(resolve(root,entry.path),'utf8'));for(const key of ['diffEditor.insertedLineBackground','diffEditor.removedLineBackground','diffEditor.insertedTextBackground','diffEditor.removedTextBackground'])assert.match(data.colors[key],/^#[0-9a-f]{6,8}$/i);assert.notEqual(data.colors['diffEditor.insertedLineBackground'],data.colors['diffEditor.removedLineBackground']);}
  const path=resolve(root,manifest.contributes.productIconThemes[0].path);const icons=JSON.parse(readFileSync(path,'utf8'));assert.ok(existsSync(resolve(dirname(path),icons.fonts[0].src[0].path)));
  for(const id of ['terminal','robot','files','search','debug','layout-sidebar-right-off','layout-panel-off','ellipsis','send'])assert.match(icons.iconDefinitions[id].fontCharacter,/^\\[a-f0-9]+$/);
  assert.ok(MUSTER_ICON_CODES.terminal>0);assert.ok(existsSync(resolve('resources/lucide.ttf')));
});
