import { Page, Locator, CDPSession } from '@playwright/test';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { publicUrl, STEP_DELAY_MS } from './config.mjs';

export type Finding = { code: string; message: string; pageUrl: string; resourceUrl?: string; observedUrl?: string; severity: string };
export type Target = { key: string; path: string; href: string; tag: string; type: string; label: string; disabled: boolean };
type Revealer = { target: Target; kind: 'click' | 'hover' };
type Work = { target: Target; revealers: Revealer[] };
export type Action = {
  key: string; selector: string; label: string; href: string;
  status: 'pending' | 'running' | 'clicked' | 'interaction_only' | 'failed' | 'excluded';
  reason?: string; clicks: number; startedAt?: string; finishedAt?: string;
  destination?: string; evidence?: string;
};
export type PageResult = {
  schemaVersion: number; site: string; siteKey: string; device: string; url: string;
  status: string; complete: boolean; startedAt: string; finishedAt?: string;
  stepDelayMs: number; actions: Action[]; physicalClicks: number;
  findings: Finding[]; warnings: Finding[]; discoveredUrls: string[];
  scopeLimitations: string[]; title?: string; httpStatus?: number; currentAction?: string;
  commit?: string;
  scroll?: { step: number; y: number; height: number; total: number };
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
      result.push({ key: JSON.stringify([css, href, type, aria, name]), path: css, href, tag, type, label,
        disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' });
    }
    return result;
  });
}

const sameDocument = (a: string, b: string) => {
  try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search; } catch { return false; }
};
const loginUrl = (url: string) => /\/(?:wbadmin|wp-admin|wp-login\.php|login|sign-?in)(?:[/?#]|$)/i.test(url);

export async function auditPage(page: Page, result: PageResult, outputPath: string, options: { delay?: number; screenshotDirectory?: string } = {}) {
  const pace = new Pacer(options.delay ?? STEP_DELAY_MS);
  const mobile = result.device.includes('mobile');
  const source = result.url;
  const context = page.context();
  const work: Work[] = [];
  const known = new Set<string>();
  const seenFindings = new Set<string>();
  const mainResponses = new Map<string, number>();
  let active: Action | undefined;
  let intentionalCleanup = false;
  let hovered = false;
  let cdp: CDPSession | undefined;
  const save = () => atomicJson(outputPath, result);
  const add = (warning: boolean, code: string, message: string, resourceUrl?: string, observedUrl?: string) => {
    const key = JSON.stringify([warning, code, message, resourceUrl]);
    if (seenFindings.has(key)) return;
    seenFindings.add(key);
    const finding = { code, message, resourceUrl, observedUrl, pageUrl: source, severity: warning ? 'low' : 'high' };
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
      else if (/report-only.*Content Security Policy|Content Security Policy.*report-only/i.test(text)) add(true, 'CSP_REPORT_ONLY', text, message.location().url, observedPage.url());
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
  const onNewPage = (opened: Page) => observe(opened);
  const onResponse = (response: any) => {
    try { if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) mainResponses.set(response.url(), response.status()); } catch {}
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
    if (active) { active.evidence = `Trusted browser action observed; outgoing handoff/submission prevented: ${href}`; active.status = 'interaction_only'; save(); }
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
      if (active && (localResource(url) || request.isNavigationRequest())) { active.status = 'interaction_only'; active.evidence = `Outgoing request blocked: ${request.method()} ${url}`; save(); }
      add(true, 'SIDE_EFFECT_BLOCKED', `${request.method()} prevented by read-only QA`, url);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  };
  await context.route('**/*', guard);
  const navigate = async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await pace.step(() => page.goto(source, { waitUntil: 'domcontentloaded', timeout: 30000 })); }
      catch (error) {
        lastError = error;
        const usable = await page.evaluate(() => document.readyState !== 'loading' && !!document.body?.innerText.trim()).catch(() => false);
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
  const click = async (control: Locator, background = false) => {
    await scrollControl(control);
    await control.click({ trial: true, timeout: 4000 });
    await pace.step(() => mobile && !background ? control.tap({ timeout: 6000 }) : control.click({ timeout: 6000, modifiers: background ? ['Control'] : [], noWaitAfter: true }));
    result.physicalClicks++;
    if (active) active.clicks++;
    save();
  };
  const reset = async () => {
    intentionalCleanup = true;
    for (const opened of context.pages()) if (opened !== page) await opened.close().catch(() => {});
    intentionalCleanup = false;
    if (!sameDocument(page.url(), source)) await pace.step(() => page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 })).catch(() => null);
    if (!sameDocument(page.url(), source)) await navigate();
    for (const value of ['.mfp-wrap .mfp-close', '.avia-popup .mfp-close', '[role="dialog"] button[aria-label*="Close"]', '.av-burger-overlay-active .av-burger-menu-main a', '.av-burger-overlay .av-burger-overlay-close', '#speak-box-close']) {
      const close = page.locator(value).first();
      if (await close.isVisible().catch(() => false)) await click(close).catch(() => {});
    }
    if (await page.locator('.mfp-wrap:visible,[role="dialog"]:visible').count()) await pace.step(() => page.keyboard.press('Escape'));
    if (hovered) { await pace.step(() => page.mouse.move(1, 1)); hovered = false; }
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
  const captureFailure = async (name: string) => {
    if (!options.screenshotDirectory || page.isClosed()) return;
    mkdirSync(options.screenshotDirectory, { recursive: true });
    await page.screenshot({ path: `${options.screenshotDirectory}/${name}.png`, timeout: 5000 }).catch(() => {});
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
    enqueue(await discover(page), []);
    await reset();
    if (mobile) cdp = await context.newCDPSession(page);
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
          if (attempt || revealers.length) await pace.step(() => page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }));
          for (const revealer of revealers) {
            const control = page.locator(revealer.target.path).first();
            if (revealer.kind === 'hover') { await pace.step(() => control.hover({ timeout: 4000 })); hovered = true; }
            else await click(control);
          }
          const control = page.locator(target.path).first();
          await control.waitFor({ state: 'visible', timeout: 4000 });
          if (!mobile && await control.evaluate(e => !!e.closest('nav,.menu,.avia-menu'))) {
            await scrollControl(control);
            await pace.step(() => control.hover({ timeout: 4000 })); hovered = true;
            await page.waitForTimeout(350);
            enqueue(await discover(page), [...revealers, { target, kind: 'hover' }]);
          }
          const before = page.url(), pagesBefore = new Set(context.pages());
          const isLink = target.tag === 'a' && /^https?:/i.test(target.href);
          await click(control, isLink && !mobile && !sameDocument(before, target.href));
          await page.waitForTimeout(350);
          let opened = context.pages().filter(candidate => !pagesBefore.has(candidate));
          const modal = async () => !!await page.locator('.mfp-wrap:visible,[role="dialog"]:visible').count();
          if (isLink && !mobile && !opened.length && sameDocument(before, page.url()) && !sameDocument(before, target.href) && !await modal()) {
            await click(control); await page.waitForTimeout(350);
            opened = context.pages().filter(candidate => !pagesBefore.has(candidate));
          }
          for (const popup of opened) {
            await popup.waitForURL(url => url.href !== 'about:blank', { timeout: 12000 }).catch(() => {});
            await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            active.destination = popup.url();
            if (popup.url() === 'about:blank') throw new Error('New tab never navigated');
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
          if (isLink && !sameDocument(before, target.href) && !opened.length && sameDocument(before, page.url()) && active.status !== 'interaction_only' && !await modal()) throw new Error(`Click produced no navigation or dialog: ${target.href}`);
          if (sameDocument(source, page.url()) && (!isLink || sameDocument(before, target.href) || await modal())) {
            const revealed = await discover(page);
            if (revealers.length >= 6 && revealed.some(item => !known.has(item.key))) add(false, 'REVEAL_DEPTH_LIMIT', `Unexplored controls after ${target.label}`, source);
            else enqueue(revealed, [...revealers, { target, kind: 'click' }]);
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
          if (target.type === 'submit' || (target.tag === 'button' && await control.evaluate(e => !!e.closest('form')))) {
            active.status = 'interaction_only';
            active.evidence ||= 'Submit clicked; client validation inspected; outgoing submission prevented by QA';
          }
          if (active.status === 'running') active.status = 'clicked';
          active.finishedAt = new Date().toISOString(); save(); break;
        } catch (error) {
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
    add(false, 'PAGE_AUDIT_INTERRUPTED', String(error), source, page.url());
    await captureFailure('interrupted');
  } finally {
    result.finishedAt = new Date().toISOString();
    result.status = result.complete ? (result.findings.length ? 'failed' : 'passed') : 'incomplete'; save();
    context.off('page', onNewPage); context.off('response', onResponse); context.off('requestfailed', onFailed);
    await context.unroute('**/*', guard).catch(() => {});
    await cdp?.detach().catch(() => {});
  }
}
