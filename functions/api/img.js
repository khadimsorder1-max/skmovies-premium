/* ============================================================================
   /api/img — Image proxy with cache + UA/Referer headers
   ----------------------------------------------------------------------------
   PROBLEM:
   - TMDB / IMDB / mlsbd-image.com / cdn.imgnest.io often return HTTP 403 to
     fetches that don't look like a "real browser". The original function
     forwarded the request with Cloudflare Worker defaults (UA = empty,
     Referer = skmovies-premium.pages.dev), which triggered bot protection.

   FIX:
   - Send a real-looking User-Agent and an empty Referer.
   - Use Cloudflare's `cf.cacheEverything` + `cacheTtl: 86400` so repeated
     requests for the same image are served from the edge, not re-fetched.
   - Validate that the `u` parameter decodes to an http(s) URL — prevents
     abuse of the proxy for arbitrary non-image content.
   - Set permissive CORS so the browser can read the response.
   ============================================================================ */

const ALLOWED_IMAGE_HOSTS = [
  /^mlsbd-image\.com$/i,
  /^cdn\.imgnest\.io$/i,
  /^m\.media-amazon\.com$/i,
  /^image\.tmdb\.org$/i,
  /^img\.freedrivemovie\.cyou$/i,
  /catimages?\.(co|org|net|io)$/i,
  /catimage\./i,
  /image\.pixxxels\.cc$/i,
  /i\.iliad\.io$/i,
  /\.hdhub4u\.(cl|ag|download|kim|lol|com|tours|yachts|skin|tv|cat)$/i,
  /hdhub4us\.ai\.in$/i,
  /^hubcdn\.sbs$/i,
  /\.b-cdn\.net$/i,
  /fibwatch\.art$/i,
  /moviebox\.ph$/i,
];

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function b64decode(str) {
  // URL-safe base64 → standard base64 → atob
  const std = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4 === 0 ? std : std + '='.repeat(4 - (std.length % 4));
  try { return atob(pad); } catch { return null; }
}

function jsonError(status, msg) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequest(context) {
  const { request, params } = context;
  const u = params?.u || new URL(request.url).searchParams.get('u');

  if (!u) return jsonError(400, 'Missing ?u= param');

  // Decode URL-safe base64
  let originalUrl;
  if (/^[A-Za-z0-9_-]+$/.test(u)) {
    originalUrl = b64decode(u);
  } else {
    // Allow raw URL passthrough too (older callers)
    originalUrl = decodeURIComponent(u);
  }
  if (!originalUrl || !/^https?:\/\//i.test(originalUrl)) {
    return jsonError(400, 'Invalid ?u= param — must be base64 of an http(s) URL');
  }

  // Validate host is in allowlist
  let hostname;
  try { hostname = new URL(originalUrl).hostname; }
  catch { return jsonError(400, 'Invalid URL'); }
  if (!ALLOWED_IMAGE_HOSTS.some(re => re.test(hostname))) {
    return jsonError(403, 'Host not allowed: ' + hostname);
  }

  // Handle HEAD requests quickly
  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=31536000, immutable' },
    });
  }

  try {
    const isFibwatch = /b-cdn\.net|fibwatch\.art/i.test(originalUrl);
    const isHdhub = /hdhub4u|hdhub4us/i.test(originalUrl);

    const upstream = await fetch(originalUrl, {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': isFibwatch ? 'https://fibwatch.art/' : isHdhub ? 'https://hdhub4u.skin/' : '',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      cf: {
        // Tell Cloudflare to cache the upstream response at the edge for 24h.
        // Repeat requests will be served from cache, not re-fetched upstream.
        cacheTtl: 86400,
        cacheEverything: true,
        // Don't follow redirects — return the 3xx so the browser can
        // decide. (Most image hosts return 200 directly, but a few do 302.)
        redirect: 'follow',
      },
    });

    if (!upstream.ok) {
      return jsonError(upstream.status, `Upstream ${upstream.status} for ${hostname}`);
    }

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    // Sanity: refuse to proxy non-image content-types (e.g. someone
    // tries to use this as a generic CORS proxy for HTML/JSON).
    if (!/^image\//i.test(contentType) && contentType !== 'application/octet-stream') {
      return jsonError(415, `Refusing to proxy non-image content-type: ${contentType}`);
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': 'public, max-age=31536000, immutable',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (e) {
    return jsonError(502, `Upstream fetch failed: ${e.message || e}`);
  }
}
