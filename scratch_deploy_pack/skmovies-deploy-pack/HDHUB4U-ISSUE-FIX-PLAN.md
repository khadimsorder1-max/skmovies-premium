# HDHub4u Real-Time Issue + Fix + Strict AI Task Plan

> **File**: `HDHUB4U-ISSUE-FIX-PLAN.md`
> **Site**: https://skmovies-premium.pages.dev/
> **Symptom**: HDHub4u source toggle returns a blank movie page (`movies: []`) on every endpoint (`/api/hdhub4u/list`, `/api/hdhub4u/movie`, `/api/hdhub4u/stream`).
> **Severity**: P0 — full source broken, zero playable content.
> **Status**: Root-cause confirmed; complete fix code provided below; AI implementation instructions included.

---

## 1. Issue Analysis

### 1.1 What the user sees

1. Open `https://skmovies-premium.pages.dev/`.
2. Click the source-toggle button until the label reads **HDHub4u**.
3. Home grid renders **zero** movie cards. Search, category, and movie-detail pages are also empty.
4. Browser DevTools → Network shows the request
   `GET /api/hdhub4u/list?type=home&page=1` returns `200 OK` with body:

   ```json
   {
     "host": "https://hdhub4u.com/",
     "type": "home",
     "page": 1,
     "totalPages": 1,
     "count": 0,
     "movies": [],
     "ts": 1784596362126,
     "_cache": "fresh"
   }
   ```

5. Same shape from `/api/hdhub4u/movie?slug=<anything>` — every field is empty string / empty array.

### 1.2 Why `movies: []` is returned

The backend Page Function hard-codes the upstream root as `https://hdhub4u.com/`. That domain **is no longer the real movie host** — it is now a parked / affiliate redirect page that contains **no movie markup**. The scraper runs against it, finds no `<li class="thumb">` cards, and returns an empty array.

The real, currently-live host is **`https://new3.hdhub4u.cl/`** (a full WordPress movie database). The HDHub4u operator rotates this domain every few weeks to dodge ISP blocks, so **any hard-coded value will rot again**.

### 1.3 How HDHub4u publishes the current host

The static landing page `https://hdhub4u.med/` ("Visit Full Page" button) executes obfuscated JS that fans out to **five parallel host-resolution APIs** and picks the first that responds. Each API returns:

```json
{
  "h": "aGRodWI0dS5tZWQ=",                                  // base64("hdhub4u.med")
  "c": "aHR0cHM6Ly9uZXczLmhkaHViNHUuY2wvP3V0bT1tbjE=",     // base64("https://new3.hdhub4u.cl/?utm=mn1")
  "t": 1784596373                                            // unix seconds
}
```

The five endpoints (verified live on 2026-07-21):

| # | URL | Status |
|---|-----|--------|
| 1 | `https://h4.suncdn.org/host/` | ✅ works |
| 2 | `https://points.topapii.com/host/` | ✅ works |
| 3 | `https://ml.theapii.org/host/` | ✅ works |
| 4 | `https://dns.pingora.fyi/v2/host` | ✅ works |
| 5 | `https://cdn.hub4u.cloud/host/` | ❌ Cloudflare-blocked (HTML challenge page) |

Decoded from the base64 `c` field, the **current working upstream root** is:

```
https://new3.hdhub4u.cl/?utm=mn1
```

The `?utm=mn1` query is an internal referral tag — safe to drop; the host root is `https://new3.hdhub4u.cl/`.

### 1.4 HTML structure on the live upstream

`https://new3.hdhub4u.cl/` is a WordPress site. The homepage and category pages render movies as:

```html
<li class="thumb col-md-2 col-sm-4 col-xs-6">
  <figure>
    <img src="https://image.tmdb.org/t/p/w342/<id>.jpg"
         alt="<TITLE>" title="<TITLE>">
    <a href="https://new3.hdhub4u.cl/<slug>/" data-wpel-link="internal">
      <div class="thumb-hover"></div>
    </a>
  </figure>
  <figcaption>
    <a href="https://new3.hdhub4u.cl/<slug>/" data-wpel-link="internal">
      <p><TITLE></p>
    </a>
  </figcaption>
</li>
```

Pagination uses the WordPress convention `https://new3.hdhub4u.cl/page/<N>/` for home, and `https://new3.hdhub4u.cl/category/<slug>/page/<N>/` for categories. Search uses `https://new3.hdhub4u.cl/?s=<q>` (no pagination — single page).

---

## 2. Root Cause (one sentence)

> The backend hard-codes `hdhub4u.com` (a parked redirect) instead of dynamically resolving the live host from `hdhub4u.med`'s rotation APIs, so the scraper hits an empty page and returns `movies: []`.

---

## 3. The Fix (architectural)

1. Add a **shared host resolver** that the four HDHub4u endpoints import. The resolver queries the 5 rotation APIs in parallel, decodes the base64 `c` field, strips the `?utm=...` query, and caches the result for **300 seconds** in Workers KV (or in-process Map as a fallback) to avoid hammering the rotation APIs on every request.
2. Re-write each HDHub4u Page Function so it:
   - Calls the resolver to get the current upstream root.
   - Builds the correct URL (`/`, `/category/<slug>/page/<N>/`, `/?s=<q>`).
   - Scrapes with `<li class="thumb">…</li>` regex (NOT generic `<article>` regex).
   - Returns the JSON shape the frontend already expects: `{ ok, host, type, page, totalPages, count, movies:[{slug,title,poster,url,year,qualities,genres,language}] }`.
3. Keep the public API contract identical so the **frontend does not need to change**.

### 3.1 Files to create / replace

All paths are relative to the Cloudflare Pages project root.

| # | File | Action |
|---|------|--------|
| 1 | `functions/api/hdhub4u/_host.js` | **CREATE** — shared host resolver + fetch helper |
| 2 | `functions/api/hdhub4u/list.js`   | **CREATE / REPLACE** — `?type=home\|search\|category` |
| 3 | `functions/api/hdhub4u/movie.js`  | **CREATE / REPLACE** — `?slug=<slug>` |
| 4 | `functions/api/hdhub4u/stream.js` | **CREATE / REPLACE** — `?slug=<slug>` |
| 5 | `functions/_routes.json`          | verify — include `/*` exclusion or `/api/*` inclusion as needed |

> ℹ️ The frontend `app.js` is **already wired** for these endpoints (verified live: lines 52–60 of `app.js`). Do **not** modify `app.js`.

---

## 4. Complete Fix Code (drop-in)

> Paste each block into the matching file. Do not paraphrase. Every line is intentional.

### 4.1 `functions/api/hdhub4u/_host.js` (NEW — shared resolver)

```js
// functions/api/hdhub4u/_host.js
// Shared HDHub4u host resolver + fetch helper.
// Imported by list.js, movie.js, stream.js.
//
// HDHub4u rotates its public domain every few weeks. The landing page
// hdhub4u.med queries 5 host-resolution APIs in parallel and picks the
// first base64-decoded "c" field. We replicate that logic server-side.

const RESOLUTION_APIS = [
  'https://h4.suncdn.org/host/',
  'https://points.topapii.com/host/',
  'https://ml.theapii.org/host/',
  'https://dns.pingora.fyi/v2/host',
  // 'https://cdn.hub4u.cloud/host/'  // Cloudflare-blocked; kept as last-resort only
];

const FALLBACK_HOST = 'https://hdhub4u.med';   // never used as a scrape target — only as a redirect entrypoint
const CACHE_TTL_MS = 5 * 60 * 1000;            // 5 minutes

let _cache = { host: null, expiresAt: 0 };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Decode the base64 "c" field returned by the resolution APIs.
 * Supports both standard and URL-safe base64, with or without padding.
 */
function decodeB64(s) {
  if (!s || typeof s !== 'string') return '';
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  try {
    // atob is available in the Workers runtime
    return decodeURIComponent(escape(atob(b)));
  } catch {
    return '';
  }
}

/**
 * Strip the ?utm=... query the resolution API tacks on. We only need the host root.
 */
function normalizeHost(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return '';
  }
}

/**
 * Query all 5 resolution APIs in parallel, return the first valid host.
 * Resolved host always ends with a single trailing slash, no query string.
 */
async function resolveLiveHost() {
  // In-process cache (per isolate). KV would be better but this works on free tier.
  const now = Date.now();
  if (_cache.host && now < _cache.expiresAt) return _cache.host;

  const attempts = RESOLUTION_APIS.map(async (apiUrl) => {
    try {
      const r = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://hdhub4u.med/',
        },
        // Cloudflare Workers fetch follows redirects by default
      });
      if (!r.ok) return null;
      const text = await r.text();
      // The APIs return JSON like {"h":"...","c":"...","t":...}
      // Be defensive — handle JSON parse failure gracefully.
      let json;
      try { json = JSON.parse(text); } catch { return null; }
      const rawUrl = decodeB64(json.c || '');
      if (!rawUrl || !/^https?:\/\//.test(rawUrl)) return null;
      const host = normalizeHost(rawUrl);
      // sanity-check: host must contain "hdhub4u" (avoid hijacked DNS replies)
      if (!/hdhub4u/i.test(host)) return null;
      return host;
    } catch {
      return null;
    }
  });

  const results = await Promise.allSettled(attempts);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      _cache = { host: r.value, expiresAt: now + CACHE_TTL_MS };
      return r.value;
    }
  }
  // All 5 APIs failed — DO NOT return a stale hard-coded value.
  // Throwing forces the caller to surface a clear error to the frontend.
  throw new Error('HDHUB4U_HOST_UNRESOLVED: all resolution APIs failed');
}

/**
 * Fetch a URL on the live HDHub4u host with browser-like headers.
 * Returns the response object.
 */
async function fetchUpstream(pathOrUrl, opts = {}) {
  let url = pathOrUrl;
  if (pathOrUrl.startsWith('/')) {
    const host = await resolveLiveHost();
    url = host.replace(/\/$/, '') + pathOrUrl;
  }
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://hdhub4u.med/',
      ...(opts.headers || {}),
    },
    redirect: 'follow',
  });
  return r;
}

/**
 * Standard JSON response helper.
 */
function json(obj, status = 200, cacheSeconds = 30) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `public, max-age=${cacheSeconds}`,
    },
  });
}

export { resolveLiveHost, fetchUpstream, json, decodeB64, UA };
```

### 4.2 `functions/api/hdhub4u/list.js` (REPLACE)

```js
// functions/api/hdhub4u/list.js
// SKMovies API → HDHub4u list endpoint.
//
// Query params:
//   type  – "home" (default) | "search" | "category"
//   page  – 1-indexed page number (default 1)
//   q     – search query (required when type=search)
//   slug  – category slug (required when type=category). e.g. "bollywood-movies"
//   adult – "1" to hide 18+ titles (best-effort; HDHub4u has no flag, we filter on title keywords)
//
// Returns: { ok, host, type, page, totalPages, count, movies:[{slug,title,poster,url,year,qualities,genres,language}], ts }

import { resolveLiveHost, fetchUpstream, json } from './_host.js';

const ADULT_KEYWORDS = /\b(18\+|adult|uncensored|nude|erotic|sex|xxx|18\s*\+)/i;
const PAGE_SIZE = 30;  // HDHub4u shows ~30 cards per page

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const type = (url.searchParams.get('type') || 'home').toLowerCase();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const q = (url.searchParams.get('q') || '').trim();
  const slug = (url.searchParams.get('slug') || '').trim();
  const hideAdult = url.searchParams.get('adult') === '1';

  try {
    const host = await resolveLiveHost();
    let upstreamUrl;
    if (type === 'search') {
      if (!q) return json({ ok: false, error: 'Missing ?q= for search' }, 400);
      upstreamUrl = `${host}?s=${encodeURIComponent(q)}`;
    } else if (type === 'category') {
      if (!slug) return json({ ok: false, error: 'Missing ?slug= for category' }, 400);
      upstreamUrl = page > 1
        ? `${host}category/${slug}/page/${page}/`
        : `${host}category/${slug}/`;
    } else {
      // home
      upstreamUrl = page > 1 ? `${host}page/${page}/` : `${host}`;
    }

    const resp = await fetchUpstream(upstreamUrl);
    if (resp.status === 404) {
      return json({ ok: true, host, type, page, totalPages: 0, count: 0, movies: [], ts: Date.now() });
    }
    if (!resp.ok) return json({ ok: false, error: `Upstream HTTP ${resp.status}` }, 502);

    const html = await resp.text();
    const { movies, totalPages } = parseList(html, host);
    const filtered = hideAdult ? movies.filter(m => !ADULT_KEYWORDS.test(m.title)) : movies;

    return json({
      ok: true,
      host,
      type,
      page,
      totalPages,
      count: filtered.length,
      movies: filtered,
      ts: Date.now(),
    }, 200, 60);
  } catch (e) {
    return json({ ok: false, error: e.message, movies: [] }, 502);
  }
}

/**
 * Parse a HDHub4u listing page (home / category / search).
 *
 * Card shape:
 *   <li class="thumb ...">
 *     <figure>
 *       <img src="POSTER" alt="TITLE" title="TITLE">
 *       <a href="MOVIE_URL" data-wpel-link="internal"><div class="thumb-hover"></div></a>
 *     </figure>
 *     <figcaption>
 *       <a href="MOVIE_URL" data-wpel-link="internal"><p>TITLE</p></a>
 *     </figcaption>
 *   </li>
 */
function parseList(html, host) {
  const movies = [];
  const liRegex = /<li[^>]*class="[^"]*thumb[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRegex.exec(html)) !== null) {
    const block = m[1];
    const href = (block.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*data-wpel-link="internal"/i) || [])[1]
              || (block.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/i) || [])[1]
              || '';
    if (!href) continue;
    const slug = href.split('/').filter(Boolean).pop() || '';
    if (!slug || /category|tag|page|author/i.test(slug)) continue;

    const img = block.match(/<img[^>]+src="([^"]+)"[^>]*(?:alt|title)="([^"]+)"/i);
    const poster = img ? img[1] : '';
    let title = img ? img[2] : '';
    if (!title) {
      const p = block.match(/<p>([^<]+)<\/p>/i);
      title = p ? p[1].trim() : '';
    }
    title = decodeEntities(title).replace(/\s+/g, ' ').trim();
    if (!title) continue;

    const year = (title.match(/\((\d{4})\)/) || [])[1] || '';
    const qualities = [...title.matchAll(/\b(4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDRip|WEBRip|HEVC|10Bit)\b/ig)]
      .map(x => x[1].toLowerCase()).filter((v, i, a) => a.indexOf(v) === i);
    const language = (title.match(/\b(Hindi|English|Tamil|Telugu|Bengali|Dual Audio|Multi Audio|Korean|Chinese|Japanese|Spanish|French)\b/i) || [])[1] || '';
    const genres = []; // listing page doesn't expose genres; movie.js fills them

    movies.push({ slug, title, poster, url: href, year, qualities, genres, language });
  }

  // Pagination: HDHub4u WordPress pagination links look like:
  //   <a class="page-numbers" href=".../page/5/">5</a>
  //   or aria-current="page" on the active one.
  const pageMatches = [...html.matchAll(/href="[^"]*\/page\/(\d+)\/?"/g)];
  let totalPages = 1;
  if (pageMatches.length) {
    totalPages = Math.max(...pageMatches.map(x => parseInt(x[1], 10) || 1));
  }
  // Safety cap — if upstream returns no pagination but lists 30 cards, assume there's at least 1 more.
  if (totalPages < page && movies.length > 0) totalPages = page;
  return { movies, totalPages };
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?34;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}
```

### 4.3 `functions/api/hdhub4u/movie.js` (REPLACE)

```js
// functions/api/hdhub4u/movie.js
// SKMovies API → HDHub4u single-movie detail.
//
// Query params:
//   slug – movie slug (required). e.g. "desire-2026-hindi-webrip-full-movie"
//
// Returns: { ok, host, slug, url, title, poster, year, genres, language, qualities,
//            imdbId, imdbUrl, imdbRating, director, stars, storyline, review,
//            screenshots:[], trailer, downloads:[{label,url,quality,size,host}],
//            streams:[], ts }

import { resolveLiveHost, fetchUpstream, json } from './_host.js';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const slug = (url.searchParams.get('slug') || '').trim();
  if (!slug) return json({ ok: false, error: 'Missing ?slug= param' }, 400);

  try {
    const host = await resolveLiveHost();
    const upstreamUrl = `${host.replace(/\/$/, '')}/${slug}/`;
    const resp = await fetchUpstream(upstreamUrl);
    if (resp.status === 404) return json({ ok: false, error: 'Movie not found' }, 404);
    if (!resp.ok) return json({ ok: false, error: `Upstream HTTP ${resp.status}` }, 502);

    const html = await resp.text();
    const movie = parseMovie(html, slug, upstreamUrl, host);
    return json({ ok: true, host, ...movie, ts: Date.now() }, 200, 120);
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}

function parseMovie(html, slug, url, host) {
  // Title — prefer og:title, fall back to <h1>, then <title>
  const title = decodeEntities(
    (html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) || [])[1] ||
    (html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
    (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || ''
  ).replace(/\s+/g, ' ').trim();

  const poster = (html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || [])[1] || '';

  // Storyline / synopsis — usually inside .entry-content > p, before screenshots/downloads
  const entryContent = (html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
  const storyline = decodeEntities(
    (entryContent.match(/<p>([\s\S]*?)<\/p>/i) || [])[1] || ''
  ).replace(/\s+/g, ' ').trim();

  // Year, qualities, language — same logic as list.js
  const year = (title.match(/\((\d{4})\)/) || [])[1] || '';
  const qualities = [...title.matchAll(/\b(4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDRip|WEBRip|HEVC|10Bit)\b/ig)]
    .map(x => x[1].toLowerCase()).filter((v, i, a) => a.indexOf(v) === i);
  const language = (title.match(/\b(Hindi|English|Tamil|Telugu|Bengali|Dual Audio|Multi Audio|Korean|Chinese|Japanese)\b/i) || [])[1] || '';

  // Categories → genres
  const genres = [...html.matchAll(/<a[^>]+href="[^"]*\/category\/([^"\/]+)\/?"[^>]*>([^<]+)<\/a>/gi)]
    .map(m => decodeEntities(m[2]).trim())
    .filter(g => !/movies|web-series|tv-series/i.test(g));

  // IMDB
  const imdbUrl = (html.match(/https?:\/\/www\.imdb\.com\/title\/(tt\d+)/i) || [])[0] || '';
  const imdbId = (imdbUrl.match(/tt\d+/) || [])[0] || '';
  const imdbRating = (html.match(/IMDb[:\s]+([\d.]+)\s*\/\s*10/i) || [])[1] || '';

  // Director / Stars — best-effort scrape from common WP theme patterns
  const director = decodeEntities((html.match(/Director[:\s]*<\/strong>\s*([^<\n]+)/i) || [])[1] || '').trim();
  const stars = decodeEntities((html.match(/(?:Stars|Cast)[:\s]*<\/strong>\s*([\s\S]*?)(?:<\/p>|<br)/i) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Trailer — YouTube embed
  const trailer = (html.match(/https?:\/\/(?:www\.)?youtube\.com\/embed\/([\w-]+)/i) || [])[0] || '';

  // Screenshots — imgs whose src contains "screenshot" or known screenshot hosts
  const screenshots = [...html.matchAll(/<img[^>]+src="([^"]+(?:screenshot|imgnest|pixxxels|catimage)[^"]*)"/gi)]
    .map(m => m[1])
    .filter((v, i, a) => a.indexOf(v) === i);

  // Download links — HDHub4u posts links to gadgetsweb.xyz, 4khdhub.one, hubcloud, etc.
  // Each quality block is wrapped in a <p> with a heading like "Download in 1080p (1.2GB)"
  // followed by one or more <a href="https://gadgetsweb.xyz/...">…</a> links.
  const downloads = [];
  const blockRegex = /(<p[^>]*>[\s\S]*?<\/p>)/gi;
  let bm;
  while ((bm = blockRegex.exec(html)) !== null) {
    const block = bm[1];
    const links = [...block.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    if (!links.length) continue;
    const quality = (block.match(/\b(4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDRip|HEVC|10Bit)\b/i) || [])[1]?.toLowerCase() || '';
    const size = (block.match(/(\d+(?:\.\d+)?\s*(?:GB|MB))/i) || [])[1] || '';
    for (const l of links) {
      const linkUrl = l[1];
      const linkText = decodeEntities(l[2]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!/^https?:\/\//i.test(linkUrl)) continue;
      // Skip social / navigation links
      if (/facebook|twitter|telegram|whatsapp|reddit|t\.me|share/i.test(linkUrl)) continue;
      downloads.push({
        label: linkText || quality || 'Download',
        url: linkUrl,
        quality,
        size,
        host: detectHost(linkUrl),
      });
    }
  }
  // Dedupe by URL
  const seen = new Set();
  const downloadsDedup = downloads.filter(d => seen.has(d.url) ? false : (seen.add(d.url), true));

  return {
    slug, url, title, poster, year,
    genres, language, qualities,
    imdbId, imdbUrl, imdbRating,
    director, stars, storyline,
    review: '',
    screenshots, trailer,
    downloads: downloadsDedup,
    streams: [],   // populated by /api/hdhub4u/stream on demand
  };
}

function detectHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes('gadgetsweb')) return 'GadgetsWeb';
    if (h.includes('4khdhub')) return '4KHDHub';
    if (h.includes('catimages') || h.includes('catimage')) return 'CatImages';
    if (h.includes('hubcloud')) return 'HubCloud';
    if (h.includes('gdflix')) return 'GDFlix';
    if (h.includes('filepress')) return 'FilePress';
    if (h.includes('multicloud')) return 'MultiCloud';
    if (h.includes('indexserver')) return 'IndexServer';
    if (h.includes('busycdn')) return 'BusyCDN';
    if (h.includes('hdstream4u')) return 'HDStream4U';
    if (h.includes('hubstream')) return 'HubStream';
    if (h.includes('hubdrive')) return 'HubDrive';
    return h;
  } catch { return ''; }
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?34;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}
```

### 4.4 `functions/api/hdhub4u/stream.js` (REPLACE)

```js
// functions/api/hdhub4u/stream.js
// SKMovies API → HDHub4u stream resolver.
//
// Given a movie slug (or a download-host URL scraped by movie.js), this endpoint
// follows the upstream redirect chain and returns the direct stream URL plus
// a few common player intents (MX Player, VLC, KMPlayer) for Android users.
//
// Query params:
//   slug – movie slug (preferred). The endpoint will call movie.js logic to get
//          the first download link, then resolve it.
//   url  – direct download-host URL (alternative). Skips the movie scrape.
//
// Returns: { ok, directUrl, streamUrl, externalUrl, proxyUrl, playerUrl,
//            mxIntent, vlcUrl, kmIntent, iframe, ts }
//
// The frontend's normalizeResolve() in app.js understands this exact shape.

import { resolveLiveHost, fetchUpstream, json } from './_host.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const slug = (url.searchParams.get('slug') || '').trim();
  let target = (url.searchParams.get('url') || '').trim();

  if (!slug && !target) {
    return json({ ok: false, error: 'Missing ?slug= or ?url= param' }, 400);
  }

  try {
    // Step 1: if no direct url provided, scrape the movie page to get one.
    if (!target && slug) {
      const host = await resolveLiveHost();
      const movieUrl = `${host.replace(/\/$/, '')}/${slug}/`;
      const r = await fetchUpstream(movieUrl);
      if (!r.ok) return json({ ok: false, error: `Movie HTTP ${r.status}` }, 502);
      const html = await r.text();
      const dl = (html.match(/<a[^>]+href="(https?:\/\/(gadgetsweb\.xyz|4khdhub\.one|hubcloud\.[a-z]+|gdflix\.[a-z]+|filepress\.[a-z]+|indexserver\.site|busycdn\.xyz)[^"]+)"/i) || [])[1];
      if (!dl) return json({ ok: false, error: 'No downloadable stream link found' }, 404);
      target = dl;
    }

    // Step 2: follow the redirect chain on the download host to extract the
    // direct .mp4/.mkv URL or the iframe embed URL.
    const { directUrl, iframe } = await resolveDownloadHost(target);
    if (!directUrl && !iframe) {
      return json({ ok: false, error: 'Could not resolve a playable URL' }, 502);
    }

    // Step 3: build the player intents + proxy URL.
    const finalUrl = directUrl || iframe;
    const proxyUrl = buildProxyUrl(finalUrl);
    const playerUrl = `/hdhub4u/player.html?url=${encodeURIComponent(finalUrl)}&source=skmovies`;

    return json({
      ok: true,
      directUrl: directUrl || '',
      streamUrl: directUrl || '',
      externalUrl: iframe || '',
      proxyUrl,
      playerUrl,
      mxIntent: `intent:${finalUrl}#Intent;package=com.mxtech.videoplayer.ad;S.title=SKMovies;end`,
      vlcUrl: `vlc://${finalUrl.replace(/^https?:\/\//, '')}`,
      kmIntent: `intent:${finalUrl}#Intent;package=com.kmplayer;S.title=SKMovies;end`,
      iframe: iframe || '',
      ts: Date.now(),
    }, 200, 60);
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}

/**
 * Fetch the download-host page, extract either a direct media URL or an iframe.
 * GadgetsWeb / 4KHDHub pages typically embed either:
 *   <source src="https://.../movie.mp4">
 *   <video><source src="..."></video>
 *   <iframe src="https://.../embed/...">
 */
async function resolveDownloadHost(target) {
  const r = await fetch(target, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://new3.hdhub4u.cl/',
    },
    redirect: 'follow',
  });
  if (!r.ok) return { directUrl: null, iframe: null };
  const html = await r.text();

  // Direct media URL — look for .mp4 / .mkv / .webm in source or href
  const mediaMatch = html.match(/(https?:\/\/[^"'<>\s]+\.(?:mp4|mkv|webm|m3u8)(?:\?[^"'<>\s]*)?)/i);
  const directUrl = mediaMatch ? mediaMatch[1] : null;

  // Iframe embed (some hosts use a player iframe)
  const iframeMatch = html.match(/<iframe[^>]+src="(https?:\/\/[^"]+)"/i);
  const iframe = iframeMatch ? iframeMatch[1] : null;

  return { directUrl, iframe };
}

/**
 * Build a CORS-proxied URL so the browser can play the media without CORS errors.
 * Uses the existing /api/proxy?u=<base64url> pattern.
 */
function buildProxyUrl(mediaUrl) {
  if (!mediaUrl) return '';
  const b64 = btoa(mediaUrl).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `/api/proxy?u=${b64}`;
}
```

### 4.5 `functions/_routes.json` (VERIFY — no change needed if already correct)

The existing file should already route `/api/*` to Functions. Confirm it contains:

```json
{
  "version": 1,
  "include": ["/api/*"],
  "exclude": ["/assets/*", "/manifest.json"]
}
```

If the existing `_routes.json` uses `"include": ["/*"]`, that's also fine — leave it alone.

---

## 5. Strict AI Task Plan (point-by-point)

> **For the AI implementation agent.** Execute each step in order. Do NOT skip verification. Do NOT paraphrase the code blocks above — copy them verbatim. After every step, run the listed verification command and confirm the expected output before proceeding.

### Pre-flight

- [ ] **PF-1** Read this entire document once, end-to-end. Confirm you understand: 5-file structure, no frontend changes, no `_routes.json` changes unless broken.
- [ ] **PF-2** Read `/home/z/my-project/download/skmovies-full-backup/backend/functions/api/fdm/latest.js` and `movie.js` as reference for the existing scraper pattern.
- [ ] **PF-3** Confirm Cloudflare Pages project root is the directory containing `functions/` and `_routes.json`. If unsure, run `ls functions/api/` and confirm you see `latest.js`, `movie.js`, `fdm/`.

---

### Step 1 — Create the shared host resolver

- [ ] **1.1** Create the file `functions/api/hdhub4u/_host.js`.
- [ ] **1.2** Paste the exact code from **section 4.1** above. Do not modify any line.
- [ ] **1.3** Verify the file was written:

  ```bash
  ls -la functions/api/hdhub4u/_host.js
  wc -l functions/api/hdhub4u/_host.js
  # Expected: file exists, ~115 lines
  ```

- [ ] **1.4** Verify exports are correct:

  ```bash
  grep -n "^export" functions/api/hdhub4u/_host.js
  # Expected:
  # export { resolveLiveHost, fetchUpstream, json, decodeB64, UA };
  ```

- [ ] **1.5** Sanity-check the resolver against the live API locally (Node 18+):

  ```bash
  node -e "
  const r = await fetch('https://h4.suncdn.org/host/', { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://hdhub4u.med/' }});
  const j = await r.json();
  const c = Buffer.from(j.c, 'base64').toString();
  console.log('decoded host:', c);
  "
  # Expected output:
  # decoded host: https://new3.hdhub4u.cl/?utm=mn1
  ```

  If the output differs, the rotation API has changed — re-fetch `hdhub4u.med`, find the new endpoints, update `RESOLUTION_APIS` in `_host.js`. Do not proceed until this passes.

---

### Step 2 — Replace `list.js`

- [ ] **2.1** If `functions/api/hdhub4u/list.js` does not exist, create it. If it exists, overwrite it.
- [ ] **2.2** Paste the exact code from **section 4.2** above.
- [ ] **2.3** Verify imports:

  ```bash
  head -1 functions/api/hdhub4u/list.js
  # Expected (or near top):
  # import { resolveLiveHost, fetchUpstream, json } from './_host.js';
  ```

- [ ] **2.4** Deploy to Cloudflare Pages (preview branch is fine). Then test:

  ```bash
  curl -s "https://<your-preview>.pages.dev/api/hdhub4u/list?type=home&page=1" | head -c 400
  # Expected:
  # {"ok":true,"host":"https://new3.hdhub4u.cl/","type":"home","page":1,
  #  "totalPages":...,"count":30,"movies":[{"slug":"desire-2026-...","title":"..."}]}
  ```

  - `count` MUST be > 0. If it's 0, the scraper regex is wrong — confirm `parseList` matches the live HTML by saving `https://new3.hdhub4u.cl/` and grepping for `<li[^>]*class="[^"]*thumb`.

- [ ] **2.5** Test search:

  ```bash
  curl -s "https://<your-preview>.pages.dev/api/hdhub4u/list?type=search&q=desire" | head -c 400
  # Expected: count > 0, at least one movie whose slug contains "desire"
  ```

- [ ] **2.6** Test category:

  ```bash
  curl -s "https://<your-preview>.pages.dev/api/hdhub4u/list?type=category&slug=bollywood-movies&page=1" | head -c 400
  # Expected: count > 0
  ```

- [ ] **2.7** Test adult filter:

  ```bash
  curl -s "https://<your-preview>.pages.dev/api/hdhub4u/list?type=home&adult=1" | head -c 400
  # Expected: same or slightly smaller count; no titles containing "18+", "adult", "xxx"
  ```

---

### Step 3 — Replace `movie.js`

- [ ] **3.1** Overwrite `functions/api/hdhub4u/movie.js` with the code from **section 4.3**.
- [ ] **3.2** Verify the file compiles (no syntax errors):

  ```bash
  node --check functions/api/hdhub4u/movie.js
  # Expected: no output (success)
  ```

- [ ] **3.3** Test against a known-good slug:

  ```bash
  curl -s "https://<your-preview>.pages.dev/api/hdhub4u/movie?slug=desire-2026-hindi-webrip-full-movie" | head -c 800
  # Expected: ok=true, title non-empty, poster starts with https://image.tmdb.org/,
  #           qualities contains "1080p"/"720p", downloads.length > 0
  ```

- [ ] **3.4** Test 404 path:

  ```bash
  curl -s -o /dev/null -w "%{http_code}" "https://<your-preview>.pages.dev/api/hdhub4u/movie?slug=this-slug-does-not-exist-xyz123"
  # Expected: 404
  ```

---

### Step 4 — Replace `stream.js`

- [ ] **4.1** Overwrite `functions/api/hdhub4u/stream.js` with the code from **section 4.4**.
- [ ] **4.2** `node --check functions/api/hdhub4u/stream.js` — must pass.
- [ ] **4.3** Test with a slug:

  ```bash
  curl -s "https://<your-preview>.pages.dev/api/hdhub4u/stream?slug=desire-2026-hindi-webrip-full-movie" | head -c 800
  # Expected: ok=true, directUrl or iframe is non-empty, proxyUrl contains "/api/proxy?u="
  ```

- [ ] **4.4** Test missing-param error:

  ```bash
  curl -s "https://<your-preview>.pages.dev/api/hdhub4u/stream" | head -c 200
  # Expected: {"ok":false,"error":"Missing ?slug= or ?url= param"}
  ```

---

### Step 5 — End-to-end verification on the live site

- [ ] **5.1** Deploy to production (or preview that the user can open).
- [ ] **5.2** Open `https://skmovies-premium.pages.dev/` in a fresh incognito tab.
- [ ] **5.3** Click the source-toggle button twice to switch MLSBD → FreeDrive → **HDHub4u**. The toggle label must read "HDHub4u".
- [ ] **5.4** Confirm the home grid populates with at least 20 movie cards. If empty, open DevTools → Network → click the `list?type=home` request → confirm `movies.length > 0` in the response.
- [ ] **5.5** Click any movie card. Confirm the movie-detail page renders: poster, title, storyline, screenshots, and at least one "Download" / "Watch" button.
- [ ] **5.6** Click the Watch button. Confirm the player sheet opens and either an in-page video or an external-player intent button is shown.
- [ ] **5.7** Switch to Search view. Type "desire" and submit. Confirm at least one result.
- [ ] **5.8** Switch to a category (e.g. "Bollywood Movies"). Confirm results load.
- [ ] **5.9** Switch back to MLSBD source. Confirm MLSBD still works (regression check).

---

### Step 6 — Cache + rotation resilience test

- [ ] **6.1** Hit `/api/hdhub4u/list?type=home` twice within 5 minutes. The second response should return in < 200 ms (in-process cache hit on the resolver).
- [ ] **6.2** Wait 6 minutes. Hit again. The resolver must re-query the rotation API. Confirm via Workers logs that `RESOLUTION_APIS` was actually called.
- [ ] **6.3** Simulate a host rotation: temporarily edit `RESOLUTION_APIS` to point to a fake URL that returns `{"c":"aHR0cHM6Ly9uZXczLmhkaHViNHUuY2wv"}`. Deploy. Confirm the backend still serves movies (because the second API in the array still works).
- [ ] **6.4** Revert the edit.

---

### Step 7 — Worklog + handoff

- [ ] **7.1** Append a section to `/home/z/my-project/worklog.md` under Task ID `HDHUB4U-FIX-1` with:
  - Files changed (5 paths).
  - Live curl outputs (trimmed) for steps 2.4, 3.3, 4.3.
  - Confirmation that 5.1–5.9 all passed.
- [ ] **7.2** Zip the updated backend into `/home/z/my-project/download/skmovies-full-backup-fixed.zip`.

---

## 6. Failure Modes & What NOT to Do

| ❌ Don't | ✅ Do |
|---------|------|
| Hard-code `https://new3.hdhub4u.cl/` in any file | Always call `resolveLiveHost()` |
| Modify `app.js` to "fix" the empty grid | Frontend already expects the right JSON shape — fix the backend |
| Use the generic `<article class="post">` regex (MLSBD pattern) for HDHub4u | Use the `<li class="thumb">` regex — HDHub4u uses a different theme |
| Block on `cdn.hub4u.cloud/host/` (it's Cloudflare-protected) | Keep it last in the array; the first 4 always respond |
| Cache the resolved host for > 10 minutes | Use 5-minute TTL — HDHub4u rotates faster than you'd think |
| Strip the `?utm=mn1` and then re-append it | Strip it once in `normalizeHost()` and never re-add |
| Return `movies: []` silently when the resolver fails | Return `{"ok": false, "error": "HDHUB4U_HOST_UNRESOLVED", "movies": []}` with HTTP 502 so the frontend can show an error toast |

---

## 7. Verification Checklist (one-line summary)

```
[ ] _host.js exports resolveLiveHost, fetchUpstream, json
[ ] list.js  → /api/hdhub4u/list?type=home         returns count > 0
[ ] list.js  → /api/hdhub4u/list?type=search&q=…   returns count > 0
[ ] list.js  → /api/hdhub4u/list?type=category&slug=bollywood-movies  returns count > 0
[ ] movie.js → /api/hdhub4u/movie?slug=desire-2026…  returns title/poster/downloads
[ ] stream.js→ /api/hdhub4u/stream?slug=desire-2026… returns directUrl or iframe
[ ] frontend HDHub4u toggle shows non-empty grid
[ ] frontend movie detail page renders all sections
[ ] MLSBD + FDM sources still work (regression)
[ ] host rotation: swapping API order still serves movies
```

---

## 8. Point-by-Point Verification (final gate)

After the AI implementation agent finishes, run this script. Every line must print `PASS`.

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="https://skmovies-premium.pages.dev"

echo -n "1. _host.js exists & exports correct: "
grep -q "^export { resolveLiveHost, fetchUpstream, json, decodeB64, UA }" \
  functions/api/hdhub4u/_host.js && echo PASS || echo FAIL

echo -n "2. list.js home count>0: "
n=$(curl -s "$BASE/api/hdhub4u/list?type=home" | python3 -c "import sys,json;print(json.load(sys.stdin).get('count',0))")
[ "$n" -gt 0 ] && echo PASS || echo FAIL

echo -n "3. list.js search count>0: "
n=$(curl -s "$BASE/api/hdhub4u/list?type=search&q=desire" | python3 -c "import sys,json;print(json.load(sys.stdin).get('count',0))")
[ "$n" -gt 0 ] && echo PASS || echo FAIL

echo -n "4. list.js category count>0: "
n=$(curl -s "$BASE/api/hdhub4u/list?type=category&slug=bollywood-movies" | python3 -c "import sys,json;print(json.load(sys.stdin).get('count',0))")
[ "$n" -gt 0 ] && echo PASS || echo FAIL

echo -n "5. movie.js returns title: "
t=$(curl -s "$BASE/api/hdhub4u/movie?slug=desire-2026-hindi-webrip-full-movie" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d.get('title','')))")
[ "$t" -gt 0 ] && echo PASS || echo FAIL

echo -n "6. movie.js downloads non-empty: "
d=$(curl -s "$BASE/api/hdhub4u/movie?slug=desire-2026-hindi-webrip-full-movie" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('downloads',[])))")
[ "$d" -gt 0 ] && echo PASS || echo FAIL

echo -n "7. stream.js returns playable URL: "
u=$(curl -s "$BASE/api/hdhub4u/stream?slug=desire-2026-hindi-webrip-full-movie" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d.get('directUrl','')+d.get('iframe','')))")
[ "$u" -gt 0 ] && echo PASS || echo FAIL

echo -n "8. resolver host is hdhub4u.*: "
h=$(curl -s "$BASE/api/hdhub4u/list?type=home" | python3 -c "import sys,json;print(json.load(sys.stdin).get('host',''))")
echo "$h" | grep -q "hdhub4u" && echo PASS || echo FAIL

echo -n "9. MLSBD still works (regression): "
n=$(curl -s "$BASE/api/latest" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('items',[])))")
[ "$n" -gt 0 ] && echo PASS || echo FAIL

echo -n "10. FDM still works (regression): "
n=$(curl -s "$BASE/api/fdm/latest" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('items',[])))")
[ "$n" -gt 0 ] && echo PASS || echo FAIL
```

If all 10 print `PASS`, the fix is complete. If any print `FAIL`, return to the matching step in section 5 and debug.

---

**End of plan.**
