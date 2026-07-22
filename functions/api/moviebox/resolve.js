export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return new Response(JSON.stringify({ok: false, error: 'Missing slug'}), {headers: {'Content-Type': 'application/json; charset=utf-8'}});
  
  try {
    const [detailPath, idPart] = slug.split('?id=');
    const subjectId = idPart || slug;
    const pageUrl = `https://moviebox.ph/moviedetail/${detailPath}?id=${subjectId}&type=/movie/detail`;
    
    const r = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    
    let videoUrl = null;
    const m = html.match(/"contentUrl":"([^"]+)"/);
    if (m) videoUrl = m[1].replace(/\\\//g, '/');
    if (!videoUrl) {
      const m2 = html.match(/https:\/\/[a-z0-9.]*aoneroom\.com\/[^"'\s\\]+\.mp4/);
      if (m2) videoUrl = m2[0].replace(/\\\//g, '/');
    }
    
    return new Response(JSON.stringify({ok: !!videoUrl, streamUrl: videoUrl}), {
      headers: {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*'},
    });
  } catch (err) {
    return new Response(JSON.stringify({ok: false, error: err.message, streamUrl: null}), {
      status: 500,
      headers: {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*'},
    });
  }
}
