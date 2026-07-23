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
        if (ghData.ok && ghData.movie && Array.isArray(ghData.movie.downloads) && ghData.movie.downloads.length > 0) {
          return json(Object.assign({}, ghData, { _cache: 'github' }), 200, 300);
        }
      }
    }
  } catch(e) {}

  // 2. Live scrape from fojik.site
  try {
    var cleanSlug = slug.replace(/^https?:\/\/[^\/]+\//, '').replace(/^movie\//, '').replace(/\/$/, '');
    var candidateUrls = slug.startsWith('http') 
      ? [slug] 
      : [
          `https://fojik.com/movie/${cleanSlug}/`,
          `https://fojik.com/${cleanSlug}/`,
          `https://fojik.site/movie/${cleanSlug}/`,
          `https://fojik.site/${cleanSlug}/`,
          `https://fojik.site/movie/${slug}/`,
          `https://fojik.site/${slug}/`
        ];

    var resp = null;
    var targetUrl = candidateUrls[0];

    for (var i = 0; i < candidateUrls.length; i++) {
      var u = candidateUrls[i];
      try {
        var r = await fetch(u, {
          redirect: 'follow',
          headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        if (r.ok) {
          resp = r;
          targetUrl = r.url || u;
          break;
        }
      } catch(e) {}
    }

    if (!resp || !resp.ok) {
      return json({ ok: false, error: 'Movie page returned HTTP ' + (resp ? resp.status : 404) }, 404);
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
  // Fojik uses single-quote attributes: name='FU' value='...'
  // Extract ALL forms with FU/FN fields
  var formRe = /<form[^>]*action=['"]([^'"]+)['"][^>]*>([\s\S]{0,3000}?)<\/form>/gi;
  var fm;
  while ((fm = formRe.exec(html)) !== null) {
    var action = fm[1];
    var inner = fm[2];
    if (!/name=['"]FU['"]/i.test(inner)) continue;

    // Extract all input tags and parse their attributes
    var inputTags = inner.match(/<input[^>]+>/gi) || [];
    var fu = '', fn = '';
    for (var j = 0; j < inputTags.length; j++) {
      var tag = inputTags[j];
      var nameM = tag.match(/name=['"]([^'"]+)['"]/i);
      var valM = tag.match(/value=['"]([^'"]*)['"](?=[^>]*>|\s*\/>)/i) || tag.match(/value=['"]([^'"]*)['"]/);
      if (!nameM || !valM) continue;
      var attrName = nameM[1].toUpperCase();
      if (attrName === 'FU') fu = valM[1];
      if (attrName === 'FN') fn = valM[1].replace(/&#\d+;/g, function(e) { return String.fromCharCode(parseInt(e.slice(2))); }).replace(/&amp;/g, '&');
    }

    if (!fu) continue;

    // Get context for quality/lang/size detection
    var formCtx = html.slice(Math.max(0, fm.index - 600), Math.min(html.length, fm.index + fm[0].length + 200));
    var qualityM = formCtx.match(/(4K UHD|4K|2160p|1080p|720p|480p|WEB-DL|WEBRip|BluRay|HDRip|HEVC)/i);
    var quality = qualityM ? qualityM[1].toUpperCase() : '1080P';
    var langM = formCtx.match(/\b(Hindi|English|Tamil|Telugu|Bengali|Korean|Japanese|Malayalam|Kannada|Dual Audio)\b/i);
    var lang = langM ? langM[1] : '';
    var sizeM = formCtx.match(/(\d+(?:\.\d+)?\s*(?:MB|GB))/i);
    var size = sizeM ? sizeM[1] : '';
    var hostM = formCtx.match(/\b(GDrive|Google Drive|GDRive|Hubcloud|Savelinks|Filepress|GDFlix)\b/i);
    var host = hostM ? hostM[1] : 'Fojik';

    downloads.push({
      label: [quality, lang, size].filter(Boolean).join(' \u2022 ') || quality,
      url: action,
      savelinks_url: action,
      action: action,
      fu: fu,
      fn: fn,
      fojikFu: fu,
      fojikFn: fn,
      quality: quality,
      lang: lang,
      size: size,
      host: host,
      isDirect: false,
      isFojikForm: true,
    });
  }

  // If no FU forms found, search for any external download links
  if (downloads.length === 0) {
    var aRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    var am;
    while ((am = aRe.exec(html)) !== null) {
      var href = am[1];
      var text = am[2].replace(/<[^>]+>/g, '').trim();
      if (/savelinks|gdflix|hubcloud|filepress|drive\.google|busycdn|indexserver|multicloud|gdtot/i.test(href) || /download/i.test(text)) {
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
