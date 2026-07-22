// functions/api/trending.js
// Reverse-engineered from https://skmovies-premium.pages.dev/api/trending
//
// Returns the trending movies from mlsbd.co homepage's "trending" / "popular" section.

const UPSTREAM = 'https://mlsbd.co';

export async function onRequest(context) {
  try {
    const resp = await fetch(`${UPSTREAM}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!resp.ok) return json({ ok: false, error: `Upstream HTTP ${resp.status}` }, 502);

    const html = await resp.text();
    // Find the "trending"/"popular" section — usually a widget area
    const trendBlock = extractBlock(html, /class="[^"]*(?:trending|popular)[^"]*"/i) || html;
    const items = parseList(trendBlock);
    return json({ ok: true, items });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function extractBlock(html, markerRe) {
  const m = html.match(markerRe);
  if (!m) return null;
  const start = m.index;
  // Walk to the next closing </div> at the same depth — naive, good enough for typical WP themes
  let depth = 1, i = start + m[0].length;
  while (i < html.length && depth > 0) {
    if (html[i] === '<' && html.slice(i, i+4) === '<div') depth++;
    else if (html[i] === '<' && html.slice(i, i+6) === '</div>') depth--;
    i++;
  }
  return html.slice(start, i);
}

function parseList(html) {
  const items = [];
  const postRegex = /<(?:article|li|div)[^>]*class="[^"]*post[^"]*"[^>]*>([\s\S]*?)<\/(?:article|li|div)>/g;
  let m;
  while ((m = postRegex.exec(html)) !== null) {
    const block = m[1];
    const slug = (block.match(/mlsbd\.co\/([^\/?#]+)\/?/) || [])[1];
    const title = stripTags(extractTag(block, 'h[2-4]') || extractAttr(block, 'a', 'title') || '');
    const poster = extractAttr(block, 'img', 'src') || '';
    if (slug && title) items.push({ slug, title, poster, year: '', quality: '', language: '', uploadDate: '', sizes: [] });
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
