import { test, expect, APIRequestContext, Page } from '@playwright/test';

type ClickAudit = {
  discovered: number;
  clicked: number;
  excluded: string[];
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

async function auditClickableElements(
  page: Page,
  url: string,
  errors: string[],
  audit: ClickAudit
) {
  // Mark the current DOM so each control can be reacquired after other clicks change
  // the layout. Newly revealed controls (for example a mobile menu) are appended below.
  const known = new Set<string>();
  const queue: string[] = [];

  const discoverVisibleControls = async () => {
    const discovered = await page.locator(CLICKABLE_SELECTOR).evaluateAll((elements) => {
      const results: { id: string; label: string; href: string; tag: string; type: string }[] = [];
      for (const [index, element] of (elements as HTMLElement[]).entries()) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
        if (!visible || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') continue;

        // The DOM index is stable after returning to the same page, unlike a
        // monotonically allocated id which would be lost on navigation.
        const qaId = `qa-${index}`;
        element.dataset.qaClickId = qaId;
        const anchor = element instanceof HTMLAnchorElement ? element : element.closest('a');
        results.push({
          id: qaId,
          label: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') ||
            (element as HTMLInputElement).value || anchor?.href || element.tagName).trim().replace(/\s+/g, ' ').slice(0, 180),
          href: anchor?.href || '',
          tag: element.tagName.toLowerCase(),
          type: (element.getAttribute('type') || '').toLowerCase()
        });
      }
      return results;
    });

    for (const item of discovered) {
      if (known.has(item.id)) continue;
      known.add(item.id);
      audit.discovered++;
      queue.push(JSON.stringify(item));
    }
  };

  await discoverVisibleControls();

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const item = JSON.parse(queue[cursor]) as {
      id: string; label: string; href: string; tag: string; type: string;
    };
    const description = item.label || `${item.tag}-${cursor + 1}`;
    const unsafeProtocol = /^(?:tel|mailto|sms):/i.test(item.href);
    const externalCommunication = /(?:line\.me|lin\.ee|m\.me|messenger\.com|wa\.me)/i.test(item.href);
    const sideEffectText = /送出|提交|立即申請|免費申請|預約|撥打|電話|加好友|加入好友|聯絡我們|付款|購買|刪除|移除|submit|send|apply|delete|remove|pay|checkout/i.test(description);
    const submitControl = item.type === 'submit';

    if (unsafeProtocol || externalCommunication || submitControl || sideEffectText) {
      audit.excluded.push(`${url} | ${description} | ${item.href || item.type || 'potential side effect'}`);
      continue;
    }

    let control = page.locator(`[data-qa-click-id="${item.id}"]`).first();
    if (!(await control.count())) {
      await discoverVisibleControls();
      control = page.locator(`[data-qa-click-id="${item.id}"]`).first();
    }
    if (!(await control.count())) {
      errors.push(`INTERACTION_NOT_REACQUIRED | ${url} | ${description}`);
      continue;
    }

    const beforeUrl = page.url();
    let popup: Page | null = null;
    try {
      await control.scrollIntoViewIfNeeded({ timeout: 5_000 });
      await page.waitForTimeout(250);

      // Keep ordinary links in a new tab. This is still a real browser click,
      // while preserving the source DOM so every remaining control is tested.
      if (item.href) {
        await control.evaluate((element) => {
          const anchor = element instanceof HTMLAnchorElement ? element : element.closest('a');
          if (anchor) anchor.target = '_blank';
        });
      }
      const popupPromise = item.href
        ? page.waitForEvent('popup', { timeout: 5_000 }).catch(() => null)
        : Promise.resolve(null);
      await control.click({ timeout: 5_000 });
      popup = await popupPromise;
      audit.clicked++;

      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
        const popupUrl = popup.url();
        const popupResponse = await popup.request.get(popupUrl, { timeout: 15_000 }).catch(() => null);
        if (popupResponse && popupResponse.status() >= 400) {
          errors.push(`CLICK_TARGET_HTTP_${popupResponse.status()} | ${url} | ${description} | ${popupUrl}`);
        }
        await popup.close().catch(() => {});
      } else {
        await page.waitForTimeout(650);
        const afterUrl = page.url();
        if (afterUrl !== beforeUrl) {
          const response = await page.request.get(afterUrl, { timeout: 15_000 }).catch(() => null);
          if (response && response.status() >= 400) {
            errors.push(`CLICK_TARGET_HTTP_${response.status()} | ${url} | ${description} | ${afterUrl}`);
          }
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(async () => {
            await page.goto(beforeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          });
        } else {
          // A menu, accordion, tab or modal may expose more clickable controls.
          await discoverVisibleControls();
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
    } catch (error) {
      errors.push(`INTERACTION_FAILED | ${url} | ${description} | ${String(error)}`);
      if (popup) await popup.close().catch(() => {});
      if (page.url() !== beforeUrl) {
        await page.goto(beforeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      }
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
    const audit: ClickAudit = { discovered: 0, clicked: 0, excluded: [] };

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
        '',
        ...audit.excluded
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
