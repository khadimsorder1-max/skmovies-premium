// /api/trending
import { CONSTANTS, fetchText, json, errorResponse, cacheGet, cacheSet } from './_lib/shared.js';
import { parseTrending, parseMovieList } from './_lib/parsers.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const adult = url.searchParams.get('adult') === '1';
  const cacheKey = `trending:home:${adult ? 'a' : 's'}`;
  let items = await cacheGet(env, cacheKey);
  if (!items || !items.length) {
    const r = await fetchText(CONSTANTS.MLSBD_BASE, { referer: CONSTANTS.MLSBD_BASE });
    if (!r.ok) return errorResponse('Upstream fetch failed', 502);
    items = parseTrending(r.text);
    if (items.length === 0) items = parseMovieList(r.text).slice(0, 12);
    await cacheSet(env, cacheKey, items, CONSTANTS.HOT_CACHE_TTL);
  }
  if (!adult) items = items.filter((m) => !/\[18\+\]|\b18\+\b/i.test(m.title));
  return json({ ok: true, items }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300',
  });
}
