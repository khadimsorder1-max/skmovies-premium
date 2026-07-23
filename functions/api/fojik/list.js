const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function json(data, status = 200, maxAge = 60) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=' + maxAge,
      'Access-Control-Allow-Origin': '*',
    },
  });
}


export async function onRequest(context) {
  var url = new URL(context.request.url);
  var type = url.searchParams.get('type') || 'home';
  var page = parseInt(url.searchParams.get('page') || '1', 10);
  var q = (url.searchParams.get('q') || '').trim();
  var catSlug = (url.searchParams.get('slug') || '').trim();

  var env = context.env || {};

  // 1. Check GitHub mega-cache first for home page
  if (type === 'home' && page <= 10) {
    var cacheRepo = env.SKM_CACHE_REPO || 'khadimsorder1-max/skmovies-cache';
    try {
      var ghUrl = 'https://raw.githubusercontent.com/' + cacheRepo + '/main/fojik/latest' + (page > 1 ? '-' + page : '') + '.json';
      var ghResp = await fetch(ghUrl);
      if (ghResp.ok) {
        var ghText = await ghResp.text();
        if (ghText.trim().startsWith('{')) {
          var ghData = JSON.parse(ghText);
          if (ghData.ok && ghData.items && ghData.items.length > 0) {
            return json(Object.assign({}, ghData, { _cache: 'github' }), 200, 120);
          }
        }
      }
    } catch(e) {}
  }

  // 2. Live scrape from fojik.site
  var targetUrl = 'https://fojik.site/';
  if (type === 'search' && q) {
    targetUrl = page > 1 ? `https://fojik.site/page/${page}/?s=${encodeURIComponent(q)}` : `https://fojik.site/?s=${encodeURIComponent(q)}`;
  } else if (type === 'category' && catSlug) {
    targetUrl = page > 1 ? `https://fojik.site/genre/${catSlug}/page/${page}/` : `https://fojik.site/genre/${catSlug}/`;
  } else if (page > 1) {
    targetUrl = `https://fojik.site/page/${page}/`;
  }

  try {
    var resp = await fetch(targetUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://fojik.site/',
      },
    });

    if (!resp.ok) return json({ ok: true, page: page, items: [], hasMore: false }, 200);

    var html = await resp.text();
    var items = parseFojikList(html);

    return json({ ok: true, page: page, items: items, hasMore: items.length >= 12 }, 200, 120);
  } catch (e) {
    return json({ ok: false, error: e.message }, 200);
  }
}

function parseFojikList(html) {
  var items = [];
  var seen = new Set();
  var itemRe = /<article[^>]*>([\s\S]*?)<\/article>|<div[^>]*class="[^"]*(?:result-item|item|post|entry)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  var m;

  while ((m = itemRe.exec(html)) !== null) {
    var block = m[1] || m[2];
    var titleM = block.match(/<div[^>]*class="title"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
                 block.match(/<h[234][^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
                 block.match(/<a[^>]+href="(https?:\/\/[^"]*\/(?:movie|series)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
                 block.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    var imgM = block.match(/<img[^>]+src="([^"]+)"/i) || block.match(/data-src="([^"]+)"/i) || block.match(/data-lazy-src="([^"]+)"/i);

    if (!titleM) continue;

    var rawUrl = titleM[1];
    var title = titleM[2].replace(/<[^>]+>/g, '').trim();

    if (!rawUrl || title.length < 3 || title.toLowerCase() === 'movie' || /genre|category|tag|page|\/$/i.test(rawUrl) && rawUrl.split('/').length < 5) continue;

    var slugMatch = rawUrl.match(/\/(?:movie|series)\/([^/]+)/i) || rawUrl.match(/\/([^/]+)\/?$/i);
    var slug = slugMatch ? slugMatch[1] : '';
    if (!slug || slug === 'movie' || slug === 'genre' || seen.has(slug)) continue;
    seen.add(slug);

    var img = imgM ? imgM[1] : '';
    if (img.startsWith('//')) img = 'https:' + img;

    var qualityM = title.match(/(480p|720p|1080p|2160p|4k|hdrip|web-dl|bluray|hevc)/i);
    var quality = qualityM ? qualityM[1].toUpperCase() : 'HD';

    var yearM = title.match(/\b(19\d{2}|20\d{2})\b/);
    var year = yearM ? yearM[1] : '';

    var ratingM = block.match(/class="rating"[^>]*>([^<]+)</i) || block.match(/(\d\.\d)\s*<\/span>/i);
    var rating = ratingM ? ratingM[1].trim() : '';

    items.push({
      id: slug,
      slug: slug,
      title: title,
      poster: img,
      quality: quality,
      year: year,
      rating: rating,
      source: 'fojik',
      url: rawUrl,
    });
  }

  // Fallback: If 0 items parsed from block regex, extract directly from <a> tags with movie/series URLs
  if (items.length === 0) {
    var aRe = /<a[^>]+href="(https?:\/\/[^"]*\/(?:movie|series)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    var am;
    while ((am = aRe.exec(html)) !== null) {
      var href = am[1];
      var tText = am[2].replace(/<[^>]+>/g, '').trim();
      if (!tText || tText.length < 3 || /read more|download|watch/i.test(tText)) continue;

      var sm = href.match(/\/(?:movie|series)\/([^/]+)/i) || href.match(/\/([^/]+)\/?$/i);
      var s = sm ? sm[1] : '';
      if (!s || s === 'movie' || seen.has(s)) continue;
      seen.add(s);

      var qM = tText.match(/(480p|720p|1080p|2160p|4k|hdrip|web-dl|bluray|hevc)/i);
      var yM = tText.match(/\b(19\d{2}|20\d{2})\b/);

      items.push({
        id: s,
        slug: s,
        title: tText,
        poster: '',
        quality: qM ? qM[1].toUpperCase() : 'HD',
        year: yM ? yM[1] : '',
        rating: '',
        source: 'fojik',
        url: href,
      });
    }
  }

  return items;
}
