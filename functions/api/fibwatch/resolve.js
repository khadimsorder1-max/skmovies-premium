export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing url param' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    let b64;
    try { b64 = btoa(targetUrl); } catch (_) { b64 = btoa(unescape(encodeURIComponent(targetUrl))); }
    b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const proxyUrl = `/api/proxy?u=${b64}`;

    return new Response(JSON.stringify({
      ok: true,
      urls: [proxyUrl, targetUrl],
      hosts: [
        { host: 'Bunny CDN Direct', url: proxyUrl, text: 'Play via Thin Proxy (Ad-Free)' },
        { host: 'Original CDN', url: targetUrl, text: 'Original Bunny CDN' }
      ]
    }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
