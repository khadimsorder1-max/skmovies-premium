/**
 * HDHub4u API Client (frontend) — v2
 * ----------------------------------
 * Drop-in module that wraps every /api/hdhub4u/* endpoint behind a
 * clean async API. Designed to work on plain Cloudflare Pages (no bundler).
 *
 * v2 additions (req #2, #3, #5):
 *   - resolveStream() now returns mxIntent + vlcUrl + kmIntent + playerUrl
 *   - playerUrl() returns /player.html?… (our ad-free player)
 *   - All endpoints transparently use server-side KV + Cache API caching
 *   - localStorage cache for resolved streams (24h TTL)
 *
 * Usage:
 *   <script src="/js/hdhub4u-client.js"></script>
 *   <script>
 *     const api = new HDHub4uClient();        // auto-detects /api/hdhub4u
 *     const list = await api.list({ type: 'home', page: 1 });
 *     const movie = await api.movie({ slug: list.movies[0].slug });
 *     const stream = await api.resolveStream(movie.streams[0].url);
 *     // stream.playerUrl -> "/player.html?url=…"
 *     // stream.mxIntent  -> "intent://…#Intent;package=com.mxtech.videoplayer.ad;…;end"
 *     // stream.vlcUrl    -> "vlc://https://…"
 *   </script>
 */
(function (global) {
  'use strict';

  const DEFAULT_BASE = '/api/hdhub4u';
  const LS_STREAM_PREFIX = 'hdhub4u:stream:';
  const LS_STREAM_TTL = 24 * 60 * 60 * 1000; // 24h
  const LS_HOST_KEY = 'hdhub4u:host';
  const LS_HOST_TTL = 5 * 60 * 1000; // 5 min — match server in-isolate cache

  class HDHub4uClient {
    constructor(base = DEFAULT_BASE) {
      this.base = base.replace(/\/$/, '');
      this._hostCache = null;
      this._hostCacheTs = 0;
    }

    /** Fetch JSON helper with query-string builder. */
    async _get(path, params = {}) {
      const url = new URL(this.base + path, location.origin);
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      }
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!r.ok) {
        let msg;
        try { msg = (await r.json()).message || r.statusText; }
        catch (_) { msg = r.statusText; }
        throw new Error('HDHub4u API ' + r.status + ': ' + msg);
      }
      return r.json();
    }

    /** GET /host — returns { host, landing, resolvers, ts }. Cached locally. */
    async host(force = false) {
      // Try localStorage first (cross-page).
      if (!force) {
        try {
          const ls = JSON.parse(localStorage.getItem(LS_HOST_KEY) || 'null');
          if (ls && (Date.now() - ls._ts) < LS_HOST_TTL) {
            this._hostCache = ls;
            this._hostCacheTs = ls._ts;
            return ls;
          }
        } catch (_) {}
      }
      // In-memory.
      if (!force && this._hostCache && (Date.now() - this._hostCacheTs) < LS_HOST_TTL) {
        return this._hostCache;
      }
      const j = await this._get('/host');
      j._ts = Date.now();
      this._hostCache = j;
      this._hostCacheTs = j._ts;
      try { localStorage.setItem(LS_HOST_KEY, JSON.stringify(j)); } catch (_) {}
      return j;
    }

    /** GET /list — fetch a movie list. */
    list({ type = 'home', page = 1, category = '', q = '' } = {}) {
      return this._get('/list', { type, page, category, q });
    }

    /** GET /movie — fetch single-movie detail. */
    movie({ slug = '', url = '' } = {}) {
      return this._get('/movie', { slug, url });
    }

    /** GET /categories */
    categories() { return this._get('/categories'); }

    /**
     * GET /stream — resolve player URL to direct video / iframe.
     * Per req #5: results cached in localStorage (24h) so we don't
     * re-hit the Worker on repeat plays of the same movie.
     */
    async resolveStream(playerUrl) {
      // localStorage cache (saves a Worker request entirely).
      try {
        const ls = JSON.parse(localStorage.getItem(LS_STREAM_PREFIX + playerUrl) || 'null');
        if (ls && (Date.now() - ls._ts) < LS_STREAM_TTL) {
          return ls;
        }
      } catch (_) {}

      const info = await this._get('/stream', { url: playerUrl, mode: 'direct' });
      info._ts = Date.now();
      try { localStorage.setItem(LS_STREAM_PREFIX + playerUrl, JSON.stringify(info)); } catch (_) {}
      return info;
    }

    /** Force-refresh the stream resolution (bypass caches). */
    async resolveStreamFresh(playerUrl) {
      try { localStorage.removeItem(LS_STREAM_PREFIX + playerUrl); } catch (_) {}
      return this._get('/stream', { url: playerUrl, mode: 'direct' });
    }

    /**
     * Build the URL of our ad-free player page for a direct video URL.
     * Used when we already have a playable URL (e.g. from movie.downloads).
     */
    playerUrl(directUrl, opts = {}) {
      const u = new URL('/player.html', location.origin);
      u.searchParams.set('url', directUrl);
      u.searchParams.set('raw', '1');
      if (opts.title)  u.searchParams.set('title', opts.title);
      if (opts.poster) u.searchParams.set('poster', opts.poster);
      if (opts.source) u.searchParams.set('source', opts.source);
      return u.toString();
    }

    /**
     * Build the URL of the sandboxed-iframe wrapper page for a player URL.
     * (mode=iframe endpoint)
     */
    iframeStreamUrl(playerUrl, title = 'HDHub4u Player') {
      const u = new URL(this.base + '/stream', location.origin);
      u.searchParams.set('url', playerUrl);
      u.searchParams.set('mode', 'iframe');
      u.searchParams.set('title', title);
      return u.toString();
    }

    /** Build a CORS-safe proxy URL for a direct video / image. */
    proxyUrl(targetUrl) {
      const u = new URL(this.base + '/proxy', location.origin);
      u.searchParams.set('url', targetUrl);
      return u.toString();
    }

    /** Convenience: search shortcut. */
    search(q, page = 1) { return this.list({ type: 'search', q, page }); }

    /** Convenience: category browse shortcut. */
    category(slug, page = 1) { return this.list({ type: 'category', category: slug, page }); }

    /** Convenience: homepage pagination shortcut. */
    home(page = 1) { return this.list({ type: 'home', page }); }

    /**
     * Build MX Player intent:// URI for a direct URL (client-side).
     * Useful when you have a direct URL but didn't call resolveStream().
     */
    buildMxIntent(directUrl, title = 'HDHub4u') {
      try {
        const u = new URL(directUrl);
        return 'intent://' + u.host + u.pathname + u.search +
               '#Intent;package=com.mxtech.videoplayer.ad;S.title=' +
               encodeURIComponent(title) + ';end';
      } catch (_) { return ''; }
    }

    /** Build VLC deep link. */
    buildVlcUrl(directUrl) { return 'vlc://' + directUrl; }
  }

  global.HDHub4uClient = HDHub4uClient;
})(window);
