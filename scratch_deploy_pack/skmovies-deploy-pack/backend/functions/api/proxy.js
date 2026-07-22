// functions/api/proxy.js
// Reverse-engineered from https://skmovies-premium.pages.dev/api/proxy?u=<base64url>
//
// Generic CORS proxy for an allow-list of file-host domains. The frontend
// (app.js → PROXY_HOST_PATTERNS) base64url-encodes the upstream URL and passes
// it as ?u=. The proxy fetches the upstream and re-streams it with CORS headers
// so the browser can read cross-origin responses.

const ALLOWED_HOST_PATTERNS = [
  /^dl\.freedrivemovie\.org$/i,
  /\.freedrivemovie\.(org|cyou|com)$/i,
  /indexserver\.site$/i,
  /busycdn\.xyz$/i,
  /multicloudlinks\.com$/i,
  /gdflix\.(dev|dad|com)$/i,
  /hubcloud\.(lol|foo|com)$/i,
  /gdtot\.(dad|com|dev)$/i,
  /^gdlink\.dev$/i,
  /filepress\.(baby|com)$/i,
  /^multidownload\.website$/i,
  /^dr\d+\.multidownload\.website$/i,
  /^mlsbd-image\.com$/i,
  /^cdn\.imgnest\.io$/i,
  /^image\.tmdb\.org$/i,
  /^img\.freedrivemovie\.cyou$/i,
];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const b64 = url.searchParams.get('u');

  if (!b64) return json({ ok: false, error: 'Missing ?u= param' }, 400);

  let target;
  try {
    // base64url decode
    const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
    target = atob(padded);
  } catch {
    return json({ ok: false, error: 'Invalid ?u= encoding' }, 400);
  }

  let parsed;
  try { parsed = new URL(target); }
  catch { return json({ ok: false, error: 'Invalid URL' }, 400); }

  const allowed = ALLOWED_HOST_PATTERNS.some(re => re.test(parsed.hostname));
  if (!allowed) return json({ ok: false, error: `Host not allowed: ${parsed.hostname}` }, 403);

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: {
        'User-Agent': request.headers.get('user-agent') || 'Mozilla/5.0',
        'Accept': request.headers.get('accept') || '*/*',
        'Referer': parsed.origin + '/',
      },
      redirect: 'follow',
    });

    // Stream the body back with CORS headers
    const respHeaders = new Headers(upstream.headers);
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    respHeaders.set('Access-Control-Allow-Headers', '*');
    respHeaders.delete('content-encoding'); // we're returning raw bytes

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
