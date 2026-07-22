// /api/fdm/latest?page=1&adult=0
import { CONSTANTS, fetchText, json, errorResponse, cacheGet, cacheSet } from '../_lib/shared.js';
import { parseFdmMovieList } from './_lib/fdm-parsers.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const page = Math.max(1, Math.min(CONSTANTS.MAX_PAGES, parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const adult = url.searchParams.get('adult') === '1';

  const cacheKey = `fdm:latest:p${page}:${adult ? 'a' : 's'}`;
  let movies = await cacheGet(env, cacheKey);
  if (!movies) {
    const target = page === 1 ? CONSTANTS.FDM_BASE : `${CONSTANTS.FDM_BASE}/page/${page}/`;
    const r = await fetchText(target, { referer: CONSTANTS.FDM_BASE });
    if (!r.ok) return errorResponse('FDM latest fetch failed', 502);
    movies = parseFdmMovieList(r.text);
    await cacheSet(env, cacheKey, movies, CONSTANTS.HOT_CACHE_TTL);
  }

  // Filter 18+: skip items with [18+] in title unless adult=1
  if (!adult) {
    movies = movies.filter((m) => !/\[18\+\]|\b18\+\b/i.test(m.title));
  }

  const hasMore = page < CONSTANTS.MAX_PAGES && movies.length >= 5;
  return json({ ok: true, page, items: movies, hasMore }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300',
  });
}
