import { unescapeHtml } from '../../_lib/shared.js';

// Parse list of movies from homepage, category, search, or trending pages
export function parseFdmMovieList(html) {
  if (!html) return [];
  const items = [];
  
  // Format: <article id="post-XXX"> <div class="image"> <a href="url"><img src="poster"></a> <div class="data"> <h3 class="title">title</h3> <span>year</span> ...
  const articleRe = /<article[^>]*>([\s\S]*?)<\/article>/g;
  let match;
  while ((match = articleRe.exec(html)) !== null) {
    const block = match[1];
    
    // Extract URL and slug
    const urlM = block.match(/href="https?:\/\/freedrivemovie\.cyou\/(movies|tvshows)\/([^"]+?)\/"/) 
              || block.match(/href="https?:\/\/freedrivemovie\.cyou\/(movies|tvshows)\/([^"]+?)"/)
              || block.match(/href="([^"]*?\/(?:movies|tvshows)\/([^"]+?)\/?)"/);
    if (!urlM) continue;
    
    const type = urlM[1] === 'tvshows' ? 'TV' : 'Movie';
    const slug = urlM[2].trim().replace(/\/+$/, '');
    const url = urlM[1] ? `https://freedrivemovie.cyou/${urlM[1]}/${slug}/` : urlM[0];

    // Extract Title
    const titleM = block.match(/class="title">([^<]+)<\/h3>/i)
                || block.match(/alt="([^"]+)"/i)
                || block.match(/<h3[^>]*>([^<]+)<\/h3>/i);
    const title = titleM ? unescapeHtml(titleM[1].strip ? titleM[1].strip() : titleM[1].trim()) : slug;

    // Extract Poster
    const posterM = block.match(/src="([^"]+?)"/i)
                 || block.match(/data-src="([^"]+?)"/i);
    let poster = posterM ? posterM[1] : '';
    if (poster && poster.startsWith('//')) {
      poster = 'https:' + poster;
    }

    // Extract Year
    const yearM = block.match(/<span>(\d{4})<\/span>/i);
    const year = yearM ? yearM[1] : '';

    items.push({
      slug,
      title,
      poster,
      year,
      type,
      url
    });
  }

  // Remove duplicates
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.slug)) continue;
    seen.add(it.slug);
    out.push(it);
  }
  return out;
}

// Parse detailed movie page
export function parseFdmMovieDetails(html, slug) {
  // Title
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : slug;

  // ★ FIX 1: Poster — extract from <div class="poster"> (not generic TMDB match)
  const posterMatch = html.match(/<div\s+class="poster"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/);
  const poster = posterMatch ? posterMatch[1] : '';

  // Original Title
  const originalTitleMatch = html.match(/<b class="variante">Original title<\/b>\s*<span class="valor">([^<]+)<\/span>/);
  const originalTitle = originalTitleMatch ? originalTitleMatch[1].trim() : '';

  // ★ FIX 4: Synopsis — strip <script> tags, clean text
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

  // ★ FIX 3: Genres — only from .sgeneros div (not menu)
  const genres = [];
  const sgeneros = html.match(/<div\s+class="sgeneros"[^>]*>([\s\S]*?)<\/div>/);
  if (sgeneros) {
    const genreMatches = sgeneros[1].matchAll(/<a[^>]+href="[^"]*genre\/[^"]+"[^>]*>([^<]+)<\/a>/g);
    for (const m of genreMatches) {
      const name = m[1].trim().replace(/&amp;/g, '&');
      if (!genres.includes(name)) genres.push(name);
    }
  }

  // ★ FIX 2: Cast — only from #cast section
  const cast = [];
  const castSection = html.match(/<div\s+id="cast"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  if (castSection) {
    const actorMatches = castSection[1].matchAll(/<div\s+class="name"><a[^>]*>([^<]+)<\/a><\/div>/g);
    for (const m of actorMatches) {
      cast.push(m[1].trim());
    }
  }

  // Director
  const directorMatch = html.match(/<div\s+class="name"><a[^>]*>([^<]+)<\/a><\/div><div\s+class="caracter">Director/);
  const director = directorMatch ? directorMatch[1].trim() : '';

  // ★ FIX 8: IMDb Rating — from correct data-rating attribute
  let imdbRating = '';
  const ratingMatch = html.match(/data-rating="([^"]+)"/);
  if (ratingMatch) imdbRating = ratingMatch[1];

  // Download links (table rows)
  const downloads = [];
  const rows = html.matchAll(/<tr\s+id=['"]link-(\d+)['"][^>]*>([\s\S]*?)<\/tr>/g);
  for (const m of rows) {
    const row = m[2];
    const urlMatch = row.match(/href=['"]([^'"]+)['"]/);
    const qualityMatch = row.match(/<strong\s+class=['"]quality['"]>([^<]+)<\/strong>/);
    const hostMatch = row.match(/favicons\?domain=([^'"]+)['"]/);
    const cells = row.matchAll(/<td>([^<]*)<\/td>/g);
    const cellValues = [...cells].map(c => c[1].trim());

    if (urlMatch) {
      downloads.push({
        id: m[1],
        url: urlMatch[1],
        savelinks_url: urlMatch[1],
        quality: qualityMatch ? qualityMatch[1].trim() : 'Download',
        host: hostMatch ? hostMatch[1] : 'unknown',
        language: cellValues[0] || '',
        size: cellValues[1] || '',
      });
    }
  }

  // ★ FIX 5: Screenshots — TMDB backdrop images (w500+, skip w92 cast thumbnails)
  const screenshots = [];
  const seenPaths = new Set();

  // Try gallery items first
  const galleryMatches = html.matchAll(/<div\s+class="g-item"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/g);
  for (const m of galleryMatches) {
    const url = m[1].replace('/w300/', '/w500/');
    const path = url.split('/').pop();
    if (!seenPaths.has(path)) {
      seenPaths.add(path);
      screenshots.push(url);
    }
  }

  // Fallback: TMDB backdrop images (w500 or larger)
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
  screenshots.splice(8); // Max 8

  // Trailer
  const trailerMatch = html.match(/<iframe[^>]*src="https?:\/\/www\.youtube\.com\/embed\/([a-zA-Z0-9_-]+)/);
  const trailer = trailerMatch
    ? `https://www.youtube.com/watch?v=${trailerMatch[1]}`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' trailer')}`;

  // Extract language from first download or defaults
  const language = downloads.length ? downloads[0].language : '';

  // Extract year from title
  const yearM = title.match(/\((\d{4})\)/) || html.match(/<span>(\d{4})<\/span>/i);
  const year = yearM ? yearM[1] : '';

  return {
    slug, title, poster, originalTitle, synopsis, genres, cast, director,
    downloads, trailer, screenshots, imdbRating,
    source: 'freedrivemovie',
    info: {
      year,
      runtime: 'N/A', // Auto-filled on client or TMDB info
      genre: genres.join(', '),
      language,
      quality: downloads.length ? downloads[0].quality : 'HD',
      director,
      cast
    }
  };
}

// Parse intermediate /links/[code]/ redirect page
export function parseFdmLinkPage(html) {
  if (!html) return null;
  // Format: <a id="link" href="https://dl.freedrivemovie.org/...">
  const linkM = html.match(/id="link"[^>]*href="([^"]+)"/i)
             || html.match(/href="(https?:\/\/dl\.freedrivemovie\.org\/[^"]+)"/i)
             || html.match(/href="([^"]+)"[^>]*id="link"/i);
  return linkM ? linkM[1] : null;
}

// Parse download options from dl.freedrivemovie.org
export function parseFdmDownloadPage(html) {
  if (!html) return [];
  const urls = [];
  
  // Extract all links
  const hrefRe = /href="([^"]+)"/g;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const url = m[1];
    if (url.startsWith('http')) {
      urls.push(url);
    }
  }

  // Prioritize fdmurgent workers.dev URLs (direct streams)
  const directUrls = urls.filter(u => u.includes('fdmurgent.workers.dev'));
  const fallbackUrls = urls.filter(u => u.includes('gdflix') || u.includes('hubcloud') || u.includes('gdtot') || u.includes('filepress'));

  return [...new Set([...directUrls, ...fallbackUrls])];
}
