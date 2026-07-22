// functions/api/fdm/latest.js
// Reverse-engineered from https://skmovies-premium.pages.dev/api/fdm/latest
//
// Fetches the latest movies from freedrivemovie.cyou (the FDM source) and
// returns a JSON list compatible with the SKMovies frontend.

const UPSTREAM = 'https://freedrivemovie.cyou';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);

  try {
    const upstreamUrl = page > 1 ? `${UPSTREAM}/page/${page}/` : `${UPSTREAM}/`;
    const resp = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!resp.ok) return json({ ok: false, error: `Upstream HTTP ${resp.status}` }, 502);

    const html = await resp.text();
    const items = parseFdmList(html);
    return json({ ok: true, page, items });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function parseFdmList(html) {
  const items = [];
  const re = /<(?:article|div)[^>]*class="[^"]*(?:movie-item|movie-card|post)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|div)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[1];
    const title = stripTags(extractTag(block, 'h[2-4]') || extractAttr(block, 'a', 'title') || '');
    const href = extractAttr(block, 'a', 'href') || '';
    const slug = href.split('/').filter(Boolean).pop() || '';
    const poster = extractAttr(block, 'img', 'src') || extractAttr(block, 'img', 'data-src') || '';
    const year = (title.match(/\((\d{4})\)/) || [])[1] || '';
    if (slug && title) {
      items.push({ slug, title, poster, year, type: 'Movie', url: href });
    }
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
      'Cache-Control': 'public, max-age=60',
    },
  });
}
