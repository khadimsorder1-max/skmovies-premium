/**
 * /api/fojik/download
 * -------------------
 * Resolves a Fojik FU/FN download form to get the actual redirect URL.
 * 
 * Usage: GET /api/fojik/download?action=<url>&fu=<base64>&fn=<filename>
 * Returns: { ok: true, url: "https://actual-download-url" }
 * 
 * How it works:
 * 1. POSTs FU and FN to the form action URL
 * 2. Follows the redirect chain
 * 3. Returns the final URL
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' } });
  }

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action') || '';
  const fu = url.searchParams.get('fu') || '';
  const fn_ = url.searchParams.get('fn') || '';

  if (!action || !fu) {
    return json({ ok: false, error: 'Missing action or fu parameters' }, 400);
  }

  try {
    // POST to the form action with FU and FN fields
    const formData = new URLSearchParams();
    formData.append('FU', fu);
    formData.append('FN', fn_);

    const resp = await fetch(action, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://fojik.site/',
        'Origin': 'https://fojik.site',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      body: formData.toString(),
      redirect: 'follow',
    });

    // If we get a redirect, the final URL is our download link
    const finalUrl = resp.url;
    const status = resp.status;

    if (status >= 400) {
      return json({ ok: false, error: `Server returned ${status}` }, 502);
    }

    // Check if the response is HTML (intermediate page) or actual file
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      // Try to extract redirect from HTML
      const html = await resp.text();
      
      // Look for meta refresh, window.location, or direct link
      const metaM = html.match(/<meta[^>]+http-equiv="refresh"[^>]+content="[^"]*url=([^"]+)"/i);
      const jsLocM = html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i)
        || html.match(/location\.replace\(["']([^"']+)["']\)/i);
      const linkM = html.match(/href="(https?:\/\/[^"]*(?:gdrive|drive\.google|hubcloud|filepress|busycdn|gdflix|savelinks)[^"]*)"/i);

      const extractedUrl = (metaM && metaM[1].trim()) || (jsLocM && jsLocM[1]) || (linkM && linkM[1]);
      
      if (extractedUrl) {
        return json({ ok: true, url: extractedUrl, method: 'extracted', finalUrl });
      }

      // Return the final URL from redirect chain
      if (finalUrl && !finalUrl.includes('fojik') && finalUrl !== action) {
        return json({ ok: true, url: finalUrl, method: 'redirect', status });
      }

      // Return the form action URL as-is (user will see the download page)
      return json({ ok: true, url: finalUrl || action, method: 'page', html_preview: html.slice(0, 200) });
    }

    // Binary/file response — this is the direct download
    return json({ ok: true, url: finalUrl, method: 'direct', contentType: ct });

  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}
