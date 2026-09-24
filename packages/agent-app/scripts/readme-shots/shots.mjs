// Each README shot: how to reach the screen (clicking as a user would, or through the renderer
// store the way the menus do), then one PNG. `opts` reach mock.js as window.__SHOT_OPTS.

/** Scroll the transcript so the main request of the demo chat sits at the top. */
const showMainTurn = async (ctx) => {
  for (let i = 0; i < 3; i++) {
    await ctx.evaluate(`const row=[...document.querySelectorAll('.user-message-row')].find(r=>r.textContent.includes('Tasks need due dates'));const t=document.querySelector('.timeline');if(row&&t){t.scrollTop+=row.getBoundingClientRect().top-t.getBoundingClientRect().top-(${ctx.mainTurnOffset ?? 34});}`);
    await ctx.sleep(250);
  }
};
const scrollTimelineBy = (ctx, px) => ctx.evaluate(`document.querySelector('.timeline').scrollTop+=${px}`);
const clickText = (ctx, selector, text) => ctx.click(selector, text);
const composerType = async (ctx, text) => {
  await ctx.evaluate(`document.querySelector('[data-testid=composer-input]').focus()`);
  await ctx.type(text);
};
const chord = (key) => `window.dispatchEvent(new KeyboardEvent('keydown',{key:'${key}',metaKey:true,bubbles:true,cancelable:true}));`;

export const SHOTS = [
  {name: 'hero', async run(ctx) {
    await ctx.store(`await s.openDiff('f-taskboard','src/models/task.ts')`);
    await ctx.sleep(1200);
    await showMainTurn(ctx);
  }},
  {name: 'timeline', async run(ctx) {
    await ctx.store(`s.setSummaryHidden(true)`);
    await ctx.sleep(400);
    await showMainTurn(ctx);
    await ctx.press('.timeline button, .timeline [role=button]', 'Thought for');
    await ctx.sleep(400);
    for (const label of ['Read 5 files', 'Edited 3 files']) { await clickText(ctx, '.activity-summary, button', label); await ctx.sleep(400); }
    await clickText(ctx, 'button, .tool-card-head, [role=button]', 'npm test');
    await ctx.sleep(600);
    await showMainTurn(ctx);
    await scrollTimelineBy(ctx, 150);
  }},
  {name: 'inline-diff', async run(ctx) {
    await ctx.store(`s.setSummaryHidden(true)`);
    await ctx.sleep(600);
    await ctx.evaluate(`const h=[...document.querySelectorAll('.timeline *')].find(e=>e.children.length<4&&/^Edited TaskCard\\.tsx/.test(e.textContent.trim()));const t=document.querySelector('.timeline');if(h)t.scrollTop+=h.getBoundingClientRect().top-t.getBoundingClientRect().top-60;`);
  }},
  {name: 'memory', async run(ctx) { await ctx.store(`s.openMemoryScreen('f-taskboard')`); await ctx.sleep(1500); }},
  // The composer close up: the draft, the "3 memories" recall chip, access mode and model.
  // The recall chip opened: which notes the next turn will use, each removable for this chat.
  {name: 'recall', async run(ctx) {
    await showMainTurn(ctx);
    await composerType(ctx, 'Add the DueBadge component with overdue styling, and a test for it');
    await ctx.sleep(1400);
    await ctx.evaluate(`document.querySelector('[data-testid="memory-recall-chip"]').click()`);
    await ctx.sleep(600);
    await ctx.evaluate(`const a=document.querySelector('.composer').getBoundingClientRect(),b=document.querySelector('.memory-recall-popover').getBoundingClientRect(),p=20;const x=Math.max(0,Math.min(a.left,b.left)-p),y=Math.max(0,Math.min(a.top,b.top)-p);window.__clip={x,y,width:Math.min(1600,Math.max(a.right,b.right)+p)-x,height:Math.min(1000,Math.max(a.bottom,b.bottom)+p-10)-y};`);
  }},
  {name: 'providers', async run(ctx) {
    await ctx.store(`s.openProvidersTab()`); await ctx.sleep(1500);
  }},
  {name: 'providers-local', async run(ctx) {
    await ctx.store(`s.openProvidersTab()`); await ctx.sleep(1500);
    await ctx.evaluate(`const h=[...document.querySelectorAll('.settings-scroll h3, .settings-scroll strong, .settings-scroll *')].find(e=>e.children.length===0&&e.textContent.trim()==='Local: Ollama');const sc=document.querySelector('.settings-scroll');const card=h.closest('article')??h;sc.scrollTop+=card.getBoundingClientRect().top-sc.getBoundingClientRect().top-24;`);
    await ctx.sleep(400);
    // Stop above the page footer.
    await ctx.evaluate(`const f=[...document.querySelectorAll('.settings-scroll *')].find(e=>e.children.length===0&&e.textContent.trim()==='Provider CLIs');const cut=f?Math.min(1000,f.getBoundingClientRect().top-12):1000;window.__clip={x:0,y:0,width:1600,height:cut};`);
  }},
  {name: 'projects', async run(ctx) { await ctx.store(`s.openProjectsScreen()`); await ctx.sleep(1500); await ctx.evaluate(`[...document.querySelectorAll('button,[role=tab],a')].find(b=>/^Tasks\\s*\\d/.test(b.textContent.trim())).click()`); await ctx.sleep(900); }},
  {name: 'model-picker', async run(ctx) { await showMainTurn(ctx); await ctx.click('button', 'Frontier Large'); await ctx.sleep(800); }},
  {name: 'sandbox', opts: {sandbox: true}, async run(ctx) {
    await ctx.store(`s.openComputerTab({kind:'chat',id:'c-hero'},'Sandbox')`);
    await ctx.sleep(1500);
    await ctx.press('.sbx-toggle', 'Settings');
    await ctx.sleep(900);
    await showMainTurn(ctx);
  }},
  {name: 'environment-menu', async run(ctx) { await showMainTurn(ctx); await ctx.click('button', 'This Mac'); await ctx.sleep(800); }},
  {name: 'terminal', opts: {terminal: true}, async run(ctx) {
    await ctx.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'\`',code:'Backquote',ctrlKey:true,bubbles:true,cancelable:true}))`);
    await ctx.sleep(1800);
    await showMainTurn(ctx);
  }},
  {name: 'git-changes', async run(ctx) {
    await ctx.store(`s.openChangesTab('f-taskboard','taskboard')`); await ctx.sleep(1200);
    await showMainTurn(ctx);
  }},
  {name: 'git-history', async run(ctx) {
    await ctx.store(`s.openHistoryTab('f-taskboard','taskboard')`); await ctx.sleep(1200);
    await ctx.press('.git-history-row', 'Add dueAt and reminder'); await ctx.sleep(900);
    await showMainTurn(ctx);
  }},
  {name: 'spotlight', async run(ctx) { await showMainTurn(ctx); await ctx.evaluate(chord('k')); await ctx.sleep(500); await ctx.type('reminder'); await ctx.sleep(900); }},
  {name: 'skills', async run(ctx) { await ctx.store(`s.openPluginsScreen('skills')`); await ctx.sleep(1500); }},
  {name: 'automations', async run(ctx) { await ctx.store(`s.openAutomationsScreen()`); await ctx.sleep(1500); }},
  // Settings > General > Updates, cropped to the Updates group (with the settings file group above it for context).
  {name: 'updates', async run(ctx) {
    await ctx.store(`s.openAppSettings('general')`); await ctx.sleep(1400);
    await ctx.evaluate(`const sc=document.querySelector('.settings-scroll');sc.scrollTop=sc.scrollHeight;`);
    await ctx.sleep(400);
    await ctx.evaluate(`const heads=[...document.querySelectorAll('.settings-scroll *')].filter(e=>e.children.length===0);const top=heads.find(e=>e.textContent.trim()==='Settings file');const upd=heads.find(e=>e.textContent.trim()==='Updates');const card=upd.nextElementSibling??upd.parentElement;const a=top.getBoundingClientRect(),c=card.getBoundingClientRect(),u=upd.getBoundingClientRect();const left=Math.min(a.left,c.left)-24,right=Math.max(c.right,u.right)+24,bottom=Math.max(c.bottom,u.bottom+200)+24;window.__clip={x:left,y:a.top-20,width:right-left,height:bottom-a.top+20};return window.__clip;`);
  }},
  {name: 'hero-light', opts: {theme: 'light'}, async run(ctx) {
    await ctx.store(`await s.openDiff('f-taskboard','src/models/task.ts')`);
    await ctx.sleep(1200);
    await showMainTurn(ctx);
  }},
];
