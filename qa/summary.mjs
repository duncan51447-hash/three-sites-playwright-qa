import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECTS } from './config.mjs';

function jsonFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? jsonFiles(join(directory, entry.name)) : entry.name.endsWith('.json') ? [join(directory, entry.name)] : []);
}
export function generateReport({ resultsDir = 'qa-results', manifestDir = 'qa-manifest', outputDir = 'qa-report', siteKey = '', project = '', shard = 0, shards = 1 } = {}) {
  const pages = new Map();
  for (const path of jsonFiles(resultsDir)) {
    const page = JSON.parse(readFileSync(path, 'utf8'));
    if (page.schemaVersion !== 1 || !page.url || !page.device) continue;
    const key = `${page.siteKey}|${page.device}|${page.url}`;
    const previous = pages.get(key);
    if (!previous || page.startedAt > previous.startedAt) pages.set(key, page);
  }
  const manifests = jsonFiles(manifestDir).filter(path => !path.endsWith('/matrix.json')).map(path => JSON.parse(readFileSync(path, 'utf8'))).filter(item => Array.isArray(item.urls) && (!siteKey || item.key === siteKey));
  const groups = [];
  const errors = [];
  const warnings = [];
  const unplanned = {};
  for (const manifest of manifests) {
    for (const device of PROJECTS.filter(name => !project || name === project)) {
      const expected = manifest.urls.filter((_, index) => index % shards === shard);
      const actual = expected.map(url => pages.get(`${manifest.key}|${device}|${url}`)).filter(Boolean);
      const actions = actual.flatMap(page => page.actions);
      const unknown = manifest.scope === 'smoke' ? [] : [...new Set(actual.flatMap(page => page.discoveredUrls || []))].filter(url => !manifest.urls.includes(url));
      unplanned[manifest.key] = [...new Set([...(unplanned[manifest.key] || []), ...unknown])];
      const missing = expected.filter(url => !pages.has(`${manifest.key}|${device}|${url}`));
      const incomplete = actual.filter(page => !page.complete);
      const failed = actual.filter(page => page.status === 'failed');
      const notClicked = actions.filter(action => ['pending', 'running', 'failed'].includes(action.status));
      const group = {
        site: manifest.name, siteKey: manifest.key, device, scope: manifest.scope || 'full', inventoryComplete: manifest.complete,
        expectedPages: expected.length, completedPages: actual.filter(page => page.complete).length,
        passedPages: actual.filter(page => page.status === 'passed').length, failedPages: failed.length,
        incompletePages: incomplete.map(page => page.url), missingPages: missing,
        discoveredActions: actions.length, clickedActions: actions.filter(action => ['clicked','interaction_only'].includes(action.status)).length,
        interactionOnlyActions: actions.filter(action => action.status === 'interaction_only').length,
        excludedActions: actions.filter(action => action.status === 'excluded').length,
        unverifiedActions: notClicked.length, physicalClicks: actual.reduce((n, page) => n + page.physicalClicks, 0),
        findingCount: actual.reduce((n, page) => n + page.findings.length, 0),
        warningCount: actual.reduce((n, page) => n + page.warnings.length, 0), unplannedUrls: unknown,
        complete: manifest.complete && !missing.length && !incomplete.length && !unknown.length,
        result: ''
      };
      group.result = group.complete && !group.findingCount && !notClicked.length && !failed.length ? 'passed' : group.complete ? 'failed' : 'incomplete';
      groups.push(group);
      for (const page of actual) {
        errors.push(...page.findings.map(item => ({ ...item, site: manifest.name, device })));
        warnings.push(...page.warnings.map(item => ({ ...item, site: manifest.name, device })));
      }
      for (const url of missing) errors.push({ site: manifest.name, device, code: 'PAGE_NOT_RUN', pageUrl: url, severity: 'high', message: 'No saved browser result' });
      for (const page of incomplete) errors.push({ site: manifest.name, device, code: 'PAGE_INCOMPLETE', pageUrl: page.url, severity: 'high', message: `Last action: ${page.currentAction || 'page setup'}` });
      for (const url of unknown) errors.push({ site: manifest.name, device, code: 'INVENTORY_COVERAGE_GAP', pageUrl: url, severity: 'high', message: 'Discovered in browser but absent from fixed inventory; requires follow-up' });
      for (const message of manifest.errors || []) errors.push({ site: manifest.name, device, code: 'INVENTORY_ERROR', pageUrl: manifest.baseUrl, severity: 'high', message });
    }
  }
  const summary = { schemaVersion: 1, createdAt: new Date().toISOString(), runUrl: process.env.GITHUB_SERVER_URL && `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    overall: groups.length && groups.every(group => group.result === 'passed') ? 'passed' : 'failed', complete: !!groups.length && groups.every(group => group.complete), groups, errors, warnings };
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'coverage-summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(outputDir, 'unplanned-urls.json'), JSON.stringify(unplanned, null, 2));
  writeFileSync(join(outputDir, 'qa-errors.txt'), errors.map(e => `${e.site} | ${e.device} | ${e.code} | ${e.pageUrl} | ${e.resourceUrl || ''} | ${e.message}`).join('\n') || 'No website/coverage errors found.');
  writeFileSync(join(outputDir, 'qa-warnings.txt'), warnings.map(e => `QA_WARNING | ${e.site} | ${e.device} | ${e.code} | ${e.pageUrl} | ${e.resourceUrl || ''} | ${e.message}`).join('\n') || 'No QA_WARNING.');
  writeFileSync(join(outputDir, 'click-audit.txt'), [...pages.values()].flatMap(page => page.actions.map(action => `${page.site} | ${page.device} | ${page.url} | ${action.status} | ${action.clicks} clicks | ${action.label} | ${action.href} | ${action.reason || action.evidence || action.destination || ''}`)).join('\n'));
  const markdown = [
    `# 三站 QA：${summary.overall === 'passed' ? '成功' : '失敗'}（覆蓋${summary.complete ? '完整' : '未完成'}）`, '',
    '| 網站 | 裝置 | 結果 | 完成／預定頁數 | 已點／發現控制項 | 實際點擊次數 | 互動限定 | 排除 | 未驗證 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...groups.map(g => `| ${g.site} | ${g.device} | ${g.result} | ${g.completedPages}/${g.expectedPages} | ${g.clickedActions}/${g.discoveredActions} | ${g.physicalClicks} | ${g.interactionOnlyActions} | ${g.excludedActions} | ${g.unverifiedActions} |`), '',
    '每個使用者操作間隔至少 3 秒。手機為 Chromium 觸控模擬；不登入、不實際撥號、不送出正式詢問。互動限定項目已實際點擊，但不代表後端送件／外部 App 全流程通過。', '',
    '## 網站錯誤與覆蓋缺口', ...errors.slice(0, 150).map(e => `- ${e.site}／${e.device}：${e.code} — ${e.pageUrl} — ${e.resourceUrl || ''} — ${e.message.replace(/\n/g, ' ').slice(0, 400)}`), '',
    `## QA_WARNING（${warnings.length} 筆，與故障分開）`, ...warnings.slice(0, 80).map(e => `- ${e.site}／${e.device}：${e.code} — ${e.pageUrl} — ${e.resourceUrl || ''} — ${e.message.replace(/\n/g, ' ').slice(0, 300)}`), '',
    summary.runUrl ? `[GitHub Actions 完整結果](${summary.runUrl})` : '',
    '完整逐頁／逐次點擊資料請見附件 qa-results、click-audit.txt、qa-errors.txt、qa-warnings.txt、coverage-summary.json。'
  ].join('\n');
  writeFileSync(join(outputDir, 'daily-report.md'), markdown);
  return { summary, markdown };
}
