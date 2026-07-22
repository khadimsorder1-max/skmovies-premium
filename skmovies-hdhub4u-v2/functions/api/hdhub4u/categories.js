/**
 * GET /api/hdhub4u/categories
 * ----------------------------
 * Returns the static list of HDHub4u categories (extracted from the
 * homepage's main nav). Cached for 24 hours.
 *
 * Response:
 *   {
 *     "host":        "https://new3.hdhub4u.cl/",
 *     "categories": [
 *       { "slug": "bollywood-movies", "name": "BollyWood",   "url": "..." },
 *       { "slug": "hollywood-movies", "name": "HollyWood",   "url": "..." },
 *       ...
 *     ]
 *   }
 */
const {
  resolveActiveHost,
  fetchHTML,
  jsonResponse,
  HTMLParser,
  setEnv,
  setWaitUntil,
  LANDING_PAGE,
} = require('./_lib.js');
const { TTL, cached, cacheKey } = require('./_cache.js');

export async function onRequestGet(ctx) {
  setEnv(ctx.env || {});
  if (ctx.waitUntil) setWaitUntil(ctx.waitUntil.bind(ctx));

  try {
    const host = await resolveActiveHost();
    const key = cacheKey('categories', 'all');

    const { value, fromCache } = await cached(key, async () => {
      const html = await fetchHTML(host, { referer: LANDING_PAGE });

      const categories = [];
      const seen = new Set();
      const re = /<a[^>]+href=["']([^"']*\/category\/([^/"']+)\/?)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const url = m[1];
        const slug = m[2];
        const name = HTMLParser.stripTags(m[3]) || slug.replace(/-/g, ' ');
        if (slug && !seen.has(slug)) {
          seen.add(slug);
          categories.push({ slug, name, url });
        }
      }

      return {
        host,
        count: categories.length,
        categories,
        ts: Date.now(),
      };
    }, TTL.CATEGORY);

    value.host = host;
    value.ts = Date.now();
    value._cache = fromCache;
    return jsonResponse(value);
  } catch (e) {
    return jsonResponse(
      { error: 'Failed to fetch categories', message: String(e && e.message || e) },
      502
    );
  }
}
