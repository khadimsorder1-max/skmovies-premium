// functions/api/fdm/resolve.js
// Reverse-engineered from https://skmovies-premium.pages.dev/api/fdm/resolve?url=<fdm-links-or-episodes-url>
//
// Resolves a freedrivemovie.(cyou|org|com)/links/<id>/ or /episodes/<id>/ page
// and extracts the outgoing file-host URLs (GDFlix, FilePress, MultiCloud, etc.).

const ALLOWED_HOST_PATTERNS = [
  /^freedrivemovie\.(cyou|org|com)$/i,
];

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = url.searchParams.get('url');
  if (!target) return json({ ok: false, error: 'Missing ?url= param' }, 400);

  let parsed;
  try { parsed = new URL(target); }
  catch { return json({ ok: false, error: 'Invalid URL' }, 400); }

  const allowed = ALLOWED_HOST_PATTERNS.some(re => re.test(parsed.hostname));
  if (!allowed) {
    return json({ ok: false, error: 'Invalid URL — expected a freedrivemovie.(cyou|org|com)/links/<id>/ or /episodes/<id>/ URL' }, 400);
  }
  if (!/^\/(links|episodes)\/[A-Za-z0-9]+\/?$/.test(parsed.pathname)) {
    return json({ ok: false, error: 'Invalid URL — expected a freedrivemovie.(cyou|org|com)/links/<id>/ or /episodes/<id>/ URL' }, 400);
  }

  try {
    const resp = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!resp.ok) return json({ ok: false, error: `Upstream HTTP ${resp.status}` }, 502);

    const html = await resp.text();
    const hosts = parseHosts(html);
    const rawUrls = hosts.map(h => h.url);
    const urls = [...new Set(rawUrls)];

    return json({
      ok: true,
      urls,
      rawUrls,
      hosts,
      sourceUrl: target,
      source: 'fdm',
      fallback: null,
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function parseHosts(html) {
  const hosts = [];
  const linkRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const linkUrl = m[1];
    const text = stripTags(m[2]).trim();
    const host = detectHost(linkUrl);
    if (host && !hosts.find(h => h.url === linkUrl)) {
      hosts.push({ host, url: linkUrl, text: text || linkUrl });
    }
  }
  return hosts;
}

function detectHost(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase(); }
  catch { return null; }
  if (h.includes('gdflix'))   return 'GDFlix';
  if (h.includes('filepress'))return 'FilePress';
  if (h.includes('multicloud')) return 'MultiCloud';
  if (h.includes('hubcloud')) return 'HubCloud';
  if (h.includes('gdtot'))    return 'GDTot';
  if (h.includes('gdlink'))   return 'GDLink';
  if (h.includes('multidownload')) return 'MultiDownload';
  if (h.includes('indexserver')) return 'IndexServer';
  if (h.includes('busycdn'))  return 'BusyCDN';
  if (h.includes('t.me'))     return 'Telegram';
  if (h.includes('freedrivemovie')) return 'FreeDriveMovie';
  return null;
}

function stripTags(s) { return (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
