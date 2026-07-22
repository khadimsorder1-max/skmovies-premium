/* ============================================================================
   SKMovies — Cloudflare Pages Function: /api/moviebox/trending
   ----------------------------------------------------------------------------
   PURPOSE
     Proxy+cache moviebox.ph / aoneroom.com trending API to avoid HTTP 429
     rate-limiting from the upstream API.

   FIX (v3.4.0)
     - Cache responses in Cloudflare KV for 5 minutes (when bound).
     - On 429 from upstream, return last-known-good cache (stale) if any.
     - Pass through proper headers to look like a real browser.
     - Add jittered retry on 429/503 (1 retry with 800ms delay).

   DEPLOYMENT
     Place this file at:  functions/api/moviebox/trending.js
   ============================================================================ */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 12000;
const CACHE_TTL_SECONDS = 300; // 5 min fresh
const STALE_TTL_SECONDS = 86400; // 1 day acceptable-stale

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, stale-while-revalidate=60`,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchUpstream(targetUrl) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(targetUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://moviebox.ph',
        'Referer': 'https://moviebox.ph/',
      },
      signal: controller.signal,
    });
    clearTimeout(t);
    return r;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const page = url.searchParams.get('page') || '1';
  const perPage = url.searchParams.get('perPage') || '24';
  const targetUrl = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/trending?page=${page}&perPage=${perPage}`;
  const cacheKey = `moviebox:trending:${page}:${perPage}`;

  // Try fresh KV cache first
  if (env && env.SKM_CACHE) {
    try {
      const cached = await env.SKM_CACHE.get(cacheKey, 'json');
      if (cached) {
        return new Response(JSON.stringify(cached), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT', ...corsHeaders() },
        });
      }
    } catch {}
  }

  // Try fetch with 1 retry on 429/503
  let resp = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      resp = await fetchUpstream(targetUrl);
      if (resp.status === 429 || resp.status === 503) {
        if (attempt === 0) { await sleep(800 + Math.random() * 600); continue; }
      }
      break;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) { await sleep(500); continue; }
    }
  }

  if (!resp || !resp.ok) {
    // Try stale cache
    if (env && env.SKM_CACHE) {
      try {
        const stale = await env.SKM_CACHE.get(cacheKey + ':stale', 'json');
        if (stale) {
          return new Response(JSON.stringify(stale), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'STALE', ...corsHeaders() },
          });
        }
      } catch {}
    }
    const status = resp ? resp.status : 502;
    const msg = lastErr ? lastErr.message : `Upstream returned ${status}`;
    return new Response(JSON.stringify({ ok: false, error: `HTTP ${status}`, message: msg, items: [] }), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
    });
  }

  const data = await resp.json();

  // Normalize: moviebox returns { data: { subjectList: [...] } } or similar
  let items = [];
  if (Array.isArray(data)) items = data;
  else if (data && Array.isArray(data.data)) items = data.data;
  else if (data && Array.isArray(data.data?.subjectList)) items = data.data.subjectList;
  else if (data && Array.isArray(data.items)) items = data.items;
  else if (data && Array.isArray(data.subjectList)) items = data.subjectList;

  // Normalize item shape
  const normalized = items.map(it => ({
    slug: String(it.id || it.subjectId || it.slug || ''),
    title: it.title || it.name || it.originalTitle || 'Untitled',
    poster: it.posterUrl || it.cover || it.image || it.img || '',
    year: it.releaseYear || it.year || (it.releaseDate ? String(it.releaseDate).slice(0, 4) : ''),
    quality: it.quality || 'HD',
    language: it.language || '',
    rating: it.imdbRating || it.rating || '',
    type: it.type || 'movie',
    _raw: it,
  }));

  const response = {
    ok: true,
    page: parseInt(page, 10),
    items: normalized,
    movies: normalized, // alias
    hasMore: normalized.length >= parseInt(perPage, 10),
    source: 'moviebox',
    ts: Date.now(),
  };

  // Write to KV (fire-and-forget): fresh + stale copies
  if (env && env.SKM_CACHE) {
    try {
      env.SKM_CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: CACHE_TTL_SECONDS });
      env.SKM_CACHE.put(cacheKey + ':stale', JSON.stringify(response), { expirationTtl: STALE_TTL_SECONDS });
    } catch {}
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS', ...corsHeaders() },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
