export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const cat = url.searchParams.get('slug') || url.searchParams.get('cat') || url.searchParams.get('platform') || '';
  const page = url.searchParams.get('page') || 1;
  
  const cacheKey = new Request(request.url, { method: 'GET' });
  try {
    const c = await caches.default.match(cacheKey);
    if (c) return c;
  } catch {}
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://moviebox.ph',
    'Referer': 'https://moviebox.ph/',
  };

  try {
    if (!cat) {
      const r = await fetch(`https://h5-api.aoneroom.com/wefeed-h5api-bff/home?host=moviebox.ph`, { headers, cf: { cacheTtl: 300, cacheEverything: true } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      
      const categories = [
        {slug: 'movie', title: '🎬 Movies'},
        {slug: 'tv', title: '📺 TV Shows'},
        {slug: 'anime', title: '🎌 Anime'},
        {slug: 'drama', title: '🎭 Drama'},
        {slug: 'series', title: '📚 Series'},
        {slug: 'trending', title: '🔥 Trending'},
      ];
      
      for (const p of data.data?.platformList || []) {
        categories.push({slug: `platform:${p.name}`, title: `📍 ${p.name}`});
      }
      
      const seen = new Set();
      for (const op of data.data?.operatingList || []) {
        if (op.type === 'SUBJECTS_MOVIE' && op.title && !seen.has(op.title)) {
          seen.add(op.title);
          categories.push({slug: `genre:${op.title}`, title: `🎬 ${op.title}`});
        }
      }
      
      const resp = new Response(JSON.stringify({ok: true, items: categories}), {
        headers: {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300'},
      });
      try { await caches.default.put(cacheKey, resp.clone()); } catch {}
      return resp;
    }
    
    let apiItems = [];
    
    if (cat.startsWith('platform:')) {
      const platform = cat.replace('platform:', '');
      const r = await fetch(`https://h5-api.aoneroom.com/wefeed-h5api-bff/platform/play-list?page=${page}&perPage=24&platform=${encodeURIComponent(platform)}`, { headers, cf: { cacheTtl: 300, cacheEverything: true } });
      if (r.ok) {
        const data = await r.json();
        apiItems = data.data?.items || [];
      }
    } else if (cat === 'trending') {
      const r = await fetch(`https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/trending?page=${page}&perPage=24`, { headers, cf: { cacheTtl: 300, cacheEverything: true } });
      if (r.ok) {
        const data = await r.json();
        apiItems = data.data?.subjectList || [];
      }
    } else if (cat === 'movie' || cat === 'tv' || cat === 'anime' || cat === 'drama' || cat === 'series') {
      const r = await fetch(`https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/trending?page=${page}&perPage=50`, { headers, cf: { cacheTtl: 300, cacheEverything: true } });
      if (r.ok) {
        const data = await r.json();
        let all = data.data?.subjectList || [];
        
        if (cat === 'anime') all = all.filter(m => (m.genre || '').toLowerCase().includes('anime') || (m.title || '').toLowerCase().includes('anime'));
        else if (cat === 'tv' || cat === 'series') all = all.filter(m => m.subjectType === 2 || (m.season && m.season > 0));
        else if (cat === 'movie') all = all.filter(m => m.subjectType !== 2);
        else if (cat === 'drama') all = all.filter(m => (m.genre || '').toLowerCase().includes('drama'));
        
        apiItems = all;
      }
    } else if (cat.startsWith('genre:')) {
      const genre = cat.replace('genre:', '');
      const r = await fetch(`https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/trending?page=${page}&perPage=50`, { headers, cf: { cacheTtl: 300, cacheEverything: true } });
      if (r.ok) {
        const data = await r.json();
        apiItems = (data.data?.subjectList || []).filter(m => (m.genre || '').toLowerCase().includes(genre.toLowerCase()));
      }
    }
    
    const items = apiItems.map(m => {
      const detailPath = m.detailPath || 'movie';
      return {
        slug: `${detailPath}?id=${m.subjectId}`,
        title: m.title || 'Unknown',
        poster: m.cover?.url || '',
        year: m.releaseDate?.substring(0, 4) || '',
        quality: 'HD',
        language: m.subtitles ? 'Multi-Sub' : '',
        genre: m.genre || '',
        rating: m.imdbRatingValue || '',
        type: m.subjectType === 2 ? 'TV' : 'Movie',
      };
    });
    
    const resp = new Response(JSON.stringify({ok: true, page: parseInt(page), items, hasMore: items.length >= 20}), {
      headers: {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300'},
    });
    if (items.length > 0) {
      try { await caches.default.put(cacheKey, resp.clone()); } catch {}
    }
    return resp;
  } catch (err) {
    return new Response(JSON.stringify({ok: false, error: err.message, items: []}), {
      status: 200,
      headers: {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*'},
    });
  }
}

