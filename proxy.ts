// proxy.ts — Deno Deploy single-file CORS proxy for HDHub4u.
//
// Why this exists:
//   Cloudflare Workers (where skmovies-premium.pages.dev runs) is blocked by
//   Cloudflare Browser Integrity Check on new3.hdhub4u.cl. Deno Deploy runs
//   on Google Cloud IPs which BIC accepts.
//
// Endpoints:
//   GET  /?url=<encoded-url>          -> proxied GET, returns upstream body + CORS headers
//   GET  /health                       -> { ok: true } liveness probe
//   GET  /                             -> tiny landing page (so root URL isn't 404)
//
// Auth:
//   Optional. If PROXY_TOKEN env var is set, requests must include
//   `X-Proxy-Token: <value>` header. If unset, proxy is open (rely on URL
//   secrecy + Deno Deploy rate limits).
//
// Limits:
//   - 30 second upstream timeout
//   - 50 MB max response body
//   - In-memory cache 60s, max 500 entries

const ALLOWED_HOST_PATTERNS = [
  /^new\d+\.hdhub4u\./i,
  /^hdhub4u\./i,
  /^h4\.suncdn\.org$/i,
  /^points\.topapii\.com$/i,
  /^ml\.theapii\.org$/i,
  /^dns\.pingora\.fyi$/i,
  /^cdn\.hub4u\.cloud$/i,
  /^gadgetsweb\.xyz$/i,
  /^4khdhub\.one$/i,
  /^hubcloud\./i,
  /^gdflix\./i,
  /^filepress\./i,
  /^indexserver\.site$/i,
  /^busycdn\.xyz$/i,
  /^catimages?\./i,
  /^catimage\./i,
];

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Referer': 'https://hdhub4u.med/',
};

const CACHE = new Map<string, { body: Uint8Array; contentType: string; status: number; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 500;
const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 50 * 1024 * 1024;

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function checkAuth(req: Request): boolean {
  const expected = Deno.env.get('PROXY_TOKEN');
  if (!expected) return true;
  const got = req.headers.get('X-Proxy-Token');
  return got === expected;
}

function isAllowed(url: URL): boolean {
  return ALLOWED_HOST_PATTERNS.some(re => re.test(url.hostname));
}

function cacheGet(key: string) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    CACHE.delete(key);
    return null;
  }
  return entry;
}

function cacheSet(key: string, body: Uint8Array, contentType: string, status: number) {
  if (CACHE.size >= CACHE_MAX) {
    const firstKey = CACHE.keys().next().value;
    if (firstKey) CACHE.delete(firstKey);
  }
  CACHE.set(key, { body, contentType, status, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function handleProxy(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }
  if (!checkAuth(req)) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  const u = new URL(req.url);
  const rawUrl = u.searchParams.get('url');
  if (!rawUrl) {
    return json({ ok: false, error: 'Missing ?url= param' }, 400);
  }

  let targetUrl: URL;
  try { targetUrl = new URL(rawUrl); }
  catch { return json({ ok: false, error: 'Invalid URL' }, 400); }

  if (!isAllowed(targetUrl)) {
    return json({ ok: false, error: 'Host not in allowlist', host: targetUrl.hostname }, 403);
  }

  const cacheKey = targetUrl.href;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return new Response(cached.body, {
      status: cached.status,
      headers: {
        'Content-Type': cached.contentType,
        'X-Cache': 'HIT',
        ...corsHeaders(),
      },
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstreamResp = await fetch(targetUrl.href, {
      method: 'GET',
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });

    const contentType = upstreamResp.headers.get('Content-Type') || 'application/octet-stream';
    const contentLength = parseInt(upstreamResp.headers.get('Content-Length') || '0', 10);

    if (contentLength > 10 * 1024 * 1024) {
      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        headers: {
          'Content-Type': contentType,
          'X-Cache': 'MISS',
          ...corsHeaders(),
        },
      });
    }

    const bodyBuf = await upstreamResp.arrayBuffer();
    const body = new Uint8Array(bodyBuf);
    if (body.byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: 'Response too large', size: body.byteLength }, 502);
    }

    if (upstreamResp.ok) {
      cacheSet(cacheKey, body, contentType, upstreamResp.status);
    }

    return new Response(body, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': contentType,
        'X-Cache': 'MISS',
        ...corsHeaders(),
      },
    });
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return json({ ok: false, error: 'Upstream timeout', url: cacheKey }, 504);
    }
    return json({ ok: false, error: e.message || 'Fetch failed' }, 502);
  } finally {
    clearTimeout(timeout);
  }
}

function json(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

Deno.serve((req: Request) => {
  const u = new URL(req.url);
  if (u.pathname === '/health') {
    return json({ ok: true, cacheSize: CACHE.size, ts: Date.now() });
  }
  if (u.pathname === '/') {
    return new Response(
      'SKMovies HDHub4u proxy is running. Use ?url=<target> to fetch.\n',
      { status: 200, headers: { 'Content-Type': 'text/plain', ...corsHeaders() } },
    );
  }
  return handleProxy(req);
});
