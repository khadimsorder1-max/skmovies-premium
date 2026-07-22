export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const page = url.searchParams.get('page') || '1';

  try {
    const targetUrl = `https://fibwatch.art/videos/category/5?page_id=${page}`;
    let html = '';
    try {
      const r = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      if (r.ok) html = await r.text();
    } catch {}

    if (!html || html.length < 10000) {
      const proxyUrl = `${url.origin}/api/proxy?u=${encodeURIComponent(targetUrl)}`;
      const pr = await fetch(proxyUrl);
      if (pr.ok) html = await pr.text();
    }

    const items = [];
    const cardRe = /<div class="video-latest-list[^"]*"\s+data-id="(\d+)"[^>]*>[\s\S]*?href="(https:\/\/fibwatch\.art\/watch\/[^"]+)"[\s\S]*?<img src="([^"]+)"\s+alt="([^"]+)"/gi;
    let m;
    while ((m = cardRe.exec(html)) !== null) {
      const watchUrl = m[2];
      const posterUrl = m[3];
      const title = m[4].trim();
      const slug = watchUrl.replace('https://fibwatch.art/watch/', '');
      items.push({
        slug,
        title,
        poster: posterUrl,
        quality: 'HD 720p',
        language: 'Hindi / Multi',
        year: '',
        sizes: [],
      });
    }

    return new Response(JSON.stringify({ ok: true, page: parseInt(page), items, hasMore: items.length >= 20 }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
