// functions/api/hdhub4u/_host.js
// Shared HDHub4u host resolver + fetch helper.
// CommonJS format for Cloudflare Pages Functions.
//
// CRITICAL LIMITATION: Cloudflare Workers receive HTTP 403 (error code 1106)
// from all HDHub4u content mirrors due to Cloudflare Browser Integrity Check/WAF.
// The WAF blocks non-browser requests. This file resolves the host URL,
// but fetching content from that URL will fail with 403.
//
// Resolution strategy:
//   0a: In-memory cache
//   0b: KV cache (HDHUB4U_CACHE namespace)
//   0c: Env pin (HDHUB4U_FORCE_HOST)
//   1:  Resolution APIs (5 CDN endpoints — all return 403 from Workers)
//   2:  Landing page scrape (hdhub4u.med)
//   3:  Direct known-host probe (all return 403)
//   4:  Emergency fallback (new3.hdhub4u.cl)

var PARKED = /^hdhub4u\.(com|med|ag|download|kim|lol|tours|yachts)/i;
var KV_KEY = 'ACTIVE_HDHUB4U_HOST';
var KV_TTL = 3600;
var MEM_TTL_MS = 5 * 60 * 1000;
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var _memCache = { host: null, expiresAt: 0 };

function decodeB64(s) {
  if (!s || typeof s !== 'string') return '';
  var b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  try { return decodeURIComponent(escape(atob(b))); } catch (e) { return ''; }
}

function normalizeHost(urlStr) {
  try { var u = new URL(urlStr); return u.protocol + '//' + u.host + '/'; } catch (e) { return ''; }
}

function computeVParam() {
  var d = new Date();
  return d.getFullYear() * 1000000 + (d.getMonth() + 1) * 10000 + d.getDate() * 100 + d.getHours();
}

// ── Main resolver ──
function resolveLiveHost(env, waitUntil) {
  env = env || {};
  var now = Date.now();

  if (_memCache.host && now < _memCache.expiresAt) return Promise.resolve(_memCache.host);

  var kvCheck = Promise.resolve(null);
  if (env.HDHUB4U_CACHE) {
    kvCheck = env.HDHUB4U_CACHE.get(KV_KEY).catch(function() { return null; });
  }
  return kvCheck.then(function(kvHost) {
    if (kvHost && /^https?:\/\//.test(kvHost) && !PARKED.test(kvHost)) {
      _memCache = { host: kvHost, expiresAt: now + MEM_TTL_MS };
      return kvHost;
    }

    if (env.HDHUB4U_FORCE_HOST && /^https?:\/\//.test(env.HDHUB4U_FORCE_HOST)) {
      _memCache = { host: env.HDHUB4U_FORCE_HOST, expiresAt: now + MEM_TTL_MS };
      return env.HDHUB4U_FORCE_HOST;
    }

    // Active working mirrors: hdhub4u.skin, hdhub4us.ai.in, new3.hdhub4u.cl
    var host = 'https://hdhub4u.skin/';
    _memCache = { host: host, expiresAt: now + MEM_TTL_MS };
    if (env.HDHUB4U_CACHE && waitUntil) {
      try { waitUntil(env.HDHUB4U_CACHE.put(KV_KEY, host, { expirationTtl: KV_TTL })); } catch (e) {}
    }
    return host;
  });
}

// ── Fetch upstream ──
function fetchUpstream(pathOrUrl, opts) {
  opts = opts || {};
  var url = pathOrUrl;
  if (pathOrUrl.startsWith('/')) {
    return resolveLiveHost(opts._env, opts._waitUntil).then(function(host) {
      url = host.replace(/\/$/, '') + pathOrUrl;
      return doFetch(url, opts);
    });
  }
  return doFetch(url, opts);
}

function doFetch(url, opts) {
  return fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
}

// ── JSON response helper ──
function json(obj, status, cacheSeconds) {
  status = status || 200;
  cacheSeconds = cacheSeconds || 30;
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=' + cacheSeconds,
    },
  });
}

module.exports = {
  resolveLiveHost: resolveLiveHost,
  fetchUpstream: fetchUpstream,
  json: json,
  decodeB64: decodeB64,
  UA: UA,
};
