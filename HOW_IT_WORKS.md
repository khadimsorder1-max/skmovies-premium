# SKMovies — How It Works

> Detailed architecture, data flow, and component breakdown for the SKMovies project.

## 🏗 Architecture Overview

SKMovies has **3 deployable components** + **1 data source**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     USER (browser / Telegram)                        │
└────────────┬────────────────────────────────┬───────────────────────┘
             │                                │
             ▼                                ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│  Cloudflare Pages        │     │  Telegram Bot Worker     │
│  (skmovies.pages.dev)    │     │  (skmovies-bot)          │
│                          │     │                           │
│  public/index.html       │     │  bot/src/index.js         │
│  public/app.js           │     │  - /start, /latest, etc. │
│  public/styles.css       │     │  - /setup (one-shot)     │
│  public/webapp/ (Mini)   │     │  - /webhook              │
│                          │     │                           │
│  functions/api/*         │     │  Uses Pages API:         │
│  - /api/latest           │     │  GET skmovies.pages.dev  │
│  - /api/movie            │     │    /api/latest           │
│  - /api/search           │     │                           │
│  - /api/trending         │     │  Menu button → Mini App  │
│  - /api/resolve          │     │                           │
│  - /api/img              │     └─────────────────────────┘
│  - /api/notice           │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│  Proxy Worker            │     │  mlsbd.co (data source)  │
│  (skmovies-proxy)        │     │                           │
│                          │     │  Scraped by:             │
│  /proxy/<b64>            │     │  - Pages Functions       │
│  - adds Referer header   │     │    (latest, movie, etc.) │
│  - streams video         │     │  - Proxy Worker          │
│                          │     │    (resolve)             │
│  /resolve?url=<savelinks>│     │                           │
│  - extracts .mp4 URL     │     │  Returns:                │
│                          │     │  - HTML (parsed)         │
└──────────┬──────────────┘     │  - savelinks.me URLs     │
           │                    │  - gdflix/multicloud URLs │
           └────────────────────┘
```

## 📊 Data Flow

### 1. Browse Movies (Homepage)

```
User opens skmovies.pages.dev
  ↓
Browser loads index.html + styles.css + app.js
  ↓
app.js calls GET /api/notice → fetches mlsbd.co homepage → parses marquee
  ↓
app.js calls GET /api/trending → fetches mlsbd.co homepage → parses featured-slider
  ↓
app.js calls GET /api/latest?page=1 → fetches mlsbd.co homepage → parses single-post grid
  ↓
Renders: notice marquee + featured slider + movie grid (pixel-perfect mlsbd.co UI)
```

### 2. Search Movies

```
User types in search bar
  ↓
app.js debounces 350ms
  ↓
GET /api/search?q=<query> → fetches mlsbd.co/?s=<query> → parses results
  ↓
Renders search results in movie grid
```

### 3. View Movie Details

```
User clicks a movie card
  ↓
app.js calls GET /api/movie?slug=<slug> → fetches mlsbd.co/<slug>/ → parses movie-info
  ↓
Opens modal with:
  - Poster + title + badges
  - Storyline, director, cast, language, quality, resolution, size
  - Screenshots gallery
  - Download buttons (480P, 720P, 1080P, 4K)
  - Trailer link
  - Favorite + Watch Online buttons
```

### 4. Direct Stream / Download (the key feature)

```
User clicks a download button (e.g., "Download in 1080p quality")
  ↓
app.js calls GET /api/resolve?url=<savelinks.me URL>
  ↓
Resolve function:
  1. Fetches savelinks.me page
  2. Extracts host URLs (gdflix.dev, multicloudlinks.com, etc.)
  3. For each host, fetches the host page
  4. Finds direct .mp4/.mkv URL (via regex + API endpoints)
  5. Returns array of direct URLs
  ↓
app.js opens player sheet with:
  - MX Player (intent://...)
  - VLC (vlc://...)
  - Just Player, MPV, KM Player
  - Browser, Download
  - Copy URL
  ↓
If user taps MX Player / VLC / Download:
  - Browser opens the proxy URL: https://skmovies-proxy.xxx.workers.dev/proxy/<b64>
  - Proxy Worker:
    1. Decodes base64 → gets original CDN URL
    2. Adds Referer: https://savelinks.me/ (or https://mlsbd.co/)
    3. Streams the video response back
  - MX Player / VLC receives the stream → plays video
```

**Why the proxy is needed:**
gdflix.dev and other CDNs reject direct downloads (HTTP 403) unless the request includes the correct `Referer` header. MX Player, VLC, and browsers don't send it, so direct downloads fail. The Proxy Worker adds it transparently.

### 5. Telegram Bot Flow

```
User sends /start to bot
  ↓
Bot Worker receives webhook
  ↓
Bot sends banner.webp + welcome text + inline keyboard
  ↓
User taps "🎬 Latest Movies"
  ↓
Bot calls GET skmovies.pages.dev/api/latest
  ↓
Bot sends movie list as inline buttons
  ↓
User taps a movie
  ↓
Bot sends "🎬 Open Movie" button (web_app → Mini App)
  ↓
User taps → Mini App opens inside Telegram
```

### 6. Telegram Mini App Flow

```
User taps menu button (☰) in bot chat
  ↓
Telegram opens webapp/index.html in WebView
  ↓
TG WebApp SDK initializes:
  - tg.ready()
  - tg.expand()
  - Apply theme (dark/light)
  - Enable haptic feedback
  - Show back button when modal open
  ↓
Mini App loads same API as website:
  - /api/notice, /api/trending, /api/latest, /api/movie, /api/resolve
  ↓
User browses movies, opens details, taps download
  ↓
Player sheet opens with TG haptics
  ↓
User taps MX Player → TG opens external app
```

## 🧩 Component Breakdown

### Frontend (public/)

| File | Purpose |
|------|---------|
| `index.html` | Pixel-perfect clone of mlsbd.co homepage shell |
| `styles.css` | Exact CSS from mlsbd.co (design tokens, dark mode, responsive) |
| `app.js` | Vanilla JS SPA — routing, state, API calls, modal, player sheet, dashboard |
| `manifest.json` | PWA manifest (installable, icons) |
| `sw.js` | Service Worker — offline cache, image cache |
| `offline.html` | Offline fallback page |
| `webapp/index.html` | Telegram Mini App shell (same UI + TG SDK) |
| `webapp/webapp.css` | TG-specific styles (splash, settings) |
| `webapp/app.js` | TG SDK hooks (haptics, back button, theme) |
| `assets/*.webp` | 14 images (logo, banner, icons, badges, og, empty) |

### Backend (functions/api/)

| File | Endpoint | What it does |
|------|----------|--------------|
| `_lib/shared.js` | — | CORS, fetch with retry, cache (KV), base64, HTML unescape |
| `_lib/parsers.js` | — | HTML parsers: `parseMovieList`, `parseMovieDetails`, `parseTrending`, `parseNotice`, `parseSavelinksHosts`, `findDirectUrlInHtml` |
| `latest.js` | `/api/latest` | Fetch mlsbd.co homepage → parse movie list → filter → return JSON |
| `movie.js` | `/api/movie` | Fetch mlsbd.co/<slug>/ → parse movie details → return JSON |
| `search.js` | `/api/search` | Fetch mlsbd.co/?s=<q> → parse results → return JSON |
| `trending.js` | `/api/trending` | Fetch mlsbd.co homepage → parse featured-slider → return JSON |
| `notice.js` | `/api/notice` | Fetch mlsbd.co homepage → parse marquee → return JSON |
| `resolve.js` | `/api/resolve` | Fetch savelinks.me → parse hosts → fetch each host → extract .mp4 URL → return JSON |
| `img.js` | `/api/img` | Fetch image from mlsbd-image.com → return with cache headers |
| `_middleware.js` | — | CORS preflight for all /api/* |

### Proxy Worker (proxy/)

| File | Purpose |
|------|---------|
| `index.js` | Two endpoints: `/proxy/<b64>` (video proxy + Referer), `/resolve?url=<savelinks>` (direct URL extractor) |

### Bot Worker (bot/)

| File | Purpose |
|------|---------|
| `src/index.js` | Telegram bot — commands, inline keyboards, banner, /setup endpoint, /webhook handler |

## 🎨 Design Token Extraction

All CSS values were extracted from mlsbd.co's actual computed styles using the clone-website skill's methodology:

```javascript
// Extraction script (run via browser console on mlsbd.co)
const cs = getComputedStyle(document.documentElement);
console.log({
  red: cs.getPropertyValue('--red'),       // #fb1114
  black: cs.getPropertyValue('--black'),   // #0a0909
  grey: cs.getPropertyValue('--grey'),     // #535353
  fontPrimary: cs.getPropertyValue('--font-primary'),   // 'Exo', sans-serif
  fontSecondary: cs.getPropertyValue('--font-secondary') // 'Google', sans-serif
});
```

Key components and their exact values:
- **Body background**: PNG pattern (data-URI) + `#202529` in dark mode
- **Header**: `#fff` (light) / `#202529` (dark), transition 0.25s
- **Section title**: red bg `#fb1114`, 2px solid `#0a0909` border, 10px radius, Exo 18px 600 uppercase
- **Movie card (.single-post)**: 10px radius, box-shadow `0 5px 10px #999`
- **Thumb**: 10px radius top, aspect-ratio 2/3
- **Post-desc**: 15px radius bottom, 3px solid `#585858` border-bottom
- **Dbtn**: 30px radius (pill), 50px height, `#ffc107` (sd), `#ff5722` (hd), `#8d6e63` (watch)
- **Footer-top**: `#535353` bg, white text
- **Footer-bottom**: `#0a0909` bg, `#a5a5a5` text
- **Go-top**: fixed bottom-right, `#fb1114` bg, opacity 0 → 0.7 on scroll

## 🔒 Ad Removal

The original mlsbd.co has:
- Google AdSense scripts
- Pop-up ad networks
- Affiliate link redirects
- Analytics trackers

SKMovies removes ALL of these by:
1. Not including any ad scripts in index.html
2. The backend (Pages Functions) only parses movie data — it strips all ad HTML
3. The image proxy only allows known image hosts (mlsbd-image.com, cdn.imgnest.io, etc.)
4. The resolve function only follows savelinks.me → gdflix/multicloud (no ad redirects)

## ⚡ Performance Optimizations

1. **Edge caching**: All API responses cached at Cloudflare edge (`s-maxage=600`)
2. **Image proxy**: Images cached for 30 days (`s-maxage=2592000, immutable`)
3. **Service Worker**: Static assets + API responses cached for offline
4. **Lazy loading**: Images use `loading="lazy"` + `decoding="async"`
5. **Preconnect**: HTML preconnects to image hosts
6. **content-visibility: auto**: On movie cards (skips off-screen rendering)
7. **Disabled backdrop-filter**: On low-end devices (≤2GB RAM heuristic)
8. **Disabled hover effects**: On touch devices (`@media (hover: none)`)
9. **Vanilla JS**: Zero dependencies, zero framework overhead

## 🌐 Cloudflare BD Edge

- **Dhaka PoP (DAC)**: Cloudflare's Bangladesh edge caches static assets + API responses locally
- **Smart Placement**: Workers auto-route to closest PoP
- **Result**: BD users get ~30-50ms latency for cached content

## 📱 External Player Detection

The app.js `detectDevice()` function checks `navigator.userAgent`:

| Platform | UA Pattern | Players Offered |
|----------|------------|-----------------|
| Android | `/android\|adr/` | MX Player, VLC, Just Player, MPV, KM Player, Browser, Download |
| iOS | `/iphone\|ipad\|ipod/` | VLC, Infuse, PlayerXtreme, Outplayer, Safari, Download |
| macOS | `/mac os x/` | IINA, VLC, MPV, QuickTime, Browser, Download |
| Windows | `/windows/` | VLC, PotPlayer, MPV, MPC-HC, Browser, Download |
| Linux | `/linux/` | VLC, MPV, Browser, Download |

Each player button uses a deep-link URL scheme:
- MX Player: `intent://<url>#Intent;package=com.mxtech.videoplayer.ad;end`
- VLC: `vlc://<url>`
- Just Player: `intent://<url>#Intent;package=com.brouken.player;end`
- MPV: `mpv://<url>`
- IINA: `iina://weblink?url=<encoded-url>`
- PotPlayer: `potplayer://<url>`

## 🔄 State Management

The frontend uses a simple `state` object (no Redux/Zustand):

```javascript
const state = {
  view: 'latest',          // latest | trending | favs | history | search | dashboard
  page: 1,
  filter: 'all',
  searchQuery: '',
  items: [],               // current movie list
  isLoading: false,
  hasMore: true,
  heroItem: null,          // featured slider item
  currentMovieSlug: null,  // open movie modal
  filter18: false,
};
```

localStorage keys:
- `skm.favs` — watchlist
- `skm.history` — recently viewed
- `skm.urls` — extracted direct URLs
- `skm.stats` — download count
- `skm.theme` — dark mode preference
- `skm.filter18` — 18+ filter state

## 🚀 Deployment Flow

```
1. Deploy Pages (skmovies.pages.dev)
   ↓
2. Deploy Proxy Worker (skmovies-proxy.xxx.workers.dev)
   ↓
3. Deploy Bot Worker (skmovies-bot.xxx.workers.dev)
   ↓
4. Visit: https://skmovies-bot.xxx.workers.dev/setup?token=<BOT_TOKEN>&webhook=1
   - Sets 10 bot commands
   - Sets menu button → Mini App
   - Sets webhook
   ↓
5. Open bot in Telegram → /start → see banner + buttons
6. Tap menu (☰) → Mini App opens
```

## 🐛 Troubleshooting

### "Upstream fetch failed" in production
- mlsbd.co may have changed their HTML structure — update parsers in `functions/api/_lib/parsers.js`
- Cloudflare bot challenge: the `cf: { scrapeShield: false }` option bypasses it when running on CF Workers/Pages

### Downloads fail with 403
- Make sure the Proxy Worker is deployed
- The proxy URL in buttons should start with `https://skmovies-proxy.`

### Mini App doesn't open
- Make sure `PAGES_URL` in `bot/src/index.js` points to your Pages URL
- The URL must be HTTPS

### Bot doesn't respond
- Check `/health`: `https://<bot-worker>.workers.dev/health`
- Verify webhook: `https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- Check logs: `npx wrangler tail` (in bot directory)
