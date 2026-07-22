# SKMovies v3.5.0 — Quick Deploy Guide

## What's new

- ✅ **Fibwatch poster fix** — posters now load correctly (was showing "No Poster")
- ✅ **HDHubMain "fau" link cleanup** — download list went from 63 entries (54 fau) to ~10 real entries
- ✅ **Ad-free iframe player** — `iframe-player.html` plays streams without upstream ads
- ✅ **GitHub-backed mega cache** — pre-fetches 1000+ items per source for super-fast loading
- ✅ **`hdhubmain` source toggle fix** — was silently falling back to MLSBD

## Files in this package

```
skmovies-v3.5.0/
├── index.html                  # Replace existing
├── app.js                      # Replace existing (v3.5.0)
├── styles.css                  # Unchanged (keep existing)
├── manifest.json               # Unchanged (keep existing)
├── iframe-player.html          # NEW — upload to project root
├── functions/
│   └── api/
│       ├── cache.js            # NEW — GitHub cache Function
│       ├── resolve.js          # From v3.4.0 (or keep your existing)
│       ├── proxy.js            # From v3.4.0 (or keep your existing)
│       ├── hdhub4u/list.js     # From v3.4.0 (or keep your existing)
│       └── moviebox/trending.js # From v3.4.0 (or keep your existing)
├── scripts/
│   └── build_cache.js          # NEW — Node.js cache builder
├── AUDIT_REPORT.md             # Full audit + technical docs
└── README_DEPLOY.md            # This file
```

## Quick deploy (3 steps)

### Step 1 — Upload frontend

Replace these files in your Cloudflare Pages project root:
- `index.html`
- `app.js`
- `iframe-player.html` (NEW)

### Step 2 — Upload backend Functions

Upload to `functions/api/`:
- `cache.js` (NEW — required for caching to work)
- Other files from v3.4.0 (if not already deployed)

### Step 3 — Set up GitHub cache (recommended for super-fast loading)

1. Create a GitHub repo, e.g. `skmovies/cache`
2. Create a GitHub personal access token: https://github.com/settings/tokens
   - Scope: `repo` (for private repos) — not needed for public repos
3. In Cloudflare Pages dashboard → Settings → Environment variables, add:
   ```
   SKM_CACHE_REPO = skmovies/cache
   SKM_CACHE_TOKEN = ghp_xxxxxxxxxxxx
   ```
4. (Optional) Bind a KV namespace as `SKM_CACHE`:
   ```bash
   wrangler kv:namespace create SKM_CACHE
   ```
5. Run the cache builder locally or via CI:
   ```bash
   export SKM_SITE=https://skmovies-premium.pages.dev
   export GH_TOKEN=ghp_xxxxxxxxxxxx
   export GH_REPO=skmovies/cache
   node scripts/build_cache.js
   ```

Without GitHub cache, the site still works (just slower) — `/api/cache` falls back to live upstream.

## Verify the deploy

After deploy, run these smoke tests:

```bash
# 1. Frontend version
curl -s "https://skmovies-premium.pages.dev/" | grep -oE 'app\.js\?v=[0-9.]+'
# Expected: app.js?v=3.5.0

# 2. iframe player loads
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://skmovies-premium.pages.dev/iframe-player.html?url=test&title=test"
# Expected: 200

# 3. Cache endpoint works
curl -s "https://skmovies-premium.pages.dev/api/cache?src=mlsbd&path=latest&page=1" \
  | jq -r '.ok'
# Expected: true

# 4. Fibwatch posters load (visit site, switch to Fibwatch source, posters should show)
# 5. HDHubMain downloads cleaned up (visit site, switch to HDHubMain, open movie, download list should have < 15 items)
```

## Set up automatic cache refresh (recommended)

The cache goes stale as new movies are added. Set up a cron to refresh every 6 hours.

### Option A: GitHub Actions (recommended — free)

Create `.github/workflows/refresh-cache.yml` in a repo that has `scripts/build_cache.js`:

```yaml
name: Refresh SKMovies cache
on:
  schedule:
    - cron: '0 */6 * * *'  # every 6 hours
  workflow_dispatch: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: node scripts/build_cache.js
        env:
          SKM_SITE: https://skmovies-premium.pages.dev
          GH_TOKEN: ${{ secrets.GH_TOKEN }}
          GH_REPO: skmovies/cache
```

Add `GH_TOKEN` as a repository secret.

### Option B: Run manually when needed

```bash
SKM_SITE=https://skmovies-premium.pages.dev \
GH_TOKEN=ghp_xxx \
GH_REPO=skmovies/cache \
node scripts/build_cache.js
```

## What if something breaks?

### Site loads but no movies show
- Check Cloudflare Pages Function logs for `/api/cache` errors
- Temporarily revert `getApi()` in `app.js` to use direct endpoints (remove `/api/cache?src=...&path=...` wrapping)

### Posters not loading
- Check browser console for 403s from `myuijy.b-cdn.net` or other BunnyCDN hosts
- Verify `/api/img?u=<base64>` returns 200 for those hosts

### iframe player shows "Could not extract direct video"
- Some hosts (hubcdn.sbs, hubdrive.tips) don't expose direct video URLs in HTML
- This is expected — fall back to HDPlayer or VLC

### MovieBox 429 errors
- Bind a KV namespace as `SKM_CACHE` (see Step 3.4 above)
- The Function caches responses for 5 minutes + serves stale for 24 hours

### HDHubMain shows old fau links
- Hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R) — the filter is client-side
- Check that `app.js?v=3.5.0` is loaded (not an older cached version)

## Rollback plan

If anything breaks, revert to v3.4.0:
1. Re-upload your previous `index.html` and `app.js` (v3.4.0 versions)
2. Delete `iframe-player.html` and `functions/api/cache.js`
3. Cloudflare Pages will redeploy within ~30 seconds

## Need help?

Read `AUDIT_REPORT.md` for:
- Full architecture overview
- Per-source test results
- Root cause analysis of every bug
- AI handoff notes for future development
