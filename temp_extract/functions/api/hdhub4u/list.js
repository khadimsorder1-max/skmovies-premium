/* ============================================================================
   SKMovies — Cloudflare Pages Function: /api/hdhub4u/list
   ----------------------------------------------------------------------------
   PURPOSE
     Scrape hdhub4u.skin (now redirects content links to hdhub4us.ai.in)
     and return a normalized list of movies for the home / search / category
     views.

   FIX (v3.4.0)
     - Try BOTH hdhub4u.skin AND hdhub4us.ai.in domains (skin/ currently
       embeds ai.in URLs in its article cards; ai.in/ may also be fetched
       directly).
     - Updated regex to match the Blocksy theme's <article class="entry-card">
       structure used by both domains.
     - Filter out non-movie links (how-to-download, category, tag, etc.).
     - Cache successful responses in Cloudflare KV for 5 minutes to reduce
       upstream load (optional — falls back gracefully if no KV binding).

   DEPLOYMENT
     Place this file at:  functions/api/hdhub4u/list.js
   ============================================================================ */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;
const CACHE_TTL_SECONDS = 300; // 5 minutes

const HD_BASES = [
  'https://hdhub4u.skin/',
  'https://hdhub4us.ai.in/',
];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
  };
}

async function fetchHtml(targetUrl) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(targetUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!r.ok) return '';
    return await r.text();
  } catch {
    clearTimeout(t);
    return '';
  }
}

function parseMovies(html) {
  const items = [];

  // Primary regex: <a class="ct-media-container..." href="..." ...>...<img src="...">
  const cardRe = /<a\s+class="ct-media-container[^"]*"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/gi;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const pageUrl = m[1];
    const poster = m[2];
    const rawSlug = pageUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/\/$/, '');
    if (/how-to-download|category|tag|author|page\/|movie-request/i.test(rawSlug)) continue;
    const title = rawSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    items.push({ slug: rawSlug, title, poster, quality: 'HD', language: 'Hindi Dubbed', year: '', sizes: [] });
  }

  // Fallback regex: <article class="entry-card"> ... <a href="...hdhub4u*...">
  if (items.length === 0) {
    const articleRe = /<article[^>]*class="[^"]*entry-card[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
    let am;
    while ((am = articleRe.exec(html)) !== null) {
      const block = am[1];
      const hrefM = block.match(/<a[^>]*href="(https?:\/\/(?:hdhub4u[^"\/]*|hdhub4us[^"\/]*)\/[^"]+)"/i);
      const imgM = block.match(/<img[^>]+src="([^"]+)"/i);
      if (hrefM) {
        const pageUrl = hrefM[1];
        const poster = imgM ? imgM[1] : '';
        const rawSlug = pageUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/\/$/, '');
        if (/how-to-download|category|tag|author|page\/|movie-request/i.test(rawSlug)) continue;
        const title = rawSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        items.push({ slug: rawSlug, title, poster, quality: 'HD', language: 'Hindi Dubbed', year: '', sizes: [] });
      }
    }
  }

  return items;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const q = url.searchParams.get('q') || '';
  const catSlug = url.searchParams.get('slug') || '';
  const type = url.searchParams.get('type') || 'home';

  const cacheKey = `hdhub4u:list:${type}:${catSlug}:${q}:${page}`;

  // Try KV cache (if bound)
  if (env && env.SKM_CACHE) {
    try {
      const cached = await env.SKM_CACHE.get(cacheKey, 'json');
      if (cached) return new Response(JSON.stringify(cached), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
      });
    } catch {}
  }

  let html = '';
  let usedBase = '';
  for (const base of HD_BASES) {
    let targetUrl = base;
    if (type === 'search' && q) {
      targetUrl = page > 1 ? `${base}page/${page}/?s=${encodeURIComponent(q)}` : `${base}?s=${encodeURIComponent(q)}`;
    } else if (type === 'category' && catSlug) {
      targetUrl = page > 1 ? `${base}category/${catSlug}/page/${page}/` : `${base}category/${catSlug}/`;
    } else if (page > 1) {
      targetUrl = `${base}page/${page}/`;
    }
    html = await fetchHtml(targetUrl);
    if (html && html.length > 5000) { usedBase = base; break; }
  }

  if (!html) {
    return new Response(JSON.stringify({
      ok: false, error: 'Failed to fetch HDHub4u HTML',
      host: HD_BASES[0], type, page, totalPages: 0, count: 0, movies: [], items: [],
    }), { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() } });
  }

  const items = parseMovies(html);

  const resp = {
    ok: true,
    host: usedBase,
    type, page,
    totalPages: items.length >= 20 ? 301 : page, // heuristic
    count: items.length,
    movies: items,
    items, // alias for frontend compat
    ts: Date.now(),
  };

  // Write to KV cache (fire-and-forget)
  if (env && env.SKM_CACHE) {
    try { env.SKM_CACHE.put(cacheKey, JSON.stringify(resp), { expirationTtl: CACHE_TTL_SECONDS }); } catch {}
  }

  return new Response(JSON.stringify(resp), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
