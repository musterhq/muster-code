/** Pages the screenshot harness shows: what an agent writes when asked for a dashboard. Fallbacks in var() keep the page
 *  readable where no theme is injected (the "before" build, a downloaded file). */
export const DASHBOARD = `<!doctype html><html><head><title>Checkout funnel, last 30 days</title><style>
:root{--g:12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--g);margin-bottom:16px}
.kpi{padding:12px 14px;border:1px solid var(--border,#dfe2e6);border-radius:var(--radius,8px);background:var(--card,#f7f8fa)}
.kpi b{display:block;font-size:22px;font-weight:600;color:var(--foreground,#1f2328);font-variant-numeric:tabular-nums}
.kpi span{font-size:12px;color:var(--muted-foreground,#626a73)}
.kpi .up{color:var(--success,#15803d)}.kpi .down{color:var(--destructive,#dc2626)}
h2{margin:4px 0 8px;font-size:13px;font-weight:600;color:var(--muted-foreground,#626a73);text-transform:uppercase;letter-spacing:.04em}
.chart{display:block;width:100%;height:180px;margin-bottom:14px}
.chart text{fill:var(--muted-foreground,#626a73);font:11px var(--font-sans,system-ui)}
.chart line{stroke:var(--border,#dfe2e6)}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-bottom:1px solid var(--border,#dfe2e6);text-align:left}
th{color:var(--muted-foreground,#626a73);font-weight:500}td:not(:first-child),th:not(:first-child){text-align:right}
.sw{display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:2px;vertical-align:middle}
</style></head><body>
<div class="kpis">
 <div class="kpi"><span>Sessions</span><b>48,210</b><span class="up">+6.4% vs prior</span></div>
 <div class="kpi"><span>Checkout starts</span><b>9,874</b><span class="up">+3.1%</span></div>
 <div class="kpi"><span>Orders</span><b>3,412</b><span class="down">-1.8%</span></div>
 <div class="kpi"><span>Conversion</span><b>7.08%</b><span class="down">-0.6 pt</span></div>
</div>
<h2>Orders per week, by channel</h2>
<svg class="chart" id="chart" viewBox="0 0 700 180" preserveAspectRatio="none" role="img" aria-label="Orders per week by channel"></svg>
<h2>Funnel by step</h2>
<table><thead><tr><th>Step</th><th>Visitors</th><th>Drop-off</th><th>Median time</th></tr></thead><tbody>
<tr><td><span class="sw" style="background:var(--chart-1,#2563eb)"></span>Cart</td><td>14,920</td><td>—</td><td>0:41</td></tr>
<tr><td><span class="sw" style="background:var(--chart-2,#0d9488)"></span>Shipping</td><td>9,874</td><td>33.8%</td><td>1:12</td></tr>
<tr><td><span class="sw" style="background:var(--chart-3,#d97706)"></span>Payment</td><td>5,106</td><td>48.3%</td><td>1:58</td></tr>
<tr><td><span class="sw" style="background:var(--chart-4,#9333ea)"></span>Confirmed</td><td>3,412</td><td>33.2%</td><td>0:09</td></tr>
</tbody></table>
<script>
const weeks=['W1','W2','W3','W4'],series=[[420,460,410,480],[300,320,350,330],[180,210,190,240]];
const svg=document.getElementById('chart'),ns='http://www.w3.org/2000/svg',H=150,max=500,gw=700/weeks.length,bw=26;
const el=(n,a)=>{const e=document.createElementNS(ns,n);for(const k in a)e.setAttribute(k,a[k]);svg.appendChild(e);return e;};
for(let i=0;i<=4;i++){const y=10+H*i/4;el('line',{x1:30,x2:700,y1:y,y2:y,'stroke-width':1});el('text',{x:0,y:y+4}).textContent=String(max-max*i/4);}
weeks.forEach((w,i)=>{series.forEach((s,j)=>{const h=H*s[i]/max;el('rect',{x:30+i*gw+24+j*(bw+6),y:10+H-h,width:bw,height:h,rx:3,fill:'var(--chart-'+(j+1)+',#2563eb)'});});el('text',{x:30+i*gw+24+bw+6,y:176}).textContent=w;});
</script></body></html>`;

/** A page that wants a CDN chart library: shown without it until the person allows network. */
export const NETWORK_PAGE = `<!doctype html><html><head><title>Live crypto prices</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script></head><body>
<p style="color:var(--muted-foreground)">Chart.js loads from a CDN once network is allowed for this page.</p><canvas id="c" height="120"></canvas></body></html>`;

/** A dev server's page for the agent-cursor shot. */
export const APP_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Acme Store</title><style>body{margin:0;font:15px system-ui;background:#f6f7f9;color:#1f2328}header{display:flex;gap:16px;align-items:center;padding:14px 24px;background:#fff;border-bottom:1px solid #e3e6ea}header b{margin-right:auto}main{max-width:720px;margin:32px auto;padding:0 24px}.card{display:flex;gap:16px;align-items:center;padding:16px;background:#fff;border:1px solid #e3e6ea;border-radius:10px}.thumb{width:72px;height:72px;border-radius:8px;background:linear-gradient(135deg,#93c5fd,#2563eb)}button{padding:8px 14px;border:0;border-radius:8px;background:#2563eb;color:#fff;font:600 14px system-ui}</style></head><body><header><b>Acme Store</b><a href="#">Shop</a><a href="#">Cart (0)</a></header><main><h1>Running shoes</h1><div class="card"><div class="thumb"></div><div style="flex:1"><b>Trail Runner 2</b><div style="color:#626a73">$129 · free returns</div></div><button id="add">Add to cart</button></div></main></body></html>`;
