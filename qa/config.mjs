export const SITES = [
  { key: 'pl168', name: '龐德隆', baseUrl: 'https://www.pl168.net/' },
  { key: 'jf1688', name: '宅立貸', baseUrl: 'https://jf1688.com.tw/' },
  { key: 'firstloan', name: '第一貸', baseUrl: 'https://www.firstloan.tw/' }
];
export const PROJECTS = ['desktop-chromium', 'mobile-chromium'];
export const STEP_DELAY_MS = 3000;

export function publicUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return null;
    url.protocol = base.protocol;
    url.host = base.host;
    if (/\/(?:wp-admin|wbadmin|wp-login\.php|wp-json|xmlrpc\.php)(?:\/|$)/i.test(url.pathname)) return null;
    if (/(?:\/feed\/?$|\/trackback\/?$|\/embed\/?$)/i.test(url.pathname)) return null;
    if (/\.(?:jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|xml|json|mp4|webm|mp3|woff2?|ttf|css|js)$/i.test(url.pathname)) return null;
    // Search, voting, preview and tracking URLs are actions, not an unbounded
    // inventory of new pages. They are still physically clicked in browser QA.
    if ([...url.searchParams.keys()].some(key => !/^(?:page_id|p|paged|page)$/.test(key))) return null;
    url.hash = '';
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    if (!/\.[a-z0-9]+$/i.test(url.pathname) && !url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  } catch { return null; }
}

export function decodeEntities(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;|&#0*39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function htmlLinks(html, baseUrl) {
  const cleaned = html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/gi, '');
  const values = [...cleaned.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)];
  return [...new Set(values.map(match => publicUrl(decodeEntities(match[1] ?? match[2] ?? match[3]), baseUrl)).filter(Boolean))];
}
