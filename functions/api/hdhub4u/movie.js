var hostLib = require('./_host.js');
var resolveLiveHost = hostLib.resolveLiveHost;
var fetchUpstream = hostLib.fetchUpstream;
var json = hostLib.json;

// Resolve hdhub.boats intermediate link pages to get real download links
async function resolveBoatsLinks(boatsUrl) {
  var REAL_DL_RE = /fastdl\.zip|vcloud\.zip|filebee\.xyz|gofile\.io|vikingfile\.com|megaup\.net|pixeldrain\.com|hubcdn\.sbs|hubdrive\.|gadgetsweb\.xyz|hubstream\.art|hubcloud\.|gdflix\.|filepress\.|gdtot\.|hdstream4u\.com/i;
  try {
    var r = await fetch(boatsUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, redirect: 'follow' });
    if (!r.ok) return [];
    var html = await r.text();
    var links = [];
    var re = /href="(https?:\/\/[^"]+)"/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      if (REAL_DL_RE.test(m[1])) links.push(m[1]);
    }
    return links;
  } catch(e) { return []; }
}

export async function onRequest(context) {
  var url = new URL(context.request.url);
  var slug = (url.searchParams.get('slug') || '').trim();
  if (!slug) return json({ ok: false, error: 'Missing ?slug= param' }, 200);

  var env = context.env || {};
  var waitUntil = context.waitUntil ? context.waitUntil.bind(context) : null;

  // 1. Check GitHub mega-cache first
  var cacheRepo = env.SKM_CACHE_REPO || 'khadimsorder1-max/skmovies-cache';
  var safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  try {
    var ghUrl = 'https://raw.githubusercontent.com/' + cacheRepo + '/main/hdhub4u/movie/' + safeSlug + '.json';
    var ghResp = await fetch(ghUrl);
    if (ghResp.ok) {
      var ghText = await ghResp.text();
      if (ghText.trim().startsWith('{')) {
        var ghData = JSON.parse(ghText);
        if (ghData.ok && ghData.downloads && ghData.downloads.length > 0) {
          return json(Object.assign({}, ghData, { _cache: 'github', ts: ghData.ts || Date.now() }), 200, 120);
        }
      }
    }
  } catch(e) {}

  // 2. Live scrape from upstream
  try {
    var host = await resolveLiveHost(env, waitUntil);
    var upstreamUrl = host.replace(/\/$/, '') + '/' + slug + '/';
    var resp = await fetchUpstream(upstreamUrl);
    if (resp.status === 404) return json({ ok: false, error: 'Movie not found' }, 200);
    if (!resp.ok) return json({ ok: false, error: 'Upstream HTTP ' + resp.status, upstreamStatus: resp.status }, 200);

    var html = await resp.text();
    var movie = await parseMovie(html, slug, upstreamUrl, host);
    return json({ ok: true, host: host, slug: movie.slug, url: movie.url, title: movie.title, poster: movie.poster, year: movie.year, genres: movie.genres, language: movie.language, qualities: movie.qualities, imdbId: movie.imdbId, imdbUrl: movie.imdbUrl, imdbRating: movie.imdbRating, director: movie.director, stars: movie.stars, storyline: movie.storyline, review: movie.review, screenshots: movie.screenshots, trailer: movie.trailer, downloads: movie.downloads, streams: movie.streams, ts: Date.now() }, 200, 120);
  } catch (e) {
    return json({ ok: false, error: e.message }, 200);
  }
}

async function parseMovie(html, slug, url, host) {
  var title = decodeEntities(
    (html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) || [])[1] ||
    (html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
    (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || ''
  ).replace(/\s+/g, ' ').trim();

  var poster = (html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || [])[1] || '';

  var entryContent = (html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
  var storyline = decodeEntities(
    (entryContent.match(/<p>([\s\S]*?)<\/p>/i) || [])[1] || ''
  ).replace(/\s+/g, ' ').trim();

  var yearMatch = title.match(/\((\d{4})\)/);
  var year = yearMatch ? yearMatch[1] : '';
  var qualities = [];
  var qMatches = title.match(/\b(4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDRip|WEBRip|HEVC|10Bit)\b/gi);
  if (qMatches) {
    qualities = qMatches.map(function(x) { return x.toLowerCase(); }).filter(function(v, i, a) { return a.indexOf(v) === i; });
  }
  var langMatch = title.match(/\b(Hindi|English|Tamil|Telugu|Bengali|Dual Audio|Multi Audio|Korean|Chinese|Japanese)\b/i);
  var language = langMatch ? langMatch[1] : '';

  var genres = [];
  var genreMatches = html.match(/<a[^>]+href="[^"]*\/category\/([^"\/]+)\/?"[^>]*>([^<]+)<\/a>/gi) || [];
  for (var g = 0; g < genreMatches.length; g++) {
    var gm = genreMatches[g].match(/>([^<]+)<\/a>/i);
    if (gm) {
      var gn = decodeEntities(gm[1]).trim();
      if (!/movies|web-series|tv-series/i.test(gn)) genres.push(gn);
    }
  }

  var imdbUrl = (html.match(/https?:\/\/www\.imdb\.com\/title\/(tt\d+)/i) || [])[0] || '';
  var imdbId = (imdbUrl.match(/tt\d+/) || [])[0] || '';
  var imdbRating = (html.match(/IMDb[:\s]+([\d.]+)\s*\/\s*10/i) || [])[1] || '';

  var director = decodeEntities((html.match(/Director[:\s]*<\/strong>\s*([^<\n]+)/i) || [])[1] || '').trim();
  var starsRaw = (html.match(/(?:Stars|Cast)[:\s]*<\/strong>\s*([\s\S]*?)(?:<\/p>|<br)/i) || [])[1] || '';
  var stars = decodeEntities(starsRaw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  var trailer = (html.match(/https?:\/\/(?:www\.)?youtube\.com\/embed\/([\w-]+)/i) || [])[0] || '';

  var screenshots = [];
  var ssMatches = html.match(/<img[^>]+src="([^"]+(?:screenshot|imgnest|pixxxels|catimage)[^"]*)"/gi) || [];
  for (var s = 0; s < ssMatches.length; s++) {
    var ssm = ssMatches[s].match(/src="([^"]+)"/i);
    if (ssm && screenshots.indexOf(ssm[1]) === -1) screenshots.push(ssm[1]);
  }

  const KNOWN_DL_HOSTS_RE = /hubcdn\.sbs|hubdrive\.(tips|com|net)|gadgetsweb\.xyz|hubstream\.art|hubcloud\.(foo|lol|com)|gdflix\.(dev|dad|com|io)|filepress\.(baby|com)|gdtot\.(dad|com|dev)|gdlink\.dev|multidownload\.website|busycdn\.xyz|indexserver\.site|hdstream4u\.com|fastdl|driveleech|savelinks|hdhub\.boats|vcloud\.zip|filebee\.xyz|gofile\.io|vikingfile\.com|megaup\.net/i;

  const contentMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:footer|\/article|aside)/i);
  const scopedHtml = contentMatch ? contentMatch[1] : html;

  const downloads = [];
  const seenUrls = new Set();
  const boatsUrls = []; // hdhub.boats intermediate pages to resolve
  const linkRegex = /<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let lm;
  while ((lm = linkRegex.exec(scopedHtml)) !== null) {
    const linkUrl = lm[1];
    const linkText = decodeEntities(lm[2]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    if (/facebook|twitter|telegram|whatsapp|reddit|t\.me|share|how-to-download|gmpg\.org|category|tag\/|author\/|#respond|wp-content|wp-includes/i.test(linkUrl)) continue;

    if (/hdhub4u\.(cl|ag|download|kim|lol|com|tours|yachts|skin|tv|cat)/i.test(linkUrl) ||
        /hdhub4us\.ai\.in/i.test(linkUrl)) {
      const linkSlug = linkUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/\/$/, '').split(/[?#]/)[0];
      if (linkSlug !== slug && !linkSlug.startsWith(slug)) {
        continue;
      }
    }

    if (!KNOWN_DL_HOSTS_RE.test(linkUrl)) {
      if (!/download\s*link|direct\s*download|download\s*now/i.test(linkText)) continue;
    }

    if (seenUrls.has(linkUrl)) continue;
    seenUrls.add(linkUrl);

    const idx = lm.index;
    const context = scopedHtml.slice(Math.max(0, idx - 300), idx + 300);
    const qMatch = context.match(/\b(4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDRip|HEVC|10Bit|HQ-HDTC|HDTC)\b/i);
    const sizeMatch = context.match(/(\d+(?:\.\d+)?\s*(?:GB|MB))/i);
    const q = qMatch ? qMatch[1] : '';
    const sz = sizeMatch ? sizeMatch[1] : '';

    // Collect hdhub.boats links separately for later resolution
    if (/hdhub\.boats/i.test(linkUrl)) {
      boatsUrls.push({ url: linkUrl, q, sz });
      continue;
    }

    downloads.push({
      label: (linkText && linkText !== 'Download Now' && linkText.length > 3 ? linkText.slice(0, 80) : (q ? q.toUpperCase() + (sz ? ` (${sz})` : '') : 'Download')),
      url: linkUrl,
      savelinks_url: linkUrl,
      quality: q,
      size: sz,
      host: detectHost(linkUrl),
      isDirect: true,
    });
  }

  // Resolve hdhub.boats intermediate pages to real file links
  for (var bi = 0; bi < Math.min(boatsUrls.length, 8); bi++) {
    var bEntry = boatsUrls[bi];
    try {
      var realLinks = await resolveBoatsLinks(bEntry.url);
      if (realLinks.length === 0) {
        // Keep boats link as fallback if no real links found
        downloads.push({ label: bEntry.q ? bEntry.q.toUpperCase() + (bEntry.sz ? ' (' + bEntry.sz + ')' : '') : 'Download', url: bEntry.url, savelinks_url: bEntry.url, quality: bEntry.q, size: bEntry.sz, host: 'HDHub', isDirect: false });
      }
      for (var ri = 0; ri < realLinks.length; ri++) {
        var rl = realLinks[ri];
        if (seenUrls.has(rl)) continue;
        seenUrls.add(rl);
        downloads.push({ label: bEntry.q ? bEntry.q.toUpperCase() + ' Direct' : 'Direct Download', url: rl, savelinks_url: rl, quality: bEntry.q, size: bEntry.sz, host: detectHost(rl), isDirect: true });
      }
    } catch(e) {
      downloads.push({ label: bEntry.q || 'Download', url: bEntry.url, savelinks_url: bEntry.url, quality: bEntry.q, size: bEntry.sz, host: 'HDHub', isDirect: false });
    }
  }

  const streams = [];
  const seenStreamUrls = new Set();

  // 1. Extract WATCH & PLAYER-2 links from page HTML
  const streamLinkRe = /<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let sm;
  while ((sm = streamLinkRe.exec(scopedHtml)) !== null) {
    const sUrl = sm[1];
    const sText = sm[2].replace(/<[^>]+>/g, '').trim().toUpperCase();
    if (/hdstream4u\.com|morencius\.com|hubstream\.art/i.test(sUrl) || /WATCH|PLAYER-2|STREAM|ONLINE/i.test(sText)) {
      if (!seenStreamUrls.has(sUrl) && !/facebook|twitter|telegram|whatsapp/i.test(sUrl)) {
        seenStreamUrls.add(sUrl);
        let label = sText || 'Watch Stream';
        if (/hdstream4u|morencius/i.test(sUrl) || sText === 'WATCH') label = 'Watch Player 1 (HDStream / Direct HLS)';
        else if (/hubstream/i.test(sUrl) || sText === 'PLAYER-2') label = 'Watch Player 2 (HubStream)';
        
        streams.push({
          label: label,
          url: sUrl,
          host: /hdstream|morencius/i.test(sUrl) ? 'HDStream' : (/hubstream/i.test(sUrl) ? 'HubStream' : 'Stream')
        });
      }
    }
  }

  // 2. Extract iframe players
  const iframeRegex = /<iframe[^>]+src="(https?:\/\/[^"]+)"/gi;
  let im2;
  while ((im2 = iframeRegex.exec(scopedHtml)) !== null) {
    const iUrl = im2[1];
    if (!seenStreamUrls.has(iUrl) && !/youtube|facebook|twitter|slider/i.test(iUrl)) {
      seenStreamUrls.add(iUrl);
      streams.push({
        url: iUrl,
        label: /hubstream/i.test(iUrl) ? 'Watch Player 2 (HubStream)' : 'HDHub Stream Player',
        host: 'Embed'
      });
    }
  }


  return {
    slug: slug, url: url, title: title, poster: poster, year: year,
    genres: genres, language: language, qualities: qualities,
    imdbId: imdbId, imdbUrl: imdbUrl, imdbRating: imdbRating,
    director: director, stars: stars, storyline: storyline,
    review: '',
    screenshots: screenshots, trailer: trailer,
    downloads: downloads,
    streams: streams,
  };
}

function detectHost(url) {
  try {
    var h = new URL(url).hostname.toLowerCase();
    if (h.indexOf('gadgetsweb') !== -1) return 'GadgetsWeb';
    if (h.indexOf('4khdhub') !== -1) return '4KHDHub';
    if (h.indexOf('catimage') !== -1) return 'CatImages';
    if (h.indexOf('hubcloud') !== -1) return 'HubCloud';
    if (h.indexOf('gdflix') !== -1) return 'GDFlix';
    if (h.indexOf('filepress') !== -1) return 'FilePress';
    if (h.indexOf('multicloud') !== -1) return 'MultiCloud';
    if (h.indexOf('indexserver') !== -1) return 'IndexServer';
    if (h.indexOf('busycdn') !== -1) return 'BusyCDN';
    if (h.indexOf('hdstream4u') !== -1) return 'HDStream4U';
    if (h.indexOf('hubstream') !== -1) return 'HubStream';
    if (h.indexOf('hubdrive') !== -1) return 'HubDrive';
    return h;
  } catch (e) { return ''; }
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/&#0?34;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); });
}