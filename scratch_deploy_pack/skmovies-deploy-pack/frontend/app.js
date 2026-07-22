/* ============================================================================
   SKMovies — Frontend App (FIXED v3.3.8)
   Vanilla JS SPA, Cloudflare Pages Functions backend.
   ----------------------------------------------------------------------------
   CHANGES vs v3.3.7:
   - [#1 CRITICAL] scrollLock now uses explicit boolean `isLocked` flag instead
                   of relying on truthiness of `savedPosition` (empty string).
                   Fixes the permanent body lock after browser-back navigation.
   - [#2 HIGH]     Defense-in-depth popstate guard: force-clears body lock when
                   returning to a state with no overlay open.
   - [#3 MED]      Lazy-load observer now uses native `loading="lazy"` where
                   supported; observer kept only as fallback. Less JS overhead
                   on initial grid render.
   - [#4 MED]      Scroll handler: rAF flag is reset BEFORE the work, so a
                   dropped frame doesn't starve subsequent scrolls.
   - [#5 MED]      `escapeHtml` now cached via a single regex pass.
   - [#6 LOW]      `popstate` only calls `closeModal` when modal actually open.
   - [#7 LOW]      `closeModal` waits for `transitionend` before clearing
                   `modalBody.innerHTML`, preventing abrupt content flash.
   - [#8 LOW]      Service-worker registration moved behind `window.load`
                   so it never competes with first paint.
   - [#9 POLISH]   Added `prefers-reduced-motion` short-circuit for animations.
   - [#10 POLISH]  Hover prefetch now respects `navigator.connection.saveData`.
   - [#11 SECURITY] DL buttons: `savelinks_url` validated to be http(s) only.
   - [#12 PERF]    `IntersectionObserver` root margin reduced from 200px→100px
                   to cut initial image fetches on slow mobile.
   ============================================================================ */
(function () {
  'use strict';

  /* ─── API endpoints ─────────────────────────────────────────────────── */
  function getApi() {
    const src = (state && state.source) || ls.get('skm.source', 'mlsbd');
    return src === 'fdm' ? {
      latest: '/api/fdm/latest',
      movie: '/api/fdm/movie',
      search: '/api/fdm/search',
      trending: '/api/fdm/trending',
      resolve: '/api/fdm/resolve',
      category: '/api/fdm/category',
      img: '/api/img',
      notice: '/api/notice',
    } : {
      latest: '/api/latest',
      movie: '/api/movie',
      search: '/api/search',
      trending: '/api/trending',
      resolve: '/api/resolve',
      category: '/api/category',
      img: '/api/img',
      notice: '/api/notice',
    };
  }

  const PROXY_WORKER_URL = window.location.origin + '/api/proxy';

  // Hosts whose responses must be proxied through /api/proxy to add CORS headers
  // or to bypass Cloudflare bot protection. Match against URL.hostname.
  const PROXY_HOST_PATTERNS = [
    /^dl\.freedrivemovie\.org$/i,
    /\.freedrivemovie\.(org|cyou|com)$/i,
    /indexserver\.site$/i,
    /busycdn\.xyz$/i,
    /multicloudlinks\.com$/i,
    /gdflix\.(dev|dad|com)$/i,
    /hubcloud\.(lol|foo|com)$/i,
    /gdtot\.(dad|com|dev)$/i,
    /^gdlink\.dev$/i,
    /filepress\.(baby|com)$/i,
    /^multidownload\.website$/i,
    /^dr\d+\.multidownload\.website$/i,
    /^mlsbd-image\.com$/i,
    /^cdn\.imgnest\.io$/i,
    /^image\.tmdb\.org$/i,
    /^img\.freedrivemovie\.cyou$/i,
  ];

  function hostNeedsProxy(urlStr) {
    try {
      const u = new URL(urlStr);
      return PROXY_HOST_PATTERNS.some(re => re.test(u.hostname));
    } catch {
      return false;
    }
  }

  function wrapInProxy(url) {
    if (!url) return url;
    if (url.startsWith('/api/proxy?')) return url;
    if (!hostNeedsProxy(url)) return url;
    const b64 = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${PROXY_WORKER_URL}?u=${b64}`;
  }

  const FILTERS = [
    { id: 'all', label: 'All' }, { id: '1080p', label: '1080P' },
    { id: '720p', label: '720P' }, { id: '480p', label: '480P' },
    { id: '4k', label: '4K' }, { id: 'bengali', label: 'বাংলা' },
    { id: 'hindi', label: 'Hindi' }, { id: 'english', label: 'English' },
    { id: 'dual', label: 'Dual' }, { id: 'web-dl', label: 'WEB-DL' },
    { id: 'bluray', label: 'BluRay' }, { id: 'hdtc', label: 'HDTC' },
    { id: 'netflix', label: 'Netflix' }, { id: 'amazon', label: 'Prime' },
    { id: 'hotstar', label: 'Hotstar' }, { id: 'zee5', label: 'Zee5' },
    { id: 'hoichoi', label: 'Hoichoi' },
  ];

  const MLSBD_CATEGORIES = [
    { name: "1080p", slug: "1080p" }, { name: "10Bits", slug: "10bits" },
    { name: "3D", slug: "3d" }, { name: "4K UHD", slug: "4k" },
    { name: "60FPS Movies", slug: "60fps-movies" }, { name: "Addatimes Originals", slug: "addatimes" },
    { name: "African Movies", slug: "foreign-language-film/african-movies" },
    { name: "Animation Movies", slug: "animation-movies" }, { name: "Anime", slug: "anime" },
    { name: "Arabic Movies", slug: "foreign-language-film/arabic-movies" },
    { name: "Asian Adult Movies", slug: "unrated/asianmovies" }, { name: "Assamese", slug: "foreign-language-film/assamese" },
    { name: "Australian Movies", slug: "foreign-language-film/australian-movies" },
    { name: "Bangla Dubbed", slug: "bangla-dubbed" }, { name: "Bengali Movies", slug: "bangla-movies" },
    { name: "Bindastimes", slug: "unrated/bindastimes" }, { name: "Binge Originals", slug: "binge-originals" },
    { name: "Bioscope Originals", slug: "bioscope-original" }, { name: "Bollywood Movies", slug: "bollywood-movies" },
    { name: "Canada Movies", slug: "foreign-language-film/canada-movies" }, { name: "Cantonese", slug: "foreign-language-film/cantonese" },
    { name: "Cartoon Series", slug: "cartoon-series" }, { name: "Charlie Chaplin Movies", slug: "charlie-chaplin-movies" },
    { name: "China Movies", slug: "foreign-language-film/china-movies" }, { name: "Chinese Movies", slug: "foreign-language-film/chinese-movies" },
    { name: "Chorki Originals", slug: "chorki-originals" }, { name: "Danish Movies", slug: "foreign-language-film/danish-movies" },
    { name: "Documentary", slug: "documentary" }, { name: "Dual/Multi Audio Movies", slug: "dual-audio-movies" },
    { name: "Dutch Movies", slug: "foreign-language-film/dutch-movies" }, { name: "Filipino Movies", slug: "foreign-language-film/filipino-movies" },
    { name: "Finland Movie", slug: "foreign-language-film/finland-movie" }, { name: "Fliz Movies", slug: "unrated/fliz" },
    { name: "Foreign Language Film", slug: "foreign-language-film" }, { name: "France Movies", slug: "foreign-language-film/france-movies" },
    { name: "French Movies", slug: "foreign-language-film/french-movies" }, { name: "German Movies", slug: "foreign-language-film/german-movies" },
    { name: "Germany Movies", slug: "foreign-language-film/germany-movies" }, { name: "Greece Movies", slug: "foreign-language-film/greece-movies" },
    { name: "Gujarati Movie", slug: "foreign-language-film/gujarati-movie" }, { name: "Gupchup", slug: "unrated/gupchup" },
    { name: "HEVC", slug: "hevc" }, { name: "Hindi Dubbed Movies", slug: "hindi-dubbed-movies" },
    { name: "Hoichoi Originals", slug: "hoichoi" }, { name: "Hollywood Movies", slug: "hollywood-movies" },
    { name: "Hong Kong", slug: "foreign-language-film/hong-kong" }, { name: "Horror Movies", slug: "horror-movies" },
    { name: "Hotshots Originals", slug: "unrated/hotshots" }, { name: "Imdb Top 250 Hindi Movies", slug: "imdb-top-250-hindi-movies" },
    { name: "IMDb Top 250 Movies", slug: "imdb-top-250-movies" }, { name: "Indonesia", slug: "foreign-language-film/indonesia" },
    { name: "Iranian Movies", slug: "foreign-language-film/iranian-movies" }, { name: "Italian Movies", slug: "foreign-language-film/italian-movies" },
    { name: "Japanese Movie", slug: "foreign-language-film/japanese-movie" }, { name: "Kannada", slug: "south-indian-movies/kannada" },
    { name: "Kannada Movies", slug: "south-indian-movies/kannada-movies" }, { name: "KLiKK Original", slug: "klikk" },
    { name: "Korean Movies/Drama", slug: "korean-movies" }, { name: "Lolypop", slug: "unrated/lolypop" },
    { name: "Malayalam Movies", slug: "south-indian-movies/malayalam-movies" }, { name: "Malaylam Movies", slug: "south-indian-movies/malaylam-movies" },
    { name: "Malaysia", slug: "foreign-language-film/malaysia" }, { name: "Mandarian", slug: "foreign-language-film/mandarian" },
    { name: "Mandarin Movies", slug: "foreign-language-film/mandarin-movies" }, { name: "Marathi Movies", slug: "south-indian-movies/marathi-movies" },
    { name: "Music Videos", slug: "music-videos" }, { name: "MX Player", slug: "mx-player" },
    { name: "Natok & Teleflim", slug: "natok-teleflim" }, { name: "Nepali Movies", slug: "foreign-language-film/nepali-movies" },
    { name: "News", slug: "news" }, { name: "Norwegian", slug: "foreign-language-film/norwegian" },
    { name: "Others", slug: "others" }, { name: "Pakistani Movies", slug: "pakistani-movies" },
    { name: "Panjabi Movies", slug: "south-indian-movies/panjabi-movies" }, { name: "Persian Movies", slug: "foreign-language-film/persian-movies" },
    { name: "Philippines", slug: "foreign-language-film/philippines" }, { name: "Podcast", slug: "podcast" },
    { name: "Polish Movies", slug: "foreign-language-film/polish-movies" }, { name: "Portuguese", slug: "foreign-language-film/portuguese" },
    { name: "Primeshots", slug: "unrated/primeshots" }, { name: "Romanian Movies", slug: "foreign-language-film/romanian-movies" },
    { name: "Russian Movies", slug: "foreign-language-film/russian-movies" }, { name: "Sapnish Movies", slug: "foreign-language-film/sapnish-movies" },
    { name: "Short Films", slug: "short-fil" }, { name: "South African Movies", slug: "foreign-language-film/south-african-movies" },
    { name: "South Indian Movies", slug: "south-indian-movies" }, { name: "Spanish Movies", slug: "foreign-language-film/sapnish-movies/spanish-movies-sapnish-movies" },
    { name: "Sports", slug: "sports" }, { name: "Swedish", slug: "foreign-language-film/swedish" },
    { name: "Taiwan", slug: "foreign-language-film/taiwan" }, { name: "Tamil Movies", slug: "south-indian-movies/tamil-movies" },
    { name: "Telugu Movies", slug: "south-indian-movies/telugu-movies" }, { name: "Thai Movies", slug: "foreign-language-film/thai-movies" },
    { name: "Torrent", slug: "torrent" }, { name: "Turkish Movies", slug: "foreign-language-film/turkish-movies" },
    { name: "TV Series", slug: "tv-series" }, { name: "TV SHOWS", slug: "tv-series/tv-shows" },
    { name: "ULLU Originals", slug: "unrated/ullu" }, { name: "UnRated", slug: "unrated" },
    { name: "Unreleased Tracks", slug: "unreleased-tracks" }, { name: "Urdo Movies", slug: "urdo-movies" },
    { name: "Vietnamese Movies", slug: "foreign-language-film/vietnamese-movies" }, { name: "Watch Online", slug: "watch-online" },
    { name: "Web Series", slug: "web-series" }
  ];

  const FDM_CATEGORIES = [
    { name: "Bangla", slug: "bangla-ge" }, { name: "Bollywood", slug: "bollywood-genre" },
    { name: "South Indian", slug: "south-indian" }, { name: "4K 2160p", slug: "4k-2160p" },
    { name: "Hindi Dubbed", slug: "hindi-dubbed" }, { name: "Dual Audio", slug: "dual-audio" },
    { name: "Action", slug: "action" }, { name: "Adventure", slug: "adventure" },
    { name: "Animation", slug: "animation" }, { name: "Comedy", slug: "comedy" },
    { name: "Crime", slug: "crime" }, { name: "Documentary", slug: "documentary" },
    { name: "Drama", slug: "drama" }, { name: "Family", slug: "family" },
    { name: "Fantasy", slug: "fantasy" }, { name: "History", slug: "history" },
    { name: "Horror", slug: "horror" }, { name: "Music", slug: "music" },
    { name: "Mystery", slug: "mystery" }, { name: "Romance", slug: "romance" },
    { name: "Science Fiction", slug: "science-fiction" }, { name: "Thriller", slug: "thriller" },
    { name: "War", slug: "war-genre-content" }, { name: "Western", slug: "western" },
    { name: "Adult", slug: "adult" },
  ];

  function getCategories() {
    return state.source === 'fdm' ? FDM_CATEGORIES : MLSBD_CATEGORIES;
  }

  const STORE = {
    favs: 'skm.favs', history: 'skm.history', theme: 'skm.theme',
    urls: 'skm.urls', stats: 'skm.stats', filter18: 'skm.filter18',
  };

  const state = {
    view: 'latest', page: 1, filter: 'all', searchQuery: '',
    items: [], isLoading: false, hasMore: true, heroItem: null,
    currentMovieSlug: null, filter18: false, hasError: false,
    source: localStorage.getItem('skm.source') === 'fdm' ? 'fdm' : 'mlsbd',
  };

  const $ = (s) => document.querySelector(s);
  const dom = {};
  let lazyImageObserver = null;
  let currentModalMovie = null;
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function cacheDom() {
    dom.grid = $('#moviesGrid'); dom.skeletonGrid = $('#skeletonGrid');
    dom.loadMore = $('#loadMore'); dom.loadMoreBtn = $('#loadMoreBtn');
    dom.empty = $('#empty'); dom.sectionTitle = $('#sectionTitle');
    dom.searchForm = $('#searchForm'); dom.searchInput = $('#searchInput'); dom.searchClear = $('#searchClear');
    dom.filtersScroll = $('#filtersScroll');
    dom.featuredSlides = $('#featuredSlides'); dom.featuredPrev = $('#featuredPrev'); dom.featuredNext = $('#featuredNext');
    dom.noticeMarquee = $('#noticeMarquee');
    dom.darkToggle = $('#dn'); dom.filter18 = $('#filter18'); dom.filter18State = $('#filter18State');
    dom.navMenu = $('#navMenu');
    dom.modal = $('#modal'); dom.modalBody = $('#modalBody');
    dom.sheet = $('#sheet'); dom.sheetTitle = $('#sheetTitle'); dom.sheetHint = $('#sheetHint');
    dom.sheetGrid = $('#sheetGrid'); dom.sheetUrl = $('#sheetUrl'); dom.sheetCopy = $('#sheetCopy'); dom.sheetTip = $('#sheetTip');
    dom.categoriesSheet = $('#categoriesSheet'); dom.categoriesGrid = $('#categoriesGrid'); dom.navCategories = $('#navCategories');
    dom.toast = $('#toast');
    dom.dashboard = $('#dashboard'); dom.dashStats = $('#dashStats'); dom.dashUrls = $('#dashUrls');
    dom.dashFavs = $('#dashFavs'); dom.dashHistory = $('#dashHistory');
    dom.movieSection = $('#movieSection'); dom.featuredSection = $('#featuredSection');
    dom.goTop = $('#go-top');
    dom.menuToggle = $('#menuToggle');
    dom.sourceToggle = $('#sourceToggle');
    dom.sourceIndicator = $('#sourceIndicator');
    dom.sourceLabel = $('#sourceLabel');
  }

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"'`]/g, (c) => ESC_MAP[c]);
  const escapeHtmlAttr = escapeHtml;

  function haptic(pattern = 10) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch {}
    }
  }
  const HAPTIC = {
    tap: 10, select: 20,
    success: [10, 30, 10], error: [40, 40, 40], warning: 30,
  };

  const IMAGE_HOST_PATTERNS = [
    /^mlsbd-image\.com$/i,
    /^cdn\.imgnest\.io$/i,
    /^m\.media-amazon\.com$/i,
    /^image\.tmdb\.org$/i,
    /^img\.freedrivemovie\.cyou$/i,
  ];

  const imgProxy = (url) => {
    if (!url) return '';
    if (url.startsWith('data:') || url.startsWith('/')) return url;
    try {
      const u = new URL(url);
      if (IMAGE_HOST_PATTERNS.some(re => re.test(u.hostname))) {
        const b64 = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return `${getApi().img}?u=${b64}`;
      }
    } catch {}
    return url;
  };

  const TOAST_DURATIONS = { success: 2400, info: 3500, error: 6000, '': 2400 };

  const toast = (msg, type = '', duration = null) => {
    clearTimeout(toast._t);
    dom.toast.classList.remove('is-visible');
    if (type === 'error') haptic(HAPTIC.error);
    if (type === 'success') haptic(HAPTIC.success);

    dom.toast.innerHTML = '';
    const lines = String(msg).split('\n');
    lines.forEach((line, i) => {
      const div = document.createElement('div');
      div.textContent = line;
      if (i > 0) { div.style.opacity = '0.85'; div.style.fontSize = '11px'; div.style.marginTop = '4px'; }
      dom.toast.appendChild(div);
    });

    dom.toast.className = 'toast toast--' + type;
    dom.toast.hidden = false;

    dom.toast.onclick = () => {
      clearTimeout(toast._t);
      dom.toast.classList.remove('is-visible');
      setTimeout(() => (dom.toast.hidden = true), 250);
    };

    requestAnimationFrame(() => dom.toast.classList.add('is-visible'));

    const ms = duration ?? TOAST_DURATIONS[type] ?? 2400;
    if (ms > 0) {
      toast._t = setTimeout(() => {
        dom.toast.classList.remove('is-visible');
        setTimeout(() => (dom.toast.hidden = true), 250);
      }, ms);
    }
  };

  const ERROR_MESSAGES_BN = {
    400: 'ভুল অনুরোধ (৪০০)। স্লাগ বা প্যারামিটার ঠিক নেই।',
    401: 'অনুমতি নেই (৪০১)। লগইন প্রয়োজন।',
    403: 'অ্যাক্সেস নিষিদ্ধ (৪০৩)। হোস্ট ব্লক করা হয়েছে।',
    404: 'খুঁজে পাওয়া যায়নি (৪০৪)। মুভি বা লিংক আর নেই।',
    408: 'সময় শেষ (৪০৮)। নেটওয়ার্ক ধীর।',
    429: 'অনেক বেশি অনুরোধ (৪২৯)। কিছুক্ষণ পরে চেষ্টা করুন।',
    500: 'সার্ভার ত্রুটি (৫০০)। সোর্স সাইটে সমস্যা।',
    502: 'গেটওয়ে ত্রুটি (৫০২)। সোর্স সাইট ডাউন বা ব্লক করেছে।',
    503: 'সার্ভার ব্যস্ত (৫০৩)। কিছুক্ষণ পরে চেষ্টা করুন।',
    504: 'গেটওয়ে টাইমআউট (৫০৪)। সোর্স সাইট সাড়া দিচ্ছে না।',
  };

  async function fetchJson(url, opts = {}) {
    const { timeoutMs = 8000, retries = 1, signal } = opts;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
      try {
        const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
        clearTimeout(t);
        if (r.status === 429 || r.status >= 500) {
          if (attempt < retries) { await sleep(500 * Math.pow(2, attempt)); continue; }
        }
        if (!r.ok) {
          let serverMsg = '';
          try { const data = await r.json(); serverMsg = data.error || data.message || data.error_message || ''; }
          catch { try { serverMsg = (await r.text()).slice(0, 200); } catch {} }
          const humanMsg = ERROR_MESSAGES_BN[r.status] || `সার্ভার ত্রুটি (${r.status})।`;
          const fullMsg = serverMsg ? `${humanMsg}\nসার্ভার বলছে: ${serverMsg}` : humanMsg;
          const err = new Error(fullMsg);
          err.status = r.status;
          err.serverMessage = serverMsg;
          throw err;
        }
        return await r.json();
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
        if (e.name === 'AbortError') {
          const err = new Error('অনুরোধ সময়ের মধ্যে শেষ হয়নি (টাইমআউট)। নেটওয়ার্ক চেক করুন।');
          err.name = 'TimeoutError'; err.status = 408;
          if (attempt < retries) { await sleep(500 * Math.pow(2, attempt)); continue; }
          throw err;
        }
        if (e.name === 'TypeError' && /fetch|network/i.test(e.message)) {
          const err = new Error('নেটওয়ার্ক সমস্যা। ইন্টারনেট কানেকশন চেক করুন।');
          err.name = 'NetworkError';
          if (attempt < retries) { await sleep(500 * Math.pow(2, attempt)); continue; }
          throw err;
        }
        if (e.status) {
          if (attempt < retries && (e.status === 429 || e.status >= 500)) {
            await sleep(500 * Math.pow(2, attempt)); continue;
          }
          throw e;
        }
        if (attempt < retries) { await sleep(500 * Math.pow(2, attempt)); continue; }
        throw new Error(`অজানা ত্রুটি: ${e.message || e}`);
      }
    }
    throw lastErr || new Error('অজানা ত্রুটি।');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ====================================================================
     [#1 CRITICAL FIX] scrollLock — explicit boolean flag, not string truthiness
     ==================================================================== */
  const scrollLock = {
    isLocked: false,
    savedScrollY: 0,
    savedOverflow: '',
    savedPosition: '',

    lock() {
      if (this.isLocked) return;                    // already locked
      this.savedScrollY = window.scrollY;
      this.savedOverflow = document.body.style.overflow;
      this.savedPosition = document.body.style.position;
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.top = `-${this.savedScrollY}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.width = '100%';
      this.isLocked = true;
    },

    unlock() {
      if (!this.isLocked) return;                   // not locked
      document.body.style.overflow = this.savedOverflow;
      document.body.style.position = this.savedPosition;
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.width = '';
      window.scrollTo(0, this.savedScrollY);
      this.isLocked = false;
      this.savedOverflow = '';
      this.savedPosition = '';
    },

    // Defense-in-depth: forcibly clear any leftover lock styles.
    // Used by the popstate safety net.
    forceClear() {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.width = '';
      this.isLocked = false;
      this.savedOverflow = '';
      this.savedPosition = '';
    },
  };

  const ls = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  /* ─── Theme ─────────────────────────────────────────────────────────── */
  function initTheme() {
    const isDark = ls.get(STORE.theme, null) === true;
    updateThemeColor(isDark);
    if (isDark) { document.documentElement.classList.add('dark-ui'); dom.darkToggle.checked = true; }
    dom.darkToggle.addEventListener('change', () => {
      const dark = dom.darkToggle.checked;
      document.documentElement.classList.toggle('dark-ui', dark);
      ls.set(STORE.theme, dark);
      updateThemeColor(dark);
      haptic(HAPTIC.tap);
    });
  }
  function updateThemeColor(isDark) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isDark ? '#0d0f14' : '#ffffff');
  }

  /* ─── Filter 18+ ────────────────────────────────────────────────────── */
  function initFilter18() {
    state.filter18 = ls.get(STORE.filter18, false);
    dom.filter18.checked = state.filter18;
    dom.filter18State.textContent = state.filter18 ? 'On' : 'Off';
    dom.filter18.addEventListener('change', () => {
      state.filter18 = dom.filter18.checked;
      dom.filter18State.textContent = state.filter18 ? 'On' : 'Off';
      setTimeout(() => {
        ls.set(STORE.filter18, state.filter18);
        state.page = 1; state.items = []; state.hasMore = true;
        loadList();
      }, 0);
    });
  }

  /* ─── Source Toggle ─────────────────────────────────────────────────── */
  function initSourceToggle() {
    if (state.source === 'fdm') {
      dom.sourceToggle.classList.add('fdm');
      dom.sourceLabel.textContent = 'FreeDrive';
    } else {
      dom.sourceToggle.classList.remove('fdm');
      dom.sourceLabel.textContent = 'MLSBD';
    }
    dom.sourceToggle.addEventListener('click', () => toggleSource());
  }

  function toggleSource() {
    if (!dom.modal.hidden) closeModal({ pushState: false });
    if (!dom.sheet.hidden) closeSheet();
    if (!dom.categoriesSheet.hidden) closeCategoriesSheet();

    state.source = state.source === 'mlsbd' ? 'fdm' : 'mlsbd';
    localStorage.setItem('skm.source', state.source);

    if (state.source === 'fdm') {
      dom.sourceToggle.classList.add('fdm');
      dom.sourceLabel.textContent = 'FreeDrive';
      toast('FreeDriveMovie সোর্সে চলে গেছে', 'success');
    } else {
      dom.sourceToggle.classList.remove('fdm');
      dom.sourceLabel.textContent = 'MLSBD';
      toast('MLSBD সোর্সে চলে গেছে', 'success');
    }

    state.page = 1;
    state.items = [];
    state.hasMore = true;
    state.searchQuery = '';
    dom.searchInput.value = '';
    dom.searchClear.hidden = true;

    updateSectionHead();
    loadFeatured();
    loadList();
  }

  /* ─── Badges ────────────────────────────────────────────────────────── */
  function qualityBadge(q) {
    if (!q) return '';
    const s = String(q).toLowerCase();
    if (/4k|2160p/.test(s)) return '<span class="badge badge--4k">4K</span>';
    if (/1080p|1080/.test(s)) return '<span class="badge badge--1080p">1080P</span>';
    if (/720p|720/.test(s)) return '<span class="badge badge--720p">720P</span>';
    if (/480p|480/.test(s)) return '<span class="badge badge--480p">480P</span>';
    return '';
  }
  function sourceBadge(q) {
    const s = String(q || '').toLowerCase();
    if (s.includes('bluray') || s.includes('blu-ray')) return '<span class="badge badge--bluray">BluRay</span>';
    if (s.includes('web-dl') || s.includes('webdl') || s.includes('webrip')) return '<span class="badge badge--web-dl">WEB-DL</span>';
    if (s.includes('hdtc') || s.includes('hdts') || s.includes('hdrip')) return '<span class="badge badge--hdtc">HDTC</span>';
    return '';
  }
  function languageBadge(lang) {
    const s = String(lang || '').toLowerCase();
    if (s.includes('bengali') || s.includes('bangla')) return '<span class="badge badge--bengali">বাংলা</span>';
    if (s.includes('hindi')) return '<span class="badge badge--hindi">Hindi</span>';
    if (s.includes('english')) return '<span class="badge badge--english">English</span>';
    if (s.includes('dual')) return '<span class="badge badge--dual">Dual</span>';
    return '';
  }
  function platformBadge(title) {
    const s = String(title || '').toLowerCase();
    const map = [
      ['netflix', 'Netflix', 'badge--netflix'], ['amazon', 'Prime', 'badge--amazon'],
      ['zee5', 'Zee5', 'badge--zee5'], ['hotstar', 'Hotstar', 'badge--hotstar'],
      ['jiohs', 'JioHot', 'badge--hotstar'], ['hoichoi', 'Hoichoi', 'badge--hoichoi'],
      ['bongobd', 'BongoBD', 'badge--hoichoi'], ['sonyliv', 'SonyLIV', 'badge--amazon'],
    ];
    const out = [];
    for (const [k, label, cls] of map)
      if (s.includes(k) && !out.find((b) => b.includes(label)))
        out.push(`<span class="badge ${cls}">${label}</span>`);
    return out.join('');
  }
  function featureBadges(title) {
    const s = String(title || '').toLowerCase();
    const out = [];
    if (s.includes('hdr') || s.includes('dolby')) out.push('<span class="badge badge--hdr">HDR</span>');
    if (s.includes('hevc') || s.includes('x265')) out.push('<span class="badge badge--hevc">HEVC</span>');
    return out.join('');
  }
  function buildBadges(m) {
    const parts = [];
    const qb = qualityBadge(m.quality || m.title); if (qb) parts.push(qb);
    const lb = languageBadge(m.language || m.title); if (lb) parts.push(lb);
    const sb = sourceBadge(m.quality || m.title); if (sb) parts.push(sb);
    const pb = platformBadge(m.title); if (pb) parts.push(pb);
    const fb = featureBadges(m.title + ' ' + (m.quality || '')); if (fb) parts.push(fb);
    return parts.slice(0, 5).join('');
  }
  function extractYear(title) { const m = String(title || '').match(/\((\d{4})\)|(\d{4})/); return m ? (m[1] || m[2]) : ''; }
  function prettyTitle(title) {
    return String(title || '')
      .replace(/\s*[-–—]\s*\d{3,4}[pP].*$/i, '')
      .replace(/\s*[-–—]\s*x26[45].*$/i, '')
      .replace(/\s*[-–—]\s*[\d.]+\s*(?:GB|MB).*$/i, '')
      .replace(/\s*[-–—]\s*(?:HEVC|AVC|AV1).*$/i, '')
      .replace(/\s*[-–—]\s*(?:ESub|Dual\sAudio|Multi\sAudio).*$/i, '')
      .replace(/\s*[-–—]\s*(Download|Watch)\s*&?\s*(Watch\s*Online)?\s*$/i, '')
      .replace(/\s*Download\s*&?\s*Watch\s*Online\s*$/i, '')
      .replace(/&#038;/g, '&')
      .replace(/&#8211;|&#8212;|&#8217;|&#8220;|&#8221;|&#8230;/g, (c) => ({
        '&#8211;': '–', '&#8212;': '—', '&#8217;': "'",
        '&#8220;': '"', '&#8221;': '"', '&#8230;': '…'
      })[c])
      .replace(/\s*[-–—]\s*$/, '')
      .trim();
  }
  function extractSizes(title) { const m = String(title || '').match(/([\d.]+\s*(?:GB|MB))/gi); return m ? m.slice(0, 4) : []; }

  /* ─── Notice marquee ────────────────────────────────────────────────── */
  async function loadNotice() {
    try {
      const r = await fetchJson(getApi().notice);
      if (r.items && r.items.length) {
        dom.noticeMarquee.innerHTML = r.items.map((t) => `␥ ${escapeHtml(t)}`).join('&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;');
      } else {
        dom.noticeMarquee.textContent = '␥ Welcome to SKMovies — ad-free premium movie streamer';
      }
    } catch {
      dom.noticeMarquee.textContent = '␥ Welcome to SKMovies — ad-free premium movie streamer';
    }
  }

  /* ─── Featured slider ───────────────────────────────────────────────── */
  async function loadFeatured() {
    try {
      const adultParam = state.filter18 ? '' : '?adult=1';
      const r = await fetchJson(`${getApi().trending}${adultParam}`);
      const items = r.items || [];
      if (items.length === 0) { dom.featuredSection.hidden = true; return; }
      dom.featuredSlides.innerHTML = items.map((m) => `
        <div class="slider-post">
          <a href="/?movie=${encodeURIComponent(m.slug)}" data-slug="${escapeHtml(m.slug)}">
            <div class="featured-post">
              ${m.poster ? `<img src="${escapeHtml(imgProxy(m.poster))}" alt="${escapeHtml(prettyTitle(m.title))}" loading="lazy" decoding="async" onerror="if(this.src!=='${escapeHtml(m.poster)}') this.src='${escapeHtml(m.poster)}';">` : ''}
              <div class="title"><h3>${escapeHtml(prettyTitle(m.title))}</h3></div>
            </div>
          </a>
        </div>
      `).join('');
      dom.featuredSlides.querySelectorAll('a[data-slug]').forEach((a) => {
        a.addEventListener('click', (e) => { e.preventDefault(); openMovie(a.getAttribute('data-slug')); });
      });
    } catch { dom.featuredSection.hidden = true; }
  }

  /* ─── Filters ───────────────────────────────────────────────────────── */
  function renderFilters() {
    dom.filtersScroll.innerHTML = FILTERS.map((f) =>
      `<button class="pill ${f.id === state.filter ? 'is-active' : ''}" data-filter="${f.id}">${escapeHtml(f.label)}</button>`
    ).join('');
  }
  function setFilter(filterId) {
    if (state.filter === filterId && state.view === 'latest') return;
    state.filter = filterId; state.view = 'latest'; state.page = 1; state.items = []; state.hasMore = true;
    renderFilters(); updateSectionHead(); setActiveNav('latest'); loadList();
  }

  /* ─── Skeletons ─────────────────────────────────────────────────────── */
  function showSkeletons(n = 10) {
    dom.skeletonGrid.innerHTML = Array.from({ length: n }).map(() =>
      `<div class="skeleton"><div class="skeleton__poster"></div><div class="skeleton__line"></div><div class="skeleton__line"></div></div>`
    ).join('');
    dom.skeletonGrid.hidden = false; dom.grid.hidden = true; dom.loadMore.hidden = true; dom.empty.hidden = true;
  }
  function hideSkeletons() { dom.skeletonGrid.hidden = true; dom.grid.hidden = false; }

  /* ─── Movie cards ───────────────────────────────────────────────────── */
  function isSlowConnection() {
    if (navigator.connection) {
      const conn = navigator.connection;
      if (conn.saveData) return true;
      if (conn.effectiveType && ['slow-2g', '2g', '3g'].includes(conn.effectiveType)) return true;
    }
    return false;
  }

  function cardHtml(m) {
    const title = prettyTitle(m.title);
    const year = m.year || extractYear(m.title);
    const poster = m.poster ? imgProxy(m.poster) : '';
    const originalPoster = m.poster || '';
    const sizes = m.sizes && m.sizes.length ? m.sizes : extractSizes(m.title);
    const badges = buildBadges(m);

    const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300">
        <rect width="200" height="300" fill="#1e293b"/>
        <text x="100" y="150" font-family="sans-serif" font-size="14" fill="#94a3b8" text-anchor="middle">No Poster</text>
      </svg>`
    );

    const showPoster = !isSlowConnection();
    // [#3] Use native loading="lazy" + decoding="async" — observer is the fallback only.
    const imgTag = showPoster && poster
      ? `<img src="${escapeHtml(poster)}" alt="${escapeHtml(title)}" width="200" height="300" loading="lazy" decoding="async" data-original="${escapeHtml(originalPoster)}" onerror="handleImgError(this)">`
      : `<img src="${PLACEHOLDER}" alt="${escapeHtml(title)}" width="200" height="300">`;

    return `
      <article class="single-post" role="button" tabindex="0" data-slug="${escapeHtml(m.slug)}" aria-label="${escapeHtml(title)}">
        <div class="thumb">
          ${imgTag}
          <div class="badges">${badges}</div>
        </div>
        <div class="post-desc">
          <h2 class="post-title">${escapeHtml(title)}</h2>
          <div class="post-meta">
            ${year ? `<span class="post-meta-item"><i class="ab ab-clock"></i>${escapeHtml(year)}</span>` : ''}
            ${m.uploadDate ? `<span class="dot">•</span><span class="post-meta-item">${escapeHtml(m.uploadDate)}</span>` : ''}
            ${sizes && sizes.length ? `<span class="dot">•</span><span class="post-meta-item">📦 ${escapeHtml(sizes[0])}</span>` : ''}
          </div>
        </div>
      </article>`;
  }

  function handleImgError(img) {
    const original = img.getAttribute('data-original');
    const currentSrc = img.src;
    if (img.dataset.triedOriginal === '1') {
      img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300">
          <rect width="200" height="300" fill="#1e293b"/>
          <text x="100" y="140" font-family="sans-serif" font-size="14" fill="#94a3b8" text-anchor="middle">No Poster</text>
          <text x="100" y="160" font-family="sans-serif" font-size="10" fill="#64748b" text-anchor="middle">Preview unavailable</text>
        </svg>`
      );
      img.style.objectFit = 'contain';
      return;
    }
    if (original && currentSrc !== original) {
      img.dataset.triedOriginal = '1';
      img.src = original;
      return;
    }
    img.dataset.triedOriginal = '1';
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#1e293b"/><text x="100" y="150" font-family="sans-serif" font-size="14" fill="#94a3b8" text-anchor="middle">No Poster</text></svg>`
    );
  }
  window.handleImgError = handleImgError;

  let currentCardIndex = -1;
  function renderGrid() {
    if (state.items.length === 0) { dom.grid.innerHTML = ''; dom.empty.hidden = !state.isLoading; return; }
    dom.grid.innerHTML = state.items.map(cardHtml).join('');
    dom.empty.hidden = true;
    dom.loadMore.hidden = !state.hasMore;
    setupLazyImages();
  }

  function getLazyImageObserver() {
    if (lazyImageObserver) return lazyImageObserver;
    if (!('IntersectionObserver' in window)) return null;
    // [#12] Reduced root margin from 200px → 100px to cut initial image fetches.
    lazyImageObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.original) {
            img.src = img.dataset.original;
            delete img.dataset.original;
          }
          img.classList.add('is-loaded');
          lazyImageObserver.unobserve(img);
        }
      });
    }, { rootMargin: '100px 0px', threshold: 0.01 });
    return lazyImageObserver;
  }

  function setupLazyImages() {
    const images = document.querySelectorAll('img[data-original]:not(.is-observed)');
    const io = getLazyImageObserver();
    if (io) {
      images.forEach(img => { img.classList.add('is-observed'); io.observe(img); });
    } else {
      images.forEach(img => {
        if (img.dataset.original) { img.src = img.dataset.original; delete img.dataset.original; }
        img.classList.add('is-loaded');
      });
    }
  }

  function appendGrid(items) {
    dom.grid.insertAdjacentHTML('beforeend', items.map(cardHtml).join(''));
    setupLazyImages();
  }

  /* ─── List loading ──────────────────────────────────────────────────── */
  async function loadList({ append = false } = {}) {
    if (state.isLoading) return;
    state.isLoading = true;
    if (!append) showSkeletons();
    else if (dom.loadMore) dom.loadMore.hidden = false;
    if (dom.loadMoreBtn) {
      dom.loadMoreBtn.disabled = true;
      dom.loadMoreBtn.textContent = 'আরও আনা হচ্ছে…';
    }
    try {
      state.hasError = false;
      let items = [];
      const adultParam = state.filter18 ? '' : '&adult=1';
      if (state.view === 'favs') { items = ls.get(STORE.favs, []).slice().reverse(); state.hasMore = false; renderListResult(items, append); return; }
      if (state.view === 'history') { items = ls.get(STORE.history, []).slice().reverse(); state.hasMore = false; renderListResult(items, append); return; }
      if (state.view === 'trending') {
        const r = await fetchJson(`${getApi().trending}?${state.filter18 ? '' : 'adult=1'}`);
        items = r.items || []; state.hasMore = false; renderListResult(items, append); return;
      }
      if (state.view === 'south') {
        const slug = state.source === 'fdm' ? 'south-indian' : 'south-indian-movies';
        const url = state.source === 'fdm'
          ? `/api/fdm/category?slug=${slug}&page=${state.page}${adultParam}`
          : `/api/south?page=${state.page}${adultParam}`;
        const r = await fetchJson(url);
        items = r.items || []; state.hasMore = !!r.hasMore; renderListResult(items, append); return;
      }
      if (state.view === 'south-hindi') {
        const url = state.source === 'fdm'
          ? `/api/fdm/search?q=hindi%20dubbed&page=${state.page}${adultParam}`
          : `/api/south?hindi=1&page=${state.page}${adultParam}`;
        const r = await fetchJson(url);
        items = r.items || []; state.hasMore = !!r.hasMore; renderListResult(items, append); return;
      }
      if (state.view === 'category') {
        let url;
        if (state.source === 'fdm' && (state.categorySlug === 'hindi-dubbed' || state.categorySlug === 'dual-audio')) {
          const query = state.categorySlug === 'hindi-dubbed' ? 'hindi dubbed' : 'dual audio';
          url = `/api/fdm/search?q=${encodeURIComponent(query)}&page=${state.page}${adultParam}`;
        } else {
          url = `${getApi().category}?slug=${encodeURIComponent(state.categorySlug)}&page=${state.page}${adultParam}`;
        }
        const r = await fetchJson(url);
        items = r.items || []; state.hasMore = !!r.hasMore; renderListResult(items, append); return;
      }
      if (state.view === 'search') {
        if (!state.searchQuery) { state.isLoading = false; hideSkeletons(); dom.empty.hidden = false; return; }
        const r = await fetchJson(`${getApi().search}?q=${encodeURIComponent(state.searchQuery)}&page=${state.page}${adultParam}`);
        items = r.items || []; state.hasMore = !!r.hasMore; renderListResult(items, append); return;
      }
      const params = new URLSearchParams({ page: String(state.page) });
      if (state.filter !== 'all') params.set('filter', state.filter);
      if (!state.filter18) params.set('adult', '1');
      const r = await fetchJson(`${getApi().latest}?${params}`);
      items = r.items || []; state.hasMore = !!r.hasMore;
      renderListResult(items, append);
    } catch (e) {
      console.error('loadList error:', e);
      state.hasError = true;
      const msg = e.message || 'লোড ব্যর্থ।';
      toast(msg, 'error', 6000);
      if (!append) {
        dom.empty.hidden = false;
        const emptyH3 = dom.empty.querySelector('h3');
        const emptyP = dom.empty.querySelector('p');
        if (emptyH3) emptyH3.textContent = 'লোড করা যায়নি';
        if (emptyP) emptyP.innerHTML = `${escapeHtml(msg)}<br><button class="view-more-btn" onclick="window.__skm.retryList()" style="margin-top:12px">আবার চেষ্টা করুন</button>`;
      }
    } finally {
      state.isLoading = false;
      if (dom.loadMoreBtn) { dom.loadMoreBtn.disabled = false; dom.loadMoreBtn.textContent = 'Load More'; }
    }
  }

  window.__skm = window.__skm || {};
  window.__skm.retryList = () => {
    state.hasError = false;
    state.page = 1;
    state.items = [];
    dom.empty.hidden = true;
    loadList();
  };

  function renderListResult(items, append) {
    if (append) { state.items = state.items.concat(items); appendGrid(items); }
    else { state.items = items; hideSkeletons(); renderGrid(); }

    if (state.items.length === 0) {
      dom.empty.hidden = false;
      const emptyImg = dom.empty.querySelector('img');
      const emptyH3 = dom.empty.querySelector('h3');
      const emptyP = dom.empty.querySelector('p');

      if (state.view === 'search') {
        if (emptyImg) emptyImg.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">
            <circle cx="80" cy="60" r="40" fill="none" stroke="%2394a3b8" stroke-width="2" stroke-dasharray="4 4"/>
            <text x="80" y="68" font-family="sans-serif" font-size="32" fill="%2394a3b8" text-anchor="middle">🔍</text>
          </svg>`
        );
        if (emptyH3) emptyH3.textContent = 'কিছু পাওয়া যায়নি';
        if (emptyP) emptyP.innerHTML = `"${escapeHtml(state.searchQuery)}" এর জন্য কোনো মুভি পাওয়া যায়নি।<br>অন্য নাম দিয়ে চেষ্টা করুন।`;
      } else if (state.view === 'favs') {
        if (emptyH3) emptyH3.textContent = 'ওয়াচলিস্ট খালি';
        if (emptyP) emptyP.textContent = 'পছন্দের মুভিতে ⭐ চাপ দিন।';
      } else if (state.view === 'history') {
        if (emptyH3) emptyH3.textContent = 'হিস্ট্রি খালি';
        if (emptyP) emptyP.textContent = 'দেখা মুভিগুলো এখানে দেখা যাবে।';
      } else {
        if (emptyH3) emptyH3.textContent = 'কোনো মুভি নেই';
        if (emptyP) emptyP.textContent = 'অন্য সার্চ বা ক্যাটাগরি চেষ্টা করুন।';
      }
      dom.grid.innerHTML = '';
    }
  }

  /* ─── Movie modal ───────────────────────────────────────────────────── */
  const FOCUSABLE_SELECTORS = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let focusTrapState = { element: null, previousFocus: null, handler: null };

  function trapFocus(element) {
    focusTrapState.previousFocus = document.activeElement;
    const focusable = element.querySelectorAll(FOCUSABLE_SELECTORS);
    if (focusable.length > 0) setTimeout(() => focusable[0].focus(), 50);
    focusTrapState.element = element;
    focusTrapState.handler = (e) => {
      if (e.key !== 'Tab') return;
      const focusableEls = element.querySelectorAll(FOCUSABLE_SELECTORS);
      if (focusableEls.length === 0) return;
      const first = focusableEls[0];
      const last = focusableEls[focusableEls.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    element.addEventListener('keydown', focusTrapState.handler);
  }

  function releaseFocus() {
    if (focusTrapState.handler && focusTrapState.element) {
      focusTrapState.element.removeEventListener('keydown', focusTrapState.handler);
    }
    if (focusTrapState.previousFocus && typeof focusTrapState.previousFocus.focus === 'function') {
      try { focusTrapState.previousFocus.focus(); } catch (e) {}
    }
    focusTrapState = { element: null, previousFocus: null, handler: null };
  }

  async function openMovie(slug, { pushState = true } = {}) {
    state.currentMovieSlug = slug;
    dom.modal.hidden = false; dom.modal.style.display = ''; dom.modal.setAttribute('aria-hidden', 'false');
    scrollLock.lock();
    trapFocus(dom.modal);

    // Check prefetch cache first
    const cached = prefetchCacheGet(slug);
    if (cached) {
      state.currentMovieData = cached;
      recordHistory(slug);
      if (pushState) {
        const url = new URL(location.href);
        url.searchParams.set('movie', slug);
        history.pushState({ slug }, '', url.toString());
      }
      renderMovieModal(cached);
      return;
    }

    dom.modalBody.innerHTML = '<div class="skeleton-modal"></div>';
    try {
      const params = new URLSearchParams(location.search);
      const nocache = params.get('nocache');
      let apiUrl = `${getApi().movie}?slug=${encodeURIComponent(slug)}`;
      if (nocache) apiUrl += `&nocache=${nocache}`;
      if (pushState) {
        const url = new URL(location.href);
        url.searchParams.set('movie', slug);
        history.pushState({ slug }, '', url.toString());
      }
      const r = await fetchJson(apiUrl);
      state.currentMovieData = r;
      recordHistory(slug);
      renderMovieModal(r);
    } catch (e) {
      dom.modalBody.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted)">Failed to load. <button class="btn btn--small" onclick="window.__skm.retry()">Retry</button></div>`;
    }
  }

  window.__skm = window.__skm || {};
  window.__skm.openMovie = openMovie;
  window.__skm.closeModal = closeModal;
  window.__skm.closeSheet = closeSheet;
  window.__skm.closeCategoriesSheet = closeCategoriesSheet;
  window.__skm.retry = () => state.currentMovieSlug && openMovie(state.currentMovieSlug);

  function renderMovieModal(m) {
    currentModalMovie = m;
    const title = prettyTitle(m.title);
    const info = m.info || {};
    const sizes = Array.isArray(info.size) ? info.size : (info.size || '').split('|').map((s) => s.trim()).filter(Boolean);
    const resolutions = Array.isArray(info.resolution) ? info.resolution : (info.resolution || '').split('|').map((s) => s.trim()).filter(Boolean);
    const genres = m.genres || (Array.isArray(info.genre) ? info.genre : (typeof info.genre === 'string' ? info.genre.split(',').map((g) => g.trim()).filter(Boolean) : []));
    const cast = info.cast || [];
    const downloads = m.downloads || [];
    const screenshots = m.screenshots || [];
    const favs = ls.get(STORE.favs, []);
    const isFav = favs.some((f) => f.slug === m.slug);

    document.title = `${title} — SKMovies`;
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    const cleanCanonical = `https://skmovies-premium.pages.dev/?movie=${encodeURIComponent(m.slug)}`;
    canonical.href = cleanCanonical;

    updateMetaTag('og:title', `${title} — SKMovies`);
    updateMetaTag('og:description', info.storyline || `Watch ${title} on SKMovies`);
    updateMetaTag('og:image', m.poster || '/assets/og-image.webp');
    updateMetaTag('og:url', cleanCanonical);
    updateMetaTag('twitter:title', `${title} — SKMovies`);
    updateMetaTag('twitter:image', m.poster || '/assets/og-image.webp');

    const groups = [];
    const seenGroups = new Map();
    downloads.forEach((d) => {
      const infoText = `${d.info || ''} ${d.label || ''}`;
      const sizeMatch = infoText.match(/([\d.]+\s*(?:GB|MB))/i);
      const size = sizeMatch ? sizeMatch[1] : '';
      let groupKey = (d.info || 'Download Links').trim();
      groupKey = groupKey.replace(/[-|]?\s*\d{3,4}[pP]\s*/g, '');
      groupKey = groupKey.replace(/[-|]?\s*[\d.]+\s*(?:GB|MB)\s*/g, '');
      groupKey = groupKey.replace(/^[-| \s]+|[-| \s]+$/g, '').trim();
      if (!groupKey) groupKey = 'Download Links';
      if (!seenGroups.has(groupKey)) {
        const g = { title: groupKey, items: [] };
        groups.push(g);
        seenGroups.set(groupKey, g);
      }
      seenGroups.get(groupKey).items.push({ ...d, size });
    });

    const chips = [
      info.imdbRating && !info.imdbRating.includes('N/A') ? `<span class="chip chip--imdb">&#11088; IMDb ${escapeHtml(info.imdbRating)}</span>` : '',
      info.quality ? `<span class="chip chip--quality">${escapeHtml(info.quality)}</span>` : '',
      info.year ? `<span class="chip">&#128197; ${escapeHtml(info.year)}</span>` : '',
      info.runtime && info.runtime !== 'N/A' ? `<span class="chip">&#9201; ${escapeHtml(info.runtime)}</span>` : '',
      info.language ? `<span class="chip">&#127760; ${escapeHtml(info.language)}</span>` : '',
      ...genres.slice(0, 3).map((g) => `<span class="chip">${escapeHtml(g)}</span>`),
    ].filter(Boolean).join('');
    const heroBg = m.poster ? escapeHtml(imgProxy(m.poster)) : '';

    const trailerUrl = m.trailer && /^https?:\/\//.test(m.trailer)
      ? m.trailer
      : `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' official trailer')}`;

    dom.modalBody.innerHTML = `
      <div class="movie-hero" style="--hero-bg: url('${heroBg}')">
        <div class="movie-hero__overlay"></div>
        <div class="movie-hero__content">
          <div class="movie-hero__info">
            <h1 class="movie-hero__title">${escapeHtml(title)}</h1>
            ${chips ? `<div class="movie-hero__chips">${chips}</div>` : ''}
            <div class="movie-hero__actions">
              ${downloads.length ? `<button class="hero-btn hero-btn--primary" id="openPlayerBtn">&#9654; Play / Download</button>` : ''}
              <a class="hero-btn hero-btn--ghost" href="${escapeHtml(trailerUrl)}" target="_blank" rel="noopener">&#127916; Trailer</a>
              <button class="hero-btn hero-btn--ghost hero-btn--fav" id="favBtn" data-fav="${isFav ? '1' : '0'}">${isFav ? '&#9733; Watchlisted' : '&#9734; Watchlist'}</button>
              ${screenshots.length ? `<button class="hero-btn hero-btn--ghost" id="showShots">&#128444; Shots</button>` : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="movie-detail-body">
        <div class="movie-info-cols">
          ${m.poster ? `
          <div class="movie-info-poster">
            <img src="${heroBg}" alt="${escapeHtml(title)}" loading="eager" decoding="async" onerror="if(this.src!=='${escapeHtml(m.poster)}') this.src='${escapeHtml(m.poster)}';">
          </div>` : ''}
          <div class="movie-info-details">
            <div class="movie-info-grid">
              ${info.director ? `<div class="movie-info-row"><strong>Director</strong><span>${escapeHtml(info.director)}</span></div>` : ''}
              ${cast.length ? `<div class="movie-info-row"><strong>Cast</strong><span>${escapeHtml(cast.slice(0,5).join(', '))}</span></div>` : ''}
              ${resolutions.length ? `<div class="movie-info-row"><strong>Resolution</strong><span>${escapeHtml(resolutions.join(' | '))}</span></div>` : ''}
              ${sizes.length ? `<div class="movie-info-row"><strong>File Size</strong><span>${escapeHtml(sizes.join(' | '))}</span></div>` : ''}
              ${m.uploadDate ? `<div class="movie-info-row"><strong>Uploaded</strong><span>${escapeHtml(m.uploadDate)}</span></div>` : ''}
            </div>
            ${info.storyline && info.storyline !== 'N/A' ? `<div class="movie-storyline"><div class="movie-storyline-label">&#128214; Storyline</div><p>${escapeHtml(info.storyline)}</p></div>` : ''}
          </div>
        </div>
        ${screenshots.length ? `<div id="shotsSection">
          <div class="post-section-title screenshots">Screenshots</div>
          <div class="screenshots">
            ${screenshots.map((s) => `<a class="screenshot" href="${escapeHtml(imgProxy(s))}" target="_blank" rel="noopener"><img src="${escapeHtml(imgProxy(s))}" alt="Screenshot" loading="lazy" decoding="async" onerror="if(this.src!=='${escapeHtml(s)}') this.src='${escapeHtml(s)}';"></a>`).join('')}
          </div>
        </div>` : ''}
        ${downloads.length ? `
          <div class="post-section-title download">Download Links</div>
          <div class="download-sections">
            ${groups.map((g) => `
              <div class="dl-group">
                <div class="dl-group__title">${escapeHtml(g.title)}</div>
                <div class="dl-group__grid">
                  ${g.items.map((item) => {
                    const cls = /480/i.test(item.quality) ? 'sd' : /720/i.test(item.quality) ? 'hd' : /1080/i.test(item.quality) ? 'fhd' : 'uhd';
                    return `<a class="dl-btn dl-btn--${cls}" data-savelinks="${escapeHtml(item.savelinks_url)}" data-quality="${escapeHtml(item.quality)}" data-size="${escapeHtml(item.size || '')}" href="#"><span class="dl-btn__quality">${escapeHtml(item.quality)}</span>${item.size ? `<span class="dl-btn__size">${escapeHtml(item.size)}</span>` : ''}</a>`;
                  }).join('')}
                </div>
              </div>`).join('')}
          </div>` : ''}
        <div style="margin-top:24px;text-align:center;padding-bottom:8px">
          <a href="https://t.me/skmovies" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:8px;background:rgba(30,136,229,0.12);border:1.5px solid rgba(30,136,229,0.3);color:#42a5f5;padding:12px 24px;border-radius:999px;font-family:var(--font-primary);font-weight:700;font-size:14px;text-decoration:none">&#128242; Join Telegram for Updates</a>
        </div>
      </div>
    `;
  }

  function updateMetaTag(property, content) {
    let meta = document.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
    if (!meta) {
      meta = document.createElement('meta');
      if (property.startsWith('og:')) meta.setAttribute('property', property);
      else meta.setAttribute('name', property);
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', content);
  }

  function closeModal({ pushState = true } = {}) {
    dom.modal.hidden = true; dom.modal.style.display = 'none'; dom.modal.setAttribute('aria-hidden', 'true');
    scrollLock.unlock();
    releaseFocus();
    state.currentMovieSlug = null;
    const card = dom.modal.querySelector('.modal__card');
    if (card) card.scrollTop = 0;

    // [#7] Clear content after animation, but only if no new modal was opened meanwhile
    setTimeout(() => {
      if (dom.modal.hidden) dom.modalBody.innerHTML = '';
    }, 300);

    document.title = 'SKMovies » The Largest Movie Link Store of Bangladesh';
    updateMetaTag('og:title', 'SKMovies — The Largest Movie Link Store of Bangladesh');
    updateMetaTag('og:description', 'One place you will ever need for your favorite movies and series.');
    updateMetaTag('og:image', '/assets/og-image.webp');

    if (pushState) {
      const url = new URL(location.href);
      if (url.searchParams.has('movie')) {
        url.searchParams.delete('movie');
        if (history.length > 1) history.back();
        else history.replaceState(null, '', url.toString());
      }
    }
  }

  /* ─── Favorites + History ───────────────────────────────────────────── */
  function toggleFav(m, btn) {
    const favs = ls.get(STORE.favs, []);
    const idx = favs.findIndex((f) => f.slug === m.slug);
    if (idx >= 0) {
      favs.splice(idx, 1);
      btn.innerHTML = '&#9734; Watchlist';
      btn.setAttribute('data-fav', '0');
      toast('ওয়াচলিস্ট থেকে সরানো হয়েছে', 'info');
    } else {
      favs.push({
        slug: m.slug, title: m.title, poster: m.poster || '',
        quality: m.info?.quality || m.quality || '',
        language: m.info?.language || m.language || '',
        year: m.info?.year || extractYear(m.title) || '',
        uploadDate: m.uploadDate || '', addedAt: Date.now()
      });
      btn.innerHTML = '&#9733; Watchlisted';
      btn.setAttribute('data-fav', '1');
      toast('ওয়াচলিস্টে যোগ হয়েছে', 'success');
    }
    ls.set(STORE.favs, favs);
  }

  function recordHistory(slug) {
    setTimeout(() => {
      let history = ls.get(STORE.history, []);
      history = history.filter((h) => h.slug !== slug);
      const movieData = state.currentMovieData || {};
      history.unshift({
        slug, title: movieData.title || slug, poster: movieData.poster || '',
        quality: movieData.info?.quality || '', language: movieData.info?.language || '',
        year: movieData.info?.year || '', viewedAt: Date.now()
      });
      history = history.slice(0, 50);
      ls.set(STORE.history, history);
    }, 0);
  }

  /* ─── Player resolution + sheet ─────────────────────────────────────── */
  let pendingResolveId = 0;
  const URL_FRESHNESS_MS = 4 * 60 * 1000;
  let lastResolvedAt = 0;
  let lastResolvedUrl = '';
  let lastResolvedSavelinks = '';

  async function ensureFreshUrl(savelinksUrl, currentBestUrl) {
    if (!/savelinks|freedrivemovie\.cyou\/links/i.test(savelinksUrl)) return currentBestUrl;
    if (Date.now() - lastResolvedAt < URL_FRESHNESS_MS &&
        lastResolvedSavelinks === savelinksUrl &&
        lastResolvedUrl === currentBestUrl) return currentBestUrl;
    try {
      const r = await fetchJson(`${getApi().resolve}?url=${encodeURIComponent(savelinksUrl)}`);
      if (r.ok && r.urls && r.urls.length) {
        lastResolvedAt = Date.now();
        lastResolvedSavelinks = savelinksUrl;
        lastResolvedUrl = r.urls[0];
        return r.urls[0];
      }
    } catch {}
    return currentBestUrl;
  }

  async function probeVideoUrl(url) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4000);
      const resp = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(t);
      return resp.ok || resp.status === 206 || resp.status === 302;
    } catch { return false; }
  }

  // [#11 SECURITY] Validate savelinks URLs to be http(s) only — guards against
  // malformed backend responses that might inject javascript: URLs.
  function isSafeUrl(u) {
    return typeof u === 'string' && /^https?:\/\//i.test(u);
  }

  async function resolveAndOpenPlayer(savelinksUrl, title, quality, size) {
    if (!isSafeUrl(savelinksUrl)) {
      toast('অগ্রহণযোগ্য লিংক।', 'error');
      return;
    }
    pendingResolveId++;
    const myId = pendingResolveId;

    state.currentSavelinksUrl = savelinksUrl;
    state.currentTitle = title;
    state.currentQuality = quality;

    const isSavelinks = /savelinks/i.test(savelinksUrl);
    const isFdmLink = /freedrivemovie\.(cyou|org|com)\/(links|episodes)\//i.test(savelinksUrl);

    if (!isSavelinks && !isFdmLink) {
      const isZip = /\.zip\b/i.test(savelinksUrl) || savelinksUrl.includes('.zip');
      if (isZip) { toast('ZIP ডাউনলোড শুরু হচ্ছে…', 'success'); window.open(savelinksUrl, '_blank'); return; }
      const isVideo = /\.(mp4|mkv|m3u8|webm)\b/i.test(savelinksUrl);
      if (!isVideo) { toast('বাইরের লিংক খোলা হচ্ছে…', 'success'); window.open(savelinksUrl, '_blank'); return; }
      recordUrl(quality || 'DL', savelinksUrl, title);
      openPlayerSheet(savelinksUrl, title, []);
      return;
    }

    openSheet({
      title: 'লিংক আনা হচ্ছে',
      hint: 'আপনার জন্য সরাসরি ভিডিও লিংক খোঁজা হচ্ছে…',
      loading: true,
      tip: 'এতে সাধারণত ১-৩ সেকেন্ড সময় লাগে।',
    });

    try {
      const r = await fetchJson(`${getApi().resolve}?url=${encodeURIComponent(savelinksUrl)}`, { signal: null });
      if (myId !== pendingResolveId) return;

      const hostBtns = (r.hosts || []).filter((h) => h && h.url && isSafeUrl(h.url))
        .map((h) => {
          let btnText = h.host || 'Open';
          let isTextUrl = /^https?:\/\//i.test(h.text);
          let specificText = (h.text && !isTextUrl && h.text.length > (h.host || '').length && h.text.length < 100 && !/^\s*$/.test(h.text)) ? h.text : '';
          if (specificText) btnText = specificText;
          else {
            if (quality) btnText += ` • ${quality}`;
            if (size) btnText += ` • ${size}`;
          }
          return `<a class="sheet__btn" href="${escapeHtml(h.url)}" target="_blank" rel="noopener"><span class="sheet__btn-icon">🌐</span>${escapeHtml(btnText)}</a>`;
        })
        .join('');
      const fallbackInstructions = hostBtns
        ? `<span class="sheet__btn sheet__btn--tip" style="grid-column:1/-1;font-size:12px;opacity:.7;justify-content:center;cursor:default">↓ সোর্স হোস্ট থেকে ম্যানুয়ালি ডাউনলোড করুন</span>${hostBtns}`
        : `<a class="sheet__btn sheet__btn--primary" href="${escapeHtml(savelinksUrl)}" target="_blank" rel="noopener"><span class="sheet__btn-icon">🌐</span>সোর্স পেজ খুলুন</a>`;

      if (!r.ok || !r.urls || r.urls.length === 0) {
        openSheet({ title: 'সরাসরি লিংক পাওয়া যায়নি', hint: 'অটো-এক্সট্র্যাক্ট করা সম্ভব হয়নি। নিচে থেকে সোর্স পেজ খুলুন।', tip: '', fallbackUrl: savelinksUrl });
        dom.sheetGrid.innerHTML = fallbackInstructions;
        dom.sheetUrl.value = savelinksUrl;
        return;
      }

      const best = r.urls[0];
      const isZip = /\.zip\b/i.test(best) || best.includes('.zip');
      if (isZip) {
        closeSheet();
        toast('ZIP ডাউনলোড শুরু হচ্ছে…', 'success');
        window.open(best, '_blank');
        return;
      }

      lastResolvedAt = Date.now();
      lastResolvedSavelinks = savelinksUrl;
      lastResolvedUrl = best;

      recordUrl(quality || 'DL', best, title);
      openPlayerSheet(best, title, r.urls.slice(1));

      if (hostBtns) {
        setTimeout(() => {
          const sep = document.createElement('span');
          sep.className = 'sheet__btn sheet__btn--tip';
          sep.style.cssText = 'grid-column:1/-1;font-size:12px;opacity:.7;justify-content:center;cursor:default;margin-top:8px';
          sep.textContent = '↓ অথবা মূল হোস্ট সরাসরি খুলুন';
          dom.sheetGrid.appendChild(sep);
          dom.sheetGrid.insertAdjacentHTML('beforeend', hostBtns);
        }, 0);
      }
    } catch (e) {
      if (myId !== pendingResolveId) return;
      console.error('resolve error:', e);
      const msg = e.message || 'সার্ভারে পৌঁছানো যাচ্ছে না। আবার চেষ্টা করুন।';
      openSheet({
        title: 'নেটওয়ার্ক সমস্যা', hint: msg,
        tip: 'নিচের বাটনে চাপ দিয়ে সোর্স পেজ সরাসরি খুলুন, অথবা আরেকটি কোয়ালিটি ট্রাই করুন।',
        fallbackUrl: savelinksUrl,
      });
      dom.sheetGrid.innerHTML = `
        <a class="sheet__btn sheet__btn--primary" href="${escapeHtml(savelinksUrl)}" target="_blank" rel="noopener">
          <span class="sheet__btn-icon">🔗</span>সোর্স পেজ খুলুন
        </a>
        <button class="sheet__btn" id="retryResolveBtn">
          <span class="sheet__btn-icon">🔄</span>আবার চেষ্টা করুন
        </button>
      `;
      const retryBtn = document.getElementById('retryResolveBtn');
      if (retryBtn) retryBtn.addEventListener('click', () => resolveAndOpenPlayer(savelinksUrl, title, quality));
      dom.sheetUrl.value = savelinksUrl;
    }
  }

  function openPlayerSheet(directUrl, title, altUrls) {
    openSheet({ title: 'Open with player', hint: getDeviceHint(), players: getPlayerButtons(directUrl, title), url: directUrl, tip: getDeviceTip(), altUrls: altUrls || [] });
  }

  function openSheet({ title, hint, players = '', url = '', tip = '', loading = false, fallbackUrl = '', altUrls = [] }) {
    dom.sheet.hidden = false; dom.sheet.style.display = ''; dom.sheet.setAttribute('aria-hidden', 'false');
    scrollLock.lock();
    dom.sheetTitle.textContent = title; dom.sheetHint.textContent = hint;
    if (loading) {
      dom.sheetGrid.innerHTML = `
        <div class="loading-card">
          <div class="loading-card__spinner"></div>
          <div class="loading-card__title loading-dots">${escapeHtml(title)}</div>
          <div class="loading-card__hint">${escapeHtml(hint)}</div>
          <div class="loading-card__progress"></div>
        </div>
      `;
      dom.sheetUrl.value = '';
      dom.sheetTip.textContent = '';
      return;
    }
    dom.sheetGrid.innerHTML = players; dom.sheetUrl.value = url || fallbackUrl; dom.sheetTip.innerHTML = tip;
    if (altUrls && altUrls.length > 0) {
      const altHtml = altUrls.slice(0, 3).map((u, i) =>
        `<a class="sheet__btn" href="${escapeHtml(wrapInProxy(u))}" target="_blank" rel="noopener"><span class="sheet__btn-icon">🔗</span>Alt #${i + 2}</a>`
      ).join('');
      dom.sheetGrid.insertAdjacentHTML('beforeend', altHtml);
    }
    if (!history.state?.sheetOpen) {
      history.pushState({ ...history.state, sheetOpen: true }, '');
    }
  }

  function closeSheet({ popState = false } = {}) {
    dom.sheet.hidden = true; dom.sheet.style.display = 'none'; dom.sheet.setAttribute('aria-hidden', 'true');
    if (dom.modal.hidden && dom.categoriesSheet.hidden && (player.modal?.hidden ?? true)) {
      scrollLock.unlock();
    }
    if (!popState && history.state?.sheetOpen) history.back();
  }

  let categoriesSource = null;
  function openCategoriesSheet() {
    dom.categoriesSheet.hidden = false; dom.categoriesSheet.style.display = ''; dom.categoriesSheet.setAttribute('aria-hidden', 'false');
    scrollLock.lock();
    if (!dom.categoriesGrid.children.length || dom.categoriesGrid.dataset.source !== state.source) {
      dom.categoriesGrid.innerHTML = getCategories().map((c) =>
        `<button class="sheet__btn" data-slug="${escapeHtml(c.slug)}" data-name="${escapeHtml(c.name)}"><span class="sheet__btn-icon">📁</span>${escapeHtml(c.name)}</button>`
      ).join('');
      dom.categoriesGrid.dataset.source = state.source;
    }
    if (!history.state?.categoriesOpen) {
      history.pushState({ ...history.state, categoriesOpen: true }, '');
    }
  }

  function closeCategoriesSheet({ popState = false } = {}) {
    dom.categoriesSheet.hidden = true; dom.categoriesSheet.style.display = 'none'; dom.categoriesSheet.setAttribute('aria-hidden', 'true');
    if (dom.modal.hidden && dom.sheet.hidden && (player.modal?.hidden ?? true)) {
      scrollLock.unlock();
    }
    if (!popState && history.state?.categoriesOpen) history.back();
  }

  function switchCategory(slug, name) {
    state.view = 'category';
    state.categorySlug = slug;
    state.categoryName = name;
    state.page = 1;
    state.items = [];
    state.hasMore = true;
    state.filter = 'all';
    state.searchQuery = '';
    dom.searchInput.value = '';
    dom.searchClear.hidden = true;
    renderFilters();
    updateSectionHead();
    setActiveNav('');
    dom.dashboard.hidden = true;
    dom.movieSection.hidden = false;
    dom.featuredSection.hidden = true;
    loadList();
  }

  /* ─── Player detection ──────────────────────────────────────────────── */
  function detectDevice() {
    const ua = (navigator.userAgent || '').toLowerCase();
    const isAndroid = /android|adr/.test(ua);
    const isIOS = /iphone|ipad|ipod|ios/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isMac = /mac os x|macintosh/.test(ua) && !isIOS;
    const isWindows = /windows/.test(ua);
    const isLinux = /linux/.test(ua) && !isAndroid;
    return { isAndroid, isIOS, isMac, isWindows, isLinux, isMobile: isAndroid || isIOS, isDesktop: !(isAndroid || isIOS) };
  }
  function getDeviceHint() {
    const d = detectDevice();
    if (d.isAndroid) return 'Android detected — tap a player to launch.';
    if (d.isIOS) return 'iOS detected — tap a player to launch.';
    if (d.isMac) return 'macOS detected — tap a player to launch.';
    if (d.isWindows) return 'Windows detected — tap a player to launch.';
    return 'Tap a player to launch.';
  }
  function getDeviceTip() {
    const d = detectDevice();
    if (d.isAndroid) return 'Tip: MX Player and VLC work best. If a player is missing, install it from Play Store first.';
    if (d.isIOS) return 'Tip: VLC and Infuse work best on iOS. Install them from App Store first.';
    if (d.isMac) return 'Tip: IINA and VLC work best on macOS.';
    if (d.isWindows) return 'Tip: VLC and PotPlayer work best on Windows. MPV is a great lightweight option.';
    return 'Tip: Install VLC for one-tap playback on any device.';
  }
  function getPlayerButtons(rawStreamUrl, title) {
    const streamUrl = wrapInProxy(rawStreamUrl);
    const d = detectDevice();
    const safeTitle = (title || '').replace(/[#;]/g, '').slice(0, 100);
    const intentStreamUrl = streamUrl.replace(/#/g, '%23').replace(/&/g, '%26');
    const btns = [];
    const mkBtn = (label, href, icon, primary = false) =>
      `<a class="sheet__btn ${primary ? 'sheet__btn--primary' : ''}" href="${escapeHtml(href)}" target="_blank" rel="noopener"><span class="sheet__btn-icon">${icon}</span>${escapeHtml(label)}</a>`;
    const dlSvg = '⬇️'; const browserSvg = '🌐';
    const isMkv = /\.(mkv|avi)(\?|$)/i.test(rawStreamUrl) || /mkv/i.test(title);

    btns.push(`<a class="sheet__btn sheet__btn--primary play-in-browser-btn" href="#" data-url="${escapeHtml(rawStreamUrl)}" data-title="${escapeHtml(title)}" ${isMkv ? 'data-unsupported="true"' : ''}><span class="sheet__btn-icon">▶️</span>Play in Browser</a>`);
    if (d.isAndroid) {
      btns.push(mkBtn('External Player', `intent:${intentStreamUrl}#Intent;action=android.intent.action.VIEW;type=video/*;end;`, '📱', true));
    } else {
      btns.push(mkBtn('External Player', `vlc://${intentStreamUrl}`, '📱', true));
    }
    btns.push(mkBtn('Browser', streamUrl, browserSvg));
    btns.push(mkBtn('Download', streamUrl, dlSvg));
    return btns.join('');
  }

  /* ─── Section head + nav ────────────────────────────────────────────── */
  function updateSectionHead() {
    const titles = {
      latest: state.filter === 'all' ? 'Latest Movies' : `${state.filter.toUpperCase()} Movies`,
      trending: '🔥 Trending Now',
      south: '🎬 South Indian Movies',
      'south-hindi': '🎭 South Indian Hindi Dubbed',
      category: `📁 Category: ${state.categoryName || 'Browse'}`,
      favs: '⭐ Your Watchlist',
      history: '🕐 Recently Viewed',
      search: `Search: "${state.searchQuery}"`
    };
    dom.sectionTitle.textContent = titles[state.view] || 'Movies';
  }
  function setActiveNav(view) { dom.navMenu.querySelectorAll('.nav-link').forEach((l) => l.classList.toggle('is-active', l.getAttribute('data-view') === view)); }
  function switchView(view) {
    if (state.view === view && view !== 'latest') return;
    state.view = view; state.page = 1; state.items = []; state.hasMore = true;
    state.filter = 'all'; state.searchQuery = '';
    dom.searchInput.value = ''; dom.searchClear.hidden = true;
    renderFilters(); updateSectionHead(); setActiveNav(view);
    if (view === 'dashboard') {
      dom.dashboard.hidden = false; dom.movieSection.hidden = true; dom.featuredSection.hidden = true; dom.empty.hidden = true;
      renderDashboard(); return;
    }
    dom.dashboard.hidden = true; dom.movieSection.hidden = false;
    if (view !== 'latest') dom.featuredSection.hidden = true;
    else { dom.featuredSection.hidden = false; loadFeatured(); }
    loadList();
  }

  /* ─── Dashboard ─────────────────────────────────────────────────────── */
  const URL_TTL_MS = 30 * 60 * 1000;

  function renderDashboard() {
    const favs = ls.get(STORE.favs, []);
    const history = ls.get(STORE.history, []);
    const stats = ls.get(STORE.stats, { views: 0, downloads: 0, searches: 0 });
    const urls = ls.get(STORE.urls, []);

    dom.dashStats.innerHTML = [
      { num: history.length, label: 'Viewed' }, { num: favs.length, label: 'Watchlist' },
      { num: urls.length, label: 'URLs extracted' }, { num: stats.downloads || 0, label: 'Downloads' },
    ].map((s) => `<div class="dash-stat"><span class="num">${s.num}</span><span class="label">${escapeHtml(s.label)}</span></div>`).join('');

    renderDashboardUrls();

    if (favs.length === 0) dom.dashFavs.innerHTML = '<div class="dash-empty">Watchlist is empty.</div>';
    else {
      dom.dashFavs.innerHTML = favs.slice(-15).reverse().map((m) => dashItemHtml(m)).join('');
      dom.dashFavs.querySelectorAll('.dash-item').forEach((el) => el.addEventListener('click', () => openMovie(el.getAttribute('data-slug'))));
    }
    if (history.length === 0) dom.dashHistory.innerHTML = '<div class="dash-empty">No history yet.</div>';
    else {
      dom.dashHistory.innerHTML = history.slice(0, 15).map((m) => dashItemHtml(m)).join('');
      dom.dashHistory.querySelectorAll('.dash-item').forEach((el) => el.addEventListener('click', () => openMovie(el.getAttribute('data-slug'))));
    }
  }

  function renderDashboardUrls() {
    const urls = ls.get(STORE.urls, []);
    const now = Date.now();
    if (!urls.length) {
      dom.dashUrls.innerHTML = '<div class="dash-empty">No URLs yet. Open a movie and tap a quality.</div>';
      return;
    }
    dom.dashUrls.innerHTML = urls.map(u => {
      const expired = u.expiresAt && u.expiresAt < now;
      const ageMin = Math.round((now - u.ts) / 60000);
      const badge = expired
        ? '<span class="url-badge url-badge--expired">expired</span>'
        : u.expiresAt
          ? `<span class="url-badge">expires in ${Math.max(0, Math.round((u.expiresAt - now) / 60000))}m</span>`
          : `<span class="url-badge">${ageMin}m ago</span>`;
      const linkHtml = u.url
        ? `<span class="url-item__url" title="${escapeHtml(u.url)}">${escapeHtml(u.url.slice(0, 60))}${u.url.length > 60 ? '…' : ''}</span>`
        : '<span class="dash-url-link dash-url-link--dead">(expired — re-resolve from movie page)</span>';
      return `<div class="url-item ${expired ? 'is-expired' : ''}">
                <span class="url-item__quality">${escapeHtml(u.quality)}</span>
                ${linkHtml}
                ${u.url ? `<button class="url-item__copy" data-url="${escapeHtml(u.url)}">Copy</button>` : ''}
                ${badge}
              </div>`;
    }).join('');

    dom.dashUrls.querySelectorAll('.url-item__copy').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(btn.getAttribute('data-url'));
          toast('লিংক কপি হয়েছে', 'success');
        } catch {
          toast('কপি ব্যর্থ হয়েছে', 'error');
        }
      });
    });
  }

  function dashItemHtml(m) {
    const title = prettyTitle(m.title);
    const poster = m.poster ? imgProxy(m.poster) : '';
    const originalPoster = m.poster || '';
    return `<div class="dash-item" data-slug="${escapeHtml(m.slug)}" role="button" tabindex="0"><div class="dash-item__poster">${poster ? `<img src="${escapeHtml(poster)}" alt="" loading="lazy" decoding="async" data-original="${escapeHtml(originalPoster)}" onerror="handleImgError(this)">` : ''}</div><div class="dash-item__body"><div class="dash-item__title">${escapeHtml(title)}</div><div class="dash-item__meta">${escapeHtml(m.quality || '')} ${m.year ? '• ' + escapeHtml(m.year) : ''}</div></div><span class="dash-item__action">View →</span></div>`;
  }

  function exportData() {
    const data = { favs: ls.get(STORE.favs, []), history: ls.get(STORE.history, []), urls: ls.get(STORE.urls, []), stats: ls.get(STORE.stats, {}), exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `skmovies-data-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    URL.revokeObjectURL(url); toast('ডেটা এক্সপোর্ট হয়েছে', 'success');
  }

  function recordUrl(quality, url, title) {
    setTimeout(() => {
      const isExpiring = /multidownload\.website|exp=\d+|token=[a-f0-9]+/i.test(url);
      const storeUrl = isExpiring ? null : url;
      const history = ls.get(STORE.urls, []);
      const existing = history.findIndex(h => h.title === title && h.quality === quality);
      const entry = {
        quality, url: storeUrl, title, ts: Date.now(),
        expiresAt: isExpiring ? Date.now() + 5 * 60 * 1000 : null,
      };
      if (existing >= 0) history[existing] = entry;
      else history.unshift(entry);
      const cutoff = Date.now() - URL_TTL_MS;
      const pruned = history.filter(h => h.ts > cutoff);
      ls.set(STORE.urls, pruned.slice(0, 50));
    }, 0);
  }

  function recordDownload(quality, title) {
    const stats = ls.get(STORE.stats, { views: 0, downloads: 0, searches: 0 });
    stats.downloads = (stats.downloads || 0) + 1;
    ls.set(STORE.stats, stats);
  }

  /* ─── Search ────────────────────────────────────────────────────────── */
  const SEARCH_DEBOUNCE_MS = 350;
  let searchDebounceTimer = null;

  function onSearchInput() {
    const q = dom.searchInput.value.trim();
    dom.searchClear.hidden = !q;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      if (q.length < 2) {
        state.view = 'latest';
        state.searchQuery = '';
        state.page = 1;
        state.items = [];
        loadList();
        return;
      }
      state.view = 'search';
      state.searchQuery = q;
      state.page = 1;
      state.items = [];
      loadList();
    }, SEARCH_DEBOUNCE_MS);
  }

  /* ─── Featured slider nav ───────────────────────────────────────────── */
  function wireFeaturedSlider() {
    dom.featuredPrev.addEventListener('click', () => {
      const first = dom.featuredSlides.querySelector('.slider-post');
      if (first) first.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', inline: 'nearest' });
      dom.featuredSlides.scrollBy({ left: -520, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
    });
    dom.featuredNext.addEventListener('click', () => dom.featuredSlides.scrollBy({ left: 520, behavior: REDUCED_MOTION ? 'auto' : 'smooth' }));
  }

  /* ─── Scroll handler (Combined Go-to-top & Infinite scroll) ─────────── */
  let scrollRafPending = false;
  function initScrollHandler() {
    window.addEventListener('scroll', () => {
      dom.goTop.classList.toggle('is-visible', window.scrollY > 400);
      // [#4] rAF flag reset BEFORE the work, so a dropped frame doesn't
      // starve subsequent scrolls.
      if (scrollRafPending) return;
      scrollRafPending = true;
      requestAnimationFrame(() => {
        scrollRafPending = false;
        if (state.isLoading || !state.hasMore || state.hasError) return;
        if (['favs', 'history', 'trending', 'dashboard'].includes(state.view)) return;
        if (document.body.scrollHeight - (window.scrollY + window.innerHeight) < 800) {
          state.page++;
          loadList({ append: true });
        }
      });
    }, { passive: true });

    dom.goTop.addEventListener('click', (e) => {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
    });
  }

  /* ─── Hover Prefetch ────────────────────────────────────────────────── */
  const PREFETCH_CACHE_MAX = 30;
  const prefetchCache = new Map();

  function prefetchCacheGet(slug) {
    if (!prefetchCache.has(slug)) return undefined;
    const value = prefetchCache.get(slug);
    prefetchCache.delete(slug);
    prefetchCache.set(slug, value);
    return value;
  }

  function prefetchCacheSet(slug, value) {
    while (prefetchCache.size >= PREFETCH_CACHE_MAX) {
      const oldestKey = prefetchCache.keys().next().value;
      prefetchCache.delete(oldestKey);
    }
    prefetchCache.set(slug, value);
  }

  function setupHoverPrefetch() {
    // [#10] Respect Save-Data header
    if (navigator.connection && navigator.connection.saveData) return;
    if (window.matchMedia && window.matchMedia('(hover: none)').matches) return;
    dom.grid.addEventListener('mouseover', (e) => {
      const card = e.target.closest('.single-post');
      if (!card) return;
      const slug = card.getAttribute('data-slug');
      if (!slug || prefetchCache.has(slug)) return;
      clearTimeout(card.dataset.hoverTimer);
      card.dataset.hoverTimer = setTimeout(async () => {
        if (prefetchCache.has(slug)) return;
        try {
          const apiUrl = `${getApi().movie}?slug=${encodeURIComponent(slug)}`;
          const r = await fetchJson(apiUrl);
          prefetchCacheSet(slug, r);
        } catch {}
      }, 200);
    });
    dom.grid.addEventListener('mouseout', (e) => {
      const card = e.target.closest('.single-post');
      if (card && card.dataset.hoverTimer) {
        clearTimeout(card.dataset.hoverTimer);
        delete card.dataset.hoverTimer;
      }
    });
  }

  /* ─── Long press context menu ───────────────────────────────────────── */
  let longPressTimer = null;
  let longPressTarget = null;

  function setupLongPress() {
    dom.grid.addEventListener('touchstart', (e) => {
      const card = e.target.closest('.single-post');
      if (!card) return;
      longPressTarget = card;
      longPressTimer = setTimeout(() => {
        if (longPressTarget === card) {
          haptic(HAPTIC.select);
          showCardContextMenu(card, e.touches[0]);
        }
      }, 500);
    }, { passive: true });
    dom.grid.addEventListener('touchend', () => { clearTimeout(longPressTimer); longPressTarget = null; });
    dom.grid.addEventListener('touchmove', () => { clearTimeout(longPressTimer); longPressTarget = null; }, { passive: true });
  }

  function showCardContextMenu(card, touch) {
    const slug = card.getAttribute('data-slug');
    const title = card.querySelector('.post-title')?.textContent || '';
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.cssText = `
      position: fixed; top: ${touch.clientY}px; left: ${touch.clientX}px;
      background: var(--card-bg); border-radius: 12px; padding: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3); z-index: 500;
      min-width: 180px; border: 1px solid var(--border);
    `;
    const favs = ls.get(STORE.favs, []);
    const isFav = favs.some(f => f.slug === slug);
    menu.innerHTML = `
      <button class="context-menu__item" data-action="open">🎬 খুলুন</button>
      <button class="context-menu__item" data-action="fav">${isFav ? '⭐ ওয়াচলিস্ট থেকে সরান' : '☆ ওয়াচলিস্টে যোগ করুন'}</button>
      <button class="context-menu__item" data-action="copy">🔗 লিংক কপি করুন</button>
      <button class="context-menu__item" data-action="share">📤 শেয়ার করুন</button>
    `;
    document.body.appendChild(menu);

    setTimeout(() => {
      const closeHandler = (e) => {
        if (!menu.contains(e.target)) {
          menu.remove();
          document.removeEventListener('click', closeHandler);
        }
      };
      document.addEventListener('click', closeHandler);
    }, 100);

    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('.context-menu__item');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      menu.remove();
      haptic(HAPTIC.tap);
      switch (action) {
        case 'open': openMovie(slug); break;
        case 'fav': {
          const favBtnMock = { setAttribute() {}, textContent: '', innerHTML: '' };
          const m = state.items.find(x => x.slug === slug) || state.currentMovieData || { slug, title };
          toggleFav(m, favBtnMock);
          break;
        }
        case 'copy': {
          const url = `${location.origin}/?movie=${encodeURIComponent(slug)}`;
          navigator.clipboard.writeText(url).then(() => toast('লিংক কপি হয়েছে', 'success'));
          break;
        }
        case 'share': {
          const sUrl = `${location.origin}/?movie=${encodeURIComponent(slug)}`;
          if (navigator.share) navigator.share({ title, url: sUrl });
          else { navigator.clipboard.writeText(sUrl); toast('লিংক কপি হয়েছে', 'success'); }
          break;
        }
      }
    });
  }

  /* ─── Drag to dismiss bottom sheet ──────────────────────────────────── */
  function setupSheetDrag() {
    const handle = dom.sheet.querySelector('.sheet__handle');
    const panel = dom.sheet.querySelector('.sheet__panel');
    if (!handle || !panel) return;
    let startY = 0, currentY = 0, isDragging = false;
    handle.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
      isDragging = true;
      panel.style.transition = 'none';
    }, { passive: true });
    handle.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      currentY = e.touches[0].clientY;
      const delta = currentY - startY;
      if (delta > 0) {
        panel.style.transform = `translateY(${delta}px)`;
        panel.style.opacity = String(Math.max(0.5, 1 - delta / 400));
      }
    }, { passive: true });
    handle.addEventListener('touchend', () => {
      if (!isDragging) return;
      isDragging = false;
      panel.style.transition = '';
      const delta = currentY - startY;
      if (delta > 100) { closeSheet(); panel.style.transform = ''; panel.style.opacity = ''; }
      else { panel.style.transform = ''; panel.style.opacity = ''; }
    });
  }

  function setupModalDelegation() {
    dom.modalBody.addEventListener('click', (e) => {
      const openBtn = e.target.closest('#openPlayerBtn');
      if (openBtn) {
        haptic(HAPTIC.tap);
        const first = dom.modalBody.querySelector('.dl-btn');
        if (first) first.click();
        return;
      }
      const favBtn = e.target.closest('#favBtn');
      if (favBtn) { haptic(HAPTIC.tap); if (currentModalMovie) toggleFav(currentModalMovie, favBtn); return; }
      const showShots = e.target.closest('#showShots');
      if (showShots) {
        haptic(HAPTIC.tap);
        const sec = $('#shotsSection');
        if (sec) {
          sec.hidden = !sec.hidden;
          if (!sec.hidden) sec.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
        }
        return;
      }
      const dlBtn = e.target.closest('.dl-btn[data-savelinks]');
      if (dlBtn && currentModalMovie) {
        e.preventDefault();
        haptic(HAPTIC.tap);
        const url = dlBtn.getAttribute('data-savelinks');
        const quality = dlBtn.getAttribute('data-quality');
        const size = dlBtn.getAttribute('data-size') || '';
        const title = prettyTitle(currentModalMovie.title);
        resolveAndOpenPlayer(url, title, quality, size);
        return;
      }
      const relatedCard = e.target.closest('.single-post');
      if (relatedCard) {
        haptic(HAPTIC.tap);
        const slug = relatedCard.getAttribute('data-slug');
        if (slug) { closeModal(); setTimeout(() => openMovie(slug), 0); }
        return;
      }
    });
  }

  /* ─── Central Keyboard Listeners ────────────────────────────────────── */
  function setupKeyboardNav() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (document.fullscreenElement) { document.exitFullscreen(); e.preventDefault(); return; }
        if (player.modal && !player.modal.hidden) { player.close(); e.preventDefault(); return; }
        if (!dom.sheet.hidden) { closeSheet(); e.preventDefault(); return; }
        if (!dom.categoriesSheet.hidden) { closeCategoriesSheet(); e.preventDefault(); return; }
        if (!dom.modal.hidden) { closeModal(); e.preventDefault(); return; }
      }
      if (player.modal && !player.modal.hidden) {
        switch(e.key) {
          case ' ': e.preventDefault(); player.togglePlay(); return;
          case 'f': case 'F': player.toggleFullscreen(); return;
          case 'r': case 'R': player.rotate(); return;
          case 's': case 'S': player.toggleStretch(); return;
          case 'ArrowLeft': player.video.currentTime -= 10; return;
          case 'ArrowRight': player.video.currentTime += 10; return;
        }
        return;
      }
      if (dom.movieSection.hidden) return;
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      if (!dom.modal.hidden || !dom.sheet.hidden || !dom.categoriesSheet.hidden) return;

      const cards = Array.from(dom.grid.querySelectorAll('.single-post'));
      if (cards.length === 0) return;

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        currentCardIndex = Math.min(currentCardIndex + 1, cards.length - 1);
        if (cards[currentCardIndex]) cards[currentCardIndex].focus();
        haptic(HAPTIC.tap);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        currentCardIndex = Math.max(currentCardIndex - 1, 0);
        if (cards[currentCardIndex]) cards[currentCardIndex].focus();
        haptic(HAPTIC.tap);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const cols = window.innerWidth >= 1024 ? 5 : window.innerWidth >= 768 ? 4 : window.innerWidth >= 540 ? 3 : 2;
        currentCardIndex = Math.min(currentCardIndex + cols, cards.length - 1);
        if (cards[currentCardIndex]) cards[currentCardIndex].focus();
        haptic(HAPTIC.tap);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const cols = window.innerWidth >= 1024 ? 5 : window.innerWidth >= 768 ? 4 : window.innerWidth >= 540 ? 3 : 2;
        currentCardIndex = Math.max(currentCardIndex - cols, 0);
        if (cards[currentCardIndex]) cards[currentCardIndex].focus();
        haptic(HAPTIC.tap);
      } else if (e.key === '/' && document.activeElement !== dom.searchInput) {
        e.preventDefault();
        dom.searchInput.focus();
      }
    });
  }

  function wireEvents() {
    dom.searchInput.addEventListener('input', () => onSearchInput());
    dom.searchForm.addEventListener('submit', (e) => { e.preventDefault(); onSearchInput(); });
    dom.searchClear.addEventListener('click', () => {
      dom.searchInput.value = ''; dom.searchClear.hidden = true;
      onSearchInput(); dom.searchInput.focus(); haptic(HAPTIC.tap);
    });
    dom.filtersScroll.addEventListener('click', (e) => {
      const b = e.target.closest('.pill');
      if (b) { haptic(HAPTIC.tap); const fid = b.getAttribute('data-filter'); setTimeout(() => setFilter(fid), 0); }
    });
    dom.grid.addEventListener('click', (e) => {
      const c = e.target.closest('.single-post');
      if (c) { haptic(HAPTIC.tap); const slug = c.getAttribute('data-slug'); setTimeout(() => openMovie(slug), 0); }
    });
    dom.grid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const c = e.target.closest('.single-post');
      if (c) { e.preventDefault(); haptic(HAPTIC.tap); const slug = c.getAttribute('data-slug'); setTimeout(() => openMovie(slug), 0); }
    });
    dom.modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || e.target.matches('.modal__backdrop')) { haptic(HAPTIC.tap); closeModal(); }
    });
    dom.sheet.addEventListener('click', (e) => {
      if (e.target.closest('[data-close-sheet]') || e.target.matches('.sheet__backdrop')) { haptic(HAPTIC.tap); closeSheet(); }
    });
    dom.categoriesSheet.addEventListener('click', (e) => {
      if (e.target.closest('[data-close-cats]')) { haptic(HAPTIC.tap); closeCategoriesSheet(); }
    });
    dom.categoriesGrid.addEventListener('click', (e) => {
      const b = e.target.closest('.sheet__btn');
      if (b) {
        e.preventDefault();
        haptic(HAPTIC.tap);
        const slug = b.getAttribute('data-slug');
        const name = b.getAttribute('data-name');
        closeCategoriesSheet();
        setTimeout(() => switchCategory(slug, name), 0);
      }
    });
    dom.navCategories.addEventListener('click', (e) => { e.preventDefault(); haptic(HAPTIC.tap); openCategoriesSheet(); });
    dom.sheetCopy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(dom.sheetUrl.value);
        haptic(HAPTIC.success);
        toast('লিংক কপি হয়েছে', 'success');
      } catch {
        dom.sheetUrl.select();
        document.execCommand('copy');
        haptic(HAPTIC.success);
        toast('লিংক কপি হয়েছে', 'success');
      }
    });
    dom.loadMoreBtn.addEventListener('click', () => {
      if (state.isLoading || !state.hasMore) return;
      haptic(HAPTIC.tap); state.page++; loadList({ append: true });
    });
    dom.navMenu.addEventListener('click', (e) => {
      const l = e.target.closest('.nav-link');
      if (l) {
        e.preventDefault();
        haptic(HAPTIC.tap);
        dom.navMenu.classList.remove('is-open');
        const view = l.getAttribute('data-view');
        setTimeout(() => switchView(view), 0);
      }
    });
    if (dom.menuToggle) {
      dom.menuToggle.addEventListener('click', () => {
        haptic(HAPTIC.tap);
        const isOpen = dom.navMenu.classList.toggle('is-open');
        dom.menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
    }

    window.addEventListener('popstate', () => {
      // Ordering for popping overlays: player -> sheet -> categories -> modal
      if (player.modal && !player.modal.hidden) { player.close({ popState: true }); return; }
      if (!dom.sheet.hidden) { closeSheet({ popState: true }); return; }
      if (!dom.categoriesSheet.hidden) { closeCategoriesSheet({ popState: true }); return; }
      const params = new URLSearchParams(location.search);
      const movieSlug = params.get('movie');
      if (movieSlug) openMovie(movieSlug, { pushState: false });
      // [#6] Only call closeModal if modal is actually open.
      else if (!dom.modal.hidden) closeModal({ pushState: false });
    });

    /* [#2] Defense-in-depth: if we ever land at the homepage with no overlay
       open, force-clear any leftover body lock styles. Protects against
       future regressions in scrollLock.unlock(). */
    window.addEventListener('popstate', () => {
      setTimeout(() => {
        const hasMovie = new URLSearchParams(location.search).has('movie');
        const anyOpen = (player.modal && !player.modal.hidden) ||
                        !dom.modal.hidden ||
                        !dom.sheet.hidden ||
                        !dom.categoriesSheet.hidden;
        if (!hasMovie && !anyOpen) {
          scrollLock.forceClear();
        }
      }, 0);
    });

    const wireDash = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', () => { haptic(HAPTIC.tap); fn(); });
    };
    wireDash('dashClearHistory', () => { ls.set(STORE.history, []); renderDashboard(); toast('হিস্ট্রি মুছে ফেলা হয়েছে'); });
    wireDash('dashClearFavs', () => { ls.set(STORE.favs, []); renderDashboard(); toast('ওয়াচলিস্ট খালি করা হয়েছে'); });
    wireDash('dashClearUrls', () => { ls.set(STORE.urls, []); renderDashboard(); toast('লিংক তালিকা মুছে ফেলা হয়েছে'); });
    wireDash('dashExport', exportData);

    dom.sheetGrid.addEventListener('click', (e) => {
      const playBtn = e.target.closest('.play-in-browser-btn');
      if (playBtn) {
        e.preventDefault();
        haptic(HAPTIC.tap);
        recordDownload(state.currentQuality || 'DL', state.currentTitle);
        if (playBtn.getAttribute('data-unsupported') === 'true') {
          toast('এই ভিডিও ফরম্যাট (MKV) ব্রাউজারে সাপোর্ট করে না। দয়া করে External Player ব্যবহার করুন।', 'error', 4000);
          return;
        }
        const streamUrl = playBtn.getAttribute('data-url');
        const streamTitle = playBtn.getAttribute('data-title');
        closeSheet();
        player.open(streamUrl, streamTitle);
        return;
      }
      const btn = e.target.closest('.sheet__btn');
      if (btn) {
        const isExternal = btn.getAttribute('target') === '_blank';
        if (isExternal) {
          haptic(HAPTIC.tap);
          recordDownload(state.currentQuality || 'DL', state.currentTitle);
        }
      }
    });

    setupHoverPrefetch();
    setupLongPress();
    setupSheetDrag();
    setupKeyboardNav();
  }

  // ─── Web Video Player ─────────────────────────────────────────
  const player = {
    video: null, modal: null,
    rotateAngle: 0, isStretched: false, speed: 1,

    init() {
      this.modal = document.getElementById('playerModal');
      this.video = document.getElementById('webVideoPlayer');
      if (!this.modal || !this.video) return;

      document.getElementById('playPauseBtn').addEventListener('click', () => this.togglePlay());
      this.video.addEventListener('click', () => this.togglePlay());

      const seekBar = document.getElementById('seekBar');
      seekBar.addEventListener('click', (e) => {
        const rect = seekBar.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        this.video.currentTime = pct * this.video.duration;
      });

      this.video.addEventListener('timeupdate', () => this.updateSeekBar());
      this.video.addEventListener('loadedmetadata', () => {
        const dur = document.getElementById('duration');
        if (dur) dur.textContent = this.formatTime(this.video.duration);
      });

      document.getElementById('rotateBtn').addEventListener('click', () => this.rotate());
      document.getElementById('stretchBtn').addEventListener('click', () => this.toggleStretch());
      document.getElementById('fullscreenBtn').addEventListener('click', () => this.toggleFullscreen());

      document.querySelectorAll('[data-close-player]').forEach(el => el.addEventListener('click', () => this.close()));

      document.getElementById('speedBtn').addEventListener('click', () => {
        const menu = document.getElementById('speedMenu');
        if (menu) menu.hidden = !menu.hidden;
      });
      document.querySelectorAll('.speed-menu button').forEach(btn => {
        btn.addEventListener('click', () => {
          this.speed = parseFloat(btn.dataset.speed);
          this.video.playbackRate = this.speed;
          const sb = document.getElementById('speedBtn');
          if (sb) sb.textContent = this.speed + 'x';
          document.querySelectorAll('.speed-menu button').forEach(b => b.classList.remove('is-active'));
          btn.classList.add('is-active');
          const menu = document.getElementById('speedMenu');
          if (menu) menu.hidden = true;
        });
      });

      document.getElementById('volumeSlider').addEventListener('input', (e) => {
        this.video.volume = parseFloat(e.target.value);
        this.video.muted = false;
      });
      document.getElementById('muteBtn').addEventListener('click', () => { this.video.muted = !this.video.muted; });
    },

    open(url, title) {
      this.modal.hidden = false;
      this.modal.setAttribute('aria-hidden', 'false');
      scrollLock.lock();
      const t = document.getElementById('playerTitle');
      if (t) t.textContent = title || 'Movie';
      this.video.src = url;
      this.video.playbackRate = this.speed;
      this.video.load();
      this.video.play().catch(() => {});
      toast('ভিডিও চালু হচ্ছে…', 'success');
      if (!history.state?.playerOpen) {
        history.pushState({ ...history.state, playerOpen: true }, '');
      }
    },

    close({ popState = false } = {}) {
      this.modal.hidden = true;
      this.modal.setAttribute('aria-hidden', 'true');
      if (dom.modal.hidden && dom.sheet.hidden && dom.categoriesSheet.hidden) {
        scrollLock.unlock();
      }
      this.video.pause();
      this.video.src = '';
      if (document.fullscreenElement) document.exitFullscreen();
      if (!popState && history.state?.playerOpen) history.back();
    },

    togglePlay() {
      if (this.video.paused) this.video.play();
      else this.video.pause();
      const pi = document.getElementById('playIcon');
      const pa = document.getElementById('pauseIcon');
      if (pi) pi.hidden = !this.video.paused;
      if (pa) pa.hidden = this.video.paused;
    },

    rotate() {
      this.rotateAngle = (this.rotateAngle + 90) % 360;
      this.video.className = 'web-video-player' +
        (this.rotateAngle ? ` rotate-${this.rotateAngle}` : '') +
        (this.isStretched ? ' stretch' : ' fit');
    },

    toggleStretch() {
      this.isStretched = !this.isStretched;
      this.video.classList.toggle('stretch', this.isStretched);
      this.video.classList.toggle('fit', !this.isStretched);
    },

    toggleFullscreen() {
      const fsIcon = document.getElementById('fsIcon');
      if (!document.fullscreenElement) {
        this.modal.requestFullscreen();
        if (fsIcon) fsIcon.innerHTML = '<path fill="currentColor" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>';
      } else {
        document.exitFullscreen();
        if (fsIcon) fsIcon.innerHTML = '<path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zm0-14h-4v2h3v3h2V5h-1z"/>';
      }
    },

    updateSeekBar() {
      const pct = (this.video.currentTime / this.video.duration) * 100;
      const sp = document.getElementById('seekProgress');
      const sh = document.getElementById('seekHandle');
      const ct = document.getElementById('currentTime');
      if (sp) sp.style.width = pct + '%';
      if (sh) sh.style.left = pct + '%';
      if (ct) ct.textContent = this.formatTime(this.video.currentTime);
      if (this.video.buffered.length > 0) {
        const sb = document.getElementById('seekBuffer');
        if (sb) {
          const buffered = (this.video.buffered.end(this.video.buffered.length - 1) / this.video.duration) * 100;
          sb.style.width = buffered + '%';
        }
      }
    },

    formatTime(sec) {
      if (isNaN(sec)) return '0:00';
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      return `${m}:${String(s).padStart(2,'0')}`;
    },
  };

  /* ─── Init ──────────────────────────────────────────────────────────── */
  function init() {
    cacheDom();
    // Ensure body overflow is never stuck from a previous broken state
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    scrollLock.isLocked = false;
    // Ensure modal and sheet start fully hidden
    dom.modal.hidden = true; dom.modal.style.display = 'none';
    dom.sheet.hidden = true; dom.sheet.style.display = 'none';
    dom.categoriesSheet.hidden = true; dom.categoriesSheet.style.display = 'none';
    initTheme();
    initFilter18();
    initSourceToggle();
    player.init();
    renderFilters();
    wireEvents();
    setupModalDelegation();
    wireFeaturedSlider();
    initScrollHandler();
    updateSectionHead();
    setActiveNav('latest');
    loadNotice();
    loadFeatured();
    loadList();
    // Check URL for deep-link (?movie=slug)
    const params = new URLSearchParams(location.search);
    const movieSlug = params.get('movie');
    if (movieSlug) openMovie(movieSlug, { pushState: false });
    const view = params.get('view');
    if (view && ['latest', 'trending', 'favs', 'history', 'dashboard'].includes(view)) switchView(view);

    // [#8] Register Service Worker behind `window.load` so it never competes
    // with first paint.
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
          .then((reg) => {
            reg.onupdatefound = () => {
              const installingWorker = reg.installing;
              if (installingWorker) {
                installingWorker.onstatechange = () => {
                  if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    toast('নতুন আপডেট এসেছে। রিলোড হচ্ছে…', 'success');
                    setTimeout(() => location.reload(), 1500);
                  }
                };
              }
            };
          })
          .catch((err) => console.error('SW registration failed:', err));
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
