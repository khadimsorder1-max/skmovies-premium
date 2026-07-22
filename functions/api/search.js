// /api/search?q=<query>&page=1
import { CONSTANTS, fetchText, json, errorResponse, cacheGet, cacheSet } from './_lib/shared.js';
import { parseMovieList } from './_lib/parsers.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const page = Math.max(1, Math.min(50, parseInt(url.searchParams.get('page') || '1', 10) || 1));
  if (!q) return json({ ok: true, items: [], hasMore: false, q: '' });
  if (q.length < 2) return json({ ok: true, q, page, items: [], hasMore: false });
  const adult = url.searchParams.get('adult') === '1';
  const cacheKey = `search:${q.toLowerCase()}:p${page}:${adult ? 'a' : 's'}`;
  let movies = await cacheGet(env, cacheKey);
  if (!movies) {
    const target = page === 1 ? `${CONSTANTS.MLSBD_BASE}/?s=${encodeURIComponent(q)}` : `${CONSTANTS.MLSBD_BASE}/page/${page}/?s=${encodeURIComponent(q)}`;
    const r = await fetchText(target, { referer: CONSTANTS.MLSBD_BASE });
    if (!r.ok) return errorResponse('Search failed', 502);
    movies = parseMovieList(r.text);
    await cacheSet(env, cacheKey, movies, CONSTANTS.CACHE_TTL);
  }
  if (!adult) movies = movies.filter((m) => !/\[18\+\]|\b18\+\b/i.test(m.title));
  const hasMore = movies.length >= 8 && page < 50;
  return json({ ok: true, q, page, items: movies, hasMore }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300',
  });
}
