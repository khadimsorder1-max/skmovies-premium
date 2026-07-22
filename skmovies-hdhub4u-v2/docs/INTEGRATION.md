# Integration Guide — adding HDHub4u+ v2 to `skmovies-premium.pages.dev`

This guide assumes your existing Cloudflare Pages project lives in a
git repo (GitHub / GitLab / Bitbucket) and auto-builds on push.
If you use direct-upload instead, the same file placement applies —
just upload via the Cloudflare dashboard or `wrangler pages deploy`.

Per requirement #6 ("amar existing project e jeno kono issue nah hoy
kheyal rekho"), every file in this package is **additive** — none of
them will overwrite your existing site assets.

---

## Step 1 — Back up your current site

```bash
git clone https://github.com/<you>/skmovies-premium.git
cd skmovies-premium
git checkout -b add-hdhub4u-v2
```

Make sure you know where your existing source code lives:

- Your existing `mlsbd.co` and `freedrive` scrapers — are they
  Cloudflare Pages Functions (under `/functions/`)? Or pure
  client-side JS that calls the upstream sites directly through a
  public CORS proxy?
- Your existing index page — `index.html` at the root, or a build
  step (Vite / Next.js / Astro) that produces a `dist/` folder?

The HDHub4u+ module is **vanilla JS + Cloudflare Pages Functions**,
so it slots in beside any architecture you already use.

---

## Step 2 — Copy the files in

From this package:

```
skmovies-hdhub4u/
├── functions/api/hdhub4u/   →  copy entire folder to  <repo>/functions/api/hdhub4u/
└── public/                  →  copy entire folder's contents to  <repo>/public/
                                (or to <repo>/ root if your project has no /public)
```

If your repo doesn't already have a `functions/` folder, creating one
tells Cloudflare Pages to enable Pages Functions automatically — no
config needed.

### Important: do NOT overwrite your existing files

This package contains these files at the root of `public/`:

- `hdhub4u.html` — the HDHub4u+ demo landing page (renamed from
  `index.html` in v1, so it no longer conflicts with your site's
  `index.html`)
- `watch.html` — paste-a-URL player
- `player.html` — ad-free MKV/HLS/MP4 player
- `_headers` — additive caching + CORS rules
- `_redirects` — optional clean-URL redirects

If your repo already has `_headers` or `_redirects`, **merge** the
contents instead of overwriting. The HDHub4u+ entries only add
CORS + caching for `/api/hdhub4u/*` and the new JS/CSS/HTML files —
they don't touch your existing rules.

If your repo doesn't already have these files, copy them as-is.

---

## Step 3 — Verify the file layout

After copying, your repo should look something like this:

```
skmovies-premium/
├── functions/
│   └── api/
│       ├── mlsbd/              (your existing mlsbd.co scraper)
│       ├── freedrive/          (your existing freedrive scraper)
│       └── hdhub4u/            ← NEW
│           ├── _lib.js         (host resolver + shared lib)
│           ├── _cache.js       (3-layer cache: mem + KV + Cache API)
│           ├── host.js
│           ├── list.js
│           ├── movie.js
│           ├── categories.js
│           ├── stream.js
│           └── proxy.js
├── public/                     (or repo root if no /public)
│   ├── index.html              (your existing homepage — UNTOUCHED)
│   ├── hdhub4u.html            ← NEW (demo page)
│   ├── watch.html              ← NEW
│   ├── player.html             ← NEW (ad-free player)
│   ├── _headers                (merged — see below)
│   ├── _redirects              (merged — see below)
│   ├── css/
│   │   └── hdhub4u.css         ← NEW (scoped under .hd-* prefix)
│   ├── js/
│   │   ├── hdhub4u-client.js   ← NEW
│   │   └── hdhub4u-ui.js       ← NEW
│   └── ...
├── wrangler.toml               ← NEW (optional, for local dev)
└── ...
```

### Merging `_headers`

If your existing `_headers` looks like:

```
/*
  X-Frame-Options: DENY

/admin/*
  Basic-Auth: ...
```

Append the HDHub4u+ rules to the end:

```
/*
  X-Frame-Options: DENY

/admin/*
  Basic-Auth: ...

/* HDHub4u+ rules */
/*
  /api/hdhub4u/*
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Methods: GET, POST, OPTIONS
    Access-Control-Allow-Headers: Content-Type, X-Requested-With
    Cache-Control: public, max-age=60
  /css/hdhub4u.css
    Cache-Control: public, max-age=86400, immutable
  /js/hdhub4u-*.js
    Cache-Control: public, max-age=86400, immutable
  /player.html
    Cache-Control: public, max-age=3600
  /watch.html
    Cache-Control: public, max-age=3600
  /hdhub4u.html
    Cache-Control: public, max-age=60
```

Note: Cloudflare Pages `_headers` files support multiple `/*` blocks —
later rules don't override earlier ones, they merge.

### Merging `_redirects`

If you don't already have a `_redirects` file, copy ours as-is. If you
do, append any redirects you want (they're all commented out by default):

```
# HDHub4u+ convenience redirects (uncomment to enable)
# /hdhub4u  /hdhub4u.html  302
# /hdhub4u/ /hdhub4u.html  302
# /watch    /watch.html    302
# /player   /player.html   302
```

---

## Step 4 — Add a "Source" switcher to your existing UI

The demo `public/hdhub4u.html` in this package shows a source switcher
with three pills: `mlsbd.co`, `freedrive`, `hdhub4u`. You probably
already have similar UI on your site. The pattern is:

```html
<div class="source-switch" role="tablist">
  <button data-source="mlsbd">mlsbd.co</button>
  <button data-source="freedrive">freedrive</button>
  <button data-source="hdhub4u" class="active">hdhub4u</button>
</div>

<!-- Each source gets its own container; only one is visible at a time. -->
<div id="mlsbd-app"></div>
<div id="freedrive-app" style="display:none"></div>
<div id="hdhub4u-app"  style="display:none"></div>
```

```js
document.querySelectorAll('.source-switch button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.source-switch button')
      .forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const src = btn.dataset.source;

    document.getElementById('mlsbd-app').style.display     = src === 'mlsbd'    ? 'block' : 'none';
    document.getElementById('freedrive-app').style.display = src === 'freedrive'? 'block' : 'none';
    document.getElementById('hdhub4u-app').style.display   = src === 'hdhub4u'  ? 'block' : 'none';

    if (src === 'hdhub4u' && !window._hdhub4uUI) {
      // Lazy-init the HDHub4u+ UI the first time it's activated.
      window._hdhub4uUI = new HDHub4uUI({
        container: document.getElementById('hdhub4u-app')
      });
      window._hdhub4uUI.init();
    }
  });
});
```

**Why this matters:** keeping each source's UI isolated in its own
container means the HDHub4u+ dark theme (`.hd-*` classes) doesn't
interfere with your existing site styling. No CSS conflicts, no JS
global collisions.

Also make sure to load the HDHub4u+ assets **only on the page that
needs them** (or load them lazily on first activation):

```html
<!-- Option A: load on every page (simpler, ~30KB total gzipped) -->
<link rel="stylesheet" href="/css/hdhub4u.css">
<script src="/js/hdhub4u-client.js" defer></script>
<script src="/js/hdhub4u-ui.js" defer></script>
```

```js
// Option B: lazy-load only when HDHub4u is activated (best for perf)
async function activateHDHub4u() {
  if (!window.HDHub4uUI) {
    await Promise.all([
      loadStyle('/css/hdhub4u.css'),
      loadScript('/js/hdhub4u-client.js'),
      loadScript('/js/hdhub4u-ui.js'),
    ]);
  }
  // ... init UI ...
}

function loadStyle(href) {
  return new Promise((res, rej) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href;
    l.onload = res; l.onerror = rej;
    document.head.appendChild(l);
  });
}
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.defer = true;
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
```

---

## Step 5 — Optional: enable KV caching (recommended for production)

Per requirement #5, KV caching dramatically reduces Worker requests
and gives you cross-region cache coverage. **This step is optional —
the site works without it.**

1. Go to Cloudflare dashboard → **Workers & Pages** → **KV** →
   **Create namespace**
2. Name it `HDHUB4U_CACHE`
3. Go to your Pages project → **Settings** → **Functions** →
   **KV namespace bindings** → **Add binding**
4. Variable name: `HDHUB4U_CACHE` → KV namespace: `HDHUB4U_CACHE`
5. Save + redeploy

That's it. The cache layer automatically uses KV when available, and
falls back to Cache API when not. You don't need to change any code.

**Verify KV is working:** open DevTools → Network → click any movie.
The `/api/hdhub4u/movie?slug=…` response should have `"_cache": "kv"`
in the JSON. If it shows `"_cache": "cacheApi"` or `"_cache": "fresh"`
every time, the KV binding isn't set up correctly.

---

## Step 6 — Optional: pin a specific mirror (for testing)

If you want to override the auto-resolver:

1. Go to Pages project → **Settings** → **Environment variables**
2. Add `HDHUB4U_FORCE_HOST` = `https://new3.hdhub4u.cl/` (or whatever)
3. Save + redeploy

Leave it empty to use the auto-resolver. This is useful for testing
against a specific mirror without waiting for the auto-resolver to
catch up.

---

## Step 7 — Test locally with `wrangler`

Install the Cloudflare Pages CLI:

```bash
npm install -g wrangler
```

From your repo root:

```bash
wrangler pages dev . --compatibility-date=2024-09-01 --kv HDHUB4U_CACHE
```

- `.` is the directory containing your static files. If you use a
  build step, point this at your build output directory instead.
- `--kv HDHUB4U_CACHE` creates a local KV namespace for dev. The
  cache layer uses it automatically.

Open `http://localhost:8788/hdhub4u.html` to test. Verify:

1. The HDHub4u+ UI loads.
2. The category bar populates from the live `hdhub4u.med` site.
3. Search returns results.
4. Clicking a movie opens the modal with downloads + screenshots.
5. Clicking ▶ Player 1 opens our ad-free player (player.html).
6. Try a movie with a known MKV download — the player should attempt
   Clappr fallback.
7. The MX / VLC / KMPlayer buttons appear in the player topbar.
8. The host pill in the header shows the current mirror (e.g.
   `new3.hdhub4u.cl`).
9. DevTools → Network → second click on the same movie should show
   `"_cache": "kv"` or `"_cache": "cacheApi"` in the response.

---

## Step 8 — Deploy

Commit and push:

```bash
git add functions/api/hdhub4u/ public/css/hdhub4u.css \
        public/js/hdhub4u-client.js public/js/hdhub4u-ui.js \
        public/hdhub4u.html public/watch.html public/player.html \
        public/_headers public/_redirects wrangler.toml
git commit -m "Add HDHub4u+ v2 source — ad-free player + KV caching + auto mirror tracking"
git push origin add-hdhub4u-v2
```

Merge to your main branch — Cloudflare Pages will auto-build and
deploy. Verify the same 9 things from Step 7 against
`https://skmovies-premium.pages.dev/hdhub4u.html`.

---

## Step 9 — Wire up the source switcher (final touch)

In your existing site JS, find where the user picks a source and
wire it up:

```js
function activateHDHub4u() {
  document.getElementById('mlsbd-app').style.display     = 'none';
  document.getElementById('freedrive-app').style.display = 'none';
  document.getElementById('hdhub4u-app').style.display   = 'block';
  if (!window._hdhub4uUI) {
    window._hdhub4uUI = new HDHub4uUI({
      container: document.getElementById('hdhub4u-app')
    });
    window._hdhub4uUI.init();
  }
}
```

Done! 🎉

---

## Troubleshooting

### "I get CORS errors in the browser console"

Make sure you deployed the `functions/api/hdhub4u/` folder. The
Pages Functions automatically add `Access-Control-Allow-Origin: *`
to every response. If you see CORS errors, the functions aren't
deployed — check your build logs.

### "The active host pill shows 'offline'"

Every resolver is down AND the landing page can't be fetched AND
every fallback host is unreachable. This is rare but possible if
Cloudflare itself is having issues. Wait a minute and refresh.

If it persists, pin a mirror via `HDHUB4U_FORCE_HOST` env var
(Step 6).

### "Movies load but posters are blank"

You're probably behind a network that blocks `image.tmdb.org` or
`catimages.org`. The UI already has an `onerror` fallback that
retries through `/api/hdhub4u/proxy?url=…` — so this should be
self-healing. If it's still not working, check that the proxy
endpoint is deployed.

### "Stream button does nothing"

Open the browser DevTools network tab. You should see a request to
`/api/hdhub4u/stream?url=…`. If it returns 502, the upstream player
page changed structure — check `functions/api/hdhub4u/stream.js`
and update the regex patterns.

### "Player loads but shows 'Could not resolve stream'"

The player page (hubstream.art / hdstream4u.com) changed its HTML
structure and our regexes can't find the direct URL. Open the
player URL directly in your browser, view source, and look for
`.mp4` / `.m3u8` / `.mkv` URLs. Update the patterns in
`functions/api/hdhub4u/stream.js` to match.

As a fallback, switch to "Original" mode in the header toggle —
this loads the original HDHub4u player in a sandboxed iframe.

### "MX Player button doesn't open MX Player"

The `intent://` URI only works on Android with MX Player installed.
On iOS / desktop, the link falls back to the direct `.mp4` URL and
will start a download. If MX Player is installed but doesn't open,
make sure you're using the free version's package
(`com.mxtech.videoplayer.ad`) — for the Pro version, change it to
`com.mxtech.videoplayer.pro` in `functions/api/hdhub4u/stream.js`
(search for `MX_PACKAGE` or `com.mxtech`).

### "VLC button doesn't open VLC"

Make sure VLC is installed and registered the `vlc://` URL scheme.
On Android, VLC registers it automatically. On iOS, you need VLC
3.x+. On desktop, VLC doesn't register `vlc://` — use the "Open
URL" button instead and copy the URL into VLC's "Open Network
Stream" dialog.

### "MKV files don't play in the browser"

MKV is a container, not a codec. Whether it plays depends on the
codec inside. Our player tries Clappr (which uses MediaSource +
Matroska demuxer) — if that fails, it falls back to the original
sandboxed iframe and shows a "Open in VLC" button.

For guaranteed MKV playback, use the **MX Player** or **VLC**
button — both handle every MKV codec natively.

### "HDHub4u changed their domain — the site broke"

The auto-resolver should pick up the new domain within 6 hours
(KV cache TTL). To force an immediate refresh:

1. Go to Cloudflare dashboard → Workers & Pages → KV →
   `HDHUB4U_CACHE` namespace
2. Find the key `ACTIVE_HOST` and delete it
3. (Optional) Also purge the Cache API: Pages project →
   Settings → Caching → Purge Everything

Or just set `HDHUB4U_FORCE_HOST` to the new domain temporarily.

### "KV cache is never hitting (always shows _cache: 'fresh')"

Verify the KV binding:

1. Pages project → Settings → Functions → KV namespace bindings
2. Variable name should be **exactly** `HDHUB4U_CACHE` (case-sensitive)
3. The namespace should be selected from the dropdown
4. Save and redeploy

If the binding is missing, the cache layer falls back to Cache API
(which is always available). The site still works — just without
cross-region caching.

---

## Updating the parser when HDHub4u changes its HTML

HDHub4u's WordPress theme updates every few months. If you notice
empty movie cards or missing download links:

1. Open `https://hdhub4u.med/` in your browser, click the "Enter
   Site" button, then right-click a movie card → Inspect.
2. Compare the actual HTML structure with the regexes in
   `functions/api/hdhub4u/list.js` (for cards) or `movie.js`
   (for download links).
3. Update the regexes — they're written to be permissive, so small
   class-name changes usually still work. Major restructuring
   (e.g. switching from `<article>` to `<div class="movie-card">`)
   will require updating the patterns.

The category, search, and pagination logic is generic enough that
it shouldn't need updates — those rely on URL conventions, not
markup.

For download link extraction, the v2 parser runs **5 strategies**
in parallel and merges the results, so even if one strategy breaks,
the others usually still find the links. You'll only notice a
problem if all 5 strategies fail simultaneously.

---

## Need a different host mirror?

The auto-resolver should handle this automatically, but if you want
to hard-code a specific mirror:

```js
// In _lib.js, FALLBACK_HOSTS array:
const FALLBACK_HOSTS = [
  'https://new3.hdhub4u.cl/',     // current live mirror
  'https://hdhub4u.ag/',
  'https://hdhub4u.download/',
  // ...add more here
];
```

Or set the `HDHUB4U_FORCE_HOST` env var (Step 6) — this is the
recommended approach since it doesn't require code changes.
