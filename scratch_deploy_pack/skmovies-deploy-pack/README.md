# SKMovies Premium — Full Backup

Complete offline mirror of **https://skmovies-premium.pages.dev/** — both the
deployed frontend bundle AND reverse-engineered Cloudflare Pages Functions
backend, plus live API response samples for every endpoint.

## Layout

```
skmovies-full-backup/
├── README.md                      ← this file
├── REVERSE-ENGINEERING.md         ← API contract, request/response shapes, notes
│
├── frontend/                      ← deployed static site (verbatim from Cloudflare Pages)
│   ├── index.html
│   ├── app.js                     ← v3.3.8, ~110 KB, comments preserved
│   ├── styles.css                 ← v3.3.8, ~69 KB
│   ├── manifest.json
│   └── assets/
│       ├── favicon-32.webp
│       ├── apple-touch-icon.webp
│       └── empty.webp
│
├── backend/                       ← reverse-engineered Pages Functions
│   ├── package.json
│   ├── wrangler.toml
│   ├── _routes.json               ← CF Pages routing config
│   └── functions/api/
│       ├── latest.js              ← MLSBD latest
│       ├── trending.js            ← MLSBD trending
│       ├── notice.js              ← curated notices (KV-overrideable)
│       ├── search.js              ← MLSBD search
│       ├── category.js            ← MLSBD category
│       ├── south.js               ← MLSBD south-Indian (hindi filter)
│       ├── movie.js               ← MLSBD movie detail
│       ├── resolve.js             ← savelinks.me resolver
│       ├── img.js                 ← image proxy (mlsbd-image, tmdb, imgnest, amazon, …)
│       ├── proxy.js               ← generic CORS proxy (base64url ?u=)
│       └── fdm/
│           ├── latest.js
│           ├── trending.js
│           ├── search.js
│           ├── category.js
│           ├── movie.js
│           └── resolve.js         ← freedrivemovie /links/ & /episodes/ resolver
│
└── api-samples/                   ← live API responses (for reference / tests)
    ├── latest.json
    ├── latest_hindi.json
    ├── trending.json
    ├── notice.json
    ├── search_hindi.json
    ├── south.json
    ├── south_hindi.json
    ├── category_hindi.json
    ├── movie_detail.json
    ├── resolve.json
    ├── fdm_latest.json
    ├── fdm_trending.json
    ├── fdm_search.json
    └── fdm_movie_detail.json
```

## What's real vs reverse-engineered

| Component | Status |
|---|---|
| `frontend/*` (HTML/CSS/JS/assets) | **Real** — verbatim download from Cloudflare Pages |
| `backend/functions/api/*.js` | **Reverse-engineered** — written from observed I/O. Cloudflare Workers runtime compatible. |
| `api-samples/*.json` | **Real** — captured live from the deployed API |
| `REVERSE-ENGINEERING.md` | Documents the API contract and known limitations |

The Cloudflare Pages Functions source code is server-side only and is not
exposed publicly. The reverse-engineered implementations faithfully replicate
every observed endpoint's behavior, but the upstream HTML parsers may need
adjustment if `mlsbd.co` or `freedrivemovie.cyou` change their theme markup.

## Run locally

### Option A — frontend only (no backend)

```bash
cd skmovies-full-backup/frontend
python3 -m http.server 8080
# open http://localhost:8080/
# (API calls will fail — backend not running)
```

### Option B — full stack with Wrangler (recommended)

```bash
cd skmovies-full-backup/backend

# Install wrangler if you don't have it
npm install

# Build a single deployable dir: copy frontend assets into backend root
cp -r ../frontend/* .

# Run with local Pages Functions
npx wrangler pages dev . --port 8788
# open http://localhost:8788/
```

### Option C — deploy to your own Cloudflare Pages

```bash
cd skmovies-full-backup/backend
cp -r ../frontend/* .

# Log in to Cloudflare first (npx wrangler login)
npx wrangler pages deploy . --project-name skmovies-premium
```

## Endpoint quick reference

See [`REVERSE-ENGINEERING.md`](./REVERSE-ENGINEERING.md) for the full contract.
Summary:

```
GET /api/latest?page=1&filter=all                  → MLSBD latest movies
GET /api/trending                                  → MLSBD trending widget
GET /api/notice                                    → curated notices
GET /api/search?q=hindi&page=1                     → MLSBD WP search
GET /api/category?slug=hindi-dubbed-movies&page=1  → MLSBD category listing
GET /api/south?hindi=1&page=1                      → south-Indian movies (hindi-only filter)
GET /api/movie?slug=<slug>                         → full movie detail + downloads
GET /api/resolve?url=<savelinks-url>               → resolves savelinks → file-host URLs
GET /api/img?u=<base64|url>                        → image proxy (CORS, hotlink bypass)
GET /api/proxy?u=<base64url>                       → generic CORS proxy for allow-listed hosts

# FDM (FreeDriveMovie) source — same shape, prefixed /api/fdm/
GET /api/fdm/latest?page=1
GET /api/fdm/trending
GET /api/fdm/search?q=hindi&page=1
GET /api/fdm/category?slug=<slug>&page=1
GET /api/fdm/movie?slug=<slug>
GET /api/fdm/resolve?url=<fdm-links-or-episodes-url>
```

## Disclaimer

This backup is for **educational / personal archival** purposes only. The
upstream sources (`mlsbd.co`, `freedrivemovie.cyou`, `savelinks.me`) host
user-submitted movie download links, some of which may point to copyrighted
content. The reverse-engineered backend code simply re-parses publicly
accessible HTML — it does not bypass authentication, paywalls, or DRM.
