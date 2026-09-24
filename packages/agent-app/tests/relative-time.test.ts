import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compactAge,exactTime,relativeLabel} from '../src/renderer/relativeTime.ts';
const now=Date.parse('2026-09-22T12:00:00Z'),ago=(ms:number)=>new Date(now-ms);
const m=60_000,h=60*m,d=24*h;

test('compact age uses the Codex row vocabulary at each boundary',()=>{
  const cases:[number,string][]=[[0,'now'],[59_999,'now'],[m,'1m'],[5*m,'5m'],[59*m,'59m'],[h,'1h'],[3*h,'3h'],[23*h,'23h'],[d,'1d'],[2*d,'2d'],[6*d,'6d'],[7*d,'1w'],[29*d,'4w'],[30*d,'1mo'],[4*30*d,'4mo'],[364*d,'12mo'],[365*d,'1y'],[800*d,'2y']];
  for(const [elapsed,label] of cases)assert.equal(compactAge(ago(elapsed),now),label,`${elapsed}ms`);
});

test('compact age accepts ISO strings, clamps future stamps and blanks invalid dates',()=>{
  assert.equal(compactAge('2026-09-22T09:00:00Z',now),'3h');
  assert.equal(compactAge(now+5*m,now),'now');
  assert.equal(compactAge('not a date',now),'');
  assert.equal(compactAge('',now),'');
});

test('relative label is localized through Intl.RelativeTimeFormat',()=>{
  assert.equal(relativeLabel(ago(10_000),now,'en'),'now');
  assert.equal(relativeLabel(ago(5*m),now,'en'),'5 minutes ago');
  assert.equal(relativeLabel(ago(h),now,'en'),'1 hour ago');
  assert.equal(relativeLabel(ago(d),now,'en'),'yesterday');
  assert.equal(relativeLabel(ago(14*d),now,'en'),'2 weeks ago');
  assert.equal(relativeLabel(ago(2*365*d),now,'en'),'2 years ago');
  assert.equal(relativeLabel(ago(3*d),now,'fr'),'il y a 3 jours');
  assert.equal(relativeLabel('nope',now,'en'),'');
});

test('exact time gives a full tooltip string and blanks invalid input',()=>{
  assert.match(exactTime(now),/2026/);
  assert.equal(exactTime('nope'),'');
});
