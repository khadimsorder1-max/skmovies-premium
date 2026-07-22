// /api/south?hindi=0&page=1  — fetch South Indian movies from mlsbd.co category
import { CONSTANTS, fetchText, json, errorResponse, cacheGet, cacheSet } from './_lib/shared.js';
import { parseMovieList } from './_lib/parsers.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const page = Math.max(1, Math.min(50, parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const hindi = url.searchParams.get('hindi') === '1';

  // mlsbd.co South Indian category URLs
  const adult = url.searchParams.get('adult') === '1';
  const categorySlug = hindi ? 'south-indian-hindi-dubbed' : 'south-indian-movies';
  const cacheKey = `south:${categorySlug}:p${page}:${adult ? 'a' : 's'}`;

  let movies = await cacheGet(env, cacheKey);
  if (!movies) {
    // Try category URL first, fallback to search
    const catBase = `${CONSTANTS.MLSBD_BASE}/category/${categorySlug}`;
    const target = page === 1 ? `${catBase}/` : `${catBase}/page/${page}/`;
    let r = await fetchText(target);
    let moviesList = [];
    if (r.ok && r.text) {
      moviesList = parseMovieList(r.text);
    }
    if (!r.ok || moviesList.length === 0) {
      const searchTerm = hindi ? 'South Indian Hindi Dubbed' : 'South Indian';
      const searchTarget = page === 1
        ? `${CONSTANTS.MLSBD_BASE}/?s=${encodeURIComponent(searchTerm)}&orderby=date`
        : `${CONSTANTS.MLSBD_BASE}/page/${page}/?s=${encodeURIComponent(searchTerm)}&orderby=date`;
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
  return json({ ok: true, page, items: movies, hasMore }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=300',
  });
}
