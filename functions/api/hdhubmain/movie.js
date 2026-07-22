var hostLib = require('./_host.js');
var json = hostLib.json;
var UA = hostLib.UA;

// Resolve hdhub.boats intermediate link pages to real download links
async function resolveBoatsLinks(boatsUrl) {
  var REAL_DL_RE = /fastdl\.zip|vcloud\.zip|filebee\.xyz|gofile\.io|vikingfile\.com|megaup\.net|pixeldrain\.com|hubcdn\.sbs|hubdrive\.|gadgetsweb\.xyz|hubstream\.art|hubcloud\.|gdflix\.|filepress\.|gdtot\.|hdstream4u\.com/i;
  try {
    var r = await fetch(boatsUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' });
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

  // 1. Check GitHub mega-cache first
  var cacheRepo = (env && env.SKM_CACHE_REPO) || 'khadimsorder1-max/skmovies-cache';
  var safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  try {
    var ghUrl = 'https://raw.githubusercontent.com/' + cacheRepo + '/main/hdhubmain/movie/' + safeSlug + '.json';
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

  // 2. Live scrape from upstream with fallback domains
  var DOMAINS = ['https://new3.hdhub4u.cl', 'https://hdhub4us.ai.in', 'https://hdhub4u.skin'];
  var html = null;
  var movieUrl = '';
  for (var di = 0; di < DOMAINS.length; di++) {
    try {
      movieUrl = DOMAINS[di] + '/' + slug + '/';
      var resp = await fetch(movieUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': 'https://hdhub4u.med/',
        },
      });
      if (resp.ok) {
        var text = await resp.text();
        if (text.length > 5000 && !text.includes('cf-browser-verification')) { html = text; break; }
      }
    } catch(e) {}
  }

  if (!html) return json({ ok: false, error: 'All domains failed', fallback: true }, 200);

    var titleM = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([^<]+)<\/title>/i);
    var title = titleM ? titleM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').trim() : slug;

    var posterM = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || html.match(/<img[^>]+src="(https?:\/\/[^"]+)"/i);
    var poster = posterM ? posterM[1] : '';

    var storylineM = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    var storyline = storylineM ? storylineM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400).trim() : '';

    const KNOWN_DL_HOSTS_RE = /hubcdn\.sbs|hubdrive\.(tips|com|net)|gadgetsweb\.xyz|hubstream\.art|hubcloud\.(foo|lol|com)|gdflix\.(dev|dad|com|io)|filepress\.(baby|com)|gdtot\.(dad|com|dev)|gdlink\.dev|multidownload\.website|busycdn\.xyz|indexserver\.site|hdstream4u\.com|fastdl|driveleech|savelinks|hdhub\.boats|vcloud\.zip|filebee\.xyz|gofile\.io|vikingfile\.com|megaup\.net/i;

    const contentMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:footer|\/article|aside)/i);
    const scopedHtml = contentMatch ? contentMatch[1] : html;

    const downloadLinks = [];
    const seenUrls = new Set();
    const boatsUrls = [];
    const linkRe = /<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let lm;
    while ((lm = linkRe.exec(scopedHtml)) !== null) {
      const linkUrl = lm[1];
      const linkText = lm[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

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
      const contextStr = scopedHtml.slice(Math.max(0, idx - 300), idx + 300);
      const qMatch = contextStr.match(/\b(4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDRip|HEVC|10Bit|HQ-HDTC|HDTC|HQ-iMAX)\b/i);
      const sizeMatch = contextStr.match(/(\d+(?:\.\d+)?\s*(?:GB|MB))/i);
      const q = qMatch ? qMatch[1] : '';
      const sz = sizeMatch ? sizeMatch[1] : '';

      // Collect boats links for later resolution
      if (/hdhub\.boats/i.test(linkUrl)) {
        boatsUrls.push({ url: linkUrl, q, sz });
        continue;
      }

      let host = 'HDHub Main';
      if (/hubcdn\.sbs/i.test(linkUrl)) host = 'HubCDN';
      else if (/hubdrive\.(tips|com|net)/i.test(linkUrl)) host = 'HubDrive';
      else if (/gadgetsweb\.xyz/i.test(linkUrl)) host = 'GadgetsWeb';
      else if (/hubstream\.art/i.test(linkUrl)) host = 'HubStream';
      else if (/hubcloud\./i.test(linkUrl)) host = 'HubCloud';
      else if (/gdflix\./i.test(linkUrl)) host = 'GDFlix';
      else if (/filepress\./i.test(linkUrl)) host = 'FilePress';
      else if (/gdtot\./i.test(linkUrl)) host = 'GDTot';
      else if (/hdstream4u\.com/i.test(linkUrl)) host = 'HDStream4U';
      else if (/savelinks/i.test(linkUrl)) host = 'Savelinks';

      let label = linkText && linkText !== 'Download Now' && linkText.length > 3
        ? linkText.slice(0, 80)
        : (q ? q.toUpperCase() + (sz ? ` (${sz})` : '') : `${host} Link`);

      downloadLinks.push({
        label,
        url: linkUrl,
        savelinks_url: linkUrl,
        quality: q,
        size: sz,
        host,
        isDirect: true,
      });
    }

    // Resolve hdhub.boats intermediate pages
    for (var bi = 0; bi < Math.min(boatsUrls.length, 8); bi++) {
      var bEntry = boatsUrls[bi];
      try {
        var realLinks = await resolveBoatsLinks(bEntry.url);
        if (realLinks.length === 0) {
          downloadLinks.push({ label: bEntry.q ? bEntry.q.toUpperCase() + (bEntry.sz ? ' (' + bEntry.sz + ')' : '') : 'Download', url: bEntry.url, savelinks_url: bEntry.url, quality: bEntry.q, size: bEntry.sz, host: 'HDHub', isDirect: false });
        }
        for (var ri = 0; ri < realLinks.length; ri++) {
          var rl = realLinks[ri];
          if (seenUrls.has(rl)) continue;
          seenUrls.add(rl);
          var rHost = 'Direct';
          if (/fastdl/i.test(rl)) rHost = 'FastDL';
          else if (/vcloud/i.test(rl)) rHost = 'VCloud';
          else if (/filebee/i.test(rl)) rHost = 'FileBee';
          else if (/gofile/i.test(rl)) rHost = 'GoFile';
          else if (/vikingfile/i.test(rl)) rHost = 'VikingFile';
          else if (/megaup/i.test(rl)) rHost = 'MegaUp';
          downloadLinks.push({ label: bEntry.q ? bEntry.q.toUpperCase() + ' Direct' : 'Direct Download', url: rl, savelinks_url: rl, quality: bEntry.q, size: bEntry.sz, host: rHost, isDirect: true });
        }
      } catch(e) {
        downloadLinks.push({ label: bEntry.q || 'Download', url: bEntry.url, savelinks_url: bEntry.url, quality: bEntry.q, size: bEntry.sz, host: 'HDHub', isDirect: false });
      }
    }

    const streams = [];
    const iframeRegex = /<iframe[^>]+src="(https?:\/\/(?:hubstream\.art|new3\.hdhub4u\.cl)[^"]+)"/gi;
    let im;
    while ((im = iframeRegex.exec(scopedHtml)) !== null) {
      streams.push({
        url: im[1],
        label: 'HDHub Stream'
      });
    }

    return json({
      ok: true,
      slug: slug,
      url: movieUrl,
      title: title,
      poster: poster,
      storyline: storyline,
      downloads: downloadLinks,
      streams: streams,
      ts: Date.now()
    }, 200, 120);
  } catch (e) {
    return json({ ok: false, error: e.message }, 200);
  }
}
