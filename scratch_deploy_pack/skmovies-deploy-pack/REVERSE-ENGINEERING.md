# SKMovies Premium — Reverse-Engineering Notes

> Source: `https://skmovies-premium.pages.dev/`  
> Live API base: `https://skmovies-premium.pages.dev/api/`  
> Frontend version observed: **v3.3.8**  
> Last sampled: 2026-07-20  

## Architecture

```
┌─────────────────────────────────────────┐
│  Cloudflare Pages  (skmovies-premium)   │
│                                         │
│  ┌─────────────┐    ┌────────────────┐  │
│  │  Frontend   │───▶│   /api/*       │  │
│  │  Static SPA │    │  Pages Funcs   │  │
│  │  (vanilla)  │    │  (Workers)     │  │
│  └─────────────┘    └───────┬────────┘  │
└─────────────────────────────┼───────────┘
                              ▼
                   ┌──────────────────────┐
                   │  Upstream sources    │
                   │  • mlsbd.co          │
                   │  • freedrivemovie.*  │
                   │  • savelinks.me      │
                   │  • various file hosts│
                   └──────────────────────┘
```

The frontend (`app.js`) is a vanilla-JS SPA with two switchable sources:

| Source code | Name | Upstream root |
|---|---|---|
| `mlsbd` (default) | MLSBD | `https://mlsbd.co` |
| `fdm` | FreeDriveMovie | `https://freedrivemovie.cyou` |

## Frontend → Backend contract (from app.js)

The frontend reads `state.source` from `localStorage['skm.source']` (default `mlsbd`) and
selects an endpoint set:

```js
mlsbd: { latest:'/api/latest', movie:'/api/movie', search:'/api/search',
         trending:'/api/trending', resolve:'/api/resolve',
         category:'/api/category', img:'/api/img', notice:'/api/notice' }

fdm:   { latest:'/api/fdm/latest', movie:'/api/fdm/movie', search:'/api/fdm/search',
         trending:'/api/fdm/trending', resolve:'/api/fdm/resolve',
         category:'/api/fdm/category', img:'/api/img', notice:'/api/notice' }
```

A separate `/api/proxy?u=<base64url>` endpoint is used to fetch from file hosts
that don't send CORS headers or that sit behind Cloudflare bot-protection.

## Endpoints observed (live)

### MLSBD source

| Endpoint | Method | Params | Returns |
|---|---|---|---|
| `GET /api/latest` | GET | `page`, `filter` | `{ ok, page, filter, items[] }` |
| `GET /api/trending` | GET | — | `{ ok, items[] }` |
| `GET /api/notice` | GET | — | `{ ok, items: string[] }` |
| `GET /api/search` | GET | `q`, `page` | `{ ok, q, page, items[] }` |
| `GET /api/category` | GET | `slug`, `page` | `{ ok, page, slug, items[] }` |
| `GET /api/south` | GET | `hindi` (0/1/true), `page` | `{ ok, page, items[] }` |
| `GET /api/movie` | GET | `slug` | full movie detail object |
| `GET /api/resolve` | GET | `url` (savelinks.me URL) | `{ ok, urls[], rawUrls[], hosts[] }` |
| `GET /api/img` | GET | `u` (base64/url) | binary image stream |
| `GET /api/proxy` | GET | `u` (base64url) | streamed upstream response with CORS |

### FDM source

| Endpoint | Method | Params | Returns |
|---|---|---|---|
| `GET /api/fdm/latest` | GET | `page` | `{ ok, page, items[] }` |
| `GET /api/fdm/trending` | GET | — | `{ ok, items[] }` |
| `GET /api/fdm/search` | GET | `q`, `page` | `{ ok, q, page, items[] }` |
| `GET /api/fdm/category` | GET | `slug`, `page` | `{ ok, page, slug, items[] }` |
| `GET /api/fdm/movie` | GET | `slug` | full movie detail object |
| `GET /api/fdm/resolve` | GET | `url` (freedrivemovie /links/ or /episodes/ URL) | `{ ok, urls[], hosts[] }` |

## Item shape (MLSBD)

```json
{
  "slug": "abar-hawa-bodol-2026-bengali-full-movie",
  "title": "Abar Hawa Bodol (2026) Bengali Amazon WEB-DL – 480P | 720P | 1080P – ...",
  "poster": "https://image.tmdb.org/t/p/w780/…",
  "year": "2026",
  "quality": "1080P",
  "language": "Bengali",
  "uploadDate": "3 days ago",
  "sizes": ["550MB","1.1GB","3GB","9.5GB"]
}
```

## Item shape (FDM)

```json
{
  "slug": "argentina-vs-spain-fifa-final-live-watch-online-free",
  "title": "Argentina VS Spain Fifa Final Live Watch Online Free",
  "poster": "https://img.freedrivemovie.cyou/files/…",
  "year": "",
  "type": "Movie",
  "url": "https://freedrivemovie.cyou/movies/…/"
}
```

## Movie detail shape (MLSBD)

```json
{
  "ok": true,
  "slug": "...",
  "title": "...",
  "poster": "...",
  "uploadDate": "3 days ago",
  "author": "SK Movies",
  "categories": ["1080p","Bengali Movies", …],
  "sizes": ["550MB","1.1GB","3GB","9.5GB"],
  "imdbRating": "(N/A)",
  "rotten": "",
  "director": "Parambrata Chattopadhyay",
  "cast": ["Kabir Bhattacharya", …],
  "storyline": "N/A",
  "screenshots": ["https://cdn.imgnest.io/..."],
  "trailer": "https://vimeo.com/928804663",
  "sections": [{ "section_title":"Download", "downloads":[…] }],
  "isMultiEpisode": false,
  "episodeSections": [],
  "downloads": [
    {
      "quality": "1080P",
      "savelinks_url": "https://savelinks.me/view/0dqRLjqb",
      "info": "Download Links Here",
      "label": "Download in 1080p HEVC 3GB quality"
    }
  ],
  "watchOnline": "",
  "movieUrl": "https://mlsbd.co/<slug>/"
}
```

## Resolve output

`GET /api/resolve?url=https://savelinks.me/view/0dqRLjqb` →

```json
{
  "ok": true,
  "urls": ["https://new.multicloudlinks.com/view/xp76vc"],
  "rawUrls": ["https://new.multicloudlinks.com/view/xp76vc"],
  "hosts": [
    { "host": "GDFlix",     "url": "https://gdflix.dev/file/…",  "text": "https://gdflix.dev/…" },
    { "host": "FilePress",  "url": "https://new2.filepress.baby/file/…", "text": "…" },
    { "host": "MultiCloud", "url": "https://new.multicloudlinks.com/view/…", "text": "…" },
    { "host": "Telegram",   "url": "https://t.me/mlsbdrequest", "text": "Telegram" }
  ],
  "savelinksUrl": "https://savelinks.me/view/0dqRLjqb",
  "source": "mlsbd",
  "fallback": null
}
```

## Proxy host allow-list (from `app.js`)

```
dl.freedrivemovie.org
*.freedrivemovie.{org,cyou,com}
indexserver.site
busycdn.xyz
multicloudlinks.com
gdflix.{dev,dad,com}
hubcloud.{lol,foo,com}
gdtot.{dad,com,dev}
gdlink.dev
filepress.{baby,com}
multidownload.website
dr*.multidownload.website
mlsbd-image.com
cdn.imgnest.io
image.tmdb.org
img.freedrivemovie.cyou
```

## Known limitations

- The live Cloudflare Pages Functions source code is **server-side only** — it is
  not exposed publicly. The implementations in `backend/functions/api/` are
  **faithful reverse-engineerings** based on observed I/O, not the original code.
- The parser regexes were written against typical WordPress theme markup for
  `mlsbd.co` and the FreeDriveMovie theme. If either upstream changes its HTML
  structure, the parsers will need updating.
- `/api/notice` returns a static, manually-curated list in the live deployment.
  We replicate the observed defaults and allow overriding via KV / env var.
- Source maps are not published for `app.js`; the file we have is the bundled
  production build (already readable — comments intact).
