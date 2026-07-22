var hostLib = require('./_host.js');
var json = hostLib.json;
var UA = hostLib.UA;

export async function onRequest(context) {
  var url = new URL(context.request.url);
  var catSlug = (url.searchParams.get('slug') || '').trim();
  var page = parseInt(url.searchParams.get('page') || '1', 10);

  if (!catSlug) return json({ ok: false, error: 'Missing ?slug= param' }, 200);

  var targetUrl = page > 1 ? `https://krx18.com/genre/${catSlug}/page/${page}/` : `https://krx18.com/genre/${catSlug}/`;

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
            title: titleM[1].trim(),
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

    return json({ ok: true, page: page, items: items, hasMore: items.length >= 12 }, 200, 120);
  } catch (e) {
    return json({ ok: false, error: e.message }, 200);
  }
}
