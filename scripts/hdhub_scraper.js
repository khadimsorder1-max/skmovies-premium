const https = require('https');

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const KV_NAMESPACE_ID = process.env.KV_NAMESPACE_ID;

const DOMAIN = 'https://new3.hdhub4u.cl';

async function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function parsePage(html) {
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  const items = [];
  let lm;
  while ((lm = liRe.exec(html)) !== null) {
    const block = lm[1];
    const aM = block.match(/href="(https:\/\/[^"]+)"/i);
    const pM = block.match(/<p>([\s\S]*?)<\/p>/i);
    const imgM = block.match(/src="([^"]+)"/i) || block.match(/data-src="([^"]+)"/i);

    if (aM && pM) {
      const pageUrl = aM[1];
      const title = pM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').trim();
      const poster = imgM ? imgM[1] : '';
      const rawSlug = pageUrl.replace(DOMAIN + '/', '').replace(/\/$/, '');

      if (!/how-to-download|category|tag|author/i.test(rawSlug)) {
        items.push({
          slug: rawSlug,
          title,
          poster,
          quality: 'HD',
          language: 'Hindi Dubbed',
          year: '',
          sizes: [],
        });
      }
    }
  }
  return items;
}

const { exec } = require('child_process');
const fs = require('fs');

async function uploadToKV(key, value) {
  const tempFile = `temp_${key}.json`;
  fs.writeFileSync(tempFile, JSON.stringify(value));
  const command = `npx wrangler kv:key put --namespace-id "054063fc418f417ab43e054269b4084f" "${key}" --path "${tempFile}"`;
  
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      try { fs.unlinkSync(tempFile); } catch (e) {}
      if (error) {
        console.error(`Failed to upload ${key} via Wrangler`);
        resolve(false);
      } else {
        console.log(`Successfully uploaded ${key} to KV via Wrangler`);
        resolve(true);
      }
    });
  });
}

async function fetchHtmlWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchHtml(url);
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function scrapeMovieDetails(slug, movieUrl) {
  try {
    const html = await fetchHtmlWithRetry(movieUrl);
    
    var titleM = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([^<]+)<\/title>/i);
    var title = titleM ? titleM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').trim() : slug;

    var posterM = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || html.match(/<img[^>]+src="(https?:\/\/[^"]+)"/i);
    var poster = posterM ? posterM[1] : '';

    var storylineM = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    var storyline = storylineM ? storylineM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400).trim() : '';

    const KNOWN_DL_HOSTS_RE = /hubcdn\.sbs|hubdrive\.(tips|com|net)|gadgetsweb\.xyz|hubstream\.art|hubcloud\.(foo|lol|com)|gdflix\.(dev|dad|com|io)|filepress\.(baby|com)|gdtot\.(dad|com|dev)|gdlink\.dev|multidownload\.website|busycdn\.xyz|indexserver\.site|hdstream4u\.com|fastdl|driveleech|savelinks/i;

    const contentMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:footer|\/article|aside)/i);
    const scopedHtml = contentMatch ? contentMatch[1] : html;

    const downloadLinks = [];
    const seenUrls = new Set();
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
        isDirect: KNOWN_DL_HOSTS_RE.test(linkUrl) && !/savelinks/i.test(linkUrl),
      });
    }

    // Extract iframe stream (if any)
    const streams = [];
    const iframeRegex = /<iframe[^>]+src="(https?:\/\/(?:hubstream\.art|new3\.hdhub4u\.cl)[^"]+)"/gi;
    let im;
    while ((im = iframeRegex.exec(scopedHtml)) !== null) {
      streams.push({
        url: im[1],
        label: 'HDHub Stream'
      });
    }

    return {
      ok: true,
      slug: slug,
      url: movieUrl,
      title: title,
      poster: poster,
      storyline: storyline,
      downloads: downloadLinks,
      streams: streams,
      ts: Date.now()
    };
  } catch (e) {
    console.error(`Failed to scrape movie ${slug}: ${e.message}`);
    return null;
  }
}

async function scrapeHome() {
  console.log('Scraping HDHub Main (Home)...');
  const pagesData = {};
  const allMoviesToScrape = [];
  
  for (let page = 1; page <= 2; page++) {
    const url = page === 1 ? `${DOMAIN}/?utm=mn1` : `${DOMAIN}/page/${page}/?utm=mn1`;
    try {
      const html = await fetchHtml(url);
      const items = await parsePage(html);
      pagesData[page] = {
        ok: true,
        page,
        items,
        hasMore: items.length >= 20
      };
      console.log(`Scraped page ${page}, found ${items.length} items`);
      
      items.forEach(item => {
        allMoviesToScrape.push({ slug: item.slug, url: `${DOMAIN}/${item.slug}/` });
      });
    } catch (e) {
      console.error(`Error scraping page ${page}:`, e);
    }
  }

  // Upload each home page to KV
  for (const [page, data] of Object.entries(pagesData)) {
    await uploadToKV(`hdhubmain_home_${page}`, data);
  }
  
  // Scrape movie details
  console.log(`Scraping ${allMoviesToScrape.length} movies...`);
  // We process them sequentially or in small batches to avoid overloading the site
  for (let i = 0; i < allMoviesToScrape.length; i++) {
    const movie = allMoviesToScrape[i];
    console.log(`Scraping [${i+1}/${allMoviesToScrape.length}] ${movie.slug}...`);
    const details = await scrapeMovieDetails(movie.slug, movie.url);
    if (details) {
      await uploadToKV(`hdhubmain_movie_${movie.slug}`, details);
    }
    // slight delay
    await new Promise(r => setTimeout(r, 500));
  }
}

async function run() {
  await scrapeHome();
  console.log('Scraping complete.');
}

run();
