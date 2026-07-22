// functions/api/fdm/resolve.js
// Resolves a freedrivemovie.cyou/links/<id>/ or /episodes/<id>/ URL to direct video URLs.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Hosts that are known to be direct-video-CDNs (return video/x-matroska, video/mp4, etc.)
const DIRECT_VIDEO_HOST_PATTERNS = [
  /\.workers\.dev$/i,
  /^dl\.freedrivemovie\.org$/i,
  /\.freedrivemovie\.org$/i,
  /indexserver\.site$/i,
  /multicloudlinks\.com$/i,
  /busycdn\.xyz$/i,
];

// File-host landing pages (HTML, need a second resolver — kept as fallback)
const FILEHOST_PATTERNS = [
  { re: /gdflix\.(dev|dad|com)$/i,        name: 'GDFlix'    },
  { re: /hubcloud\.(lol|foo|com)$/i,      name: 'HubCloud'  },
  { re: /gdtot\.(dad|com|dev)$/i,         name: 'GDTot'     },
  { re: /gdlink\.dev$/i,                  name: 'GDLink'    },
  { re: /filepress\.(baby|com)$/i,        name: 'FilePress' },
  { re: /multicloudlinks\.com$/i,         name: 'MultiCloud'},
  { re: /multidownload\.website$/i,       name: 'MultiDL'   },
  { re: /t\.me/i,                         name: 'Telegram'  },
  { re: /telegram/i,                      name: 'Telegram'  },
];

function isDirectVideo(url) {
  try {
    const u = new URL(url);
    return DIRECT_VIDEO_HOST_PATTERNS.some(re => re.test(u.hostname)) ||
           /\.(mp4|mkv|webm|m3u8)(\?|$)/i.test(u.pathname);
  } catch { return false; }
}

function fileHostName(url) {
  try {
    const u = new URL(url);
    for (const p of FILEHOST_PATTERNS) if (p.re.test(u.hostname)) return p.name;
    return u.hostname;
  } catch { return ''; }
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
    cf: { cacheTtl: 60, cacheEverything: false },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return await r.text();
}

// Extract the dl.freedrivemovie.org/<slug>/ URL from a /links/<id>/ page
function findDlUrl(html) {
  const m = html.match(/href="(https?:\/\/dl\.freedrivemovie\.org\/[^"]+)"/i);
  return m ? m[1] : null;
}

// Parse dl.freedrivemovie.org/<slug>/ (or /episodes/<slug>/) — split by wp-block-button blocks
function parseDlPage(html) {
  const directUrls = [];
  const hostUrls  = [];

  // Find every <div class="wp-block-button"><a href="URL">LABEL</a></div>
  const buttonRe = /<div class="wp-block-button">\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/div>/gi;
  let m;
  while ((m = buttonRe.exec(html)) !== null) {
    const url   = m[1].trim();
    const label = m[2].replace(/<[^>]+>/g, '').trim();
    if (!/^https?:\/\//.test(url)) continue;
    if (isDirectVideo(url)) {
      directUrls.push({ url, label });
      if (/multicloudlinks\.com/i.test(url)) {
        hostUrls.push({ url, label, host: 'MultiCloud' });
      }
    } else {
      hostUrls.push({ url, label, host: fileHostName(url) });
    }
  }
  return { directUrls, hostUrls };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target || !/freedrivemovie\.(cyou|org|com)\/(links|episodes)\//i.test(target)) {
    return json({ ok: false, error: 'Invalid URL — expected a freedrivemovie.(cyou|org|com)/links/<id>/ or /episodes/<id>/ URL' }, 400);
  }

  // Check KV cache
  const cacheKey = `fdm:resolve:${target}`;
  let cacheVal = null;
  if (env.LINKS_CACHE) {
    try {
      cacheVal = await env.LINKS_CACHE.get(cacheKey, 'json');
    } catch {}
  }
  if (cacheVal && (Date.now() - cacheVal.ts < 5 * 60 * 1000)) {
    return json(cacheVal.data);
  }

  try {
    let dlHtml;
    let dlUrl = target;

    if (/\/links\//.test(target)) {
      // Step 1: fetch the /links/<id>/ page to find the dl.freedrivemovie.org URL
      const linksHtml = await fetchText(target);
      dlUrl = findDlUrl(linksHtml);

      // Some /links/ pages already redirect — also try a <meta refresh> fallback
      if (!dlUrl) {
        const meta = linksHtml.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"']+)/i);
        if (meta) dlUrl = meta[1].trim();
      }
      
      if (!dlUrl) {
        const mMatch = linksHtml.match(/href="(https?:\/\/(?:mega\.nz|drive\.google\.com)\/[^"]+)"/i);
        if (mMatch) {
          const directUrl = mMatch[1];
          const out = {
            ok: true,
            urls: [directUrl],
            rawUrls: [directUrl],
            labels: ['Direct'],
            hosts: [{ host: new URL(directUrl).hostname, url: directUrl, label: 'Direct' }],
            source: 'freedrivemovie',
          };
          return json(out);
        }
        return json({ ok: false, error: 'Could not find dl.freedrivemovie.org URL on /links/ page', hosts: [] }, 502);
      }
      dlHtml = await fetchText(dlUrl);
    } else {
      // It is a /episodes/ page, fetch it directly
      dlHtml = await fetchText(target);
    }

    const { directUrls, hostUrls } = parseDlPage(dlHtml);

    if (directUrls.length === 0 && hostUrls.length === 0) {
      return json({ ok: false, error: 'No download buttons found on download page', hosts: [], dlUrl }, 502);
    }

    const out = {
      ok: directUrls.length > 0,
      urls: directUrls.map(d => d.url),
      rawUrls: directUrls.map(d => d.url),
      labels: directUrls.map(d => d.label),
      hosts: hostUrls.map(h => ({ host: h.host, url: h.url, label: h.label })),
      dlUrl,
      source: 'freedrivemovie',
    };

    if (env.LINKS_CACHE) {
      try {
        await env.LINKS_CACHE.put(cacheKey, JSON.stringify({ ts: Date.now(), data: out }), { expirationTtl: 600 });
      } catch {}
    }

    return json(out);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e), hosts: [] }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
