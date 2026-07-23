#!/usr/bin/env node
/**
 * SKMovies Fojik Entire-Site Cache Populator v4.0
 * ------------------------------------------------
 * CORRECT APPROACH:
 * - Fojik uses post-sitemap.xml (NOT attachment-sitemap) for movie posts
 * - Supplemented with all genre pages (unlimited pagination)
 * - Skips image attachments, junk slugs
 * - Caches FU/FN tokens for direct downloads + stream info
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '6', 10);
const MAX_GENRE_PAGES = parseInt(process.env.PAGES || '99', 10); // per genre

const CACHE_DIR = process.env.CACHE_OUT_DIR
  ? path.resolve(process.env.CACHE_OUT_DIR)
  : path.join(__dirname, '../skmovies-cache-repo/fojik');

const MOVIE_DIR = path.join(CACHE_DIR, 'movie');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(MOVIE_DIR)) fs.mkdirSync(MOVIE_DIR, { recursive: true });

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const GENRE_PAGES = [
  'bollywood-hindi', 'hollywood-english', 'tamil', 'telugu', 'malayalam',
  'dual-audio', 'hindi-dubbed', 'hevc-collection', 'tv-web-series',
  'action', 'thriller', 'drama', 'romance', 'sci-fi', 'comedy', 'horror',
  'korean', 'japanese-chinese', 'animation', 'kannada', 'pakistani-movies', 'others'
];

// Slugs that are clearly NOT movies
const JUNK_SLUG_RE = /^(wp-content|uploads|thumb|thumbnail|attachment|page|tag|category|author|feed|search|genre|movie|series|download|how-to|about|contact|privacy|sitemap|xml|rss|css|js|img|image|photo|screenshot|adspic|lastpage|download|null|undefined)$/i;
const JUNK_SLUG_PATTERN = /-jpg$|-png$|-jpeg$|-gif$|-webp$|^[a-z0-9]{28,}$|\?attachment_id=|^[0-9]+$|screenshot|^w300|^adspic|lastpage/i;

function isValidMovieSlug(slug) {
  if (!slug || slug.length < 3 || slug.length > 150) return false;
  if (JUNK_SLUG_RE.test(slug)) return false;
  if (JUNK_SLUG_PATTERN.test(slug)) return false;
  // Must contain at least one letter and one hyphen OR be a valid title slug
  if (!/[a-z]/i.test(slug)) return false;
  return true;
}

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
        }, opts.headers || {}),
        timeout: 20000,
      };

      const req = lib.request(reqOpts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location.startsWith('http') ? res.headers.location : `${u.protocol}//${u.host}${res.headers.location}`;
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
    } catch (e) { resolve({ status: 500, body: '', error: e.message }); }
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

function parseFojikList(html) {
  const items = [];
  const seen = new Set();
  const itemRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let m;

  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1];
    const imgM = block.match(/data-lazy-src="([^"]+)"|data-src="([^"]+)"|<img[^>]+src="([^"]+wp-content[^"]+)"/i);
    let img = imgM ? (imgM[1] || imgM[2] || imgM[3] || '') : '';
    if (img.startsWith('//')) img = 'https:' + img;
    img = img.replace(/-\d+x\d+(\.\w+)$/, '$1');

    const titleM = block.match(/<h\d[^>]*class="[^"]*entry-title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<h\d[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href="(https?:\/\/fojik[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);

    if (!titleM) continue;

    const rawUrl = titleM[1];
    const title = decodeHtmlEntities(titleM[2].replace(/<[^>]+>/g, '').trim());
    if (!rawUrl || title.length < 3) continue;

    const slugM = rawUrl.match(/\/movie\/([^/]+)\/?$|\/series\/([^/]+)\/?$|\/([a-z0-9][a-z0-9-]{2,})\/?$/i);
    const slug = slugM ? (slugM[1] || slugM[2] || slugM[3] || '') : '';
    if (!isValidMovieSlug(slug) || seen.has(slug)) continue;
    seen.add(slug);

    const qualityM = title.match(/(4K UHD|4K|2160p|1080p|720p|480p|WEB-DL|WEBRip|BluRay|HEVC|HDRip|PRE-HD|ORG)/i);
    const quality = qualityM ? qualityM[1].toUpperCase() : 'HD';
    const yearM = title.match(/\b(19\d{2}|20\d{2})\b/);
    const year = yearM ? yearM[1] : '';

    items.push({ id: slug, slug, title, poster: img, quality, year, rating: '', source: 'fojik', url: rawUrl });
  }

  return items;
}

function parseFojikMoviePage(html, targetUrl, slug) {
  const ogTitleM = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const rawTitle = (ogTitleM && ogTitleM[1]) || (h1M && h1M[1].replace(/<[^>]+>/g, '')) || slug;
  const title = decodeHtmlEntities(rawTitle.trim());

  const ogImgM = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  const poster = ogImgM ? ogImgM[1] : '';

  const screenshots = [];
  const ssRe = /<img[^>]+src="(https?:\/\/img(?:forw[^"]+)\.(?:xyz|com)[^"]+)"/gi;
  let ssM;
  while ((ssM = ssRe.exec(html)) !== null) {
    if (!screenshots.includes(ssM[1])) screenshots.push(ssM[1]);
  }

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

  const imdbM = html.match(/IMDb[^<]*<span[^>]*>([\d.]+)<\/span>/i)
    || html.match(/class="[^"]*imdb[^"]*"[^>]*>([\d.]+)/i);
  const imdbRating = imdbM ? imdbM[1] : '';

  let synopsis = '';
  const synopM = html.match(/<div[^>]*class="[^"]*wp-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
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

  const downloads = [];
  const formRe = /<form[^>]*action=['"]([^'"]+)['"][^>]*>([\s\S]{0,3000}?)<\/form>/gi;
  let fm;
  while ((fm = formRe.exec(html)) !== null) {
    const action = fm[1];
    const inner = fm[2];
    if (!/name=['"]FU['"]/i.test(inner)) continue;

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
      url: action, fu, fn,
      fojikFu: fu, fojikFn: fn,
      isFojikForm: true,
    });
  }

  return {
    id: slug, slug, title, poster, screenshots,
    synopsis, genres, imdbRating,
    downloads,
    streams: downloads.map(d => ({
      url: d.url, label: `${d.quality || 'HD'} • ${d.host || 'Fojik'}`,
      isStream: true, fu: d.fu, fn: d.fn,
    })),
    source: 'fojik', url: targetUrl,
  };
}

async function run() {
  console.log('=== SKMovies Fojik Whole-Site Cache Populator v4.0 ===');
  console.log(`  Output: ${CACHE_DIR}, Concurrency: ${CONCURRENCY}`);

  const baseHost = 'https://fojik.site';
  const allSlugs = new Set();
  const allItems = [];
  const addItem = (it) => {
    if (!isValidMovieSlug(it.slug)) return;
    if (!allSlugs.has(it.slug)) {
      allSlugs.add(it.slug);
      allItems.push(it);
    }
  };

  // ── Step 1: Scrape genre pages (this is the most reliable source of movie slugs) ──
  console.log('\n[1/3] Scraping all genre/category pages...');
  for (const genre of GENRE_PAGES) {
    let genreTotal = 0;
    for (let page = 1; page <= MAX_GENRE_PAGES; page++) {
      const url = page === 1 ? `${baseHost}/genre/${genre}/` : `${baseHost}/genre/${genre}/page/${page}/`;
      const r = await fetchRaw(url);
      if (r.status !== 200) break;
      const items = parseFojikList(r.body);
      if (items.length === 0) break;
      items.forEach(addItem);
      genreTotal += items.length;
      await sleep(300);
    }
    if (genreTotal > 0) process.stdout.write(`  /genre/${genre}: +${genreTotal} (total: ${allSlugs.size})\n`);
  }

  // ── Step 2: Scrape homepage ──
  const rHome = await fetchRaw(baseHost + '/');
  if (rHome.status === 200) parseFojikList(rHome.body).forEach(addItem);

  console.log(`\n  ✓ Total valid movie slugs: ${allSlugs.size}, cards: ${allItems.length}`);

  // Save list files (20 per page)
  const PAGE_SIZE = 20;
  const totalPages = Math.ceil(allItems.length / PAGE_SIZE);
  console.log(`\n[2/3] Writing ${totalPages} list cache files...`);
  for (let p = 0; p < totalPages; p++) {
    const pageItems = allItems.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
    const payload = { ok: true, page: p + 1, totalPages, items: pageItems, hasMore: p + 1 < totalPages, source: 'fojik', ts: Date.now() };
    fs.writeFileSync(path.join(CACHE_DIR, p === 0 ? 'latest.json' : `latest-${p + 1}.json`), JSON.stringify(payload));
  }
  fs.writeFileSync(path.join(CACHE_DIR, 'trending.json'), JSON.stringify({ ok: true, page: 1, items: allItems.slice(0, 20), hasMore: true, source: 'fojik', ts: Date.now() }));

  // ── Step 3: Fetch details for all valid slugs ──
  const slugList = Array.from(allSlugs);
  console.log(`\n[3/3] Fetching detail pages for ${slugList.length} movies/series...`);

  const tasks = slugList.map((slug) => async () => {
    const safe = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
    const outPath = path.join(MOVIE_DIR, safe + '.json');

    // Skip fresh cache (< 12h old)
    if (fs.existsSync(outPath)) {
      try {
        const ex = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        if (ex.ts && Date.now() - ex.ts < 12 * 3600 * 1000) return;
      } catch {}
    }

    let r = await fetchRaw(`${baseHost}/movie/${slug}/`);
    if (r.status !== 200) r = await fetchRaw(`${baseHost}/${slug}/`);

    if (r.status === 200) {
      const movie = parseFojikMoviePage(r.body, `${baseHost}/movie/${slug}/`, slug);
      fs.writeFileSync(outPath, JSON.stringify({ ok: true, movie, ts: Date.now() }));
      process.stdout.write(`    ✓ ${slug.slice(0, 40)} (${movie.downloads.length}dl ${movie.screenshots.length}ss)\n`);
    }

    await sleep(280);
  });

  // Also clean up any existing junk files in movie dir
  const movieFiles = fs.readdirSync(MOVIE_DIR);
  let cleaned = 0;
  for (const f of movieFiles) {
    const slugCheck = f.replace('.json', '');
    if (!isValidMovieSlug(slugCheck)) {
      fs.unlinkSync(path.join(MOVIE_DIR, f));
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`  ✓ Cleaned ${cleaned} junk detail files`);

  const result = await runWithConcurrency(tasks, CONCURRENCY);
  console.log(`\n✓ Done! ${allItems.length} movies in ${totalPages} pages, ${result.ok} detail pages cached!`);
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });
