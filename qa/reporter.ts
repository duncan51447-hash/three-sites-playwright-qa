import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SITES } from './config.mjs';
import { atomicJson } from './audit';
import { generateReport } from './summary.mjs';

export default class PersistReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === 'passed' || result.status === 'skipped') return;
    const site = SITES.find(site => test.title.startsWith(`${site.name} | `));
    if (!site) return;
    const url = test.title.split(' | ').slice(2).join(' | ');
    const device = test.parent.project()?.name || '';
    const id = createHash('sha256').update(url).digest('hex').slice(0, 16);
    const path = join('qa-results', site.key, device, `${id}.json`);
    if (!existsSync(path)) return;
    const page = JSON.parse(readFileSync(path, 'utf8'));
    if (result.status === 'timedOut' || result.status === 'interrupted') {
      page.complete = false; page.status = 'incomplete';
      page.findings.push({ code: `TEST_${result.status.toUpperCase()}`, severity: 'high', pageUrl: url, message: result.error?.message || result.status });
    } else if (page.status === 'running') { page.complete = false; page.status = 'incomplete'; }
    atomicJson(path, page);
  }
  onEnd() {
    generateReport({ siteKey: process.env.QA_SITE || '', project: process.env.QA_PROJECT || '', shard: Number(process.env.QA_SHARD_INDEX || 0), shards: Number(process.env.QA_SHARD_TOTAL || 1) });
  }
}
