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
  var slug = (url.searchParams.get('slug') || url.searchParams.get('id') || '').trim();

  if (!slug) {
    return json({ ok: false, error: 'Slug parameter is required' }, 400);
  }

  var env = context.env || {};

  // 1. Check GitHub mega-cache first
  var cacheRepo = env.SKM_CACHE_REPO || 'khadimsorder1-max/skmovies-cache';
  try {
    var ghUrl = 'https://raw.githubusercontent.com/' + cacheRepo + '/main/fojik/movie/' + encodeURIComponent(slug) + '.json';
    var ghResp = await fetch(ghUrl);
    if (ghResp.ok) {
      var ghText = await ghResp.text();
      if (ghText.trim().startsWith('{')) {
        var ghData = JSON.parse(ghText);
        if (ghData.ok && ghData.movie) {
          return json(Object.assign({}, ghData, { _cache: 'github' }), 200, 300);
        }
      }
    }
  } catch(e) {}

  // 2. Live scrape from fojik.site
  var targetUrl = slug.startsWith('http') ? slug : `https://fojik.site/movie/${slug}/`;

  try {
    var resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://fojik.site/',
      },
    });

    if (!resp.ok && !targetUrl.includes('fojik.site/movie/')) {
      targetUrl = `https://fojik.site/${slug}/`;
      resp = await fetch(targetUrl, {
        headers: { 'User-Agent': UA, 'Referer': 'https://fojik.site/' },
      });
    }

    if (!resp.ok) {
      return json({ ok: false, error: 'Movie page return HTTP ' + resp.status }, 404);
    }

    var html = await resp.text();
    var movie = parseFojikMovie(html, targetUrl, slug);

    return json({ ok: true, movie: movie }, 200, 300);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function parseFojikMovie(html, targetUrl, slug) {
  var titleM = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  var title = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : slug;

  var posterM = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || html.match(/<img[^>]+src="([^"]+)"/i);
  var poster = posterM ? posterM[1] : '';

  var storyM = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
               html.match(/<div[^>]*id="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  var storyline = storyM ? storyM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500).trim() : '';

  var genres = [];
  var genreRe = /<a[^>]+href="https?:\/\/[^"]*\/genre\/([^"/]+)\/?"[^>]*>([^<]+)<\/a>/gi;
  var gm;
  while ((gm = genreRe.exec(html)) !== null) {
    var gText = gm[2].trim();
    if (gText && !genres.includes(gText) && gText.length < 30) genres.push(gText);
  }

  var downloads = [];
  // Extract download forms inside download table
  var rowRe = /<tr[^>]*id=['"]link-\d+['"][^>]*>([\s\S]*?)<\/tr>/gi;
  var rm;
  while ((rm = rowRe.exec(html)) !== null) {
    var rowContent = rm[1];
    var formM = rowContent.match(/<form[^>]*action=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/form>/i);
    var qualityM = rowContent.match(/<strong[^>]*class=['"]quality['"][^>]*>([^<]+)<\/strong>/i) || rowContent.match(/(480p|720p|1080p|4k|hevc)/i);
    var langM = rowContent.match(/<td>\s*(Hindi|English|Tamil|Telugu|Dual Audio|ORG|[A-Z][a-z]+)\s*<\/td>/i);
    var sizeM = rowContent.match(/<td>\s*(\d+(?:\.\d+)?\s*(?:MB|GB))\s*<\/td>/i);

    var quality = qualityM ? qualityM[1].trim() : '1080p';
    var lang = langM ? langM[1].trim() : 'Hindi';
    var size = sizeM ? sizeM[1].trim() : '';

    if (formM) {
      var action = formM[1];
      var formInner = formM[2];
      var fuM = formInner.match(/name=['"]FU['"]\s+value=['"]([^'"]+)['"]/i);
      var fnM = formInner.match(/name=['"]FN['"]\s+value=['"]([^'"]+)['"]/i);

      var fu = fuM ? fuM[1] : '';
      var fn = fnM ? fnM[1] : '';

      downloads.push({
        label: `${quality} • ${lang} Direct Download`,
        url: action,
        savelinks_url: action,
        action: action,
        fu: fu,
        fn: fn,
        quality: quality,
        size: size,
        host: 'Fojik Host',
        isDirect: false,
        isFojikForm: true,
      });
    }
  }

  // Fallback: search for direct savelinks/gdflix/hubcloud/drive URLs
  if (downloads.length === 0) {
    var aRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    var am;
    while ((am = aRe.exec(html)) !== null) {
      var href = am[1];
      var text = am[2].replace(/<[^>]+>/g, '').trim();
      if (/savelinks|gdflix|hubcloud|filepress|drive|gdtot|busycdn|indexserver|multicloud|download/i.test(href) || /download/i.test(text)) {
        downloads.push({
          label: text || 'Download Link',
          url: href,
          savelinks_url: href,
          quality: '1080p',
          size: '',
          host: 'Fojik Download',
          isDirect: false,
        });
      }
    }
  }

  return {
    id: slug,
    slug: slug,
    title: title,
    poster: poster,
    storyline: storyline,
    genres: genres,
    downloads: downloads,
    source: 'fojik',
    url: targetUrl,
  };
}
