import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { SITES } from '../qa/config.mjs';
const directory = mkdtempSync(join(tmpdir(),'qa-collection-'));
for (const site of SITES) writeFileSync(join(directory,`${site.key}.json`),JSON.stringify({ ...site, scope:'smoke', urls:[site.baseUrl], complete:true, errors:[] }));
const output = spawnSync(process.execPath,[resolve('node_modules/playwright/cli.js'),'test','--list'],{
  encoding:'utf8',timeout:30000,
  env:{...process.env,QA_MANIFEST_DIR:directory,QA_SITE:'',QA_SHARD_INDEX:'0',QA_SHARD_TOTAL:'1'}
});
assert.equal(output.status,0,`${output.stdout}\n${output.stderr}`);
assert.match(output.stdout,/Total:\s*6 tests/);
console.log('PASS: production test entry point collected all six site/device tests without navigation.');
