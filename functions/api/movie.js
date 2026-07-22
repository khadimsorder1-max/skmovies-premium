// /api/movie?slug=<slug>
import { CONSTANTS, fetchText, json, errorResponse, cacheGet, cacheSet } from './_lib/shared.js';
import { parseMovieDetails } from './_lib/parsers.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get('slug') || '').trim();
  if (!slug) return errorResponse('Missing slug', 400);
  if (!/^[a-z0-9-]+$/i.test(slug)) return errorResponse('Invalid slug', 400);
  const nocache = url.searchParams.has('nocache') || url.searchParams.get('cache') === 'false';
  const cacheKey = `movie:${slug}`;
  let details = null;
  if (!nocache) {
    details = await cacheGet(env, cacheKey);
  }
  if (!details) {
    const target = `${CONSTANTS.MLSBD_BASE}/${slug}/`;
    const r = await fetchText(target, { referer: CONSTANTS.MLSBD_BASE });
    if (!r.ok) return errorResponse('Movie fetch failed', r.status === 404 ? 404 : 502);
    details = parseMovieDetails(r.text, slug);
    if (!details) return errorResponse('Parse failed', 500);
    details.movieUrl = target;
    await cacheSet(env, cacheKey, details, CONSTANTS.CACHE_TTL * 4);
  }
  return json({ ok: true, ...details }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300',
  });
}
