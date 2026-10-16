import { readFileSync, appendFileSync } from 'node:fs';
import { SITES } from '../qa/config.mjs';
for (const site of SITES) {
  const manifest = JSON.parse(readFileSync(`qa-manifest/${site.key}.json`, 'utf8'));
  if (manifest.scope !== (process.env.QA_SCOPE || 'full')) throw new Error(`Scope mismatch: ${site.key}`);
  if (!manifest.complete || Math.abs(Date.now() - Date.parse(manifest.createdAt)) > 24 * 3600000) throw new Error(`Inventory incomplete or older than 24 hours: ${site.key}`);
}
const matrix = JSON.parse(readFileSync('qa-manifest/matrix.json', 'utf8'));
if (!Array.isArray(matrix.include) || !matrix.include.length || matrix.include.length > 256) throw new Error('Invalid inventory matrix');
matrix.include.sort((a,b) => a.shard - b.shard || a.site.localeCompare(b.site) || a.project.localeCompare(b.project));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
console.log(`Reused immutable inventory: ${matrix.include.length} browser shards`);
