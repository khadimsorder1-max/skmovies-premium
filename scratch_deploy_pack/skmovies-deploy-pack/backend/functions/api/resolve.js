// functions/api/resolve.js
// Reverse-engineered from https://skmovies-premium.pages.dev/api/resolve?url=<savelinks-url>
//
// Fetches a savelinks.me/view/<id> page and extracts all the outgoing file-host URLs.

const ALLOWED_HOSTS = [
  'savelinks.me',
];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = url.searchParams.get('url');

  if (!target) return json({ ok: false, error: 'Missing ?url= param' }, 400);

  try {
    const u = new URL(target);
    const okHost = ALLOWED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
    if (!okHost) {
      return json({ ok: false, error: 'Invalid URL — expected a savelinks.me/view/<id> URL' }, 400);
    }
    if (!/^\/view\/[A-Za-z0-9]+\/?$/.test(u.pathname)) {
      return json({ ok: false, error: 'Invalid URL — expected a savelinks.me/view/<id> URL' }, 400);
    }

    const resp = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!resp.ok) return json({ ok: false, error: `Upstream HTTP ${resp.status}` }, 502);

    const html = await resp.text();
    const hosts = parseSavelinks(html);
    const rawUrls = hosts.map(h => h.url);
    const urls = [...new Set(rawUrls)];

    return json({
      ok: true,
      urls,
      rawUrls,
      hosts,
      savelinksUrl: target,
      source: 'mlsbd',
      fallback: null,
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function parseSavelinks(html) {
  const hosts = [];
  // savelinks.me typically renders links as <a href="..."> inside .link-container or .download-links
  const linkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const linkUrl = m[1];
    const text = stripTags(m[2]).trim();
    const host = detectHost(linkUrl);
    if (host && !hosts.find(h => h.url === linkUrl)) {
      hosts.push({ host, url: linkUrl, text: text || linkUrl });
    }
  }
  // Always include Telegram request channel if present
  const tgMatch = html.match(/https?:\/\/t\.me\/[A-Za-z0-9_]+/);
  if (tgMatch && !hosts.find(h => h.url === tgMatch[0])) {
    hosts.push({ host: 'Telegram', url: tgMatch[0], text: 'Telegram' });
  }
  return hosts;
}

function detectHost(url) {
  const h = new URL(url).hostname.toLowerCase();
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
