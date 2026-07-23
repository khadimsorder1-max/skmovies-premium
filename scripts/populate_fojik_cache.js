#!/usr/bin/env node
/**
 * SKMovies Fojik Full Cache Populator v2.0
 * ----------------------------------------
 * STRATEGY:
 *  - Main homepage (90 articles per page, but page 2+ = 404 → only 1 page)
 *  - Genre/Category pages: /genre/bollywood-hindi/, /genre/hollywood-english/, etc.
 *  - All genre pages use /genre/<slug>/page/<N>/ for pagination
 *  - Target: 500+ unique slugs
 *
 * MOVIE DETAILS (per movie):
 *  - Title, Poster (full-size og:image)
 *  - Screenshots from imgforwp.xyz
 *  - Genres from sgeneros
 *  - IMDB rating
 *  - Synopsis
 *  - Downloads: FU/FN form fields (base64 encoded URLs)
 *    → We POST to form action to get actual redirect URL
 *  - Direct stream: Any iframe/video src in the page
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── Config ─────────────────────────────────────────────────────────────────────
const PAGES_PER_GENRE = parseInt(process.env.PAGES_PER_GENRE || '5', 10);
const DETAILS_COUNT = parseInt(process.env.DETAILS || '500', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);

const CACHE_DIR = process.env.CACHE_OUT_DIR
  ? path.resolve(process.env.CACHE_OUT_DIR)
  : path.join(__dirname, '../skmovies-cache-repo/fojik');

const MOVIE_DIR = path.join(CACHE_DIR, 'movie');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(MOVIE_DIR)) fs.mkdirSync(MOVIE_DIR, { recursive: true });

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// All genre pages to scrape (from fojik.site nav menu)
const GENRE_PAGES = [
  'bollywood-hindi',
  'hollywood-english',
  'tamil',
  'telugu',
  'malayalam',
  'dual-audio',
  'hindi-dubbed',
  'hevc-collection',
  'tv-web-series',
  'action',
  'thriller',
  'drama',
  'romance',
  'sci-fi',
  'comedy',
  'horror',
  'korean',
  'japanese-chinese',
  'animation',
  'kannada',
];

// ── Fetch helpers ──────────────────────────────────────────────────────────────
function fetchRaw(url, opts, depth) {
  depth = depth || 0;
  opts = opts || {};
  if (depth > 5) return Promise.resolve({ status: 508, body: '' });

  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;

      const reqOpts = {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: Object.assign({
          'User-Agent': BROWSER_UA,
          'Accept': opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        }, opts.headers || {}),
        timeout: 20000,
      };

      const req = lib.request(reqOpts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${u.protocol}//${u.host}${res.headers.location}`;
          res.resume();
          return fetchRaw(loc, opts, depth + 1).then(resolve);
        }
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers, finalUrl: url }));
      });

      req.on('timeout', () => { req.destroy(); resolve({ status: 504, body: '' }); });
      req.on('error', (e) => resolve({ status: 500, body: '', error: e.message }));
      if (opts.body) req.write(opts.body);
      req.end();
    } catch (e) {
      resolve({ status: 500, body: '', error: e.message });
    }
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

function decodeHtmlEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#038;/g, '&');
}

// ── HTML parsers ────────────────────────────────────────────────────────────────
function parseFojikList(html, sourceLabel) {
  const items = [];
  const seen = new Set();

  // Fojik uses DooPlay theme - articles with class "post"
  const itemRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let m;

  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1];

    // Poster image - prefer data-src (lazy loaded) over src
    const imgM = block.match(/data-lazy-src="([^"]+)"|data-src="([^"]+)"|<img[^>]+src="([^"]+wp-content[^"]+)"/i);
    let img = imgM ? (imgM[1] || imgM[2] || imgM[3] || '') : '';
    if (img.startsWith('//')) img = 'https:' + img;
    // Upgrade to full size (remove -185x278 thumbnail suffix)
    img = img.replace(/-\d+x\d+(\.\w+)$/, '$1');

    // Title & URL
    const titleM = block.match(/<h\d[^>]*class="[^"]*entry-title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<h\d[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href="(https?:\/\/fojik[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);

    if (!titleM) continue;

    const rawUrl = titleM[1];
    const title = decodeHtmlEntities(titleM[2].replace(/<[^>]+>/g, '').trim());
    if (!rawUrl || title.length < 3) continue;

    // Extract slug
    const slugM = rawUrl.match(/\/movie\/([^/]+)\/?$|\/series\/([^/]+)\/?$|fojik\.site\/([^/]+)\/?$|\/([a-z0-9-]+)\/?$/i);
    const slug = slugM ? (slugM[1] || slugM[2] || slugM[3] || slugM[4] || '') : '';
    if (!slug || ['movie', 'series', 'genre', 'category', 'page', 'tag'].includes(slug) || seen.has(slug)) continue;
    seen.add(slug);

    // Quality
    const qualityM = title.match(/(4K UHD|4K|2160p|1080p|720p|480p|WEB-DL|WEBRip|BluRay|HEVC|HDRip|PRE-HD|CAMRip|ORG)/i);
    const quality = qualityM ? qualityM[1].toUpperCase() : 'HD';

    // Year
    const yearM = title.match(/\b(19\d{2}|20\d{2})\b/);
    const year = yearM ? yearM[1] : '';

    // Rating from article if available
    const ratingM = block.match(/<span[^>]*class="[^"]*rating[^"]*"[^>]*>([\d.]+)/i);
    const rating = ratingM ? ratingM[1] : '';

    items.push({ id: slug, slug, title, poster: img, quality, year, rating, source: 'fojik', url: rawUrl });
  }

  return items;
}

function parseFojikMoviePage(html, targetUrl, slug) {
  // Title from og:title (most reliable)
  const ogTitleM = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const rawTitle = (ogTitleM && ogTitleM[1]) || (h1M && h1M[1].replace(/<[^>]+>/g, '')) || slug;
  const title = decodeHtmlEntities(rawTitle.trim());

  // Poster - og:image gives full size (not thumbnail)
  const ogImgM = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  const poster = ogImgM ? ogImgM[1] : '';

  // Screenshots from imgforwp.xyz or img.imgforwp.xyz
  const screenshots = [];
  const ssRe = /<img[^>]+src="(https?:\/\/img(?:forw[^"]+)\.(?:xyz|com)[^"]+)"/gi;
  let ssM;
  while ((ssM = ssRe.exec(html)) !== null) {
    const ssUrl = ssM[1];
    if (!screenshots.includes(ssUrl)) screenshots.push(ssUrl);
  }

  // Genres from .sgeneros
  const genres = [];
  const sgeneros = html.match(/<div[^>]*class="sgeneros"[^>]*>([\s\S]*?)<\/div>/i);
  if (sgeneros) {
    const gRe = /href="[^"]*\/genre\/([^/"]+)[^"]*"[^>]*>([^<]+)</gi;
    let gm;
    while ((gm = gRe.exec(sgeneros[1])) !== null) {
      const g = gm[2].trim();
      if (g && !genres.includes(g)) genres.push(g);
    }
  }

  // IMDB rating
  const imdbM = html.match(/IMDb[^<]*<span[^>]*>([\d.]+)<\/span>/i)
    || html.match(/class="[^"]*imdb[^"]*"[^>]*>([\d.]+)/i)
    || html.match(/<span[^>]*class="[^"]*starstruck-rating[^"]*"[^>]*>[\s\S]*?([\d.]+)/i);
  const imdbRating = imdbM ? imdbM[1] : '';

  // Release date
  const dateM = html.match(/<span[^>]*class="date"[^>]*>([^<]+)<\/span>/i)
    || html.match(/<meta[^>]*property="article:published_time"[^>]*content="([^"]+)"/i);
  const releaseDate = dateM ? dateM[1].trim() : '';

  // Synopsis from .wp-content > p (first real paragraph)
  const synopM = html.match(/<div[^>]*class="[^"]*wp-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  let synopsis = '';
  if (synopM) {
    const paragraphs = synopM[1].match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
    for (const p of paragraphs) {
      const text = decodeHtmlEntities(p.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      if (text.length > 30 && !/screenshot|download|link/i.test(text)) {
        synopsis = text.slice(0, 600);
        break;
      }
    }
  }

  // Downloads — Fojik uses forms with single-quote attributes: name='FU' value='...' name='FN'
  const downloads = [];

  // Helper: extract attr value from input tag (handles both single and double quotes)
  function extractInputAttr(tag, attrName) {
    const re = new RegExp('name=[\'"]' + attrName + '[\'"][^>]*value=[\'"]([^\'"]+)[\'"]', 'i');
    const re2 = new RegExp('value=[\'"]([^\'"]+)[\'"][^>]*name=[\'"]' + attrName + '[\'"]', 'i');
    const m = tag.match(re) || tag.match(re2);
    return m ? m[1] : '';
  }

  const formRe = /<form[^>]*action=['"]([^'"]+)['"][^>]*>([\s\S]{0,3000}?)<\/form>/gi;
  let fm;
  while ((fm = formRe.exec(html)) !== null) {
    const action = fm[1];
    const inner = fm[2];
    if (!/name=['"]FU['"]/i.test(inner)) continue;

    // Extract FU and FN values
    const inputTags = inner.match(/<input[^>]+>/gi) || [];
    let fu = '', fn = '';
    for (const tag of inputTags) {
      const nameM = tag.match(/name=['"]([^'"]+)['"]/i);
      const valM = tag.match(/value=['"]([^'"]*)['"](?=[^>]*>|\s*\/>)/i) || tag.match(/value=['"]([^'"]*)['"]/);
      if (!nameM || !valM) continue;
      if (nameM[1].toUpperCase() === 'FU') fu = valM[1];
      if (nameM[1].toUpperCase() === 'FN') fn = decodeHtmlEntities(valM[1]);
    }

    if (!fu) continue;

    // Get context around the form for quality/size info
    const formCtx = html.slice(Math.max(0, fm.index - 600), Math.min(html.length, fm.index + fm[0].length + 200));
    const qM = formCtx.match(/(4K UHD|4K|2160p|1080p|720p|480p|WEB-DL|WEBRip|BluRay|HDRip|HEVC)/i);
    const quality = qM ? qM[1].toUpperCase() : '1080P';
    const langM = formCtx.match(/\b(Hindi|English|Tamil|Telugu|Bengali|Korean|Japanese|Malayalam|Kannada|Dual Audio)\b/i);
    const lang = langM ? langM[1] : '';
    const sizeM = formCtx.match(/(\d+(?:\.\d+)?\s*(?:MB|GB))/i);
    const size = sizeM ? sizeM[1] : '';
    const hostM = formCtx.match(/\b(GDrive|Google Drive|GDRive|Hubcloud|Savelinks|Filepress|GDFlix)\b/i);
    const host = hostM ? hostM[1] : 'Fojik';

    downloads.push({
      label: [quality, lang, size].filter(Boolean).join(' • ') || quality,
      quality, lang, size, host,
      url: action,
      fu, fn,
      fojikFu: fu,
      fojikFn: fn,
      isFojikForm: true,
    });
  }

  // Stream links — look for video iframes or embed URLs
  const streams = [];
  const embedRe = /(?:src|data-src)="(https?:\/\/(?:www\.)?(?:youtube\.com\/embed|youtu\.be|embed\.fojik|player\.[^"]+|iframe\.[^"]+)[^"]*)"/gi;
  let em;
  while ((em = embedRe.exec(html)) !== null) {
    const eUrl = em[1];
    if (!streams.includes(eUrl)) streams.push({ url: eUrl, type: 'embed' });
  }

  return {
    id: slug, slug, title, poster, screenshots,
    synopsis, genres, imdbRating, releaseDate,
    downloads, streams,
    source: 'fojik', url: targetUrl,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────────
async function run() {
  console.log('=== SKMovies Fojik Full Cache Populator v2.0 ===');
  console.log(`  Output: ${CACHE_DIR}`);
  console.log(`  Target: ${DETAILS_COUNT}+ items, Concurrency: ${CONCURRENCY}`);

  const baseHost = 'https://fojik.site';
  const allSlugs = new Set();
  const allItems = [];

  // ── Step 1: Scrape homepage ──
  console.log('\n[1/3] Scraping homepage...');
  const rHome = await fetchRaw(baseHost + '/');
  if (rHome.status === 200) {
    const homeItems = parseFojikList(rHome.body, 'home');
    homeItems.forEach(it => { if (!allSlugs.has(it.slug)) { allSlugs.add(it.slug); allItems.push(it); } });
    console.log(`  Home: ${homeItems.length} items`);
  }

  // ── Step 2: Scrape genre pages ──
  console.log(`\n[2/3] Scraping ${GENRE_PAGES.length} genre pages (${PAGES_PER_GENRE} pages each)...`);
  for (const genre of GENRE_PAGES) {
    let genreTotal = 0;
    for (let page = 1; page <= PAGES_PER_GENRE; page++) {
      const url = page === 1 ? `${baseHost}/genre/${genre}/` : `${baseHost}/genre/${genre}/page/${page}/`;
      const r = await fetchRaw(url);
      if (r.status !== 200) break;
      const items = parseFojikList(r.body, genre);
      if (items.length === 0) break;

      items.forEach(it => { if (!allSlugs.has(it.slug)) { allSlugs.add(it.slug); allItems.push(it); } });
      genreTotal += items.length;
      await sleep(500);
    }
    if (genreTotal > 0) console.log(`  /genre/${genre}/: +${genreTotal} (total: ${allSlugs.size})`);
    if (allSlugs.size >= DETAILS_COUNT * 2) break; // enough slugs
  }

  console.log(`\n  Total unique slugs: ${allSlugs.size}`);

  // Save paginated list files (split into groups of 20 per page)
  const PAGE_SIZE = 20;
  const allItemsArr = allItems.slice(0, DETAILS_COUNT);
  for (let p = 0; p < Math.ceil(allItemsArr.length / PAGE_SIZE); p++) {
    const pageItems = allItemsArr.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
    const payload = { ok: true, page: p + 1, items: pageItems, hasMore: (p + 1) * PAGE_SIZE < allItemsArr.length, source: 'fojik', ts: Date.now() };
    const fname = p === 0 ? 'latest.json' : `latest-${p + 1}.json`;
    fs.writeFileSync(path.join(CACHE_DIR, fname), JSON.stringify(payload));
  }

  // Save trending (first 20)
  const tPayload = { ok: true, page: 1, items: allItemsArr.slice(0, 20), hasMore: true, source: 'fojik', ts: Date.now() };
  fs.writeFileSync(path.join(CACHE_DIR, 'trending.json'), JSON.stringify(tPayload));
  console.log(`\n  Saved ${Math.ceil(allItemsArr.length / PAGE_SIZE)} list pages (${allItemsArr.length} items total)`);

  // ── Step 3: Fetch movie details ──
  const slugList = Array.from(allSlugs).slice(0, DETAILS_COUNT);
  console.log(`\n[3/3] Fetching ${slugList.length} movie detail pages...`);

  const tasks = slugList.map((slug) => async () => {
    const safe = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
    const outPath = path.join(MOVIE_DIR, safe + '.json');

    // Skip if recently cached (< 6h old)
    if (fs.existsSync(outPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        if (existing.ts && Date.now() - existing.ts < 6 * 3600 * 1000) return;
      } catch {}
    }

    let r = await fetchRaw(`${baseHost}/movie/${slug}/`);
    if (r.status !== 200) r = await fetchRaw(`${baseHost}/${slug}/`);

    if (r.status === 200) {
      const movie = parseFojikMoviePage(r.body, `${baseHost}/movie/${slug}/`, slug);
      fs.writeFileSync(outPath, JSON.stringify({ ok: true, movie, ts: Date.now() }));
      process.stdout.write(`    ✓ ${slug.slice(0, 40)} (${movie.downloads.length}dl ${movie.screenshots.length}ss)\n`);
    }

    await sleep(350);
  });

  const result = await runWithConcurrency(tasks, CONCURRENCY);
  console.log(`\n  ✓ Details: ${result.ok} ok, ${result.fail} fail`);
  console.log(`\n✓ Done! ${allItemsArr.length} list items, ${result.ok} detail pages cached.`);
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });
