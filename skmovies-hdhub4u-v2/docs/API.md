# API Reference — HDHub4u+ v2

All endpoints live under `/api/hdhub4u/*` on your Cloudflare Pages site.
All responses are JSON with CORS headers (`Access-Control-Allow-Origin: *`)
unless noted otherwise.

Every endpoint transparently uses the **3-layer cache** (memory → KV →
Cache API) described in `README.md`. You can see which layer served the
response via the `_cache` field in the JSON.

---

## `GET /api/hdhub4u/host`

Returns the currently active HDHub4u mirror.

**Cache:** memory (5 min) → KV (6h) → Cache API (6h) → fresh probe.

**Response:**

```json
{
  "host":      "https://new3.hdhub4u.cl/",
  "landing":   "https://hdhub4u.med",
  "resolvers": ["https://h4.suncdn.org/host/", "..."],
  "cached":    false,
  "ts":        1784318447000
}
```

---

## `GET /api/hdhub4u/categories`

Returns the list of HDHub4u categories (extracted from the homepage nav).

**Cache:** memory → KV (24h) → Cache API (24h) → fresh scrape.

**Response:**

```json
{
  "host":       "https://new3.hdhub4u.cl/",
  "count":      12,
  "categories": [
    { "slug": "bollywood-movies", "name": "BollyWood", "url": "..." },
    { "slug": "hollywood-movies", "name": "HollyWood", "url": "..." }
  ],
  "ts":         1784318447000,
  "_cache":     "kv"
}
```

---

## `GET /api/hdhub4u/list`

Fetch a list of movies. Three modes via the `type` query param.

### Home page

`GET /api/hdhub4u/list?type=home&page=1`

### Category browse

`GET /api/hdhub4u/list?type=category&category=bollywood-movies&page=1`

### Search

`GET /api/hdhub4u/list?type=search&q=bahubali&page=1`

**Cache:** Home/Category → 6h. Search → 1h.

**Response:**

```json
{
  "host":       "https://new3.hdhub4u.cl/",
  "type":       "home",
  "page":       1,
  "totalPages": 154,
  "count":      24,
  "movies": [
    {
      "title":   "Avatar: Fire and Ash (2025) Hindi BluRay Full Movie",
      "slug":    "avatar-fire-and-ash-2025-hindi-bluray-full-movie",
      "url":     "https://new3.hdhub4u.cl/avatar-fire-and-ash-...",
      "poster":  "https://image.tmdb.org/t/p/w342/gDVgC9jd917NdAcqBdRRDUYi4Tq.jpg",
      "quality": ["4K","1080p","720p","480p"],
      "genre":   ["Sci-Fi"],
      "year":    "2025",
      "excerpt": ""
    }
  ],
  "ts":     1784318447000,
  "_cache": "cacheApi"
}
```

---

## `GET /api/hdhub4u/movie`

Fetch full details for a single movie.

### By slug

`GET /api/hdhub4u/movie?slug=avatar-fire-and-ash-2025-hindi-bluray-full-movie`

### By full URL

`GET /api/hdhub4u/movie?url=https://new3.hdhub4u.cl/avatar-fire-and-ash-.../`

**Cache:** 24h.

**Response:**

```json
{
  "title":       "Avatar: Fire and Ash (2025) Hindi BluRay Full Movie",
  "slug":        "avatar-fire-and-ash-2025-hindi-bluray-full-movie",
  "url":         "https://new3.hdhub4u.cl/avatar-fire-and-ash-...",
  "host":        "https://new3.hdhub4u.cl/",
  "poster":      "https://image.tmdb.org/t/p/w500/gDVgC9jd917NdAcqBdRRDUYi4Tq.jpg",
  "year":        "2025",
  "genres":      ["Sci-Fi","Adventure"],
  "language":    "Hindi",
  "qualities":   [{ "label": "4K", "size": "" }, { "label": "1080p", "size": "[1.2GB]" }],
  "imdbId":      "tt1234567",
  "imdbUrl":     "https://www.imdb.com/title/tt1234567/",
  "imdbRating":  "8.2",
  "director":    "James Cameron",
  "stars":       "Sam Worthington, Zoe Saldana, Sigourney Weaver",
  "storyline":   "After the events of The Way of Water...",
  "review":      "",
  "screenshots": [
    "https://catimages.co/image/abc123",
    "https://i.ibb.co/xyz/screenshot1.jpg"
  ],
  "trailer":     "https://www.youtube.com/embed/abc123",
  "downloads": [
    {
      "label":      "480p [750MB]",
      "quality":    "480p",
      "size":       "750MB",
      "codec":      "HEVC",
      "url":        "https://hubdrive.tips/file/abc123",
      "kind":       "hubdrive",
      "isStream":   false,
      "isDownload": true
    },
    {
      "label":      "1080p HEVC [1.2GB]",
      "quality":    "1080p",
      "size":       "1.2GB",
      "codec":      "HEVC",
      "url":        "https://hubstream.art/#abc123",
      "kind":       "hubstream",
      "isStream":   true,
      "isDownload": false
    }
  ],
  "streams": [
    {
      "player": "Player 1",
      "kind":   "hubstream",
      "url":    "https://hubstream.art/#abc123",
      "label":  "Hubstream"
    },
    {
      "player": "Player 2",
      "kind":   "hdstream4u",
      "url":    "https://hdstream4u.com/file/abc123",
      "label":  "HDStream4u"
    }
  ],
  "ts":     1784318447000,
  "_cache": "fresh"
}
```

**`downloads[].kind`** values: `hubdrive` | `hubcdn` | `hdstream4u` |
`hubstream` | `gadgetsweb` | `newtabs` | `filemail` | `archive` |
`directfile` | `other`.

---

## `GET /api/hdhub4u/stream`

Resolve a player URL to a direct playable URL + external-player deep links.

### Query params

| Param | Required | Default  | Description                                    |
|-------|----------|----------|------------------------------------------------|
| `url` | yes      | —        | The player URL to resolve                       |
| `mode`| no       | `direct` | `direct` = JSON, `iframe` = HTML wrapper, `player` = HTML redirect to `/player.html` |

**Cache (mode=direct):** 7 days (KV + Cache API + memory).

### `mode=direct` response

```json
{
  "source":      "hubstream",
  "directUrl":   "https://hubstream-cdn.example.com/avatars3.mp4",
  "streamUrl":   null,
  "gdriveId":    null,
  "iframe":      "https://hubstream.art/embed/abc123",
  "playableUrl": "https://hubstream-cdn.example.com/avatars3.mp4",
  "proxyUrl":    "/api/hdhub4u/proxy?url=https%3A%2F%2Fhubstream-cdn.example.com%2Favatars3.mp4",
  "playerUrl":   "/player.html?url=https%3A%2F%2Fhubstream-cdn.example.com%2Favatars3.mp4&source=hubstream",
  "mxIntent":    "intent://hubstream-cdn.example.com/avatars3.mp4#Intent;package=com.mxtech.videoplayer.ad;S.title=HDHub4u;end",
  "vlcUrl":      "vlc://https://hubstream-cdn.example.com/avatars3.mp4",
  "kmIntent":    "intent://hubstream-cdn.example.com/avatars3.mp4#Intent;package=com.kmplayer;S.title=HDHub4u;end",
  "externalUrl": "https://hubstream-cdn.example.com/avatars3.mp4",
  "ts":          1784318447000,
  "_cache":      "kv"
}
```

Fields:

| Field         | Description                                                            |
|---------------|------------------------------------------------------------------------|
| `source`      | Which player host the URL came from                                    |
| `directUrl`   | Direct .mp4 / .mkv URL when found                                      |
| `streamUrl`   | HLS .m3u8 URL when found (mutually exclusive with `directUrl`)         |
| `gdriveId`    | Google Drive file ID when source is `hubdrive`                         |
| `iframe`      | Last-resort embed URL                                                  |
| `playableUrl` | Best-guess playable URL (directUrl → streamUrl → GDrive → iframe)      |
| `proxyUrl`    | Our CORS-safe proxy URL for use in `<video>`                           |
| `playerUrl`   | Our ad-free player page URL (`/player.html?url=…`)                     |
| `mxIntent`    | MX Player intent:// URI (Android)                                      |
| `vlcUrl`      | VLC deep link (Android + iOS)                                          |
| `kmIntent`    | KMPlayer intent:// URI (Android)                                       |
| `externalUrl` | Raw playable URL for "Open URL" buttons                                |

### `mode=iframe` response

Returns an HTML page that wraps the player URL in a sandboxed iframe,
with auto-hiding topbar containing Back / Fullscreen / MX / VLC / Open
buttons. The MX / VLC buttons are wired via a background fetch to
`mode=direct`.

### `mode=player` response

Returns an HTML page that redirects to `/player.html?url=…` (our
ad-free player). Used by the UI's `openStream()` function.

---

## `GET /api/hdhub4u/proxy`

Transparent pass-through proxy. Used for:

  1. CORS bypass for direct video URLs (so `<video>` on your domain can
     play files served from `new3.hdhub4u.cl` / `hubcdn.sbs` /
     `drive.google.com`).
  2. Image proxy for poster thumbnails when the upstream host blocks
     hot-linking.
  3. MKV pass-through (the proxy streams the file to our player page
     which uses Clappr for MKV demuxing).

### Query params

| Param | Required | Description                |
|-------|----------|----------------------------|
| `url` | yes      | The URL to proxy            |

Forwards the `Range` header so video seeking works. Copies back
`Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`.

**Cache:** 1 day for images, 1 hour for videos.

---

## Error responses

All endpoints return HTTP 4xx / 5xx with JSON body:

```json
{
  "error":   "Failed to fetch list",
  "message": "HTTP 503 for https://new3.hdhub4u.cl/"
}
```

Common errors:

| Status | Cause                                                | Fix                                |
|--------|------------------------------------------------------|------------------------------------|
| 400    | Missing required query param                         | Add `?url=…` or `?slug=…`          |
| 502    | Upstream HDHub4u mirror is down or changed structure| Wait a minute or pin a mirror via `HDHUB4U_FORCE_HOST` |
| 504    | Upstream took >15s to respond                       | Retry; usually transient           |

---

## Client-side API

See `public/js/hdhub4u-client.js` for the front-end client class.
Highlights:

```js
const api = new HDHub4uClient();

// All endpoints:
await api.host();                              // GET /host
await api.categories();                        // GET /categories
await api.home(1);                             // GET /list?type=home&page=1
await api.category('bollywood-movies', 1);     // GET /list?type=category&...
await api.search('bahubali', 1);               // GET /list?type=search&...
await api.movie({ slug: '...' });              // GET /movie?slug=...
await api.movie({ url: 'https://...' });       // GET /movie?url=...
await api.resolveStream(playerUrl);            // GET /stream?url=...&mode=direct

// Helpers:
api.iframeStreamUrl(playerUrl, title);         // builds /stream?mode=iframe URL
api.playerUrl(directUrl, { title, source });   // builds /player.html URL
api.proxyUrl(targetUrl);                       // builds /proxy?url=… URL
api.buildMxIntent(directUrl, title);           // client-side MX intent builder
api.buildVlcUrl(directUrl);                    // client-side VLC URL builder
```

The client caches:

  - **Host** in localStorage (5 min TTL)
  - **Resolved stream URLs** in localStorage (24h TTL)

So opening the same movie twice in 24h makes zero Worker requests.
