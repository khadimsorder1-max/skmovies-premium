// functions/api/fdm/movie.js
// Scrapes a freedrivemovie.cyou movie OR tvshow page.
// Returns: { ok, slug, title, poster, info, downloads: [...], sections: [...] }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

function extractDownloads(html) {
  const downloads = [];

  // Pattern 1: structured table rows (movie layout)
  //   <tr id='link-130963'>
  //     <td><a href=".../links/enzqx8ntfu/">Download</a></td>
  //     <td>4K</td> <td>Dual Audio(Hin-Telugu)</td> <td>30Gb</td> <td>824</td> <td>1 year</td>
  //   </tr>
  const rowRe = /<tr[^>]*id=['"]link-(\d+)['"][^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const id = m[1];
    const rowHtml = m[2];
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1]);
    if (cells.length < 4) continue;
    const linkMatch = rowHtml.match(/href=["'](https?:\/\/freedrivemovie\.cyou\/links\/[^"']+)["']/i);
    if (!linkMatch) continue;
    const url = linkMatch[1];
    // Strip tags from cells
    const clean = cells.map(c => c.replace(/<[^>]+>/g, '').trim());
    downloads.push({
      id,
      url,
      savelinks_url: url,
      quality:  clean[1] || '',
      language: clean[2] || '',
      size:     clean[3] || '',
      host:     extractHostFromLabel(clean[1] + ' ' + clean[3]),
    });
  }
  if (downloads.length) return downloads;

  // Pattern 2: TV-show episode layout — episodes grouped under <h3>Episode N</h3>
  //   <div class="episode"><h3>Episode 97</h3> … <a href=".../links/xxx/">Download</a> …</div>
  // Simpler approach: find every /links/ URL on the page and pair it with the closest preceding heading text.
  const tokens = [];
  const headRe = /<(h[2-4])[^>]*>([\s\S]*?)<\/\1>/gi;
  let h;
  while ((h = headRe.exec(html)) !== null) {
    tokens.push({ type: 'head', text: h[2].replace(/<[^>]+>/g, '').trim(), pos: h.index });
  }
  const lRe = /href=["'](https?:\/\/freedrivemovie\.cyou\/links\/[^"']+)["']/gi;
  let l;
  while ((l = lRe.exec(html)) !== null) {
    tokens.push({ type: 'link', url: l[1], pos: l.index });
  }
  tokens.sort((a, b) => a.pos - b.pos);

  let currentSection = '';
  for (const t of tokens) {
    if (t.type === 'head') currentSection = t.text;
    else {
      downloads.push({
        url: t.url,
        savelinks_url: t.url,
        quality: currentSection || 'Download',
        language: '',
        size: '',
        host: 'dl.freedrivemovie.org',  // FDM's own direct host
        episode: currentSection,
      });
    }
  }
  return downloads;
}

function extractTvEpisodes(html) {
  const episodes = [];
  
  // Find seasons container: <div id='seasons'>...
  const seasonsMatch = html.match(/<div[^>]*id=['"]seasons['"][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i) ||
                       html.match(/<div[^>]*id=['"]seasons['"][^>]*>([\s\S]*?)$/i);
  if (!seasonsMatch) return episodes;
  
  const seasonsHtml = seasonsMatch[1];
  
  // Each season block: <div class='se-c'>...
  const seasonRe = /<div class=['"]se-c['"][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let sm;
  while ((sm = seasonRe.exec(seasonsHtml)) !== null) {
    const seasonHtml = sm[1];
    
    // Season title/number: <span class='title'>Season 1 ...</span>
    const seasonTitleM = seasonHtml.match(/<span class=['"]title['"][^>]*>([\s\S]*?)<\/span>/i);
    const seasonTitle = seasonTitleM ? seasonTitleM[1].replace(/<[^>]+>/g, '').trim() : 'Season';
    
    // Episode list: <ul class='episodios'>...</ul>
    // Inside: <div class='episodiotitle'><a href='...episodes/...'>Episode Title</a></div>
    const epLinkRe = /<div class=['"]episodiotitle['"][^>]*>\s*<a href=['"](https?:\/\/freedrivemovie\.cyou\/episodes\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
    let em;
    while ((em = epLinkRe.exec(seasonHtml)) !== null) {
      const url = em[1];
      const epTitle = em[2].replace(/<[^>]+>/g, '').trim();
      const slug = url.replace(/\/$/, '').split('/').pop();
      
      episodes.push({
        id: slug,
        url,
        savelinks_url: url,
        quality: epTitle,
        language: '',
        size: '',
        host: 'dl.freedrivemovie.org',
        episode: epTitle,
        season: seasonTitle,
      });
    }
  }
  
  return episodes;
}

function extractHostFromLabel(label) {
  const m = label.match(/\b(mega\.nz|gdrive|g-drive|gd|hubcloud|gdtot|gdflix|multicloud)\b/i);
  if (!m) return 'dl.freedrivemovie.org';
  const map = { 'mega': 'mega.nz', 'gdrive': 'dl.freedrivemovie.org', 'g-drive': 'dl.freedrivemovie.org',
                'gd': 'dl.freedrivemovie.org', 'hubcloud': 'hubcloud.lol', 'gdtot': 'gdtot.dad',
                'gdflix': 'gdflix.dad', 'multicloud': 'multicloudlinks.com' };
  return map[m[1].toLowerCase()] || m[1];
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  const directUrl = url.searchParams.get('url');   // also accept ?url=
  if (!slug && !directUrl) {
    return json({ ok: false, error: 'Missing ?slug= or ?url=' }, 400);
  }

  // KV cache lookup
  const reqSlug = slug || directUrl.replace(/\/$/, '').split('/').pop();
  const cacheKey = `fdm:movie:${reqSlug}`;
  let cacheVal = null;
  if (env.LINKS_CACHE) {
    try {
      cacheVal = await env.LINKS_CACHE.get(cacheKey, 'json');
    } catch {}
  }
  if (cacheVal && (Date.now() - cacheVal.ts < 10 * 60 * 1000)) {
    return json(cacheVal.data);
  }

  // Determine type from the URL if given, else try /movies/ first, fall back to /tvshows/
  let sourceUrl = directUrl;
  let typeHint = 'Movie';
  if (!sourceUrl) {
    sourceUrl = `https://freedrivemovie.cyou/movies/${slug}/`;
  } else if (/\/tvshows\//.test(sourceUrl)) {
    typeHint = 'TV';
  }

  let html;
  try { html = await fetchText(sourceUrl); }
  catch {
    // Try the other layout
    const alt = sourceUrl.replace('/movies/', '/tvshows/');
    try {
      html = await fetchText(alt);
      typeHint = 'TV';
      sourceUrl = alt;
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 502);
    }
  }

  // Detect TV-show layout if we see episode markers or seasons
  if (/<(?:h[2-4])[^>]*>\s*Episode\s+\d+/i.test(html) ||
      /class=["'][^"']*episodes?[^"']*["']/i.test(html) ||
      /id=['"]episodes['"]/i.test(html)) {
    typeHint = 'TV';
  }

  let downloads = extractDownloads(html);
  let tvSections = null;

  if (downloads.length === 0 && typeHint === 'TV') {
    const episodes = extractTvEpisodes(html);
    if (episodes.length > 0) {
      const groups = {};
      for (const ep of episodes) {
        const season = ep.season || 'Episodes';
        if (!groups[season]) groups[season] = { section_title: season, downloads: [] };
        groups[season].downloads.push(ep);
      }
      tvSections = Object.values(groups);
      downloads = episodes;
    }
  }

  // Parse details
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : (slug || reqSlug);

  const posterMatch = html.match(/<div\s+class="poster"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/) || html.match(/<div\s+class="poster"[^>]*>[\s\S]*?<img[^+]+data-src="([^"]+)"/);
  const poster = posterMatch ? posterMatch[1] : '';

  const originalTitleMatch = html.match(/<b class="variante">Original title<\/b>\s*<span class="valor">([^<]+)<\/span>/);
  const originalTitle = originalTitleMatch ? originalTitleMatch[1].trim() : '';

  const synopsisMatch = html.match(/<div\s+itemprop="description"[^>]*>([\s\S]*?)<\/div>/);
  let synopsis = '';
  if (synopsisMatch) {
    synopsis = synopsisMatch[1]
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const genres = [];
  const sgeneros = html.match(/<div\s+class="sgeneros"[^>]*>([\s\S]*?)<\/div>/);
  if (sgeneros) {
    const genreMatches = sgeneros[1].matchAll(/<a[^>]+href="[^"]*genre\/[^"]+"[^>]*>([^<]+)<\/a>/g);
    for (const m of genreMatches) {
      const name = m[1].trim().replace(/&amp;/g, '&');
      if (!genres.includes(name)) genres.push(name);
    }
  }

  const cast = [];
  const castSection = html.match(/<div\s+id="cast"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  if (castSection) {
    const actorMatches = castSection[1].matchAll(/<div\s+class="name"><a[^>]*>([^<]+)<\/a><\/div>/g);
    for (const m of actorMatches) {
      cast.push(m[1].trim());
    }
  }

  const directorMatch = html.match(/<div\s+class="name"><a[^>]*>([^<]+)<\/a><\/div><div\s+class="caracter">Director/);
  const director = directorMatch ? directorMatch[1].trim() : '';

  let imdbRating = '';
  const ratingMatch = html.match(/data-rating="([^"]+)"/);
  if (ratingMatch) imdbRating = ratingMatch[1];

  const screenshots = [];
  const seenPaths = new Set();
  const galleryMatches = html.matchAll(/<div\s+class="g-item"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/g);
  for (const m of galleryMatches) {
    const url = m[1].replace('/w300/', '/w500/');
    const path = url.split('/').pop();
    if (!seenPaths.has(path)) {
      seenPaths.add(path);
      screenshots.push(url);
    }
  }
  if (screenshots.length === 0) {
    const tmdbMatches = html.matchAll(/image\.tmdb\.org\/t\/p\/(?:w500|w780|original|w1280)\/([^"'\s]+)/g);
    for (const m of tmdbMatches) {
      const path = m[1];
      if (!seenPaths.has(path)) {
        seenPaths.add(path);
        screenshots.push(`https://image.tmdb.org/t/p/w500/${path}`);
      }
    }
  }
  screenshots.splice(8);

  const trailerMatch = html.match(/<iframe[^>]*src="https?:\/\/www\.youtube\.com\/embed\/([a-zA-Z0-9_-]+)/);
  const trailer = trailerMatch
    ? `https://www.youtube.com/watch?v=${trailerMatch[1]}`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' trailer')}`;

  const yearM = title.match(/\((\d{4})\)/) || html.match(/<span>(\d{4})<\/span>/i);
  const year = yearM ? yearM[1] : '';

  const out = {
    ok: true,
    slug: reqSlug,
    title,
    poster,
    originalTitle,
    synopsis,
    genres,
    cast,
    director,
    downloads,
    trailer,
    screenshots,
    imdbRating,
    source: 'freedrivemovie',
    type: typeHint,
    sourceUrl,
    sections: tvSections || (typeHint === 'TV' ? groupByEpisode(downloads) : [{ section_title: 'Download', downloads }]),
    info: {
      year,
      runtime: 'N/A',
      genre: genres.join(', '),
      language: downloads.length ? downloads[0].language : '',
      quality: downloads.length ? downloads[0].quality : 'HD',
      director,
      cast
    }
  };

  if (env.LINKS_CACHE) {
    try {
      await env.LINKS_CACHE.put(cacheKey, JSON.stringify({ ts: Date.now(), data: out }), { expirationTtl: 600 });
    } catch {}
  }

  return json(out);
}

function groupByEpisode(downloads) {
  const groups = {};
  for (const d of downloads) {
    const ep = d.episode || 'Download';
    if (!groups[ep]) groups[ep] = { section_title: ep, downloads: [] };
    groups[ep].downloads.push(d);
  }
  return Object.values(groups);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
