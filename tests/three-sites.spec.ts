import { test, expect, APIRequestContext, Page } from '@playwright/test';

const SITES = [
  { name: '龐德隆', baseUrl: 'https://www.pl168.net' },
  { name: '宅立貸', baseUrl: 'https://jf1688.com.tw' },
  { name: '第一貸', baseUrl: 'https://www.firstloan.tw' }
];

const decodeXml = (value: string) =>
  value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

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

async function checkPage(page: Page, url: string, errors: string[]) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const onConsole = (message: { type(): string; text(): string }) => {
            const text = message.text();
    if (/requestStorageAccess:\s*Permission denied/i.test(text)) {
      console.warn(`QA_WARNING | ${url} | ${text}`);
      return;
    }
    if (message.type() === 'error' && !/favicon|third-party cookie/i.test(text)) {
      consoleErrors.push(message.text());
    }
  };
  const onPageError = (error: Error) => pageErrors.push(error.message);

  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response) errors.push(`NO_RESPONSE | ${url}`);
    else if (response.status() >= 400) errors.push(`HTTP_${response.status()} | ${url}`);

    await expect(page.locator('body')).toBeVisible();
    const title = (await page.title()).trim();
    if (!title) errors.push(`EMPTY_TITLE | ${url}`);

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

    const safeControls = page.locator(
      'button:visible:not([type="submit"]), [role="button"]:visible, [aria-expanded]:visible'
    );
    const count = Math.min(await safeControls.count(), 20);
    for (let index = 0; index < count; index++) {
      const control = safeControls.nth(index);
      const text = ((await control.innerText().catch(() => '')) || '').trim();
      if (/送出|申請|預約|聯絡|撥打|電話|LINE|submit|send|apply|delete|remove/i.test(text)) continue;

      const beforeClickUrl = page.url();
      try {
        await control.click({ timeout: 3_000 });
        await page.waitForTimeout(500);

        if (page.url() !== beforeClickUrl) {
          const returned = await page.goBack({
            waitUntil: 'domcontentloaded',
            timeout: 10_000
          }).catch(() => null);

          if (!returned && page.url() !== beforeClickUrl) {
            await page.goto(beforeClickUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 30_000
            });
          }
          await page.waitForLoadState('domcontentloaded').catch(() => {});
        }

        await page.keyboard.press('Escape').catch(() => {});
      } catch (error) {
        if (page.url() !== beforeClickUrl) {
          await page.goBack({
            waitUntil: 'domcontentloaded',
            timeout: 10_000
          }).catch(async () => {
            await page.goto(beforeClickUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 30_000
            }).catch(() => {});
          });
          continue;
        }

        errors.push(`INTERACTION_FAILED | ${url} | ${text || `control-${index + 1}`} | ${String(error)}`);
      }
    }

    for (const message of consoleErrors.slice(0, 10)) {
      errors.push(`CONSOLE_ERROR | ${url} | ${message}`);
    }
    for (const message of pageErrors.slice(0, 10)) {
      errors.push(`PAGE_ERROR | ${url} | ${message}`);
    }
  } catch (error) {
    errors.push(`NAVIGATION_FAILED | ${url} | ${String(error)}`);
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
}

for (const site of SITES) {
  test(`${site.name}：Sitemap 全頁與互動巡檢`, async ({ page, request }, testInfo) => {
    const urls = await collectSitemapUrls(request, site.baseUrl);
    const errors: string[] = [];

    await testInfo.attach('discovered-urls.txt', {
      body: urls.join('\n'),
      contentType: 'text/plain'
    });

    for (const url of urls) {
      await test.step(url, async () => {
        await checkPage(page, url, errors);
      });
    }

    await testInfo.attach('qa-errors.txt', {
      body: errors.length ? errors.join('\n') : 'No errors found.',
      contentType: 'text/plain'
    });

    expect(errors, errors.join('\n')).toEqual([]);
  });
}
