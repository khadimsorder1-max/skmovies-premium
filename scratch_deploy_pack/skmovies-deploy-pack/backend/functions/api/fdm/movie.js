// functions/api/fdm/movie.js
// Reverse-engineered from https://skmovies-premium.pages.dev/api/fdm/movie?slug=<slug>
//
// Fetches a single movie page from freedrivemovie.cyou/movies/<slug>/ and parses
// the full detail (poster, synopsis, genres, cast, director, download links).

const UPSTREAM = 'https://freedrivemovie.cyou';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return json({ ok: false, error: 'Missing ?slug= param' }, 400);

  try {
    const upstreamUrl = `${UPSTREAM}/movies/${slug}/`;
    const resp = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (resp.status === 404) return json({ ok: false, error: 'Movie not found' }, 404);
    if (!resp.ok) return json({ ok: false, error: `Upstream HTTP ${resp.status}` }, 502);

    const html = await resp.text();
    const movie = parseFdmMovie(html, slug, upstreamUrl);
    return json({ ok: true, ...movie });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function parseFdmMovie(html, slug, movieUrl) {
  const title = stripTags(extractTag(html, 'h1') || '');
  const poster = (html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || [])[1] || '';
  const originalTitle = (html.match(/Original Title[:\s]+([^<\n]+)/i) || [])[1]?.trim() || title;
  const synopsis = (html.match(/<div[^>]*class="[^"]*(?:synopsis|description|story)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
  const director = (html.match(/Director[:\s]+([^<\n]+)/i) || [])[1]?.trim() || '';

  // Genres — every link inside .genres or .category
  const genres = [...html.matchAll(/<a\s+href="[^"]*\/genre\/[^"]*"\s*>([^<]+)<\/a>/gi)].map(m => stripTags(m[1]));
  // Cast
  const cast = [...html.matchAll(/<a\s+href="[^"]*\/cast\/[^"]*"\s*>([^<]+)<\/a>/gi)].map(m => stripTags(m[1])).slice(0, 20);

  // Download links — FDM uses /links/<id>/ on its own CDN host
  const downloads = [];
  const linkRe = /https:\/\/freedrivemovie\.(cyou|org|com)\/links\/([A-Za-z0-9]+)\/?/g;
  let m;
  const seen = new Set();
  while ((m = linkRe.exec(html)) !== null) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    // look back 600 chars for quality/size/language labels
    const before = html.slice(Math.max(0, m.index - 600), m.index);
    const quality = (before.match(/\b(Mega[^<]*|HD\s*480p|HD\s*720p|HD\s*1080p|4K|2160p)\b/i) || [])[1]?.trim() || '';
    const size = (before.match(/(\d+(?:\.\d+)?(?:GB|MB))/i) || [])[1] || '----';
    const language = (before.match(/\b(Dual Audio[^<\n]*|Hindi[^<\n]*|English[^<\n]*|Tamil[^<\n]*|Telugu[^<\n]*)/i) || [])[1]?.trim() || '';
    downloads.push({
      id: m[2],
      url: m[0],
      savelinks_url: m[0],
      quality,
      language,
      size,
      host: 'dl.freedrivemovie.org',
    });
  }

  // Episodes (for series)
  const episodeRe = /https:\/\/freedrivemovie\.(cyou|org|com)\/episodes\/([A-Za-z0-9]+)\/?/g;
  const episodeSections = [];
  while ((m = episodeRe.exec(html)) !== null) {
    episodeSections.push({ url: m[0], id: m[2] });
  }

  return {
    slug,
    title,
    poster,
    originalTitle,
    synopsis: stripTags(synopsis),
    genres,
    cast,
    director,
    downloads,
    episodeSections,
    isMultiEpisode: episodeSections.length > 0,
    movieUrl,
  };
}

function extractTag(s, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  return (s.match(re) || [])[1] || '';
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
