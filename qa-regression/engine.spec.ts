import { test, expect } from '@playwright/test';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditPage, PageResult, Pacer } from '../qa/audit';
import { generateReport } from '../qa/summary.mjs';
import { publicUrl, htmlLinks, STEP_DELAY_MS } from '../qa/config.mjs';

function initial(url: string, device: string): PageResult {
  return { schemaVersion: 1, site: 'Fixture', siteKey: 'fixture', device, url, status: 'running', complete: false, startedAt: new Date().toISOString(), stepDelayMs: 0, actions: [], physicalClicks: 0, findings: [], warnings: [], discoveredUrls: [], scopeLimitations: [] };
}
let server: Server, base: string, posts = 0, assetRequests = 0, landings = 0;
test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.method === 'POST') posts++;
    if (request.url === '/canonical-home/') { response.writeHead(302,{location:'/'}); response.end(); return; }
    if (request.url === '/asset.js') { assetRequests++; response.writeHead(200, { 'content-type':'application/javascript', 'cache-control':'public,max-age=3600' }); response.end('window.liveAsset=true;'); return; }
    if (request.url === '/bad.png') { response.writeHead(404); response.end('missing'); return; }
    if (request.url === '/warning.png') { response.writeHead(401); response.end('unauthorized'); return; }
    response.setHeader('content-type', 'text/html');
    if (request.url === '/player/') { response.end('<title>Player</title><button style="position:fixed;inset:0" onclick="this.textContent=\'Playing\'">Play</button>'); return; }
    if (request.url !== '/') { response.end('<title>Destination</title><script src="/asset.js"></script><main>destination loaded</main>'); return; }
    const section = `footer-${landings++ % 2}`;
    response.end(`<!doctype html><title>QA fixture</title><script src="/asset.js"></script>
      <style>body{margin:0;padding:25px}a,button,input,select{display:block;margin:15px;padding:8px}#panel{display:none}.av-burger-overlay-active #panel{display:block}.mfp-wrap{display:none;position:fixed;inset:0;background:#eee;z-index:20}.mfp-wrap.open{display:block}#speak-box-close{display:none}</style>
      <nav class="av-burger-menu-main"><a id="menu" href="#" onclick="document.body.classList.toggle('av-burger-overlay-active');return false">Menu</a></nav>
      <div id="panel"><a id="child" href="/child/">Hidden child</a><button id="nested" onclick="document.getElementById('deep').hidden=false">Nested</button><a id="deep" href="/deep/" hidden>Deep child</a></div>
      <a id="ordinary" href="/destination/">Ordinary link</a>
      <a id="alias" href="/canonical-home/">Canonical home alias</a>
      <a id="web-menu-parent" href="/section/" onclick="document.getElementById('web-menu-child').hidden=false;return false">URL-shaped menu opener</a><a id="web-menu-child" href="/web-child/" hidden>URL-shaped menu child</a>
      <a id="same1" href="/same/">same label</a><a id="same2" href="/same/">same label</a>
      <a id="popup" href="/popup/" target="_blank">Popup</a>
      <a id="phone" href="tel:0800000000">Phone</a>
      <a id="search" href="/?s=" onclick="document.getElementById('query').hidden=false;return false">Search</a><input id="query" placeholder="Search query" hidden>
      <a id="faq" href="#toggle-id-10" onclick="const p=document.getElementById('answer');p.hidden=!p.hidden;this.href=p.hidden?'#toggle-id-10':'#toggle-id-10-closed';location.hash=p.hidden?'toggle-id-10-closed':'toggle-id-10';return false">FAQ</a>
      <div id="answer" hidden><a id="faq-child" href="/faq-destination/">FAQ child</a></div>
      <button id="photo" onclick="document.getElementById('modal').classList.add('open')">Photo</button>
      <div id="modal" class="mfp-wrap"><button class="mfp-close" id="close" onclick="document.getElementById('modal').classList.remove('open')">Close photo</button></div>
      <form><input id="name" name="name" placeholder="Name" required><button id="submit" type="submit">Submit</button></form>
      <button id="post" onclick="fetch('/submit/',{method:'POST',body:'test'}).catch(()=>{})">Read-only guarded action</button>
      <div id="play-overlay" class="av-click-to-play-overlay" style="cursor:pointer;padding:20px" onclick="document.getElementById('player').hidden=false">Embedded play overlay</div>
      <iframe id="player" title="Embedded player" src="/player/" hidden></iframe>
      <a id="login" href="/wp-login.php">Login</a>
      <div id="${section}"><a href="/stable-footer/">Stable footer</a></div>
      <div style="height:1000px">scroll content</div><button id="bottom">Bottom button</button>
      <script>if(location.hash.startsWith('#toggle-id-10')){document.getElementById('answer').hidden=false;document.getElementById('faq').href='#toggle-id-10-closed';}console.error('[Report Only] Refused to frame https://www.google.com/ because frame-ancestors is report-only');document.addEventListener('click',e=>{window.counts ||= {};if(e.isTrusted&&e.target.id)window.counts[e.target.id]=(window.counts[e.target.id]||0)+1},true)</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

test('physically clicks duplicate links, hidden menus, lightbox, touch and form without posting', async ({ page }, info) => {
  const result = initial(`${base}/`, info.project.name);
  const path = info.outputPath('page.json');
  const beforePosts = posts;
  const beforeAssets = assetRequests;
  await auditPage(page, result, path, { delay: 0 });
  expect(result.complete, JSON.stringify(result.findings)).toBe(true);
  expect(result.findings).toEqual([]);
  for (const id of ['menu','child','nested','deep','ordinary','alias','web-menu-parent','web-menu-child','same1','same2','popup','phone','photo','close','name','submit','post','bottom','play-overlay','player','search','query','faq','faq-child']) {
    const action = result.actions.find(action => action.selector === `#${id}`);
    expect(action, `Missing ${id}`).toBeTruthy();
    expect(action!.clicks, `${id}: ${action!.reason}`).toBeGreaterThan(0);
    expect(['clicked','interaction_only']).toContain(action!.status);
  }
  expect(result.actions.find(a => a.selector === '#phone')?.status).toBe('interaction_only');
  expect(result.actions.find(a => a.selector === '#login')?.status).toBe('excluded');
  expect(result.actions.filter(a => a.label === 'Stable footer').every(a => a.status === 'clicked')).toBe(true);
  expect(result.warnings.some(w => w.code === 'CSP_REPORT_ONLY')).toBe(true);
  expect(posts).toBe(beforePosts);
  expect(assetRequests - beforeAssets, 'Fetch each live cacheable asset once per page audit').toBe(1);
  expect(result.cachedAssetResponses).toBeGreaterThan(1);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  expect(saved.actions.length).toBe(result.actions.length);
  expect(saved.physicalClicks).toBeGreaterThanOrEqual(15);
});

test('records same-site HTTP failure separately from third-party 401', async ({ page }, info) => {
  const url = `${base}/resources/`;
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: `<title>Resources</title><img src="${base}/bad.png"><img src="${base.replace('localhost','127.0.0.1')}/warning.png">` }));
  const result = initial(url, info.project.name);
  await auditPage(page, result, info.outputPath('page.json'), { delay: 0 });
  expect(result.findings.some(f => f.code === 'HTTP_404_RESOURCE' && f.resourceUrl === `${base}/bad.png`)).toBe(true);
  expect(result.warnings.some(f => f.code === 'HTTP_401_RESOURCE')).toBe(true);
  expect(result.status).toBe('failed');
});

test('never reports incomplete or missing device coverage as success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-report-regression-'));
  mkdirSync(join(root, 'manifest'));
  mkdirSync(join(root, 'results'));
  const url = `${base}/`;
  writeFileSync(join(root, 'manifest', 'fixture.json'), JSON.stringify({ key:'fixture', name:'Fixture', baseUrl:base, urls:[url], complete:true, errors:[] }));
  const page = initial(url, 'desktop-chromium');
  page.actions.push({ key:'interrupted', selector:'#a', label:'interrupted', href:'', status:'running', clicks:0 });
  writeFileSync(join(root, 'results', 'partial.json'), JSON.stringify(page));
  const { summary } = generateReport({ resultsDir:join(root,'results'), manifestDir:join(root,'manifest'), outputDir:join(root,'report'), sites:[{key:'fixture',name:'Fixture',baseUrl:base}] });
  expect(summary.overall).toBe('failed');
  expect(summary.complete).toBe(false);
  expect(summary.groups.find(g => g.device === 'mobile-chromium')!.missingPages).toEqual([url]);
  expect(summary.errors.every(e => e.category === 'qa_coverage' && e.causeZh && e.priority === 'P1')).toBe(true);
  expect(readFileSync(join(root,'report','click-audit.txt'),'utf8')).toContain('interrupted');
});

test('never reports success when a required site inventory is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-missing-inventory-'));
  const { summary, markdown } = generateReport({ resultsDir:join(root,'results'), manifestDir:join(root,'missing'), outputDir:join(root,'report') });
  expect(summary.overall).toBe('failed');
  expect(summary.complete).toBe(false);
  expect(summary.groups).toHaveLength(6);
  expect(summary.errors).toHaveLength(6);
  expect(summary.errors.every(e => e.code === 'INVENTORY_NOT_AVAILABLE' && e.category === 'qa_coverage')).toBe(true);
  expect(markdown).toContain('未知');
});

test('preserves three-second production pacing and bounds inventory URLs', async () => {
  expect(STEP_DELAY_MS).toBe(3000);
  const pacer = new Pacer(40), times: number[] = [];
  await pacer.step(async () => { times.push(Date.now()); });
  await pacer.step(async () => { times.push(Date.now()); });
  expect(times[1]-times[0]).toBeGreaterThanOrEqual(35);
  expect(publicUrl('/article/?utm_source=facebook', base)).toBe(null);
  expect(publicUrl('/wbadmin/', base)).toBe(null);
  expect(htmlLinks('<script>"<a href=\"/fake/\">"</script><a href="/real/">', base)).toEqual([`${base}/real/`]);
});
