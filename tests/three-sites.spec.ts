import { test, expect, APIRequestContext, Page, Request, Response } from '@playwright/test';

declare const process: { env: Record<string, string | undefined> };

type ClickAudit = {
  discovered: number;
  uniqueActions: number;
  clicked: number;
  physicalClicks: number;
  equivalentCovered: number;
  excluded: string[];
  unavailable: string[];
  blocked: string[];
  warnings: string[];
};

type SitemapInventory = {
  urls: string[];
  checkedSitemaps: string[];
  warnings: string[];
};

type ClickTarget = {
  key: string;
  path: string;
  tag: string;
  type: string;
  id: string;
  href: string;
  target: string;
  role: string;
  ariaLabel: string;
  title: string;
  name: string;
  text: string;
  label: string;
  occurrence: number;
};

type QueuedClick = ClickTarget & {
  revealers: ClickTarget[];
};

type ClickCoverage = {
  discoveredActions: Set<string>;
  clickedActions: Set<string>;
  excludedActions: Set<string>;
};

const SITES = [
  { key: 'pl168', name: '龐德隆', baseUrl: 'https://www.pl168.net' },
  { key: 'jf1688', name: '宅立貸', baseUrl: 'https://jf1688.com.tw' },
  { key: 'firstloan', name: '第一貸', baseUrl: 'https://www.firstloan.tw' }
];

const decodeXml = (value: string) =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([\da-f]+);/gi, (_match, digits) => String.fromCodePoint(parseInt(digits, 16)));

function sitemapLocations(xml: string) {
  return [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
    .map((match) => decodeXml(match[1]).trim())
    .filter(Boolean);
}

function normalizePublicPageUrl(value: string, baseUrl: string) {
  try {
    const url = new URL(value, baseUrl);
    const base = new URL(baseUrl);
    if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol)) return null;
    if (/\/(?:wp-admin|wp-login\.php|wp-json)(?:\/|$)/i.test(url.pathname)) return null;
    if (/(?:\/feed\/?$|\/trackback\/?$)/i.test(url.pathname)) return null;
    if (/\.(?:jpe?g|png|gif|webp|svg|ico|pdf|zip|xml|json|mp4|webm|mp3)(?:$|\?)/i.test(url.href)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

async function browseLikeAVisitor(page: Page, url: string, errors: string[]) {
  // Exercise lazy loading, sticky headers and scroll listeners on every public
  // page. Pauses and a short back-scroll mimic a visitor without making a
  // thousand-page sitemap take all day.
  await page.waitForTimeout(350);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const viewportHeight = page.viewportSize()?.height ?? 800;
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const scrollableDistance = Math.max(0, pageHeight - viewportHeight);
      const steps = Math.min(8, Math.max(1, Math.ceil(scrollableDistance / viewportHeight)));
      const step = Math.max(280, Math.ceil(scrollableDistance / steps));

      for (let index = 0; index < steps; index++) {
        await page.mouse.wheel(0, step);
        await page.waitForTimeout(140 + (index % 3) * 55);

        if (index === 2 && steps > 4) {
          await page.mouse.wheel(0, -Math.round(viewportHeight * 0.24));
          await page.waitForTimeout(210);
        }
      }

      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
      );
      if (overflow) errors.push(`HORIZONTAL_OVERFLOW_WHILE_SCROLLING | ${url}`);

      await page.mouse.wheel(0, -Math.max(pageHeight, viewportHeight));
      await page.waitForTimeout(180);
      const returnedToTop = await page.evaluate(() => window.scrollY <= 10);
      if (!returnedToTop) errors.push(`SCROLL_RETURN_FAILED | ${url}`);
      return;
    } catch (error) {
      const navigationRace = /Execution context was destroyed|frame was detached|Cannot find context/i.test(String(error));
      if (!navigationRace || attempt === 1) throw error;
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

async function collectSitemapUrls(
  request: APIRequestContext,
  baseUrl: string
): Promise<SitemapInventory> {
  const discovered = new Set<string>();
  const visitedMaps = new Set<string>();
  const warnings: string[] = [];
  const queue = [
    new URL('/sitemap.xml', baseUrl).href,
    new URL('/sitemap_index.xml', baseUrl).href,
    new URL('/wp-sitemap.xml', baseUrl).href
  ];

  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).href;
    const robots = await request.get(robotsUrl, { timeout: 30_000 });
    if (robots.ok()) {
      const body = await robots.text();
      for (const match of body.matchAll(/^\s*sitemap:\s*(\S+)\s*$/gim)) queue.push(match[1]);
    } else {
      warnings.push(`ROBOTS_HTTP_${robots.status()} | ${robotsUrl}`);
    }
  } catch (error) {
    warnings.push(`ROBOTS_UNAVAILABLE | ${new URL('/robots.txt', baseUrl).href} | ${String(error)}`);
  }

  while (queue.length > 0) {
    const sitemapUrl = queue.shift()!;
    if (visitedMaps.has(sitemapUrl)) continue;
    visitedMaps.add(sitemapUrl);

    try {
      const response = await request.get(sitemapUrl, { timeout: 30_000 });
      if (!response.ok()) continue;
      const xml = await response.text();
      if (!/<(?:urlset|sitemapindex)\b/i.test(xml)) continue;
      const locations = sitemapLocations(xml);
      const isIndex = /<sitemapindex\b/i.test(xml);

      for (const location of locations) {
        if (isIndex || /(?:\.xml|sitemap)(?:\?|$)/i.test(location)) {
          if (!visitedMaps.has(location)) queue.push(location);
        } else {
          const url = normalizePublicPageUrl(location, baseUrl);
          if (url) discovered.add(url);
        }
      }
    } catch (error) {
      warnings.push(`SITEMAP_UNAVAILABLE | ${sitemapUrl} | ${String(error)}`);
    }
  }

  if (discovered.size === 0) discovered.add(new URL('/', baseUrl).href);
  return {
    urls: [...discovered].sort(),
    checkedSitemaps: [...visitedMaps],
    warnings
  };
}

const CLICKABLE_SELECTOR = [
  'a[href]',
  'button',
  'input[type="button"]',
  'input[type="reset"]',
  'input[type="submit"]',
  '[role="button"]',
  '[role="link"]',
  '[aria-expanded]',
  'summary',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

async function discoverVisibleClickTargets(page: Page): Promise<ClickTarget[]> {
  return page.locator(CLICKABLE_SELECTOR).evaluateAll((elements) => {
    const normalize = (value: string | null | undefined) =>
      (value || '').trim().replace(/\s+/g, ' ').slice(0, 180);

    const cssPath = (element: Element) => {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.documentElement) {
        const tag = current.tagName.toLowerCase();
        if ((current as HTMLElement).id) {
          parts.unshift(`#${CSS.escape((current as HTMLElement).id)}`);
          return parts.join(' > ');
        }
        const parent: Element | null = current.parentElement;
        if (!parent) break;
        const siblings = [...parent.children].filter((sibling) => sibling.tagName === current!.tagName);
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
        current = parent;
      }
      parts.unshift('html');
      return parts.join(' > ');
    };

    const occurrences = new Map<string, number>();
    const results: ClickTarget[] = [];
    for (const element of elements as HTMLElement[]) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const hiddenAncestor = element.closest('[hidden], [aria-hidden="true"], [inert]');
      const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
        style.pointerEvents !== 'none' && Number(style.opacity) !== 0 &&
        rect.width > 0 && rect.height > 0 && !hiddenAncestor;
      if (!visible || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') continue;

      const anchor = element instanceof HTMLAnchorElement ? element : element.closest('a');
      const text = normalize(element.innerText || element.textContent);
      const target = {
        path: cssPath(element),
        tag: element.tagName.toLowerCase(),
        type: normalize(element.getAttribute('type')).toLowerCase(),
        id: normalize(element.id),
        href: anchor?.href || '',
        target: anchor?.target || '',
        role: normalize(element.getAttribute('role')).toLowerCase(),
        ariaLabel: normalize(element.getAttribute('aria-label')),
        title: normalize(element.getAttribute('title')),
        name: normalize(element.getAttribute('name')),
        text,
        label: normalize(text || element.getAttribute('aria-label') || element.getAttribute('title') ||
          (element as HTMLInputElement).value || anchor?.href || element.tagName)
      };
      const fingerprint = JSON.stringify([
        target.tag, target.type, target.id, target.href, target.role,
        target.ariaLabel, target.title, target.name, target.text
      ]);
      const occurrence = occurrences.get(fingerprint) || 0;
      occurrences.set(fingerprint, occurrence + 1);
      results.push({
        ...target,
        occurrence,
        key: `${target.path}|${fingerprint}|${occurrence}`
      });
    }
    return results;
  });
}

async function locateClickTarget(page: Page, target: ClickTarget) {
  const byPath = page.locator(target.path).first();
  if (await byPath.count()) {
    const matches = await byPath.evaluate((element, expected) => {
      const normalize = (value: string | null | undefined) =>
        (value || '').trim().replace(/\s+/g, ' ').slice(0, 180);
      const anchor = element instanceof HTMLAnchorElement ? element : element.closest('a');
      const text = normalize((element as HTMLElement).innerText || element.textContent);
      return element.tagName.toLowerCase() === expected.tag &&
        normalize(element.getAttribute('type')).toLowerCase() === expected.type &&
        normalize((element as HTMLElement).id) === expected.id &&
        (anchor?.href || '') === expected.href &&
        normalize(element.getAttribute('role')).toLowerCase() === expected.role &&
        normalize(element.getAttribute('aria-label')) === expected.ariaLabel &&
        normalize(element.getAttribute('title')) === expected.title &&
        normalize(element.getAttribute('name')) === expected.name &&
        text === expected.text;
    }, target).catch(() => false);
    if (matches) return byPath;
  }

  const index = await page.locator(CLICKABLE_SELECTOR).evaluateAll((elements, expected) => {
    const normalize = (value: string | null | undefined) =>
      (value || '').trim().replace(/\s+/g, ' ').slice(0, 180);
    let occurrence = 0;
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index] as HTMLElement;
      const anchor = element instanceof HTMLAnchorElement ? element : element.closest('a');
      const text = normalize(element.innerText || element.textContent);
      const matches = element.tagName.toLowerCase() === expected.tag &&
        normalize(element.getAttribute('type')).toLowerCase() === expected.type &&
        normalize(element.id) === expected.id &&
        (anchor?.href || '') === expected.href &&
        normalize(element.getAttribute('role')).toLowerCase() === expected.role &&
        normalize(element.getAttribute('aria-label')) === expected.ariaLabel &&
        normalize(element.getAttribute('title')) === expected.title &&
        normalize(element.getAttribute('name')) === expected.name &&
        text === expected.text;
      if (!matches) continue;
      if (occurrence === expected.occurrence) return index;
      occurrence++;
    }
    return -1;
  }, target);

  return index >= 0 ? page.locator(CLICKABLE_SELECTOR).nth(index) : null;
}

function isSameDocument(left: string, right: string) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

function addUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

async function navigateWithRetry(page: Page, url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (response && response.status() >= 500 && attempt === 0) {
        await page.waitForTimeout(700);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (page.isClosed() || attempt === 1) throw error;
      await page.waitForTimeout(700);
    }
  }
  throw lastError;
}

function clickActionKey(target: ClickTarget, revealers: ClickTarget[]) {
  return JSON.stringify([
    ...revealers.map((revealer) => revealer.path),
    target.path,
    target.tag,
    target.type,
    target.href,
    target.role,
    target.ariaLabel,
    target.title,
    target.name,
    target.text,
    target.occurrence
  ]);
}

function clickSafetyReason(target: ClickTarget) {
  if (/^(?:tel|mailto|sms):/i.test(target.href)) return 'external protocol';
  if (/(?:line\.me|lin\.ee|m\.me|messenger\.com|wa\.me)/i.test(target.href)) {
    return 'external messaging action';
  }
  if (target.type === 'submit') return 'form submission';
  if (/驗證.*人類|captcha/i.test(target.label)) return 'CAPTCHA';
  if (!target.href && /送出|提交|立即申請|免費申請|預約|付款|購買|刪除|移除|submit|send|apply|delete|remove|pay|checkout/i.test(target.label)) {
    return 'potential side effect';
  }
  return '';
}

function recordClickNavigationFindings(
  pageUrl: string,
  description: string,
  failures: { status?: number; resourceUrl: string; failure?: string }[],
  errors: string[],
  audit: ClickAudit
) {
  for (const failure of failures) {
    let sameSite = false;
    try {
      sameSite = new URL(failure.resourceUrl).origin === new URL(pageUrl).origin;
    } catch {}

    const code = failure.status ? `CLICK_TARGET_HTTP_${failure.status}` : 'CLICK_TARGET_REQUEST_FAILED';
    const detail = failure.failure ? ` | ${failure.failure}` : '';
    const finding = `${code} | ${pageUrl} | ${description} | ${failure.resourceUrl}${detail}`;
    if (sameSite) errors.push(finding);
    else addUnique(audit.warnings, finding);
  }
}

async function auditClickableElements(
  page: Page,
  url: string,
  errors: string[],
  audit: ClickAudit,
  coverage: ClickCoverage,
  useBackgroundTabs: boolean,
  onInternalUrl: (url: string) => void
) {
  // Stable fingerprints reacquire controls without injecting test attributes into
  // the website. Repeated header/footer controls are clicked once per structural
  // location and device; page-specific links remain unique because href is in the key.
  const known = new Set<string>();
  const queue: QueuedClick[] = [];

  const enqueue = (targets: ClickTarget[], revealers: ClickTarget[]) => {
    for (const target of targets) {
      if (known.has(target.key)) continue;
      known.add(target.key);
      audit.discovered++;
      queue.push({ ...target, revealers });
    }
  };

  enqueue(await discoverVisibleClickTargets(page), []);

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const item = queue[cursor];
    const description = item.label || `${item.tag}-${cursor + 1}`;
    const actionKey = clickActionKey(item, item.revealers);
    const firstDiscovery = !coverage.discoveredActions.has(actionKey);
    if (firstDiscovery) {
      coverage.discoveredActions.add(actionKey);
      audit.uniqueActions++;
    }

    const internalUrl = item.href ? normalizePublicPageUrl(item.href, url) : null;
    if (internalUrl) onInternalUrl(internalUrl);

    const safetyReason = clickSafetyReason(item);
    if (safetyReason) {
      if (!coverage.excludedActions.has(actionKey)) {
        coverage.excludedActions.add(actionKey);
        audit.excluded.push(`${url} | ${description} | ${item.href || item.type || safetyReason} | ${safetyReason}`);
      }
      continue;
    }

    if (coverage.clickedActions.has(actionKey)) {
      audit.equivalentCovered++;
      continue;
    }

    const documentFailures: { status?: number; resourceUrl: string; failure?: string }[] = [];
    const onResponse = (response: Response) => {
      // response.frame() can throw before a new popup frame exists. A document
      // response plus same-origin classification below is sufficient and race-free.
      if (response.status() >= 400 && response.request().resourceType() === 'document') {
        documentFailures.push({ status: response.status(), resourceUrl: response.url() });
      }
    };
    const onRequestFailed = (request: Request) => {
      if (request.resourceType() === 'document' && request.isNavigationRequest()) {
        documentFailures.push({
          resourceUrl: request.url(),
          failure: request.failure()?.errorText || 'unknown navigation failure'
        });
      }
    };
    page.context().on('response', onResponse);
    page.context().on('requestfailed', onRequestFailed);

    try {
      // Dynamic controls must start from a clean document so replaying their menu
      // or accordion opener cannot accidentally close an already-open panel.
      if (!isSameDocument(page.url(), url) || item.revealers.length > 0) {
        const setupResponse = await navigateWithRetry(page, url);
        if (!setupResponse || setupResponse.status() >= 400) {
          errors.push(`CLICK_SETUP_HTTP_${setupResponse?.status() || 'NO_RESPONSE'} | ${url} | ${description}`);
          continue;
        }
        await page.waitForTimeout(250);
      }

      let revealFailed = false;
      for (const revealer of item.revealers) {
        const revealerControl = await locateClickTarget(page, revealer);
        if (!revealerControl || !(await revealerControl.isVisible())) {
          const finding = `${url} | ${description} | revealer unavailable: ${revealer.label}`;
          addUnique(audit.unavailable, finding);
          addUnique(errors, `INTERACTION_UNAVAILABLE | ${finding}`);
          revealFailed = true;
          break;
        }
        await revealerControl.scrollIntoViewIfNeeded({ timeout: 5_000 });
        await revealerControl.click({ timeout: 5_000 });
        audit.physicalClicks++;
        await page.waitForTimeout(260);
      }
      if (revealFailed) continue;

      const control = await locateClickTarget(page, item);
      if (!control || !(await control.isVisible())) {
        const finding = `${url} | ${description}`;
        addUnique(audit.unavailable, finding);
        addUnique(errors, `INTERACTION_UNAVAILABLE | ${finding}`);
        continue;
      }

      await control.scrollIntoViewIfNeeded({ timeout: 5_000 });
      await page.waitForTimeout(170 + (cursor % 3) * 55);

      try {
        await control.click({ trial: true, timeout: 5_000 });
      } catch (error) {
        const finding = `${url} | ${description} | ${String(error)}`;
        addUnique(audit.blocked, finding);
        addUnique(errors, `INTERACTION_BLOCKED | ${finding}`);
        continue;
      }

      const pagesBefore = new Set(page.context().pages());
      const beforeUrl = page.url();
      const isWebLink = /^https?:/i.test(item.href);
      await control.click({
        timeout: 8_000,
        modifiers: isWebLink && useBackgroundTabs && item.target !== '_blank' ? ['Control'] : []
      });
      audit.physicalClicks++;
      audit.clicked++;
      coverage.clickedActions.add(actionKey);
      await page.waitForTimeout(550);

      let openedPages = page.context().pages().filter((candidate) => !pagesBefore.has(candidate));
      let stayedOnSource = isSameDocument(beforeUrl, page.url());

      // Some JavaScript link handlers ignore Ctrl-click. Fall back to an ordinary
      // human click so a successful click is never inferred solely from href text.
      if (isWebLink && useBackgroundTabs && openedPages.length === 0 && stayedOnSource &&
          !isSameDocument(beforeUrl, item.href)) {
        const fallbackControl = await locateClickTarget(page, item);
        if (!fallbackControl) throw new Error('link did not open and could not be reacquired for normal-click fallback');
        await fallbackControl.click({ timeout: 8_000 });
        audit.physicalClicks++;
        await page.waitForTimeout(550);
        openedPages = page.context().pages().filter((candidate) => !pagesBefore.has(candidate));
        stayedOnSource = isSameDocument(beforeUrl, page.url());
      }

      for (const openedPage of openedPages) {
        await openedPage.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
        await openedPage.waitForTimeout(180).catch(() => {});
        await openedPage.close().catch(() => {});
      }

      if (item.revealers.length < 2 && stayedOnSource) {
        const revealed = await discoverVisibleClickTargets(page);
        enqueue(revealed, [...item.revealers, item]);
      }

      if (!stayedOnSource) {
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
        await navigateWithRetry(page, url);
        await page.waitForTimeout(220);
      } else if (!item.href) {
        // Close modals where possible, then reload so the next initial control is
        // not influenced by the state left by this interaction.
        await page.keyboard.press('Escape').catch(() => {});
        await navigateWithRetry(page, url);
        await page.waitForTimeout(220);
      }

      recordClickNavigationFindings(url, description, documentFailures, errors, audit);
    } catch (error) {
      addUnique(errors, `INTERACTION_FAILED | ${url} | ${description} | ${String(error)}`);
      if (!page.isClosed() && !isSameDocument(page.url(), url)) {
        await navigateWithRetry(page, url).catch(() => {});
      }
    } finally {
      page.context().off('response', onResponse);
      page.context().off('requestfailed', onRequestFailed);
    }
  }
}

async function checkPage(
  page: Page,
  url: string,
  errors: string[],
  audit: ClickAudit,
  coverage: ClickCoverage,
  useBackgroundTabs: boolean,
  onInternalUrl: (url: string) => void
) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const unauthorizedResponses = new Set<string>();

  const onConsole = (message: { type(): string; text(): string }) => {
    const text = message.text();
    if (/requestStorageAccess:\s*Permission denied/i.test(text)) {
      console.warn(`QA_WARNING | ${url} | ${text}`);
      return;
    }
    if (/Failed to load resource:.*status of 401/i.test(text)) {
      console.warn(`QA_WARNING | ${url} | 401 resource detected; exact URL recorded from the response event`);
      return;
    }
    if (/Content Security Policy.*report-only|violates.*report-only Content Security Policy/i.test(text)) {
      console.warn(`QA_WARNING | ${url} | CSP_REPORT_ONLY | ${text}`);
      return;
    }
    if (message.type() === 'error' && !/favicon|third-party cookie/i.test(text)) {
      consoleErrors.push(message.text());
    }
  };
  const onPageError = (error: Error) => {
    const isJf1688NonBlockingWordPressError =
      new URL(url).hostname === 'jf1688.com.tw' &&
      /^(?:jQuery|wp) is not defined$/i.test(error.message.trim());

    if (isJf1688NonBlockingWordPressError) {
      console.warn(`QA_WARNING | ${url} | WORDPRESS_SCRIPT_ORDER | ${error.message}`);
      return;
    }

    pageErrors.push(error.message);
  };
  const onResponse = (response: { status(): number; url(): string }) => {
    if (response.status() === 401) unauthorizedResponses.add(response.url());
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  try {
    const response = await navigateWithRetry(page, url);
    if (!response) errors.push(`NO_RESPONSE | ${url}`);
    else if (response.status() >= 400) errors.push(`HTTP_${response.status()} | ${url}`);

    await expect(page.locator('body')).toBeVisible();
    const title = (await page.title()).trim();
    if (!title) errors.push(`EMPTY_TITLE | ${url}`);

    await browseLikeAVisitor(page, url, errors);

    const brokenImages = await page.locator('img:visible').evaluateAll((images) =>
      images
        .filter((image) => {
          const img = image as HTMLImageElement;
          return img.complete && img.naturalWidth === 0;
        })
        .map((image) => (image as HTMLImageElement).currentSrc || (image as HTMLImageElement).src)
    );
    for (const imageUrl of brokenImages) errors.push(`BROKEN_IMAGE | ${url} | ${imageUrl}`);

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
    );
    if (overflow) errors.push(`HORIZONTAL_OVERFLOW | ${url}`);

    const badInternalLinks = await page.locator('a[href]').evaluateAll((links, currentUrl) => {
      const current = new URL(currentUrl as string);
      return links
        .map((link) => (link as HTMLAnchorElement).href)
        .filter((href) => {
          try {
            const target = new URL(href);
            return target.origin === current.origin &&
              !['http:', 'https:'].includes(target.protocol);
          } catch {
            return true;
          }
        });
    }, url);
    for (const href of badInternalLinks) errors.push(`INVALID_LINK | ${url} | ${href}`);

    await auditClickableElements(
      page,
      url,
      errors,
      audit,
      coverage,
      useBackgroundTabs,
      onInternalUrl
    );

    for (const message of consoleErrors.slice(0, 10)) {
      errors.push(`CONSOLE_ERROR | ${url} | ${message}`);
    }
    for (const message of pageErrors.slice(0, 10)) {
      errors.push(`PAGE_ERROR | ${url} | ${message}`);
    }
  } catch (error) {
    errors.push(`NAVIGATION_FAILED | ${url} | ${String(error)}`);
  } finally {
    const pageOrigin = new URL(url).origin;
    for (const resourceUrl of unauthorizedResponses) {
      const finding = `HTTP_401_RESOURCE | ${url} | ${resourceUrl}`;
      try {
        if (new URL(resourceUrl).origin === pageOrigin) errors.push(finding);
        else console.warn(`QA_WARNING | ${finding}`);
      } catch {
        errors.push(finding);
      }
    }
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  }
}

const requestedSite = process.env.QA_SITE || '';
const scope = process.env.QA_SCOPE === 'full' ? 'full' : 'smoke';
const shardIndex = Number.parseInt(process.env.QA_SHARD_INDEX || '0', 10);
const shardTotal = Number.parseInt(process.env.QA_SHARD_TOTAL || '1', 10);
if (!Number.isInteger(shardIndex) || !Number.isInteger(shardTotal) ||
    shardIndex < 0 || shardTotal < 1 || shardIndex >= shardTotal) {
  throw new Error(`Invalid QA shard ${shardIndex}/${shardTotal}`);
}

const selectedSites = SITES.filter((site) => !requestedSite || site.key === requestedSite);
if (selectedSites.length === 0) throw new Error(`Unknown QA_SITE: ${requestedSite}`);

for (const site of selectedSites) {
  const shardLabel = scope === 'full' ? `（分片 ${shardIndex + 1}/${shardTotal}）` : '';
  test(`${site.name}：${scope === 'full' ? 'Sitemap 全站' : '首頁'}與互動巡檢${shardLabel}`, async ({ page, request }, testInfo) => {
    const inventory = scope === 'full'
      ? await collectSitemapUrls(request, site.baseUrl)
      : { urls: [new URL('/', site.baseUrl).href], checkedSitemaps: [], warnings: [] };
    const errors: string[] = [];
    const audit: ClickAudit = {
      discovered: 0,
      uniqueActions: 0,
      clicked: 0,
      physicalClicks: 0,
      equivalentCovered: 0,
      excluded: [],
      unavailable: [],
      blocked: [],
      warnings: [...inventory.warnings]
    };
    const coverage: ClickCoverage = {
      discoveredActions: new Set(),
      clickedActions: new Set(),
      excludedActions: new Set()
    };

    if (scope === 'full' && inventory.urls.length < 10) {
      errors.push(`SITEMAP_COVERAGE_TOO_SMALL | ${site.baseUrl} | found ${inventory.urls.length} public URLs`);
    }

    const allKnownUrls = new Set(inventory.urls);
    const queuedUrls = new Set(
      inventory.urls.filter((_url, index) => index % shardTotal === shardIndex)
    );
    const urls = [...queuedUrls];
    const crawlDiscovered: string[] = [];
    const onInternalUrl = (candidate: string) => {
      if (allKnownUrls.has(candidate)) return;
      allKnownUrls.add(candidate);
      queuedUrls.add(candidate);
      urls.push(candidate);
      crawlDiscovered.push(candidate);
    };
    const useBackgroundTabs = !testInfo.project.name.toLowerCase().includes('mobile');

    for (let index = 0; index < urls.length; index++) {
      const url = urls[index];
      if (index % 25 === 0) {
        console.log(`QA_PROGRESS | ${site.name} | ${testInfo.project.name} | ${index}/${urls.length} | ${url}`);
      }
      await checkPage(
        page,
        url,
        errors,
        audit,
        coverage,
        useBackgroundTabs,
        onInternalUrl
      );
    }

    const safeUniqueActions = coverage.discoveredActions.size - coverage.excludedActions.size;
    if (coverage.clickedActions.size !== safeUniqueActions) {
      errors.push(
        `CLICK_COVERAGE_GAP | ${site.baseUrl} | safe unique actions ${safeUniqueActions} | clicked ${coverage.clickedActions.size}`
      );
    }

    const summary = {
      site: site.name,
      siteKey: site.key,
      device: testInfo.project.name,
      scope,
      shard: { index: shardIndex, number: shardIndex + 1, total: shardTotal },
      sitemapUrls: inventory.urls.length,
      testedUrls: urls.length,
      crawlDiscoveredUrls: crawlDiscovered.length,
      clickableInstances: audit.discovered,
      uniqueClickableActions: coverage.discoveredActions.size,
      safelyExcludedActions: coverage.excludedActions.size,
      clickedUniqueActions: coverage.clickedActions.size,
      physicalClicks: audit.physicalClicks,
      equivalentInstancesCovered: audit.equivalentCovered,
      unavailable: audit.unavailable.length,
      blocked: audit.blocked.length,
      warnings: audit.warnings,
      errors
    };

    await testInfo.attach('discovered-urls.txt', {
      body: [
        `Sitemap URLs (all shards): ${inventory.urls.length}`,
        `This shard tested: ${urls.length}`,
        `Crawl-only URLs added: ${crawlDiscovered.length}`,
        '',
        ...urls
      ].join('\n'),
      contentType: 'text/plain'
    });

    await testInfo.attach('sitemap-inventory.txt', {
      body: [
        '[CHECKED SITEMAPS]',
        ...inventory.checkedSitemaps,
        '',
        '[SITEMAP WARNINGS]',
        ...inventory.warnings,
        '',
        '[CRAWL-ONLY URLS]',
        ...crawlDiscovered
      ].join('\n'),
      contentType: 'text/plain'
    });

    await testInfo.attach('click-audit.txt', {
      body: [
        `Discovered visible clickable instances: ${audit.discovered}`,
        `Unique clickable actions: ${coverage.discoveredActions.size}`,
        `Actually clicked unique actions: ${coverage.clickedActions.size}`,
        `Physical browser clicks (including menu replay/fallback): ${audit.physicalClicks}`,
        `Equivalent repeated instances covered: ${audit.equivalentCovered}`,
        `Safely excluded unique actions: ${coverage.excludedActions.size}`,
        `Unavailable after clean reload: ${audit.unavailable.length}`,
        `Covered or not pointer-actionable: ${audit.blocked.length}`,
        `External/background warnings: ${audit.warnings.length}`,
        '',
        '[SAFELY EXCLUDED]',
        ...audit.excluded,
        '',
        '[UNAVAILABLE]',
        ...audit.unavailable,
        '',
        '[COVERED OR NOT ACTIONABLE]',
        ...audit.blocked,
        '',
        '[WARNINGS]',
        ...audit.warnings
      ].join('\n'),
      contentType: 'text/plain'
    });

    await testInfo.attach('coverage-summary.json', {
      body: JSON.stringify(summary, null, 2),
      contentType: 'application/json'
    });

    await testInfo.attach('qa-errors.txt', {
      body: errors.length ? errors.join('\n') : 'No errors found.',
      contentType: 'text/plain'
    });

    expect(errors, errors.slice(0, 200).join('\n')).toEqual([]);
  });
}
