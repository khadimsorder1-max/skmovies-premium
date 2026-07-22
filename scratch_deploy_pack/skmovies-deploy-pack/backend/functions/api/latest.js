// functions/api/latest.js
// Reverse-engineered from observed behavior of https://skmovies-premium.pages.dev/api/latest
//
// Fetches the latest movies from mlsbd.co, parses the HTML list, and returns JSON.
//
// Query params:
//   page   – page number (1-indexed, default 1)
//   filter – quality/language filter (e.g. 1080p, hindi, dual, web-dl). Default "all".

const UPSTREAM = 'https://mlsbd.co';
const FILTER_MAP = {
  all: '', 1080p: '/category/1080p', '720p': '/category/720p', '480p': '/category/480p',
  '4k': '/category/4k', bengali: '/category/bangla-movies', hindi: '/category/hindi-dubbed-movies',
  english: '/category/english-movies', dual: '/category/dual-audio-movies',
  'web-dl': '/category/web-dl', bluray: '/category/bluray',
};

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const filter = url.searchParams.get('filter') || 'all';

  try {
    const upstreamBase = FILTER_MAP[filter] || '';
    const upstreamUrl = `${UPSTREAM}${upstreamBase}/page/${page}/`;

    const resp = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!resp.ok) {
      return json({ ok: false, error: `Upstream HTTP ${resp.status}` }, 502);
    }

    const html = await resp.text();
    const items = parseMlsbdList(html);
    return json({ ok: true, page, filter, items });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// Parses mlsbd.co movie listing HTML into structured items.
function parseMlsbdList(html) {
  const items = [];
  // mlsbd.co uses a WordPress theme; each movie is in an <article> with class .post or .movie-item
  // Regex-based extraction (keep it portable for Cloudflare Workers runtime).
  const postRegex = /<article[^>]*class="[^"]*post[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let match;
  while ((match = postRegex.exec(html)) !== null) {
    const block = match[1];
    const slug = extractAttr(block, 'a', 'href')?.match(/mlsbd\.co\/([^\/?#]+)\/?/)?.[1];
    const title = stripTags(extractTag(block, 'h[2-3]') || '');
    const poster = extractAttr(block, 'img', 'src') || extractAttr(block, 'img', 'data-src');
    const year = (title.match(/\((\d{4})\)/) || [])[1] || '';
    const quality = (title.match(/\b(480P|720P|1080P|4K|2160P)\b/i) || [])[1]?.toUpperCase() || '';
    const language = (title.match(/\b(Bengali|Hindi|English|Tamil|Telugu|Dual Audio|Multi Audio)\b/i) || [])[1] || '';
    const uploadDate = (block.match(/(\d+\s+(?:day|days|hour|hours|week|weeks|month|months|year|years)\s+ago)/i) || [])[1] || '';
    const sizes = [...title.matchAll(/(\d+(?:\.\d+)?(?:GB|MB))/gi)].map(m => m[1]);

    if (slug && title) {
      items.push({ slug, title, poster, year, quality, language, uploadDate, sizes });
    }
  }
  return items;
}

// --- helpers ---
function extractTag(s, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  return (s.match(re) || [])[1] || '';
}
function extractAttr(s, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["']`, 'i');
  return (s.match(re) || [])[1] || null;
}
function stripTags(s) { return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
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
