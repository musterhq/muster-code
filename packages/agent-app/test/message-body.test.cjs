const {test} = require('node:test');
const assert = require('node:assert/strict');
const {build} = require('esbuild');
const Module = require('node:module');
const path = require('node:path');

let renderer;
async function render(text) {
  if (!renderer) {
    const result = await build({stdin:{contents:`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {MessageBody} from './src/renderer/components/MessageBody'; export const render = text => renderToStaticMarkup(React.createElement(MessageBody,{text}));`,resolveDir:path.resolve(__dirname,'..'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'}});
    const module = new Module(__filename);
    module._compile(result.outputFiles[0].text,__filename);
    renderer = module.exports.render;
  }
  return renderer(text);
}

test('Markdown renders lists, tables and fenced code as structured content',async()=>{
  const html=await render('- Greeting changed\n- Version updated\n\n```ts\nconst n = 2;\n```\n\n| Before | After |\n| --- | --- |\n| 1 | 2 |');
  assert.match(html,/<ul>/); assert.match(html,/<table>/);
  assert.match(html,/class="md-code-body"/); assert.match(html,/Copy code/);
  assert.doesNotMatch(html,/```/);
});

test('Provider text cannot inject HTML or active URL schemes',async()=>{
  const html=await render('<script>window.pwned=true</script>\n\n[bad](javascript:alert%281%29) [data](data:text/html,test) [safe](https://example.com)');
  assert.doesNotMatch(html,/<script|href="javascript:|href="data:/i);
  assert.match(html,/href="https:\/\/example.com"/);
});
