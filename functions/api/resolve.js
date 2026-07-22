/* ============================================================================
   SKMovies — Cloudflare Pages Function: /api/resolve
   ----------------------------------------------------------------------------
   PURPOSE
     Resolve a savelinks.me / freedrivemovie.cyou/links/ URL into DIRECT
     video URLs that the browser <video> element can actually play.

   PROBLEM (v3.3.8 and earlier)
     The original resolve only scraped savelinks.me and returned the
     INTERMEDIATE file-host page URLs (e.g. https://new.multicloudlinks.com/view/xp76vc)
     instead of the direct .mkv/.mp4 URLs hidden inside those pages. The
     frontend then handed HTML pages to <video>.src, causing
     MEDIA_ELEMENT_ERROR: Format error and silent playback failure.

   FIX (v3.4.0)
     After scraping savelinks.me, we recursively fetch each intermediate
     host page (MultiCloud, GDFlix, FilePress, HubCloud, HubDrive, GDTot)
     via a Cloudflare-worker fetch and parse the HTML for direct video URLs.
     The first direct URL found becomes urls[0]; the original intermediate
     URLs are preserved in `hosts` for manual fallback.

   DEPLOYMENT
     Place this file at:  functions/api/resolve.js
   ============================================================================ */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 12000;

// Hosts that are known to be INTERMEDIATE pages (HTML, not direct video).
// For each, we'll fetch the page and scrape for direct video URLs.
const INTERMEDIATE_HOST_PATTERNS = [
  /multicloudlinks\.com$/i,
  /gdflix\.(dev|dad|com|io)$/i,
  /filepress\.(baby|com)$/i,
  /hubcloud\.(lol|foo|com)$/i,
  /hubdrive\.(tips|com|net)$/i,
  /gdtot\.(dad|com|dev)$/i,
  /gdlink\.dev$/i,
  /multidownload\.website$/i,
  /busycdn\.xyz$/i,
  /indexserver\.site$/i,
  /hubstream\.art$/i,
];

const VIDEO_EXT_RE = /\.(mp4|mkv|m3u8|webm|mov|avi|ts)(\?|#|$)/i;

function isIntermediate(url) {
  try {
    const u = new URL(url);
    return INTERMEDIATE_HOST_PATTERNS.some(re => re.test(u.hostname));
  } catch { return false; }
}

function isDirectVideo(url) {
  return VIDEO_EXT_RE.test(url);
}

function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(t));
}

// Fetch an intermediate page and extract direct video URLs from the HTML.
// Returns array of direct URLs (may be empty).
async function deepScrape(intermediateUrl) {
  try {
    const resp = await fetchWithTimeout(intermediateUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!resp.ok) return [];
    const ct = resp.headers.get('content-type') || '';
    // Already a direct video? Return the URL itself.
    if (/video\//i.test(ct)) return [intermediateUrl];
    const html = await resp.text();
    // Support .m3u / #EXTM3U stream playlist parsing (e.g. Multidownload / Multicloud .m3u links)
    if (html.includes('#EXTM3U') || /\.m3u8?(\?|$)/i.test(intermediateUrl)) {
      const lines = html.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      const directUrls = lines.filter(l => /^https?:\/\//i.test(l));
      if (directUrls.length > 0) return directUrls;
    }
    // Match https://...mp4|mkv|m3u8|webm (with optional query)
    const re = /https?:\/\/[^\s"'<>\)]+\.(?:mp4|mkv|webm|m3u8)(?:\?[^\s"'<>\)]*)?/gi;
    const matches = html.match(re) || [];
    // De-dup
    return [...new Set(matches)];

  } catch (e) {
    console.warn('deepScrape failed for', intermediateUrl, e.message);
    return [];
  }
}

// Parse savelinks.me page HTML to extract file-host links.
function parseSavelinksHtml(html) {
  const links = [];
  // Pattern 1: <a href="https://gdflix.dev/file/...">
  const aRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html)) !== null) {
    const url = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (/gdflix|filepress|hubcloud|hubdrive|gdtot|multicloudlinks|busycdn|indexserver|hubstream|telegram|t\.me/i.test(url)) {
      // Detect host label
      let host = 'Link';
      if (/gdflix/i.test(url)) host = 'GDFlix';
      else if (/filepress/i.test(url)) host = 'FilePress';
      else if (/hubcloud/i.test(url)) host = 'HubCloud';
      else if (/hubdrive/i.test(url)) host = 'HubDrive';
      else if (/gdtot/i.test(url)) host = 'GDTot';
      else if (/multicloudlinks/i.test(url)) host = 'MultiCloud';
      else if (/busycdn/i.test(url)) host = 'BusyCDN';
      else if (/indexserver/i.test(url)) host = 'IndexServer';
      else if (/hubstream/i.test(url)) host = 'HubStream';
      else if (/telegram|t\.me/i.test(url)) host = 'Telegram';
      links.push({ url, text: text || host, host });
    }
  }
  return links;
}

async function resolveSavelinks(savelinksUrl) {
  const resp = await fetchWithTimeout(savelinksUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://mlsbd.co/',
    },
  });
  if (!resp.ok) {
    return { ok: false, error: `savelinks.me returned ${resp.status}` };
  }
  const html = await resp.text();
  const hosts = parseSavelinksHtml(html);

  // For each intermediate host, deep-scrape to find direct video URL.
  // We do this in parallel with a small concurrency limit.
  const directUrls = [];
  const directByHost = {};
  const concurrency = 4;
  const queue = [...hosts];
  async function worker() {
    while (queue.length) {
      const h = queue.shift();
      if (!h) return;
      // Skip Telegram (not a file host)
      if (h.host === 'Telegram') return;
      if (!isIntermediate(h.url)) return;
      const deepUrls = await deepScrape(h.url);
      if (deepUrls.length > 0) {
        // Pick the best (mp4 preferred)
        deepUrls.sort((a, b) => {
          const ra = ({ mp4: 0, m3u8: 1, webm: 2, mkv: 3 })[(a.match(/\.(mp4|mkv|m3u8|webm)/i) || [])[1]?.toLowerCase()] ?? 9;
          const rb = ({ mp4: 0, m3u8: 1, webm: 2, mkv: 3 })[(b.match(/\.(mp4|mkv|m3u8|webm)/i) || [])[1]?.toLowerCase()] ?? 9;
          return ra - rb;
        });
        directByHost[h.host] = deepUrls[0];
        directUrls.push(...deepUrls);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Deduplicate direct URLs
  const uniqDirect = [...new Set(directUrls)];
  // Fallback: if no direct URLs found, use the intermediate URLs
  const fallbackUrls = hosts.filter(h => h.host !== 'Telegram').map(h => h.url);

  return {
    ok: true,
    urls: uniqDirect.length > 0 ? uniqDirect : fallbackUrls,
    rawUrls: fallbackUrls,
    hosts: hosts.map(h => ({ host: h.host, url: h.url, text: h.text })),
    savelinksUrl,
    source: 'mlsbd',
    fallback: uniqDirect.length === 0 ? 'No direct video URLs found; returning intermediate page URLs' : null,
  };
}

async function resolveFdmLink(fdmUrl) {
  // FDM link page: https://freedrivemovie.cyou/links/<id>/
  const resp = await fetchWithTimeout(fdmUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://freedrivemovie.cyou/',
    },
  });
  if (!resp.ok) {
    return { ok: false, error: `FDM page returned ${resp.status}` };
  }
  const html = await resp.text();
  // Same parsing as savelinks
  const hosts = parseSavelinksHtml(html);
  const directUrls = [];
  const concurrency = 4;
  const queue = [...hosts];
  async function worker() {
    while (queue.length) {
      const h = queue.shift();
      if (!h || h.host === 'Telegram') return;
      if (!isIntermediate(h.url)) return;
      const deepUrls = await deepScrape(h.url);
      if (deepUrls.length > 0) directUrls.push(...deepUrls);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const uniqDirect = [...new Set(directUrls)];
  const fallbackUrls = hosts.filter(h => h.host !== 'Telegram').map(h => h.url);
  return {
    ok: true,
    urls: uniqDirect.length > 0 ? uniqDirect : fallbackUrls,
    rawUrls: fallbackUrls,
    hosts: hosts.map(h => ({ host: h.host, url: h.url, text: h.text })),
    savelinksUrl: fdmUrl,
    source: 'freedrivemovie',
    fallback: uniqDirect.length === 0 ? 'No direct video URLs found; returning intermediate page URLs' : null,
  };
}

async function resolveKrx18Link(linkUrl) {
  if (!linkUrl.includes('krx18.com/links/')) return linkUrl;
  try {
    const r1 = await fetchWithTimeout(linkUrl, {
      headers: { 'User-Agent': UA, 'Referer': 'https://krx18.com/' },
    });
    if (!r1.ok) return linkUrl;
    const html = await r1.text();

    const go = (html.match(/name="doo_hidden_go"\s+value="([^"]+)"/i) || [])[1] || '1';
    const nonce = (html.match(/name="doo_hidden_nonce"\s+value="([^"]+)"/i) || [])[1];
    const issued = (html.match(/name="doo_hidden_issued"\s+value="([^"]+)"/i) || [])[1];
    const wait = (html.match(/name="doo_hidden_wait"\s+value="([^"]+)"/i) || [])[1];
    const waitToken = (html.match(/name="doo_hidden_wait_token"\s+value="([^"]+)"/i) || [])[1];

    if (!waitToken && !issued) return linkUrl;

    const bodyParams = [];
    bodyParams.push('doo_hidden_go=' + encodeURIComponent(go));
    if (nonce) bodyParams.push('doo_hidden_nonce=' + encodeURIComponent(nonce));
    if (issued) bodyParams.push('doo_hidden_issued=' + encodeURIComponent(issued));
    if (wait) bodyParams.push('doo_hidden_wait=' + encodeURIComponent(wait));
    if (waitToken) bodyParams.push('doo_hidden_wait_token=' + encodeURIComponent(waitToken));

    const r2 = await fetch(linkUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': linkUrl,
      },
      body: bodyParams.join('&'),
      redirect: 'manual',
    });

    const loc = r2.headers.get('location');
    return loc || linkUrl;
  } catch {
    return linkUrl;
  }
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url') || url.searchParams.get('u');
  if (!target) {
    return jsonResponse({ ok: false, error: 'Missing ?url= or ?u= param' }, 400);
  }
  // Validate URL
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid URL' }, 400);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return jsonResponse({ ok: false, error: 'URL must be http(s)' }, 400);
  }

  try {
    let result;
    if (/savelinks\.me\/view\//i.test(target)) {
      result = await resolveSavelinks(target);
    } else if (/freedrivemovie\.(cyou|org|com)\/(links|episodes)\//i.test(target)) {
      result = await resolveFdmLink(target);
    } else if (target.includes('krx18.com/links/')) {
      const loc = await resolveKrx18Link(target);
      result = { ok: true, urls: [loc], rawUrls: [loc], hosts: [{ host: 'Download Host', url: loc, text: 'Download Host' }], savelinksUrl: target, source: 'krx18' };
    } else if (isDirectVideo(target)) {

      // Direct video URL — just return it.
      result = { ok: true, urls: [target], rawUrls: [target], hosts: [], savelinksUrl: null, source: 'direct' };
    } else if (isIntermediate(target)) {
      // Caller passed an intermediate URL directly — deep-scrape it.
      const deepUrls = await deepScrape(target);
      result = {
        ok: deepUrls.length > 0,
        urls: deepUrls.length > 0 ? deepUrls : [target],
        rawUrls: [target],
        hosts: [{ host: 'Direct', url: target, text: 'Source page' }],
        savelinksUrl: null,
        source: 'intermediate',
        fallback: deepUrls.length === 0 ? 'Could not extract direct video URL' : null,
      };
    } else {
      return jsonResponse({ ok: false, error: 'Invalid URL — expected a savelinks.me/view/<id> URL, FDM links URL, intermediate host URL, or direct video URL' }, 400);
    }
    return jsonResponse(result, 200);
  } catch (err) {
    console.error('resolve error:', err);
    return jsonResponse({ ok: false, error: 'Resolver error: ' + (err.message || String(err)) }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
     
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60', // cache 1 min on the edge
    },
  });
}
