import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compactCount,formatCount,joinCounts,noun,plural,verbFor} from '../src/shared/wording.ts';
import {agoLabel} from '../src/renderer/relativeTime.ts';

test('plural uses Intl plural rules, groups digits and handles irregular nouns (UX-18)',()=>{
 assert.equal(plural(0,'chat'),'0 chats');assert.equal(plural(1,'chat'),'1 chat');assert.equal(plural(2,'chat'),'2 chats');
 assert.equal(plural(1204,'file','files',{locale:'en'}),'1,204 files');
 assert.equal(plural(3,'entry'),'3 entries');assert.equal(plural(2,'directory'),'2 directories');assert.equal(plural(2,'match'),'2 matches');assert.equal(plural(2,'box'),'2 boxes');
 assert.equal(plural(2,'day'),'2 days','vowel + y keeps its y');
 assert.equal(plural(2,'queued follow-up'),'2 queued follow-ups');assert.equal(plural(2,'person'),'2 people');
 assert.equal(noun(1,'chat'),'chat');assert.equal(noun(5,'chat'),'chats');assert.equal(verbFor(1,'was','were'),'was');assert.equal(verbFor(3,'was','were'),'were');
});

test('unknown counts never render as zero (UX-18)',()=>{
 assert.equal(plural(undefined,'chat'),'—');assert.equal(plural(null,'chat',undefined,{unknown:'unknown'}),'unknown');assert.equal(plural(Number.NaN,'chat'),'—');
 assert.equal(formatCount(undefined),'—');assert.equal(formatCount(0),'0');assert.equal(formatCount(1234.56,{locale:'en'}),'1,234.6');
 assert.equal(compactCount(1234,{locale:'en'}),'1.2K');assert.equal(compactCount(null),'—');
 assert.equal(joinCounts([plural(2,'approval'),0,false,'',plural(1,'question')]),'2 approvals · 1 question');
});

test('agoLabel shares compactAge buckets and blanks unknown dates (UX-18)',()=>{
 const now=Date.parse('2026-09-23T12:00:00Z');
 assert.equal(agoLabel(now-10_000,now),'just now');assert.equal(agoLabel(now-13*3_600_000,now),'13h ago');
 assert.equal(agoLabel(now-8*86_400_000,now),'1w ago');assert.equal(agoLabel(now-100*86_400_000,now),'3mo ago');
 assert.equal(agoLabel('not a date',now),'');
});
