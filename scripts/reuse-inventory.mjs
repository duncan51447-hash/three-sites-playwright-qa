import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { SITES } from '../qa/config.mjs';
import { buildMatrix } from '../qa/matrix.mjs';
const inventories = [];
for (const site of SITES) {
  const manifest = JSON.parse(readFileSync(`qa-manifest/${site.key}.json`, 'utf8'));
  if (manifest.scope !== (process.env.QA_SCOPE || 'full')) throw new Error(`Scope mismatch: ${site.key}`);
  if (!manifest.complete || Math.abs(Date.now() - Date.parse(manifest.createdAt)) > 24 * 3600000) throw new Error(`Inventory incomplete or older than 24 hours: ${site.key}`);
  inventories.push(manifest);
}
// Page evidence is independent of shard layout. Keep the exact collected URLs
// and timestamps while balancing the current runners across all three sites.
const matrix = buildMatrix(inventories,process.env.QA_SCOPE || 'full');
if (!Array.isArray(matrix.include) || !matrix.include.length || matrix.include.length > 256) throw new Error('Invalid inventory matrix');
matrix.include.sort((a,b) => a.shard - b.shard || a.site.localeCompare(b.site) || a.project.localeCompare(b.project));
writeFileSync('qa-manifest/matrix.json',JSON.stringify(matrix));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
console.log(`Reused immutable inventory: ${matrix.include.length} browser shards`);
