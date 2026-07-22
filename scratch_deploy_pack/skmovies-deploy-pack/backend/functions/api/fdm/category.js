// functions/api/fdm/category.js
// Reverse-engineered from https://skmovies-premium.pages.dev/api/fdm/category?slug=<slug>&page=<n>
//
// Note: the live backend returns 404 for unknown slugs — FDM's category URL
// structure uses /genre/<slug>/ rather than /category/<slug>/.

const UPSTREAM = 'https://freedrivemovie.cyou';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const slug = url.searchParams.get('slug') || '';
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  if (!slug) return json({ ok: false, error: 'Missing ?slug= param' }, 400);

  try {
    const upstreamUrl = `${UPSTREAM}/genre/${slug}/page/${page}/`;
    const resp = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (resp.status === 404) return json({ ok: false, error: `FDM category fetch failed: HTTP 404` }, 404);
    if (!resp.ok) return json({ ok: false, error: `FDM category fetch failed: HTTP ${resp.status}` }, 502);

    const html = await resp.text();
    const items = parseList(html);
    return json({ ok: true, page, slug, items });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function parseList(html) {
  const items = [];
  const re = /<(?:article|div)[^>]*class="[^"]*(?:movie-item|post)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|div)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[1];
    const title = stripTags(extractTag(block, 'h[2-4]') || '');
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
