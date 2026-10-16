import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SITES, STEP_DELAY_MS } from '../qa/config.mjs';
import { auditPage, PageResult, atomicJson } from '../qa/audit';

const requestedSite = process.env.QA_SITE;
const sites = SITES.filter(site => !requestedSite || requestedSite === site.key);
if (!sites.length) throw new Error(`Unknown QA_SITE: ${requestedSite}`);
const shard = Number(process.env.QA_SHARD_INDEX || 0);
const shards = Number(process.env.QA_SHARD_TOTAL || 1);
if (!Number.isInteger(shard) || !Number.isInteger(shards) || shard < 0 || shards < 1 || shard >= shards) throw new Error('Invalid QA shard');
for (const site of sites) {
  const inventory = JSON.parse(readFileSync(join(process.env.QA_MANIFEST_DIR || 'qa-manifest', `${site.key}.json`), 'utf8'));
  const urls: string[] = inventory.urls.filter((_: string, index: number) => index % shards === shard);
  for (const url of urls) {
    const id = createHash('sha256').update(url).digest('hex').slice(0, 16);
    test(`${site.name} | ${id} | ${url}`, async ({ page }, testInfo) => {
      const path = join('qa-results', site.key, testInfo.project.name, `${id}.json`);
      const resumePath = process.env.QA_RESUME_DIR && join(process.env.QA_RESUME_DIR, site.key, testInfo.project.name, `${id}.json`);
      if (resumePath && existsSync(resumePath)) {
        const previous = JSON.parse(readFileSync(resumePath, 'utf8'));
        if (previous.commit === process.env.GITHUB_SHA && previous.status === 'passed' && previous.complete && previous.stepDelayMs === STEP_DELAY_MS) {
          atomicJson(path, previous);
          test.skip(true, 'Reused complete passing page from the identical commit and pacing');
        }
      }
      const result: PageResult = {
        schemaVersion: 1, site: site.name, siteKey: site.key, device: testInfo.project.name, url,
        commit: process.env.GITHUB_SHA,
        status: 'running', complete: false, startedAt: new Date().toISOString(), stepDelayMs: STEP_DELAY_MS,
        actions: [], physicalClicks: 0, findings: [], warnings: [], discoveredUrls: [],
        scopeLimitations: ['No login', 'No real telephone call or outgoing form/message submission', 'Chromium desktop and emulated mobile; native iOS Safari not included']
      };
      atomicJson(path, result);
      await auditPage(page, result, path, { screenshotDirectory: testInfo.outputPath('evidence') });
      await testInfo.attach('page-result', { path, contentType: 'application/json' });
      expect(result.complete, `PAGE_INCOMPLETE | ${url}`).toBe(true);
      expect(result.findings, result.findings.map(f => `${f.code} | ${f.pageUrl} | ${f.resourceUrl || ''} | ${f.message}`).join('\n')).toEqual([]);
    });
  }
}
