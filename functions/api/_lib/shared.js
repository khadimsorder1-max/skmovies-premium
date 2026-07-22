/* Shared utilities for Cloudflare Pages Functions */
export const CONSTANTS = {
  MLSBD_BASE: 'https://mlsbd.co',
  FDM_BASE: 'https://freedrivemovie.cyou',
  HDHUB4U_LANDING: 'https://hdhub4u.med/',
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  BROWSER_HEADERS: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  },
  FETCH_TIMEOUT_MS: 12000,
  FETCH_RETRIES: 2,
  CACHE_TTL: 1800,
  HOT_CACHE_TTL: 600,
  IMG_CACHE_TTL: 86400 * 7,
  MAX_PAGES: 100,
};
export const FILTERS = new Set([
  '1080p', '720p', '480p', '4k',
  'bengali', 'hindi', 'english', 'dual',
  'web-dl', 'bluray', 'hdtc',
  'netflix', 'amazon', 'hotstar', 'zee5', 'hoichoi',
  'south-indian', 'south-indian-hindi',
]);

export function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=0, s-maxage=300',
    ...extra,
  };
}
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(extraHeaders) },
  });
}
export function errorResponse(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function fetchText(url, options = {}) {
  const { headers = {}, timeoutMs = CONSTANTS.FETCH_TIMEOUT_MS, retries = CONSTANTS.FETCH_RETRIES, accept, referer } = options;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        headers: {
          ...CONSTANTS.BROWSER_HEADERS,
          ...(accept ? { Accept: accept } : {}),
          ...(referer ? { Referer: referer } : {}),
          ...(referer && new URL(url).origin === new URL(referer).origin ? { 'Sec-Fetch-Site': 'same-origin' } : { 'Sec-Fetch-Site': 'cross-site' }),
          ...headers,
        },
        signal: ctrl.signal,
        redirect: 'follow',
        cf: { cacheTtl: 60, cacheEverything: true, scrapeShield: false },
      });
      if (!r.ok) {
        if (attempt < retries && r.status >= 500) { await sleep(500 * (attempt + 1)); continue; }
        return { ok: false, status: r.status, text: '' };
      }
      return { ok: true, status: r.status, text: await r.text() };
    } catch (e) {
      lastErr = String(e);
      clearTimeout(t);
      if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
      return { ok: false, status: 0, text: '', error: lastErr };
    } finally { clearTimeout(t); }
  }
  return { ok: false, status: 0, text: '', error: lastErr };
}

export async function fetchBinary(url, options = {}) {
  const { headers = {}, timeoutMs = 15000, referer } = options;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        ...CONSTANTS.BROWSER_HEADERS,
        'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
        ...(referer ? { Referer: referer } : {}),
        ...headers,
      },
      signal: ctrl.signal,
      redirect: 'follow',
      cf: { cacheTtl: 3600, cacheEverything: true, scrapeShield: false },
    });
    if (!r.ok) return { ok: false, status: r.status, body: null, contentType: '' };
    const body = await r.arrayBuffer();
    return { ok: true, status: r.status, body, contentType: r.headers.get('Content-Type') || '' };
  } catch (e) { return { ok: false, status: 0, body: null, contentType: '', error: String(e) }; }
  finally { clearTimeout(t); }
}

export function b64decode(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return atob(s + pad);
}

export function unescapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;|&#39;|&#8217;/g, "'")
    .replace(/&#038;/g, '&').replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"').replace(/&#8230;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

export async function cacheGet(env, key) {
  if (!env || !env.CACHE) return null;
  try { const v = await env.CACHE.get(key, { type: 'json' }); return v || null; } catch { return null; }
}
export async function cacheSet(env, key, value, ttl) {
  if (!env || !env.CACHE) return;
  try { await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl }); } catch {}
}
