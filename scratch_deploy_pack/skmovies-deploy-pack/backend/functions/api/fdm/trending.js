// functions/api/fdm/trending.js
// Reverse-engineered from https://skmovies-premium.pages.dev/api/fdm/trending

const UPSTREAM = 'https://freedrivemovie.cyou';

export async function onRequest(context) {
  try {
    // FDM exposes a "trending" / "popular" widget on the homepage.
    const resp = await fetch(`${UPSTREAM}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!resp.ok) return json({ ok: false, error: `Upstream HTTP ${resp.status}` }, 502);
    const html = await resp.text();
    const block = extractBlock(html, /class="[^"]*(?:trending|popular)[^"]*"/i) || html;
    const items = parseList(block);
    return json({ ok: true, items });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function extractBlock(html, markerRe) {
  const m = html.match(markerRe);
  if (!m) return null;
  let depth = 1, i = m.index + m[0].length;
  while (i < html.length && depth > 0) {
    if (html[i] === '<' && html.slice(i, i+4) === '<div') depth++;
    else if (html[i] === '<' && html.slice(i, i+6) === '</div>') depth--;
    i++;
  }
  return html.slice(m.index, i);
}

function parseList(html) {
  const items = [];
  const re = /<(?:article|div|li)[^>]*class="[^"]*(?:movie-item|post)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|div|li)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[1];
    const title = stripTags(extractTag(block, 'h[2-4]') || extractAttr(block, 'a', 'title') || '');
    const href = extractAttr(block, 'a', 'href') || '';
    const slug = href.split('/').filter(Boolean).pop() || '';
    const poster = extractAttr(block, 'img', 'src') || '';
    if (slug && title) items.push({ slug, title, poster, year: '', type: 'Movie', url: href });
  }
  return items;
}

function extractTag(s, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  return (s.match(re) || [])[1] || '';
}
function extractAttr(s, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["']`, 'i');
  return (s.match(re) || [])[1] || null;
}
function stripTags(s) { return (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
