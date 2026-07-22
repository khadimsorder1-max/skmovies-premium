/**
 * HDHub4u — Generic KV + Cache API cache layer
 * --------------------------------------------
 * Used to persist resolved direct/stream URLs and movie metadata so we
 * don't burn Worker requests re-resolving the same URL on every visit.
 *
 * Per requirement #5:
 *   "Cloudflare worker use kortechi tao free tai jeno extra request
 *    korey request waste nah hoy + perdomance thik thake tai movie er
 *    direct link+stream link gulo ekbar extract hoiley oitar info
 *    google cloudstore/emn kono source e auto up korte chai jekhane
 *    kono issue hobi nah abar limit pera nah + fast response."
 *
 * Cache strategy (read-through):
 *   1. Check in-isolate Map cache (instant)
 *   2. Check Cloudflare KV (cross-region, sub-50ms)
 *   3. Check Cache API    (edge, sub-10ms)
 *   4. If miss → call fetcher(), then write back to all three layers
 *
 * TTLs:
 *   - Stream URLs:        7 days  (stream URLs are stable per-file)
 *   - Download URLs:      7 days  (same logic)
 *   - Movie metadata:     1 day   (posters/screenshots don't change)
 *   - List pages:         6 hours (new posts appear regularly)
 *   - Category list:      1 day
 *   - Active host:        6 hours (set in _lib.js)
 */
const {
  setEnv, getEnv, setWaitUntil,
  kvGet, kvSet, cacheGet, cacheSet,
  KV_NAMESPACE,
} = require('./_lib.js');

const TTL = {
  STREAM:     7 * 24 * 3600,
  DOWNLOAD:   7 * 24 * 3600,
  MOVIE:      24 * 3600,
  LIST:       6 * 3600,
  CATEGORY:   24 * 3600,
  HOST:       6 * 3600,
};

// In-isolate Map cache. Each Pages Function isolate lives for a few
// seconds to minutes, so this catches rapid repeat requests within the
// same isolate (e.g. image-grid lazy-loads).
const _mem = new Map();
function memGet(key) {
  const e = _mem.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > e.ttl * 1000) { _mem.delete(key); return null; }
  return e.value;
}
function memSet(key, value, ttl) {
  _mem.set(key, { value, ts: Date.now(), ttl });
  // Cap Map size to prevent unbounded growth within a long-lived isolate.
  if (_mem.size > 200) {
    const firstKey = _mem.keys().next().value;
    if (firstKey) _mem.delete(firstKey);
  }
}

/**
 * Read-through cache.
 *
 * @param {string} key      Cache key (use cacheKey() helpers below)
 * @param {function} fetcher  Async function that returns the fresh value
 * @param {number} ttlSec   TTL in seconds (use TTL.* constants)
 * @param {object} opts     { kv: bool=true, cacheApi: bool=true, mem: bool=true }
 * @returns {Promise<{ value, fromCache: 'mem'|'kv'|'cacheApi'|'fresh' }>}
 */
async function cached(key, fetcher, ttlSec, opts = {}) {
  const useMem     = opts.mem      !== false;
  const useKv      = opts.kv       !== false;
  const useCacheApi = opts.cacheApi !== false;

  // 1. Memory
  if (useMem) {
    const hit = memGet(key);
    if (hit !== null && hit !== undefined) {
      return { value: hit, fromCache: 'mem' };
    }
  }

  // 2. KV (cross-region)
  if (useKv) {
    try {
      const hit = await kvGet(key);
      if (hit !== null && hit !== undefined) {
        if (useMem) memSet(key, hit, ttlSec);
        return { value: hit, fromCache: 'kv' };
      }
    } catch (_) {}
  }

  // 3. Cache API (edge)
  if (useCacheApi) {
    try {
      const hit = await cacheGet(key);
      if (hit !== null && hit !== undefined) {
        if (useMem) memSet(key, hit, ttlSec);
        // Also backfill KV if Cache API had it but KV didn't.
        if (useKv) eventWaitUntilSafe(kvSet(key, hit, ttlSec));
        return { value: hit, fromCache: 'cacheApi' };
      }
    } catch (_) {}
  }

  // 4. Fresh fetch
  const value = await fetcher();
  if (value !== null && value !== undefined) {
    if (useMem) memSet(key, value, ttlSec);
    eventWaitUntilSafe(Promise.all([
      useKv ? kvSet(key, value, ttlSec) : Promise.resolve(),
      useCacheApi ? cacheSet(key, value, ttlSec) : Promise.resolve(),
    ]));
  }
  return { value, fromCache: 'fresh' };
}

/** Invalidate a single cache key across all layers. */
async function invalidate(key) {
  _mem.delete(key);
  const env = getEnv();
  try {
    if (env && env[KV_NAMESPACE]) {
      await env[KV_NAMESPACE].delete(key);
    }
  } catch (_) {}
  try {
    const cache = await caches.open('hdhub4u-host-cache');
    await cache.delete(new Request('https://cache.local/' + key));
  } catch (_) {}
}

// ---- Key builders --------------------------------------------------
function cacheKey(prefix, ...parts) {
  return prefix + ':' + parts
    .map((p) => String(p || '').replace(/[^a-zA-Z0-9._-]/g, '_'))
    .join('|');
}

function eventWaitUntilSafe(promise) {
  try { promise.catch(() => {}); } catch (_) {}
}

module.exports = {
  TTL,
  cached,
  invalidate,
  cacheKey,
  // Re-export env setters so callers only need to import one module.
  setEnv, getEnv, setWaitUntil,
};
