var hostLib = require('./_host.js');
var json = hostLib.json;
var UA = hostLib.UA;

export async function onRequest(context) {
  var url = new URL(context.request.url);
  var slug = (url.searchParams.get('slug') || '').trim();
  if (!slug) return json({ ok: false, error: 'Missing ?slug= param' }, 200);

  var env = context.env || {};

  // 1. Check GitHub mega-cache first
  var cacheRepo = env.SKM_CACHE_REPO || 'khadimsorder1-max/skmovies-cache';
  var safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  try {
    var ghUrl = 'https://raw.githubusercontent.com/' + cacheRepo + '/main/krx18/movie/' + safeSlug + '.json';
    var ghResp = await fetch(ghUrl);
    if (ghResp.ok) {
      var ghText = await ghResp.text();
      if (ghText.trim().startsWith('{')) {
        var ghData = JSON.parse(ghText);
        if (ghData.ok && (ghData.title || (ghData.downloads && ghData.downloads.length > 0))) {
          return json(Object.assign({}, ghData, { _cache: 'github' }), 200, 120);
        }
      }
    }
  } catch(e) {}

  // 2. Live scrape from krx18.com
  var movieUrl = `https://krx18.com/${slug.includes('/') ? slug : 'movies/' + slug}/`;

  try {
    var resp = await fetch(movieUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://krx18.com/',
      },
    });

    if (!resp.ok) return json({ ok: false, error: 'HTTP ' + resp.status }, 200);

    var html = await resp.text();
    var movie = await parseKrx18Movie(html, slug, movieUrl);

    return json(Object.assign({ ok: true, slug: slug, url: movieUrl, ts: Date.now() }, movie), 200, 120);
  } catch (e) {
    return json({ ok: false, error: e.message }, 200);
  }
}

async function parseKrx18Movie(html, slug, movieUrl) {
  var titleM = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || html.match(/<title>([^<]+)<\/title>/i);
  var title = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : slug;

  var posterM = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || html.match(/<img[^>]+src="(https?:\/\/[^"]+\.(?:webp|jpg|jpeg|png))"/i);
  var poster = posterM ? posterM[1] : '';

  var storylineM = html.match(/<div[^>]*class="[^"]*wp-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || html.match(/<p>([\s\S]*?)<\/p>/i);
  var storyline = storylineM ? storylineM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400).trim() : '';

  var yearM = html.match(/<span>(\d{4})<\/span>/i);
  var year = yearM ? yearM[1] : '';

  // Extract categories / genres
  var genres = [];
  var genreMatches = html.match(/<a[^>]+href="[^"]*\/genre\/([^"\/]+)\/?"[^>]*>([^<]+)<\/a>/gi) || [];
  for (var g = 0; g < genreMatches.length; g++) {
    var gm = genreMatches[g].match(/>([^<]+)<\/a>/i);
    if (gm && genres.indexOf(gm[1].trim()) === -1) genres.push(gm[1].trim());
  }

  // 1. Extract download links & resolve 3-4 main sources (1Fichier, Nitroflare, K2S, etc.)
  var downloads = [];
  var seenUrls = new Set();
  var linkRe = /<tr[^>]*>[\s\S]*?<a[^>]+href='([^']+)'[^>]*>([^<]+)<\/a>[\s\S]*?<\/tr>/gi;
  var lm;
  var linkEntries = [];
  while ((lm = linkRe.exec(html)) !== null) {
    var linkUrl = lm[1];
    var domainM = lm[0].match(/favicons\?domain=([^'&]+)/i);
    var host = domainM ? domainM[1].replace('.cc', '').replace('.com', '') : 'Download';
    if (!seenUrls.has(linkUrl)) {
      seenUrls.add(linkUrl);
      linkEntries.push({ linkUrl: linkUrl, host: host });
    }
  }

  // Resolve krx18 intermediate link pages to direct click-to-download URLs
  for (var i = 0; i < Math.min(linkEntries.length, 6); i++) {
    var entry = linkEntries[i];
    try {
      var resolvedUrl = await resolveKrx18Link(entry.linkUrl);
      var hostName = detectHost(resolvedUrl || entry.host);
      downloads.push({
        label: `${hostName} Direct Download`,
        url: resolvedUrl || entry.linkUrl,
        savelinks_url: resolvedUrl || entry.linkUrl,
        quality: '1080p',
        size: '',
        host: hostName,
        isDirect: true,
      });
    } catch(e) {
      downloads.push({
        label: `${entry.host} Link`,
        url: entry.linkUrl,
        savelinks_url: entry.linkUrl,
        quality: '1080p',
        size: '',
        host: entry.host,
        isDirect: false,
      });
    }
  }

  // 2. Extract streams / iframe embeds
  var streams = [];
  var iframeRe = /<iframe[^>]+src="([^"]+)"/gi;
  var im;
  while ((im = iframeRe.exec(html)) !== null) {
    if (!/facebook|twitter|youtube|telegram/i.test(im[1])) {
      streams.push({
        url: im[1],
        label: 'KRX18 Player (Direct / Sandboxed)',
        host: 'KRX18',
        isDirect: true,
      });
    }
  }

  return {
    title: title,
    poster: poster,
    year: year,
    genres: genres,
    storyline: storyline,
    downloads: downloads,
    streams: streams,
  };
}

async function resolve1FichierDirect(alterUrl) {
  if (!alterUrl || !/1fichier|alterupload/i.test(alterUrl)) return null;
  try {
    var r1 = await fetch(alterUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!r1.ok) return null;
    var html1 = await r1.text();

    if (html1.includes('You must wait') || html1.includes('Without subscription')) {
      return null;
    }

    var r2 = await fetch(alterUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': alterUrl,
      },
      body: 'dl_no_ssl=on',
      redirect: 'manual',
    });

    var loc = r2.headers.get('location');
    if (loc && /1fichier|alterupload|cdn/i.test(loc)) return loc;

    var html2 = await r2.text();
    var cdnMatch = html2.match(/href="(https?:\/\/[a-z0-9-]+\.1fichier\.com\/[^"]+)"/i) ||
                   html2.match(/https?:\/\/[a-z0-9-]+\.1fichier\.com\/[^\s"'<>]+/gi);
    return cdnMatch ? (Array.isArray(cdnMatch) ? cdnMatch[0] : cdnMatch[1]) : null;
  } catch(e) {
    return null;
  }
}

// Resolve krx18.com/links/XXXX form POST to get final 302 Location header
async function resolveKrx18Link(linkUrl) {
  if (!linkUrl.includes('krx18.com/links/')) return linkUrl;
  try {
    var r1 = await fetch(linkUrl, {
      headers: { 'User-Agent': UA, 'Referer': 'https://krx18.com/' },
    });
    if (!r1.ok) return linkUrl;
    var html = await r1.text();

    var go = (html.match(/name="doo_hidden_go"\s+value="([^"]+)"/i) || [])[1] || '1';
    var nonce = (html.match(/name="doo_hidden_nonce"\s+value="([^"]+)"/i) || [])[1];
    var issued = (html.match(/name="doo_hidden_issued"\s+value="([^"]+)"/i) || [])[1];
    var wait = (html.match(/name="doo_hidden_wait"\s+value="([^"]+)"/i) || [])[1];
    var waitToken = (html.match(/name="doo_hidden_wait_token"\s+value="([^"]+)"/i) || [])[1];

    if (!waitToken && !issued) return linkUrl;

    var bodyParams = [];
    bodyParams.push('doo_hidden_go=' + encodeURIComponent(go));
    if (nonce) bodyParams.push('doo_hidden_nonce=' + encodeURIComponent(nonce));
    if (issued) bodyParams.push('doo_hidden_issued=' + encodeURIComponent(issued));
    if (wait) bodyParams.push('doo_hidden_wait=' + encodeURIComponent(wait));
    if (waitToken) bodyParams.push('doo_hidden_wait_token=' + encodeURIComponent(waitToken));

    var r2 = await fetch(linkUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': linkUrl,
      },
      body: bodyParams.join('&'),
      redirect: 'manual',
    });

    var loc = r2.headers.get('location');
    if (loc) {
      var direct1F = await resolve1FichierDirect(loc);
      return direct1F || loc;
    }
    return linkUrl;
  } catch(e) {
    return linkUrl;
  }
}



function detectHost(url) {
  try {
    var h = new URL(url).hostname.toLowerCase();
    if (h.includes('k2s') || h.includes('keep2share') || h.includes('moneyplatform')) return 'Keep2Share';
    if (h.includes('nitroflare')) return 'Nitroflare';
    if (h.includes('1fichier') || h.includes('alterupload')) return '1Fichier';
    if (h.includes('filebee')) return 'FileBee';
    if (h.includes('vcloud')) return 'VCloud';
    if (h.includes('fastdl')) return 'FastDL';
    if (h.includes('pixeldrain')) return 'PixelDrain';
    if (h.includes('gofile')) return 'GoFile';
    return h.replace(/^www\./, '');
  } catch(e) { return 'Direct Host'; }
}
