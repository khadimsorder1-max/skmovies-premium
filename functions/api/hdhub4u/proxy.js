/**
 * GET /api/hdhub4u/proxy?url=<video-or-image-url>
 * ------------------------------------------------
 * Transparent pass-through proxy used for:
 *
 *   1. CORS bypass for direct video URLs (so HTML5 <video> on
 *      skmovies-premium.pages.dev can play files served from
 *      new3.hdhub4u.cl / hubcdn.sbs / drive.google.com).
 *
 *   2. Image proxy for poster thumbnails when the upstream host
 *      blocks hot-linking.
 *
 *   3. MKV pass-through (req #2 — "eita ki direct onnano site er
 *      stream url stream korte parbe specially mkv file?"). MKV is
 *      not natively playable in <video>, but the proxy lets us feed
 *      the URL into our player.html which uses Clappr/MediaElement
 *      as fallback for MKV.
 *
 * The proxy:
 *   - Forwards the request with a browser-like User-Agent
 *   - Copies back Content-Type, Content-Length, Content-Range
 *   - Supports HTTP range requests so the video element can seek
 *   - Streams the body (does not buffer large files in memory)
 */
const { UA, corsHeaders, setEnv, setWaitUntil } = require('./_lib.js');

export async function onRequestGet(ctx) {
  setEnv(ctx.env || {});
  if (ctx.waitUntil) setWaitUntil(ctx.waitUntil.bind(ctx));

  const url = new URL(ctx.request.url);
  const target = url.searchParams.get('url');

  if (!target || !/^https?:\/\//.test(target)) {
    return new Response(JSON.stringify({ error: 'Invalid ?url=' + target }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  // Domain allowlist — prevent SSRF against internal/metadata endpoints.
  const ALLOWED_PROXY_HOSTS = [
    'hdhub4u.med', 'hdhub4u.com', 'hdhub4u.cl', 'hdhub4u.dev',
    'hdhub4u.ag', 'hdhub4u.download', 'hdhub4u.kim', 'hdhub4u.lol',
    'hdhub4u.tours', 'hdhub4u.yachts',
    'hubcdn.sbs', 'hubstream.art', 'hdstream4u.com',
    'hubdrive.tips', 'hubdrive.com', 'hubdrive.net',
    'gadgetsweb.xyz', '4khdhub.one', '4khdhub.com',
    'hubcloud.lol', 'hubcloud.foo', 'hubcloud.com',
    'gdflix.dev', 'gdflix.dad', 'gdflix.com',
    'gdtot.dad', 'gdtot.com', 'gdtot.dev',
    'gdlink.dev',
    'filepress.baby', 'filepress.com',
    'indexserver.site', 'busycdn.xyz', 'multicloudlinks.com',
    'catimages.co', 'catimages.org', 'catimages.net', 'catimages.io',
    'drive.google.com', 'docs.google.com',
    'm.media-amazon.com', 'image.tmdb.org',
    'img.youtube.com', 'i.ytimg.com',
    'cdn.jsdelivr.net',
    'catimage.co', 'catimage.org', 'catimage.net',
  ];
  try {
    const targetHost = new URL(target).hostname;
    const allowed = ALLOWED_PROXY_HOSTS.some(h => targetHost === h || targetHost.endsWith('.' + h));
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Host not allowed', host: targetHost }),
        { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }
  } catch (_) {
    return new Response(JSON.stringify({ error: 'Invalid URL' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  const headers = {
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const range = ctx.request.headers.get('Range');
  if (range) headers['Range'] = range;

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30000),
      redirect: 'follow',
    });

    const respHeaders = new Headers();
    for (const h of [
      'Content-Type', 'Content-Length', 'Content-Range',
      'Accept-Ranges', 'Last-Modified', 'ETag',
    ]) {
      const v = upstream.headers.get(h);
      if (v) respHeaders.set(h, v);
    }
    for (const [k, v] of Object.entries(corsHeaders())) respHeaders.set(k, v);

    // Cache images for 1 day, videos for 1 hour.
    if (/^image\//.test(respHeaders.get('Content-Type') || '')) {
      respHeaders.set('Cache-Control', 'public, max-age=86400');
    } else if (/^video\//.test(respHeaders.get('Content-Type') || '')) {
      respHeaders.set('Cache-Control', 'public, max-age=3600');
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Proxy fetch failed',
                                         message: String(e && e.message || e) }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }
}

/** Handle CORS preflight. */
export async function onRequestOptions(ctx) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(),
      'Access-Control-Max-Age': '86400',
    },
  });
}
