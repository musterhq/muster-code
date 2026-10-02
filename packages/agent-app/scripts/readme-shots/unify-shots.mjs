// Screenshots for the one-Muster-Server experience: the real renderer in headless Chrome, with the server answers captured from a real Paperclip
// backend and a real muster-server (the E2E runs write them). Usage (from packages/agent-app):
//   UNIFY_DATA=<dir with shots-data-a.json and shots-data-b.json> SHOTS_FILE=scripts/readme-shots/unify-shots.mjs SHOTS_TMP=<dir> \
//     node scripts/readme-shots/shoot.mjs --probe settings-paperclip settings-muster sidebar project roster
import {readFileSync} from 'node:fs';
import path from 'node:path';

const dir = process.env.UNIFY_DATA;
const read = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
const A = read('shots-data-a.json'), B = read('shots-data-b.json');

/** Answers `paperclip.*` and `musterServer.*` from a captured backend, on top of the fictional bridge that boots the rest of the app. */
const connect = (data, view) => async (ctx) => {
  const payload = JSON.stringify({snapshot: data.snap, view, test: data.test ?? data.detect, detail: data.detail, ledger: data.ledger});
  await ctx.evaluate(`
    const d = ${payload}, h = window.__mockHandlers;
    h['paperclip.config.get'] = () => d.view;
    h['paperclip.signin.status'] = () => ({phase: 'idle'});
    h['paperclip.test'] = () => d.test;
    h['paperclip.snapshot'] = () => ({...d.snapshot, fetchedAt: new Date().toISOString()});
    h['paperclip.task'] = ({id}) => ({...d.detail, task: d.snapshot.tasks.find(t => t.id === id) ?? d.detail.task});
    h['paperclip.ledger'] = () => d.ledger;
    h['paperclip.badge'] = () => ({connected: true, inbox: d.snapshot.inbox.length, liveRuns: 0, mail: 0, chatIds: [], company: d.snapshot.paperclip?.company?.name ?? null, orgs: {}});
    h['paperclip.watch'] = () => ({live: d.view.live ?? 'socket'});
    h['paperclip.inbox.dismissed'] = () => ({items: []});
    h['paperclip.list'] = () => ({kind: 'audit', rows: [], note: ''});
    h['paperclip.dashboard'] = () => null;
    window.__emit({type: 'projectsWorkspaceChanged', scopes: ['config', 'tasks', 'runs', 'agents', 'inbox'], taskIds: []});
  `);
  await ctx.sleep(600);
};
const openSettings = async (ctx) => { await ctx.store(`s.openAppSettings('integrations')`); await ctx.sleep(1500); };

export const SHOTS = [
  {name: 'settings-paperclip', local: true, opts: {}, async run(ctx) { await connect(A, A.view)(ctx); await openSettings(ctx); }},
  {name: 'settings-muster', local: true, opts: {}, async run(ctx) { await connect(B, B.view)(ctx); await openSettings(ctx); }},
  {name: 'sidebar', local: true, opts: {}, async run(ctx) { await connect(A, A.view)(ctx); await ctx.sleep(3500); await ctx.evaluate(`document.querySelector('.nav-org-label')?.scrollIntoView({block: 'center'})`); }},
  {name: 'sidebar-muster', local: true, opts: {}, async run(ctx) { await connect(B, B.view)(ctx); await ctx.sleep(3500); await ctx.evaluate(`document.querySelector('.nav-org-label')?.scrollIntoView({block: 'center'})`); }},
  {name: 'project', local: true, opts: {}, async run(ctx) { await connect(B, B.view)(ctx); await ctx.sleep(3500); await ctx.click('.nav-section-title', 'Support desk'); await ctx.sleep(1800); }},
  {name: 'project-paperclip', local: true, opts: {}, async run(ctx) { await connect(A, A.view)(ctx); await ctx.sleep(3500); await ctx.click('.nav-section-title', 'Pipeline'); await ctx.sleep(1800); }},
  {name: 'roster', local: true, opts: {}, async run(ctx) { await connect(B, B.view)(ctx); await ctx.sleep(3500); await ctx.click('.nav-item, button', 'Roster'); await ctx.sleep(1800); }},
  {name: 'roster-paperclip', local: true, opts: {}, async run(ctx) { await connect(A, A.view)(ctx); await ctx.sleep(3500); await ctx.click('.nav-item, button', 'Roster'); await ctx.sleep(1800); }},
];
