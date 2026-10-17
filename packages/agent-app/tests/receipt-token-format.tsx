/** Receipt token counts: never "1000.0k", and billions get a unit. */
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const {Receipt}=await import('../src/renderer/components/HubParts');
const summary=(input:number,output:number)=>{
  const html=renderToStaticMarkup(<Receipt entry={{id:'e',outcome:'succeeded',source:'paperclip',files:null,tests:0,tokens:{input,output,cached:0,reasoning:0},costUsd:null,durationMs:null,agent:'A',trigger:'x',tools:[]} as any}/>);
  return (html.match(/ws-receipt-summary">([^<]*)</)??[])[1]??'';
};
assert.match(summary(999_990,1500),/^1\.0M in · 1\.5k out/);
assert.match(summary(2_500_000_000,0),/^2\.5B in/);
assert.doesNotMatch(summary(999_960,12),/1000/);
console.log('receipt-token-format ok');
process.exit(0);
