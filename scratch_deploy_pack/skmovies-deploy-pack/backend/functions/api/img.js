// functions/api/img.js
// Reverse-engineered from https://skmovies-premium.pages.dev/api/img?u=<base64-or-url>
//
// Image proxy: fetches an image from an allow-listed host and streams it back
// with proper CORS headers. Used by the frontend to avoid mixed-content and
// hotlink-protection issues.

const ALLOWED_HOST_PATTERNS = [
  /^mlsbd-image\.com$/i,
  /^cdn\.imgnest\.io$/i,
  /^m\.media-amazon\.com$/i,
  /^image\.tmdb\.org$/i,
  /^img\.freedrivemovie\.cyou$/i,
  /^s\d+\.postimg\.cc$/i,
  /^i\.ibb\.co$/i,
];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  let target = url.searchParams.get('u') || url.searchParams.get('url');

  if (!target) return json({ ok: false, error: 'Missing ?u= param' }, 400);

  // The frontend base64-encodes some URLs (see wrapInProxy in app.js). Decode if it looks like base64.
  if (!/^https?:\/\//i.test(target)) {
    try { target = atob(target); } catch { /* not base64, leave as is */ }
  }

  let parsed;
  try { parsed = new URL(target); }
  catch { return json({ ok: false, error: 'Invalid URL' }, 400); }

  const allowed = ALLOWED_HOST_PATTERNS.some(re => re.test(parsed.hostname));
  if (!allowed) return json({ ok: false, error: `Host not allowed: ${parsed.hostname}` }, 403);

  try {
    const resp = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/*',
        'Referer': parsed.origin + '/',
      },
    });
    if (!resp.ok) return json({ ok: false, error: `Upstream HTTP ${resp.status}` }, 502);

    const ct = resp.headers.get('content-type') || 'image/jpeg';
    const body = await resp.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}
