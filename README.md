# SKMovies — Pixel-Perfect Ad-Free mlsbd.co Clone

> **SKMovies** is a pixel-perfect, ad-free clone of [mlsbd.co](https://mlsbd.co), rebranded and enhanced with premium features.
> Deploys to **`skmovies.pages.dev`** (Cloudflare Pages) + Telegram Bot + Mini App.
> Built using the [clone-website skill](https://github.com/JCodesMore/ai-website-cloner-template).

## 📦 What's Inside

This zip contains **everything** you need:

```
skmovies-final/
├── public/                          # Cloudflare Pages site (skmovies.pages.dev)
│   ├── index.html                   # Pixel-perfect clone of mlsbd.co homepage
│   ├── styles.css                   # Exact CSS from mlsbd.co (tokens, dark mode, responsive)
│   ├── app.js                       # Frontend SPA (vanilla JS)
│   ├── manifest.json                # PWA manifest
│   ├── sw.js                        # Service Worker (offline)
│   ├── offline.html                 # Offline fallback
│   ├── _headers                     # Cache + security headers
│   ├── _redirects                   # SPA fallback
│   ├── robots.txt
│   ├── sitemap.xml
│   ├── assets/                      # 14 webp images (logo, banner, icons, badges, og, empty)
│   └── webapp/                      # Telegram Mini App
│       ├── index.html               # Mini App shell (TG SDK integrated)
│       ├── webapp.css               # TG-specific styles
│       └── app.js                   # TG SDK hooks (haptics, back button, theme)
├── functions/api/                   # Cloudflare Pages Functions (backend)
│   ├── _lib/
│   │   ├── shared.js                # CORS, fetch, cache, base64
│   │   └── parsers.js               # mlsbd.co HTML parsers
│   ├── _middleware.js               # CORS preflight
│   ├── latest.js                    # GET /api/latest
│   ├── movie.js                     # GET /api/movie
│   ├── search.js                    # GET /api/search
│   ├── trending.js                  # GET /api/trending
│   ├── notice.js                    # GET /api/notice
│   ├── resolve.js                   # GET /api/resolve (direct URL extractor)
│   └── img.js                       # GET /api/img (image proxy)
├── proxy/                           # Cloudflare Worker (direct stream/download proxy)
│   ├── index.js                     # /proxy/<b64> + /resolve?url=<savelinks>
│   └── wrangler.toml
├── bot/                             # Telegram Bot (Cloudflare Worker)
│   ├── src/index.js                 # Bot code (commands, inline keyboards, banner, setup)
│   ├── wrangler.toml
│   ├── package.json
│   └── .env.example
├── wrangler.toml                    # Pages config
├── package.json
├── .gitignore
├── README.md                        # This file
└── HOW_IT_WORKS.md                  # Detailed architecture + flow
```

## ✨ Features

### Pixel-Perfect Clone of mlsbd.co
- **Exact design tokens**: `--red: #fb1114`, `--black: #0a0909`, `--grey: #535353`, Exo font, Google Sans
- **Cloned components**: header (logo + notice marquee + dark mode moon toggle + filter 18+), nav bar, featured slider (Trending), single-post movie grid, post-meta, section-title red bars, footer, go-to-top
- **Cloned interactions**: dark mode toggle (localStorage), poster hover opacity, sticky nav, marquee auto-scroll, featured slider prev/next
- **Rebranded**: every "MLSBD" → "SKMovies", logo replaced, all links point to skmovies.pages.dev

### Ad-Free
- All ads, popups, Google AdSense, trackers removed
- Clean, distraction-free movie browsing

### Premium Additions
- **External player detection** — Android (MX Player, VLC, Just Player, MPV, KM Player), iOS (VLC, Infuse, PlayerXtreme, Outplayer), Windows (VLC, PotPlayer, MPV, MPC-HC), macOS (IINA, VLC, MPV)
- **Direct URL resolver** — extracts .mp4/.mkv from savelinks.me → gdflix/multicloud
- **Video proxy** — adds Referer header so MX Player/VLC/downloads work
- **Dashboard** — stats, extracted URLs, watchlist, history, export
- **PWA** — installable, offline support
- **Telegram Bot** — commands, inline keyboards, banner image, auto-setup
- **Telegram Mini App** — full web app inside Telegram

## 🚀 Deploy (3 Steps)

### Step 1 — Deploy Cloudflare Pages (the website)

```bash
cd skmovies-final
npm install

# Create Pages project
npx wrangler pages project create skmovies --production-branch main

# Deploy
npx wrangler pages deploy public --project-name skmovies --branch main
```

Live at **`https://skmovies.pages.dev`** 🎉

### Step 2 — Deploy the Proxy Worker (direct stream/download)

```bash
cd proxy
npx wrangler deploy
# Note the URL: https://skmovies-proxy.<your-subdomain>.workers.dev
```

### Step 3 — Deploy the Telegram Bot

```bash
cd bot
npx wrangler secret put BOT_TOKEN    # from @BotFather
npx wrangler deploy
# Note the URL: https://skmovies-bot.<your-subdomain>.workers.dev

# One-shot setup (sets commands, menu button, webhook):
# Visit in browser:
https://skmovies-bot.<your-subdomain>.workers.dev/setup?token=<BOT_TOKEN>&webhook=1
```

Done! Your bot now has:
- 10 commands (`/start`, `/latest`, `/search`, `/help`, `/miniapp`, etc.)
- Menu button → opens Mini App
- Webhook configured
- Banner image on /start

## 📋 Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome with banner image |
| `/help` | Help & commands list |
| `/latest` | Latest movies (inline buttons) |
| `/search <query>` | Search movies |
| `/favs` | Watchlist (in Mini App) |
| `/history` | Recently viewed (in Mini App) |
| `/stats` | Download stats (in Mini App) |
| `/settings` | Bot settings |
| `/request <name>` | Request a movie |
| `/miniapp` | Open Mini App button |

## 🎨 Design Tokens (exact from mlsbd.co)

```css
:root {
  --font-primary: 'Exo', sans-serif;
  --font-secondary: 'Google Sans', sans-serif;
  --red: #fb1114;
  --black: #0a0909;
  --grey: #535353;
}
```

## 🔧 API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/latest?page=1&filter=all&adult=0` | Latest movies |
| `GET /api/movie?slug=<slug>` | Movie details + downloads |
| `GET /api/search?q=<query>&page=1` | Search |
| `GET /api/trending` | Trending movies |
| `GET /api/notice` | Upcoming releases marquee |
| `GET /api/resolve?url=<savelinks>` | Extract direct video URL |
| `GET /api/img?u=<base64url>` | Image proxy |

Proxy Worker:
| Endpoint | Description |
|----------|-------------|
| `GET /proxy/<base64url>` | Video proxy (adds Referer) |
| `GET /resolve?url=<savelinks>` | Resolve direct URL |

## 📊 Cost

| Resource | Free Tier | Usage |
|----------|-----------|-------|
| Cloudflare Pages | 500 builds/month, unlimited requests | ✅ |
| Cloudflare Workers | 100k requests/day | ✅ |
| Telegram Bot API | Free | ✅ |
| **Total** | **$0** | ✅ |

## ⚠️ Legal Note

Personal use only. This is a link aggregator — it does not host any content.
Copyright is the user's responsibility.

## 📄 License

MIT — open source, public, free to use.

## 📖 How It Works

See **[HOW_IT_WORKS.md](HOW_IT_WORKS.md)** for the detailed architecture, data flow, and component breakdown.
