/**
 * GET /api/hdhub4u/list
 * ---------------------
 * Fetch a list of movies from the active HDHub4u mirror.
 *
 * Query params (any one of):
 *   ?type=home&page=1                              homepage pagination
 *   ?type=category&category=bollywood-movies&page=1
 *   ?type=search&q=bahubali&page=1
 *
 * Caching (per req #5 — save Worker requests):
 *   - Home / Category: cached 6 hours (KV + Cache API + memory)
 *   - Search:           cached 1 hour
 *   - Cache key:        list:<type>:<category|query>:<page>
 *
 * Response shape — see code.
 */
const {
  resolveActiveHost,
  fetchHTML,
  jsonResponse,
  decodeHTMLEntities,
  HTMLParser,
  setEnv,
  setWaitUntil,
} = require('./_lib.js');
const { TTL, cached, cacheKey } = require('./_cache.js');

function extractMovieCards(html, host) {
  const movies = [];
  const seen = new Set();

  const hostOrigin = (() => { try { return new URL(host).host; } catch (_) { return ''; } })();

  /** Reject system / non-movie slugs. */
  function isMovieSlug(slug) {
    if (!slug) return false;
    if (/^(category|tag|page|author|wp-|search|xmlrpc|disclaimer|how-to-download|join-our-group|movie-request|dmca|contact|about|privacy|terms|sitemap|feed|comments)/i.test(slug)) return false;
    if (/\.(php|xml|txt|rss|css|js|png|jpg|jpeg|gif|webp|ico)$/i.test(slug)) return false;
    return true;
  }

  // ------------------------------------------------------------------
  // Strategy 1: <li class="thumb"> blocks (HDHub4u's actual layout)
  // ------------------------------------------------------------------
  const liRe = /<li[^>]*class=["'][^"']*\bthumb\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let lm;
  while ((lm = liRe.exec(html)) !== null) {
    const block = lm[1];

    const aRe = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
    let am, movieUrl = '', movieSlug = '';
    while ((am = aRe.exec(block)) !== null) {
      let u = am[1];
      if (u.startsWith('/')) u = new URL(u, host).href;
      if (hostOrigin && !u.includes(hostOrigin)) continue;
      const slug = u.replace(/\/$/, '').split('/').pop();
      if (!isMovieSlug(slug)) continue;
      if (/-(full-movie|full-series|all-episodes|trailer|hindi-dub-trailer)\/?$/i.test(u)) {
        movieUrl = u; movieSlug = slug; break;
      }
      if (!movieUrl) { movieUrl = u; movieSlug = slug; }
    }
    if (!movieUrl) continue;
    if (seen.has(movieSlug)) continue;
    seen.add(movieSlug);

    let poster = HTMLParser.firstSrc(block, true);

    let title = '';
    const altM = block.match(/<img[^>]+(?:alt|title)=["']([^"']+)["']/i);
    if (altM) title = decodeHTMLEntities(altM[1]);
    if (!title) {
      const capM = block.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
      if (capM) title = HTMLParser.stripTags(capM[1]);
    }

    const quality = [];
    const qRe = /\b(4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDRip|CAMRip|WEBRip|HDCAM|HDTC|HQ-HDTC)\b/gi;
    let qm;
    while ((qm = qRe.exec(block + ' ' + title)) !== null) {
      const q = qm[1].toUpperCase();
      if (!quality.includes(q)) quality.push(q);
    }

    let year = '';
    const ym = (title + ' ' + movieSlug).match(/\b(19\d{2}|20\d{2})\b/);
    if (ym) year = ym[1];

    movies.push({
      title: title || movieSlug.replace(/-/g, ' '),
      slug: movieSlug,
      url: movieUrl,
      poster,
      quality,
      genre: [],
      year,
      excerpt: '',
    });
  }

  // ------------------------------------------------------------------
  // Strategy 1b: WordPress .ht-vdo / .post-thumb blocks (fallback markup)
  // ------------------------------------------------------------------
  if (movies.length === 0) {
    const wpRe = /<div[^>]*class=["'][^"']*(?:ht-vdo|post-thumb|movie-thumb|item-thumb|poster)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
    let wm;
    while ((wm = wpRe.exec(html)) !== null) {
      const block = wm[1];
      const aRe = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
      let am, movieUrl = '', movieSlug = '';
      while ((am = aRe.exec(block)) !== null) {
        let u = am[1];
        if (u.startsWith('/')) u = new URL(u, host).href;
        if (hostOrigin && !u.includes(hostOrigin)) continue;
        const slug = u.replace(/\/$/, '').split('/').pop();
        if (!isMovieSlug(slug)) continue;
        movieUrl = u; movieSlug = slug; break;
      }
      if (!movieUrl) continue;
      if (seen.has(movieSlug)) continue;
      seen.add(movieSlug);

      let poster = HTMLParser.firstSrc(block, true);
      let title = '';
      const altM = block.match(/<img[^>]+(?:alt|title)=["']([^"']+)["']/i);
      if (altM) title = decodeHTMLEntities(altM[1]);
      if (!title) {
        const tM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        if (tM) title = HTMLParser.stripTags(tM[1]);
      }
      const quality = [];
      const qRe = /\b(4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDRip|CAMRip|WEBRip|HDTC)\b/gi;
      let qm;
      while ((qm = qRe.exec(block + ' ' + title)) !== null) {
        const q = qm[1].toUpperCase();
        if (!quality.includes(q)) quality.push(q);
      }
      const ym = (title + ' ' + movieSlug).match(/\b(19\d{2}|20\d{2})\b/);
      movies.push({
        title: title || movieSlug.replace(/-/g, ' '),
        slug: movieSlug, url: movieUrl, poster,
        quality, genre: [],
        year: ym ? ym[1] : '',
        excerpt: '',
      });
    }
  }

  // ------------------------------------------------------------------
  // Strategy 2 (fallback): generic <article> blocks
  // ------------------------------------------------------------------
  if (movies.length === 0) {
    const articleRe = /<article[\s\S]*?<\/article>/gi;
    let am2;
    while ((am2 = articleRe.exec(html)) !== null) {
      const art = am2[0];
      const href = HTMLParser.firstHref(art);
      if (!href) continue;
      let url = href;
      if (url.startsWith('/')) url = new URL(url, host).href;
      const slug = url.replace(/\/$/, '').split('/').pop();
      if (!isMovieSlug(slug) || seen.has(slug)) continue;
      seen.add(slug);
      const poster = HTMLParser.firstSrc(art, true);
      const titleM = art.match(/<(?:h[2-4]|a)[^>]*>([\s\S]*?)<\/(?:h[2-4]|a)>/i);
      const title = titleM ? HTMLParser.stripTags(titleM[1]) : slug.replace(/-/g, ' ');
      const ym = (title + ' ' + slug).match(/\b(19\d{2}|20\d{2})\b/);
      movies.push({
        title, slug, url, poster,
        quality: [], genre: [],
        year: ym ? ym[1] : '',
        excerpt: '',
      });
    }
  }

  // ------------------------------------------------------------------
  // Strategy 3 (last resort): scan all <a href> on the same host
  // ------------------------------------------------------------------
  if (movies.length === 0) {
    const linkRe = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let lm3;
    while ((lm3 = linkRe.exec(html)) !== null) {
      const url = lm3[1];
      if (hostOrigin && !url.includes(hostOrigin)) continue;
      const afterHost = url.split(host).pop() || '';
      const slug = afterHost.replace(/\/$/, '').split('/')[0];
      if (!isMovieSlug(slug) || seen.has(slug)) continue;
      if (/\/(category|tag|page|author|wp-)\//i.test(url)) continue;
      seen.add(slug);
      const around = html.slice(Math.max(0, lm3.index - 500), lm3.index + 500);
      const poster = HTMLParser.firstSrc(around, true);
      const title = HTMLParser.stripTags(lm3[2]);
      const ym = (title + ' ' + slug).match(/\b(19\d{2}|20\d{2})\b/);
      movies.push({
        title: title || slug.replace(/-/g, ' '),
        slug, url, poster,
        quality: [], genre: [],
        year: ym ? ym[1] : '',
        excerpt: '',
      });
      if (movies.length >= 30) break;
    }
  }

  return movies;
}

function extractTotalPages(html) {
  const pageRe = /\/page\/(\d+)\/?["']/g;
  let max = 1;
  let pm;
  while ((pm = pageRe.exec(html)) !== null) {
    const n = parseInt(pm[1], 10);
    if (n > max) max = n;
  }
  const pnRe = /class=["'][^"']*page-numbers[^"']*["'][^>]*>(\d+)</g;
  while ((pm = pnRe.exec(html)) !== null) {
    const n = parseInt(pm[1], 10);
    if (n > max) max = n;
  }
  return max;
}

/**
 * Search uses HDHub4u's Typesense backend at search.pingora.fyi.
 * Returns rich JSON documents directly — no HTML parsing.
 */
const SEARCH_API = 'https://search.pingora.fyi/collections/post/documents/search';
const SEARCH_PER_PAGE = 15;

async function runSearch(q, page, host) {
  const u = new URL(SEARCH_API);
  u.searchParams.set('q', q);
  u.searchParams.set('query_by', 'post_title,category,stars,director,imdb_id');
  u.searchParams.set('query_by_weights', '4,2,2,2,4');
  u.searchParams.set('sort_by', 'sort_by_date:desc');
  u.searchParams.set('limit', String(SEARCH_PER_PAGE));
  u.searchParams.set('highlight_fields', 'none');
  u.searchParams.set('use_cache', 'true');
  u.searchParams.set('page', String(page));
  u.searchParams.set('analytics_tag', new Date().toISOString().split('T')[0]);

  const r = await fetch(u, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': host,
      'Origin': host.replace(/\/$/, ''),
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('Search API HTTP ' + r.status);
  const data = await r.json();

  const total = data.found || 0;
  const totalPages = Math.max(1, Math.ceil(total / SEARCH_PER_PAGE));
  const movies = (data.hits || []).map((hit) => {
    const d = hit.document || {};
    let permalink = d.permalink || '';
    if (permalink && !/^https?:\/\//.test(permalink)) {
      permalink = new URL(permalink, host).href;
    }
    const slug = permalink ? permalink.replace(/\/$/, '').split('/').pop() : '';
    let year = '';
    const ym = (d.post_title || '').match(/\b(19\d{2}|20\d{2})\b/);
    if (ym) year = ym[1];
    const quality = [];
    const qRe = /\b(4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDRip|CAMRip|WEBRip|HDTC)\b/gi;
    let qm;
    while ((qm = qRe.exec(d.post_title || '')) !== null) {
      const q = qm[1].toUpperCase();
      if (!quality.includes(q)) quality.push(q);
    }
    return {
      title: d.post_title || slug.replace(/-/g, ' '),
      slug,
      url: permalink,
      poster: d.post_thumbnail || '',
      quality,
      genre: Array.isArray(d.category) ? d.category.slice(0, 4) : [],
      year,
      excerpt: '',
      imdbId: d.imdb_id || '',
    };
  });

  return { movies, totalPages, total };
}

export async function onRequestGet(ctx) {
  setEnv(ctx.env || {});
  if (ctx.waitUntil) setWaitUntil(ctx.waitUntil.bind(ctx));

  try {
    const host = await resolveActiveHost();
    const url = new URL(ctx.request.url);
    const type = url.searchParams.get('type') || 'home';
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const category = url.searchParams.get('category') || '';
    const q = (url.searchParams.get('q') || '').trim();

    // -------- Search: use the Typesense backend (cached 1 hour) --------
    if (type === 'search' && q) {
      const key = cacheKey('list', 'search', q, page);
      const ttl = 3600; // 1 hour
      const { value, fromCache } = await cached(key, async () => {
        const { movies, totalPages, total } = await runSearch(q, page, host);
        return {
          host, type: 'search', page, totalPages,
          query: q, total, count: movies.length, movies,
          ts: Date.now(),
        };
      }, ttl);

      // Always re-stamp host/ts so the UI shows the live mirror.
      value.host = host;
      value.ts = Date.now();
      value._cache = fromCache;
      return jsonResponse(value);
    }

    // -------- Home / Category: HTML scrape (cached 6 hours) --------
    const key = cacheKey('list', type, category || 'home', page);
    const ttl = TTL.LIST;

    const { value, fromCache } = await cached(key, async () => {
      let target;
      if (type === 'category' && category) {
        target = new URL('/category/' + encodeURIComponent(category) + '/', host);
        if (page > 1) {
          target = new URL(
            '/category/' + encodeURIComponent(category) + '/page/' + page + '/',
            host
          );
        }
      } else {
        target = new URL('/', host);
        if (page > 1) target = new URL('/page/' + page + '/', host);
      }

      const html = await fetchHTML(target.href, { referer: host });
      const movies = extractMovieCards(html, host);
      const totalPages = extractTotalPages(html);

      return {
        host, type, page, totalPages,
        category: type === 'category' ? category : undefined,
        count: movies.length, movies,
        ts: Date.now(),
      };
    }, ttl);

    value.host = host;
    value.ts = Date.now();
    value._cache = fromCache;
    return jsonResponse(value);
  } catch (e) {
    return jsonResponse(
      { error: 'Failed to fetch list', message: String(e && e.message || e) },
      502
    );
  }
}
