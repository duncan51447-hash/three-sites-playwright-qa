import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECTS, SITES } from './config.mjs';

function explain(item, warning = false) {
  const code = item.code || '';
  let category = 'website', causeZh = '網站回應或前端執行發生錯誤，請依原始訊息與資源網址定位。', priority = item.severity === 'medium' ? 'P2' : 'P1';
  if (code === 'BROWSER_VERIFICATION_BLOCKED') {
    category = 'qa_coverage'; causeZh = '測試瀏覽器停在網站驗證頁，未進入公開內容；這是測試覆蓋受阻，不能據此判定網站對一般訪客故障。'; priority = 'P1';
  } else if (/^(?:PAGE_NOT_RUN|PAGE_INCOMPLETE|PAGE_AUDIT_INTERRUPTED|INVENTORY_|TEST_|REVEAL_DEPTH_LIMIT)/.test(code)) {
    category = 'qa_coverage'; causeZh = '測試證據或覆蓋尚未完成；此項本身不能判定網站故障。'; priority = 'P1';
  } else if (code === 'INTERACTION_FAILED') {
    category = 'needs_review'; causeZh = '實際互動重試後仍無法完成；需依點擊、頁面與截圖確認是網站行為或測試定位問題。';
  } else if (/SCROLL_/.test(code)) {
    category = 'needs_review'; causeZh = '瀏覽器未完成捲動；需確認頁面捲動限制或測試手勢，不能視為完整覆蓋。';
  } else if (/PAGE_HTTP_/.test(code)) causeZh = '公開頁面未回傳可使用的 HTTP 回應，訪客可能無法開啟此頁。';
  else if (/HTTP_\d+_RESOURCE/.test(code)) causeZh = '網站資源回傳錯誤狀態；請檢查原始資源與受影響功能。';
  else if (code === 'PAGE_ERROR' || code === 'CONSOLE_ERROR') causeZh = '前端 JavaScript 或瀏覽器執行錯誤，可能中斷頁面互動；請依原始堆疊確認原因。';
  else if (code === 'BROKEN_IMAGE') causeZh = '可見圖片載入後仍沒有可呈現的影像。';
  else if (code === 'HORIZONTAL_OVERFLOW') causeZh = '內容寬度超出裝置視窗，可能造成橫向捲動或內容被裁切。';
  else if (code === 'EMPTY_TITLE') causeZh = '頁面標題為空，影響辨識與搜尋呈現。';
  else if (code === 'REQUEST_FAILED') causeZh = '網站資源請求未完成；需確認連線、伺服器或瀏覽器阻擋原因。';
  if (warning) {
    category = 'background_warning'; priority = 'P3';
    causeZh = code === 'CSP_REPORT_ONLY' ? 'CSP 目前僅回報，這則訊息本身沒有阻擋資源。'
      : code === 'STORAGE_ACCESS' ? '第三方儲存存取被瀏覽器拒絕，這則訊息本身不足以判定網站功能故障。'
      : /HTTP_401_RESOURCE/.test(code) && /recaptcha/i.test(item.resourceUrl || '') ? 'Google reCAPTCHA 驗證資源回傳 401；需與表單實際互動結果分開判讀。'
      : code === 'SIDE_EFFECT_BLOCKED' ? 'QA 已阻止正式送件、投票或外部副作用，屬測試範圍限制。'
      : /EXTERNAL_HANDOFF|EMBEDDED_PLAYBACK/.test(code) ? '控制項已實際點擊；外部 App 或第三方播放結果尚未確認，不列為全流程通過。'
      : code === 'LOAD_EVENT_TIMEOUT' ? '頁面已呈現，但載入事件等待逾時；後續互動仍繼續驗證。'
      : '背景或第三方訊息；是否影響使用須依實際互動證據判斷。';
  }
  return { ...item, category, causeZh, priority, severityZh: warning ? '低' : item.severity === 'medium' ? '中' : '高' };
}

function jsonFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? jsonFiles(join(directory, entry.name)) : entry.name.endsWith('.json') ? [join(directory, entry.name)] : []);
}
export function generateReport({ resultsDir = 'qa-results', manifestDir = 'qa-manifest', outputDir = 'qa-report', siteKey = '', project = '', shard = 0, shards = 1, sites = SITES } = {}) {
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
  for (const site of sites.filter(site => !siteKey || site.key === siteKey)) {
    if (manifests.some(manifest => manifest.key === site.key)) continue;
    for (const device of PROJECTS.filter(name => !project || name === project)) {
      groups.push({ site: site.name, siteKey: site.key, device, scope: 'unknown', inventoryComplete: false, expectedPages: null, completedPages: 0, passedPages: 0, failedPages: 0, incompletePages: [], missingPages: [], discoveredActions: 0, clickedActions: 0, interactionOnlyActions: 0, excludedActions: 0, unverifiedActions: 0, physicalClicks: 0, findingCount: 0, warningCount: 0, warningOccurrences: 0, unplannedUrls: [], complete: false, result: 'incomplete' });
      errors.push({ site: site.name, device, code: 'INVENTORY_NOT_AVAILABLE', pageUrl: site.baseUrl, severity: 'high', message: 'Required site inventory is missing; page count and browser coverage are unknown' });
    }
  }
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
        warningOccurrences: actual.reduce((n, page) => n + page.warnings.reduce((m, warning) => m + (warning.occurrences || 1), 0), 0),
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
    overall: groups.length && groups.every(group => group.result === 'passed') ? 'passed' : 'failed', complete: !!groups.length && groups.every(group => group.complete), groups, errors: errors.map(item => explain(item)), warnings: warnings.map(item => explain(item, true)) };
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'coverage-summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(outputDir, 'unplanned-urls.json'), JSON.stringify(unplanned, null, 2));
  writeFileSync(join(outputDir, 'qa-errors.txt'), summary.errors.map(e => `${e.site} | ${e.device} | ${e.category} | ${e.priority}/${e.severityZh} | ${e.code} | ${e.pageUrl} | ${e.resourceUrl || ''} | ${e.message} | 中文原因：${e.causeZh}`).join('\n') || 'No website/coverage errors found.');
  writeFileSync(join(outputDir, 'qa-warnings.txt'), summary.warnings.map(e => `QA_WARNING | ${e.site} | ${e.device} | ${e.code} | ${e.pageUrl} | ${e.resourceUrl || ''} | ${e.message} | 中文原因：${e.causeZh} | occurrences=${e.occurrences || 1}`).join('\n') || 'No QA_WARNING.');
  writeFileSync(join(outputDir, 'click-audit.txt'), [...pages.values()].flatMap(page => page.actions.map(action => `${page.site} | ${page.device} | ${page.url} | ${action.status} | ${action.clicks} target clicks + ${action.setupClicks || 0} setup clicks | ${action.label} | ${action.href} | ${action.reason || action.evidence || action.destination || ''}`)).join('\n'));
  const markdown = [
    `# 三站 QA：${summary.overall === 'passed' ? '成功' : '失敗'}（覆蓋${summary.complete ? '完整' : '未完成'}）`, '',
    '| 網站 | 裝置 | 結果 | 完成／預定頁數 | 已點／發現控制項 | 實際點擊次數 | 互動限定 | 排除 | 未驗證 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...groups.map(g => `| ${g.site} | ${g.device} | ${g.result} | ${g.completedPages}/${g.expectedPages ?? '未知'} | ${g.clickedActions}/${g.discoveredActions} | ${g.physicalClicks} | ${g.interactionOnlyActions} | ${g.excludedActions} | ${g.unverifiedActions} |`), '',
    '每個使用者操作間隔至少 3 秒。手機為 Chromium 觸控模擬；不登入、不實際撥號、不送出正式詢問。互動限定項目已實際點擊，但不代表後端送件／外部 App 全流程通過。', '',
    '修正順序：P1 優先處理網站主要錯誤並補齊測試證據 → P2 圖片／版面等問題 → P3 背景警告。待判讀的互動失敗不得直接歸因於網站。', '',
    ...[['website','網站錯誤'],['needs_review','互動失敗待判讀'],['qa_coverage','QA 覆蓋或執行問題']].flatMap(([category,label]) => {
      const rows = summary.errors.filter(e => e.category === category);
      return [`## ${label}（${rows.length} 筆）`, ...rows.slice(0, 100).map(e => `- ${e.priority}／${e.severityZh}｜${e.site}／${e.device}：${e.code} — ${e.pageUrl} — ${e.resourceUrl || ''} — ${e.message.replace(/\n/g, ' ').slice(0, 400)}；中文原因：${e.causeZh}`), ''];
    }),
    `## QA_WARNING（${warnings.length} 筆，與故障分開）`, ...summary.warnings.slice(0, 80).map(e => `- ${e.site}／${e.device}：${e.code} — ${e.pageUrl} — ${e.resourceUrl || ''} — ${e.message.replace(/\n/g, ' ').slice(0, 300)}；中文原因：${e.causeZh}`), '',
    summary.runUrl ? `[GitHub Actions 完整結果](${summary.runUrl})` : '',
    '完整逐頁／逐次點擊資料請見附件 qa-results、click-audit.txt、qa-errors.txt、qa-warnings.txt、coverage-summary.json。'
  ].join('\n');
  writeFileSync(join(outputDir, 'daily-report.md'), markdown);
  return { summary, markdown };
}
