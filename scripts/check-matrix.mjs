import { strict as assert } from 'node:assert';
import { buildMatrix } from '../qa/matrix.mjs';
import { PROJECTS } from '../qa/config.mjs';
const inventories = [1272,2610,1290].map((count,index) => ({key:`site${index}`,urls:Array.from({length:count},(_,n)=>`https://site${index}.test/${n}/`)}));
for (const sizes of [inventories, [8000,8000,8000].map((count,index)=>({key:`site${index}`,urls:Array(count).fill('url')}))]) {
  const { include } = buildMatrix(sizes);
  assert(include.length <= 256);
  for (const site of sizes) for (const project of PROJECTS) {
    const assigned = include.filter(row=>row.site===site.key && row.project===project);
    const seen = Array(site.urls.length).fill(0);
    for (const row of assigned) site.urls.forEach((_,index)=>{if(index%row.shards===row.shard)seen[index]++;});
    assert(seen.every(count=>count===1),'Every page/device must have exactly one shard');
  }
}
const full = buildMatrix(inventories);
assert(full.include.every(row=>Math.ceil(inventories.find(site=>site.key===row.site).urls.length/row.shards)<=42));
assert.equal(buildMatrix(inventories,'smoke').include.length,6);
console.log(`PASS: balanced ${full.include.length} shards cover all 10,344 page/device assignments exactly once, at most 42 pages per shard.`);
