/**
 * SKMovies — Video Proxy + Resolver Worker
 * =========================================
 *
 * Two endpoints:
 *   1. GET /proxy/<base64url>  — reverses-proxies video CDN URLs + adds Referer header
 *   2. GET /resolve?url=<savelinks URL>  — extracts direct .mp4/.mkv URL from savelinks.me
 *
 * Why the proxy: savelinks.me → gdflix/multicloud hosts often require a Referer
 * header. MX Player, VLC, and browsers don't send it, so direct downloads fail.
 * The proxy adds it transparently.
 *
 * Deploy as a separate Cloudflare Worker (e.g. skmovies-proxy).
 * Set PROXY_WORKER_URL in your bot worker + Pages project.
 */

const ALLOWED_HOSTS = [
  'gdflix.dev', 'gdflix.io', 'gdflix.sbs',
  'multicloudlinks.com', 'new.multicloudlinks.com',
  'filepress.xyz', 'megaup.net', 'filemoon.to',
  'mediafire.com', 'mega.nz', '1fichier.com',
  'mlsbd.co', 'mlsbd-image.com', 'savelinks.me',
  'indexserver.site',
  'west.indexserver.site',
  'bolt.indexserver.site',
  'instant.busycdn.xyz',
  'drivebot.sbs',
  'dr1.multidownload.website',
  'multidownload.website',
  'cgd1.multicloudlinks.com',
  'cgd2.multicloudlinks.com',
  'bdl1.multicloudlinks.com',
  'bdl2.multicloudlinks.com',
];

const REFERER_MAP = {
  'gdflix': 'https://savelinks.me/',
  'filepress': 'https://savelinks.me/',
  'megaup': 'https://savelinks.me/',
  'filemoon': 'https://savelinks.me/',
  'savelinks': 'https://mlsbd.co/',
  'mlsbd': 'https://mlsbd.co/',
  'indexserver': 'https://gdflix.dev/',
  'west.indexserver': 'https://gdflix.dev/',
  'bolt.indexserver': 'https://gdflix.dev/',
  'busycdn': 'https://gdflix.dev/',
  'drivebot': 'https://gdflix.dev/',
  'multicloud': 'https://new.multicloudlinks.com/',
  'cgd1': 'https://new.multicloudlinks.com/',
  'cgd2': 'https://new.multicloudlinks.com/',
  'bdl': 'https://new.multicloudlinks.com/',
  'multidownload': 'https://new.multicloudlinks.com/',
};

const VIDEO_EXT_RE = /https?:\/\/[^"'\s<>]+\.(?:mp4|mkv|m3u8|webm)[^"'\s<>]*/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({
        ok: true, service: 'skmovies-proxy', version: '1.0.0',
        timestamp: new Date().toISOString(),
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ─── /proxy/<base64url> ──────────────────────────────────────────
    const proxyMatch = url.pathname.match(/^\/proxy\/([A-Za-z0-9_-]+)$/);
    if (proxyMatch) {
      return handleProxy(proxyMatch[1], request);
    }

    // ─── /resolve?url=<savelinks URL> ────────────────────────────────
    if (url.pathname === '/resolve') {
      return handleResolve(url, env);
    }

    return new Response('Not found. Use /proxy/<base64url> or /resolve?url=<url>', { status: 404 });
  },
};

// ─── Proxy handler ───────────────────────────────────────────────────
async function handleProxy(b64, request) {
  let targetUrl;
  try {
    let b = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    targetUrl = atob(b);
  } catch { return new Response('Invalid base64', { status: 400 }); }

  if (!/^https?:\/\//.test(targetUrl)) return new Response('Invalid URL', { status: 400 });

  let targetHost;
  try { targetHost = new URL(targetUrl).hostname.replace(/^www\./, ''); }
  catch { return new Response('Invalid URL', { status: 400 }); }

  const isAllowed = ALLOWED_HOSTS.some((h) => targetHost.includes(h));
  if (!isAllowed) return new Response(`Host not allowed: ${targetHost}`, { status: 403 });

  // Determine Referer
  let referer = 'https://mlsbd.co/';
  for (const [key, val] of Object.entries(REFERER_MAP)) {
    if (targetHost.includes(key)) { referer = val; break; }
  }

  const upstreamHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': referer,
    'Origin': 'https://mlsbd.co',
  };

  // Pass through Range header for video seeking
  const range = request.headers.get('Range');
  if (range) upstreamHeaders['Range'] = range;

  try {
    const upstreamResp = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: 'follow',
      cf: { cacheTtl: 86400, cacheEverything: true, scrapeShield: false },
    });

    const respHeaders = new Headers();
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Last-Modified', 'ETag']) {
      const v = upstreamResp.headers.get(h);
      if (v) respHeaders.set(h, v);
    }
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('Access-Control-Allow-Headers', '*');
    respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    respHeaders.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    respHeaders.set('X-Proxy-Host', targetHost);

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: respHeaders,
    });
  } catch (e) {
    return new Response(`Upstream fetch failed: ${e.message}`, { status: 502 });
  }
}

// ─── Resolve handler ─────────────────────────────────────────────────
async function handleResolve(url, env) {
  const target = url.searchParams.get('url');
  if (!target) return json({ ok: false, error: 'Missing url' }, 400);
  if (!/^https?:\/\/(savelinks\.me|new\.savelinks\.me)\//i.test(target)) {
    return json({ ok: false, error: 'Only savelinks.me URLs supported' }, 400);
  }

  // Check cache
  const cacheKey = `resolve:${target}`;
  if (env && env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey, { type: 'json' });
      if (cached) return json(cached);
    } catch {}
  }

  // Step 1: fetch savelinks.me page
  const slResp = await fetch(target, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Referer': 'https://mlsbd.co/',
    },
    cf: { cacheTtl: 300, cacheEverything: true, scrapeShield: false },
  });
  if (!slResp.ok) return json({ ok: false, error: 'Savelinks fetch failed' }, 502);

  const slHtml = await slResp.text();

  // Step 2: extract host URLs (gdflix, multicloud, etc.)
  const hosts = [];
  const seen = new Set();
  const re = /<a\s+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*break-words[^"]*"[^>]*>/g;
  let m;
  while ((m = re.exec(slHtml)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    hosts.push(m[1]);
  }

  if (hosts.length === 0) return json({ ok: false, urls: [], hosts: [], error: 'No hosts found' });

  // Step 3: fetch each host page + extract direct video URL
  const urls = [];
  await Promise.all(hosts.map(async (hostUrl) => {
    try {
      const direct = await extractDirectFromHost(hostUrl);
      if (direct) urls.push(direct);
    } catch (e) { console.error('Host extract failed', hostUrl, String(e)); }
  }));

  const unique = [...new Set(urls)];
  const origin = new URL(url).origin;
  const proxiedUrls = unique.map((u) => {
    const b64 = btoa(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${origin}/proxy/${b64}`;
  });
  const result = { ok: proxiedUrls.length > 0, urls: proxiedUrls, hosts: hosts.map((h) => { try { return new URL(h).hostname; } catch { return 'unknown'; } }) };

  // Cache result
  if (env && env.CACHE && proxiedUrls.length > 0) {
    try { await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 1800 }); } catch {}
  }

  return json(result);
}

async function extractDirectFromHost(hostUrl) {
  const r = await fetch(hostUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Referer': 'https://savelinks.me/',
    },
    cf: { cacheTtl: 300, cacheEverything: true, scrapeShield: false },
  });
  if (!r.ok) return null;
  const html = await r.text();

  // Try multiple patterns
  const patterns = [
    /https?:\/\/bolt\.indexserver\.site\/[^"'\s<>]+/i,
    /https?:\/\/new\d*\.gdflix\.[a-z]+\/file\/dl\/[^"'\s<>]+/i,
    /https?:\/\/[^"'\s<>]+\.(?:mp4|mkv|m3u8|webm)(?:\?[^"'\s<>]*)?/i,
  ];
  for (const re of patterns) { const m = html.match(re); if (m) return m[0]; }

  // Try og:video
  const og = html.match(/<meta\s+property="og:video[^"]*"\s+content="([^"]+)"/i);
  if (og) return og[1];

  // Try /file/dl/ API
  const dlApiM = html.match(/(\/file\/dl\/[^"'\s<>]+)/);
  if (dlApiM) {
    try {
      const base = new URL(hostUrl).origin;
      const apiR = await fetch(base + dlApiM[1], {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': hostUrl,
          'Accept': 'application/json',
        },
      });
      if (apiR.ok) {
        try {
          const data = await apiR.json();
          const u = data.url || data.file || data.direct_url || (data.data && data.data.url);
          if (u && /^https?:\/\//.test(u)) return u;
        } catch {}
        const apiText = await apiR.text();
        const m2 = apiText.match(VIDEO_EXT_RE);
        if (m2) return m2[0];
      }
    } catch {}
  }

  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}
