/* SKMovies — HTML parsers for mlsbd.co (cloned, ad-free) */
import { unescapeHtml } from './shared.js';

const IMG_BLACKLIST = /(?:mlsbdshop\.png|favicon|placeholder|logo|sprite)/i;

export function parseMovieList(html) {
  if (!html) return [];
  const items = [];
  const blocks = html.match(/<div\s+class="single-post[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g) || [];
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]*href="(https?:\/\/mlsbd\.co\/[^"]+\/?)"/);
    if (!hrefMatch) continue;
    const url = hrefMatch[1];
    const slug = url.replace(/^https?:\/\/mlsbd\.co\//, '').replace(/\/+$/, '');
    if (!slug || slug.startsWith('category/') || slug.startsWith('page/') || slug === 'stream' || slug === 'review-news') continue;
    const titleMatch = block.match(/<h2[^>]*class="[^"]*post-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/);
    const title = titleMatch ? unescapeHtml(titleMatch[1].replace(/<[^>]+>/g, '').trim()) : slug;
    let poster = '';
    const pictureSrc = block.match(/<picture[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/);
    if (pictureSrc) poster = pictureSrc[1];
    else { const imgMatch = block.match(/<img[^>]+src="([^"]+)"/); if (imgMatch) poster = imgMatch[1]; }
    if (poster && IMG_BLACKLIST.test(poster)) poster = '';
    const uploadMatch = block.match(/ab-clock[^>]*><\/i>\s*([^<]+)/);
    const uploadDate = uploadMatch ? uploadMatch[1].trim() : '';
    items.push({ slug, title, poster, year: extractYear(title), quality: detectQuality(title), language: detectLanguage(title), uploadDate, sizes: extractSizes(title) });
  }
  const seen = new Set();
  const out = [];
  for (const it of items) { if (seen.has(it.slug)) continue; seen.add(it.slug); out.push(it); }
  return out;
}

export function parseTrending(html) {
  const items = [];
  // Find the featured-slider section
  const m = html.match(/<div\s+class="featured-slider"[^>]*>([\s\S]*?)<\/div>\s*<!--|<div\s+class="featured-slider"[^>]*>([\s\S]*?)<\/article>/);
  // Fallback: just grab everything between featured-slider and the next major section
  const startIdx = html.indexOf('featured-slider');
  if (startIdx === -1) return items;
  // Find the closing </div></div></div> that ends the slider (3 levels)
  const endIdx = html.indexOf('class="section-title"', startIdx);
  const block = endIdx > 0 ? html.slice(startIdx, endIdx) : html.slice(startIdx, startIdx + 10000);
  // Each slider-post has: <a href="..."> <div class="featured-post"> <picture><img src="..."> <div class="title"><h3>title</h3>
  const slideRe = /<div\s+class="slider-post[^"]*"[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/mlsbd\.co\/[^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/g;
  let slide;
  while ((slide = slideRe.exec(block)) !== null) {
    const url = slide[1];
    const poster = slide[2];
    const title = unescapeHtml(slide[3].replace(/<[^>]+>/g, '').trim());
    const slug = url.replace(/^https?:\/\/mlsbd\.co\//, '').replace(/\/+$/, '');
    items.push({ slug, title, poster, year: '', quality: '', language: '', uploadDate: '', sizes: [] });
  }
  return items;
}

export function parseNotice(html) {
  const items = [];
  const m = html.match(/<marquee[^>]*class="upcoming-movies"[^>]*>([\s\S]*?)<\/marquee>/i);
  if (!m) return items;
  const text = unescapeHtml(m[1].replace(/<[^>]+>/g, '').trim());
  return text.split('␥').map((s) => s.replace(/&nbsp;/g, ' ').trim()).filter(Boolean);
}

export function filterMovies(movies, filterId) {
  if (!filterId || filterId === 'all') return movies;
  const f = filterId.toLowerCase();
  return movies.filter((m) => {
    const hay = ((m.title || '') + ' ' + (m.quality || '') + ' ' + (m.language || '')).toLowerCase();
    switch (f) {
      case '1080p': return /1080p|1080/.test(hay);
      case '720p': return /720p|720/.test(hay);
      case '480p': return /480p|480/.test(hay);
      case '4k': return /4k|2160p/.test(hay);
      case 'bengali': return /bengali|bangla/.test(hay);
      case 'hindi': return /hindi/.test(hay);
      case 'english': return /english/.test(hay);
      case 'dual': return /dual audio/.test(hay);
      case 'web-dl': return /web-dl|webdl|webrip/.test(hay);
      case 'bluray': return /bluray|blu-ray/.test(hay);
      case 'hdtc': return /hdtc|hdts|hdrip/.test(hay);
      case 'netflix': return /netflix/.test(hay);
      case 'amazon': return /amazon/.test(hay);
      case 'hotstar': return /hotstar|jiohs/.test(hay);
      case 'zee5': return /zee5/.test(hay);
      case 'hoichoi': return /hoichoi/.test(hay);
      default: return true;
    }
  });
}

export function parseMovieDetails(html, slug) {
  if (!html) return null;
  const h1Match = html.match(/<h1[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const title = h1Match ? unescapeHtml(h1Match[1].replace(/<[^>]+>/g, '').trim()) : slug;
  let poster = '';
  const posterMatch = html.match(/<div\s+class="poster"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/);
  if (posterMatch) poster = posterMatch[1];
  else { const ogImg = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/); if (ogImg) poster = ogImg[1]; }
  const infoBlockMatch = html.match(/<div\s+class="info"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  const infoBlock = infoBlockMatch ? infoBlockMatch[1] : html;
  const miscMatch = infoBlock.match(/<p\s+class="misc"[^>]*>([\s\S]*?)<\/p>/);
  const miscText = miscMatch ? unescapeHtml(miscMatch[1].replace(/<[^>]+>/g, '').trim()) : '';
  const miscParts = miscText.split('|').map((s) => s.trim());
  const runtime = miscParts[0] && miscParts[0] !== 'N/A' ? miscParts[0] : '';
  const genre = miscParts[1] ? miscParts[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  function strongField(label) {
    const re = new RegExp('<strong>\\s*' + label.replace(/\s+/g, '\\s*') + '[^<]*?:?\\s*</strong>\\s*:?\\s*([^<\\n]+)', 'i');
    const m = infoBlock.match(re);
    return m ? unescapeHtml(m[1].trim()) : '';
  }
  const imdbRating = strongField('IMDb Ratings') || '';
  const storyline = strongField('Storyline') || '';
  const director = strongField('Director') || '';
  const castStr = strongField('Cast');
  const cast = castStr ? castStr.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const language = strongField('Language') || '';
  const quality = strongField('Quality') || '';
  const resolutionStr = strongField('Resolution') || '';
  const resolution = resolutionStr ? resolutionStr.split('|').map((s) => s.trim()).filter(Boolean) : [];
  const sizeStr = strongField('Size') || '';
  const size = sizeStr ? sizeStr.split('|').map((s) => s.trim()).filter(Boolean) : [];
  const year = extractYear(title) || (miscParts[2] && miscParts[2] !== 'N/A' ? miscParts[2] : '');
  const screenshots = [];
  const shotsSection = html.match(/<div\s+class="post-section-title\s+screenshots"[^>]*>([\s\S]*?)<div\s+class="post-section-title\s+download"/);
  if (shotsSection) {
    const shotImgs = shotsSection[1].matchAll(/<img[^>]+src="([^"]+)"/g);
    for (const m of shotImgs) if (!IMG_BLACKLIST.test(m[1])) screenshots.push(m[1]);
  }
  const downloads = [];
  
  // Find all headers (<div class="post-section-title download">...</div> or <p class="Dinfo">...</p>)
  const headers = [];
  const titleRegex = /<div\s+class="post-section-title\s+download"[^>]*>([\s\S]*?)<\/div>/g;
  let titleMatch;
  while ((titleMatch = titleRegex.exec(html)) !== null) {
    headers.push({
      index: titleMatch.index,
      text: unescapeHtml(titleMatch[1].replace(/<[^>]+>/g, '').trim())
    });
  }
  const infoRegex = /<p\s+class="Dinfo"[^>]*>([\s\S]*?)<\/p>/g;
  let infoMatch;
  while ((infoMatch = infoRegex.exec(html)) !== null) {
    headers.push({
      index: infoMatch.index,
      text: unescapeHtml(infoMatch[1].replace(/<[^>]+>/g, '').trim())
    });
  }
  headers.sort((a, b) => a.index - b.index);

  const dlBtnRegex = /<a[^>]*class="[^"]*Dbtn[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let dlMatch;
  while ((dlMatch = dlBtnRegex.exec(html)) !== null) {
    const url = dlMatch[1];
    const label = unescapeHtml(dlMatch[2].replace(/<[^>]+>/g, '').trim());
    if (url && !url.includes('facebook.com') && !url.includes('twitter.com') && !url.includes('youtube.com') && !url.includes('mlsbd.co') && !url.startsWith('#')) {
      const lcLabel = label.toLowerCase();
      if (lcLabel.includes('how to download') || lcLabel.includes('join') || lcLabel.includes('request')) continue;
      
      const qualityMatch = label.match(/(\d{3,4}[pP]|\dK)/i);
      
      // Find closest preceding header
      let closestHeader = null;
      for (let i = headers.length - 1; i >= 0; i--) {
        if (headers[i].index < dlMatch.index) {
          closestHeader = headers[i];
          break;
        }
      }
      
      downloads.push({
        quality: qualityMatch ? qualityMatch[0].toUpperCase() : label,
        savelinks_url: url,
        info: closestHeader ? closestHeader.text : '',
        label: label
      });
    }
  }
  const trailerMatch = html.match(/<a[^>]*href="(https?:\/\/(?:vimeo\.com\/\d+|youtube\.com\/watch\?v=[\w-]+|youtu\.be\/[\w-]+))"/);
  const trailer = trailerMatch ? trailerMatch[1] : '';
  const uploadMatch = html.match(/ab-clock[^>]*><\/i>\s*([^<]+)/);
  const uploadDate = uploadMatch ? uploadMatch[1].trim() : '';
  const authorMatch = html.match(/ab-user[^>]*><\/i>\s*<a[^>]*>([^<]+)<\/a>/);
  const author = authorMatch ? unescapeHtml(authorMatch[1].trim()) : '';
  const categories = [];
  const tagMatches = html.matchAll(/<a\s+href="https:\/\/mlsbd\.co\/category\/[^"]+"[^>]*>([^<]+)<\/a>/g);
  for (const m of tagMatches) categories.push(unescapeHtml(m[1].trim()));
  return {
    slug, title, poster, uploadDate, author, categories: [...new Set(categories)],
    info: { year, runtime, genre, releaseDate: '', country: '', language, quality, resolution, size, imdbRating, rotten: '', director, cast },
    storyline, screenshots, trailer, sections: downloads.length > 0 ? [{ section_title: 'Download', downloads }] : [],
    isMultiEpisode: false, episodeSections: [], downloads, watchOnline: '',
  };
}

export function parseSavelinksHosts(html) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  
  const hrefRe = /href="([^"]+)"/g;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const url = m[1];
    if (url.startsWith('http') && (
      url.includes('gdflix') || 
      url.includes('multicloud') || 
      url.includes('filepress') || 
      url.includes('hubcloud') || 
      url.includes('gdtot') ||
      url.includes('megaup') || 
      url.includes('filemoon') || 
      url.includes('newsmonth') || 
      url.includes('mediafire') || 
      url.includes('mega.nz') ||
      url.includes('1fichier') ||
      url.includes('drive.google')
    )) {
      if (!seen.has(url)) {
        seen.add(url);
        out.push({ host: classifyHost(url), url });
      }
    }
  }
  return out;
}

function classifyHost(url) {
  const u = url.toLowerCase();
  if (u.includes('gdflix')) return 'gdflix';
  if (u.includes('multicloud')) return 'multicloud';
  if (u.includes('filepress')) return 'filepress';
  if (u.includes('hubcloud')) return 'hubcloud';
  if (u.includes('gdtot')) return 'gdtot';
  if (u.includes('megaup')) return 'megaup';
  if (u.includes('filemoon')) return 'filemoon';
  if (u.includes('newsmonth')) return 'newsmonth';
  if (u.includes('mediafire')) return 'mediafire';
  if (u.includes('mega.nz')) return 'mega';
  if (u.includes('1fichier')) return '1fichier';
  if (u.includes('drive.google')) return 'gdrive';
  try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; } catch { return 'unknown'; }
}

export function extractYear(title) {
  if (!title) return '';
  const m = title.match(/\((\d{4})\)/) || title.match(/\b(19\d{2}|20\d{2})\b/);
  return m ? m[1] : '';
}
export function detectQuality(title) {
  const s = (title || '').toLowerCase();
  if (/4k|2160p/.test(s)) return '4K';
  if (/1080p|1080/.test(s)) return '1080P';
  if (/720p|720/.test(s)) return '720P';
  if (/480p|480/.test(s)) return '480P';
  if (/web-dl|webdl/.test(s)) return 'WEB-DL';
  if (/bluray|blu-ray/.test(s)) return 'BluRay';
  if (/hdtc|hdts/.test(s)) return 'HDTC';
  return '';
}
export function detectLanguage(title) {
  const s = (title || '').toLowerCase();
  if (/bengali|bangla/.test(s)) return 'Bengali';
  if (/dual audio/.test(s)) return 'Dual Audio';
  if (/hindi/.test(s)) return 'Hindi';
  if (/english/.test(s)) return 'English';
  if (/tamil/.test(s)) return 'Tamil';
  if (/telugu/.test(s)) return 'Telugu';
  if (/malayalam/.test(s)) return 'Malayalam';
  if (/korean/.test(s)) return 'Korean';
  return '';
}
export function extractSizes(title) {
  if (!title) return [];
  const m = title.match(/([\d.]+\s*(?:GB|MB))/gi);
  return m ? m.slice(0, 4) : [];
}

/**
 * Construct direct video URL from multicloud view URL.
 * Input:  https://new.multicloudlinks.com/view/xv8g4l
 * Output: https://cgd1.multicloudlinks.com/xv8g4l
 */
export function constructMulticloudDirectUrl(multicloudUrl) {
  const match = multicloudUrl.match(/multicloudlinks\.com\/view\/([A-Za-z0-9]+)/i);
  if (match && match[1]) {
    return `https://cgd1.multicloudlinks.com/${match[1]}`;
  }
  return null;
}

export function findDirectUrlInHtml(html) {
  if (!html) return null;

  // ★★★ FIX: Decode HTML entities first ★★★
  const decoded = html.replace(/&amp;/g, '&');

  // ★★★ FIX: Add dr1 URL pattern (works when cgd1 is down!) ★★★
  const dr1Match = decoded.match(/https?:\/\/dr\d*\.multidownload\.website\/[^"'\s<>]+/i);
  if (dr1Match) return dr1Match[0];

  // Pattern 1: ANY indexserver.site URL (west., bolt., etc.)
  const idxMatch = decoded.match(/https?:\/\/[a-z]+\.indexserver\.site\/[^"'\s<>]+/i);
  if (idxMatch) return idxMatch[0];
  
  // Pattern 2: Direct video and archive extensions (.mp4, .mkv, .m3u8, .webm, .zip)
  const extMatch = decoded.match(/https?:\/\/[^"'\s<>]+\.(?:mp4|mkv|m3u8|webm|zip)(?:\?[^"'\s<>]*)?/i);
  if (extMatch) return extMatch[0];
  
  // Pattern 3: r2.dev URLs
  const r2Match = decoded.match(/https?:\/\/pub-[a-f0-9]+\.r2\.dev\/[^"'\s<>]+/i);
  if (r2Match) return r2Match[0];
  
  // Pattern 4: busycdn URLs
  const busyMatch = decoded.match(/https?:\/\/instant\.busycdn\.xyz\/[^"'\s<>]+/i);
  if (busyMatch) return busyMatch[0];
  
  // Pattern 5: multidownload URLs (multicloud stream)
  const mdMatch = decoded.match(/https?:\/\/dr\d*\.multidownload\.website\/[^"'\s<>]+/i);
  if (mdMatch) return mdMatch[0];
  
  // Pattern 6: og:video meta
  const og = decoded.match(/<meta\s+property="og:video[^"]*"\s+content="([^"]+)"/i);
  if (og && /^https?:\/\//.test(og[1])) return og[1];
  
  return null;
}
