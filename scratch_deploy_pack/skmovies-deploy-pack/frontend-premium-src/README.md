# SKMovies Premium — Source Mirror

Mirror of **https://skmovies-premium.pages.dev/** (Cloudflare Pages static SPA).

## Files
- `index.html` — App shell (SPA entry point; client-side routing handles `?view=...`)
- `app.js` — Application logic (vanilla JS, ~110 KB)
- `styles.css` — Full stylesheet (~69 KB)
- `manifest.json` — PWA manifest
- `assets/` — Icons & images (`favicon-32.webp`, `apple-touch-icon.webp`, `empty.webp`)

## Notes
- This is the **deployed/bundled** frontend, not the original repo. The site is a single-page app; routes like `?view=dashboard`, `?view=trending`, `?view=favs`, `?view=history`, `?view=south`, `?view=south-hindi` are all handled by the same `index.html` + `app.js`.
- Asset filenames had `?v=3.3.8` cache-buster query strings; those were stripped so files open cleanly offline.
- All upstream image hosts (`mlsbd-image.com`, `cdn.imgnest.io`, `m.media-amazon.com`, `image.tmdb.org`) are referenced via `<link rel="preconnect">` — they're external CDNs and not bundled.
- API endpoints (`/api/...`) are proxied by Cloudflare Pages Functions and are not included — they only exist server-side.

## Run locally
```bash
python3 -m http.server 8080
# open http://localhost:8080/
```
Note: API calls to `/api/...` will fail locally without the Cloudflare Pages Functions backend.
