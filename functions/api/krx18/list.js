var hostLib = require('./_host.js');
var json = hostLib.json;
var UA = hostLib.UA;

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
      var ghUrl = 'https://raw.githubusercontent.com/' + cacheRepo + '/main/krx18/latest' + (page > 1 ? '-' + page : '') + '.json';
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

  // 2. Live scrape from krx18.com
  var targetUrl = 'https://krx18.com/';
  if (type === 'search' && q) {
    targetUrl = page > 1 ? `https://krx18.com/page/${page}/?s=${encodeURIComponent(q)}` : `https://krx18.com/?s=${encodeURIComponent(q)}`;
  } else if (type === 'category' && catSlug) {
    targetUrl = page > 1 ? `https://krx18.com/genre/${catSlug}/page/${page}/` : `https://krx18.com/genre/${catSlug}/`;
  } else if (page > 1) {
    targetUrl = `https://krx18.com/page/${page}/`;
  }

  try {
    var resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://krx18.com/',
      },
    });

    if (!resp.ok) return json({ ok: true, page: page, items: [], hasMore: false }, 200);

    var html = await resp.text();
    var items = parseKrx18List(html);

    return json({ ok: true, page: page, items: items, hasMore: items.length >= 12 }, 200, 120);
  } catch (e) {
    return json({ ok: false, error: e.message }, 200);
  }
}

function parseKrx18List(html) {
  var items = [];
  var seen = new Set();
  var articleRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  var am;
  while ((am = articleRe.exec(html)) !== null) {
    var block = am[1];
    var urlM = block.match(/href="(https?:\/\/krx18\.com\/(?:movies|tvshows|episodes)\/[^"]+)"/i);
    var titleM = block.match(/<h3><a[^>]*>([^<]+)<\/a><\/h3>/i) || block.match(/alt="([^"]+)"/i);
    var imgM = block.match(/src="(https?:\/\/[^"]+\.(?:webp|jpg|jpeg|png)[^"]*)"/i);
    var yearM = block.match(/<span>(\d{4})<\/span>/i);

    if (urlM && titleM) {
      var pageUrl = urlM[1];
      var slug = pageUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/\/$/, '');
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        items.push({
          slug: slug,
          title: decodeEntities(titleM[1].trim()),
          poster: imgM ? imgM[1] : '',
          pageUrl: pageUrl,
          quality: 'HD',
          language: 'English Subbed',
          year: yearM ? yearM[1] : '',
          sizes: [],
        });
      }
    }
  }
  return items;
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, "'");
}
