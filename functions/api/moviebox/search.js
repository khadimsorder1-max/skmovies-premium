export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || url.searchParams.get('keyword') || url.searchParams.get('query') || '';
  if (!q) return new Response(JSON.stringify({ok: true, items: []}), {headers: {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*'}});
  
  const cacheKey = new Request(request.url, { method: 'GET' });
  try {
    const c = await caches.default.match(cacheKey);
    if (c) return c;
  } catch {}
  
  try {
    const r = await fetch(`https://moviebox.ph/wefeed-h5api-bff/subject/trending?page=1&perPage=100`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://moviebox.ph',
        'Referer': 'https://moviebox.ph/',
        'Accept': 'application/json'
      },
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    
    const query = q.toLowerCase();
    const items = (data.data?.subjectList || [])
      .filter(m => (m.title || '').toLowerCase().includes(query) || (m.genre || '').toLowerCase().includes(query))
      .map(m => {
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
        };
      });
    
    const resp = new Response(JSON.stringify({ok: true, items}), {
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

