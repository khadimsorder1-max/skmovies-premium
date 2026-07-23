#!/usr/bin/env node
/**
 * SKMovies Fojik Direct Cache Populator v1.2
 * --------------------------------------------
 * Direct scrapes https://fojik.site/ (bypasses Cloudflare Worker IP block)
 * and writes JSON cache files to skmovies-cache repo.
 *
 * Works both:
 *   - Locally: writes to ../skmovies-cache-repo/fojik/
 *   - CI/CD:   writes to env CACHE_OUT_DIR (e.g., ./skmovies-cache-out/fojik)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────────
const PAGES_COUNT = parseInt(process.env.PAGES || '10', 10);
const DETAILS_COUNT = parseInt(process.env.DETAILS || '200', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);

// Output directory: env override (for CI) or default (local dev)
const CACHE_DIR = process.env.CACHE_OUT_DIR
  ? path.resolve(process.env.CACHE_OUT_DIR)
  : path.join(__dirname, '../skmovies-cache-repo/fojik');

const MOVIE_DIR = path.join(CACHE_DIR, 'movie');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(MOVIE_DIR)) fs.mkdirSync(MOVIE_DIR, { recursive: true });

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Fetch helpers ─────────────────────────────────────────────────────────────
function fetchRaw(url, depth) {
  depth = depth || 0;
  if (depth > 5) return Promise.resolve({ status: 508, body: '' });

  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;

      const reqOpts = {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
        timeout: 20000,
      };

      const req = lib.request(reqOpts, (res) => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${u.protocol}//${u.host}${res.headers.location}`;
          // Consume response body
          res.resume();
          return fetchRaw(loc, depth + 1).then(resolve);
        }

        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 504, body: '' });
      });
      req.on('error', (e) => {
        resolve({ status: 500, body: '', error: e.message });
      });
      req.end();
    } catch (e) {
      resolve({ status: 500, body: '', error: e.message });
    }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runWithConcurrency(tasks, concurrency) {
  return new Promise(async (resolve) => {
    let i = 0, ok = 0, fail = 0;
    async function worker() {
      while (i < tasks.length) {
        const task = tasks[i++];
        try { await task(); ok++; } catch { fail++; }
      }
    }
    const workers = [];
    for (let w = 0; w < Math.min(concurrency, tasks.length); w++) workers.push(worker());
    await Promise.all(workers);
    resolve({ ok, fail });
  });
}

// ── HTML parsers ──────────────────────────────────────────────────────────────
function parseFojikList(html) {
  const items = [];
  const seen = new Set();

  // Fojik uses WordPress with IMDB-Movie-Database plugin: <article class="...">
  const itemRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let m;

  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1];

    // Poster image
    const imgM = block.match(/data-lazy-src="([^"]+)"|data-src="([^"]+)"|<img[^>]+src="([^"]+)"/i);
    let img = imgM ? (imgM[1] || imgM[2] || imgM[3] || '') : '';
    if (img.startsWith('//')) img = 'https:' + img;

    // Title & URL — try .entry-title a first, then any heading link
    const titleM = block.match(/<h\d[^>]*class="[^"]*entry-title[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<h\d[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href="(https?:\/\/fojik\.site\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);

    if (!titleM) continue;

    const rawUrl = titleM[1];
    const title = titleM[2].replace(/<[^>]+>/g, '').replace(/&#\d+;/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
    if (!rawUrl || title.length < 3) continue;

    // Slug from URL
    const slugM = rawUrl.match(/\/movie\/([^/]+)\/?$|\/series\/([^/]+)\/?$|\/([^/]+)\/?$/);
    const slug = slugM ? (slugM[1] || slugM[2] || slugM[3] || '') : '';
    if (!slug || slug === 'movie' || slug === 'series' || slug === 'genre' || slug === 'category' || seen.has(slug)) continue;
    seen.add(slug);

    // Quality from title
    const qualityM = title.match(/(4K\s*UHD|4K|2160p|1080p|720p|480p|WEB-DL|WEBRip|BluRay|HEVC|HDRip|PRE-HD|CAMRip)/i);
    const quality = qualityM ? qualityM[1].toUpperCase().replace(' ', '') : 'HD';

    // Year
    const yearM = title.match(/\b(19\d{2}|20\d{2})\b/);
    const year = yearM ? yearM[1] : '';

    items.push({
      id: slug, slug, title,
      poster: img, quality, year, rating: '', source: 'fojik', url: rawUrl,
    });
  }

  return items;
}

function parseFojikMoviePage(html, targetUrl, slug) {
  // Title
  const titleM = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').replace(/&#\d+;/g, ' ').replace(/&amp;/g, '&').trim() : slug;

  // Poster
  const posterM = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
    || html.match(/<img[^>]+class="[^"]*wp-post-image[^"]*"[^>]+src="([^"]+)"/i)
    || html.match(/<img[^>]+src="([^"]+)"/i);
  const poster = posterM ? posterM[1] : '';

  // Storyline
  const storyM = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const storyline = storyM
    ? storyM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600).trim()
    : '';

  // Genres from meta or breadcrumb
  const genres = [];
  const genreRe = /rel="category tag"[^>]*>([\s\S]*?)<\/a>/gi;
  let gm;
  while ((gm = genreRe.exec(html)) !== null) {
    const g = gm[1].trim();
    if (g && !genres.includes(g)) genres.push(g);
  }

  // Downloads — Fojik uses <form action="..."> with hidden FU/FN fields
  const downloads = [];
  const formRe = /<form[^>]*action=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/form>/gi;
  let fm;
  while ((fm = formRe.exec(html)) !== null) {
    const action = fm[1];
    const formInner = fm[2];
    // Must have FU and FN hidden fields
    if (!/name=['"]FU['"]/i.test(formInner) || !/name=['"]FN['"]/i.test(formInner)) continue;

    const fuM = formInner.match(/name=['"]FU['"]\s+value=['"]([^'"]+)['"]/i)
      || formInner.match(/name=['"]FU['"][^>]*value=['"]([^'"]+)['"]/i);
    const fnM = formInner.match(/name=['"]FN['"]\s+value=['"]([^'"]+)['"]/i)
      || formInner.match(/name=['"]FN['"][^>]*value=['"]([^'"]+)['"]/i);

    const fu = fuM ? fuM[1] : '';
    const fn = fnM ? fnM[1] : '';

    // Detect quality from button or label text near the form
    const btnM = formInner.match(/<button[^>]*>([\s\S]*?)<\/button>/i)
      || formInner.match(/value=['"]([^'"]*(?:480p|720p|1080p|4k|2160p|WEB-DL|BluRay|HDRip)[^'"]*)['"]/i);
    const btnText = btnM ? btnM[1].replace(/<[^>]+>/g, '').trim() : '';
    const qM = btnText.match(/(4K\s*UHD|4K|2160p|1080p|720p|480p|WEB-DL|WEBRip|BluRay|HDRip)/i);
    const quality = qM ? qM[1].toUpperCase() : '1080P';

    downloads.push({
      label: `Fojik - ${quality}`,
      url: action,
      savelinks_url: action,
      action,
      fu, fn,
      fojikFu: fu,
      fojikFn: fn,
      quality,
      host: 'Fojik',
      isFojikForm: true,
    });
  }

  return { id: slug, slug, title, poster, storyline, genres, downloads, source: 'fojik', url: targetUrl };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function run() {
  console.log('=== SKMovies Fojik Cache Populator v1.2 ===');
  console.log(`  Output dir: ${CACHE_DIR}`);
  console.log(`  Pages: ${PAGES_COUNT}, Details: ${DETAILS_COUNT}, Concurrency: ${CONCURRENCY}`);

  const baseHost = 'https://fojik.site';
  const allSlugs = new Set();
  let totalItems = 0;

  // ── List pages ──
  for (let page = 1; page <= PAGES_COUNT; page++) {
    const url = page === 1 ? `${baseHost}/` : `${baseHost}/page/${page}/`;
    process.stdout.write(`  → Page ${page}... `);

    const r = await fetchRaw(url);
    if (r.status !== 200) {
      console.log(`SKIP (status ${r.status})`);
      if (r.status >= 400) break;
      continue;
    }

    const items = parseFojikList(r.body);
    if (items.length === 0) {
      console.log('SKIP (0 items parsed)');
      if (page > 2) break;
      continue;
    }

    totalItems += items.length;
    const payload = {
      ok: true, page, items,
      hasMore: items.length >= 12,
      source: 'fojik',
      ts: Date.now(),
    };

    const fileName = page === 1 ? 'latest.json' : `latest-${page}.json`;
    fs.writeFileSync(path.join(CACHE_DIR, fileName), JSON.stringify(payload));
    items.forEach((it) => it.slug && allSlugs.add(it.slug));

    console.log(`✓ ${items.length} items (total slugs: ${allSlugs.size})`);
    await sleep(800);
  }

  // ── Trending (same as page 1) ──
  const rHome = await fetchRaw(baseHost + '/');
  if (rHome.status === 200) {
    const tItems = parseFojikList(rHome.body);
    const tPayload = { ok: true, page: 1, items: tItems, hasMore: true, source: 'fojik', ts: Date.now() };
    fs.writeFileSync(path.join(CACHE_DIR, 'trending.json'), JSON.stringify(tPayload));
    console.log(`  ✓ trending.json (${tItems.length} items)`);
  }

  // ── Movie detail pages ──
  const slugList = Array.from(allSlugs).slice(0, DETAILS_COUNT);
  console.log(`\n  → Fetching ${slugList.length} movie detail pages...`);

  const tasks = slugList.map((slug) => async () => {
    const safe = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
    const outPath = path.join(MOVIE_DIR, safe + '.json');

    // Check if already cached (skip if recent — within 6 hours)
    if (fs.existsSync(outPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        if (existing.ts && Date.now() - existing.ts < 6 * 3600 * 1000) return; // skip
      } catch {}
    }

    // Try /movie/slug/ then /slug/
    let r = await fetchRaw(`${baseHost}/movie/${slug}/`);
    if (r.status !== 200) r = await fetchRaw(`${baseHost}/${slug}/`);

    if (r.status === 200) {
      const targetUrl = `${baseHost}/movie/${slug}/`;
      const movie = parseFojikMoviePage(r.body, targetUrl, slug);
      const mPayload = { ok: true, movie, ts: Date.now() };
      fs.writeFileSync(outPath, JSON.stringify(mPayload));
      console.log(`    ✓ ${slug} (${movie.downloads.length} downloads)`);
    } else {
      console.log(`    ✗ ${slug} (status ${r.status})`);
    }

    await sleep(400);
  });

  const res = await runWithConcurrency(tasks, CONCURRENCY);
  console.log(`\n  ✓ Details: ${res.ok} ok, ${res.fail} fail`);
  console.log(`\n✓ Done! Total items: ${totalItems}, Cache: ${CACHE_DIR}`);
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });
