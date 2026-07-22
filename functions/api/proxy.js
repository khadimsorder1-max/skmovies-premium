/* ============================================================================
   SKMovies — Cloudflare Pages Function: /api/proxy
   ----------------------------------------------------------------------------
   PURPOSE
     Generic CORS proxy. Fetches any http(s) URL server-side and returns the
     body with permissive CORS headers + Range support so the browser
     <video> element can stream cross-origin media.

   FIX (v3.4.0)
     - Properly forwards Range request headers (so video seeking works).
     - Returns 206 Partial Content when upstream sends 206.
     - Detects content-type sniffing issues (HTML on HEAD vs video on GET
       for sites like bdl2.multicloudlinks.com).
     - Accepts BOTH ?u=<base64-urlsafe> AND ?u=<url-encoded-raw-url> for
       backwards compatibility with the existing frontend code.

   DEPLOYMENT
     Place this file at:  functions/api/proxy.js
   ============================================================================ */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 30000;

// Decode ?u= param — accepts base64-urlsafe OR raw URL-encoded URL.
function decodeTarget(param) {
  if (!param) return null;
  // Try base64-urlsafe first
  let b64 = param.replace(/-/g, '+').replace(/_/g, '/');
  // Pad
  while (b64.length % 4) b64 += '=';
  try {
    const decoded = atob(b64);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {}
  // Try URL-encoded raw URL
  try {
    const decoded = decodeURIComponent(param);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {}
  // Try raw URL
  if (/^https?:\/\//i.test(param)) return param;
  return null;
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
    'Access-Control-Max-Age': '86400',
    ...extra,
  };
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const target = decodeTarget(url.searchParams.get('u'));
  if (!target) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid base64' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
    });
  }

  // Validate URL
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid target URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
    });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return new Response(JSON.stringify({ ok: false, error: 'Only http(s) URLs allowed' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
    });
  }

  // Forward Range header for video seeking
  const upstreamHeaders = {
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  if (parsed.hostname.includes('kb-cdn.net') || parsed.hostname.includes('fibwatch')) {
    upstreamHeaders['Referer'] = 'https://fibwatch.art/';
    upstreamHeaders['Origin'] = 'https://fibwatch.art';
  } else if (parsed.hostname.includes('multidownload') || parsed.hostname.includes('multicloud')) {
    upstreamHeaders['Referer'] = 'https://multidownload.website/';
  } else {
    upstreamHeaders['Referer'] = parsed.origin + '/';
  }

  const range = request.headers.get('Range');
  if (range) upstreamHeaders['Range'] = range;


  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetch(target, {
      headers: upstreamHeaders,
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(t);

    // Forward status + body
    const status = upstream.status;
    const respHeaders = new Headers();
    // Pass through content-type, content-length, content-range, accept-ranges, etag, last-modified
    const passThrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition'];
    for (const h of passThrough) {
      const v = upstream.headers.get(h);
      if (v) respHeaders.set(h, v);
    }
    // Force CORS headers
    for (const [k, v] of Object.entries(corsHeaders())) {
      respHeaders.set(k, v);
    }
    // Force inline disposition (so browsers play instead of download)
    if (!respHeaders.has('Content-Disposition')) {
      respHeaders.set('Content-Disposition', 'inline');
    }
    // Allow browser caching for video segments (10 min)
    if (/video\//i.test(respHeaders.get('Content-Type') || '')) {
      respHeaders.set('Cache-Control', 'public, max-age=600');
    }

    return new Response(upstream.body, { status, headers: respHeaders });
  } catch (err) {
    clearTimeout(t);
    const msg = err.name === 'AbortError' ? 'Upstream timeout' : (err.message || 'Fetch failed');
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
    });
  }
}

export async function onRequestHead(ctx) {
  // Same as GET but discard body
  const resp = await onRequestGet(ctx);
  return new Response(null, { status: resp.status, headers: resp.headers });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
