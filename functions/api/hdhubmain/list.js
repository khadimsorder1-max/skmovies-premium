var hostLib = require('./_host.js');
var json = hostLib.json;
var UA = hostLib.UA;

export async function onRequest(context) {
  var url = new URL(context.request.url);
  var type = url.searchParams.get('type') || 'home';
  var page = parseInt(url.searchParams.get('page') || '1', 10);
  var q = (url.searchParams.get('q') || '').trim();
  var catSlug = (url.searchParams.get('slug') || '').trim();

  var targetUrl = 'https://new3.hdhub4u.cl/?utm=mn1';
  if (type === 'search' && q) {
    targetUrl = page > 1 ? `https://new3.hdhub4u.cl/page/${page}/?s=${encodeURIComponent(q)}` : `https://new3.hdhub4u.cl/?s=${encodeURIComponent(q)}`;
  } else if (type === 'category' && catSlug) {
    targetUrl = page > 1 ? `https://new3.hdhub4u.cl/category/${catSlug}/page/${page}/` : `https://new3.hdhub4u.cl/category/${catSlug}/`;
  } else if (page > 1) {
    targetUrl = `https://new3.hdhub4u.cl/page/${page}/?utm=mn1`;
  }

  if (type === 'home' && context.env && context.env.SKMOVIES_KV) {
    try {
      var kvData = await context.env.SKMOVIES_KV.get(`hdhubmain_home_${page}`);
      if (kvData) {
        return json(JSON.parse(kvData));
      }
    } catch (e) {
      console.warn("KV fetch failed", e);
    }
  }

  try {
    var resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://hdhub4u.med/',
      },
    });

    if (!resp.ok) {
      // If CF block happens, just return empty list gracefully for now
      return json({ ok: true, page: page, items: [], hasMore: false }, 200);
    }

    var html = await resp.text();
    var liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    var items = [];
    var lm;
    while ((lm = liRe.exec(html)) !== null) {
      var block = lm[1];
      var aM = block.match(/href="(https:\/\/new3\.hdhub4u\.cl\/[^"]+)"/i);
      var pM = block.match(/<p>([\s\S]*?)<\/p>/i);
      var imgM = block.match(/src="([^"]+)"/i) || block.match(/data-src="([^"]+)"/i);

      if (aM && pM) {
        var pageUrl = aM[1];
        var title = pM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').trim();
        var poster = imgM ? imgM[1] : '';
        var rawSlug = pageUrl.replace('https://new3.hdhub4u.cl/', '').replace(/\/$/, '');

        if (!/how-to-download|category|tag|author/i.test(rawSlug)) {
          items.push({
            slug: rawSlug,
            title: title,
            poster: poster,
            pageUrl: pageUrl,
            quality: 'HD',
            language: 'Hindi Dubbed',
            year: '',
            sizes: [],
          });
        }
      }
    }

    return json({ ok: true, page: page, items: items, hasMore: items.length >= 20 }, 200, 60);
  } catch (e) {
    return json({ ok: false, error: e.message }, 200);
  }
}
