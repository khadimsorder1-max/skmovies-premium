// /api/latest?page=1&filter=all&adult=0
import { CONSTANTS, FILTERS, fetchText, json, errorResponse, cacheGet, cacheSet } from './_lib/shared.js';
import { parseMovieList, filterMovies } from './_lib/parsers.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const page = Math.max(1, Math.min(CONSTANTS.MAX_PAGES, parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const filter = (url.searchParams.get('filter') || 'all').toLowerCase();
  const adult = url.searchParams.get('adult') === '1';
  if (filter !== 'all' && !FILTERS.has(filter)) return errorResponse('Invalid filter', 400);

  const cacheKey = `latest:p${page}:${adult ? 'a' : 's'}`;
  let movies = await cacheGet(env, cacheKey);
  if (!movies) {
    const target = page === 1 ? CONSTANTS.MLSBD_BASE : `${CONSTANTS.MLSBD_BASE}/page/${page}/`;
    const r = await fetchText(target, { referer: CONSTANTS.MLSBD_BASE });
    if (!r.ok) return errorResponse('Upstream fetch failed', 502);
    movies = parseMovieList(r.text);
    await cacheSet(env, cacheKey, movies, 300);
  }
  if (filter !== 'all') movies = filterMovies(movies, filter);
  // Filter 18+: skip items with [18+] in title unless adult=1
  if (!adult) movies = movies.filter((m) => !/\[18\+\]|\b18\+\b/i.test(m.title));
  const hasMore = page < CONSTANTS.MAX_PAGES && movies.length >= 5;
  return json({ ok: true, page, filter, items: movies, hasMore }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300',
  });
}
