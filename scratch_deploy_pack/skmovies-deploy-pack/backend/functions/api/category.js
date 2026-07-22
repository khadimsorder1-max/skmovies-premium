// functions/api/category.js
// Reverse-engineered from https://skmovies-premium.pages.dev/api/category?slug=<slug>&page=<n>
//
// Fetches a mlsbd.co category listing and parses items.

const UPSTREAM = 'https://mlsbd.co';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') || '';
  const page = parseInt(url.searchParams.get('page') || '1', 10);

  if (!slug) return json({ ok: false, error: 'Missing ?slug= param' }, 400);

  try {
    const upstreamUrl = `${UPSTREAM}/category/${slug}/page/${page}/`;
    const resp = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (resp.status === 404) return json({ ok: false, error: `Category not found: ${slug}` }, 404);
    if (!resp.ok) return json({ ok: false, error: `Upstream HTTP ${resp.status}` }, 502);

    const html = await resp.text();
    const items = parseList(html);
    return json({ ok: true, page, slug, items });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function parseList(html) {
  const items = [];
  const postRegex = /<article[^>]*class="[^"]*post[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = postRegex.exec(html)) !== null) {
    const block = m[1];
    const slug = (block.match(/mlsbd\.co\/([^\/?#]+)\/?/) || [])[1];
    const title = stripTags(extractTag(block, 'h[2-3]') || '');
    const poster = extractAttr(block, 'img', 'src') || '';
    const year = (title.match(/\((\d{4})\)/) || [])[1] || '';
    const quality = (title.match(/\b(480P|720P|1080P|4K)\b/i) || [])[1]?.toUpperCase() || '';
    const language = (title.match(/\b(Bengali|Hindi|English|Dual Audio)\b/i) || [])[1] || '';
    const sizes = [...title.matchAll(/(\d+(?:\.\d+)?(?:GB|MB))/gi)].map(x => x[1]);
    if (slug && title) items.push({ slug, title, poster, year, quality, language, uploadDate: '', sizes });
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
