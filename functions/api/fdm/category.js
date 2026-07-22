// functions/api/fdm/category.js
// Scrapes freedrivemovie.cyou/genre/<slug>/page/<n>/
import { CONSTANTS, fetchText, json, errorResponse, cacheGet, cacheSet } from '../_lib/shared.js';
import { parseFdmMovieList } from './_lib/fdm-parsers.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  const page = Math.max(1, Math.min(CONSTANTS.MAX_PAGES, parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const adult = url.searchParams.get('adult');

  if (!slug) return errorResponse('Missing ?slug=', 400);

  const cacheKey = `fdm:cat:${slug}:p${page}:${adult === '1' ? 'a' : 's'}`;
  let cacheVal = await cacheGet(env, cacheKey);
  if (cacheVal && (Date.now() - cacheVal.ts < CONSTANTS.HOT_CACHE_TTL * 1000)) {
    return json(cacheVal.data);
  }

  try {
    const target = page === 1
      ? `${CONSTANTS.FDM_BASE}/genre/${encodeURIComponent(slug)}/`
      : `${CONSTANTS.FDM_BASE}/genre/${encodeURIComponent(slug)}/page/${page}/`;

    const r = await fetchText(target, { referer: CONSTANTS.FDM_BASE });
    if (!r.ok) return errorResponse(`FDM category fetch failed: HTTP ${r.status}`, 502);

    const items = parseFdmMovieList(r.text);

    // Check for "next page" link
    const hasNext = /class="[^"]*next[^"]*"/i.test(r.text) ||
                    /href="[^"]*page\/${page + 1}\/"/i.test(r.text);

    // Filter adult content if ?adult is not '1'
    const filtered = adult === '1' ? items : filterAdult(items);

    const out = {
      ok: true,
      slug,
      page,
      items: filtered,
      hasMore: hasNext && filtered.length > 0,
    };

    await cacheSet(env, cacheKey, { ts: Date.now(), data: out }, CONSTANTS.HOT_CACHE_TTL);

    return json(out, 200, {
      'Cache-Control': 'public, max-age=0, s-maxage=300',
    });
  } catch (e) {
    return errorResponse('FDM category fetch failed: ' + String(e.message || e), 502);
  }
}

function filterAdult(items) {
  const adultRegex = /\b(18\+|adult|xxx|erotic|nude)\b/i;
  return items.filter(i => !adultRegex.test(i.title));
}
