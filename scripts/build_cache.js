#!/usr/bin/env node
/**
 * SKMovies Mega Cache Builder v4.11.13
 * ---------------------------------------------------------------------------
 * Scrapes all sources DIRECTLY (bypassing CF Worker limits) and writes JSON
 * to GitHub repo for edge serving.
 *
 * Special handling:
 *  - moviebox: calls h5-api.aoneroom.com directly (works from Node.js/Actions)
 *  - hdhubmain: scrapes new3.hdhub4u.cl directly + resolves hdhub.boats links
 *  - hdhub4u:   scrapes hdhub4us.ai.in directly + resolves hdhub.boats links
 *  - others:    calls SKM_SITE API (CF Worker) as before
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

const SKM_SITE = process.env.SKM_SITE || 'https://skmovies-premium.pages.dev';
const GH_TOKEN  = process.env.GH_TOKEN;
const GH_REPO   = process.env.GH_REPO || 'khadimsorder1-max/skmovies-cache';
const GH_BRANCH = process.env.GH_BRANCH || 'main';

if (!GH_TOKEN) {
  console.error('ERROR: GH_TOKEN is required');
  process.exit(1);
}

const PAGES_PER_SOURCE   = parseInt(process.env.PAGES    || '30', 10);
const DETAILS_PER_SOURCE = parseInt(process.env.DETAILS  || '500', 10);
const CONCURRENCY        = parseInt(process.env.CONCURRENCY || '4', 10);

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Generic HTTP fetch with redirect follow
function fetchRaw(url, opts) {
  opts = opts || {};
  return new Promise(function(resolve, reject) {
    var u;
    try { u = new URL(url); } catch(e) { return reject(new Error('Invalid URL: ' + url)); }
    var lib = u.protocol === 'https:' ? https : http;
    var reqOpts = {
      method: opts.method || 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: Object.assign({
        'User-Agent': opts.ua || BROWSER_UA,
        'Accept': opts.accept || 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      }, opts.headers || {}),
      timeout: opts.timeout || 25000,
    };
    var req = lib.request(reqOpts, function(res) {
      if ([301,302,303,307,308].indexOf(res.statusCode) !== -1 && res.headers.location) {
        var loc = res.headers.location.startsWith('http') ? res.headers.location : (u.protocol + '//' + u.host + res.headers.location);
        return fetchRaw(loc, opts).then(resolve).catch(reject);
      }
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() { resolve({ status: res.statusCode, headers: res.headers, body: body }); });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function fetchJson(url, opts) {
  opts = opts || {};
  opts.accept = 'application/json,*/*;q=0.8';
  var r = await fetchRaw(url, opts);
  if (r.status >= 400) throw new Error('HTTP ' + r.status + ' for ' + url);
  var trimmed = r.body.trim();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') throw new Error('Non-JSON from ' + url + ' (starts: ' + trimmed.slice(0,50) + ')');
  return JSON.parse(r.body);
}

async function githubPutFile(path, content, message) {
  var url = 'https://api.github.com/repos/' + GH_REPO + '/contents/' + path;
  var sha;
  try {
    var r = await fetchRaw(url, { headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json' } });
    if (r.status === 200) sha = JSON.parse(r.body).sha;
  } catch(e) {}
  var body = JSON.stringify({
    message: message || ('cache: ' + path),
    content: Buffer.from(content).toString('base64'),
    branch: GH_BRANCH,
    ...(sha ? { sha: sha } : {}),
  });
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var r2 = await fetchRaw(url, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + GH_TOKEN, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
        body: body,
      });
      if (r2.status === 200 || r2.status === 201) return;
      if (r2.status === 409) { await sleep(1000); continue; }
      throw new Error('GitHub ' + r2.status + ': ' + r2.body.slice(0, 200));
    } catch(e) {
      if (attempt === 2) throw e;
      await sleep(1000);
    }
  }
}

async function runWithConcurrency(tasks, concurrency) {
  var idx = 0; var ok = 0; var fail = 0; var total = tasks.length;
  async function worker() {
    while (idx < tasks.length) {
      var i = idx++;
      try { await tasks[i](); ok++; } catch(e) { fail++; }
      if ((ok + fail) % 10 === 0 || (ok + fail) === total)
        process.stdout.write('\r  · progress: ' + (ok+fail) + '/' + total + ' (ok=' + ok + ', fail=' + fail + ')  ');
    }
  }
  await Promise.all(Array.from({ length: concurrency }, function() { return worker(); }));
  console.log('');
  return { ok: ok, fail: fail };
}

// ── hdhub.boats resolver ──────────────────────────────────────────────────
var REAL_DL_RE = /fastdl\.zip|vcloud\.zip|filebee\.xyz|gofile\.io|vikingfile\.com|megaup\.net|pixeldrain\.com|uploadhaven\.com|hubcdn\.sbs|hubdrive\.|gadgetsweb\.xyz|hubstream\.art|hubcloud\.|gdflix\.|filepress\.|gdtot\.|gdlink\.dev|multidownload\.|busycdn\.xyz|indexserver\.site|hdstream4u\.com/i;

async function resolveBoatsLinks(boatsUrl) {
  try {
    var r = await fetchRaw(boatsUrl);
    if (r.status !== 200) return [];
    var links = [];
    var re = /href="(https?:\/\/[^"]+)"/gi;
    var m;
    while ((m = re.exec(r.body)) !== null) {
      if (REAL_DL_RE.test(m[1])) links.push(m[1]);
    }
    return links;
  } catch(e) { return []; }
}

function detectHost(url) {
  try {
    var h = new URL(url).hostname.toLowerCase();
    if (h.indexOf('fastdl') !== -1) return 'FastDL';
    if (h.indexOf('vcloud') !== -1) return 'VCloud';
    if (h.indexOf('filebee') !== -1) return 'FileBee';
    if (h.indexOf('gofile') !== -1) return 'GoFile';
    if (h.indexOf('vikingfile') !== -1) return 'VikingFile';
    if (h.indexOf('megaup') !== -1) return 'MegaUp';
    if (h.indexOf('hubcdn') !== -1) return 'HubCDN';
    if (h.indexOf('hubdrive') !== -1) return 'HubDrive';
    if (h.indexOf('gadgetsweb') !== -1) return 'GadgetsWeb';
    if (h.indexOf('hubstream') !== -1) return 'HubStream';
    if (h.indexOf('hubcloud') !== -1) return 'HubCloud';
    if (h.indexOf('gdflix') !== -1) return 'GDFlix';
    if (h.indexOf('filepress') !== -1) return 'FilePress';
    if (h.indexOf('gdtot') !== -1) return 'GDTot';
    if (h.indexOf('hdstream4u') !== -1) return 'HDStream4U';
    return h;
  } catch(e) { return ''; }
}

// ── MOVIEBOX (direct aoneroom.com) ────────────────────────────────────────
function normalizeMovieboxItem(it) {
  var poster = '';
  if (typeof it.cover === 'string') poster = it.cover;
  else if (it.cover && it.cover.url) poster = it.cover.url;
  else if (it.posterUrl) poster = typeof it.posterUrl === 'object' ? (it.posterUrl.url || '') : it.posterUrl;
  var slug = '';
  if (it.detailPath && it.subjectId) slug = it.detailPath + '?id=' + it.subjectId;
  else slug = String(it.subjectId || it.id || '');
  return { slug: slug, title: it.title || it.name || 'Untitled', poster: poster, year: it.releaseYear || it.year || (it.releaseDate ? String(it.releaseDate).slice(0,4) : ''), quality: 'HD', language: '', rating: it.imdbRatingValue || it.imdbRating || '', type: it.subjectType === 2 ? 'tv' : 'movie' };
}

async function buildMoviebox() {
  console.log('\n=== Building cache: moviebox (direct aoneroom.com) ===');
  var allSlugs = new Set();
  for (var page = 1; page <= PAGES_PER_SOURCE; page++) {
    try {
      var data = await fetchJson('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/trending?page=' + page + '&perPage=24');
      var rawItems = (data.data && data.data.subjectList) || [];
      if (rawItems.length === 0) { console.log('  · moviebox page ' + page + ': empty'); break; }
      var normalized = rawItems.map(normalizeMovieboxItem).filter(function(it) { return it.slug; });
      var payload = { ok: true, page: page, items: normalized, movies: normalized, hasMore: rawItems.length >= 24, source: 'moviebox', ts: Date.now() };
      var filename = 'moviebox/latest' + (page > 1 ? '-' + page : '') + '.json';
      await githubPutFile(filename, JSON.stringify(payload), 'cache: moviebox page ' + page);
      normalized.forEach(function(it) { if (it.slug) allSlugs.add(it.slug); });
      console.log('  ✓ ' + filename + ' (' + normalized.length + ' items, total: ' + allSlugs.size + ')');
      if (rawItems.length < 24) break;
      await sleep(400);
    } catch(e) { console.warn('  ✗ moviebox page ' + page + ': ' + e.message); break; }
  }
  // trending.json = page 1
  try {
    var td = await fetchJson('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/trending?page=1&perPage=24');
    var ri = (td.data && td.data.subjectList) || [];
    var ni = ri.map(normalizeMovieboxItem).filter(function(it) { return it.slug; });
    await githubPutFile('moviebox/trending.json', JSON.stringify({ ok: true, page: 1, items: ni, movies: ni, hasMore: true, source: 'moviebox', ts: Date.now() }), 'cache: moviebox trending');
    console.log('  ✓ moviebox/trending.json (' + ni.length + ' items)');
  } catch(e) { console.warn('  ✗ moviebox/trending.json: ' + e.message); }
  console.log('  → Total moviebox slugs: ' + allSlugs.size);

  // Movie details via SKM API
  var slugs = Array.from(allSlugs).slice(0, DETAILS_PER_SOURCE);
  console.log('  → Fetching ' + slugs.length + ' movie details...');
  var tasks = slugs.map(function(slug) {
    return async function() {
      var data = await fetchJson(SKM_SITE + '/api/moviebox/movie?slug=' + encodeURIComponent(slug));
      var safe = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
      await githubPutFile('moviebox/movie/' + safe + '.json', JSON.stringify(data), 'cache: moviebox movie');
      await sleep(300);
    };
  });
  var res = await runWithConcurrency(tasks, CONCURRENCY);
  console.log('  ✓ moviebox details: ' + res.ok + ' ok, ' + res.fail + ' fail');
}

// ── HDHub direct scraper ──────────────────────────────────────────────────
function parseHDHubList(html) {
  var items = [];
  var seen = new Set();
  // article-based
  var articleRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  var am;
  while ((am = articleRe.exec(html)) !== null) {
    var block = am[1];
    var urlM = block.match(/href="(https?:\/\/(?:hdhub4us?\.ai\.in|hdhub4u\.|new3\.hdhub4u)[^"]+)"/i);
    var titleM = block.match(/<(?:h2|h3)[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i) || block.match(/<a[^>]+title="([^"]+)"/i);
    var imgM = block.match(/(?:data-src|src)="(https?:\/\/[^"]+\.(?:webp|jpg|jpeg|png)[^"]*)"/i);
    if (urlM && titleM) {
      var pageUrl = urlM[1];
      var slug = pageUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/\/$/, '');
      if (slug && !seen.has(slug) && !/category|tag|author|how-to/i.test(slug)) {
        seen.add(slug);
        items.push({ slug: slug, title: titleM[1].trim(), poster: imgM ? imgM[1] : '', quality: 'HD', language: 'Hindi Dubbed', year: '', sizes: [] });
      }
    }
  }
  if (items.length > 0) return items;
  // li-based fallback
  var liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  var lm;
  while ((lm = liRe.exec(html)) !== null) {
    var block2 = lm[1];
    var aM = block2.match(/href="(https?:\/\/(?:hdhub4us?\.ai\.in|hdhub4u\.|new3\.hdhub4u)[^"]+)"/i);
    var tM = block2.match(/<p[^>]*>([^<]+)<\/p>/i);
    var imgM2 = block2.match(/(?:data-src|src)="([^"]+)"/i);
    if (aM && tM) {
      var slug2 = aM[1].replace(/^https?:\/\/[^\/]+\//, '').replace(/\/$/, '');
      if (slug2 && !seen.has(slug2) && !/category|tag|author|how-to/i.test(slug2)) {
        seen.add(slug2);
        items.push({ slug: slug2, title: tM[1].trim(), poster: imgM2 ? imgM2[1] : '', quality: 'HD', language: 'Hindi Dubbed', year: '', sizes: [] });
      }
    }
  }
  return items;
}

async function parseHDHubMoviePage(html, slug) {
  var title = ((html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) || [])[1] ||
               (html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || slug).replace(/<[^>]+>/g, '').trim();
  var poster = (html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || [])[1] || '';
  var yearM = title.match(/\((\d{4})\)/);
  var year = yearM ? yearM[1] : '';

  var contentM = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:footer|\/article|aside)/i);
  var scopedHtml = contentM ? contentM[1] : html;
  var storylineM = scopedHtml.match(/<p>([\s\S]*?)<\/p>/i);
  var storyline = storylineM ? storylineM[1].replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, '').replace(/\s+/g, ' ').trim().slice(0, 500) : '';

  var KNOWN_DL_RE = /hubcdn\.sbs|hubdrive\.|gadgetsweb\.xyz|hubstream\.art|hubcloud\.|gdflix\.|filepress\.|gdtot\.|gdlink\.dev|multidownload\.|busycdn\.xyz|indexserver\.site|hdstream4u\.com|fastdl|driveleech|savelinks|hdhub\.boats/i;
  var seenUrls = new Set();
  var downloads = [];
  var boatsUrls = [];

  var linkRe = /<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  var lm;
  while ((lm = linkRe.exec(scopedHtml)) !== null) {
    var linkUrl = lm[1];
    var linkText = lm[2].replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
    if (/facebook|twitter|telegram|whatsapp|reddit|t\.me|share|how-to|gmpg\.org|category|tag\/|author\/|#respond|wp-content|wp-includes/i.test(linkUrl)) continue;
    if (/hdhub4u\.|hdhub4us\.ai\.in|new3\.hdhub4u\.cl/i.test(linkUrl)) {
      var ls = linkUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/\/$/, '').split(/[?#]/)[0];
      if (ls !== slug && ls.indexOf(slug) !== 0) continue;
    }
    if (!KNOWN_DL_RE.test(linkUrl)) continue;
    if (seenUrls.has(linkUrl)) continue;
    seenUrls.add(linkUrl);
    if (/hdhub\.boats/i.test(linkUrl)) { boatsUrls.push(linkUrl); continue; }
    var ctx = scopedHtml.slice(Math.max(0, lm.index - 300), lm.index + 300);
    var q = (ctx.match(/\b(4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDRip|HEVC|10Bit|HQ-HDTC|HDTC|iMAX)\b/i) || [])[1] || '';
    var sz = (ctx.match(/(\d+(?:\.\d+)?\s*(?:GB|MB))/i) || [])[1] || '';
    var label = (linkText && linkText.length > 3 && linkText !== 'Download Now') ? linkText.slice(0, 80) : (q ? q.toUpperCase() + (sz ? ' (' + sz + ')' : '') : 'Download');
    downloads.push({ label: label, url: linkUrl, quality: q, size: sz, host: detectHost(linkUrl), isDirect: true });
  }

  // Resolve hdhub.boats intermediate pages
  for (var bi = 0; bi < Math.min(boatsUrls.length, 8); bi++) {
    var bUrl = boatsUrls[bi];
    var bCtx = scopedHtml.slice(scopedHtml.indexOf(bUrl) - 400, scopedHtml.indexOf(bUrl) + 100);
    var bq = (bCtx.match(/\b(4K|2160p|1080p|720p|480p)\b/i) || [])[1] || '';
    var bsz = (bCtx.match(/(\d+(?:\.\d+)?\s*(?:GB|MB))/i) || [])[1] || '';
    try {
      var realLinks = await resolveBoatsLinks(bUrl);
      for (var ri = 0; ri < realLinks.length; ri++) {
        var rl = realLinks[ri];
        if (seenUrls.has(rl)) continue;
        seenUrls.add(rl);
        downloads.push({ label: (bq ? bq.toUpperCase() + ' Direct' : 'Direct Download'), url: rl, quality: bq, size: bsz, host: detectHost(rl), isDirect: true, via: 'hdhub.boats' });
      }
      await sleep(400);
    } catch(e) {}
  }

  var streams = [];
  var seenStreamUrls = new Set();
  var streamLinkRe = /<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  var sm;
  while ((sm = streamLinkRe.exec(scopedHtml)) !== null) {
    var sUrl = sm[1];
    var sText = sm[2].replace(/<[^>]+>/g, '').trim().toUpperCase();
    if (/hdstream4u\.com|morencius\.com|hubstream\.art/i.test(sUrl) || /WATCH|PLAYER-2|STREAM|ONLINE/i.test(sText)) {
      if (!seenStreamUrls.has(sUrl) && !/facebook|twitter|telegram|whatsapp/i.test(sUrl)) {
        seenStreamUrls.add(sUrl);
        var label = sText || 'Watch Stream';
        if (/hdstream4u|morencius/i.test(sUrl) || sText === 'WATCH') label = 'Watch Player 1 (HDStream / Direct HLS)';
        else if (/hubstream/i.test(sUrl) || sText === 'PLAYER-2') label = 'Watch Player 2 (HubStream)';
        streams.push({ label: label, url: sUrl, host: /hdstream|morencius/i.test(sUrl) ? 'HDStream' : (/hubstream/i.test(sUrl) ? 'HubStream' : 'Stream') });
      }
    }
  }

  return { title: title, poster: poster, year: year, storyline: storyline, downloads: downloads, streams: streams };
}


var HDHUB4U_HOSTS = ['https://hdhub4us.ai.in', 'https://hdhub4u.skin', 'https://new3.hdhub4u.cl'];
var HDHUBMAIN_HOSTS = ['https://new3.hdhub4u.cl', 'https://hdhub4us.ai.in', 'https://hdhub4u.skin'];

async function tryHosts(hosts, path) {
  for (var i = 0; i < hosts.length; i++) {
    try {
      var url = hosts[i].replace(/\/$/, '') + path;
      var r = await fetchRaw(url);
      if (r.status === 200 && r.body.length > 5000 && !r.body.includes('cf-browser-verification')) return r.body;
    } catch(e) {}
    await sleep(600);
  }
  throw new Error('All hosts failed for path: ' + path);
}

async function buildHDHub(srcKey, hosts) {
  console.log('\n=== Building cache: ' + srcKey + ' (direct scrape + boats resolver) ===');
  var allSlugs = new Set();

  for (var page = 1; page <= PAGES_PER_SOURCE; page++) {
    var path = page > 1 ? '/page/' + page + '/?utm=mn1' : '/?utm=mn1';
    try {
      var html = await tryHosts(hosts, path);
      var items = parseHDHubList(html);
      if (items.length === 0) { console.log('  · ' + srcKey + ' page ' + page + ': empty, stopping'); break; }
      var payload = { ok: true, page: page, items: items, movies: items, hasMore: items.length >= 20, source: srcKey, ts: Date.now() };
      var filename = srcKey + '/latest' + (page > 1 ? '-' + page : '') + '.json';
      await githubPutFile(filename, JSON.stringify(payload), 'cache: ' + srcKey + ' page ' + page);
      items.forEach(function(it) { if (it.slug) allSlugs.add(it.slug); });
      console.log('  ✓ ' + filename + ' (' + items.length + ' items, total: ' + allSlugs.size + ')');
      if (items.length < 20) break;
      await sleep(1200);
    } catch(e) { console.warn('  ✗ ' + srcKey + ' page ' + page + ': ' + e.message); break; }
  }

  // trending = page 1 data
  try {
    var thtml = await tryHosts(hosts, '/?utm=mn1');
    var titems = parseHDHubList(thtml);
    await githubPutFile(srcKey + '/trending.json', JSON.stringify({ ok: true, page: 1, items: titems, movies: titems, hasMore: true, source: srcKey, ts: Date.now() }), 'cache: ' + srcKey + ' trending');
    console.log('  ✓ ' + srcKey + '/trending.json (' + titems.length + ' items)');
  } catch(e) { console.warn('  ✗ ' + srcKey + '/trending.json: ' + e.message); }

  console.log('  → Total ' + srcKey + ' slugs: ' + allSlugs.size);

  // Movie details - direct scrape with boats resolver
  var slugs = Array.from(allSlugs).slice(0, DETAILS_PER_SOURCE);
  console.log('  → Fetching ' + slugs.length + ' movie details (direct + boats resolver)...');
  var tasks = slugs.map(function(slug) {
    return async function() {
      var mHtml = await tryHosts(hosts, '/' + slug + '/');
      var movie = await parseHDHubMoviePage(mHtml, slug);
      var safe = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
      var payload = { ok: true, slug: slug, url: hosts[0] + '/' + slug + '/', title: movie.title, poster: movie.poster, year: movie.year, storyline: movie.storyline, genres: [], qualities: [], language: 'Hindi Dubbed', downloads: movie.downloads, streams: movie.streams, ts: Date.now() };
      await githubPutFile(srcKey + '/movie/' + safe + '.json', JSON.stringify(payload), 'cache: ' + srcKey + ' movie');
      await sleep(600);
    };
  });
  var res = await runWithConcurrency(tasks, Math.max(1, CONCURRENCY - 1));
  console.log('  ✓ ' + srcKey + ' details: ' + res.ok + ' ok, ' + res.fail + ' fail');
}

// ── Generic source via SKM API ────────────────────────────────────────────
function getListUrl(src, page) {
  if (src === 'mlsbd') return SKM_SITE + '/api/latest?page=' + page;
  if (src === 'fdm') return SKM_SITE + '/api/fdm/latest?page=' + page;
  if (src === 'fibwatch') return SKM_SITE + '/api/fibwatch/latest?page=' + page;
  if (src === 'fojik') return SKM_SITE + '/api/fojik/list?type=home&page=' + page;
  if (src === 'krx18') return SKM_SITE + '/api/krx18/list?type=home&page=' + page;
  if (src === 'nongor') return SKM_SITE + '/api/nongor/latest?page=' + page + '&sort=year_desc';
}
function getTrendingUrl(src) {
  if (src === 'mlsbd') return SKM_SITE + '/api/trending';
  if (src === 'fdm') return SKM_SITE + '/api/fdm/trending';
  if (src === 'fibwatch') return SKM_SITE + '/api/fibwatch/trending';
  if (src === 'fojik') return SKM_SITE + '/api/fojik/list?type=home&page=1';
  if (src === 'krx18') return SKM_SITE + '/api/krx18/list?type=home&page=1';
  if (src === 'nongor') return SKM_SITE + '/api/nongor/latest?page=1&sort=top_rated';
}
function getMovieUrl(src, slug) {
  if (src === 'mlsbd') return SKM_SITE + '/api/movie?slug=' + encodeURIComponent(slug);
  if (src === 'fdm') return SKM_SITE + '/api/fdm/movie?slug=' + encodeURIComponent(slug);
  if (src === 'fibwatch') return SKM_SITE + '/api/fibwatch/movie?slug=' + encodeURIComponent(slug);
  if (src === 'fojik') return SKM_SITE + '/api/fojik/movie?slug=' + encodeURIComponent(slug) + '&_cb=' + Date.now();
  if (src === 'krx18') return SKM_SITE + '/api/krx18/movie?slug=' + encodeURIComponent(slug);
  if (src === 'nongor') return SKM_SITE + '/api/nongor/movie?slug=' + encodeURIComponent(slug) + '&_cb=' + Date.now();
}
function respItems(r) { return r ? (r.movies || r.items || []) : []; }

async function buildGenericSource(src) {
  console.log('\n=== Building cache: ' + src + ' (via SKM API) ===');
  try {
    var t = await fetchJson(getTrendingUrl(src));
    await githubPutFile(src + '/trending.json', JSON.stringify(t), 'cache: ' + src + ' trending');
    console.log('  ✓ ' + src + '/trending.json (' + respItems(t).length + ' items)');
  } catch(e) { console.warn('  ✗ ' + src + '/trending: ' + e.message); }
  var allSlugs = new Set();
  for (var page = 1; page <= PAGES_PER_SOURCE; page++) {
    try {
      var data = await fetchJson(getListUrl(src, page));
      var items = respItems(data);
      if (items.length === 0) { console.log('  · ' + src + ' page ' + page + ': empty'); break; }
      var filename = src + '/latest' + (page > 1 ? '-' + page : '') + '.json';
      await githubPutFile(filename, JSON.stringify(data), 'cache: ' + src + ' page ' + page);
      items.forEach(function(it) { if (it.slug) allSlugs.add(it.slug); });
      console.log('  ✓ ' + filename + ' (' + items.length + ')');
      if (data.hasMore === false) break;
      await sleep(400);
    } catch(e) { console.warn('  ✗ ' + src + ' page ' + page + ': ' + e.message); break; }
  }
  var slugs = Array.from(allSlugs).slice(0, DETAILS_PER_SOURCE);
  var tasks = slugs.map(function(slug) {
    return async function() {
      var data = await fetchJson(getMovieUrl(src, slug));
      if (!data.ok) throw new Error(data.error || 'not ok');
      var safe = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
      await githubPutFile(src + '/movie/' + safe + '.json', JSON.stringify(data), 'cache: ' + src + ' movie');
      await sleep(400);
    };
  });
  var res = await runWithConcurrency(tasks, CONCURRENCY);
  console.log('  ✓ ' + src + ' details: ' + res.ok + ' ok, ' + res.fail + ' fail');
}


// ── Fojik source ─────────────────────────────────────────────────────────
async function buildFojik() {
  console.log('\n=== Building cache: fojik (via SKM API + flatten) ===');
  var allSlugs = new Set();
  try {
    var t = await fetchJson(getTrendingUrl('fojik'));
    await githubPutFile('fojik/trending.json', JSON.stringify(t), 'cache: fojik trending');
    console.log('  ✓ fojik/trending.json (' + respItems(t).length + ' items)');
  } catch(e) { console.warn('  ✗ fojik trending: ' + e.message); }

  for (var page = 1; page <= PAGES_PER_SOURCE; page++) {
    try {
      var data = await fetchJson(getListUrl('fojik', page));
      var items = respItems(data);
      if (items.length === 0) { console.log('  · fojik page ' + page + ': empty'); break; }
      var filename = 'fojik/latest' + (page > 1 ? '-' + page : '') + '.json';
      await githubPutFile(filename, JSON.stringify(data), 'cache: fojik page ' + page);
      items.forEach(function(it) { if (it.slug) allSlugs.add(it.slug); });
      console.log('  ✓ ' + filename + ' (' + items.length + ')');
      if (data.hasMore === false) break;
      await sleep(400);
    } catch(e) { console.warn('  ✗ fojik page ' + page + ': ' + e.message); break; }
  }
  console.log('  → Total fojik slugs: ' + allSlugs.size);

  var slugs = Array.from(allSlugs).slice(0, DETAILS_PER_SOURCE);
  var tasks = slugs.map(function(slug) {
    return async function() {
      var data = await fetchJson(getMovieUrl('fojik', slug));
      // [#v4.11.13] FLATTEN: if response has { movie: {...} } but no top-level downloads,
      // merge movie fields to top level so frontend normalizeMovie() works.
      if (data.movie && !data.downloads) {
        data = Object.assign({}, data.movie, { ok: true, movie: data.movie });
      }
      if (!data.ok) throw new Error(data.error || 'not ok');
      var safe = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
      await githubPutFile('fojik/movie/' + safe + '.json', JSON.stringify(data), 'cache: fojik movie');
      await sleep(400);
    };
  });
  var res = await runWithConcurrency(tasks, CONCURRENCY);
  console.log('  ✓ fojik details: ' + res.ok + ' ok, ' + res.fail + ' fail');
}

// ── Nongor source ────────────────────────────────────────────────────────
async function buildNongor() {
  console.log('\n=== Building cache: nongor (via SKM API) ===');
  var allSlugs = new Set();
  try {
    var t = await fetchJson(getTrendingUrl('nongor'));
    await githubPutFile('nongor/trending.json', JSON.stringify(t), 'cache: nongor trending');
    console.log('  ✓ nongor/trending.json (' + respItems(t).length + ' items)');
  } catch(e) { console.warn('  ✗ nongor trending: ' + e.message); }

  for (var page = 1; page <= PAGES_PER_SOURCE; page++) {
    try {
      var data = await fetchJson(getListUrl('nongor', page));
      var items = respItems(data);
      if (items.length === 0) { console.log('  · nongor page ' + page + ': empty'); break; }
      var filename = 'nongor/latest' + (page > 1 ? '-' + page : '') + '.json';
      await githubPutFile(filename, JSON.stringify(data), 'cache: nongor page ' + page);
      items.forEach(function(it) { if (it.slug) allSlugs.add(it.slug); });
      console.log('  ✓ ' + filename + ' (' + items.length + ')');
      if (data.hasMore === false) break;
      await sleep(400);
    } catch(e) { console.warn('  ✗ nongor page ' + page + ': ' + e.message); break; }
  }
  console.log('  → Total nongor slugs: ' + allSlugs.size);

  var slugs = Array.from(allSlugs).slice(0, DETAILS_PER_SOURCE);
  var tasks = slugs.map(function(slug) {
    return async function() {
      var data = await fetchJson(getMovieUrl('nongor', slug));
      if (!data.ok) throw new Error(data.error || 'not ok');
      var safe = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
      await githubPutFile('nongor/movie/' + safe + '.json', JSON.stringify(data), 'cache: nongor movie');
      await sleep(400);
    };
  });
  var res = await runWithConcurrency(tasks, CONCURRENCY);
  console.log('  ✓ nongor details: ' + res.ok + ' ok, ' + res.fail + ' fail');
}

// ── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('SKMovies Mega Cache Builder v4.11.13');
  console.log('  Site: ' + SKM_SITE + '  Repo: ' + GH_REPO + '  Pages: ' + PAGES_PER_SOURCE + '  Details: ' + DETAILS_PER_SOURCE);
  var requested = (process.env.SOURCES || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  var all = requested.length > 0 ? requested : ['moviebox', 'hdhub4u', 'hdhubmain', 'mlsbd', 'fdm', 'fibwatch', 'fojik', 'krx18', 'nongor'];
  for (var i = 0; i < all.length; i++) {
    var src = all[i];
    try {
      if (src === 'moviebox') await buildMoviebox();
      else if (src === 'hdhub4u') await buildHDHub('hdhub4u', HDHUB4U_HOSTS);
      else if (src === 'hdhubmain') await buildHDHub('hdhubmain', HDHUBMAIN_HOSTS);
      else if (src === 'fojik') await buildFojik();
      else if (src === 'krx18') await buildGenericSource('krx18');
      else if (src === 'nongor') await buildNongor();
      else await buildGenericSource(src);
    } catch(e) { console.error('FATAL ' + src + ': ' + e.message); }
  }
  console.log('\n✓ Cache build complete!');
}

main().catch(function(e) { console.error('Fatal:', e); process.exit(1); });
