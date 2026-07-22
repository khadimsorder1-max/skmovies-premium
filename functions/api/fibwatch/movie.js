export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (!slug) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing slug' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const watchUrl = slug.startsWith('http') ? slug : `https://fibwatch.art/watch/${slug}`;
    
    // Fetch via internal proxy / fetch
    let html = '';
    try {
      const r = await fetch(watchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        cf: { cacheTtl: 600, cacheEverything: true }
      });
      if (r.ok) html = await r.text();
    } catch {}

    if (!html || html.length < 10000) {
      // Fallback to proxy
      const proxyUrl = `${url.origin}/api/proxy?u=${encodeURIComponent(watchUrl)}`;
      const pr = await fetch(proxyUrl);
      if (pr.ok) html = await pr.text();
    }

    if (!html) throw new Error('Failed to load Fibwatch movie page');

    let title = 'Unknown';
    const tm = html.match(/<title>([^<]+)<\/title>/i);
    if (tm) title = tm[1].replace(/Fibwatch.*$/i, '').replace(/Watch\s*/i, '').trim();

    let poster = '';
    const pm = html.match(/poster="([^"]+)"/i) || html.match(/<img[^>]+src="(https:\/\/[a-z0-9.-]+\.b-cdn\.net\/[^"]+)"/i);
    if (pm) poster = pm[1];

    let synopsis = '';
    const sm = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    if (sm) synopsis = sm[1];

    const videoUrls = [];
    const sourceRe = /<source\s+src="([^"]+)"/gi;
    let vm;
    while ((vm = sourceRe.exec(html)) !== null) {
      if (vm[1].includes('b-cdn.net') && !videoUrls.includes(vm[1])) videoUrls.push(vm[1]);
    }

    if (videoUrls.length === 0) {
      const cdnRe = /https?:\/\/[a-z0-9.-]+\.b-cdn\.net\/s3\/upload\/videos\/[^\s"'\\]+\.(?:mkv|mp4|m3u8)/gi;
      let cm;
      while ((cm = cdnRe.exec(html)) !== null) {
        if (!videoUrls.includes(cm[0])) videoUrls.push(cm[0]);
      }
    }

    const downloadLinks = videoUrls.map((u, i) => {
      let b64;
      try { b64 = btoa(u); } catch (_) { b64 = btoa(unescape(encodeURIComponent(u))); }
      b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const proxiedVideoUrl = `${url.origin}/api/proxy?u=${b64}`;

      return {
        label: videoUrls.length > 1 ? `Quality ${i + 1} (Direct MKV Stream)` : 'Direct MKV Stream (Bunny CDN)',
        url: proxiedVideoUrl,
        savelinks_url: proxiedVideoUrl,
        size: u.includes('1080p') ? '1080p' : u.includes('720p') ? '720p' : 'HD',
      };
    });

    const streamUrl = downloadLinks[0] ? downloadLinks[0].url : null;

    const result = {
      ok: true,
      slug,
      title,
      poster,
      synopsis,
      streamUrl,
      downloadLinks,
      downloads: downloadLinks,
      episodes: [],
    };

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=600' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
