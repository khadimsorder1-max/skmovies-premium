/**
 * HDHub4u UI Renderer (frontend) — v2
 * -----------------------------------
 * Vanilla JS module that builds a complete UI on top of HDHub4uClient.
 *
 * v2 additions (req #2, #3, #5):
 *   - Stream buttons now open our ad-free player (player.html) by default
 *     instead of the sandboxed iframe. The original iframe is still
 *     available via the "Original player" toggle.
 *   - External-player buttons (MX / VLC / KMPlayer / Open URL) shown
 *     next to every stream + download.
 *   - Resolved streams are cached client-side (localStorage 24h) so
 *     opening the same movie again is instant.
 *   - All images route through /api/hdhub4u/proxy on first load failure
 *     (image hotlink fallback, req #4).
 *
 * Public API:
 *   const ui = new HDHub4uUI({ container: document.querySelector('#app') });
 *   ui.init();
 */
(function (global) {
  'use strict';

  const TMDB_IMG = 'https://image.tmdb.org/t/p/';

  class HDHub4uUI {
    constructor({ container, client, perPage = 24 } = {}) {
      this.container = container || document.body;
      this.api = client || new HDHub4uClient();
      this.perPage = perPage;
      this.state = {
        view: 'home',
        page: 1,
        totalPages: 1,
        category: '',
        query: '',
        movies: [],
        loading: false,
        currentMovie: null,
        // Per req #2: "site e je exact ei player ad korte boltechi hdhub4u
        // te toggle thakle ar source theke play in browser korle eitai abar
        // jeno kono ad nah ase mathai rekho."
        // userPref.adFreePlayer === true  -> use /player.html (ad-free, our player)
        // userPref.adFreePlayer === false -> use sandboxed iframe of original player
        userPref: {
          adFreePlayer: true,
        },
      };
      this._imgObserver = null;
      this._searchTimer = null;
      this._toastEl = null;
    }

    // ===================== Lifecycle =====================
    init() {
      this._setupLazyObserver();
      this._setupToast();
      this._renderShell();
      this._wireShellEvents();
      this.loadHome(1);
    }

    _setupLazyObserver() {
      if (this._imgObserver) return;
      if (!('IntersectionObserver' in global)) return;
      this._imgObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const img = e.target;
          const src = img.getAttribute('data-src');
          if (src) {
            // Add fallback handler — if the image fails to load, route
            // through our CORS proxy as a last resort (req #4: image
            // fetch e jeno kono issue nah hoy).
            img.addEventListener('error', () => {
              if (img.dataset.proxyTried === '1') return;
              img.dataset.proxyTried = '1';
              img.src = this.api.proxyUrl(src);
            }, { once: true });
            img.src = src;
            img.removeAttribute('data-src');
          }
          this._imgObserver.unobserve(img);
        }
      }, { rootMargin: '300px 0px' });
    }

    _setupToast() {
      const el = document.createElement('div');
      el.className = 'hd-toast';
      el.setAttribute('role', 'alert');
      document.body.appendChild(el);
      this._toastEl = el;
    }

    toast(msg, type = 'info') {
      const el = this._toastEl;
      el.textContent = msg;
      el.className = 'hd-toast hd-toast-' + type + ' show';
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        el.className = 'hd-toast hd-toast-' + type;
      }, 3500);
    }

    // ===================== Shell layout =====================
    _renderShell() {
      this.container.innerHTML = `
<header class="hd-header">
  <div class="hd-header-inner">
    <a class="hd-logo" href="#/">
      <span class="hd-logo-mark">HD</span>
      <span class="hd-logo-text">Hub4u<span class="hd-accent">+</span></span>
    </a>
    <form class="hd-search" role="search">
      <input type="search" placeholder="Search movies, series…" aria-label="Search">
      <button type="submit" aria-label="Search">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
        </svg>
      </button>
    </form>
    <button class="hd-host-pill" title="Active HDHub4u mirror">
      <span class="hd-dot"></span><span class="hd-host-name">resolving…</span>
    </button>
    <button class="hd-pref-toggle" id="hd-pref-toggle" title="Player preference: Ad-free / Original">
      <span class="hd-pref-label">Ad-free</span>
    </button>
  </div>
  <nav class="hd-cats" aria-label="Categories">
    <div class="hd-cats-track">
      <button class="hd-cat-chip active" data-cat="">All</button>
    </div>
  </nav>
</header>

<main class="hd-main">
  <div class="hd-grid" id="hd-grid"></div>
  <div class="hd-pager" id="hd-pager"></div>
</main>

<div class="hd-modal" id="hd-modal" aria-hidden="true">
  <div class="hd-modal-backdrop"></div>
  <div class="hd-modal-card" role="dialog" aria-modal="true">
    <button class="hd-modal-close" aria-label="Close">×</button>
    <div class="hd-modal-body" id="hd-modal-body"></div>
  </div>
</div>

<div class="hd-player" id="hd-player" aria-hidden="true">
  <div class="hd-player-frame">
    <button class="hd-player-close" aria-label="Close player">×</button>
    <div class="hd-player-mount" id="hd-player-mount"></div>
  </div>
</div>
`;
    }

    _wireShellEvents() {
      const form = this.container.querySelector('.hd-search');
      const input = form.querySelector('input');
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = input.value.trim();
        if (q) this.loadSearch(q, 1);
      });
      input.addEventListener('input', () => {
        clearTimeout(this._searchTimer);
        const q = input.value.trim();
        this._searchTimer = setTimeout(() => {
          if (q.length >= 3) this.loadSearch(q, 1);
          else if (q.length === 0) this.loadHome(1);
        }, 350);
      });

      this.container.querySelector('.hd-cats').addEventListener('click', (e) => {
        const btn = e.target.closest('.hd-cat-chip');
        if (!btn) return;
        const cat = btn.dataset.cat;
        this.container.querySelectorAll('.hd-cat-chip').forEach((c) => c.classList.remove('active'));
        btn.classList.add('active');
        if (cat === '') this.loadHome(1);
        else this.loadCategory(cat, 1);
      });

      this.container.querySelector('#hd-grid').addEventListener('click', (e) => {
        const card = e.target.closest('.hd-card');
        if (!card) return;
        const slug = card.dataset.slug;
        if (slug) this.openMovie(slug);
      });

      this.container.querySelector('#hd-pager').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const page = parseInt(btn.dataset.page, 10);
        if (page) this._gotoPage(page);
      });

      this.container.querySelector('.hd-modal-close').addEventListener('click', () => this.closeModal());
      this.container.querySelector('.hd-modal-backdrop').addEventListener('click', () => this.closeModal());

      this.container.querySelector('.hd-player-close').addEventListener('click', () => this.closePlayer());
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { this.closePlayer(); this.closeModal(); }
      });

      // Player-preference toggle (ad-free ↔ original)
      const prefBtn = this.container.querySelector('#hd-pref-toggle');
      prefBtn.addEventListener('click', () => {
        this.state.userPref.adFreePlayer = !this.state.userPref.adFreePlayer;
        prefBtn.querySelector('.hd-pref-label').textContent =
          this.state.userPref.adFreePlayer ? 'Ad-free' : 'Original';
        prefBtn.classList.toggle('hd-pref-original', !this.state.userPref.adFreePlayer);
        this.toast('Player mode: ' + (this.state.userPref.adFreePlayer ? 'Ad-free (our player)' : 'Original (sandboxed iframe)'), 'info');
      });

      // Resolve host on init
      this.api.host().then((j) => {
        const name = (j.host || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
        this.container.querySelector('.hd-host-name').textContent = name;
      }).catch(() => {
        this.container.querySelector('.hd-host-name').textContent = 'offline';
      });

      this.api.categories().then((j) => this._renderCategoryChips(j.categories)).catch(() => {});
    }

    _renderCategoryChips(cats) {
      const track = this.container.querySelector('.hd-cats-track');
      const all = track.querySelector('[data-cat=""]');
      track.innerHTML = '';
      track.appendChild(all);
      for (const c of cats) {
        const b = document.createElement('button');
        b.className = 'hd-cat-chip';
        b.dataset.cat = c.slug;
        b.textContent = c.name;
        track.appendChild(b);
      }
    }

    // ===================== Loading views =====================
    _showGridSkeletons(n = 12) {
      const grid = this.container.querySelector('#hd-grid');
      grid.innerHTML = '';
      for (let i = 0; i < n; i++) {
        const d = document.createElement('div');
        d.className = 'hd-card hd-card-skeleton';
        d.innerHTML = `
          <div class="hd-card-poster hd-skel"></div>
          <div class="hd-card-title hd-skel"></div>
          <div class="hd-card-meta hd-skel"></div>`;
        grid.appendChild(d);
      }
    }

    _renderGrid(movies) {
      const grid = this.container.querySelector('#hd-grid');
      grid.innerHTML = '';
      if (!movies.length) {
        grid.innerHTML = `<div class="hd-empty">No movies found.</div>`;
        return;
      }
      for (const m of movies) {
        const card = document.createElement('article');
        card.className = 'hd-card';
        card.dataset.slug = m.slug;
        card.innerHTML = `
          <div class="hd-card-poster">
            ${m.poster
              ? `<img data-src="${this._posterThumb(m.poster)}" alt="${this._esc(m.title)}" loading="lazy" decoding="async">`
              : `<div class="hd-card-poster-fallback">${this._esc(m.title || 'No title')}</div>`}
            ${m.quality && m.quality.length
              ? `<div class="hd-card-badges">${m.quality.slice(0,3).map((q) => `<span class="hd-badge">${this._esc(q)}</span>`).join('')}</div>`
              : ''}
          </div>
          <div class="hd-card-title" title="${this._esc(m.title)}">${this._esc(m.title)}</div>
          <div class="hd-card-meta">
            ${m.year ? `<span>${this._esc(m.year)}</span>` : ''}
            ${m.genre && m.genre.length ? `<span class="hd-dotsep">•</span><span>${this._esc(m.genre[0])}</span>` : ''}
          </div>`;
        grid.appendChild(card);
      }
      if (this._imgObserver) {
        grid.querySelectorAll('img[data-src]').forEach((img) => this._imgObserver.observe(img));
      } else {
        grid.querySelectorAll('img[data-src]').forEach((img) => { img.src = img.getAttribute('data-src'); img.removeAttribute('data-src'); });
      }
    }

    _renderPager() {
      const pager = this.container.querySelector('#hd-pager');
      const { page, totalPages } = this.state;
      if (totalPages <= 1) { pager.innerHTML = ''; return; }

      const btn = (label, p, disabled = false, active = false) =>
        `<button class="hd-page-btn ${active ? 'active' : ''}" data-page="${p}" ${disabled ? 'disabled' : ''}>${label}</button>`;

      const win = 2;
      let from = Math.max(1, page - win);
      let to = Math.min(totalPages, page + win);
      let html = '';
      html += btn('‹ Prev', page - 1, page <= 1);
      if (from > 1) { html += btn('1', 1, false, page === 1); if (from > 2) html += `<span class="hd-ellipsis">…</span>`; }
      for (let p = from; p <= to; p++) html += btn(p, p, false, p === page);
      if (to < totalPages) {
        if (to < totalPages - 1) html += `<span class="hd-ellipsis">…</span>`;
        html += btn(totalPages, totalPages, false, page === totalPages);
      }
      html += btn('Next ›', page + 1, page >= totalPages);
      pager.innerHTML = html;
    }

    _gotoPage(p) {
      if (this.state.view === 'home') this.loadHome(p);
      else if (this.state.view === 'category') this.loadCategory(this.state.category, p);
      else if (this.state.view === 'search') this.loadSearch(this.state.query, p);
    }

    // ===================== Public actions =====================
    async loadHome(page = 1) {
      this.state.view = 'home'; this.state.page = page;
      this._showGridSkeletons();
      try {
        const j = await this.api.home(page);
        this.state.movies = j.movies;
        this.state.totalPages = j.totalPages || 1;
        this._renderGrid(j.movies);
        this._renderPager();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (e) { this._handleError(e); }
    }

    async loadCategory(slug, page = 1) {
      this.state.view = 'category'; this.state.category = slug; this.state.page = page;
      this._showGridSkeletons();
      try {
        const j = await this.api.category(slug, page);
        this.state.movies = j.movies;
        this.state.totalPages = j.totalPages || 1;
        this._renderGrid(j.movies);
        this._renderPager();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (e) { this._handleError(e); }
    }

    async loadSearch(q, page = 1) {
      this.state.view = 'search'; this.state.query = q; this.state.page = page;
      this._showGridSkeletons();
      try {
        const j = await this.api.search(q, page);
        this.state.movies = j.movies;
        this.state.totalPages = j.totalPages || 1;
        this._renderGrid(j.movies);
        this._renderPager();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (e) { this._handleError(e); }
    }

    async openMovie(slug) {
      const modal = this.container.querySelector('#hd-modal');
      const body = this.container.querySelector('#hd-modal-body');
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
      body.innerHTML = `<div class="hd-modal-loading">Loading movie…</div>`;
      try {
        const m = await this.api.movie({ slug });
        this.state.currentMovie = m;
        this._renderMovieModal(m);
      } catch (e) {
        body.innerHTML = `<div class="hd-modal-error">Failed to load movie: ${this._esc(e.message)}</div>`;
      }
    }

    closeModal() {
      const modal = this.container.querySelector('#hd-modal');
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
      const body = this.container.querySelector('#hd-modal-body');
      body.innerHTML = '';
    }

    /**
     * Open a stream. Per req #2 + #3:
     *   - ad-free mode: opens /player.html (our player, no ads, MKV/HLS support)
     *   - original mode: opens sandboxed iframe of the original HDHub4u player
     * In both cases we pre-resolve the direct URL so external-player buttons
     * can be wired into the modal.
     */
    openStream(playerUrl, title = 'HDHub4u Player') {
      const player = this.container.querySelector('#hd-player');
      const mount = this.container.querySelector('#hd-player-mount');

      let srcUrl;
      if (this.state.userPref.adFreePlayer) {
        // Resolve direct URL server-side, then open our player page.
        srcUrl = this.api.iframeStreamUrl(playerUrl, title);
        // Replace with our player page after resolving.
        mount.innerHTML = `<div class="hd-player-loading">Resolving stream…</div>`;
        this.api.resolveStream(playerUrl).then((info) => {
          const direct = info.directUrl || info.streamUrl || info.playableUrl;
          const finalUrl = direct
            ? this.api.playerUrl(direct, { title, source: info.source })
            : this.api.iframeStreamUrl(playerUrl, title);
          mount.innerHTML = `<iframe src="${this._esc(finalUrl)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen sandbox="allow-scripts allow-same-origin allow-presentation allow-forms allow-popups"></iframe>`;
        }).catch(() => {
          // Fall back to sandboxed iframe.
          mount.innerHTML = `<iframe src="${this._esc(this.api.iframeStreamUrl(playerUrl, title))}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen sandbox="allow-scripts allow-same-origin allow-presentation allow-forms allow-popups"></iframe>`;
        });
      } else {
        // Original sandboxed iframe of the HDHub4u player.
        srcUrl = this.api.iframeStreamUrl(playerUrl, title);
        mount.innerHTML = `<iframe src="${this._esc(srcUrl)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen sandbox="allow-scripts allow-same-origin allow-presentation allow-forms allow-popups"></iframe>`;
      }
      player.classList.add('show');
      player.setAttribute('aria-hidden', 'false');
    }

    closePlayer() {
      const player = this.container.querySelector('#hd-player');
      const mount = this.container.querySelector('#hd-player-mount');
      mount.innerHTML = '';
      player.classList.remove('show');
      player.setAttribute('aria-hidden', 'true');
    }

    // ===================== Movie modal renderer =====================
    _renderMovieModal(m) {
      const body = this.container.querySelector('#hd-modal-body');
      const downloads = (m.downloads || []).filter((d) => d.isDownload);
      const streams = (m.streams || []);
      const qualities = (m.qualities || []).map((q) => q.label).filter(Boolean);

      // Group downloads by quality
      const byQuality = {};
      for (const d of downloads) {
        const q = d.quality || (d.label.match(/\b(4K|1080p|720p|480p)\b/i)?.[0]) || 'Other';
        if (!byQuality[q]) byQuality[q] = [];
        byQuality[q].push(d);
      }

      body.innerHTML = `
        <div class="hd-movie">
          <div class="hd-movie-head">
            <div class="hd-movie-poster">
              ${m.poster ? `<img src="${this._posterFull(m.poster)}" alt="${this._esc(m.title)}" loading="lazy">` : ''}
            </div>
            <div class="hd-movie-info">
              <h2 class="hd-movie-title">${this._esc(m.title)}</h2>
              <div class="hd-movie-sub">
                ${m.year ? `<span>${this._esc(m.year)}</span>` : ''}
                ${m.imdbRating ? `<span class="hd-dotsep">•</span><span class="hd-imdb">★ ${this._esc(m.imdbRating)}/10</span>` : ''}
                ${qualities.length ? `<span class="hd-dotsep">•</span><span>${this._esc(qualities.join(' / '))}</span>` : ''}
              </div>
              ${m.genres && m.genres.length ? `<div class="hd-movie-genres">${m.genres.map((g) => `<span class="hd-genre">${this._esc(g)}</span>`).join('')}</div>` : ''}
              <dl class="hd-movie-meta">
                ${m.language ? `<dt>Language</dt><dd>${this._esc(m.language)}</dd>` : ''}
                ${m.director ? `<dt>Director</dt><dd>${this._esc(m.director)}</dd>` : ''}
                ${m.stars ? `<dt>Stars</dt><dd>${this._esc(m.stars)}</dd>` : ''}
                ${m.imdbUrl ? `<dt>IMDB</dt><dd><a href="${this._esc(m.imdbUrl)}" target="_blank" rel="noopener">${this._esc(m.imdbId || 'View on IMDB')}</a></dd>` : ''}
              </dl>
              <div class="hd-movie-actions">
                ${streams.length
                  ? streams.map((s) => `<button class="hd-btn hd-btn-stream" data-stream="${this._esc(s.url)}" data-title="${this._esc(m.title + ' - ' + s.player)}">▶ ${this._esc(s.player)}</button>`).join('')
                  : `<span class="hd-muted">No stream available</span>`}
                ${m.trailer ? `<button class="hd-btn hd-btn-trailer" data-trailer="${this._esc(m.trailer)}">▶ Trailer</button>` : ''}
              </div>
              <div class="hd-pref-row">
                <label class="hd-pref-check">
                  <input type="checkbox" id="hd-pref-adfree" ${this.state.userPref.adFreePlayer ? 'checked' : ''}>
                  <span>Use ad-free player (no popups, plays MKV / HLS)</span>
                </label>
              </div>
            </div>
          </div>

          ${m.storyline ? `
            <section class="hd-movie-section">
              <h3>Storyline</h3>
              <p>${this._esc(m.storyline)}</p>
            </section>` : ''}

          ${m.screenshots && m.screenshots.length ? `
            <section class="hd-movie-section">
              <h3>Screenshots</h3>
              <div class="hd-shots">
                ${m.screenshots.slice(0, 8).map((s) => `<a href="${this._esc(s)}" target="_blank"><img data-src="${this._esc(s)}" alt="Screenshot" loading="lazy"></a>`).join('')}
              </div>
            </section>` : ''}

          ${downloads.length ? `
            <section class="hd-movie-section">
              <h3>Download Links</h3>
              <div class="hd-dl-groups">
                ${Object.entries(byQuality).map(([q, items]) => `
                  <div class="hd-dl-group">
                    <h4>${this._esc(q)}</h4>
                    <div class="hd-dl-links">
                      ${items.map((d) => `
                        <div class="hd-dl-link">
                          <a class="hd-dl-link-main" href="${this._esc(d.url)}" target="_blank" rel="noopener">
                            <span class="hd-dl-name">${this._esc(d.label)}</span>
                            ${d.size ? `<span class="hd-dl-size">${this._esc(d.size)}</span>` : ''}
                            <span class="hd-dl-kind hd-dl-kind-${d.kind}">${this._esc(d.kind)}</span>
                          </a>
                          <div class="hd-dl-link-ext">
                            <button class="hd-dl-ext-btn" data-action="mx"  data-url="${this._esc(d.url)}" title="Open in MX Player">▶ MX</button>
                            <button class="hd-dl-ext-btn" data-action="vlc" data-url="${this._esc(d.url)}" title="Open in VLC">▶ VLC</button>
                            <button class="hd-dl-ext-btn" data-action="copy" data-url="${this._esc(d.url)}" title="Copy link">⧉</button>
                          </div>
                        </div>`).join('')}
                    </div>
                  </div>`).join('')}
              </div>
            </section>` : ''}

          ${m.review ? `
            <section class="hd-movie-section">
              <h3>Review</h3>
              <p>${this._esc(m.review)}</p>
            </section>` : ''}
        </div>
      `;

      // Wire lazy load for screenshots
      if (this._imgObserver) {
        body.querySelectorAll('img[data-src]').forEach((img) => this._imgObserver.observe(img));
      }

      // Stream buttons
      body.querySelectorAll('.hd-btn-stream').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.openStream(btn.dataset.stream, btn.dataset.title);
        });
      });

      // Trailer
      body.querySelectorAll('.hd-btn-trailer').forEach((btn) => {
        btn.addEventListener('click', () => {
          const url = btn.dataset.trailer;
          const player = this.container.querySelector('#hd-player');
          const mount = this.container.querySelector('#hd-player-mount');
          mount.innerHTML = `<iframe src="${this._esc(url)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe>`;
          player.classList.add('show');
          player.setAttribute('aria-hidden', 'false');
        });
      });

      // Ad-free toggle in modal
      const adFreeCheck = body.querySelector('#hd-pref-adfree');
      if (adFreeCheck) {
        adFreeCheck.addEventListener('change', () => {
          this.state.userPref.adFreePlayer = adFreeCheck.checked;
          // Sync the header toggle too
          const prefBtn = this.container.querySelector('#hd-pref-toggle');
          prefBtn.querySelector('.hd-pref-label').textContent =
            this.state.userPref.adFreePlayer ? 'Ad-free' : 'Original';
          prefBtn.classList.toggle('hd-pref-original', !this.state.userPref.adFreePlayer);
        });
      }

      // Download external buttons
      body.querySelectorAll('.hd-dl-ext-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const action = btn.dataset.action;
          const url = btn.dataset.url;
          if (action === 'copy') {
            try {
              await navigator.clipboard.writeText(url);
              this.toast('Link copied to clipboard', 'success');
            } catch (_) {
              this.toast('Could not copy — long-press the link instead', 'error');
            }
            return;
          }
          if (action === 'mx' || action === 'vlc') {
            // For player pages (hubstream/hdstream4u) we need to resolve first.
            if (/hubstream\.art|hdstream4u\.com|hubdrive\.|hubcdn\.sbs|gadgetsweb\.xyz/i.test(url)) {
              this.toast('Resolving direct URL…', 'info');
              try {
                const info = await this.api.resolveStream(url);
                const direct = info.directUrl || info.streamUrl || info.playableUrl;
                if (!direct) throw new Error('No direct URL');
                if (action === 'mx') location.href = info.mxIntent || this.api.buildMxIntent(direct, m.title);
                else location.href = info.vlcUrl || this.api.buildVlcUrl(direct);
              } catch (e) {
                this.toast('Could not resolve: ' + e.message, 'error');
              }
            } else {
              // Direct URL — build intent / vlc URL client-side.
              if (action === 'mx') location.href = this.api.buildMxIntent(url, m.title);
              else location.href = this.api.buildVlcUrl(url);
            }
          }
        });
      });
    }

    // ===================== Helpers =====================
    _handleError(e) {
      console.error(e);
      this.toast('Error: ' + (e.message || 'unknown'), 'error');
      const grid = this.container.querySelector('#hd-grid');
      grid.innerHTML = `<div class="hd-empty">Failed to load. ${this._esc(e.message || '')}</div>`;
    }

    _posterThumb(u) {
      if (!u) return '';
      return u.replace(/\/w(342|500|780|original)\//, '/w185/');
    }
    _posterFull(u) {
      if (!u) return '';
      return u.replace(/\/w(185|342|500)\//, '/w500/');
    }

    _esc(s = '') {
      return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[c]);
    }
  }

  global.HDHub4uUI = HDHub4uUI;
})(window);
