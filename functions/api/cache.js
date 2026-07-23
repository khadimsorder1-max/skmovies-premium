/* ============================================================================
   SKMovies — Cloudflare Pages Function: /api/cache
   ----------------------------------------------------------------------------
   PURPOSE
     GitHub-backed mega-cache for SKMovies. Pre-fetches 1000+ movies/series
     per source into a GitHub repo (JSON files), then serves them via
     Cloudflare with super-fast edge caching.

   ARCHITECTURE
     ┌────────────────┐    scheduled cron    ┌──────────────────┐
     │  GitHub repo   │ ←─────────────────  │  Worker cron     │
     │  /cache/       │    (writes JSON)    │  (fetches upstream│
     │  mlsbd/latest  │                     │   every 6 hours) │
     │  mlsbd/movie/  │                     └──────────────────┘
     │  fdm/latest    │                              ▲
     │  ...           │                              │ fetch
     │                │   read on-demand             │ upstream
     │                │ ←───────────┐                │
     └────────────────┘             │                │
              ▲                     │                │
              │ raw.githubusercontent│                │
              │                     │                │
     ┌────────┴────────┐    cache miss    ┌──────────┴───────┐
     │  /api/cache     │ ←─────────────  │  Cloudflare KV    │
     │  Cloudflare Fn  │                 │  SKM_CACHE        │
     │  (reads GitHub  │                 │  (1-hour TTL)     │
     │   OR upstream   │                 └───────────────────┘
     │   + caches in KV│
     └─────────────────┘
              ▲
              │ fetch
              │
     ┌────────┴────────┐
     │     Browser     │
     │  (skmovies app) │
     └─────────────────┘

   FLOW
     1. Browser requests /api/cache?src=mlsbd&path=latest&page=1
     2. Function checks Cloudflare KV for cached response (1-hour TTL).
     3. If KV miss, fetches from raw.githubusercontent.com/<owner>/<repo>/main/<src>/<path>.json
        (the GitHub repo serves as the slow-changing mega-cache).
     4. If GitHub also fails (or file doesn't exist), falls back to the
        original upstream Function (/api/<src>/<path>) which scrapes live.
     5. The result is cached in KV for 1 hour AND in the browser via
        Cache-Control headers.

   DEPLOYMENT
     Place this file at:  functions/api/cache.js

   ENVIRONMENT VARIABLES (set in Cloudflare Pages dashboard)
     - SKM_CACHE_REPO: GitHub repo in format "owner/repo" (e.g. "skmovies/cache")
     - SKM_CACHE_TOKEN: GitHub personal access token (for private repos, optional)
     - SKM_CACHE_KV: KV namespace binding (name: SKM_CACHE)

   GITHUB REPO STRUCTURE (build with scripts/build_cache.js)
     cache/
     ├── mlsbd/
     │   ├── latest.json         (1000+ items, page 1)
     │   ├── latest-2.json       (page 2)
     │   ├── latest-3.json
     │   ├── trending.json
     │   ├── category/<slug>.json
     │   └── movie/
     │       ├── <slug>.json     (one file per movie detail)
     │       └── ...
     ├── fdm/
     │   ├── latest.json
     │   └── ...
     ├── hdhub4u/
     │   └── ...
     ├── hdhubmain/
     │   └── ...
     ├── moviebox/
     │   └── ...
     └── fibwatch/
         └── ...
   ============================================================================ */

const FETCH_TIMEOUT_MS = 8000;

function corsHeaders(cacheTtl = 3600) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}, stale-while-revalidate=600`,
  };
}

function jsonResponse(obj, status = 200, cacheTtl = 3600) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(cacheTtl),
    },
  });
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(t));
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const src = (url.searchParams.get('src') || 'mlsbd').toLowerCase();
  let path = (url.searchParams.get('path') || 'latest').toLowerCase();
  const page = url.searchParams.get('page') || '1';
  const slug = url.searchParams.get('slug') || '';
  const adult = url.searchParams.get('adult') || '';
  const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';

  // Normalize "home" → "latest" for cache key consistency
  if (path === 'home') path = 'latest';


  // Validate src
  const VALID_SOURCES = ['mlsbd', 'fdm', 'hdhub4u', 'hdhubmain', 'moviebox', 'fibwatch', 'krx18', 'fojik'];

  if (!VALID_SOURCES.includes(src)) {
    return jsonResponse({ ok: false, error: 'Invalid source' }, 400);
  }


  // Build the cache key (include adult flag for separate caching)
  let cacheKey;
  let githubPath;
  if (path === 'movie' && slug) {
    const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
    cacheKey = `cache:${src}:movie:${safeSlug}`;
    githubPath = `${src}/movie/${safeSlug}.json`;
  } else if (path === 'category' && slug) {
    const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
    cacheKey = `cache:${src}:category:${safeSlug}:${page}`;
    githubPath = `${src}/category/${safeSlug}-${page}.json`;
  } else if (path === 'search') {
    const q = url.searchParams.get('q') || '';
    if (!q) return jsonResponse({ ok: true, items: [], source: src });
    cacheKey = `cache:${src}:search:${q}:${page}`;
    githubPath = null;
  } else {
    cacheKey = `cache:${src}:${path}:${page}`;
    githubPath = `${src}/${path}${page !== '1' ? '-' + page : ''}.json`;
  }

  // 1. Try Cloudflare KV cache first
  if (!refresh && env && env.SKM_CACHE) {
    try {
      const cached = await env.SKM_CACHE.get(cacheKey, 'json');
      if (cached) {
        return jsonResponse(cached, 200, 3600);
      }
    } catch {}
  }

  // 2. Try GitHub repo (raw.githubusercontent.com)
  if (!refresh && githubPath && env && env.SKM_CACHE_REPO) {
    const ghUrl = `https://raw.githubusercontent.com/${env.SKM_CACHE_REPO}/main/${githubPath}`;

    const ghHeaders = { 'Accept': 'application/json' };
    if (env.SKM_CACHE_TOKEN) {
      ghHeaders['Authorization'] = `Bearer ${env.SKM_CACHE_TOKEN}`;
    }
    try {
      const r = await fetchWithTimeout(ghUrl, { headers: ghHeaders });
      if (r.ok) {
        const data = await r.json();
        // Cache in KV for 1 hour (edge cache)
        if (env.SKM_CACHE) {
          try { env.SKM_CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 }); } catch {}
        }
        return jsonResponse(data, 200, 3600);
      }
    } catch (e) {
      console.warn('GitHub cache fetch failed:', e.message);
    }
  }

  // 3. Fall back to the live upstream Function
  //    (e.g. /api/latest, /api/fdm/latest, /api/hdhub4u/list, etc.)
  let upstreamUrl;
  switch (src) {
    case 'mlsbd':
      upstreamUrl = path === 'movie'
        ? `/api/movie?slug=${encodeURIComponent(slug)}`
        : path === 'category'
          ? `/api/category?slug=${encodeURIComponent(slug)}&page=${page}`
          : path === 'trending'
            ? `/api/trending?page=${page}`
            : `/api/latest?page=${page}`;
      break;
    case 'fdm':
      upstreamUrl = path === 'movie'
        ? `/api/fdm/movie?slug=${encodeURIComponent(slug)}`
        : path === 'category'
          ? `/api/fdm/category?slug=${encodeURIComponent(slug)}&page=${page}`
          : path === 'trending'
            ? `/api/fdm/trending?page=${page}`
            : `/api/fdm/latest?page=${page}`;
      break;
    case 'hdhub4u':
      upstreamUrl = path === 'movie'
        ? `/api/hdhub4u/movie?slug=${encodeURIComponent(slug)}`
        : `/api/hdhub4u/list?type=${path === 'trending' ? 'home' : path}&page=${page}${slug ? `&slug=${encodeURIComponent(slug)}` : ''}`;
      break;
    case 'hdhubmain':
      upstreamUrl = path === 'movie'
        ? `/api/hdhubmain/movie?slug=${encodeURIComponent(slug)}`
        : `/api/hdhubmain/list?type=${path === 'trending' ? 'home' : path}&page=${page}${slug ? `&slug=${encodeURIComponent(slug)}` : ''}`;
      break;
    case 'moviebox':
      upstreamUrl = path === 'movie'
        ? `/api/moviebox/movie?slug=${encodeURIComponent(slug)}`
        : path === 'category'
          ? `/api/moviebox/category?slug=${encodeURIComponent(slug)}&page=${page}`
          : path === 'trending'
            ? `/api/moviebox/trending?page=${page}`
            : `/api/moviebox/trending?page=${page}`;
      break;
    case 'fibwatch':
      upstreamUrl = path === 'movie'
        ? `/api/fibwatch/movie?slug=${encodeURIComponent(slug)}`
        : path === 'category'
          ? `/api/fibwatch/category?slug=${encodeURIComponent(slug)}&page=${page}`
          : path === 'trending'
            ? `/api/fibwatch/trending?page=${page}`
            : `/api/fibwatch/latest?page=${page}`;
      break;
    case 'krx18':
      upstreamUrl = path === 'movie'
        ? `/api/krx18/movie?slug=${encodeURIComponent(slug)}`
        : path === 'category'
          ? `/api/krx18/category?slug=${encodeURIComponent(slug)}&page=${page}`
          : `/api/krx18/list?type=${path}&page=${page}${slug ? `&slug=${encodeURIComponent(slug)}` : ''}`;
      break;
    case 'fojik':
      upstreamUrl = path === 'movie'
        ? `/api/fojik/movie?slug=${encodeURIComponent(slug)}`
        : `/api/fojik/list?type=${path === 'trending' ? 'home' : path}&page=${page}${slug ? `&slug=${encodeURIComponent(slug)}` : ''}`;
      break;

  }


  // Add search query if applicable
  const q = url.searchParams.get('q');
  if (q && path === 'search') {
    upstreamUrl += (upstreamUrl.includes('?') ? '&' : '?') + `q=${encodeURIComponent(q)}`;
  }
  // Pass through adult filter
  if (adult) {
    upstreamUrl += (upstreamUrl.includes('?') ? '&' : '?') + `adult=${adult}`;
  }

  try {
    const r = await fetchWithTimeout(new URL(upstreamUrl, request.url).toString(), {
      headers: { 'Accept': 'application/json', 'User-Agent': 'SKM-Cache/1.0' },
    });
    if (!r.ok) {
      return jsonResponse({ ok: false, error: `Upstream returned ${r.status}`, source: src }, r.status, 60);
    }
    const data = await r.json();
    // Cache successful responses for 1 hour in KV
    if (env && env.SKM_CACHE && data && data.ok !== false) {
      try { env.SKM_CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 }); } catch {}
    }
    return jsonResponse(data, 200, 1800); // 30 min browser cache for live fallback
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Cache + upstream both failed: ' + (e.message || ''), source: src }, 502, 60);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
