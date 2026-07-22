// functions/api/movie.js
// Reverse-engineered from https://skmovies-premium.pages.dev/api/movie?slug=<slug>
//
// Fetches a single movie page from mlsbd.co/<slug>/ and parses the full detail.

const UPSTREAM = 'https://mlsbd.co';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (!slug) return json({ ok: false, error: 'Missing ?slug= param' }, 400);

  try {
    const upstreamUrl = `${UPSTREAM}/${slug}/`;
    const resp = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (resp.status === 404) return json({ ok: false, error: 'Movie not found' }, 404);
    if (!resp.ok) return json({ ok: false, error: `Upstream HTTP ${resp.status}` }, 502);

    const html = await resp.text();
    const movie = parseMlsbdMovie(html, slug);
    return json({ ok: true, ...movie });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function parseMlsbdMovie(html, slug) {
  // Title from <h1 class="entry-title"> or <title>
  const title = stripTags(extractTag(html, 'h1') || extractTag(html, 'title') || '');

  // Poster from og:image
  const poster = (html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || [])[1] || '';

  // Author / upload date from .post-meta or .entry-meta
  const author = (html.match(/class="[^"]*author[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i) || [])[1] || 'MLSBD TEAM';
  const uploadDate = (html.match(/(\d+\s+(?:day|days|hour|hours|week|weeks|month|months|year|years)\s+ago)/i) || [])[1] || '';

  // Categories: every link inside .cat-links or .entry-categories
  const categories = [...html.matchAll(/<a\s+href="[^"]*\/category\/[^"]*"\s+rel="[^"]*"\s*>([^<]+)<\/a>/gi)]
    .map(m => stripTags(m[1]));

  // Trailer: first YouTube/Vimeo URL in the body
  const trailer = (html.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/embed\/[\w-]+|youtu\.be\/[\w-]+|vimeo\.com\/\d+)/i) || [])[0] || '';

  // Storyline: text inside .storyline or first <p> after entry-content
  const storyline = extractSection(html, 'storyline') || '';

  // Screenshots: <img> URLs whose href/src contains "screenshot" or "imgnest"
  const screenshots = [...html.matchAll(/<img[^>]+src=["']([^"']+(?:screenshot|imgnest)[^"']*)["']/gi)]
    .map(m => m[1]);

  // Download sections — every https://savelinks.me/view/<id> URL inside the body
  const savelinksRegex = /https:\/\/savelinks\.me\/view\/([A-Za-z0-9]+)/g;
  const downloads = [];
  let m;
  while ((m = savelinksRegex.exec(html)) !== null) {
    // Find the nearest preceding heading/quality label
    const before = html.slice(Math.max(0, m.index - 600), m.index);
    const quality = (before.match(/\b(480P|720P|1080P|4K|2160P)\b[^<]*$/) || [])[1]
      || (before.match(/\b(480p|720p|1080p|4k)\b/i) || [])[1]?.toUpperCase()
      || '';
    const sizeMatch = before.match(/(\d+(?:\.\d+)?(?:GB|MB))/i);
    downloads.push({
      quality,
      savelinks_url: `https://savelinks.me/view/${m[1]}`,
      info: 'Download Links Here',
      label: sizeMatch ? `Download in ${quality} ${sizeMatch[1]} quality` : `Download in ${quality} quality`,
    });
  }

  // IMDB / Rotten / Cast / Director — best-effort scrape from common WP theme patterns
  const imdbRating = (html.match(/IMDb[:\s]+([\d.]+\/10|N\/A)/i) || [])[1] || '(N/A)';
  const director = (html.match(/Director[:\s]+([^<\n]+)/i) || [])[1]?.trim() || '';
  const cast = [...html.matchAll(/<a[^>]+rel="tag"[^>]*>([^<]+)<\/a>/gi)].map(m => stripTags(m[1])).slice(0, 20);

  // Sizes summary
  const sizes = [...title.matchAll(/(\d+(?:\.\d+)?(?:GB|MB))/gi)].map(m => m[1]);
  const year = (title.match(/\((\d{4})\)/) || [])[1] || '';

  return {
    slug,
    title,
    poster,
    uploadDate,
    author,
    categories,
    sizes,
    imdbRating,
    rotten: '',
    director,
    cast,
    storyline,
    screenshots,
    trailer,
    sections: [{ section_title: 'Download', downloads }],
    isMultiEpisode: false,
    episodeSections: [],
    downloads,
    watchOnline: '',
    movieUrl: `${UPSTREAM}/${slug}/`,
  };
}

// Helpers
function extractTag(s, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  return (s.match(re) || [])[1] || '';
}
function extractSection(html, klass) {
  const re = new RegExp(`class="[^"]*${klass}[^"]*"[^>]*>([\\s\\S]*?)<\\/(?:div|section|p)>`, 'i');
  return stripTags((html.match(re) || [])[1] || '');
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
