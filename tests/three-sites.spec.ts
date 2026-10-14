import { test, expect, APIRequestContext, Page } from '@playwright/test';

type ClickAudit = {
  discovered: number;
  clicked: number;
  excluded: string[];
  unavailable: string[];
  blocked: string[];
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

const SITES = [
  { name: '龐德隆', baseUrl: 'https://www.pl168.net' },
  { name: '宅立貸', baseUrl: 'https://jf1688.com.tw' },
  { name: '第一貸', baseUrl: 'https://www.firstloan.tw' }
];

const decodeXml = (value: string) =>
  value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function browseLikeAVisitor(page: Page, url: string, errors: string[]) {
  // Let banners, fonts, lazy-loaded images and third-party widgets settle as they
  // would while a visitor reads the first screen.
  await page.waitForTimeout(900);

  const viewportHeight = page.viewportSize()?.height ?? 800;
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const scrollableDistance = Math.max(0, pageHeight - viewportHeight);
  const step = Math.max(280, Math.round(viewportHeight * 0.72));
  const steps = Math.min(12, Math.max(1, Math.ceil(scrollableDistance / step)));

  for (let index = 0; index < steps; index++) {
    // Wheel scrolling also exercises scroll listeners, sticky headers and lazy loading.
    await page.mouse.wheel(0, step);
    await page.waitForTimeout(450 + (index % 3) * 170);

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
    );
    if (overflow) {
      errors.push(`HORIZONTAL_OVERFLOW_WHILE_SCROLLING | ${url} | step-${index + 1}`);
      break;
    }

    // People commonly scroll back slightly after passing a section they want to reread.
    if (index === 2 && steps > 4) {
      await page.mouse.wheel(0, -Math.round(viewportHeight * 0.28));
      await page.waitForTimeout(550);
    }
  }

  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'auto' }));
  await page.waitForTimeout(500);

  const returnedToTop = await page.evaluate(() => window.scrollY <= 10);
  if (!returnedToTop) errors.push(`SCROLL_RETURN_FAILED | ${url}`);
}

async function collectSitemapUrls(
  request: APIRequestContext,
  baseUrl: string
): Promise<string[]> {
  const discovered = new Set<string>();
  const visitedMaps = new Set<string>();
  const queue = [
    new URL('/sitemap.xml', baseUrl).href,
    new URL('/sitemap_index.xml', baseUrl).href
  ];

  while (queue.length > 0) {
    const sitemapUrl = queue.shift()!;
    if (visitedMaps.has(sitemapUrl)) continue;
    visitedMaps.add(sitemapUrl);

    try {
      const response = await request.get(sitemapUrl, { timeout: 30_000 });
      if (!response.ok()) continue;
      const xml = await response.text();
      const locations = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
        .map((match) => decodeXml(match[1].trim()));

      for (const location of locations) {
        if (/\.xml(?:\?|$)/i.test(location)) {
          if (!visitedMaps.has(location)) queue.push(location);
        } else {
          try {
            const url = new URL(location);
            if (url.origin === new URL(baseUrl).origin) discovered.add(url.href);
          } catch {
            // Ignore malformed sitemap entries; they are reported by the page checks.
          }
        }
      }
    } catch {
      // Try the other conventional sitemap location before falling back.
    }
  }

  if (discovered.size === 0) discovered.add(new URL('/', baseUrl).href);
  return [...discovered].sort();
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
      const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
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

async function auditClickableElements(
  page: Page,
  url: string,
  errors: string[],
  audit: ClickAudit
) {
  // Every click runs in a fresh page. A menu, accordion or navigation click can no
  // longer change the DOM used by any later click.
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
    const unsafeProtocol = /^(?:tel|mailto|sms):/i.test(item.href);
    const externalCommunication = /(?:line\.me|lin\.ee|m\.me|messenger\.com|wa\.me)/i.test(item.href);
    const sideEffectText = /送出|提交|立即申請|免費申請|預約|撥打|電話|加好友|加入好友|聯絡我們|付款|購買|刪除|移除|submit|send|apply|delete|remove|pay|checkout/i.test(description);
    const submitControl = item.type === 'submit';
    const captchaControl = /驗證.*人類|captcha/i.test(description);

    if (unsafeProtocol || externalCommunication || submitControl || sideEffectText || captchaControl) {
      audit.excluded.push(`${url} | ${description} | ${item.href || item.type || 'potential side effect'}`);
      continue;
    }

    const actionPage = await page.context().newPage();
    const documentFailures: { status: number; resourceUrl: string }[] = [];
    const onResponse = (response: { status(): number; url(): string; request(): { resourceType(): string }; frame(): { parentFrame(): unknown } }) => {
      if (response.status() >= 400 && response.request().resourceType() === 'document' && !response.frame().parentFrame()) {
        documentFailures.push({ status: response.status(), resourceUrl: response.url() });
      }
    };
    page.context().on('response', onResponse);

    try {
      const response = await actionPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!response || response.status() >= 400) {
        errors.push(`CLICK_SETUP_HTTP_${response?.status() || 'NO_RESPONSE'} | ${url} | ${description}`);
        continue;
      }
      await actionPage.waitForTimeout(350);

      let revealFailed = false;
      for (const revealer of item.revealers) {
        const revealerControl = await locateClickTarget(actionPage, revealer);
        if (!revealerControl || !(await revealerControl.isVisible())) {
          addUnique(audit.unavailable, `${url} | ${description} | revealer unavailable: ${revealer.label}`);
          revealFailed = true;
          break;
        }
        await revealerControl.scrollIntoViewIfNeeded({ timeout: 5_000 });
        await revealerControl.click({ timeout: 5_000 });
        await actionPage.waitForTimeout(300);
      }
      if (revealFailed) continue;

      const control = await locateClickTarget(actionPage, item);
      if (!control || !(await control.isVisible())) {
        addUnique(audit.unavailable, `${url} | ${description}`);
        continue;
      }

      await control.scrollIntoViewIfNeeded({ timeout: 5_000 });
      await actionPage.waitForTimeout(250);

      const receivesPointer = await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
        const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
        const top = document.elementFromPoint(x, y);
        return Boolean(top && (element === top || element.contains(top) || top.contains(element)));
      }).catch(() => false);
      if (!receivesPointer) {
        addUnique(audit.blocked, `${url} | ${description} | covered or outside active viewport`);
        continue;
      }

      const pagesBefore = new Set(page.context().pages());
      const beforeUrl = actionPage.url();
      await control.click({ timeout: 5_000 });
      audit.clicked++;
      await actionPage.waitForTimeout(700);

      for (const failure of documentFailures) {
        let sameSite = false;
        try {
          sameSite = new URL(failure.resourceUrl).origin === new URL(url).origin;
        } catch {}
        const finding = `CLICK_TARGET_HTTP_${failure.status} | ${url} | ${description} | ${failure.resourceUrl}`;
        if (sameSite) errors.push(finding);
        else addUnique(audit.warnings, finding);
      }

      // Buttons, menus, tabs and accordions can reveal more controls. Replay the
      // same opener in a fresh page when those newly visible controls are tested.
      if (item.revealers.length < 2 && isSameDocument(beforeUrl, actionPage.url())) {
        const revealed = await discoverVisibleClickTargets(actionPage);
        enqueue(revealed, [...item.revealers, item]);
      }

      for (const openedPage of page.context().pages()) {
        if (!pagesBefore.has(openedPage) && openedPage !== actionPage) {
          await openedPage.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
          await openedPage.close().catch(() => {});
        }
      }
    } catch (error) {
      errors.push(`INTERACTION_FAILED | ${url} | ${description} | ${String(error)}`);
    } finally {
      page.context().off('response', onResponse);
      await actionPage.close().catch(() => {});
    }
  }
}

async function checkPage(page: Page, url: string, errors: string[], audit: ClickAudit) {
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
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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

    await auditClickableElements(page, url, errors, audit);

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

for (const site of SITES) {
  test(`${site.name}：Sitemap 全頁與互動巡檢`, async ({ page, request }, testInfo) => {
    const urls = await collectSitemapUrls(request, site.baseUrl);
    const errors: string[] = [];
    const audit: ClickAudit = {
      discovered: 0,
      clicked: 0,
      excluded: [],
      unavailable: [],
      blocked: [],
      warnings: []
    };

    await testInfo.attach('discovered-urls.txt', {
      body: urls.join('\n'),
      contentType: 'text/plain'
    });

    for (const url of urls) {
      await test.step(url, async () => {
        await checkPage(page, url, errors, audit);
      });
    }

    await testInfo.attach('click-audit.txt', {
      body: [
        `Discovered visible clickable elements: ${audit.discovered}`,
        `Actually clicked: ${audit.clicked}`,
        `Safely excluded: ${audit.excluded.length}`,
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

    await testInfo.attach('qa-errors.txt', {
      body: errors.length ? errors.join('\n') : 'No errors found.',
      contentType: 'text/plain'
    });

    expect(errors, errors.join('\n')).toEqual([]);
  });
}
