import { PROJECTS } from './config.mjs';

export function buildMatrix(inventories, scope = 'full') {
  const allocation = inventories.map(site => ({ site, shards: 1, wanted: scope === 'smoke' ? 1 : Math.max(1, Math.ceil(site.urls.length / 42)) }));
  const budget = Math.floor(256 / PROJECTS.length);
  while (allocation.reduce((n, row) => n + row.shards, 0) < budget) {
    const next = allocation.filter(row => row.shards < row.wanted).sort((a,b) => b.site.urls.length / b.shards - a.site.urls.length / a.shards)[0];
    if (!next) break;
    next.shards++;
  }
  return { include: allocation.flatMap(({site,shards}) => PROJECTS.flatMap(project => Array.from({length:shards}, (_,shard) => ({site:site.key,project,shard,shards})))).sort((a,b) => a.shard - b.shard || a.site.localeCompare(b.site) || a.project.localeCompare(b.project)) };
}
