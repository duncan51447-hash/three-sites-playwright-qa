import { Page, Locator, CDPSession } from '@playwright/test';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { publicUrl, STEP_DELAY_MS } from './config.mjs';

export type Finding = { code: string; message: string; pageUrl: string; resourceUrl?: string; observedUrl?: string; severity: string; occurrences?: number };
export type Target = { key: string; path: string; href: string; tag: string; type: string; label: string; disabled: boolean; occurrence?: number };
type Revealer = { target: Target; kind: 'click' | 'hover' };
type Work = { target: Target; revealers: Revealer[] };
export type Action = {
  key: string; selector: string; label: string; href: string;
  status: 'pending' | 'running' | 'clicked' | 'interaction_only' | 'failed' | 'excluded';
  reason?: string; clicks: number; startedAt?: string; finishedAt?: string;
  setupClicks?: number;
  destination?: string; evidence?: string;
};
export type PageResult = {
  schemaVersion: number; site: string; siteKey: string; device: string; url: string;
  status: string; complete: boolean; startedAt: string; finishedAt?: string;
  stepDelayMs: number; actions: Action[]; physicalClicks: number;
  findings: Finding[]; warnings: Finding[]; discoveredUrls: string[];
  scopeLimitations: string[]; title?: string; httpStatus?: number; currentAction?: string;
  commit?: string;
  engineVersion?: string;
  scroll?: { step: number; y: number; height: number; total: number };
  cachedAssetResponses?: number;
};

export function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${path}.tmp`, path);
}
export class Pacer {
  private last = 0;
  constructor(public readonly delay = STEP_DELAY_MS) {}
  async step<T>(operation: () => Promise<T>): Promise<T> {
    const wait = this.delay - (Date.now() - this.last);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    try { return await operation(); } finally { this.last = Date.now(); }
  }
}

const selector = 'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[aria-expanded],summary,[onclick],[tabindex]:not([tabindex="-1"]),.av-submenu-indicator,.av-click-to-play-overlay,.kksr-star,video,iframe[src]';

export async function discover(page: Page): Promise<Target[]> {
  return page.locator(selector).evaluateAll(elements => {
    const text = (s: string | null | undefined) => (s || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    const path = (element: Element) => {
      const parts: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        const siblings = node.parentElement ? [...node.parentElement.children].filter(e => e.tagName === node!.tagName) : [node];
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
      }
      return parts.join(' > ');
    };
    const result: Target[] = [];
    const counts = new Map<string,number>();
    for (const element of elements as HTMLElement[]) {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height || element.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
      if (box.right <= 0 || box.left >= innerWidth) continue;
      let visible = true;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || style.pointerEvents === 'none') { visible = false; break; }
        if (ancestor !== element && /hidden|clip/.test(style.overflowX + style.overflowY)) {
          const clip = ancestor.getBoundingClientRect();
          if (box.right <= clip.left || box.left >= clip.right || box.bottom <= clip.top || box.top >= clip.bottom) { visible = false; break; }
        }
      }
      if (!visible) continue;
      if (!element.matches('a,button,input,textarea,select,summary,video,.av-submenu-indicator,.kksr-star') && element.closest('a,button') !== null) continue;
      const tag = element.tagName.toLowerCase();
      const href = element instanceof HTMLAnchorElement ? element.href : element instanceof HTMLIFrameElement ? element.src : '';
      const type = text(element.getAttribute('type')).toLowerCase();
      const aria = text(element.getAttribute('aria-label'));
      const name = text(element.getAttribute('name'));
      const label = text(aria || element.getAttribute('title') || (element as HTMLInputElement).placeholder || (element as HTMLInputElement).value || element.innerText || element.textContent || element.querySelector('img')?.alt || href || tag);
      const css = path(element);
      const fingerprint = JSON.stringify([tag, href, type, aria, name, label]);
      const occurrence = counts.get(fingerprint) || 0;
      counts.set(fingerprint, occurrence + 1);
      result.push({ key: JSON.stringify([css, href, type, aria, name]), path: css, href, tag, type, label,
        occurrence,
        disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' });
    }
    return result;
  });
}

const sameDocument = (a: string, b: string) => {
  try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search; } catch { return false; }
};
const loginUrl = (url: string) => /\/(?:wbadmin|wp-admin|wp-login\.php|login|sign-?in)(?:[/?#]|$)/i.test(url);
class BrowserVerificationBlocked extends Error {}

async function locateTarget(page: Page, target: Target) {
  const matches = (element: Element, expected: Target) => {
    const text = (s: string | null | undefined) => (s || '').trim().replace(/\s+/g, ' ').slice(0,160);
    const href = element instanceof HTMLAnchorElement ? element.href : element instanceof HTMLIFrameElement ? element.src : '';
    const canonical = (value: string) => {
      try { const u = new URL(value); return `${u.protocol}//${u.hostname.replace(/^www\./,'')}${u.port ? ':' + u.port : ''}${u.pathname.replace(/\/$/,'')}${u.search}${u.hash}`; } catch { return value; }
    };
    const label = text(element.getAttribute('aria-label') || element.getAttribute('title') || (element as HTMLInputElement).placeholder || (element as HTMLInputElement).value || (element as HTMLElement).innerText || element.textContent || element.querySelector('img')?.alt || href || element.tagName.toLowerCase());
    return element.tagName.toLowerCase() === expected.tag && text(element.getAttribute('type')).toLowerCase() === expected.type && canonical(href) === canonical(expected.href) && label === expected.label;
  };
  const direct = page.locator(target.path).first();
  if (await direct.count() && await direct.evaluate(matches, target).catch(() => false)) return direct;
  const candidates = page.locator(selector);
  const count = await candidates.count();
  const matching: number[] = [];
  for (let index = 0; index < count; index++) {
    const candidate = candidates.nth(index);
    if (await candidate.evaluate(matches,target).catch(() => false) && await candidate.isVisible()) matching.push(index);
  }
  const selected = matching.length === 1 ? matching[0] : matching[target.occurrence || 0];
  return selected === undefined ? direct : candidates.nth(selected);
}

export async function auditPage(page: Page, result: PageResult, outputPath: string, options: { delay?: number; screenshotDirectory?: string } = {}) {
  const pace = new Pacer(options.delay ?? STEP_DELAY_MS);
  const mobile = result.device.includes('mobile');
  const source = result.url;
  const context = page.context();
  const work: Work[] = [];
  const known = new Set<string>();
  const seenFindings = new Map<string, Finding>();
  const mainResponses = new Map<string, number>();
  let navigationResponses = 0;
  const assets = new Map<string, { body: Buffer; headers: Record<string,string>; expires: number }>();
  let cachedBytes = 0;
  const assetKey = (request: any) => JSON.stringify([request.url(), request.headers().origin || '', request.headers().accept || '']);
  let active: Action | undefined;
  let performingSetup = false;
  let intentionalCleanup = false;
  let hovered = false;
  let cdp: CDPSession | undefined;
  let screenshots = 0;
  const extraSessions: CDPSession[] = [];
  const save = () => atomicJson(outputPath, result);
  const add = (warning: boolean, code: string, message: string, resourceUrl?: string, observedUrl?: string) => {
    let identity = resourceUrl;
    if (warning && resourceUrl) {
      try { const u = new URL(resourceUrl); identity = `${u.origin}${u.pathname}${u.searchParams.has('k') ? '?k=' + u.searchParams.get('k') : ''}`; } catch {}
    }
    const key = JSON.stringify([warning, code, message, identity]);
    const existing = seenFindings.get(key);
    if (existing) { existing.occurrences = (existing.occurrences || 1) + 1; save(); return; }
    const finding = { code, message, resourceUrl, observedUrl, pageUrl: source, severity: warning ? 'low' : /BROKEN_IMAGE|HORIZONTAL_OVERFLOW/.test(code) ? 'medium' : 'high', occurrences: 1 };
    seenFindings.set(key, finding);
    (warning ? result.warnings : result.findings).push(finding);
    console.log(`${warning ? 'QA_WARNING' : 'QA_ERROR'} | ${code} | ${source} | ${resourceUrl || ''} | ${message.replace(/\n/g, ' ').slice(0, 600)}`);
    save();
  };
  const localResource = (url: string) => {
    try { return new URL(url).hostname.replace(/^www\./, '') === new URL(source).hostname.replace(/^www\./, ''); } catch { return false; }
  };
  const observe = (observedPage: Page) => {
    observedPage.on('console', message => {
      const text = message.text();
      if (/requestStorageAccess.*Permission denied/i.test(text)) add(true, 'STORAGE_ACCESS', text, message.location().url, observedPage.url());
      else if (/\[report\s+only\]|report[ -]+only.*Content Security Policy|Content Security Policy.*report[ -]+only/i.test(text)) add(true, 'CSP_REPORT_ONLY', text, message.location().url, observedPage.url());
      else if (/compute-pressure.*not allowed|permissions policy.*compute-pressure/i.test(text)) add(true, 'PERMISSIONS_POLICY', text, message.location().url, observedPage.url());
      else if (message.type() === 'error' && !/Failed to load resource|net::ERR_ABORTED|third-party cookie/i.test(text)) add(!localResource(observedPage.url()), 'CONSOLE_ERROR', text, message.location().url, observedPage.url());
    });
    observedPage.on('pageerror', error => add(!localResource(observedPage.url()), 'PAGE_ERROR', error.message, error.stack?.split('\n')[1]?.trim(), observedPage.url()));
    observedPage.on('dialog', dialog => { add(true, 'BROWSER_DIALOG', dialog.message(), undefined, observedPage.url()); void dialog.dismiss(); });
    observedPage.on('filechooser', chooser => {
      if (active) { active.status = 'interaction_only'; active.evidence = 'File picker opened by real click; no file uploaded'; save(); }
      void chooser.setFiles([]);
    });
  };
  const observeHandoffs = async (observedPage: Page) => {
    const session = await context.newCDPSession(observedPage);
    session.on('Page.frameRequestedNavigation', event => {
      if (active && !performingSetup && /(?:m\.me|messenger\.com|line\.me|lin\.ee|wa\.me)|^(?:tel|mailto|sms|intent|line|fb-messenger|whatsapp|skype|tg|viber|facetime):/i.test(active.href) && /^(?:tel|mailto|sms|intent|line|fb-messenger|whatsapp|skype|tg|viber|facetime):/i.test(event.url)) {
        active.status = 'interaction_only'; active.destination = event.url;
        active.evidence = `External app handoff observed: ${event.url}`; save();
      }
    });
    await session.send('Page.enable');
    extraSessions.push(session);
    return session;
  };
  const onNewPage = (opened: Page) => { observe(opened); void observeHandoffs(opened).catch(() => {}); };
  const onResponse = (response: any) => {
    // Routing disables Chromium's HTTP cache. Reuse only live bytes fetched
    // during this page audit and explicitly cacheable under server headers.
    // HTML, APIs, POSTs, errors and private/no-cache responses are never cached.
    const request = response.request();
    if (response.status() === 200 && ['script','stylesheet','image','font'].includes(request.resourceType())) {
      const headers = response.headers(), key = assetKey(request);
      const control = headers['cache-control'] || '';
      const ttl = Number(control.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1] || 0) - Number(headers.age || 0);
      if (ttl > 0 && !/no-store|no-cache|private/i.test(control) && !/cookie|\*/i.test(headers.vary || '') && !assets.has(key)) {
        void response.body().then((body: Buffer) => {
          if (body.length > 4 * 1024 * 1024 || assets.has(key)) return;
          while (cachedBytes + body.length > 48 * 1024 * 1024 && assets.size) {
            const first = assets.keys().next().value!;
            cachedBytes -= assets.get(first)!.body.length; assets.delete(first);
          }
          const cachedHeaders = { ...headers };
          delete cachedHeaders['content-encoding']; delete cachedHeaders['content-length'];
          assets.set(key, { body, headers: cachedHeaders, expires: Date.now() + ttl * 1000 }); cachedBytes += body.length;
        }).catch(() => {});
      }
    }
    try { if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) { mainResponses.set(response.url(), response.status()); navigationResponses++; } } catch {}
    if (response.status() < 400) return;
    let observedUrl: string | undefined;
    try { observedUrl = response.request().frame().url(); } catch {}
    add(!localResource(response.url()), `HTTP_${response.status()}_RESOURCE`, `HTTP ${response.status()}; ${response.request().resourceType()}`, response.url(), observedUrl);
  };
  const onFailed = (request: any) => {
    const message = request.failure()?.errorText || 'unknown failure';
    if (intentionalCleanup || /net::ERR_ABORTED|net::ERR_BLOCKED_BY_CLIENT/i.test(message)) return;
    add(!localResource(request.url()), 'REQUEST_FAILED', message, request.url());
  };
  observe(page);
  context.on('page', onNewPage);
  context.on('response', onResponse);
  context.on('requestfailed', onFailed);
  await context.exposeBinding('__qaHandoff', (_event, href: string) => {
    if (active && !performingSetup && (href === active.href || href.startsWith('FORM '))) { active.evidence = `Trusted browser action observed; outgoing handoff/submission prevented: ${href}`; active.status = 'interaction_only'; save(); }
  });
  // Browser instrumentation preserves the trusted click but prevents a real
  // telephone/mail application from being launched. Website source is untouched.
  await context.addInitScript(() => {
    document.addEventListener('click', event => {
      const element = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (element instanceof HTMLAnchorElement && /^(?:tel|mailto|sms):/i.test(element.href)) {
        event.preventDefault(); event.stopImmediatePropagation();
        void (window as any).__qaHandoff(element.href);
      }
    }, true);
    document.addEventListener('submit', event => {
      const form = event.target;
      if (form instanceof HTMLFormElement && (form.method.toLowerCase() !== 'get' || form.closest('.wpcf7'))) {
        event.preventDefault(); event.stopImmediatePropagation();
        void (window as any).__qaHandoff(`FORM ${form.method.toUpperCase()} ${form.action}`);
      }
    }, true);
  });
  const guard = async (route: any) => {
    const request = route.request(), url = request.url();
    let u: URL;
    try { u = new URL(url); } catch { return route.continue(); }
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method());
    const permittedTelemetry = /(?:^|\.)(?:google\.com|googleapis\.com|gstatic\.com|google-analytics\.com|googletagmanager\.com|doubleclick\.net|youtube\.com|tiktok\.com|tiktokw\.us|facebook\.com)$/.test(u.hostname);
    const cacheHandshake = localResource(url) && /\/wp-content\/plugins\/litespeed-cache\/guest\.vary\.php$/.test(u.pathname);
    if (loginUrl(url) || (mutating && !permittedTelemetry && !cacheHandshake) || /[?&](?:action|rating|vote|logout|add-to-cart)=/i.test(url)) {
      if (active && !performingSetup && (localResource(url) || request.isNavigationRequest())) { active.status = 'interaction_only'; active.evidence = `Outgoing request blocked: ${request.method()} ${url}`; save(); }
      add(true, 'SIDE_EFFECT_BLOCKED', `${request.method()} prevented by read-only QA`, url);
      return route.abort('blockedbyclient');
    }
    if (request.method() === 'GET' && ['script','stylesheet','image','font'].includes(request.resourceType())) {
      const key = assetKey(request), cached = assets.get(key);
      if (cached && cached.expires > Date.now()) {
        result.cachedAssetResponses = (result.cachedAssetResponses || 0) + 1;
        return route.fulfill({ status: 200, headers: cached.headers, body: cached.body });
      }
      if (cached) { cachedBytes -= cached.body.length; assets.delete(key); }
    }
    return route.continue();
  };
  await context.route('**/*', guard);
  const primarySession = await observeHandoffs(page);
  if (mobile) cdp = primarySession;
  const navigate = async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await pace.step(() => page.goto(source, { waitUntil: 'domcontentloaded', timeout: 30000 }));
        await assertPublicContent(page);
        return response;
      }
      catch (error) {
        if (error instanceof BrowserVerificationBlocked) throw error;
        lastError = error;
        const usable = await page.evaluate(() => document.readyState !== 'loading' && !!document.body?.innerText.trim()).catch(() => false);
        if (usable) await assertPublicContent(page);
        const status = mainResponses.get(page.url());
        if (sameDocument(page.url(), source) && usable && status && status < 400) {
          add(true, 'LOAD_EVENT_TIMEOUT', 'Document rendered; load-event wait timed out. All browser interactions still tested.', source);
          return { status: () => status };
        }
        if (page.isClosed()) break;
      }
    }
    throw lastError;
  };
  const scrollControl = async (control: Locator) => {
    const box = await control.boundingBox(), viewport = page.viewportSize();
    if (box && viewport && box.y >= 80 && box.y + box.height <= viewport.height - 70) return;
    await pace.step(() => control.scrollIntoViewIfNeeded({ timeout: 5000 }));
  };
  const click = async (control: Locator, background = false, belongsToActive = true) => {
    await scrollControl(control);
    await control.click({ trial: true, timeout: 4000 });
    const previousSetup = performingSetup;
    performingSetup = !belongsToActive;
    try { await pace.step(() => mobile && !background ? control.tap({ timeout: 6000 }) : control.click({ timeout: 6000, modifiers: background ? ['Control'] : [], noWaitAfter: true })); }
    finally { performingSetup = previousSetup; }
    result.physicalClicks++;
    if (active) { if (belongsToActive) active.clicks++; else active.setupClicks = (active.setupClicks || 0) + 1; }
    save();
  };
  const reset = async () => {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await assertPublicContent(page);
    intentionalCleanup = true;
    for (const opened of context.pages()) if (opened !== page) await opened.close().catch(() => {});
    intentionalCleanup = false;
    if (!sameDocument(page.url(), source)) await pace.step(() => page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 })).catch(() => null);
    if (!sameDocument(page.url(), source)) await navigate();
    for (const value of ['.mfp-wrap .mfp-close', '.avia-popup .mfp-close', '[role="dialog"] button[aria-label*="Close"]', '.av-burger-overlay-active .av-burger-menu-main a', '.av-burger-overlay .av-burger-overlay-close', '#speak-box-close']) {
      const close = page.locator(value).first();
      if (await close.isVisible().catch(() => false)) await click(close, false, false).catch(() => {});
    }
    if (await page.locator('.mfp-wrap:visible,[role="dialog"]:visible').count()) await pace.step(() => page.keyboard.press('Escape'));
    if (hovered) { await pace.step(() => page.mouse.move(1, 1)); hovered = false; }
    if (!sameDocument(page.url(), source)) await navigate();
  };
  const settledDiscovery = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return sameDocument(source,page.url()) ? await discover(page) : []; }
      catch (error) {
        if (!/Execution context was destroyed|frame was detached|Cannot find context/i.test(String(error)) || attempt) throw error;
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      }
    }
    return [];
  };
  const enqueue = (targets: Target[], revealers: Revealer[]) => {
    for (const target of targets) {
      if (known.has(target.key)) continue;
      known.add(target.key);
      const internal = target.tag === 'a' ? publicUrl(target.href, source) : null;
      if (target.href && internal && !result.discoveredUrls.includes(internal)) result.discoveredUrls.push(internal);
      const reason = target.disabled ? 'disabled control' : loginUrl(target.href) || target.type === 'password' ? 'authentication excluded by user' : /captcha|驗證.*人類/i.test(target.label) ? 'third-party CAPTCHA challenge' : '';
      result.actions.push({ key: target.key, selector: target.path, label: target.label, href: target.href, status: reason ? 'excluded' : 'pending', clicks: 0, ...(reason ? { reason } : {}) });
      if (!reason) work.push({ target, revealers });
    }
    save();
  };
  const captureFailure = async (name: string, observedPage = page) => {
    if (!options.screenshotDirectory || observedPage.isClosed() || screenshots >= 2) return;
    screenshots++;
    mkdirSync(options.screenshotDirectory, { recursive: true });
    await observedPage.screenshot({ path: `${options.screenshotDirectory}/${name}.jpg`, type: 'jpeg', quality: 65, timeout: 5000 }).catch(() => {});
  };
  const assertPublicContent = async (observedPage: Page) => {
    if (observedPage.isClosed() || !localResource(observedPage.url())) return;
    const document = await observedPage.locator('body').evaluate(body => ({ title: body.ownerDocument.title, text: (body as HTMLElement).innerText.trim().replace(/\s+/g, ' ') }));
    if (observedPage === page && sameDocument(source, observedPage.url())) result.title = document.title;
    const verificationTitle = /^(?:one moment,?\s*(?:please)?|just a moment|checking your browser)[.!…\s]*$/i.test(document.title);
    const verificationText = /please wait while your request is being verified|verify (?:that )?you are human|checking your browser/i.test(document.text);
    if (!verificationTitle || !verificationText || document.text.length > 2000) return;
    const message = `${document.title} | ${document.text.slice(0, 300)} | Public content unavailable to this test browser; verification was not bypassed or retried`;
    result.complete = false;
    result.scopeLimitations.push(message);
    add(false, 'BROWSER_VERIFICATION_BLOCKED', message, observedPage.url(), observedPage.url());
    await captureFailure('browser-verification-blocked', observedPage);
    throw new BrowserVerificationBlocked(message);
  };
  save();
  try {
    const response = await navigate();
    result.httpStatus = response?.status();
    result.title = await page.title();
    if (!response || response.status() >= 400) {
      add(false, `PAGE_HTTP_${response?.status() || 'NO_RESPONSE'}`, 'Public page did not return a usable response', source);
      await captureFailure('page-http-error'); return;
    }
    if (!result.title.trim()) add(false, 'EMPTY_TITLE', 'Page title is empty', source);
    await page.locator('body').waitFor({ state: 'visible', timeout: 10000 });
    await assertPublicContent(page);
    enqueue(await discover(page), []);
    await reset();
    let reachedBottom = false;
    let stagnantScrolls = 0;
    for (let index = 0; index < 150; index++) {
      const d = await page.evaluate(() => ({ y: scrollY, height: innerHeight, total: document.documentElement.scrollHeight, width: innerWidth }));
      result.scroll = { step: index, y: d.y, height: d.height, total: d.total }; save();
      if (d.y + d.height >= d.total - 12) { reachedBottom = true; break; }
      await pace.step(async () => {
        if (cdp) {
          // Dispatch a bounded touch drag. synthesizeScrollGesture can wait
          // indefinitely for a compositor acknowledgement when an iframe exists.
          const x = 8, start = Math.round(d.height * .78), distance = Math.round(d.height * .58);
          try {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start, id: 1 }] });
            for (let move = 1; move <= 8; move++) {
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(start - distance * move / 8), id: 1 }] });
              await page.waitForTimeout(25);
            }
          } finally { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch(() => {}); }
        }
        else { await page.mouse.move(8, Math.round(d.height * .65)); await page.mouse.wheel(0, Math.round(d.height * .78)); }
      });
      await page.waitForTimeout(250);
      const nextY = await page.evaluate(() => scrollY);
      stagnantScrolls = Math.abs(nextY - d.y) < 2 ? stagnantScrolls + 1 : 0;
      if (stagnantScrolls >= 2) {
        // Touch gestures over embedded content may be consumed by the frame.
        // A real keyboard page-down moves the parent page without DOM rewriting.
        await pace.step(() => page.keyboard.press('PageDown'));
        await page.waitForTimeout(250);
        if (await page.evaluate(() => scrollY) <= d.y + 2) {
          add(false, 'SCROLL_BLOCKED', 'Touch/wheel and keyboard scrolling could not move the public page', source);
          break;
        }
        stagnantScrolls = 0;
      }
      enqueue(await discover(page), []);
    }
    if (!reachedBottom) add(false, 'SCROLL_INCOMPLETE', 'Page did not reach the bottom within 150 visitor scrolls', source);
    const broken = await page.locator('img:visible').evaluateAll(images => images.filter(img => (img as HTMLImageElement).complete && !(img as HTMLImageElement).naturalWidth).map(img => (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src));
    for (const url of broken) add(false, 'BROKEN_IMAGE', 'Visible image failed to render', url);
    if (!result.actions.length) add(false, 'NO_CLICKABLE_CONTROLS', 'No public controls discovered after rendering and scrolling', source);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 3)) add(false, 'HORIZONTAL_OVERFLOW', 'Content exceeds viewport width', source);
    await pace.step(() => page.keyboard.press('Home'));
    for (let index = 0; index < work.length; index++) {
      const { target, revealers } = work[index];
      active = result.actions.find(action => action.key === target.key)!;
      active.status = 'running'; active.startedAt = new Date().toISOString();
      result.currentAction = target.label; save();
      console.log(`QA_ACTION | ${result.siteKey} | ${result.device} | ${source} | ${index + 1}/${work.length} | ${target.label}`);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await reset();
          // Reloading #toggle-id-N makes Enfold reopen that accordion on startup.
          // Replay always navigates to the original fragment-free source URL.
          if (attempt || revealers.length) await navigate();
          enqueue(await settledDiscovery(), []);
          for (const revealer of revealers) {
            const control = await locateTarget(page, revealer.target);
            if (revealer.kind === 'hover') { await pace.step(() => control.hover({ timeout: 4000 })); hovered = true; }
            else await click(control, false, false);
          }
          const control = await locateTarget(page, target);
          await control.waitFor({ state: 'visible', timeout: 4000 });
          // Closing a dialog can remove its button; inspect form membership first.
          const isSubmitControl = target.type === 'submit' || (target.tag === 'button' && await control.evaluate(e => !!e.closest('form')));
          if (!mobile && await control.evaluate(e => !!e.closest('nav,.menu,.avia-menu'))) {
            await scrollControl(control);
            await pace.step(() => control.hover({ timeout: 4000 })); hovered = true;
            await page.waitForTimeout(350);
            enqueue(await discover(page), [...revealers, { target, kind: 'hover' }]);
          }
          const before = page.url(), pagesBefore = new Set(context.pages());
          const navigationBefore = navigationResponses;
          const uiHint = await control.evaluate(element => element.hasAttribute('aria-expanded') || !!element.closest('.menu-item-search,.av-burger-menu-main,.togglecontainer,.av-image-lightbox') || /[?&]s=(?:$|&)/.test((element as HTMLAnchorElement).href || '') || /\.(?:jpe?g|png|gif|webp|avif)(?:\?|$)/i.test((element as HTMLAnchorElement).href || ''));
          const isLink = target.tag === 'a' && /^https?:/i.test(target.href) && !uiHint;
          const beforeKeys = new Set((await settledDiscovery()).map(item => item.key));
          await click(control, isLink && !mobile && !sameDocument(before, target.href));
          await page.waitForTimeout(options.delay === 0 ? 100 : STEP_DELAY_MS);
          let opened = context.pages().filter(candidate => !pagesBefore.has(candidate));
          const modal = async () => !!await page.locator('.mfp-wrap:visible,[role="dialog"]:visible').count();
          let revealed = await settledDiscovery();
          let uiChanged = revealed.some(item => !beforeKeys.has(item.key));
          if (isLink && !opened.length && !sameDocument(before,target.href) && sameDocument(before,page.url()) && navigationResponses === navigationBefore && !uiChanged && active.status !== 'interaction_only' && !/(?:m\.me|messenger\.com|line\.me|lin\.ee|wa\.me)/i.test(target.href)) {
            await page.waitForURL(url => !sameDocument(before,url.href), { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => {});
            opened = context.pages().filter(candidate => !pagesBefore.has(candidate));
          }
          if (!sameDocument(before,page.url())) await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
          await assertPublicContent(page);
          revealed = await settledDiscovery();
          uiChanged = revealed.some(item => !beforeKeys.has(item.key));
          if (isLink && !mobile && !opened.length && sameDocument(before, page.url()) && !sameDocument(before, target.href) && navigationResponses === navigationBefore && !await modal() && !uiChanged) {
            await click(control); await page.waitForTimeout(options.delay === 0 ? 100 : STEP_DELAY_MS);
            await assertPublicContent(page);
            opened = context.pages().filter(candidate => !pagesBefore.has(candidate));
            revealed = await settledDiscovery();
            uiChanged = revealed.some(item => !beforeKeys.has(item.key));
          }
          for (const popup of opened) {
            await popup.waitForURL(url => url.href !== 'about:blank', { timeout: 12000 }).catch(() => {});
            await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            active.destination = popup.url();
            await assertPublicContent(popup);
            if (popup.url() === 'about:blank' && active.status !== 'interaction_only') {
              if (/(?:m\.me|messenger\.com|line\.me|lin\.ee|wa\.me)/i.test(target.href)) {
                active.status = 'interaction_only'; active.evidence = 'Messaging app handoff left an empty browser tab; native app unavailable';
                add(true, 'EXTERNAL_HANDOFF_UNCONFIRMED', active.evidence, target.href);
              } else throw new Error('New tab never navigated');
            }
          }
          if (!opened.length) active.destination = page.url();
          if (target.tag === 'iframe') {
            active.destination = target.href;
            const frame = await (await control.elementHandle())?.contentFrame();
            if (frame && /(?:youtube(?:-nocookie)?\.com|vimeo\.com)/i.test(target.href)) {
              const playing = await frame.waitForFunction(() => {
                const video = document.querySelector('video');
                return video && !video.paused && video.currentTime > 0;
              }, undefined, { timeout: 8000 }).then(() => true).catch(() => false);
              if (playing) {
                active.evidence = 'Embedded video playback advanced after a trusted browser gesture';
                const pause = frame.locator('button.ytp-play-button').first();
                if (await pause.isVisible().catch(() => false)) await click(pause);
              } else {
                active.status = 'interaction_only'; active.evidence = 'Embedded player clicked; third-party playback could not be confirmed';
                add(true, 'EMBEDDED_PLAYBACK_UNCONFIRMED', active.evidence, target.href);
              }
            } else {
              active.status = 'interaction_only'; active.evidence = 'Embedded frame received a trusted pointer gesture; external service not submitted';
            }
          }
          if (isLink && !sameDocument(before, target.href) && !opened.length && sameDocument(before, page.url()) && navigationResponses === navigationBefore && active.status !== 'interaction_only' && !await modal() && !uiChanged) {
            if (/(?:m\.me|messenger\.com|line\.me|lin\.ee|wa\.me)/i.test(target.href)) {
              active.status = 'interaction_only'; active.evidence = 'Trusted messaging-link click; native app handoff unavailable in this browser';
              add(true, 'EXTERNAL_HANDOFF_UNCONFIRMED', active.evidence, target.href);
            } else throw new Error(`Click produced no navigation or dialog: ${target.href}`);
          }
          if (navigationResponses > navigationBefore && !active.evidence) active.evidence = 'Main document navigation confirmed, including redirects back to the canonical URL';
          const canReveal = !target.href || sameDocument(before,target.href) || uiHint || await modal() || (uiChanged && navigationResponses === navigationBefore);
          if (sameDocument(source, page.url()) && canReveal && active.status !== 'interaction_only') {
            revealed = revealed.filter(item => !beforeKeys.has(item.key));
            if (revealers.length >= 6 && revealed.some(item => !known.has(item.key))) add(false, 'REVEAL_DEPTH_LIMIT', `Unexplored controls after ${target.label}`, source);
            else enqueue(revealed, [...revealers, { target, kind: 'click' }]);
          } else if (sameDocument(source,page.url()) && !revealers.length) {
            enqueue(revealed, []);
          }
          if (['input', 'textarea'].includes(target.tag) && !['button','submit','reset','checkbox','radio','file','image','range','color','date','time'].includes(target.type)) {
            const value = target.type === 'email' ? 'qa@example.invalid' : target.type === 'number' ? '1' : 'QA測試';
            await pace.step(() => control.fill(value, { timeout: 4000 }));
            await pace.step(() => control.fill('', { timeout: 4000 }));
            active.evidence = 'Focused, entered a test value, then cleared the field';
          }
          if (target.tag === 'select') {
            await pace.step(() => control.press('ArrowDown')); await pace.step(() => control.press('Enter'));
            active.evidence = 'Opened and selected using keyboard';
          }
          if (isSubmitControl) {
            active.status = 'interaction_only';
            active.evidence ||= 'Submit clicked; client validation inspected; outgoing submission prevented by QA';
          }
          if (active.status === 'running') active.status = 'clicked';
          active.finishedAt = new Date().toISOString(); save(); break;
        } catch (error) {
          if (error instanceof BrowserVerificationBlocked) {
            active.status = 'failed'; active.reason = String(error); active.finishedAt = new Date().toISOString();
            throw error;
          }
          if (attempt === 0 && !page.isClosed()) continue;
          active.status = 'failed'; active.reason = String(error); active.finishedAt = new Date().toISOString();
          add(false, 'INTERACTION_FAILED', `${target.label} | ${String(error)}`, target.href || source, page.url());
          await captureFailure(`action-${index}`); save();
        } finally {
          intentionalCleanup = true;
          for (const popup of context.pages()) if (popup !== page) await popup.close().catch(() => {});
          intentionalCleanup = false;
        }
      }
      active = undefined; result.currentAction = undefined;
    }
    result.complete = reachedBottom && !result.actions.some(action => ['pending', 'running'].includes(action.status));
  } catch (error) {
    if (!(error instanceof BrowserVerificationBlocked)) {
      add(false, 'PAGE_AUDIT_INTERRUPTED', String(error), source, page.url());
      await captureFailure('interrupted');
    }
  } finally {
    result.finishedAt = new Date().toISOString();
    result.status = result.complete ? (result.findings.length ? 'failed' : 'passed') : 'incomplete'; save();
    context.off('page', onNewPage); context.off('response', onResponse); context.off('requestfailed', onFailed);
    await context.unroute('**/*', guard).catch(() => {});
    for (const session of extraSessions) await session.detach().catch(() => {});
  }
}
