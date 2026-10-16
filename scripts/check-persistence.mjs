import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';

// Deliberately kill a real Playwright test at its timeout. This verifies the
// reporter/checkpoint boundary that previously lost all 90-minute shard results.
const root = process.cwd();
mkdirSync('test-results', { recursive: true });
const directory = mkdtempSync(resolve('test-results/persistence-'));
mkdirSync(join(directory, 'qa-manifest'));
const url = 'http://localhost/persistence-fixture/';
const id = createHash('sha256').update(url).digest('hex').slice(0, 16);
writeFileSync(join(directory, 'qa-manifest/pl168.json'), JSON.stringify({ key:'pl168', name:'龐德隆', scope:'full', baseUrl:'http://localhost/', urls:[url], complete:true, errors:[] }));
writeFileSync(join(directory, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'.',outputDir:${JSON.stringify(join(directory,'output'))},testMatch:'timeout.spec.ts',timeout:400,workers:1,reporter:[[${JSON.stringify(join(root,'qa/reporter.ts'))}]],projects:[{name:'desktop-chromium'}]});`);
const data = {
  schemaVersion:1, site:'龐德隆', siteKey:'pl168', device:'desktop-chromium', url,
  status:'running', complete:false, startedAt:new Date().toISOString(), stepDelayMs:3000,
  actions:[{key:'fixture',selector:'#fixture',label:'unfinished control',href:'',status:'running',clicks:0}],
  currentAction:'unfinished control', physicalClicks:0, findings:[], warnings:[], discoveredUrls:[], scopeLimitations:[]
};
const resultPath = `qa-results/pl168/desktop-chromium/${id}.json`;
writeFileSync(join(directory, 'timeout.spec.ts'), `import {test} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
test(${JSON.stringify(`龐德隆 | ${id} | ${url}`)},async()=>{mkdirSync('qa-results/pl168/desktop-chromium',{recursive:true});writeFileSync(${JSON.stringify(resultPath)},${JSON.stringify(JSON.stringify(data))});await new Promise(r=>setTimeout(r,5000));});`);
const child = spawnSync(process.execPath, [join(root,'node_modules/playwright/cli.js'),'test','-c','playwright.config.ts'], {
  cwd: directory, encoding:'utf8', timeout:30000,
  env:{...process.env,QA_MANIFEST_DIR:join(directory,'qa-manifest'),QA_SITE:'pl168',QA_PROJECT:'desktop-chromium',QA_SHARD_INDEX:'0',QA_SHARD_TOTAL:'1'}
});
assert.equal(child.status, 1, `Probe should time out, not fail to launch: ${child.stdout}\n${child.stderr}`);
assert(existsSync(join(directory,resultPath)), `Probe never wrote its checkpoint: ${child.stdout}\n${child.stderr}`);
const page = JSON.parse(readFileSync(join(directory,resultPath),'utf8'));
assert.equal(page.complete,false);
assert.equal(page.status,'incomplete');
assert.equal(page.currentAction,'unfinished control');
assert(page.findings.some(f=>f.code==='TEST_TIMEDOUT'));
const report = JSON.parse(readFileSync(join(directory,'qa-report/coverage-summary.json'),'utf8'));
assert.equal(report.overall,'failed');
assert.equal(report.complete,false);
assert(report.groups[0].incompletePages.includes(url));
assert(readFileSync(join(directory,'qa-report/click-audit.txt'),'utf8').includes('unfinished control'));
console.log('PASS: real timeout retained the current control, JSON checkpoint, click audit and incomplete coverage gate.');
