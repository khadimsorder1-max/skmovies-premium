export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return new Response(JSON.stringify({ok: false, error: 'Missing slug'}), {headers: {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*'}});
  
  const [detailPath, idPart] = slug.split('?id=');
  const subjectId = idPart || slug;
  
  const cacheKey = new Request(request.url, { method: 'GET' });
  try {
    const c = await caches.default.match(cacheKey);
    if (c) return c;
  } catch {}

  // 1. Check GitHub mega-cache first
  const cacheRepo = (context.env && context.env.SKM_CACHE_REPO) || 'khadimsorder1-max/skmovies-cache';
  const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  try {
    const ghUrl = `https://raw.githubusercontent.com/${cacheRepo}/main/moviebox/movie/${safeSlug}.json`;
    const ghResp = await fetch(ghUrl);
    if (ghResp.ok) {
      const ghText = await ghResp.text();
      if (ghText.trim().startsWith('{')) {
        const ghData = JSON.parse(ghText);
        if (ghData.ok && (ghData.title || (ghData.downloads && ghData.downloads.length > 0))) {
          const resp = new Response(JSON.stringify({ ...ghData, _cache: 'github' }), {
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=600' }
          });
          try { await caches.default.put(cacheKey, resp.clone()); } catch {}
          return resp;
        }
      }
    }
  } catch {}

    let pageUrl = `https://moviebox.ph/moviedetail/${detailPath}?id=${subjectId}&type=/movie/detail`;
    if (!detailPath || detailPath === subjectId) {
      pageUrl = `https://moviebox.ph/moviedetail/movie?id=${subjectId}&type=/movie/detail`;
    }
    const r = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      cf: { cacheTtl: 600, cacheEverything: true }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    
    let title = 'Unknown';
    let poster = '';
    let synopsis = '';
    const videoUrls = [];
    const screenshots = [];

    // 1. Parse JSON-LD Schema
    const ldM = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (ldM) {
      try {
        const ld = JSON.parse(ldM[1]);
        if (ld.name) title = ld.name;
        if (ld.description) synopsis = ld.description;
        if (ld.thumbnailUrl && ld.thumbnailUrl.length) poster = ld.thumbnailUrl[0];
        if (ld.contentUrl) videoUrls.push(ld.contentUrl);
      } catch(e) {}
    }

    // 2. Extract video URLs (.mp4, .m3u8, .mkv)
    const videoRe = /https?:\/\/[a-z0-9.]*aoneroom\.com\/[^"'\s\\]+\.(?:mp4|m3u8|mkv)/gi;
    let vm;
    while ((vm = videoRe.exec(html)) !== null) {
      const u = vm[0].replace(/\\\//g, '/');
      if (!videoUrls.includes(u)) videoUrls.push(u);
    }

    // 3. Fallback title, poster, synopsis
    if (title === 'Unknown') {
      const tm = html.match(/<title>([^<]+)<\/title>/);
      if (tm) title = tm[1].replace(/\s*-\s*MovieBox.*$/i, '').replace(/\s*-\s*Watch.*$/i, '').trim();
    }
    if (!poster) {
      const pm = html.match(/https?:\/\/[a-z0-9.]*aoneroom\.com\/[^\s"'\\]+\.(?:jpg|jpeg|png|webp)/gi);
      if (pm && pm.length) poster = pm[0];
    }
    if (!synopsis) {
      const sm = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
      if (sm) synopsis = sm[1];
    }

    // 4. Screenshots extraction
    const imgRe = /https?:\/\/pbcdnw\.aoneroom\.com\/image\/[^\s"'\\]+\.(?:jpg|jpeg|png|webp)/gi;
    let im;
    while ((im = imgRe.exec(html)) !== null) {
      const u = im[0].replace(/\\\//g, '/');
      if (u !== poster && !screenshots.includes(u)) screenshots.push(u);
    }

    let genres = [];
    const gm = html.match(/"genre":"([^"]+)"/);
    if (gm) genres = gm[1].split(',').map(g => g.trim());

    let rating = '';
    const im2 = html.match(/"imdbRatingValue":"([^"]+)"/);
    if (im2) rating = im2[1];

    const downloadLinks = videoUrls.map((u, i) => ({
      label: videoUrls.length > 1 ? `Quality ${i + 1}` : 'Watch / Download',
      url: u,
      size: u.includes('-sd.') ? 'SD (480p)' : u.includes('-hd.') ? 'HD (720p)' : u.includes('-fhd.') ? 'FHD (1080p)' : 'HD',
    }));
    
    const streamUrl = videoUrls[0] || null;
    const streams = videoUrls.map((u, i) => ({
      url: u,
      label: `MovieBox Stream ${i + 1}`
    }));
    
    const result = {
      ok: true,
      slug,
      title,
      poster,
      synopsis,
      storyline: synopsis,
      genres,
      screenshots: screenshots.slice(0, 10),
      rating,
      streamUrl,
      streams: streams,
      downloadLinks,
      downloads: downloadLinks,
      episodes: [],
    };
    
    const resp = new Response(JSON.stringify(result), {
      headers: {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=600'},
    });
    if (streamUrl) {
      try { await caches.default.put(cacheKey, resp.clone()); } catch {}
    }
    return resp;
  } catch (err) {
    return new Response(JSON.stringify({ok: false, error: err.message}), {
      status: 200,
      headers: {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*'},
    });
  }
}


