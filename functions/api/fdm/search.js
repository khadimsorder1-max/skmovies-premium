// /api/fdm/search?q=<query>
import { CONSTANTS, fetchText, json, errorResponse, cacheGet, cacheSet } from '../_lib/shared.js';
import { parseFdmMovieList } from './_lib/fdm-parsers.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return errorResponse('Missing query', 400);

  const page = Math.max(1, Math.min(CONSTANTS.MAX_PAGES, parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const adult = url.searchParams.get('adult') === '1';

  const cacheKey = `fdm:search:${q}:p${page}:${adult ? 'a' : 's'}`;
  let cacheVal = await cacheGet(env, cacheKey);
  if (cacheVal && (Date.now() - cacheVal.ts < CONSTANTS.HOT_CACHE_TTL * 1000)) {
    return json(cacheVal.data);
  }

  try {
    const target = page === 1 
      ? `${CONSTANTS.FDM_BASE}/?s=${encodeURIComponent(q)}` 
      : `${CONSTANTS.FDM_BASE}/page/${page}/?s=${encodeURIComponent(q)}`;
    const r = await fetchText(target, { referer: CONSTANTS.FDM_BASE });
    if (!r.ok) return errorResponse('FDM search fetch failed', 502);

    let items = parseFdmMovieList(r.text);

    // Check for "next page" link
    const hasNext = /class="[^"]*next[^"]*"/i.test(r.text) ||
                    new RegExp(`href="[^"]*page\\/${page + 1}\\/"`, 'i').test(r.text);

    if (!adult) {
      items = items.filter((m) => !/\[18\+\]|\b18\+\b/i.test(m.title));
    }

    const out = { 
      ok: true, 
      page, 
      items, 
      hasMore: hasNext && items.length > 0 
    };

    await cacheSet(env, cacheKey, { ts: Date.now(), data: out }, CONSTANTS.HOT_CACHE_TTL);
    
    return json(out, 200, {
      'Cache-Control': 'public, max-age=0, s-maxage=300',
    });
  } catch (e) {
    return errorResponse('FDM search fetch failed: ' + String(e.message || e), 502);
  }
}
