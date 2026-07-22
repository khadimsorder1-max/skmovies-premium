# HDHub4u+ — skmovies-premium.pages.dev integration (v2)

A drop-in HDHub4u source module for your existing **Skmovies-premium.pages** site.
Adds full browsing, search, category, movie-detail, screenshot, download,
and **ad-free streaming** support — all fetched live from `hdhub4u.med`'s
current mirror, with **automatic mirror tracking** so the site keeps working
even when HDHub4u changes its hosting domain.

---

## What's new in v2

The original v1 module already covered browsing, search, downloads, and a
sandboxed-iframe player. v2 adds the following — each tied directly to user
requirements:

### 1. Automatic mirror tracking  (req #1)

> *"Hdhud4u er hosting domain change korey kichudin por por, hosting jtoi
> change koruk landing page theke to dhuka jay update tai tai eita kheyal
> rekhe update kore dio."*

The new `resolveActiveHost()` function in `functions/api/hdhub4u/_lib.js`
checks **6 sources** in order before giving up:

  1. **`HDHUB4U_FORCE_HOST` env var** (admin pin)
  2. **Cloudflare KV** (`HDHUB4U_CACHE:ACTIVE_HOST` — 6h TTL, cross-region)
  3. **Cloudflare Cache API** (edge cache, 6h TTL)
  4. **Live landing page probe** (`hdhub4u.med`) — looks for
     `<meta http-equiv="refresh">`, `window.location = …`, and
     `<a href="https://newX.hdhub4u.tld/…">` patterns
  5. **CDN resolver race** (`h4.suncdn.org`, `points.topapii.com`,
     `ml.theapii.org`, `dns.pingora.fyi`, + 2 backup endpoints) —
     first non-empty `c` field (base64-encoded host URL) wins
  6. **Hard-coded fallback list** (10 known mirrors) — each probed for
     liveness; first 200 wins

Once a host is resolved, it's cached in all three layers (memory + KV +
Cache API). On every request the in-isolate memory cache returns instantly;
if KV / Cache API values are older than 1 hour, a background refresh
fires (`ctx.waitUntil`) without blocking the response.

**Result:** when HDHub4u changes its domain, the site picks up the new
mirror within minutes — no code changes, no redeploy.

### 2. Ad-free video player  (req #2)

> *"Er je video player eita ki direct onnano site er stream url stream
> korte parbe specially mkv file? Ar site e je exact ei player ad korte
> boltechi hdhub4u te toggle thakle ar source theke play in browser korle
> eitai abar jeno kono ad nah ase mathai rekho. Ar ui smooth thaka chai."*

New file: `public/player.html`

Our own player, hosted on your domain, with **zero ads**:

  - **Native `<video>`** for MP4 / WebM — fastest, smoothest UX
  - **Video.js + VHS** for HLS (.m3u8) — works on every browser
    (Chrome, Firefox, Edge, Safari, mobile Chrome, Kiwi)
  - **hls.js** as fallback if Video.js VHS fails
  - **Clappr.js** for MKV files (Matroska demuxer via MediaSource)
  - **GDrive preview iframe** for Google Drive file IDs
  - **Last-resort sandboxed iframe** for player URLs that resist
    direct extraction (popup / redirect / ad-blocking sandbox attributes)

The player loads all libraries from jsDelivr CDN — no build step needed.

UI features:

  - Topbar auto-hides after 3.5 s of mouse / touch inactivity
  - Keyboard shortcuts: Space/k = play-pause, ←/→ = seek 10 s,
    ↑/↓ = volume, f = fullscreen, m = mute
  - Picture-in-picture, fullscreen, native mobile gestures
  - Loading spinner + clear error states with "Open in VLC" fallback
  - Mobile-first responsive layout
  - **Toggle in the header** to switch between **Ad-free** (our player)
    and **Original** (sandboxed iframe of HDHub4u's player)

### 3. External player deep-links  (req #3)

> *"External player eo jeno play hoy mathai rekho."*

Every stream and download link now has buttons for:

  - **▶ MX** — `intent://…#Intent;package=com.mxtech.videoplayer.ad;…`
    (Android MX Player free; switch to `.pro` in `stream.js` for Pro)
  - **▶ VLC** — `vlc://https://…` (Android + iOS)
  - **▶ KM** — `intent://…#Intent;package=com.kmplayer;…` (Android
    KMPlayer)
  - **↗ Open** — raw URL in a new tab (works everywhere as a download)

The buttons appear next to every stream button in the movie modal,
next to every download link, and inside the player topbar.

For player-page URLs (hubstream.art / hdstream4u.com / hubdrive / hubcdn /
gadgetsweb), the client first calls `/api/hdhub4u/stream?url=…` to resolve
the direct URL, then builds the intent:// URI from that. For already-direct
URLs (e.g. `.mp4` links), the intent is built client-side instantly.

### 4. Hardened parsers — no compromise on extraction  (req #4)

> *"Search+ exact category + movie list+ screenshot + image eigulo fetch
> e jeno kono issue nah hoy + direct download extract e jeno kono issue
> nah hoy. Direct download extract e no compromise."*

**List parser** (`functions/api/hdhub4u/list.js`):
  - Strategy 1: `<li class="thumb">` blocks (HDHub4u's actual layout)
  - Strategy 1b: `<div class="ht-vdo|post-thumb|movie-thumb|item-thumb|poster">` blocks (fallback markup)
  - Strategy 2: generic `<article>` blocks
  - Strategy 3: scan all `<a href>` on the same host (last resort)

**Search**: uses HDHub4u's Typesense backend (`search.pingora.fyi`) —
returns rich JSON documents directly, no HTML parsing needed.

**Download parser** (`functions/api/hdhub4u/movie.js`) — 5 strategies
running in parallel, results merged + deduped by URL:

  1. `<h2-h6>` / `<strong>` / `<em>` / `<p>` blocks containing `<a href>`
  2. `<div class="download-links|dl-links|download-area|movie-download|…">` blocks
  3. `<table>` rows with download links
  4. `<a class="btn-download|btn-dl|download-btn|…">` buttons (both `href`-first and `class`-first patterns)
  5. Generic `<a href>` with download-host URL (last resort)

Each link is classified by host (`hubdrive` / `hubcdn` / `hdstream4u` /
`hubstream` / `gadgetsweb` / `newtabs` / `filemail` / `archive` /
`directfile` / `other`) and labeled with quality + size + codec.

**Screenshot parser**: matches 10+ image-host patterns
(catimages.co/org/net/io, postimg.cc/org, ibb.co, imgur, image.tmdb.org,
live.staticflickr.com, drive.google.com file IDs, fastimage.xyz,
pixxxels.cc, beeimg.com, prntscr.com, sparklarge.com, iliad.io) +
lightbox `<a href>...<img></a>` patterns + `<a data-caption>` patterns.

**Image fallback**: every poster/screenshot lazy-load has an `onerror`
handler that retries through `/api/hdhub4u/proxy?url=…` — so even if a
host blocks hotlinking, the image still loads.

### 5. Caching — save Worker requests  (req #5)

> *"Cloudflare worker use kortechi tao free tai jeno extra request korey
> request waste nah hoy + perdomance thik thake tai movie er direct
> link+stream link gulo ekbar extract hoiley oitar info google cloudstore
> /emn kono source e auto up korte chai jekhane kono issue hobi nah abar
> limit pera nah + fast response. Eita full site er jonno oi."*

New file: `functions/api/hdhub4u/_cache.js`

Three-layer read-through cache for every endpoint:

| Layer              | TTL         | Scope               | Speed   |
|--------------------|-------------|---------------------|---------|
| In-isolate Map     | matches TTL | single Worker isolate | <1 ms |
| Cloudflare KV      | 7d / 24h / 6h / 1h | cross-region   | ~50 ms  |
| Cloudflare Cache API | same       | edge POP            | <10 ms  |

TTLs:

| Resource            | TTL      |
|---------------------|----------|
| Stream URLs         | 7 days  |
| Download URLs       | 7 days  |
| Movie metadata      | 1 day   |
| List pages          | 6 hours |
| Category list       | 1 day   |
| Active host         | 6 hours |

When a request hits:
  1. Check memory → if hit, return immediately (no async I/O)
  2. Check KV → if hit, backfill memory, return
  3. Check Cache API → if hit, backfill memory + KV (background), return
  4. Miss → fetch fresh, write to all three (background), return

**Bonus:** the front-end client (`hdhub4u-client.js`) also caches
resolved stream URLs in `localStorage` (24h TTL) — so opening the same
movie a second time within 24h is **instant, with zero Worker requests**.

**Important:** KV is OPTIONAL. If you don't set up the KV binding, the
module falls back to Cache API + memory cache (which is always available
on Cloudflare Pages). The site will still work — just without the
cross-region cache layer. See `wrangler.toml` for setup instructions.

### 6. Backward compatibility  (req #6)

> *"Abar amar existing project e jeno kono issue nah hoy kheyal rekho."*

Every file is **additive**:

  - All API endpoints live under `/api/hdhub4u/*` — your existing
    `/api/mlsbd/*` and `/api/freedrive/*` endpoints are untouched
  - All JS lives in `/js/hdhub4u-*.js` — your existing JS files are
    untouched
  - All CSS lives in `/css/hdhub4u.css`, scoped under the `.hd-*`
    class prefix — your existing styles are not affected
  - All HTML pages live at `/hdhub4u.html`, `/watch.html`, `/player.html`
    — **does NOT overwrite your `index.html`**
  - The `_headers` and `_redirects` files are additive rules — if your
    existing site already has these, **merge** the contents (don't
    overwrite)
  - The `wrangler.toml` file is optional — only used for local dev

No build step required. Drop the files in, deploy, done.

### 7. Final deliverable as zip  (req #7)

> *"Sob dile direct zip korey dibey."*

See `/home/z/my-project/download/skmovies-hdhub4u-v2.zip` — contains
everything you need to deploy.

---

## File structure

```
skmovies-hdhub4u/
├── wrangler.toml                              # (optional) Cloudflare Pages config
├── functions/
│   └── api/
│       └── hdhub4u/
│           ├── _lib.js                        # shared library + host resolver (req #1)
│           ├── _cache.js                      # 3-layer cache: mem + KV + Cache API (req #5)
│           ├── host.js                        # GET /api/hdhub4u/host
│           ├── categories.js                  # GET /api/hdhub4u/categories
│           ├── list.js                        # GET /api/hdhub4u/list
│           ├── movie.js                       # GET /api/hdhub4u/movie
│           ├── stream.js                      # GET /api/hdhub4u/stream  (req #2,#3)
│           └── proxy.js                       # GET /api/hdhub4u/proxy
├── public/
│   ├── hdhub4u.html                          # demo landing page (renamed from index.html)
│   ├── watch.html                            # /watch — paste a player URL to play (req #2,#3)
│   ├── player.html                           # /player — ad-free MKV/HLS/MP4 player (req #2)
│   ├── _headers                              # caching + CORS rules
│   ├── _redirects                            # (optional) clean-URL redirects
│   ├── css/
│   │   └── hdhub4u.css                       # dark + gold theme, scoped under .hd-*
│   └── js/
│       ├── hdhub4u-client.js                 # API client + localStorage cache (req #5)
│       └── hdhub4u-ui.js                     # UI renderer: grid, modal, player, ext buttons
└── docs/
    ├── README.md                              # this file
    ├── INTEGRATION.md                         # how to add to your existing site
    ├── API.md                                 # endpoint reference
    └── MX-PLAYER.md                           # MX Player intent:// deep dive
```

---

## Quick start (5 minutes)

1. **Unzip** the package.
2. **Copy** `functions/api/hdhub4u/` into your existing repo's `functions/api/` folder.
3. **Copy** `public/css/hdhub4u.css`, `public/js/hdhub4u-client.js`,
   `public/js/hdhub4u-ui.js`, `public/player.html`, `public/watch.html`,
   `public/hdhub4u.html` into your repo's `public/` folder (or root if
   no `/public`).
4. **Merge** `public/_headers` and `public/_redirects` with your existing
   files (if you have them).
5. **Commit + push.** Cloudflare Pages auto-builds. Verify at
   `https://skmovies-premium.pages.dev/hdhub4u.html`.

For full step-by-step, see `docs/INTEGRATION.md`.

---

## Optional: enable KV caching (recommended for production)

Per req #5, KV caching dramatically reduces Worker requests:

1. Go to Cloudflare dashboard → Workers & Pages → KV → Create namespace
2. Name it `HDHUB4U_CACHE`
3. Go to your Pages project → Settings → Functions →
   KV namespace bindings → Add binding
4. Variable name: `HDHUB4U_CACHE` → KV namespace: `HDHUB4U_CACHE`
5. Save + redeploy

That's it. The cache layer automatically uses KV when available, and
falls back to Cache API when not.

---

## Optional: pin a specific mirror

If you want to override the auto-resolver (e.g. for testing):

1. Go to Pages project → Settings → Environment variables
2. Add `HDHUB4U_FORCE_HOST` = `https://new3.hdhub4u.cl/` (or whatever)
3. Save + redeploy

Leave it empty to use the auto-resolver.

---

## Browser support

| Browser              | MP4 | WebM | HLS | MKV | Notes                          |
|----------------------|-----|------|-----|-----|--------------------------------|
| Chrome (desktop)     | ✓   | ✓    | ✓ via hls.js | ⚠ via Clappr | Best experience |
| Firefox (desktop)    | ✓   | ✓    | ✓ via hls.js | ⚠ via Clappr | Good            |
| Safari (desktop)     | ✓   | ✗    | ✓ native      | ✗              | HLS native      |
| Edge (desktop)       | ✓   | ✓    | ✓ via hls.js | ⚠ via Clappr | Good            |
| Chrome (Android)     | ✓   | ✓    | ✓ via hls.js | ⚠ via Clappr | Best mobile     |
| Safari (iOS)         | ✓   | ✗    | ✓ native      | ✗              | HLS native      |
| Samsung Internet     | ✓   | ✓    | ✓ via hls.js | ⚠ via Clappr | Good            |

MKV playback depends on the codec inside the container. If Clappr can't
decode the MKV (e.g. HEVC inside MKV on a browser without HEVC support),
the player falls back to the iframe mode and shows a "Open in VLC" button.

---

## Troubleshooting

See `docs/INTEGRATION.md` → "Troubleshooting" section.

---

## License

This integration code is provided as-is for use on your own Cloudflare
Pages project. The HDHub4u name and trademarks belong to their respective
owners; this module only fetches publicly available data from their site.
