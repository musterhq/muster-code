/** OrgAvatar: the initial of a name that starts with an emoji or another astral character is the whole character, not half of it. */
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const {OrgAvatar}=await import('../src/renderer/components/OrgSidebar');
const initial=(name:string)=>renderToStaticMarkup(<OrgAvatar name={name}/>).replace(/<[^>]+>/g,'');
assert.equal(initial('🚀 Launch'),'🚀');
assert.equal(initial('  ragnar'),'R');
assert.equal(initial('𝔸lpha'),'𝔸');
assert.equal(initial('   '),'?');
console.log('org-avatar-emoji ok');
process.exit(0);
