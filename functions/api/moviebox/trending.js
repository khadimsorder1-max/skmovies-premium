/* ============================================================================
   SKMovies — Cloudflare Pages Function: /api/moviebox/trending  v3.5.2
   ----------------------------------------------------------------------------
   STRATEGY:
     1. KV cache (fresh, 5 min)
     2. GitHub mega-cache (raw.githubusercontent.com) — primary stable source
     3. h5-api.aoneroom.com — direct API (works from CF Workers without auth)
     4. moviebox.ph/wefeed-h5api-bff — fallback (may 403 from CF)
     5. KV stale (up to 24h)
============================================================================ */

const CACHE_TTL = 300;
const STALE_TTL = 86400;
const TIMEOUT   = 8000;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': `public, max-age=${CACHE_TTL}, stale-while-revalidate=120`,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tryFetch(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, */*',
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return r;
  } catch(e) { clearTimeout(t); throw e; }
}

function normalizeItems(data) {
  let raw = [];
  if (Array.isArray(data)) raw = data;
  else if (data && data.data && Array.isArray(data.data.subjectList)) raw = data.data.subjectList;
  else if (data && Array.isArray(data.data)) raw = data.data;
  else if (data && Array.isArray(data.items)) raw = data.items;
  else if (data && Array.isArray(data.movies)) return data; // already normalized

  return raw.map(it => {
    let poster = '';
    if (typeof it.cover === 'string') poster = it.cover;
    else if (it.cover && it.cover.url) poster = it.cover.url;
    else if (it.posterUrl) poster = typeof it.posterUrl === 'object' ? (it.posterUrl.url || '') : it.posterUrl;
    let slug = '';
    if (it.detailPath && it.subjectId) slug = `${it.detailPath}?id=${it.subjectId}`;
    else slug = String(it.subjectId || it.id || it.slug || '');
    return { slug, title: it.title || it.name || 'Untitled', poster, year: it.releaseYear || it.year || (it.releaseDate ? String(it.releaseDate).slice(0,4) : ''), quality: 'HD', language: '', rating: it.imdbRatingValue || it.imdbRating || '', type: it.subjectType === 2 ? 'tv' : 'movie' };
  }).filter(it => it.slug && it.title !== 'Untitled');
}

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const page = url.searchParams.get('page') || '1';
  const perPage = url.searchParams.get('perPage') || '24';
  const cacheKey = `moviebox:trending:${page}:${perPage}`;

  // 1. Fresh KV
  if (env && env.SKM_CACHE) {
    try {
      const cached = await env.SKM_CACHE.get(cacheKey, 'json');
      if (cached && cached.ok && cached.items && cached.items.length > 0) {
        return new Response(JSON.stringify(cached), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'KV-HIT', ...cors() } });
      }
    } catch {}
  }

  // 2. GitHub mega-cache
  const cacheRepo = (env && env.SKM_CACHE_REPO) || 'khadimsorder1-max/skmovies-cache';
  try {
    const ghUrl = `https://raw.githubusercontent.com/${cacheRepo}/main/moviebox/latest${page !== '1' ? '-' + page : ''}.json`;
      const ghHeaders = { Accept: 'application/json' };
      if (env.SKM_CACHE_TOKEN) ghHeaders['Authorization'] = `Bearer ${env.SKM_CACHE_TOKEN}`;
      const r = await tryFetch(ghUrl);
      if (r.ok) {
        const text = await r.text();
        if (text.trim().startsWith('{')) {
          const data = JSON.parse(text);
          if (data.items && data.items.length > 0) {
            if (env.SKM_CACHE) {
              try { env.SKM_CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: CACHE_TTL }); } catch {}
            }
            return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'GH-HIT', ...cors() } });
          }
        }
      }
    } catch {}

  // 3. Live upstream sources (aoneroom.com primary, moviebox.ph fallback)

  const SOURCES = [
    `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/trending?page=${page}&perPage=${perPage}`,
    `https://moviebox.ph/wefeed-h5api-bff/subject/trending?page=${page}&perPage=${perPage}`,
  ];

  let items = [];
  for (const src of SOURCES) {
    try {
      const r = await tryFetch(src);
      if (!r.ok) continue;
      const text = await r.text();
      if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) continue;
      const data = JSON.parse(text);
      const parsed = Array.isArray(data.items) ? data.items : normalizeItems(data);
      if (parsed.length > 0) { items = parsed; break; }
    } catch { await sleep(200); }
  }

  // 4. Stale KV fallback
  if (items.length === 0 && env && env.SKM_CACHE) {
    try {
      const stale = await env.SKM_CACHE.get(cacheKey + ':stale', 'json');
      if (stale && stale.items && stale.items.length > 0) {
        return new Response(JSON.stringify({ ...stale, _stale: true }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'STALE', ...cors() } });
      }
    } catch {}
    return new Response(JSON.stringify({ ok: false, error: 'All sources failed', items: [], movies: [] }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors() } });
  }

  const response = { ok: true, page: parseInt(page, 10), items, movies: items, hasMore: items.length >= parseInt(perPage, 10), source: 'moviebox', ts: Date.now() };

  if (env && env.SKM_CACHE) {
    try {
      env.SKM_CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: CACHE_TTL });
      env.SKM_CACHE.put(cacheKey + ':stale', JSON.stringify(response), { expirationTtl: STALE_TTL });
    } catch {}
  }

  return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS', ...cors() } });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: cors() });
}
