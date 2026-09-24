import test from 'node:test';
import assert from 'node:assert/strict';
import {pageVisible,releaseImage} from '../src/renderer/pageVisibility.ts';

test('PER-04: decoded surfaces treat only a hidden document as not visible',()=>{
  assert.equal(pageVisible({visibilityState:'visible'}),true);
  assert.equal(pageVisible({visibilityState:'hidden'}),false);
  assert.equal(pageVisible(undefined),true,'no document (tests, workers) never suspends');
});

test('PER-04: releasing an image drops its src so the decoded bitmap can be freed',()=>{
  let removed='';
  releaseImage({removeAttribute:(name:string)=>{removed=name;}} as unknown as HTMLImageElement);
  assert.equal(removed,'src');
  releaseImage(null);
});
