/** OrgAvatar: the initial of a name that starts with an emoji or another astral character is the whole character, not half of it. */
import assert from 'node:assert/strict';
import React from 'react';
import {check} from './dom-check.ts';
import {renderToStaticMarkup} from 'react-dom/server';
const {OrgAvatar}=await import('../src/renderer/components/OrgSidebar');
const initial=(name:string)=>(renderToStaticMarkup(<OrgAvatar name={name}/>).match(/>([^<]*)<\/span>/)??[])[1];
// Spec: MUS-SPEC-12-557A (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-557a)
await check('an org avatar shows the whole first emoji or character of the name', async () => {
  assert.equal(initial('🚀 Launch'),'🚀');
  assert.equal(initial('  ragnar'),'R');
  assert.equal(initial('𝔸lpha'),'𝔸');
  assert.equal(initial('   '),'?');
});
console.log('org-avatar-emoji ok');
process.exit(0);
