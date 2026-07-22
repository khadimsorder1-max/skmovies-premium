// /api/notice — upcoming releases marquee
import { CONSTANTS, fetchText, json, cacheGet, cacheSet } from './_lib/shared.js';
import { parseNotice } from './_lib/parsers.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const nocache = url.searchParams.has('nocache') || url.searchParams.get('cache') === 'false';
  const cacheKey = 'notice:home';
  let items = null;
  if (!nocache) {
    items = await cacheGet(env, cacheKey);
  }
  if (!items) {
    const r = await fetchText(CONSTANTS.MLSBD_BASE, { referer: CONSTANTS.MLSBD_BASE });
    if (!r.ok) return json({ ok: true, items: [] });
    items = parseNotice(r.text);
    if (items.length === 0) items = ['Welcome to SKMovies — ad-free premium movie streamer'];
    await cacheSet(env, cacheKey, items, CONSTANTS.HOT_CACHE_TTL);
  }
  return json({ ok: true, items }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300',
  });
}
