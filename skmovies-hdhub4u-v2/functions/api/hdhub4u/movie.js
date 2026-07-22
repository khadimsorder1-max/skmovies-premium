/**
 * GET /api/hdhub4u/movie?slug=<slug>
 * GET /api/hdhub4u/movie?url=<full-movie-url>
 * ------------------------------------------------
 * Fetch full details for a single movie. Hardened parser (req #4 —
 * "direct download extract e no compromise").
 *
 * Caching (req #5): movie metadata cached 24h, direct/stream URLs
 * cached 7 days separately (so when the metadata cache expires, the
 * direct URLs are still hot).
 *
 * Hardened download extraction strategies:
 *   1. <h2-h6> blocks containing <a href>  (classic WP / Dooplay)
 *   2. <div class="download-links"> blocks (HDHub4u's modern theme)
 *   3. <table> rows with download links     (older theme)
 *   4. <a class="btn-download|button dl">   (button-style)
 *   5. Generic <a> with download-host href  (last resort)
 *
 * Response shape — see buildMovieResponse() below.
 */
const {
  resolveActiveHost,
  fetchHTML,
  jsonResponse,
  decodeHTMLEntities,
  HTMLParser,
  setEnv,
  setWaitUntil,
} = require('./_lib.js');
const { TTL, cached, cacheKey } = require('./_cache.js');

/**
 * Known HDHub4u download/stream hosts. We use these to (a) classify each
 * link as a download or a stream, and (b) decide whether a link should
 * be opened directly or routed through the stream-extractor endpoint.
 */
const HOSTS = {
  // GDrive-style direct download
  hubdrive:    /^https?:\/\/(?:www\.)?hubdrive\.(?:tips|tips\/|com|net)\/(?:file\/|dl\/|download\/)?[^?\s]*/i,
  // Hub CDN — usually a direct .mp4 / .mkv
  hubcdn:      /^https?:\/\/(?:www\.)?hubcdn\.sbs\/(?:file\/|dl\/)?[^?\s]*/i,
  // Obfuscated redirector — needs an extra hop
  gadgetsweb:  /^https?:\/\/(?:www\.)?gadgetsweb\.xyz\/?\??/i,
  // Stream player (also downloadable via its own file page)
  hdstream4u:  /^https?:\/\/(?:www\.)?hdstream4u\.com\/(?:file\/|stream\/)?[^?\s]*/i,
  // Watch-online player (hash in fragment)
  hubstream:   /^https?:\/\/(?:www\.)?hubstream\.art\/?#?[^ ]+/i,
  // Additional known mirror hosts
  newtabs:     /^https?:\/\/(?:www\.)?new\d*\.hdhub4u\.[a-z]+\/(?:file|download|stream)\/?[^?\s]*/i,
  // Generic file host whitelist
  filemail:    /^https?:\/\/(?:www\.)?filemail\.com\/[^?\s]*/i,
  archive:     /^https?:\/\/(?:www\.)?archive\.org\/(?:details|download)\/[^?\s]*/i,
  // Direct file URLs (any host with .mkv/.mp4 extension)
  directfile:  /^https?:\/\/[^?\s]+\.(?:mkv|mp4|webm|avi|m3u8)(?:\?[^?\s]*)?$/i,
};

function classifyLink(url) {
  for (const [kind, re] of Object.entries(HOSTS)) {
    if (re.test(url)) return kind;
  }
  return 'other';
}

/**
 * Pull the size like [750MB], [1.2GB], ~9.6GB from a label.
 */
function extractSize(label) {
  const szM = label.match(/\[?([\d.]+\s*(?:KB|MB|GB|TB))\]?/i);
  return szM ? szM[1] : '';
}

function extractQuality(label) {
  const qlM = label.match(/\b(4K|2160p|1080p|720p|480p|360p)\b/i);
  return qlM ? qlM[1] : '';
}

function extractCodec(label) {
  const cM = label.match(/\b(HEVC|x264|x265|10Bit\s*HEVC|SDR|HDR|HDR10\+|DV|REMUX|WEB-DL|BluRay|HDRip|CAMRip|WEBRip|HDCAM|HDTC|HQ-HDTC|HQ)\b/i);
  return cM ? cM[1] : '';
}

/**
 * Build a download object from a link + label text.
 */
function buildDownload(link, labelText, blockContext = '') {
  if (!/^https?:\/\//.test(link)) return null;
  // Skip share/social/nav links.
  if (/(facebook|twitter|telegram|whatsapp|reddit|tumblr|pinterest|linkedin|vk\.com|mailto:|javascript:)/i.test(link)) return null;
  if (/\/(?:category|tag|author|page|wp-|feed|comments|sitemap)\//i.test(link)) return null;
  // Skip pure-asset links (CSS/JS/images).
  if (/\.(?:css|js|png|jpg|jpeg|gif|webp|ico|svg|woff2?|ttf)(\?|$)/i.test(link)) return null;

  const label = (labelText || blockContext || '').replace(/\s+/g, ' ').trim();
  const kind = classifyLink(link);

  // Skip non-classified links that don't have a video file extension.
  if (kind === 'other' && !/\.(?:mkv|mp4|zip|rar|m3u8|webm|avi)(\?|$)/i.test(link)) {
    // Still keep it if it's clearly a "download" labeled link to an unknown host.
    if (!/download|dl|file|stream|watch/i.test(label)) return null;
  }

  return {
    label:    label || 'Download',
    quality:  extractQuality(label + ' ' + link),
    size:     extractSize(label),
    codec:    extractCodec(label),
    url:      link,
    kind,
    isStream:   kind === 'hdstream4u' || kind === 'hubstream' || kind === 'directfile' && /\.m3u8$/i.test(link),
    isDownload: kind !== 'hdstream4u' && kind !== 'hubstream',
  };
}

/**
 * Strategy 1 — heading blocks containing links.
 * Pattern: <h3>…<a href="...">480p [750MB]</a>…</h3>
 */
function extractFromHeadings(html) {
  const out = [];
  const dlRe = /<(?:h[2-6]|strong|em|p)[^>]*>([\s\S]*?)<\/(?:h[2-6]|strong|em|p)>/gi;
  let dlm;
  while ((dlm = dlRe.exec(html)) !== null) {
    const block = dlm[1];
    const aRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = aRe.exec(block)) !== null) {
      const link = am[1];
      const text = HTMLParser.stripTags(am[2]);
      const d = buildDownload(link, text, block);
      if (d) out.push(d);
    }
  }
  return out;
}

/**
 * Strategy 2 — <div class="download-links"> blocks.
 * HDHub4u's modern theme wraps each quality section in a div.
 */
function extractFromDownloadDivs(html) {
  const out = [];
  const divRe = /<div[^>]*class=["'][^"']*\b(?:download-links|dl-links|download-area|movie-download|dl-area|hd-download|download-btn-wrap|dl-btn-wrap|file-list)\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  let dm;
  while ((dm = divRe.exec(html)) !== null) {
    const block = dm[1];
    // Sub-section heading may carry the quality label.
    const headingM = block.match(/<(?:h[2-6]|strong|span|p)[^>]*>([\s\S]*?)<\/(?:h[2-6]|strong|span|p)>/i);
    const heading = headingM ? HTMLParser.stripTags(headingM[1]) : '';
    const aRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = aRe.exec(block)) !== null) {
      const link = am[1];
      const text = HTMLParser.stripTags(am[2]);
      const d = buildDownload(link, text + ' ' + heading, block);
      if (d) out.push(d);
    }
  }
  return out;
}

/**
 * Strategy 3 — table rows with download links.
 */
function extractFromTables(html) {
  const out = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tm;
  while ((tm = trRe.exec(html)) !== null) {
    const row = tm[1];
    const aM = row.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!aM) continue;
    const link = aM[1];
    const text = HTMLParser.stripTags(row);
    const d = buildDownload(link, text, row);
    if (d) out.push(d);
  }
  return out;
}

/**
 * Strategy 4 — <a class="btn-download|btn dl|download-btn"> buttons.
 */
function extractFromButtons(html) {
  const out = [];
  const btnRe = /<a[^>]+class=["'][^"']*\b(?:btn-download|btn-dl|download-btn|dl-btn|btn\s+dl|button\s+dl|download-button|btn\s+download|btn\s+btn-warning|btn\s+btn-success)\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let bm;
  while ((bm = btnRe.exec(html)) !== null) {
    const link = bm[1];
    const text = HTMLParser.stripTags(bm[2]);
    // Pull surrounding context for quality/size info.
    const ctx = html.slice(Math.max(0, bm.index - 200), bm.index + bm[0].length + 200);
    const d = buildDownload(link, text + ' ' + HTMLParser.stripTags(ctx), ctx);
    if (d) out.push(d);
  }
  // Also reverse pattern: href first, then class.
  const btnRe2 = /<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*\b(?:btn-download|btn-dl|download-btn|dl-btn|btn\s+dl|button\s+dl|download-button|btn\s+download|btn\s+btn-warning|btn\s+btn-success)\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let bm2;
  while ((bm2 = btnRe2.exec(html)) !== null) {
    const link = bm2[1];
    const text = HTMLParser.stripTags(bm2[2]);
    const d = buildDownload(link, text, html.slice(Math.max(0, bm2.index - 200), bm2.index + bm2[0].length + 200));
    if (d && !out.find((x) => x.url === d.url)) out.push(d);
  }
  return out;
}

/**
 * Strategy 5 — generic <a href> with download-host href.
 */
function extractGenericLinks(html) {
  const out = [];
  const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let lm;
  while ((lm = linkRe.exec(html)) !== null) {
    const link = lm[1];
    const text = HTMLParser.stripTags(lm[2]);
    const kind = classifyLink(link);
    if (kind === 'other') continue;
    const d = buildDownload(link, text, html.slice(Math.max(0, lm.index - 200), lm.index + lm[0].length + 200));
    if (d) out.push(d);
  }
  return out;
}

/**
 * Run all download-extraction strategies, merge results, dedupe by URL.
 * Priority order: headings > download divs > tables > buttons > generic.
 */
function extractAllDownloads(html) {
  const all = [
    ...extractFromHeadings(html),
    ...extractFromDownloadDivs(html),
    ...extractFromTables(html),
    ...extractFromButtons(html),
    ...extractGenericLinks(html),
  ];

  // Dedupe by URL — keep the entry that has the most metadata filled in.
  const byUrl = new Map();
  for (const d of all) {
    const existing = byUrl.get(d.url);
    if (!existing) {
      byUrl.set(d.url, d);
    } else {
      // Merge fields — prefer non-empty values.
      const merged = { ...existing };
      merged.label   = merged.label   || d.label;
      merged.quality = merged.quality || d.quality;
      merged.size    = merged.size    || d.size;
      merged.codec   = merged.codec   || d.codec;
      byUrl.set(d.url, merged);
    }
  }
  return Array.from(byUrl.values());
}

/**
 * Parse a movie detail page into a structured object.
 */
function parseMoviePage(html, movieUrl, host) {
  const p = new HTMLParser(html);

  // Title
  let title = p.getOG('title') || p.getTitle() || '';
  title = title.replace(/\s*\|\s*HDHub4u.*$/i, '').replace(/\s*\|\s*Full Movie.*$/i, '');

  // Slug + canonical URL
  let slug = '';
  let canonical = p.getOG('url') || movieUrl || '';
  if (canonical) {
    slug = canonical.replace(/\/$/, '').split('/').pop();
  } else if (movieUrl) {
    slug = movieUrl.replace(/\/$/, '').split('/').pop();
  }

  // Poster
  let poster = p.getOG('image') || '';

  // Description
  const description = p.getMeta('description') || p.getOG('description') || '';

  // Body content
  let body = '';
  const bodyM = html.match(
    /<div[^>]*class=["'][^"]*(?:entry-content|movie-description|description|post-content|movie-content|content-area)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  );
  if (bodyM) body = bodyM[1];
  if (!body) {
    const fallbackM = html.match(/DOWNLOAD LINKS[\s\S]*?(?:<div[^>]*id=["']comments|<!--.*?comments.*?-->)/i);
    if (fallbackM) body = fallbackM[0];
  }

  // Storyline / Plot
  let storyline = '';
  const storyM = body.match(
    /(?:Storyline|Story Line|Story\s*:|Plot\s*:)[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
  );
  if (storyM) storyline = HTMLParser.stripTags(storyM[1]);
  if (!storyline && description) storyline = description;

  // Review
  let review = '';
  const reviewM = body.match(
    /(?:Review|Review\s*:)[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
  );
  if (reviewM) review = HTMLParser.stripTags(reviewM[1]);

  // Genres
  const genres = [];
  const gRe = /<a[^>]+href=["'][^"']*\/category\/([^/"']+)\/?["'][^>]*>([\s\S]*?)<\/a>/gi;
  let gm;
  while ((gm = gRe.exec(html)) !== null) {
    const g = HTMLParser.stripTags(gm[2]);
    if (g && !genres.includes(g)) genres.push(g);
  }
  const gtM = html.match(/Genre\s*:\s*([^<\n]+)/i);
  if (gtM && genres.length === 0) {
    gtM[1].split(/\||,|&/).forEach((x) => {
      const g = x.trim();
      if (g) genres.push(g);
    });
  }

  // IMDB rating
  let imdbRating = '';
  const imdbM = html.match(/iMDB\s*Rating\s*:\s*([\d.]+)\s*\/\s*10/i);
  if (imdbM) imdbRating = imdbM[1];

  // IMDB ID + URL
  let imdbUrl = '';
  let imdbId = '';
  const imdbLinkM = html.match(/https?:\/\/(?:www\.)?imdb\.com\/title\/(tt\d+)/i);
  if (imdbLinkM) {
    imdbUrl = imdbLinkM[0];
    imdbId = imdbLinkM[1];
  }

  // Release year
  let year = '';
  const ym = (title + ' ' + slug).match(/\b(19\d{2}|20\d{2})\b/);
  if (ym) year = ym[1];

  // Stars / cast
  let stars = '';
  const starsM = html.match(/Stars\s*:\s*([^<\n]+)/i);
  if (starsM) stars = starsM[1].trim();

  // Director
  let director = '';
  const dirM = html.match(/Director\s*:\s*([^<\n]+)/i);
  if (dirM) director = dirM[1].trim();

  // Language
  let language = '';
  const langM = html.match(/Language\s*:\s*([^<\n]+)/i);
  if (langM) language = langM[1].trim();

  // Quality list
  const qualities = [];
  const qRe = /\b(4K|2160p|1080p\s*(?:HEVC|10Bit\s*HEVC|x264)?|720p\s*(?:HEVC|10Bit\s*HEVC|x264)?|480p)\b(?:\s*\[([^\]]+)\])?/gi;
  let qm;
  while ((qm = qRe.exec(html)) !== null) {
    const q = qm[1].trim();
    const size = (qm[2] || '').trim();
    if (!qualities.find((x) => x.label === q)) {
      qualities.push({ label: q, size });
    }
  }

  // Screenshots — multiple patterns for robustness (req #4)
  const screenshots = [];
  const ssRe = /https?:\/\/(?:catimages\.(?:co|org|net|io)\/image\/\w+|i\.(?:ibb|imgur)\.co[^"'\s]+|image\.tmdb\.org[^"'\s]+|s\d+\.postimg\.(?:cc|org)\/[^"'\s]+|catimage\.[a-z]+\/[^"'\s]+|prntscr\.com\/[^"'\s]+|drive\.google\.com\/file\/d\/[^"'\s]+\/view[^"'\s]*|live\.staticflickr\.com\/[^"'\s]+|fastimage\.xyz\/[^"'\s]+|pixxxels\.cc\/[^"'\s]+|image\.pixxxels\.cc\/[^"'\s]+|image\.beeimg\.com\/[^"'\s]+|imgsxx\.sparklarge\.com\/[^"'\s]+|i\.iliad\.io\/[^"'\s]+)/gi;
  let ssm;
  while ((ssm = ssRe.exec(html)) !== null) {
    if (!screenshots.includes(ssm[0])) screenshots.push(ssm[0]);
  }
  // Also pick up screenshots in <a href> wrapping <img> (lightbox pattern).
  const lightboxRe = /<a[^>]+href=["'](https?:\/\/[^"'\s]+\.(?:png|jpe?g|webp))["'][^>]*>\s*<img[\s\S]*?<\/a>/gi;
  let lbm;
  while ((lbm = lightboxRe.exec(html)) !== null) {
    if (!screenshots.includes(lbm[1])) screenshots.push(lbm[1]);
  }
  // And <a data-caption> + href pairs.
  const dataCapRe = /<a[^>]+href=["'](https?:\/\/[^"'\s]+\.(?:png|jpe?g|webp))["'][^>]*data-[a-z]*caption=/gi;
  while ((lbm = dataCapRe.exec(html)) !== null) {
    if (!screenshots.includes(lbm[1])) screenshots.push(lbm[1]);
  }

  // Trailer (YouTube embed)
  let trailer = '';
  const ytM = html.match(/https?:\/\/(?:www\.)?youtube\.com\/embed\/([\w-]+)/i);
  if (ytM) trailer = 'https://www.youtube.com/embed/' + ytM[1];
  const ytShortM = html.match(/https?:\/\/youtu\.be\/([\w-]+)/i);
  if (!trailer && ytShortM) trailer = 'https://www.youtube.com/embed/' + ytShortM[1];

  // -------- Download links (hardened multi-strategy) --------
  const downloads = extractAllDownloads(html);

  // -------- Stream players --------
  const streams = downloads
    .filter((d) => d.isStream)
    .map((d, i) => ({
      player: i === 0 ? 'Player 1' : 'Player ' + (i + 1),
      kind: d.kind,
      url: d.url,
      label: d.label,
    }));

  // Make sure we always have at least the two standard players even if
  // they weren't auto-detected (some movie pages link to them from
  // outside the main content area).
  const hubStreamUrl  = (html.match(/https?:\/\/(?:www\.)?hubstream\.art\/?#?\w+[^"'\s]*/i) || [])[0];
  const hdStream4uUrl = (html.match(/https?:\/\/(?:www\.)?hdstream4u\.com\/(?:file|stream)\/[^"'\s]+/i) || [])[0];
  if (hubStreamUrl && !streams.find((s) => s.url === hubStreamUrl)) {
    streams.push({ player: 'Player ' + (streams.length + 1), kind: 'hubstream', url: hubStreamUrl, label: 'Hubstream' });
  }
  if (hdStream4uUrl && !streams.find((s) => s.url === hdStream4uUrl)) {
    streams.push({ player: 'Player ' + (streams.length + 1), kind: 'hdstream4u', url: hdStream4uUrl, label: 'HDStream4u' });
  }

  return {
    title,
    slug,
    url: canonical || movieUrl,
    host,
    poster,
    year,
    genres,
    language,
    qualities,
    imdbId,
    imdbUrl,
    imdbRating,
    director,
    stars,
    storyline,
    review,
    screenshots,
    trailer,
    downloads,
    streams,
    ts: Date.now(),
  };
}

export async function onRequestGet(ctx) {
  setEnv(ctx.env || {});
  if (ctx.waitUntil) setWaitUntil(ctx.waitUntil.bind(ctx));

  try {
    const host = await resolveActiveHost();
    const url = new URL(ctx.request.url);
    let slug = (url.searchParams.get('slug') || '').trim();
    let movieUrl = (url.searchParams.get('url') || '').trim();

    if (!slug && !movieUrl) {
      return jsonResponse(
        { error: 'Provide either ?slug=<slug> or ?url=<full-movie-url>' },
        400
      );
    }

    if (!movieUrl) {
      movieUrl = new URL('/' + slug + '/', host).href;
    }

    const key = cacheKey('movie', slug || movieUrl);

    const { value: movie, fromCache } = await cached(key, async () => {
      const html = await fetchHTML(movieUrl, { referer: host });
      return parseMoviePage(html, movieUrl, host);
    }, TTL.MOVIE);

    // Always re-stamp host + ts so the UI shows the live mirror.
    movie.host = host;
    movie.ts = Date.now();
    movie._cache = fromCache;
    return jsonResponse(movie);
  } catch (e) {
    return jsonResponse(
      { error: 'Failed to fetch movie', message: String(e && e.message || e) },
      502
    );
  }
}

// Internals are not exported (Pages Functions mixes CJS require with ESM
// export — only one default export shape per file). Other endpoints
// that need download extraction should call the /movie endpoint and
// read .downloads from the JSON response.
