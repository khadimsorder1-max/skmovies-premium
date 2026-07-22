# SKMovies × HDHub4u — Real-Time Issue Analysis + Strict AI Task Plan

**Document version:** 1.0  
**Captured live:** 2026-07-21 (Asia/Dhaka)  
**Target site:** `https://skmovies-premium.pages.dev/`  
**Affected feature:** HDHub4u source toggle (top-right "MLSBD / FreeDrive / HDHub4u" switch)  
**Symptom:** Selecting HDHub4u source → movie grid is empty / page is blank. No error in UI; console shows `count: 0, movies: []` from `/api/hdhub4u/list`.

---

## 0. Executive Summary (TL;DR)

The SKMovies backend's HDHub4u scraper is pointed at a **dead/parked HDHub4u domain** (`hdhub4u.yachts` → 301 → `hdhub4u.med` static SEO landing → 0 movies). The actual live HDHub4u movie database is served from a **rotating host** that the upstream landing page (`hdhub4u.med`) resolves dynamically via 4 hidden JSON APIs. As of capture time, the live host is `https://new3.hdhub4u.cl/`, a WordPress site whose search is powered by a public Typesense endpoint at `https://search.pingora.fyi/collections/post/documents/search`.

**Fix:** Replace the hardcoded host with a **runtime host resolver** that calls `https://h4.suncdn.org/host/` (with 3 fallbacks), decodes the base64 `c` field, and uses that as the upstream root for all scraping. Search must use the Typesense API directly (the WP `/?s=` endpoint returns a JS-only skeleton, no server-rendered results).

**Estimated effort:** ~3-5 hours for a competent AI agent. 7 new/modified backend files, 0 frontend changes required (frontend already calls `/api/hdhub4u/*` correctly).

---

## Part 1 — Real-Time Issue Analysis

### 1.1 Symptom (user-visible)

1. User opens `https://skmovies-premium.pages.dev/`
2. Clicks the source-toggle button in the header
3. Source cycles `MLSBD → FreeDrive → HDHub4u`
4. When `HDHub4u` is selected: section title shows "HDHub4u" (or similar), the movies grid is **completely empty**, no skeletons, no error toast.
5. All HDHub4u sub-features also return empty: Latest, Trending, Search, Category, Movie Detail.

### 1.2 Root-cause chain (live evidence)

| Step | Probe | Result | Verdict |
|---|---|---|---|
| 1 | `GET /api/hdhub4u/list?type=home` | `{"host":"https://hdhub4u.com/","count":0,"movies":[]}` | ❌ Backend returns 0 movies |
| 2 | `GET /api/hdhub4u/list?type=search&q=dunki` | `{"error":"Failed to fetch list","message":"Search API HTTP 403"}` | ❌ Search fails with 403 |
| 3 | `GET https://hdhub4u.com/` (direct) | HTTP 302, 11-byte body | ❌ Dead redirect |
| 4 | `GET https://hdhub4u.yachts/` (older hardcoded host) | HTTP 301 → `https://filmyfly.cl` | ❌ Redirects to unrelated domain |
| 5 | `GET https://filmyfly.cl/` | HTTP 200, body is just `<title>Index of /</title>` — empty directory listing | ❌ No movie content |
| 6 | `GET https://hdhub4u.med/` (the actual current landing) | HTTP 200, 38 KB static SEO article, **0 movie links**, **0 `<article>` tags** | ❌ Landing page only |

**Conclusion:** Every hardcoded host the backend might be using (`hdhub4u.yachts`, `hdhub4u.com`, `hdhub4u.med`) leads to either a redirect, a parked page, or a static landing page with no movie database. None of them serve the actual WordPress movie catalogue.

### 1.3 HDHub4u's own dynamic host-rotation system (discovered)

The `hdhub4u.med` landing page's inline JavaScript contains an obfuscated host-resolution mechanism. Deobfuscated, it does this on every page load:

```js
const RESOLUTION_ENDPOINTS = [
  'https://h4.suncdn.org/host/',
  'https://points.topapii.com/host/',
  'https://ml.theapii.org/host/',
  'https://dns.pingora.fyi/v2/host',
  'https://cdn.hub4u.cloud/host/'   // Cloudflare-blocked, ignore
];
// Try each in sequence (with rotation), pick first that returns valid JSON
// Response shape: { h: '<base64>', c: '<base64>', t: <epoch_seconds> }
// h = landing host (e.g. "hdhub4u.med")
// c = current live movie host URL (e.g. "https://new3.hdhub4u.cl/?utm=mn1")
```

Live verification (2026-07-21):

```
GET https://h4.suncdn.org/host/?v=2026072100
→ { "h":"aGRodWI0dS5tZWQ=", "c":"aHR0cHM6Ly9uZXczLmhkaHViNHUuY2wvP3V0bT1tbjE=", "t":1784595710 }

Decoded:
  h = "hdhub4u.med"
  c = "https://new3.hdhub4u.cl/?utm=mn1"
```

All 4 working endpoints return identical `h`/`c` values. The host rotates every few weeks (historical pattern: `new.hdhub4u.cl` → `new2.hdhub4u.cl` → `new3.hdhub4u.cl` → …). **Any hardcoded host will eventually break.**

### 1.4 The actual live movie site — `new3.hdhub4u.cl`

WordPress + LiteSpeed + Cloudflare. Confirmed working:

| Probe | HTTP | Size | Notes |
|---|---|---|---|
| `GET /` | 200 | 296 KB | Homepage with 16+ movie cards per page, real categories |
| `GET /page/2/` | 200 | 59 KB | Pagination works |
| `GET /category/bollywood-movies/` | 200 | 244 KB | Category listing, 16 per page |
| `GET /category/bollywood-movies/page/2/` | 200 | 54 KB | Category pagination works |
| `GET /?s=dunki` | 301 → `/search.html?q=dunki` | — | WP search redirects to `.html` endpoint |
| `GET /search.html?q=dunki` | 200 | 27 KB | **JS-only skeleton**, results loaded via XHR |
| `GET /23-000-lives-2026-hindi-webrip-full-movie/` | 200 | 390 KB | Full movie detail page |

**Critical discovery:** `/?s=` and `/search.html` return an HTML skeleton with no server-rendered results. The actual search runs against a public **Typesense** search API:

```
GET https://search.pingora.fyi/collections/post/documents/search?q=dunki&query_by=post_title&per_page=15&page=1
```

Returns standard Typesense JSON: `{ found, hits[], page, out_of }`. Each `hit.document` contains `post_title`, `permalink` (e.g. `/dunki-2023-hindi-webrip-full-movie/`), `post_thumbnail`, `category[]`, `director[]`, `stars[]`, `imdb_id`, `post_date`. Total index: `out_of: 14024` documents.

### 1.5 Why the existing SKMovies backend breaks (inferred)

The Cloudflare Pages Functions source for `/api/hdhub4u/*` is not public. Observed behavior is consistent with this implementation:

```js
// BROKEN — what the live backend appears to do
const HARDCODED_HOST = 'https://hdhub4u.yachts/';   // or .com / .med
const html = await fetch(HARDCODED_HOST).then(r => r.text());
const movies = parseWpList(html);   // returns [] because landing page has no <article>
return { host: HARDCODED_HOST, count: movies.length, movies };
```

For search, the backend likely hits `https://hdhub4u.yachts/?s=...` → 301 → `filmyfly.cl/?s=...` → 403 (filmyfly has no WP search). Hence `"Search API HTTP 403"`.

### 1.6 Frontend contract (must be preserved)

From the deployed `app.js` (v3.3.8), the frontend's HDHub4u code paths:

```js
// getApi() returns these endpoints when state.source === 'hdhub4u'
{
  latest:   '/api/hdhub4u/list?type=home',
  trending: '/api/hdhub4u/list?type=home',          // same as latest for hdhub4u
  search:   '/api/hdhub4u/list?type=search',
  category: '/api/hdhub4u/list?type=category',
  movie:    '/api/hdhub4u/movie',
  resolve:  '/api/hdhub4u/stream',
  img:      '/api/img',
  notice:   '/api/notice',
}

// Response normalisation helpers in app.js:
function respItems(r) { return (r && (r.movies || r.items)) || []; }
function respHasMore(r) {
  if (typeof r.totalPages !== 'undefined') return state.page < r.totalPages;
  if (typeof r.hasMore !== 'undefined') return r.hasMore;
  return false;
}
```

So the backend MUST return:
- List endpoints: `{ host, type, page, totalPages, count, movies[], ts, _cache }`
- Movie endpoint: `{ slug, title, poster, year, genres[], director, cast[], synopsis, screenshots[], downloads[] }`
- Stream endpoint: `{ ok, urls[], hosts[] }` (mirrors MLSBD/FDM resolve shape — frontend calls this for Play/Download sheet)

Item shape (per movie in list):
```js
{ slug, title, poster, year, type:'Movie' }
```

---

## Part 2 — Fix Strategy

### 2.1 Core principle

**Never hardcode the host.** Resolve it at request time via the upstream JSON API, cache for 5 minutes in Cloudflare KV (or in-memory if KV unavailable), and fall back to the next resolver on failure.

### 2.2 Upstream endpoints to use

| Purpose | URL | Method | Fallback chain |
|---|---|---|---|
| Host resolution | `https://h4.suncdn.org/host/` | GET | → `points.topapii.com` → `ml.theapii.org` → `dns.pingora.fyi/v2/host` |
| Home / category list | `{resolvedHost}/` and `{resolvedHost}/category/<slug>/page/<n>/` | GET (HTML) | — |
| Search | `https://search.pingora.fyi/collections/post/documents/search?q=<q>&query_by=post_title&per_page=15&page=<n>` | GET (JSON) | — |
| Movie detail | `{resolvedHost}/<slug>/` | GET (HTML) | — |
| Screenshot / poster proxying | existing `/api/img` and `/api/proxy` | — | Already handled by existing endpoints |

### 2.3 WordPress HTML selectors (verified against `new3.hdhub4u.cl`)

**List page (home or category):**

```
Movie card container:    <li class="thumb col-md-2 col-sm-4 col-xs-6">
Movie link (href):       <a href="https://new3.hdhub4u.cl/<slug>/" data-wpel-link="internal">
Movie title text:        <a ...><p>TITLE TEXT</p></a>   (inside <figcaption>)
Poster image URL:        <img src="..." alt="..." title="...">
Pagination:              <a href=".../page/N/"> present when more pages exist
```

Regex pattern that captures all movie cards on a list page:
```regex
<li class="thumb[^"]*"[^>]*>[\s\S]*?href="https?://[^"]*/([^/]+)/"[^>]*>[\s\S]*?<p>([^<]+)</p>[\s\S]*?</li>
```
(Split into 3 separate captures in code for robustness — see Phase 2.)

**Movie detail page:**

```
Title:        <h1><span class="material-text">TITLE</span></h1>
Poster:       <meta property="og:image" content="...">
Storyline:    Text after a <strong>StoryLine</strong> heading, up to next heading
Categories:   Find <strong>Genre:</strong> ... text  (single-line, comma-separated)
Director:     <strong>Director:</strong> TEXT
Stars/Cast:   <strong>Stars:</strong> TEXT (comma-separated)
Quality:      Extract from title via regex  \b(480p|720p|1080p|2160p|4K)\b  (case-insensitive)
Year:         Extract from title via regex  \((\d{4})\)
Screenshots:  All <a href="https://catimages.org/image/..."> links
Download links: All <h3>/<h4> blocks containing an outbound href
                - text becomes label (e.g. "720p 10Bit HEVC [880MB]")
                - href is the download URL (hubdrive.tips / gadgetsweb.xyz / 4khdhub.one / etc.)
```

### 2.4 Search response shape (Typesense)

```
GET https://search.pingora.fyi/collections/post/documents/search?q=dunki&query_by=post_title&per_page=15&page=1

→ {
  "found": 2,
  "out_of": 14024,
  "page": 1,
  "hits": [
    {
      "document": {
        "id": "142334",
        "post_title": "Dunki (2023) WEB-DL [Hindi DD5.1] 1080p 720p & 480p [x264/10Bit-HEVC] | Full Movie",
        "permalink": "/dunki-2023-hindi-webrip-full-movie/",
        "post_thumbnail": "https://image.tmdb.org/t/p/w400/kPRb1mbVHGop0egQ7153y0lhzGL.jpg",
        "category": ["300MB Movies","BollyWood","Comedy","Drama","Netflix"],
        "director": [],
        "stars": [],
        "imdb_id": "tt15428134",
        "post_date": "February 14, 2024",
        "post_type": "post"
      }
    }
  ]
}
```

Map each `hit.document` to SKMovies item shape:
```js
{
  slug: doc.permalink.replace(/^\//,'').replace(/\/$/,''),
  title: doc.post_title,
  poster: doc.post_thumbnail,
  year: (doc.post_title.match(/\((\d{4})\)/) || [])[1] || '',
  type: 'Movie',
  url: resolvedHost.replace(/\/$/,'') + doc.permalink
}
```

### 2.5 Cloudflare bot-protection notes

`new3.hdhub4u.cl` sits behind Cloudflare. To reliably fetch HTML:

1. Always send a real browser `User-Agent` (Chrome 120+ on Windows).
2. Send `Accept-Encoding: gzip, deflate, br` (use `--compressed` in curl; in Workers, `fetch` auto-decompresses).
3. Send `Referer: https://new3.hdhub4u.cl/` for category/movie fetches.
4. If a request returns a Cloudflare challenge page (look for `<title>Just a moment...</title>` or `cf-chl-bypass`), retry once with the alternate resolver's host.

---

## Part 3 — Strict AI Task Plan

> **Executor:** AI coding agent (Claude / GPT / local LLM with file-write + shell access).  
> **Goal:** Replace the broken HDHub4u backend in `skmovies-full-backup/` with a working dynamic-host implementation.  
> **Constraint:** Do NOT touch the frontend (`frontend/app.js`, `frontend/index.html`) — it already calls the right endpoints. Only modify `backend/functions/api/hdhub4u/*` and `backend/_routes.json`.  
> **Working directory:** `/home/z/my-project/download/skmovies-full-backup/`

### Phase 0 — Pre-flight checks (5 min)

**0.1** Verify working directory exists and contains the previous backup:
```
ls /home/z/my-project/download/skmovies-full-backup/backend/functions/api/
```
Expected: `latest.js, trending.js, notice.js, search.js, category.js, south.js, movie.js, resolve.js, img.js, proxy.js, fdm/`

**0.2** Confirm live endpoints still work (re-run if any fail before proceeding):
```bash
curl -s "https://h4.suncdn.org/host/?v=$(date +%Y%m%d%H)" | python3 -m json.tool
# Must return: { h, c, t } — decode c to get current host

curl -s "https://search.pingora.fyi/collections/post/documents/search?q=dunki&query_by=post_title&per_page=3&page=1" | python3 -m json.tool
# Must return: { found, hits[], page, out_of }

curl -sL -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" \
  --compressed -H "Referer: https://new3.hdhub4u.cl/" \
  "https://new3.hdhub4u.cl/" | wc -c
# Must return: > 200000
```

If any of these fail, STOP and report — the upstream has changed again and this plan needs updating.

**0.3** Create the HDHub4u backend directory:
```bash
mkdir -p /home/z/my-project/download/skmovies-full-backup/backend/functions/api/hdhub4u
```

### Phase 1 — Host resolution helper (15 min)

**File:** `backend/functions/api/hdhub4u/_host.js`

**Exports:** `async function resolveHost(context) → string` (returns full origin URL with no trailing slash, e.g. `https://new3.hdhub4u.cl`)

**Behavior:**

1. Check `context.env.HDHUB4U_HOST_CACHE` KV namespace for a cached value (TTL 300s). If present and fresh, return it.
2. Otherwise hit each resolver in order: `h4.suncdn.org`, `points.topapii.com`, `ml.theapii.org`, `dns.pingora.fyi/v2/host`. Pass `?v=<YYYYMMDDHH>` cache-buster.
3. For each response, parse JSON, base64-decode the `c` field, strip query string and trailing slash.
4. First non-empty decoded value wins. Cache it to KV (if available) and to a module-level `let cachedHost; let cachedAt = 0;` variable as a fallback for when KV is unbound.
5. If all 4 resolvers fail, fall back to the module-level cache (even if stale). If no cache, throw `Error('All HDHub4u host resolvers failed')`.

**Hard requirements:**

- Use the Web standard `atob()` for base64 decode (available in Workers runtime).
- Set a 5-second timeout per resolver using `AbortController`.
- Never log the full URL — log only the hostname.
- The function must be idempotent and side-effect-free apart from caching.

**Skeleton:**

```js
// backend/functions/api/hdhub4u/_host.js
const RESOLVERS = [
  'https://h4.suncdn.org/host/',
  'https://points.topapii.com/host/',
  'https://ml.theapii.org/host/',
  'https://dns.pingora.fyi/v2/host',
];

let cachedHost = null;
let cachedAt = 0;
const TTL_MS = 5 * 60 * 1000;

export async function resolveHost(context) {
  const now = Date.now();

  // 1. Module-level cache
  if (cachedHost && (now - cachedAt) < TTL_MS) return cachedHost;

  // 2. KV cache (optional)
  if (context?.env?.HDHUB4U_HOST_KV) {
    try {
      const raw = await context.env.HDHUB4U_HOST_KV.get('host');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.host && (now - parsed.ts) < TTL_MS) {
          cachedHost = parsed.host;
          cachedAt = parsed.ts;
          return cachedHost;
        }
      }
    } catch (_) { /* ignore KV errors */ }
  }

  // 3. Live resolution
  const v = new Date().toISOString().slice(0,13).replace(/[-T]/g, '');
  for (const url of RESOLVERS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(`${url}?v=${v}`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (!data || !data.c) continue;
      const decoded = atob(data.c);
      const u = new URL(decoded);
      const host = `${u.protocol}//${u.host}`;  // strip path & query
      cachedHost = host;
      cachedAt = now;
      if (context?.env?.HDHUB4U_HOST_KV) {
        try { await context.env.HDHUB4U_HOST_KV.put('host', JSON.stringify({ host, ts: now })); } catch (_) {}
      }
      return host;
    } catch (_) { /* try next */ }
  }

  // 4. Stale fallback
  if (cachedHost) return cachedHost;
  throw new Error('All HDHub4u host resolvers failed');
}
```

**Acceptance:**
- `resolveHost()` returns a string like `https://new3.hdhub4u.cl` (no path, no trailing slash, no query).
- Calling it twice in 5 minutes hits the module cache the second time (no network).
- If all 4 resolvers return 500, the function throws (callers must catch and return HTTP 502).

### Phase 2 — List endpoint (home / category / search) (40 min)

**File:** `backend/functions/api/hdhub4u/list.js`

**Route:** `GET /api/hdhub4u/list?type=<home|category|search>&page=<n>&category=<slug>&q=<query>`

**Behavior by `type`:**

| `type` | Upstream | Parser |
|---|---|---|
| `home` | `GET {host}/page/<page>/` (page 1 = `{host}/`) | `parseWpList(html)` |
| `category` | `GET {host}/category/<category>/page/<page>/` | `parseWpList(html)` |
| `search` | `GET https://search.pingora.fyi/collections/post/documents/search?q=<q>&query_by=post_title&per_page=15&page=<page>` | `parseTypesense(json)` |

**Headers to send on HTML fetches (REQUIRED):**
```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
Accept-Language: en-US,en;q=0.5
Accept-Encoding: gzip, deflate, br
Referer: {host}/
```

**Response shape (must match frontend contract):**
```js
{
  host: 'https://new3.hdhub4u.cl',
  type: 'home' | 'category' | 'search',
  page: 1,
  totalPages: 12,
  count: 16,
  movies: [
    { slug, title, poster, year, type:'Movie' },
    ...
  ],
  ts: <epoch_ms>,
  _cache: 'fresh' | 'hit'
}
```

**`parseWpList(html)` implementation notes:**

1. Use the regex `<li[^>]*class="thumb[^"]*"[^>]*>([\s\S]*?)<\/li>` to split into card blocks. (Lazy match — important.)
2. For each block, extract:
   - `slug`: from `href="https?://[^"]+/(<slug>)/"` (skip if href contains `category`, `tag`, `page`, `disclaimer`, `how-to-download`, `join-our-group`, `donate`)
   - `title`: text inside `<p>...</p>` within the block (HTML-decode entities: `&#038;`→`&`, `&#8217;`→`'`, `&amp;`→`&`)
   - `poster`: from `<img src="..."` (first match in block)
   - `year`: regex `\((\d{4})\)` on title
3. `totalPages`: look for `class="pagination"` block, count `<a href=".../page/N/"` links; if no pagination block, `totalPages = 1`.

**`parseTypesense(json)` implementation notes:**

1. Parse the JSON response.
2. For each `hit.document`, build item:
   ```js
   {
     slug: doc.permalink.replace(/^\//,'').replace(/\/$/,''),
     title: decodeHtml(doc.post_title),
     poster: doc.post_thumbnail,
     year: (doc.post_title.match(/\((\d{4})\)/) || [])[1] || '',
     type: 'Movie',
     url: host + doc.permalink
   }
   ```
3. `totalPages = Math.ceil(json.found / 15)`. If `found === 0`, `totalPages = 0`.
4. If `json.message` exists (Typesense error), throw with the message — caller returns HTTP 502.

**Hard requirements:**

- HTML fetch must use `redirect: 'follow'`.
- HTML decode helper must handle: `&amp;`, `&#038;`, `&#8211;`, `&#8217;`, `&quot;`, `&#039;`, `&lt;`, `&gt;`, `&nbsp;`.
- 404 from upstream → return `{ ok:false, error:'Upstream 404' }` with HTTP 404.
- Empty result → still return `{ ok:true, count:0, movies:[], totalPages:0 }`. Never return `null`.

### Phase 3 — Movie detail endpoint (30 min)

**File:** `backend/functions/api/hdhub4u/movie.js`

**Route:** `GET /api/hdhub4u/movie?slug=<slug>`

**Upstream:** `GET {host}/<slug>/` (HTML)

**Response shape:**
```js
{
  ok: true,
  slug,
  title,
  poster,
  originalTitle: title,        // WP doesn't separate, use same
  synopsis,                    // storyline text
  genres: [],                  // from "Genre:" label
  cast: [],                    // from "Stars:" label, comma-split
  director: '',                // from "Director:" label
  downloads: [
    { quality, label, url, host }   // one per <h3>/<h4> with outbound link
  ],
  screenshots: [],
  isMultiEpisode: false,
  episodeSections: [],
  movieUrl: '<host>/<slug>/'
}
```

**Extractors (verified against live HTML):**

| Field | Regex / Strategy |
|---|---|
| title | `<h1[^>]*>[\s\S]*?<span class="material-text">[\s\S]*?<\/span>` → strip tags, decode entities |
| poster | `<meta\s+property="og:image"\s+content="([^"]+)"` |
| year | `\((\d{4})\)` from title |
| synopsis | Find `<strong>StoryLine<\/strong>` (case-insensitive), then capture text up to next `<h[1-6]` or `<div class="` |
| director | `<strong>\s*Director:\s*<\/strong>\s*([^<\n]+)` |
| cast | `<strong>\s*Stars:\s*<\/strong>\s*([^<\n]+)` → split on `,` |
| genres | `<strong>\s*Genre:\s*<\/strong>\s*([^<\n]+)` → split on `,` |
| screenshots | All `href="(https://catimages\.org/[^"]+)"` |
| downloads | All `<h[34][^>]*>([\s\S]*?)<\/h[34]>` blocks containing `href="https?://"`; for each: extract href + strip tags for label. Skip if href contains `hdhub4u.cl`, `catimages.org`, `gmpg.org`, `google.com`, `bootstrap`, `fontawesome`. Detect host from URL: `hubdrive.tips`→`HubDrive`, `gadgetsweb.xyz`→`GadgetsWeb`, `4khdhub.one`→`4KHDHub`, `gdtot`→`GDTot`, `gdflix`→`GDFlix`, `filepress`→`FilePress`, etc. |
| quality | From label: `\b(480p|720p|1080p|2160p|4K)\b` (case-insensitive) |

**Hard requirements:**

- 404 from upstream → `{ ok:false, error:'Movie not found' }` with HTTP 404.
- HTML entities decode (same helper as Phase 2).
- Empty `downloads` is allowed (return `[]`) — but log a warning.
- If the page looks like a Cloudflare challenge (`<title>Just a moment`), retry once with `Referer: {host}/` header; if still challenge, return HTTP 502 with `{ ok:false, error:'Upstream blocked by Cloudflare' }`.

### Phase 4 — Stream / resolve endpoint (20 min)

**File:** `backend/functions/api/hdhub4u/stream.js`

**Route:** `GET /api/hdhub4u/stream?url=<url>`

**Purpose:** Given a download URL extracted from a movie detail page (e.g. `https://gadgetsweb.xyz/?id=...` or `https://hubdrive.tips/file/...`), fetch the upstream page and extract the final direct-download URL.

**Implementation:**

For Phase 1 of this fix, **the stream endpoint can simply return the input URL as the only host** — the frontend will display it as a clickable download link. This is acceptable because:

- HDHub4u download URLs are already direct links (the user clicks → goes to file host → downloads).
- Unlike MLSBD's `savelinks.me` indirection, HDHub4u doesn't have a second resolution layer.
- Frontend's `playerMode === 'hdhub4u'` path opens `/hdhub4u/player.html?url=<url>` in a new tab — it just needs the raw URL.

**Response shape:**
```js
{
  ok: true,
  urls: [<input-url>],
  rawUrls: [<input-url>],
  hosts: [
    { host: '<detected>', url: '<input-url>', text: '<input-url>' }
  ],
  sourceUrl: '<input-url>',
  source: 'hdhub4u',
  fallback: null
}
```

**Host detection helper:** reuse the same `detectHost()` logic from `backend/functions/api/resolve.js` (already in the backup). Add `hubdrive.tips → 'HubDrive'`, `gadgetsweb.xyz → 'GadgetsWeb'`, `4khdhub.one → '4KHDHub'`.

**Hard requirements:**

- Missing `?url=` → 400 with `{ ok:false, error:'Missing ?url= param' }`.
- Allow-list: only accept URLs whose hostname matches the patterns in `app.js`'s `PROXY_HOST_PATTERNS` (HDHub4u section). Reject others with 403.

### Phase 5 — Routes & config (10 min)

**File:** `backend/_routes.json` — add HDHub4u routes to the include list:

```json
{
  "version": 1,
  "include": ["/api/*"],
  "exclude": ["/assets/*", "/styles.css", "/app.js", "/manifest.json", "/*.webp", "/*.png", "/*.ico"]
}
```

(Already correct — `/api/hdhub4u/*` is matched by `/api/*`.)

**File:** `backend/wrangler.toml` — add optional KV namespace binding:

```toml
[[kv_namespaces]]
binding = "HDHUB4U_HOST_KV"
id = "REPLACE_WITH_YOUR_KV_ID"   # create with: wrangler kv:namespace create HDHUB4U_HOST_KV
```

(KV is optional — the helper falls back to in-memory cache. Leave commented out for local dev.)

### Phase 6 — Frontend (NO CHANGES)

**Do NOT modify `frontend/app.js` or `frontend/index.html`.** The frontend already:

- Calls `/api/hdhub4u/list?type=home|search|category`
- Calls `/api/hdhub4u/movie?slug=<slug>`
- Calls `/api/hdhub4u/stream?url=<url>`
- Reads `r.movies` and `r.totalPages` correctly via `respItems()` / `respHasMore()`

If the AI agent modifies the frontend, **that is a bug** — revert it.

### Phase 7 — Testing (30 min)

**7.1 Unit tests (manual curl):**

```bash
# Set up local Wrangler dev server
cd /home/z/my-project/download/skmovies-full-backup/backend
cp -r ../frontend/* .
npx wrangler pages dev . --port 8788 &
sleep 5

# Test 1: host resolution
curl -s http://localhost:8788/api/hdhub4u/list?type=home | python3 -m json.tool
# Expected: count > 0, movies[] non-empty, totalPages > 0

# Test 2: category
curl -s "http://localhost:8788/api/hdhub4u/list?type=category&category=bollywood-movies&page=1" | python3 -m json.tool
# Expected: count > 0

# Test 3: search
curl -s "http://localhost:8788/api/hdhub4u/list?type=search&q=dunki" | python3 -m json.tool
# Expected: count >= 1, first movie slug contains "dunki"

# Test 4: movie detail
SLUG=$(curl -s "http://localhost:8788/api/hdhub4u/list?type=home" | python3 -c "import sys,json; print(json.load(sys.stdin)['movies'][0]['slug'])")
curl -s "http://localhost:8788/api/hdhub4u/movie?slug=$SLUG" | python3 -m json.tool
# Expected: title, poster, downloads[] non-empty

# Test 5: stream
URL=$(curl -s "http://localhost:8788/api/hdhub4u/movie?slug=$SLUG" | python3 -c "import sys,json; print(json.load(sys.stdin)['downloads'][0]['url'])")
curl -s "http://localhost:8788/api/hdhub4u/stream?url=$URL" | python3 -m json.tool
# Expected: ok:true, urls[] contains the input URL

# Test 6: error cases
curl -s "http://localhost:8788/api/hdhub4u/list" | python3 -m json.tool
# Expected: 400 with "Missing or invalid ?type= param"

curl -s "http://localhost:8788/api/hdhub4u/movie" | python3 -m json.tool
# Expected: 400 with "Missing ?slug= param"

curl -s "http://localhost:8788/api/hdhub4u/stream" | python3 -m json.tool
# Expected: 400 with "Missing ?url= param"
```

**7.2 Acceptance criteria (all must pass):**

| # | Criterion | Pass condition |
|---|---|---|
| 1 | `type=home` returns ≥10 movies | `len(movies) >= 10` |
| 2 | Each movie has non-empty `slug`, `title`, `poster` | All 3 fields truthy on every item |
| 3 | `type=search&q=dunki` returns ≥1 result containing "Dunki" in title | Case-insensitive match |
| 4 | `type=category&category=bollywood-movies` returns ≥5 movies | `len(movies) >= 5` |
| 5 | Movie detail returns non-empty `title`, `poster`, `downloads[]` | All truthy |
| 6 | Each download entry has `url`, `label`, `host`, `quality` | All 4 fields truthy |
| 7 | `totalPages` is an integer ≥1 for home/category | Not 0 |
| 8 | Response time ≤3s for any endpoint on warm cache | Measure with `time curl` |
| 9 | Frontend (manual browser test) shows movie grid on HDHub4u toggle | Visual confirmation |
| 10 | Frontend "Play" button opens movie detail without errors | Visual confirmation |

**7.3 Forbidden patterns (regression triggers):**

- ❌ Hardcoding any specific HDHub4u domain (e.g. `new3.hdhub4u.cl`) in source code. The host MUST come from `resolveHost()`.
- ❌ Using regex with greedy `.*` instead of lazy `.*?` for HTML parsing — will collapse multiple cards into one.
- ❌ Forgetting to HTML-decode entities in titles — `&#038;` will show as literal in UI.
- ❌ Skipping the `Referer` header on HTML fetches — Cloudflare will return challenge pages.
- ❌ Caching host for >5 minutes — by then a new mirror may be live.
- ❌ Returning 200 with `count:0, movies:[]` for successful (non-empty) upstream responses — indicates parser bug, must fail loudly.
- ❌ Modifying frontend files — frontend is correct as-is.
- ❌ Using `Node`-specific APIs (`fs`, `path`, `Buffer`) — must work in Cloudflare Workers runtime (Web APIs only).

### Phase 8 — Deployment (10 min)

**8.1** Re-zip the updated backup:

```bash
cd /home/z/my-project/download
rm -f skmovies-full-backup.zip
zip -r skmovies-full-backup.zip skmovies-full-backup/ -x "*.DS_Store"
```

**8.2** Deploy to Cloudflare Pages (optional — user may do this themselves):

```bash
cd /home/z/my-project/download/skmovies-full-backup/backend
cp -r ../frontend/* .
npx wrangler pages deploy . --project-name skmovies-premium
```

**8.3** Post-deploy verification:

```bash
curl -s "https://skmovies-premium.pages.dev/api/hdhub4u/list?type=home" | python3 -m json.tool
# Expected: count > 0, movies[] non-empty
```

**8.4** Update the existing `REVERSE-ENGINEERING.md` to document the new HDHub4u backend behavior, the host-resolution mechanism, and the Typesense search API.

---

## Part 4 — Reference Data

### 4.1 File structure (post-fix)

```
backend/functions/api/hdhub4u/
├── _host.js          ← NEW: host resolution helper (Phase 1)
├── list.js           ← NEW: home/category/search (Phase 2)
├── movie.js          ← NEW: movie detail (Phase 3)
└── stream.js         ← NEW: download link resolver (Phase 4)

backend/functions/api/   ← unchanged
├── latest.js, trending.js, notice.js, search.js, category.js,
├── south.js, movie.js, resolve.js, img.js, proxy.js
└── fdm/...
```

### 4.2 Live API response samples (captured 2026-07-21)

**Host resolver (`h4.suncdn.org`):**
```json
{
  "h": "aGRodWI0dS5tZWQ=",
  "c": "aHR0cHM6Ly9uZXczLmhkaHViNHUuY2wvP3V0bT1tbjE=",
  "t": 1784595710
}
```
Decoded: `h = "hdhub4u.med"`, `c = "https://new3.hdhub4u.cl/?utm=mn1"`

**Typesense search (`q=dunki`):**
```json
{
  "found": 2,
  "out_of": 14024,
  "page": 1,
  "hits": [
    {
      "document": {
        "id": "142334",
        "post_title": "Dunki (2023) WEB-DL [Hindi DD5.1] 1080p 720p & 480p [x264/10Bit-HEVC] | Full Movie",
        "permalink": "/dunki-2023-hindi-webrip-full-movie/",
        "post_thumbnail": "https://image.tmdb.org/t/p/w400/kPRb1mbVHGop0egQ7153y0lhzGL.jpg",
        "category": ["300MB Movies","BollyWood","Comedy","Drama","Netflix"],
        "imdb_id": "tt15428134",
        "post_date": "February 14, 2024",
        "post_type": "post"
      }
    }
  ]
}
```

**Movie detail extractors (verified):**

```
Title:      23 000 Lives (2026) WEB-DL [Hindi (DD5.1) & English] 4K 1080p 720p & 480p Dual Audio [x264/10Bit-HEVC] | Full Movie
Poster:     https://i1.wp.com/image.tmdb.org/t/p/w500/yHIuR7rTAbHXbELc9UqoaOIxXZx.jpg?ssl=1
Director:   Markus Goller
Stars:      Louis Hofmann, Mala Emde, Katharina Stark
Genre:      Drama
Storyline:  23 000 Lives (2026) Hindi Dubbed : Unable to stand by and watch as countless refugees lose their lives attempting to reach Europe by sea, a group of young Berliners take action...
Screenshots: 8 × https://catimages.org/image/<id>

Downloads:
  - label: "720p 10Bit HEVC [880MB]"   url: https://hubdrive.tips/file/2702016333     host: HubDrive
  - label: "720p x264 [1.1GB]"          url: https://gadgetsweb.xyz/?id=<base64>       host: GadgetsWeb
  - label: "1080p 10Bit HEVC [1.9GB]"   url: https://hubdrive.tips/file/3633040310     host: HubDrive
  - label: "1080p x264 [2.5GB]"         url: https://gadgetsweb.xyz/?id=<base64>       host: GadgetsWeb
  - label: "1080p WEB-DL [5.4GB]"       url: https://hubdrive.tips/file/4371908817     host: HubDrive
  - label: "4K [2160p SDR WEB-DL – 15.2GB]"  url: https://hubdrive.tips/file/2262377732  host: HubDrive
  - label: "4K | SDR | HDR | DV | HEVC"  url: https://4khdhub.one/23-000-lives-movie-7471/  host: 4KHDHub
```

### 4.3 Glossary

| Term | Meaning |
|---|---|
| **Source toggle** | The 3-way button in the SKMovies header that switches between MLSBD / FreeDrive / HDHub4u backends |
| **Host resolver** | HDHub4u's own JSON API (`h4.suncdn.org/host/` etc.) that returns the current live mirror domain |
| **Typesense** | The open-source search engine powering `search.pingora.fyi` — public, no auth required |
| **`c` field** | Base64-encoded URL of the current live HDHub4u host, returned by the resolver |
| **`h` field** | Base64-encoded hostname of the landing page (`hdhub4u.med`) — informational only |
| **WP `/?s=`** | WordPress's built-in search — HDHub4u's WP install redirects this to `/search.html` which is JS-only |
| **Cloudflare challenge** | The `<title>Just a moment...</title>` interstitial — indicates bot-protection triggered |
| **Pages Functions** | Cloudflare Pages' serverless function runtime — runs on Workers V8 isolates, supports Web APIs only |

### 4.4 Known unknowns / future risk

1. **Domain rotation cadence:** HDHub4u rotates mirrors every 2-6 weeks. The resolver APIs are the source of truth — if they themselves go down (all 4), the backend will fail. Mitigation: monitor + manual override env var.
2. **Typesense index coverage:** `out_of: 14024` documents. If HDHub4u migrates away from Typesense, search will break. Mitigation: detect `json.message` (error) and fall back to scraping WP `/?s=` if it ever returns server-rendered results.
3. **Cloudflare bot-score:** Aggressive scraping from a single Cloudflare Pages IP may trigger challenges. Mitigation: respect 5-min cache TTL, add jitter, and never retry more than once.
4. **Download URL lifecycle:** `gadgetsweb.xyz/?id=<base64>` URLs may expire or rotate. The stream endpoint currently passes them through unchanged. If user reports "download button doesn't work", a second resolution layer may be needed in `stream.js` — out of scope for this fix.

---

## Appendix A — Quick command reference

```bash
# Check current live HDHub4u host
T=$(date +%Y%m%d%H)
curl -s "https://h4.suncdn.org/host/?v=$T" | python3 -c "import sys,json,base64; d=json.load(sys.stdin); print(base64.b64decode(d['c']).decode())"

# Verify Typesense search
curl -s "https://search.pingora.fyi/collections/post/documents/search?q=dunki&query_by=post_title&per_page=3&page=1" | python3 -m json.tool

# Fetch live homepage HTML for parser testing
curl -sL --compressed \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" \
  -H "Referer: https://new3.hdhub4u.cl/" \
  "https://new3.hdhub4u.cl/" > /tmp/h_home.html

# Check SKMovies live HDHub4u endpoint (should show 0 movies before fix, >0 after)
curl -s "https://skmovies-premium.pages.dev/api/hdhub4u/list?type=home" | python3 -m json.tool

# Verify which domains are alive (sanity check)
for d in hdhub4u.med hdhub4u.ms hdhub4u.mn new3.hdhub4u.cl; do
  echo -n "$d → "
  curl -s -o /dev/null -w "HTTP %{http_code}\n" -m 5 "https://$d/"
done
```

---

**End of document.**
