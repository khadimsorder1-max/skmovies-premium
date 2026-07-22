/**
 * HDHub4u Cloudflare Pages Functions — Shared Library (v2)
 * --------------------------------------------------------
 * Upgraded to address user requirement #1:
 *   "Hdhud4u er hosting domain change korey kichudin por por,
 *    hosting jtoi change koruk landing page theke to dhuka jay
 *    update tai tai eita kheyal rekhe update kore dio"
 *
 * Strategy (in order):
 *   1. ENV.HDHUB4U_FORCE_HOST  — admin override (Cloudflare dashboard)
 *   2. KV cache HDHUB4U_HOST   — last-known-good host (TTL 6h)
 *   3. Cache API (caches.open) — last-known-good host (TTL 6h, edge)
 *   4. Live landing page fetch — hdhub4u.med → follow JS / meta / link
 *   5. CDN resolvers race       — first non-empty `c` field wins
 *   6. Hard-coded fallback list — try each, first 200 wins
 *
 * Also exposes:
 *   - fetchHTML(url, opts)     fetches HTML with a real browser UA
 *   - corsHeaders()            CORS pre-flight helpers
 *   - jsonResponse(obj, code)  uniform JSON response with CORS + cache
 *   - HTMLParser               tiny DOM-free HTML extractor (regex based)
 *   - decodeHTMLEntities()     &amp; -> &
 *   - kvGet / kvSet            Cloudflare KV helpers (no-op if unbound)
 *   - cacheGet / cacheSet      Cache API helpers (always available)
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

/**
 * Landing page — always reachable even when the movie host changes.
 * The landing page runs a tiny script that races the host resolvers
 * below and redirects to whichever mirror is currently live.
 */
const LANDING_PAGE = 'https://hdhub4u.med/';

/**
 * CDN endpoints that return { h, c, t } JSON with base64-encoded host info.
 * Order matters only when "first wins" tiebreakers happen — but we use
 * Promise.any so the fastest valid response wins.
 */
const HOST_RESOLVERS = [
  'https://h4.suncdn.org/host/',
  'https://points.topapii.com/host/',
  'https://ml.theapii.org/host/',
  'https://dns.pingora.fyi/v2/host',
  'https://hd4u.cdnassets.org/host/',
  'https://cdn1.theapii.org/host/',
];

/**
 * Hard fallbacks if every resolver is down AND the landing page can't
 * be fetched. These get re-checked every invocation but cached for 5 min.
 */
const FALLBACK_HOSTS = [
  'https://new3.hdhub4u.cl/',
  'https://new4.hdhub4u.cl/',
  'https://new5.hdhub4u.cl/',
  'https://hdhub4u.ag/',
  'https://hdhub4u.download/',
  'https://hdhub4u.kim/',
  'https://hdhub4u.lol/',
  'https://hdhub4u.com/',
  'https://hdhub4u.tours/',
  'https://hdhub4u.yachts/',
];

/** KV namespace binding name (configured in wrangler.toml / Pages dashboard). */
const KV_NAMESPACE = 'HDHUB4U_CACHE';
const KV_HOST_KEY = 'ACTIVE_HOST';
const HOST_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** In-memory cache so we don't re-resolve on every request within a single isolate. */
let _cachedHost = null; // { host, ts }
const HOST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes (in-isolate)

// ------------------------------------------------------------------
// KV helpers — graceful no-op if the binding is missing.
// On Cloudflare Pages Functions, `env` is passed to onRequest(context).
// We can't access it from a sync helper, so we stash the latest env
// seen by onRequest via `setEnv(env)`.
// ------------------------------------------------------------------
let _env = null;
function setEnv(env) { _env = env || null; }
function getEnv() { return _env; }

async function kvGet(key) {
  try {
    const env = getEnv();
    if (!env || !env[KV_NAMESPACE]) return null;
    const v = await env[KV_NAMESPACE].get(key);
    if (!v) return null;
    try { return JSON.parse(v); } catch (_) { return v; }
  } catch (_) { return null; }
}

async function kvSet(key, value, ttlSeconds) {
  try {
    const env = getEnv();
    if (!env || !env[KV_NAMESPACE]) return false;
    const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
    await env[KV_NAMESPACE].put(key, JSON.stringify(value), opts);
    return true;
  } catch (_) { return false; }
}

// ------------------------------------------------------------------
// Cache API helpers — always available in Workers / Pages Functions.
// We use a dedicated cache namespace so it doesn't collide with the
// default request cache.
// ------------------------------------------------------------------
const CACHE_API_NAME = 'hdhub4u-host-cache';

async function cacheGet(key) {
  try {
    const cache = await caches.open(CACHE_API_NAME);
    const r = await cache.match(new Request('https://cache.local/' + key));
    if (!r) return null;
    try { return await r.json(); } catch (_) { return null; }
  } catch (_) { return null; }
}

async function cacheSet(key, value, ttlSeconds) {
  try {
    const cache = await caches.open(CACHE_API_NAME);
    const resp = new Response(JSON.stringify(value), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=' + (ttlSeconds || 3600),
      },
    });
    await cache.put(new Request('https://cache.local/' + key), resp);
    return true;
  } catch (_) { return false; }
}

// ------------------------------------------------------------------
// Main resolver
// ------------------------------------------------------------------

/**
 * Fetch the landing page and look for hints about the current mirror.
 * Landing page strategies:
 *   - <meta http-equiv="refresh" content="0;url=https://new3.hdhub4u.cl/">
 *   - <script>...window.location.href='https://...'</script>
 *   - <a href="https://..." class="enter">Enter</a>
 *   - First link containing "hdhub4u" that's not the landing domain itself
 */
async function probeLandingPage() {
  try {
    const html = await fetchHTML(LANDING_PAGE, { timeoutMs: 6000 });
    const landingHost = new URL(LANDING_PAGE).host;

    // 1. <meta http-equiv="refresh" content="0;url=...">
    const metaM = html.match(
      /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=(https?:\/\/[^"'\s>]+)/i
    );
    if (metaM && !metaM[1].includes(landingHost)) {
      return normalizeHost(metaM[1]);
    }

    // 2. window.location = "https://..." (any variant)
    const jsLocM = html.match(
      /window\.location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i
    );
    if (jsLocM && !jsLocM[1].includes(landingHost)) {
      return normalizeHost(jsLocM[1]);
    }

    // 3. <a href="https://newX.hdhub4u.tld/" ...>Enter</a>
    const enterM = html.match(
      /<a[^>]+href=["'](https?:\/\/(?:new\d+\.)?hdhub4u\.[a-z]+\/?)["'][^>]*>(?:[\s\S]*?)<\/a>/i
    );
    if (enterM) return normalizeHost(enterM[1]);

    // 4. Any href containing "hdhub4u" but not the landing domain.
    //    Reject known spam/fake mirrors (.ms, .xyz, .top, .ru etc.)
    const anyM = html.match(/href=["'](https?:\/\/[^"']*hdhub4u\.[a-z]+\/?[^"']*)["']/i);
    if (anyM && !anyM[1].includes(landingHost) && !/\.ms(\/|$)/i.test(anyM[1])) {
      return normalizeHost(anyM[1]);
    }
  } catch (_) {}
  return null;
}

/** Race the CDN resolvers — first non-empty `c` field wins. */
async function raceResolvers() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);

    const race = Promise.any(
      HOST_RESOLVERS.map(async (url) => {
        const r = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept': 'application/json' },
          signal: controller.signal,
        });
        if (!r.ok) throw new Error('bad status ' + r.status);
        const j = await r.json();
        if (!j || !j.c) throw new Error('no c field');
        const decoded = atob(j.c).trim();
        if (!/^https?:\/\//.test(decoded)) throw new Error('bad decoded url');
        return decoded;
      })
    );

    const host = await race.finally(() => clearTimeout(timeout));
    if (host) return normalizeHost(host);
  } catch (_) {}
  return null;
}

/** Verify a host is actually reachable. */
async function isHostAlive(host) {
  try {
    const r = await fetch(host, {
      method: 'GET',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });
    // Accept 200, 301, 302, 304 — anything but 4xx/5xx.
    return r.ok || (r.status >= 300 && r.status < 400);
  } catch (_) {
    return false;
  }
}

function normalizeHost(host) {
  if (!host) return null;
  let h = host.trim();
  // Reject obvious spam/fake mirrors that scrape "hdhub4u" branding
  // but serve no real content (e.g. .ms safepages).
  if (/\.ms(\/|$)/i.test(h) || /\.xyz(\/|$)/i.test(h) ||
      /\.top(\/|$)/i.test(h) || /\.ru(\/|$)/i.test(h)) {
    return null;
  }
  // Strip trailing path / query.
  try {
    const u = new URL(h);
    h = u.origin + '/';
  } catch (_) {
    if (!h.endsWith('/')) h += '/';
  }
  return h;
}

/** Guard against spam/fake mirror hosts (returned by poisoned caches). */
function isSafeHost(host) {
  if (!host) return false;
  if (/\.ms(\/|$)/i.test(host) || /\.xyz(\/|$)/i.test(host) ||
      /\.top(\/|$)/i.test(host) || /\.ru(\/|$)/i.test(host)) {
    return false;
  }
  return /^https?:\/\/(?:new\d+\.)?hdhub4u\.[a-z]+\/$/i.test(host);
}

/**
 * Resolve the current active HDHub4u host.
 * Order: ENV override → KV cache → Cache API → landing page → resolvers → fallbacks.
 */
async function resolveActiveHost() {
  // 1. ENV override (admin pin)
  const env = getEnv();
  const forced = env && (env.HDHUB4U_FORCE_HOST || env.HDHUB4U_FORCE);
  if (forced) return normalizeHost(forced) || FALLBACK_HOSTS[0];

  // 2. In-isolate memory cache
  if (_cachedHost && (Date.now() - _cachedHost.ts) < HOST_CACHE_TTL) {
    return _cachedHost.host;
  }

  // 3. KV cache (long-TTL, cross-region) — reject poisoned/spam entries.
  try {
    const kvHit = await kvGet(KV_HOST_KEY);
    if (kvHit && isSafeHost(kvHit.host) && (Date.now() - (kvHit.ts || 0)) < HOST_TTL_MS) {
      // Trust KV but optionally verify with a HEAD request in background.
      _cachedHost = { host: kvHit.host, ts: Date.now() };
      // Background refresh if KV value is older than 1h.
      if (Date.now() - (kvHit.ts || 0) > 60 * 60 * 1000) {
        eventWaitUntil(refreshHostAsync());
      }
      return kvHit.host;
    }
  } catch (_) {}

  // 4. Cache API (edge cache, also long-TTL) — reject poisoned/spam entries.
  try {
    const cacheHit = await cacheGet(KV_HOST_KEY);
    if (cacheHit && isSafeHost(cacheHit.host) && (Date.now() - (cacheHit.ts || 0)) < HOST_TTL_MS) {
      _cachedHost = { host: cacheHit.host, ts: Date.now() };
      if (Date.now() - (cacheHit.ts || 0) > 60 * 60 * 1000) {
        eventWaitUntil(refreshHostAsync());
      }
      return cacheHit.host;
    }
  } catch (_) {}

  // 5. Fresh resolution: landing page + resolvers race in parallel.
  const [landingHost, resolverHost] = await Promise.allSettled([
    probeLandingPage(),
    raceResolvers(),
  ]);
  const landing  = landingHost.status  === 'fulfilled' ? landingHost.value  : null;
  const resolver = resolverHost.status === 'fulfilled' ? resolverHost.value : null;

  // Prefer the CDN resolver result — it is authoritative (signed `c` field)
  // and far less likely to point at a spam/fake mirror than a scraped
  // landing-page link. Only fall back to the landing probe when the
  // resolver yields nothing.
  let host = resolver || landing || null;
  if (!isSafeHost(host)) host = null;

  // 6. Verify the resolved host is alive; otherwise try fallbacks.
  if (host) {
    if (!(await isHostAlive(host))) host = null;
  }
  if (!host) {
    for (const fb of FALLBACK_HOSTS) {
      if (await isHostAlive(fb)) { host = fb; break; }
    }
  }
  if (!host) host = FALLBACK_HOSTS[0];

  // Persist to caches.
  _cachedHost = { host, ts: Date.now() };
  eventWaitUntil(Promise.all([
    kvSet(KV_HOST_KEY, { host, ts: Date.now() }, Math.floor(HOST_TTL_MS / 1000)),
    cacheSet(KV_HOST_KEY, { host, ts: Date.now() }, Math.floor(HOST_TTL_MS / 1000)),
  ]));

  return host;
}

/**
 * Force-refresh the host in the background.
 * Called when KV / cache values are stale.
 */
async function refreshHostAsync() {
  try {
    const landing  = await probeLandingPage();
    const resolver = await raceResolvers();
    let host = landing || resolver || null;
    if (host && !(await isHostAlive(host))) host = null;
    if (!host) {
      for (const fb of FALLBACK_HOSTS) {
        if (await isHostAlive(fb)) { host = fb; break; }
      }
    }
    if (!host) return;
    _cachedHost = { host, ts: Date.now() };
    await Promise.all([
      kvSet(KV_HOST_KEY, { host, ts: Date.now() }, Math.floor(HOST_TTL_MS / 1000)),
      cacheSet(KV_HOST_KEY, { host, ts: Date.now() }, Math.floor(HOST_TTL_MS / 1000)),
    ]);
  } catch (_) {}
}

/**
 * Schedule a promise to run without blocking the response.
 * Falls back to a no-op if ctx.waitUntil is not available.
 */
let _waitUntilFn = null;
function setWaitUntil(fn) { _waitUntilFn = fn; }
function eventWaitUntil(promise) {
  if (_waitUntilFn) _waitUntilFn(promise);
  else { try { promise.catch(() => {}); } catch (_) {} }
}

// ------------------------------------------------------------------
// Fetch helpers
// ------------------------------------------------------------------

/** Fetch HTML text with a browser-like UA. */
async function fetchHTML(url, { referer, timeoutMs = 15000 } = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (referer) headers['Referer'] = referer;

  const r = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return await r.text();
}

/** Standard CORS headers so the front-end can call us from any origin. */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, code = 200, cacheSeconds = 60) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=' + cacheSeconds,
      ...corsHeaders(),
    },
  });
}

function htmlResponse(html, code = 200) {
  return new Response(html, {
    status: code,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

/** Decode the most common HTML entities (&amp; &lt; &gt; &#39; &quot; &nbsp;). */
function decodeHTMLEntities(s = '') {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/**
 * Tiny regex-based HTML extractor for use inside Workers (no DOMParser).
 * Methods are intentionally permissive — these sites change markup often.
 */
class HTMLParser {
  constructor(html) { this.html = html || ''; }

  /** Get the contents of <title>…</title> (decoded). */
  getTitle() {
    const m = this.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? decodeHTMLEntities(m[1].trim()) : '';
  }

  /** Get <meta name="description" content="…"> */
  getMeta(name) {
    const re = new RegExp(
      '<meta[^>]+name=["\']' + name + '["\'][^>]*content=["\']([\\s\\S]*?)["\']',
      'i'
    );
    const m = this.html.match(re);
    if (m) return decodeHTMLEntities(m[1]);
    const re2 = new RegExp(
      '<meta[^>]+content=["\']([\\s\\S]*?)["\'][^>]+name=["\']' + name + '["\']',
      'i'
    );
    const m2 = this.html.match(re2);
    return m2 ? decodeHTMLEntities(m2[1]) : '';
  }

  /** Get <meta property="og:…" content="…"> */
  getOG(prop) {
    const re = new RegExp(
      '<meta[^>]+property=["\']og:' + prop + '["\'][^>]*content=["\']([\\s\\S]*?)["\']',
      'i'
    );
    const m = this.html.match(re);
    if (m) return decodeHTMLEntities(m[1]);
    const re2 = new RegExp(
      '<meta[^>]+content=["\']([\\s\\S]*?)["\'][^>]+property=["\']og:' + prop + '["\']',
      'i'
    );
    const m2 = this.html.match(re2);
    return m2 ? decodeHTMLEntities(m2[1]) : '';
  }

  /** Find all <article> blocks (movie cards). */
  getArticles() {
    const out = [];
    const re = /<article[\s\S]*?<\/article>/gi;
    let m;
    while ((m = re.exec(this.html)) !== null) out.push(m[0]);
    return out;
  }

  /** Extract first href from an HTML fragment. */
  static firstHref(html) {
    const m = html.match(/href=["']([^"']+)["']/i);
    return m ? m[1] : '';
  }

  /** Extract first src (or data-src) from an HTML fragment. */
  static firstSrc(html, preferLazy = true) {
    if (preferLazy) {
      const m = html.match(/data-(?:src|original|lazy|lazy-src)=["']([^"']+)["']/i);
      if (m) return m[1];
    }
    const m = html.match(/src=["']([^"']+)["']/i);
    return m ? m[1] : '';
  }

  /** Strip all tags, collapse whitespace, decode entities. */
  static stripTags(html = '') {
    return decodeHTMLEntities(
      html.replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
    ).trim();
  }
}

module.exports = {
  UA,
  LANDING_PAGE,
  HOST_RESOLVERS,
  FALLBACK_HOSTS,
  KV_NAMESPACE,
  resolveActiveHost,
  fetchHTML,
  corsHeaders,
  jsonResponse,
  htmlResponse,
  decodeHTMLEntities,
  HTMLParser,
  setEnv,
  getEnv,
  setWaitUntil,
  eventWaitUntil,
  kvGet,
  kvSet,
  cacheGet,
  cacheSet,
};
