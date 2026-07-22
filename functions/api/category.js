// /api/category?slug=[category-slug]&page=1
import { CONSTANTS, fetchText, json, errorResponse, cacheGet, cacheSet } from './_lib/shared.js';
import { parseMovieList } from './_lib/parsers.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
  const page = Math.max(1, Math.min(50, parseInt(url.searchParams.get('page') || '1', 10) || 1));
  if (!slug) return errorResponse('Missing category slug', 400);

  const adult = url.searchParams.get('adult') === '1';
  const cacheKey = `cat:${slug}:p${page}:${adult ? 'a' : 's'}`;

  let movies = await cacheGet(env, cacheKey);
  if (!movies) {
    const catBase = `${CONSTANTS.MLSBD_BASE}/category/${slug}`;
    const target = page === 1 ? `${catBase}/` : `${catBase}/page/${page}/`;
    let r = await fetchText(target);
    let moviesList = [];
    if (r.ok && r.text) {
      moviesList = parseMovieList(r.text);
    }
    if (!r.ok || moviesList.length === 0) {
      // Fallback: search-based approach with chronological order
      const searchTarget = page === 1
        ? `${CONSTANTS.MLSBD_BASE}/?s=${encodeURIComponent(slug.replace(/-/g, ' '))}&orderby=date`
        : `${CONSTANTS.MLSBD_BASE}/page/${page}/?s=${encodeURIComponent(slug.replace(/-/g, ' '))}&orderby=date`;
      const r2 = await fetchText(searchTarget);
      if (r2.ok && r2.text) {
        moviesList = parseMovieList(r2.text);
      }
    }
    movies = moviesList;
    await cacheSet(env, cacheKey, movies, 300);
  }

  if (!adult) movies = movies.filter((m) => !/\[18\+\]|\b18\+\b/i.test(m.title));
  const hasMore = movies.length >= 5 && page < 50;
  return json({ ok: true, page, items: movies, hasMore });
}
