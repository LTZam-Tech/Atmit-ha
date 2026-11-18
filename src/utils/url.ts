/**
 * Addresses with a query string. Many apps need it to show the right thing (a venue, a tenant, a language):
 * https://book.example.com/?venue=abc. Pages keep it in their URL, and the environment's own query
 * (baseURL) is added to every address of the same site that does not set those values itself.
 */
const TRACKING = /^(utm_\w+|fbclid|gclid|msclkid|_ga|_gl|mc_cid|mc_eid)$/i;

/** the part of an address a page is saved with: path + the query values that matter (no tracking) */
export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    return u.pathname + (u.searchParams.toString() ? `?${u.searchParams.toString()}` : '');
  } catch { return url; }
}

/** add the environment's query values to an address of the same site (values the address sets itself win) */
export function withBaseQuery(target: string, baseURL?: string): string {
  if (!baseURL) return target;
  let base: URL;
  try { base = new URL(baseURL); } catch { return target; }
  if (!base.search) return target;
  let t: URL;
  try { t = new URL(target, base); } catch { return target; }
  if (t.origin !== base.origin) return target;
  for (const [k, v] of base.searchParams) if (!t.searchParams.has(k) && !TRACKING.test(k)) t.searchParams.set(k, v);
  return /^https?:/i.test(target) ? t.toString() : t.pathname + t.search + t.hash;
}

/** does the browser's address show this page? same path, and every query value the page was saved with */
export function sameAddress(pageUrl: string, current: string): boolean {
  try {
    const here = new URL(current);
    const p = new URL(pageUrl, here);
    const norm = (s: string) => s.replace(/\/$/, '') || '/';
    if (norm(p.pathname) !== norm(here.pathname)) return false;
    for (const [k, v] of p.searchParams) if (here.searchParams.get(k) !== v) return false;
    return true;
  } catch { return false; }
}
