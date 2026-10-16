import { request } from '@playwright/test';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { SITES, PROJECTS, publicUrl, decodeEntities, htmlLinks } from '../qa/config.mjs';

const scope = process.env.QA_SCOPE || 'full';
const directory = process.env.QA_MANIFEST_DIR || 'qa-manifest';
const selected = SITES.filter(site => !process.env.QA_SITE || site.key === process.env.QA_SITE);
if (!selected.length) throw new Error('Unknown QA_SITE');
mkdirSync(directory, { recursive: true });
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const client = await request.newContext({ ignoreHTTPSErrors: true, timeout: 30000, ...(proxy ? { proxy: { server: proxy } } : {}) });
const inventories = [];
try {
  for (const site of selected) {
    const pages = new Set([site.baseUrl]);
    const sitemaps = new Set();
    const warnings = [];
    const errors = [];
    const pageStatus = {};
    if (scope === 'full') {
      const maps = ['/sitemap_index.xml', '/sitemap.xml', '/wp-sitemap.xml'].map(path => new URL(path, site.baseUrl).href);
      try {
        const robots = await client.get(new URL('/robots.txt', site.baseUrl).href);
        if (robots.ok()) for (const match of (await robots.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim)) maps.push(match[1]);
      } catch (error) { warnings.push(`ROBOTS_UNAVAILABLE | ${site.baseUrl} | ${String(error)}`); }
      for (let index = 0; index < maps.length; index++) {
        const map = maps[index];
        if (sitemaps.has(map)) continue;
        sitemaps.add(map);
        try {
          const response = await client.get(map);
          if (!response.ok()) continue; // Alternative WordPress sitemap names need not exist.
          const xml = await response.text();
          if (!/<(?:sitemapindex|urlset)\b/i.test(xml)) continue;
          for (const match of xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
            const value = decodeEntities(match[1]).trim();
            if (/<sitemapindex\b/i.test(xml)) {
              if (!sitemaps.has(value)) maps.push(value);
            } else {
              const page = publicUrl(value, site.baseUrl);
              if (page) pages.add(page);
            }
          }
        } catch (error) { errors.push(`SITEMAP_UNAVAILABLE | ${map} | ${String(error)}`); }
      }
      if (pages.size < 10) errors.push(`SITEMAP_COVERAGE_TOO_SMALL | ${site.baseUrl} | ${pages.size}`);
    }
    const sitemapUrls = pages.size;
    // A finite inventory is built once, BEFORE browser sharding. Discovering an
    // internal link never makes every device/shard grow a private duplicate queue.
    const queue = [...pages];
    let cursor = 0;
    const scanned = new Set();
    const redirected = new Set();
    const scan = async () => {
      while (cursor < queue.length) {
        const url = queue[cursor++];
        let response;
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              response = await client.get(url);
              if (response.status() >= 500 && attempt === 0) continue;
              break;
            } catch (error) { if (attempt === 1) throw error; }
          }
          pageStatus[url] = response.status();
          const canonical = publicUrl(response.url(), site.baseUrl);
          if (canonical && canonical !== url) redirected.add(url);
          if (response.status() >= 400) {
            // Keep bad linked pages in the browser manifest; the browser test
            // records their exact status and screenshot instead of hiding them.
            warnings.push(`INVENTORY_HTTP_${response.status()} | ${url}`);
          } else if ((response.headers()['content-type'] || '').includes('text/html')) {
            const html = await response.text();
            if (scope === 'full') for (const link of htmlLinks(html, site.baseUrl)) {
              if (pages.has(link)) continue;
              if (pages.size >= 8000) throw new Error('Inventory exceeds 8000 pages; refusing silent truncation');
              pages.add(link);
              queue.push(link);
            }
          }
          scanned.add(url);
          if (scanned.size % 100 === 0) console.log(`QA_INVENTORY | ${site.name} | ${scanned.size}/${queue.length}`);
        } catch (error) {
          errors.push(`INVENTORY_FETCH_FAILED | ${url} | ${String(error)}`);
        } finally { if (response) await response.dispose(); }
      }
    };
    await Promise.all([scan(), scan(), scan()]);
    const inventory = {
      ...site, scope, createdAt: new Date().toISOString(), sitemapUrls,
      checkedSitemaps: [...sitemaps], scannedPages: scanned.size,
      urls: [...pages].sort(), redirected: [...redirected], pageStatus, warnings, errors,
      complete: errors.length === 0 && scanned.size === pages.size
    };
    writeFileSync(`${directory}/${site.key}.json`, JSON.stringify(inventory, null, 2));
    inventories.push(inventory);
    console.log(`QA_INVENTORY_DONE | ${site.name} | ${inventory.urls.length} pages | complete=${inventory.complete}`);
  }
} finally { await client.dispose(); }

const include = inventories.flatMap(site => {
  const shards = scope === 'smoke' ? 1 : Math.max(1, Math.min(40, Math.ceil(site.urls.length / 25)));
  return PROJECTS.flatMap(project => Array.from({ length: shards }, (_, shard) => ({ site: site.key, project, shard, shards })));
});
const matrix = JSON.stringify({ include });
writeFileSync(`${directory}/matrix.json`, matrix);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
if (inventories.some(site => !site.complete)) process.exitCode = 1;
