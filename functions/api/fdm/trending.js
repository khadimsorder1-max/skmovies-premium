// /api/fdm/trending
import { CONSTANTS, fetchText, json, errorResponse, cacheGet, cacheSet } from '../_lib/shared.js';
import { parseFdmMovieList } from './_lib/fdm-parsers.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const adult = url.searchParams.get('adult') === '1';

  const cacheKey = `fdm:trending:${adult ? 'a' : 's'}`;
  let items = await cacheGet(env, cacheKey);
  if (!items) {
    const target = `${CONSTANTS.FDM_BASE}/trending/`;
    const r = await fetchText(target, { referer: CONSTANTS.FDM_BASE });
    if (!r.ok) return errorResponse('FDM trending fetch failed', 502);
    items = parseFdmMovieList(r.text);
    await cacheSet(env, cacheKey, items, CONSTANTS.HOT_CACHE_TTL);
  }

  // Filter 18+ items unless adult=1
  if (!adult) {
    items = items.filter((m) => !/\[18\+\]|\b18\+\b/i.test(m.title));
  }

  return json({ ok: true, items });
}
