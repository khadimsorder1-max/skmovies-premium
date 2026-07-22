#!/usr/bin/env node
/**
 * SKMovies Cache Builder
 * --------------------------------------------------------------------------
 * Pre-fetches 1000+ movies/series per source and writes them to a GitHub repo
 * as JSON files. This cache is then served by /api/cache (Cloudflare Function)
 * for super-fast loading.
 *
 * Usage:
 *   SKM_SITE=https://skmovies-premium.pages.dev \
 *   GH_TOKEN=ghp_xxx \
 *   GH_REPO=skmovies/cache \
 *   node build_cache.js
 *
 * What it does:
 *   1. For each source (mlsbd, fdm, hdhub4u, hdhubmain, moviebox, fibwatch):
 *      a. Fetches pages 1-50 of /api/<src>/latest (1000+ items total).
 *      b. Fetches page 1 of /api/<src>/trending.
 *      c. For each movie, fetches /api/<src>/movie?slug=<slug> (detail).
 *   2. Writes each response as a separate JSON file in the cache repo:
 *        <src>/latest.json         (page 1)
 *        <src>/latest-2.json       (page 2)
 *        <src>/trending.json
 *        <src>/movie/<slug>.json
 *   3. Uses GitHub Contents API to commit each file.
 */

const https = require('https');
const { URL } = require('url');

const SKM_SITE = process.env.SKM_SITE || 'https://skmovies-premium.pages.dev';
const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = process.env.GH_REPO || 'skmovies/cache';
const GH_BRANCH = process.env.GH_BRANCH || 'main';

if (!GH_TOKEN) {
  console.error('ERROR: GH_TOKEN environment variable is required');
  console.error('Create a GitHub personal access token at https://github.com/settings/tokens');
  process.exit(1);
}

const SOURCES = ['mlsbd', 'fdm', 'hdhub4u', 'hdhubmain', 'moviebox', 'fibwatch'];
const PAGES_PER_SOURCE = parseInt(process.env.PAGES || '50', 10);
const DETAILS_PER_SOURCE = parseInt(process.env.DETAILS || '200', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts = {
      method: opts.method || 'GET',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'SKM-Cache-Builder/1.0',
        'Accept': 'application/json',
        ...(opts.headers || {}),
      },
      timeout: opts.timeout || 30000,
    };
    const req = https.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.status || r.status >= 400) throw new Error(`HTTP ${r.status} for ${url}`);
  try { return JSON.parse(r.body); }
  catch (e) { throw new Error(`Invalid JSON from ${url}: ${e.message}`); }
}

async function githubPutFile(path, content, message) {
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${path}`;
  let sha;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${GH_TOKEN}` } });
    if (r.status === 200) {
      const data = JSON.parse(r.body);
      sha = data.sha;
    }
  } catch {}
  const body = JSON.stringify({
    message: message || `Update ${path}`,
    content: Buffer.from(content).toString('base64'),
    branch: GH_BRANCH,
    ...(sha ? { sha } : {}),
  });
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`GitHub API ${r.status}: ${r.body.slice(0, 200)}`);
  }
  return JSON.parse(r.body);
}

async function runWithConcurrency(tasks, concurrency, onResult) {
  const results = [];
  let idx = 0;
  let completed = 0, failed = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        const result = await tasks[i]();
        results[i] = result;
        completed++;
        if (onResult) onResult(i, result, null, completed, failed, tasks.length);
      } catch (e) {
        failed++;
        results[i] = null;
        if (onResult) onResult(i, null, e, completed, failed, tasks.length);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function getListUrl(src, page) {
  switch (src) {
    case 'mlsbd': return `${SKM_SITE}/api/latest?page=${page}`;
    case 'fdm': return `${SKM_SITE}/api/fdm/latest?page=${page}`;
    case 'hdhub4u': return `${SKM_SITE}/api/hdhub4u/list?type=home&page=${page}`;
    case 'hdhubmain': return `${SKM_SITE}/api/hdhubmain/list?type=home&page=${page}`;
    case 'moviebox': return `${SKM_SITE}/api/moviebox/trending?page=${page}&perPage=24`;
    case 'fibwatch': return `${SKM_SITE}/api/fibwatch/latest?page=${page}`;
  }
}

function getTrendingUrl(src) {
  switch (src) {
    case 'mlsbd': return `${SKM_SITE}/api/trending`;
    case 'fdm': return `${SKM_SITE}/api/fdm/trending`;
    case 'hdhub4u': return `${SKM_SITE}/api/hdhub4u/list?type=home&page=1`;
    case 'hdhubmain': return `${SKM_SITE}/api/hdhubmain/list?type=home&page=1`;
    case 'moviebox': return `${SKM_SITE}/api/moviebox/trending?page=1&perPage=24`;
    case 'fibwatch': return `${SKM_SITE}/api/fibwatch/trending`;
  }
}

function getMovieUrl(src, slug) {
  switch (src) {
    case 'mlsbd': return `${SKM_SITE}/api/movie?slug=${encodeURIComponent(slug)}`;
    case 'fdm': return `${SKM_SITE}/api/fdm/movie?slug=${encodeURIComponent(slug)}`;
    case 'hdhub4u': return `${SKM_SITE}/api/hdhub4u/movie?slug=${encodeURIComponent(slug)}`;
    case 'hdhubmain': return `${SKM_SITE}/api/hdhubmain/movie?slug=${encodeURIComponent(slug)}`;
    case 'moviebox': return `${SKM_SITE}/api/moviebox/movie?slug=${encodeURIComponent(slug)}`;
    case 'fibwatch': return `${SKM_SITE}/api/fibwatch/movie?slug=${encodeURIComponent(slug)}`;
  }
}

function respItems(r) {
  if (!r) return [];
  return r.movies || r.items || [];
}

async function buildSource(src) {
  console.log(`\n=== Building cache for source: ${src} ===`);

  try {
    const trending = await fetchJson(getTrendingUrl(src));
    await githubPutFile(`${src}/trending.json`, JSON.stringify(trending), `cache: ${src} trending`);
    console.log(`  ✓ ${src}/trending.json (${respItems(trending).length} items)`);
  } catch (e) {
    console.warn(`  ✗ ${src}/trending.json: ${e.message}`);
  }

  const allSlugs = new Set();
  for (let page = 1; page <= PAGES_PER_SOURCE; page++) {
    try {
      const data = await fetchJson(getListUrl(src, page));
      const items = respItems(data);
      if (items.length === 0) {
        console.log(`  · ${src}/latest${page > 1 ? '-' + page : ''}.json: empty, stopping`);
        break;
      }
      const filename = `${src}/latest${page > 1 ? '-' + page : ''}.json`;
      await githubPutFile(filename, JSON.stringify(data), `cache: ${src} latest page ${page}`);
      items.forEach(it => { if (it.slug) allSlugs.add(it.slug); });
      console.log(`  ✓ ${filename} (${items.length} items, total slugs: ${allSlugs.size})`);

      if (data.hasMore === false || (data.totalPages && page >= data.totalPages)) break;
    } catch (e) {
      console.warn(`  ✗ ${src}/latest${page > 1 ? '-' + page : ''}.json: ${e.message}`);
      break;
    }
  }
  console.log(`  → Total unique slugs collected: ${allSlugs.size}`);

  const slugs = [...allSlugs].slice(0, DETAILS_PER_SOURCE);
  console.log(`  → Fetching details for top ${slugs.length} movies (concurrency=${CONCURRENCY})...`);

  let detailOk = 0, detailFail = 0;
  await runWithConcurrency(
    slugs.map(slug => async () => {
      try {
        const data = await fetchJson(getMovieUrl(src, slug));
        if (!data.ok) throw new Error(data.error || 'not ok');
        const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
        await githubPutFile(`${src}/movie/${safeSlug}.json`, JSON.stringify(data), `cache: ${src} movie ${slug}`);
        detailOk++;
      } catch (e) {
        detailFail++;
      }
    }),
    CONCURRENCY,
    (i, result, err, completed, failed, total) => {
      if ((completed + failed) % 20 === 0 || (completed + failed) === total) {
        process.stdout.write(`\r  · Details: ${completed + failed}/${total} (ok=${detailOk}, fail=${detailFail})   `);
      }
    }
  );
  console.log(`\n  ✓ Details: ${detailOk} ok, ${detailFail} failed`);
}

async function main() {
  console.log(`SKMovies Cache Builder`);
  console.log(`  Site: ${SKM_SITE}`);
  console.log(`  GitHub repo: ${GH_REPO}`);
  console.log(`  Pages per source: ${PAGES_PER_SOURCE}`);
  console.log(`  Details per source: ${DETAILS_PER_SOURCE}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Sources: ${SOURCES.join(', ')}`);

  const sourcesToBuild = (process.env.SOURCES || '').split(',').map(s => s.trim()).filter(Boolean);
  const sources = sourcesToBuild.length > 0 ? sourcesToBuild : SOURCES;

  for (const src of sources) {
    try {
      await buildSource(src);
    } catch (e) {
      console.error(`FATAL error building ${src}:`, e.message);
    }
  }

  console.log('\n✓ Cache build complete!');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
