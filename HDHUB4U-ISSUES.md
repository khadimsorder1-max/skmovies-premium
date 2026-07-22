# HDHub4u Integration — Issues & Findings

## Root Cause: Cloudflare WAF Blocks Workers

### Symptom
- All HDHub4u API endpoints return `movies: []` or `Upstream HTTP 403`
- `/api/hdhub4u/list` → `{"ok":false,"error":"Upstream HTTP 403"}`

### Why?
`new3.hdhub4u.cl` (এবং সব HDHub4u content mirror) Cloudflare-এর **Browser Integrity Check (error code 1106)** ব্যবহার করে। এটি শুধুমাত্র真實 browser-এর request accept করে — Cloudflare Workers (server-side fetch) ব্লক করে।

### পরীক্ষা Results
| Target | Workers থেকে | Local Machine থেকে |
|--------|-------------|-------------------|
| `new3.hdhub4u.cl/` | 403 (error 1106) | 200 (full HTML) |
| `h4.suncdn.org/host/` | 403 | 200 (valid JSON) |
| `points.topapii.com/host/` | 403 | 200 (valid JSON) |
| `ml.theapii.org/host/` | 403 | 200 (valid JSON) |
| `dns.pingora.fyi/v2/host` | 403 | 200 (valid JSON) |
| `cdn.hub4u.cloud/host/` | 403 | 200 (valid JSON) |
| `hdhub4u.med/` | 200 (landing page) | 200 (landing page) |
| `hdhub4u.mn/` | 200 (7KB landing) | 200 (7KB landing) |
| `hdhub4u.com/` | 200 (parked) | 200 (parked) |

- **Resolution APIs**: সব ৫টি API-ই 403 return করে (Workers ব্লক)
- **Landing pages** (`.med`, `.mn`): Accessible কিন্তু movie content নেই (শুধু redirect JS)
- **Content hosts** (`.cl`): সব 403
- **Parked domains** (`.com`): Accessible কিন্তু কোনো movie content নেই

### Bypass Attempts (সব ব্যর্থ)
1. **DoH (DNS-over-HTTPS)**: Google DoH দিয়ে IP resolve করে Host Header manipulation → 403
2. **`cf` options**: `scrapeShield: false`, `skipRUM: true`, `resolveOverride` → 403
3. **Headers Variation**: ভিন্ন User-Agent, Referer, Cookie, Accept → 403
4. **Landing page scraping**: `hdhub4u.med` থেকে base64 URL extract করে API call → 403
5. **Direct IP fetch**: DoH-প্রাপ্ত IP-তে সরাসরি connection → 403

---

## Deployment Issues

### 1. Wrong Deploy Directory
- **Problem**: `npx wrangler pages deploy .` (root directory) ব্যবহার করলে Cloudflare Pages static files serve করতে পারে না → main page 404
- **Fix**: `npx wrangler pages deploy public --project-name=skmovies-premium` ব্যবহার করতে হবে
- **Status**: ✅ Fixed

### 2. ESM import/export → CommonJS
- **Problem**: Cloudflare Pages Functions-এ `import`/`export` (ESM) syntax **কাজ করে না**। শুধুমাত্র `require()` (CommonJS) support করে
- **Affected files**: `_host.js`, `list.js`, `movie.js`, `stream.js`
- **Fix**: সব `import`/`export` → `require()`/`module.exports` + `export async function onRequest`
- **Status**: ✅ Fixed

### 3. HTTP 502 → Cloudflare Interception
- **Problem**: Cloudflare Pages Functions 5xx status code return করলে Cloudflare নিজের error page দেখায় (JSON body lost)
- **Affected**: সব error response
- **Fix**: সব response এ status 200 ব্যবহার করতে হবে, error সিগন্যাল `ok: false` field দিয়ে
- **Status**: ✅ Fixed

### 4. KV Cache Poisoned with Parked Domain
- **Problem**: `_lib.js`-এর `resolveActiveHost()` KV cache থেকে `hdhub4u.com` return করে (parked domain, no content)
- **Fix**: নতুন `_host.js`-এ parked domains ignore করা হয়েছে (`.com`, `.med`, `.ag`, etc.)
- **Status**: ✅ Fixed

---

## File Changes Summary

### `functions/api/hdhub4u/_host.js`
- **Action**: Full rewrite (CommonJS)
- **Resolver**: In-memory cache → KV cache → Env pin → Emergency fallback (`new3.hdhub4u.cl/`)
- **Note**: Resolution APIs সব 403 return করে, তাই সরাসরি fallback ব্যবহার করা হয়

### `functions/api/hdhub4u/list.js`
- **Action**: Full rewrite (CommonJS + ESM export hybrid)
- **Parser**: `<li class="thumb">` HTML scraper (same as before)
- **Improvements**: `?slug=` parameter support for categories, `adult` filter

### `functions/api/hdhub4u/movie.js`
- **Action**: Full rewrite (CommonJS)
- **Parser**: parseMovie with 5 download extraction strategies, IMDB parsing, screenshots

### `functions/api/hdhub4u/stream.js`
- **Action**: Full rewrite (CommonJS)
- **Resolver**: resolveDownloadHost + buildProxyUrl

### `functions/api/hdhub4u/proxy.js`
- **Action**: Updated domain allowlist
- **Added**: gadgetsweb.xyz, 4khdhub.one, hubcloud, gdflix, filepress, indexserver, busycdn, multicloud, catimage

---

## Solution Options

### Option 1: VPS Scraper + KV Cache (Recommended)
- VPS-এ scraper চালিয়ে HDHub4u থেকে HTML scrape করে
- Cloudflare KV-তে cached data store করে
- Workers শুধু KV থেকে data serve করে
- **Pros**: Fully automated, real-time content
- **Cons**: VPS maintenance needed

### Option 2: HDHUB4U_FORCE_HOST
- `wrangler.toml`-এ uncomment করে নির্দিষ্ট host forced করুন:
  ```toml
  [vars]
  HDHUB4U_FORCE_HOST = "https://new3.hdhub4u.cl/"
  ```
- কিংবা Cloudflare Dashboard-এ Pages → skmovies-premium → Environment variables
- **Pros**: Simple setup
- **Cons**: Host বদলালে manually update করতে হবে; Workers এখনও 403 পাবে

### Option 3: Client-Side Fetch (Frontend Modification)
- Frontend (`app.js`) modify করে browser থেকে সরাসরি HDHub4u থেকে fetch করুন
- Browser real JS challenge pass করতে পারে, তাই 403 আসবে না
- **Pros**: No VPS needed
- **Cons**: CORS issue হতে পারে; frontend modification লাগবে

### Option 4: Alternative Content Source
- Workers ব্লক করে না এমন source ব্যবহার করুন (TMDB + torrent API, বা অন্য site)
- **Pros**: Workers-friendly
- **Cons**: পুরো architecture change লাগতে পারে

---

## How to Deploy

```bash
# Correct deploy command:
npx wrangler pages deploy public --project-name=skmovies-premium
```

## KV Namespace
- **ID**: `898f65f8832b4794aa8ff39f90fa3288`
- **Binding**: `HDHUB4U_CACHE`
- **Key**: `ACTIVE_HDHUB4U_HOST` (resolved host URL)
- **TTL**: 1 hour
