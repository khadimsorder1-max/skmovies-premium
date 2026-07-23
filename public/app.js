/* ============================================================================
   SKMovies — Frontend App (FIXED v3.5.0)
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
  function urlJoin(base, ...parts) {
    const q = parts.filter(Boolean).join('&');
    if (!q) return base;
    return base + (base.includes('?') ? '&' : '?') + q;
  }



  function getApi() {
    const src = (state && state.source) || ls.get('skm.source', 'mlsbd');
    // [#v3.5.0] Route ALL list + movie-detail requests through /api/cache.
    // /api/cache checks Cloudflare KV → GitHub raw cache → live upstream,
    // in that order. This gives super-fast loading for pre-cached items
    // (1000+ per source) while transparently falling back to live scrape.
    //
    // The ?src= and ?path= params tell /api/cache which file to look up.
    // The Function internally translates to the right upstream endpoint.
    const CACHE_BASE = '/api/cache';
    const buildCacheApi = (path) => `${CACHE_BASE}?src=${src}&path=${path}`;

    if (src === 'fdm') {
      return {
        latest: buildCacheApi('latest'),
        movie: buildCacheApi('movie'),  // ?slug= appended by caller
        search: '/api/fdm/search',       // search is not pre-cached (infinite queries)
        trending: buildCacheApi('trending'),
        resolve: '/api/fdm/resolve',
        category: buildCacheApi('category'),
        img: '/api/img',
        notice: '/api/notice',
      };
    }
    if (src === 'hdhub4u') {
      return {
        latest: buildCacheApi('home'),
        movie: buildCacheApi('movie'),
        search: '/api/hdhub4u/list?type=search',
        trending: buildCacheApi('home'),
        resolve: '/api/hdhub4u/stream',
        category: buildCacheApi('category'),
        img: '/api/img',
        notice: '/api/notice',
      };
    }
    if (src === 'hdhubmain') {
      return {
        latest: buildCacheApi('home'),
        movie: buildCacheApi('movie'),
        search: '/api/hdhubmain/list?type=search',
        trending: buildCacheApi('home'),
        resolve: '/api/hdhubmain/stream',
        category: buildCacheApi('category'),
        img: '/api/img',
        notice: '/api/notice',
      };
    }
    if (src === 'moviebox') {
      return {
        latest: buildCacheApi('trending'),
        movie: buildCacheApi('movie'),
        search: '/api/moviebox/search',
        trending: buildCacheApi('trending'),
        resolve: '/api/moviebox/resolve',
        category: buildCacheApi('category'),
        img: '/api/img',
        notice: '/api/notice',
      };
    }
    if (src === 'fibwatch') {
      return {
        latest: buildCacheApi('latest'),
        movie: buildCacheApi('movie'),
        search: '/api/fibwatch/search',
        trending: buildCacheApi('trending'),
        resolve: '/api/fibwatch/resolve',
        category: buildCacheApi('category'),
        img: '/api/img',
        notice: '/api/notice',
      };
    }
    if (src === 'fojik') {
      return {
        latest: buildCacheApi('latest'),
        movie: buildCacheApi('movie'),
        search: '/api/fojik/list?type=search',
        trending: buildCacheApi('latest'),
        resolve: '/api/resolve',
        category: buildCacheApi('category'),
        img: '/api/img',
        notice: '/api/notice',
      };
    }
    if (src === 'krx18') {

      return {
        latest: buildCacheApi('latest'),
        movie: buildCacheApi('movie'),
        search: '/api/krx18/list?type=search',
        trending: buildCacheApi('latest'),
        resolve: '/api/krx18/stream',
        category: buildCacheApi('category'),
        img: '/api/img',
        notice: '/api/notice',
      };
    }

    return {
      latest: buildCacheApi('latest'),
      movie: buildCacheApi('movie'),
      search: '/api/search',
      trending: buildCacheApi('trending'),
      resolve: '/api/resolve',
      category: buildCacheApi('category'),
      img: '/api/img',
      notice: '/api/notice',
    };
  }

  // Normalize list response items across sources.
  // MLSBD / FDM use `items`; HDHub4u uses `movies`.
  function respItems(r) { return (r && (r.movies || r.items)) || []; }
  function respHasMore(r) {
    if (!r) return false;
    if (typeof r.hasMore !== 'undefined') return !!r.hasMore;
    if (typeof r.totalPages !== 'undefined') return state.page < r.totalPages;
    return false;
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
    // HDHub4u hosts
    /\.hdhub4u\.(cl|ag|download|kim|lol|com|tours|yachts)$/i,
    /^hubdrive\.(tips|com|net)$/i,
    /^hubcdn\.sbs$/i,
    /^gadgetsweb\.xyz$/i,
    /^hdstream4u\.com$/i,
    /^hubstream\.art$/i,
    /\.aoneroom\.com$/i,
    /moviebox\.ph$/i,
    /^(new\d+\.)?hdhub4u\./i,
    /^catimages?\.(co|org|net|io)$/i,
    /^catimage\./i,
    /^image\.pixxxels\.cc$/i,
    /^i\.iliad\.io$/i,
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
    let b64;
    try { b64 = btoa(url); } catch (_) { b64 = btoa(unescape(encodeURIComponent(url))); }
    b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

  // HDHub4u static categories (mirrors hdhub4u.med homepage nav)
  const HDHUB4U_CATEGORIES = [
    { name: "Bollywood Movies", slug: "bollywood-movies" },
    { name: "Hollywood Movies", slug: "hollywood-movies" },
    { name: "South Indian Movies", slug: "south-indian-movies" },
    { name: "Hindi Dubbed", slug: "hindi-dubbed-movies" },
    { name: "Bengali Movies", slug: "bangla-movies" },
    { name: "Dual Audio", slug: "dual-audio-movies" },
    { name: "4K 2160p", slug: "4k-2160p" },
    { name: "1080p Movies", slug: "1080p" },
    { name: "720p Movies", slug: "720p" },
    { name: "480p Movies", slug: "480p" },
    { name: "WEB-DL", slug: "web-dl" },
    { name: "BluRay", slug: "bluray" },
    { name: "HEVC", slug: "hevc" },
    { name: "Netflix", slug: "netflix" },
    { name: "Amazon Prime", slug: "amazon-prime" },
    { name: "TV Series", slug: "tv-series" },
    { name: "Web Series", slug: "web-series" },
    { name: "Animation", slug: "animation-movies" },
    { name: "Documentary", slug: "documentary" },
    { name: "Action", slug: "action" },
    { name: "18+ Adult", slug: "adult" },
  ];

  const MOVIEBOX_CATEGORIES = [
    { name: "🎬 Movies", slug: "movie" },
    { name: "📺 TV Shows", slug: "tv" },
    { name: "🎌 Anime", slug: "anime" },
    { name: "🎭 Drama", slug: "drama" },
    { name: "📚 Series", slug: "series" },
    { name: "🔥 Trending", slug: "trending" },
    { name: "📍 Netflix", slug: "platform:Netflix" },
    { name: "📍 Prime Video", slug: "platform:Prime Video" },
    { name: "📍 Disney+", slug: "platform:Disney" },
    { name: "📍 Apple TV+", slug: "platform:Apple TV" },
    { name: "📍 Hulu", slug: "platform:Hulu" },
    { name: "📍 Zee5", slug: "platform:Zee5" },
    { name: "📍 Hoichoi", slug: "platform:Hoichoi" },
    { name: "📍 Viu", slug: "platform:Viu" },
    { name: "📍 Showmax", slug: "platform:Showmax" },
    { name: "📍 Vivamax", slug: "platform:Vivamax" },
    { name: "💥 Action & Thriller", slug: "genre:Action&Thriller" },
    { name: "💕 Teen Romance", slug: "genre:Teen Romance" },
    { name: "👬 BL Story", slug: "genre:BL Story" },
    { name: "😂 Sitcom", slug: "genre:Sitcom" },
    { name: "🔞 Adult Animation", slug: "genre:Adult Animation" },
    { name: "❤️ Romance", slug: "genre:Romance" },
    { name: "😄 Comedy", slug: "genre:Comedy" },
    { name: "👻 Horror", slug: "genre:Horror" },
    { name: "🚀 Sci-Fi", slug: "genre:Sci-Fi" },
    { name: "🧙 Fantasy", slug: "genre:Fantasy" },
    { name: "🕵️ Crime", slug: "genre:Crime" },
    { name: "🔍 Mystery", slug: "genre:Mystery" },
    { name: "🗺️ Adventure", slug: "genre:Adventure" },
    { name: "👨‍👩‍👧 Family", slug: "genre:Family" },
  ];

  const FIBWATCH_CATEGORIES = [
    { name: "🇧🇩 Bangla & Kolkata", slug: "1" },
    { name: "📺 Web Series", slug: "2" },
    { name: "🎬 Tamil & Telugu", slug: "3" },
    { name: "🎭 Hindi Movies", slug: "4" },
    { name: "🎙️ Hindi Dubbed", slug: "5" },
    { name: "👻 Horror Movies", slug: "6" },
    { name: "🐥 Cartoon & Anime", slug: "7" },
    { name: "🇬🇧 English Movies", slug: "8" },
    { name: "🇰🇷 Korean Movies", slug: "9" },
    { name: "🌴 Malayalam", slug: "10" },
    { name: "🐘 Kannada", slug: "11" },
    { name: "🏮 Marathi", slug: "12" },
    { name: "🇷🇺 Russian Movies", slug: "13" },
    { name: "🇳🇵 Nepali Movies", slug: "14" },
    { name: "🇨🇳 Chinese Movies", slug: "15" },
    { name: "🇵🇰 Urdu Movies", slug: "16" },
    { name: "🔊 Bangla Dubbed", slug: "17" },
    { name: "🎭 Mix Category", slug: "18" },
    { name: "📺 TV-Shows", slug: "19" },
    { name: "🎭 Natok", slug: "20" },
    { name: "👳 Punjabi", slug: "21" },
    { name: "🎌 Anime Cartoon", slug: "22" },
  ];

  const KRX18_CATEGORIES = [
    { name: "🔤 Eng Subbed", slug: "eng-sub" },
    { name: "🔞 X Clip", slug: "xxx" },
    { name: "🇰🇷 Korea", slug: "korea" },
    { name: "🇦🇺 Australia", slug: "australia" },
    { name: "🇨🇦 Canada", slug: "canada" },
    { name: "🇨🇳 China", slug: "china" },
    { name: "🇫🇷 France", slug: "france" },
    { name: "🇩🇪 Germany", slug: "germany" },
    { name: "🇯🇵 Japan", slug: "japan" },
    { name: "🇺🇸 USA", slug: "usa" },
  ];

  function getCategories() {
    if (state.source === 'fdm') return FDM_CATEGORIES;
    if (state.source === 'hdhub4u') return HDHUB4U_CATEGORIES;
    if (state.source === 'moviebox') return MOVIEBOX_CATEGORIES;
    if (state.source === 'fibwatch') return FIBWATCH_CATEGORIES;
    if (state.source === 'krx18') return KRX18_CATEGORIES;
    return MLSBD_CATEGORIES;
  }

  const STORE = {
    favs: 'skm.favs', history: 'skm.history', theme: 'skm.theme',
    urls: 'skm.urls', stats: 'skm.stats', filter18: 'skm.filter18',
    player: 'skm.player',
  };

  const state = {
    view: 'latest', page: 1, filter: 'all', searchQuery: '',
    items: [], isLoading: false, hasMore: true, heroItem: null,
    currentMovieSlug: null, filter18: false, hasError: false,
    source: (() => { const s = localStorage.getItem('skm.source'); return (s === 'fdm' || s === 'hdhub4u' || s === 'hdhubmain' || s === 'moviebox' || s === 'fibwatch' || s === 'krx18') ? s : 'mlsbd'; })(),
    playerMode: (() => { const p = localStorage.getItem('skm.player'); return (p === 'hdhub4u') ? 'hdhub4u' : 'inpage'; })(),
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
    /^catimages?\.(co|org|net|io)$/i,
    /^catimage\./i,
    /^image\.pixxxels\.cc$/i,
    /^i\.iliad\.io$/i,
    /\.hdhub4u\.(cl|ag|download|kim|lol|com|tours|yachts|skin|tv|cat)$/i,
    /hdhub4us\.ai\.in$/i,
    /^hubcdn\.sbs$/i,
    // [#v3.5.0] Match ANY *.b-cdn.net subdomain (BunnyCDN used by Fibwatch + others)
    /\.b-cdn\.net$/i,
    // [#v3.5.0] Catch-all for any myuijy / myuijy-style Fibwatch CDN subdomains
    /^myuijy\.b-cdn\.net$/i,
    /fibwatch\.art$/i,
    /fibwatch\.(com|net|info|biz)$/i,
    /moviebox\.ph$/i,
    // [#v3.5.0] HDHubMain poster hosts
    /^gadgetsweb\.xyz$/i,
    /^hdstream4u\.com$/i,
    /^hubstream\.art$/i,
    /^hubcdn\.sbs$/i,
  ];

  const imgProxy = (url) => {
    if (!url) return '';
    if (url.startsWith('data:') || url.startsWith('/')) return url;
    try {
      const u = new URL(url);
      if (IMAGE_HOST_PATTERNS.some(re => re.test(u.hostname))) {
        let b64;
        try { b64 = btoa(url); } catch (_) { b64 = btoa(unescape(encodeURIComponent(url))); }
        b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

  async function fetchMovieBoxClient(apiUrl) {
    try {
      const u = new URL(apiUrl, window.location.origin);
      const pathname = u.pathname;
      const page = u.searchParams.get('page') || '1';
      const q = u.searchParams.get('q') || u.searchParams.get('query') || '';
      const cat = u.searchParams.get('slug') || u.searchParams.get('cat') || '';

      let targetUrl = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/trending?page=${page}&perPage=24`;
      if (pathname.includes('/search') && q) {
        targetUrl = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/trending?page=1&perPage=100`;
      } else if (pathname.includes('/category') && cat) {
        if (cat.startsWith('platform:')) {
          const platform = cat.replace('platform:', '');
          targetUrl = `https://h5-api.aoneroom.com/wefeed-h5api-bff/platform/play-list?page=${page}&perPage=24&platform=${encodeURIComponent(platform)}`;
        } else {
          targetUrl = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/trending?page=${page}&perPage=50`;
        }
      }

      const r = await fetch(targetUrl, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Origin': 'https://moviebox.ph',
          'Referer': 'https://moviebox.ph/',
        }
      });

      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();

      let rawItems = data.data?.subjectList || data.data?.items || [];
      if (q) {
        const query = q.toLowerCase();
        rawItems = rawItems.filter(m => (m.title || '').toLowerCase().includes(query) || (m.genre || '').toLowerCase().includes(query));
      }

      const items = rawItems.map(m => {
        const detailPath = m.detailPath || 'movie';
        return {
          slug: `${detailPath}?id=${m.subjectId}`,
          title: m.title || 'Unknown',
          poster: m.cover?.url || '',
          year: m.releaseDate?.substring(0, 4) || '',
          quality: 'HD',
          language: m.subtitles ? 'Multi-Sub' : '',
          uploadDate: '',
          sizes: [],
          genre: m.genre || '',
          rating: m.imdbRatingValue || '',
          type: m.subjectType === 2 ? 'TV' : 'Movie',
        };
      });

      return { ok: true, page: parseInt(page), items, hasMore: items.length >= 20 };
    } catch (err) {
      console.warn('MovieBox client fetch failed:', err);
      return { ok: false, error: err.message, items: [] };
    }
  }

  async function fetchMovieBoxDetailClient(apiUrl) {
    try {
      const u = new URL(apiUrl, window.location.origin);
      const slug = u.searchParams.get('slug') || '';
      if (!slug) return { ok: false, error: 'Missing slug' };

      const [detailPath, idPart] = slug.split('?id=');
      const subjectId = idPart || slug;
      const targetUrl = `https://moviebox.ph/moviedetail/${detailPath}?id=${subjectId}&type=/movie/detail`;
      const proxyUrl = `${PROXY_WORKER_URL}?u=${encodeURIComponent(targetUrl)}`;

      let html = '';
      try {
        const r = await fetch(proxyUrl);
        if (r.ok) html = await r.text();
      } catch {}

      if (!html) {
        try {
          const r2 = await fetch(targetUrl);
          if (r2.ok) html = await r2.text();
        } catch {}
      }

      if (!html) throw new Error('Failed to load movie detail HTML');

      let title = 'Unknown';
      let poster = '';
      let synopsis = '';
      const videoUrls = [];
      const screenshots = [];

      // 1. JSON-LD Schema
      const ldM = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
      if (ldM) {
        try {
          const ld = JSON.parse(ldM[1]);
          if (ld.name) title = ld.name;
          if (ld.description) synopsis = ld.description;
          if (ld.thumbnailUrl && ld.thumbnailUrl.length) poster = ld.thumbnailUrl[0];
          if (ld.contentUrl) videoUrls.push(ld.contentUrl);
        } catch(e) {}
      }

      // 2. Extract video URLs (.mp4, .m3u8, .mkv)
      const videoRe = /https?:\/\/[a-z0-9.]*aoneroom\.com\/[^"'\s\\]+\.(?:mp4|m3u8|mkv)/gi;
      let vm;
      while ((vm = videoRe.exec(html)) !== null) {
        const urlStr = vm[0].replace(/\\\//g, '/');
        if (!videoUrls.includes(urlStr)) videoUrls.push(urlStr);
      }

      // 3. Fallbacks
      if (title === 'Unknown') {
        const tm = html.match(/<title>([^<]+)<\/title>/);
        if (tm) title = tm[1].replace(/\s*-\s*MovieBox.*$/i, '').replace(/\s*-\s*Watch.*$/i, '').trim();
      }
      if (!poster) {
        const pm = html.match(/https?:\/\/[a-z0-9.]*aoneroom\.com\/[^\s"'\\]+\.(?:jpg|jpeg|png|webp)/gi);
        if (pm && pm.length) poster = pm[0];
      }
      if (!synopsis) {
        const sm = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
        if (sm) synopsis = sm[1];
      }

      // 4. Screenshots
      const imgRe = /https?:\/\/pbcdnw\.aoneroom\.com\/image\/[^\s"'\\]+\.(?:jpg|jpeg|png|webp)/gi;
      let im;
      while ((im = imgRe.exec(html)) !== null) {
        const urlStr = im[0].replace(/\\\//g, '/');
        if (urlStr !== poster && !screenshots.includes(urlStr)) screenshots.push(urlStr);
      }

      let rating = '';
      const im2 = html.match(/"imdbRatingValue":"([^"]+)"/);
      if (im2) rating = im2[1];

      let seasons = [];
      const nuxtM = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (nuxtM) {
        try {
          const str = nuxtM[1];
          const seMatches = str.match(/"se":(\d+),"maxEp":(\d+)/g);
          if (seMatches) {
            const seenSe = new Set();
            for (const sm of seMatches) {
              const m = sm.match(/"se":(\d+),"maxEp":(\d+)/);
              if (m && !seenSe.has(m[1])) {
                seenSe.add(m[1]);
                seasons.push({ se: parseInt(m[1]), maxEp: parseInt(m[2]) });
              }
            }
          }
        } catch(e) {}
      }

      const downloadLinks = videoUrls.map((uStr, i) => ({
        label: videoUrls.length > 1 ? `Quality ${i + 1}` : 'Watch / Download',
        url: uStr,
        size: uStr.includes('-sd.') ? 'SD (480p)' : uStr.includes('-hd.') ? 'HD (720p)' : uStr.includes('-fhd.') ? 'FHD (1080p)' : 'HD',
      }));

      return {
        ok: true,
        slug,
        title,
        poster,
        synopsis,
        screenshots: screenshots.slice(0, 10),
        rating,
        seasons,
        streamUrl: videoUrls[0] || null,
        downloadLinks,
        downloads: downloadLinks,
        episodes: [],
      };
    } catch (err) {
      console.warn('fetchMovieBoxDetailClient failed:', err);
      return { ok: false, error: err.message };
    }
  }

  async function fetchFibwatchDetailClient(apiUrl) {
    try {
      const u = new URL(apiUrl, window.location.origin);
      const slug = u.searchParams.get('slug') || '';
      if (!slug) return { ok: false, error: 'Missing slug' };

      const watchUrl = slug.startsWith('http') ? slug : `https://fibwatch.art/watch/${slug}`;
      const proxyUrl = `${PROXY_WORKER_URL}?u=${encodeURIComponent(watchUrl)}`;

      let html = '';
      try {
        const r = await fetch(proxyUrl);
        if (r.ok) html = await r.text();
      } catch {}

      if (!html) {
        try {
          const r2 = await fetch(watchUrl);
          if (r2.ok) html = await r2.text();
        } catch {}
      }

      if (!html) throw new Error('Failed to load Fibwatch movie HTML');

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

      const downloadLinks = videoUrls.map((videoUrl, i) => {
        let b64;
        try { b64 = btoa(videoUrl); } catch (_) { b64 = btoa(unescape(encodeURIComponent(videoUrl))); }
        b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const proxiedVideoUrl = `${PROXY_WORKER_URL}?u=${b64}`;

        return {
          label: videoUrls.length > 1 ? `Quality ${i + 1} (Direct MKV Stream)` : 'Direct MKV Stream (Bunny CDN)',
          url: proxiedVideoUrl,
          savelinks_url: proxiedVideoUrl,
          size: videoUrl.includes('1080p') ? '1080p' : videoUrl.includes('720p') ? '720p' : 'HD',
        };
      });

      return {
        ok: true,
        slug,
        title,
        poster,
        synopsis,
        streamUrl: downloadLinks[0] ? downloadLinks[0].url : null,
        downloadLinks,
        downloads: downloadLinks,
        episodes: [],
      };
    } catch (err) {
      console.warn('fetchFibwatchDetailClient failed:', err);
      return { ok: false, error: err.message };
    }
  }

  async function fetchHDHub4uClient(apiUrl) {
    try {
      const u = new URL(apiUrl, window.location.origin);
      const page = u.searchParams.get('page') || '1';
      const q = u.searchParams.get('q') || '';
      const catSlug = u.searchParams.get('slug') || '';
      const type = u.searchParams.get('type') || '';

      // [#3 v3.4.0] HDHub4u migrated content from hdhub4u.skin → hdhub4us.ai.in.
      // The skin/ homepage now embeds ai.in URLs in its article cards.
      // Try the primary domain first, fall back to the alternate.
      const HD_BASES = ['https://hdhub4u.skin/', 'https://hdhub4us.ai.in/'];

      let html = '';
      for (const base of HD_BASES) {
        let targetUrl = base;
        if (type === 'search' && q) {
          targetUrl = page > 1 ? `${base}page/${page}/?s=${encodeURIComponent(q)}` : `${base}?s=${encodeURIComponent(q)}`;
        } else if (type === 'category' && catSlug) {
          targetUrl = page > 1 ? `${base}category/${catSlug}/page/${page}/` : `${base}category/${catSlug}/`;
        } else if (page > 1) {
          targetUrl = `${base}page/${page}/`;
        }

        const proxyUrl = `${PROXY_WORKER_URL}?u=${encodeURIComponent(targetUrl)}`;
        try {
          const r = await fetch(proxyUrl);
          if (r.ok) { html = await r.text(); if (html && html.length > 5000) break; }
        } catch {}
        // Direct fallback
        if (!html) {
          try {
            const r2 = await fetch(targetUrl);
            if (r2.ok) { html = await r2.text(); if (html && html.length > 5000) break; }
          } catch {}
        }
      }

      if (!html) throw new Error('Failed to load HDHub4u HTML');

      // [#3 v3.4.0] Updated regex: the link text after class=" may include
      // additional classes like "boundless-image has-hover-effect". The
      // existing regex already allows [^>]*, so it should match — but we
      // ALSO accept hdhub4us.ai.in and hdhub4u.skin in the href.
      const cardRe = /<a\s+class="ct-media-container[^"]*"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/gi;
      const items = [];
      let m;
      while ((m = cardRe.exec(html)) !== null) {
        const pageUrl = m[1];
        const poster = m[2];
        // Strip domain (works for both hdhub4u.skin and hdhub4us.ai.in)
        const rawSlug = pageUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/\/$/, '');
        const title = rawSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

        // Filter out non-movie links
        if (/how-to-download|category|tag|author|page\/|\/\?s=|movie-request/i.test(rawSlug)) continue;

        items.push({
          slug: rawSlug,
          title,
          poster,
          quality: 'HD',
          language: 'Hindi Dubbed',
          year: '',
          sizes: [],
        });
      }

      // [#3 v3.4.0] Fallback regex: match any <a> inside an <article> with
      // class entry-card, since some Blocksy theme variants use different
      // anchor class names.
      if (items.length === 0) {
        const articleRe = /<article[^>]*class="[^"]*entry-card[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
        let am;
        while ((am = articleRe.exec(html)) !== null) {
          const block = am[1];
          const hrefM = block.match(/<a[^>]*href="(https?:\/\/(?:hdhub4u[^"\/]*|hdhub4us[^"\/]*)\/[^"]+)"/i);
          const imgM = block.match(/<img[^>]+src="([^"]+)"/i);
          if (hrefM) {
            const pageUrl = hrefM[1];
            const poster = imgM ? imgM[1] : '';
            const rawSlug = pageUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/\/$/, '');
            if (/how-to-download|category|tag|author|page\/|movie-request/i.test(rawSlug)) continue;
            const title = rawSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            items.push({ slug: rawSlug, title, poster, quality: 'HD', language: 'Hindi Dubbed', year: '', sizes: [] });
          }
        }
      }

      return { ok: true, page: parseInt(page), items, hasMore: items.length >= 20 };
    } catch (err) {
      console.warn('fetchHDHub4uClient failed:', err);
      return { ok: false, error: err.message, items: [] };
    }
  }

  async function fetchHDHubMainClient(apiUrl) {
    try {
      const u = new URL(apiUrl, window.location.origin);
      const page = u.searchParams.get('page') || '1';
      const q = u.searchParams.get('q') || '';
      const catSlug = u.searchParams.get('slug') || '';
      const type = u.searchParams.get('type') || '';

      let targetUrl = page > 1 ? `https://new3.hdhub4u.cl/page/${page}/?utm=mn1` : 'https://new3.hdhub4u.cl/?utm=mn1';
      if (type === 'search' && q) {
        targetUrl = page > 1 ? `https://new3.hdhub4u.cl/page/${page}/?s=${encodeURIComponent(q)}` : `https://new3.hdhub4u.cl/?s=${encodeURIComponent(q)}`;
      } else if (type === 'category' && catSlug) {
        targetUrl = page > 1 ? `https://new3.hdhub4u.cl/category/${catSlug}/page/${page}/` : `https://new3.hdhub4u.cl/category/${catSlug}/`;
      }

      let html = '';
      try {
        const r = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          }
        });
        if (r.ok) html = await r.text();
      } catch {}

      if (!html) {
        try {
          const proxyUrl = `${PROXY_WORKER_URL}?u=${encodeURIComponent(targetUrl)}`;
          const r2 = await fetch(proxyUrl);
          if (r2.ok) html = await r2.text();
        } catch {}
      }

      if (!html) throw new Error('Failed to load HDHub Main HTML');

      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      const items = [];
      let lm;
      while ((lm = liRe.exec(html)) !== null) {
        const block = lm[1];
        const aM = block.match(/href="(https:\/\/new3\.hdhub4u\.cl\/[^"]+)"/i);
        const pM = block.match(/<p>([\s\S]*?)<\/p>/i);
        const imgM = block.match(/src="([^"]+)"/i) || block.match(/data-src="([^"]+)"/i);

        if (aM && pM) {
          const pageUrl = aM[1];
          const title = pM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').trim();
          const poster = imgM ? imgM[1] : '';
          const rawSlug = pageUrl.replace('https://new3.hdhub4u.cl/', '').replace(/\/$/, '');

          if (!/how-to-download|category|tag|author/i.test(rawSlug)) {
            items.push({
              slug: rawSlug,
              title,
              poster,
              quality: 'HD',
              language: 'Hindi Dubbed',
              year: '',
              sizes: [],
            });
          }
        }
      }

      return { ok: true, page: parseInt(page), items, hasMore: items.length >= 20 };
    } catch (err) {
      console.warn('fetchHDHubMainClient failed:', err);
      return { ok: false, error: err.message, items: [] };
    }
  }

  async function fetchHDHubMainDetailClient(apiUrl) {
    try {
      const u = new URL(apiUrl, window.location.origin);
      const slug = u.searchParams.get('slug') || '';
      const movieUrl = `https://new3.hdhub4u.cl/${slug}/`;

      let html = '';
      // [#v3.5.0] Try corsproxy.io first, then our own /api/proxy as fallback.
      // corsproxy.io is faster but rate-limits; /api/proxy is slower but reliable.
      const proxies = [
        `https://corsproxy.io/?url=${encodeURIComponent(movieUrl)}`,
        `${PROXY_WORKER_URL}?u=${encodeURIComponent(movieUrl)}`,
      ];
      for (const proxyUrl of proxies) {
        try {
          const r = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
          if (r.ok) { html = await r.text(); if (html && html.length > 3000) break; }
        } catch (e) {
          console.warn('proxy fetch failed:', e.message);
        }
      }
      // Last resort: direct fetch (will fail due to CORS but try anyway)
      if (!html) {
        try {
          const r = await fetch(movieUrl);
          if (r.ok) html = await r.text();
        } catch {}
      }

      if (!html) throw new Error('Failed to load HDHub Main Movie Detail HTML');

      const titleM = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([^<]+)<\/title>/i);
      const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').trim() : slug;

      const posterM = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || html.match(/<img[^>]+src="(https?:\/\/[^"]+)"/i);
      const poster = posterM ? posterM[1] : '';

      const storylineM = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const synopsis = storylineM ? storylineM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400).trim() : '';

      // [#v3.5.0] CRITICAL FIX: filter out "fau" (fake) cross-reference links.
      // The HDHubMain scraper was capturing EVERY <a href="...hdhub4u.cl/...">
      // link on the page, including related-posts, sidebar links, and other
      // movies' page links. This resulted in 54+ irrelevant "fau" entries in
      // the download list.
      //
      // New approach:
      //   1. Identify the MAIN content area (entry-content div) to scope scraping.
      //   2. Filter OUT any URL pointing to hdhub4u.cl/<other-slug>/ (page link,
      //      NOT a download host).
      //   3. Only include URLs on KNOWN download/stream hosts:
      //      hubcdn.sbs, hubdrive.tips, gadgetsweb.xyz, hubstream.art,
      //      hubcloud.foo/lol/com, gdflix.dev/dad/io, filepress.baby/com,
      //      gdtot.dad/com/dev, gdlink.dev, multidownload.website,
      //      busycdn.xyz, indexserver.site, hdstream4u.com
      //   4. De-duplicate by URL.
      const KNOWN_DL_HOSTS_RE = /hubcdn\.sbs|hubdrive\.(tips|com|net)|gadgetsweb\.xyz|hubstream\.art|hubcloud\.(foo|lol|com)|gdflix\.(dev|dad|com|io)|filepress\.(baby|com)|gdtot\.(dad|com|dev)|gdlink\.dev|multidownload\.website|busycdn\.xyz|indexserver\.site|hdstream4u\.com|fastdl|driveleech|savelinks/i;

      // Scope to entry-content (the article body). If not found, use full HTML.
      const contentMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:footer|\/article|aside)/i);
      const scopedHtml = contentMatch ? contentMatch[1] : html;

      const downloadLinks = [];
      const seenUrls = new Set();
      const linkRe = /<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let lm;
      while ((lm = linkRe.exec(scopedHtml)) !== null) {
        const linkUrl = lm[1];
        const linkText = lm[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

        // Skip social/share/page-nav links
        if (/facebook|twitter|telegram|whatsapp|reddit|t\.me|share|how-to-download|gmpg\.org|category|tag\/|author\/|#respond|wp-content|wp-includes/i.test(linkUrl)) continue;

        // [#v3.5.0] SKIP "fau" cross-reference links: any hdhub4u.<tld>/<slug>/ link
        // that points to a DIFFERENT movie's page (not the current one).
        if (/hdhub4u\.(cl|ag|download|kim|lol|com|tours|yachts|skin|tv|cat)/i.test(linkUrl) ||
            /hdhub4us\.ai\.in/i.test(linkUrl)) {
          // Is it a link to the CURRENT movie? Then it's a stream/player link, keep it.
          // Otherwise, it's a "fau" cross-reference link — SKIP.
          const linkSlug = linkUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/\/$/, '').split(/[?#]/)[0];
          if (linkSlug !== slug && !linkSlug.startsWith(slug)) {
            continue; // fau link — skip
          }
        }

        // [#v3.5.0] Only include URLs on KNOWN download/stream hosts
        if (!KNOWN_DL_HOSTS_RE.test(linkUrl)) {
          // Not a known download host — skip unless explicitly labeled as download
          if (!/download\s*link|direct\s*download|download\s*now/i.test(linkText)) continue;
        }

        // De-dup
        if (seenUrls.has(linkUrl)) continue;
        seenUrls.add(linkUrl);

        // Extract quality/size from surrounding context
        const idx = lm.index;
        const contextStr = scopedHtml.slice(Math.max(0, idx - 300), idx + 300);
        const qMatch = contextStr.match(/\b(4K|2160p|1080p|720p|480p|WEB-DL|BluRay|HDRip|HEVC|10Bit|HQ-HDTC|HDTC|HQ-iMAX)\b/i);
        const sizeMatch = contextStr.match(/(\d+(?:\.\d+)?\s*(?:GB|MB))/i);
        const q = qMatch ? qMatch[1] : '';
        const sz = sizeMatch ? sizeMatch[1] : '';

        // Determine host label
        let host = 'HDHub Main';
        if (/hubcdn\.sbs/i.test(linkUrl)) host = 'HubCDN';
        else if (/hubdrive\.(tips|com|net)/i.test(linkUrl)) host = 'HubDrive';
        else if (/gadgetsweb\.xyz/i.test(linkUrl)) host = 'GadgetsWeb';
        else if (/hubstream\.art/i.test(linkUrl)) host = 'HubStream';
        else if (/hubcloud\./i.test(linkUrl)) host = 'HubCloud';
        else if (/gdflix\./i.test(linkUrl)) host = 'GDFlix';
        else if (/filepress\./i.test(linkUrl)) host = 'FilePress';
        else if (/gdtot\./i.test(linkUrl)) host = 'GDTot';
        else if (/hdstream4u\.com/i.test(linkUrl)) host = 'HDStream4U';
        else if (/savelinks/i.test(linkUrl)) host = 'Savelinks';

        // Build a clean label
        let label = linkText && linkText !== 'Download Now' && linkText.length > 3
          ? linkText.slice(0, 80)
          : (q ? q.toUpperCase() + (sz ? ` (${sz})` : '') : `${host} Link`);

        downloadLinks.push({
          label,
          url: linkUrl,
          savelinks_url: linkUrl,
          quality: q,
          size: sz,
          host,
          // [#v3.5.0] Mark "direct" hosts (GDFlix/HubCloud/etc.) vs "intermediate"
          // (Savelinks). Direct hosts can be deep-resolved; intermediate need
          // server-side resolve.
          isDirect: KNOWN_DL_HOSTS_RE.test(linkUrl) && !/savelinks/i.test(linkUrl),
        });
      }

      // Sort: direct hosts first (GDFlix/HubCloud/HubDrive/HubCDN), then others
      downloadLinks.sort((a, b) => {
        if (a.isDirect && !b.isDirect) return -1;
        if (!a.isDirect && b.isDirect) return 1;
        return 0;
      });

      const streams = [];
      const iframeRegex = /<iframe[^>]+src="(https?:\/\/(?:hubstream\.art|hdstream4u\.com|new3\.hdhub4u\.cl)[^"]+)"/gi;
      let im;
      while ((im = iframeRegex.exec(html)) !== null) {
        streams.push({
          url: im[1],
          label: 'HDHub Stream (iframe)',
          // [#v3.5.0] Mark as iframe stream so the player opens it in an iframe
          isIframe: true,
        });
      }

      return {
        ok: true,
        slug,
        title,
        poster,
        synopsis,
        streamUrl: streams.length > 0 ? streams[0].url : (downloadLinks[0] ? downloadLinks[0].url : null),
        downloadLinks,
        downloads: downloadLinks,
        streams,
        episodes: [],
      };
    } catch (err) {
      console.warn('fetchHDHubMainDetailClient failed:', err);
      return { ok: false, error: err.message };
    }
  }

  async function fetchJson(url, opts = {}) {
    const { timeoutMs = 8000, retries = 1, signal } = opts;
    const isMovieBox = String(url).includes('/api/moviebox/');
    const isMovieBoxDetail = String(url).includes('/api/moviebox/movie');
    const isFibwatchDetail = String(url).includes('/api/fibwatch/movie');
    const isHDHub4u = String(url).includes('/api/hdhub4u/');
    const isHDHubMain = String(url).includes('/api/hdhubmain/');
    const isHDHubMainDetail = String(url).includes('/api/hdhubmain/movie');
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
      try {
        const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
        clearTimeout(t);
        if (r.status === 403 || r.status === 429 || r.status >= 500) {
          if (isHDHubMainDetail) {
            const clientRes = await fetchHDHubMainDetailClient(url);
            if (clientRes && clientRes.ok) return clientRes;
          } else if (isHDHubMain) {
            const clientRes = await fetchHDHubMainClient(url);
            if (clientRes && clientRes.ok && clientRes.items && clientRes.items.length > 0) return clientRes;
          } else if (isHDHub4u) {
            const clientRes = await fetchHDHub4uClient(url);
            if (clientRes && clientRes.ok && clientRes.items && clientRes.items.length > 0) return clientRes;
          } else if (isFibwatchDetail) {
            const clientRes = await fetchFibwatchDetailClient(url);
            if (clientRes && clientRes.ok) return clientRes;
          } else if (isMovieBoxDetail) {
            const clientRes = await fetchMovieBoxDetailClient(url);
            if (clientRes && clientRes.ok) return clientRes;
          } else if (isMovieBox) {
            const clientRes = await fetchMovieBoxClient(url);
            if (clientRes && clientRes.ok && clientRes.items.length > 0) return clientRes;
          }
          if (attempt < retries) { await sleep(500 * Math.pow(2, attempt)); continue; }
        }
        if (!r.ok) {
          if (isHDHubMainDetail) {
            const clientRes = await fetchHDHubMainDetailClient(url);
            if (clientRes && clientRes.ok) return clientRes;
          }
          if (isHDHubMain) {
            const clientRes = await fetchHDHubMainClient(url);
            if (clientRes && clientRes.ok && clientRes.items && clientRes.items.length > 0) return clientRes;
          }
          if (isHDHub4u) {
            const clientRes = await fetchHDHub4uClient(url);
            if (clientRes && clientRes.ok && clientRes.items && clientRes.items.length > 0) return clientRes;
          }
          if (isFibwatchDetail) {
            const clientRes = await fetchFibwatchDetailClient(url);
            if (clientRes && clientRes.ok) return clientRes;
          }
          if (isMovieBoxDetail) {
            const clientRes = await fetchMovieBoxDetailClient(url);
            if (clientRes && clientRes.ok) return clientRes;
          }
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
        const json = await r.json();
        if (isHDHubMain && (!json.ok || !json.items || json.items.length === 0)) {
          const clientRes = await fetchHDHubMainClient(url);
          if (clientRes && clientRes.ok && clientRes.items && clientRes.items.length > 0) return clientRes;
        }
        if (isHDHubMainDetail && (!json.ok || !json.downloads || json.downloads.length === 0)) {
          const clientRes = await fetchHDHubMainDetailClient(url);
          if (clientRes && clientRes.ok && clientRes.downloads && clientRes.downloads.length > 0) return clientRes;
        }
        if (isHDHub4u && (!json.ok || !json.items || json.items.length === 0)) {
          const clientRes = await fetchHDHub4uClient(url);
          if (clientRes && clientRes.ok && clientRes.items && clientRes.items.length > 0) return clientRes;
        }
        if (isFibwatchDetail && (!json.ok || !json.downloadLinks || json.downloadLinks.length === 0)) {
          const clientRes = await fetchFibwatchDetailClient(url);
          if (clientRes && clientRes.ok && clientRes.downloadLinks && clientRes.downloadLinks.length > 0) return clientRes;
        }
        if (isMovieBoxDetail && (!json.ok || !json.downloadLinks || json.downloadLinks.length === 0)) {
          const clientRes = await fetchMovieBoxDetailClient(url);
          if (clientRes && clientRes.ok && clientRes.downloadLinks && clientRes.downloadLinks.length > 0) return clientRes;
        }
        if (isMovieBox && !isMovieBoxDetail && (!json.ok || !json.items || json.items.length === 0)) {
          const clientRes = await fetchMovieBoxClient(url);
          if (clientRes && clientRes.ok && clientRes.items.length > 0) return clientRes;
        }
        return json;
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
        if (isFibwatchDetail) {
          const clientRes = await fetchFibwatchDetailClient(url);
          if (clientRes && clientRes.ok) return clientRes;
        } else if (isMovieBoxDetail) {
          const clientRes = await fetchMovieBoxDetailClient(url);
          if (clientRes && clientRes.ok) return clientRes;
        } else if (isMovieBox) {
          const clientRes = await fetchMovieBoxClient(url);
          if (clientRes && clientRes.ok && clientRes.items.length > 0) return clientRes;
        }
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
    if (isMovieBoxDetail) {
      const clientRes = await fetchMovieBoxDetailClient(url);
      if (clientRes && clientRes.ok) return clientRes;
    } else if (isMovieBox) {
      const clientRes = await fetchMovieBoxClient(url);
      if (clientRes && clientRes.ok) return clientRes;
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
    if (isDark) {
      document.documentElement.classList.add('dark-ui');
      document.body.classList.add('dark-ui');
      dom.darkToggle.checked = true;
    }
    dom.darkToggle.addEventListener('change', () => {
      const dark = dom.darkToggle.checked;
      document.documentElement.classList.toggle('dark-ui', dark);
      document.body.classList.toggle('dark-ui', dark);
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
  const SOURCES = [
    { id: 'mlsbd', label: 'MLSBD', toast: 'MLSBD সোর্সে চলে গেছে' },
    { id: 'fdm', label: 'FreeDrive', toast: 'FreeDriveMovie সোর্সে চলে গেছে' },
    { id: 'hdhub4u', label: 'HDHub4u', toast: 'HDHub4u সোর্সে চলে গেছে' },
    { id: 'hdhubmain', label: 'HDHub Main', toast: 'HDHub Main সোর্সে চলে গেছে' },
    { id: 'moviebox', label: 'MovieBox', toast: 'MovieBox সোর্সে চলে গেছে' },
    { id: 'fibwatch', label: 'Fibwatch', toast: 'Fibwatch.art সোর্সে চলে গেছে' },
    { id: 'fojik', label: 'Fojik.site', toast: 'Fojik.site সোর্সে চলে গেছে' },
    { id: 'krx18', label: 'KRX18', toast: 'KRX18.com সোর্সে চলে গেছে' },
  ];


  function isKrx18Unlocked() {
    return localStorage.getItem('skm.krx18_unlocked') === '1';
  }

  function getAvailableSources() {
    if (isKrx18Unlocked()) return SOURCES;
    return SOURCES.filter(s => s.id !== 'krx18');
  }

  function applySourceUI() {
    const s = SOURCES.find(x => x.id === state.source) || SOURCES[0];
    dom.sourceToggle.classList.toggle('fdm', state.source === 'fdm');
    dom.sourceToggle.classList.toggle('hd', state.source === 'hdhub4u');
    dom.sourceToggle.classList.toggle('mb', state.source === 'moviebox');
    dom.sourceToggle.classList.toggle('fw', state.source === 'fibwatch');
    dom.sourceToggle.classList.toggle('kr', state.source === 'krx18');
    dom.sourceLabel.textContent = s.label;
  }

  function initSourceToggle() {
    applySourceUI();
    dom.sourcesSheet = $('#sourcesSheet');
    dom.sourceToggle.addEventListener('click', () => toggleSource());

    if (dom.sourcesSheet) {
      dom.sourcesSheet.querySelectorAll('[data-close-sources]').forEach(el => {
        el.addEventListener('click', () => closeSourcesSheet());
      });
      dom.sourcesSheet.querySelectorAll('.source-select-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const targetSource = btn.getAttribute('data-source');
          if (targetSource) switchSource(targetSource);
        });
      });
      const unlockBtn = dom.sourcesSheet.querySelector('#unlockSourceBtn');
      if (unlockBtn) {
        unlockBtn.addEventListener('click', () => openUnlockModal());
      }
    }

    const headerUnlock = document.getElementById('headerUnlockBtn');
    if (headerUnlock) headerUnlock.addEventListener('click', () => openUnlockModal());
    const navUnlock = document.getElementById('navUnlockBtn');
    if (navUnlock) navUnlock.addEventListener('click', (e) => { e.preventDefault(); openUnlockModal(); });


    const unlockModal = document.getElementById('unlockModal');
    if (unlockModal) {
      unlockModal.querySelectorAll('[data-close-unlock]').forEach(el => {
        el.addEventListener('click', () => closeUnlockModal());
      });
      const submitBtn = unlockModal.querySelector('#submitUnlockBtn');
      if (submitBtn) submitBtn.addEventListener('click', () => submitUnlockCode());
      const input = unlockModal.querySelector('#unlockCodeInput');
      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submitUnlockCode();
        });
      }
    }
  }

  function openUnlockModal() {
    const modal = document.getElementById('unlockModal');
    if (!modal) return;
    modal.hidden = false;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    const input = document.getElementById('unlockCodeInput');
    if (input) { input.value = ''; setTimeout(() => input.focus(), 100); }
  }

  function closeUnlockModal() {
    const modal = document.getElementById('unlockModal');
    if (!modal) return;
    modal.hidden = true;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }

  function submitUnlockCode() {
    const input = document.getElementById('unlockCodeInput');
    const code = input ? input.value.trim().toLowerCase() : '';
    if (code === 'krx18') {
      localStorage.setItem('skm.krx18_unlocked', '1');
      closeUnlockModal();
      closeSourcesSheet();
      toast('🔓 Secret Source Unlocked!', 'success', 4000);
      const krxBtn = document.getElementById('krx18SourceBtn');
      if (krxBtn) krxBtn.style.display = 'flex';
      switchSource('krx18');
    } else {
      toast('❌ Invalid unlock code!', 'error', 3000);
    }
  }



  function openSourcesSheet() {
    if (!dom.sourcesSheet) { toggleSource(); return; }
    dom.sourcesSheet.hidden = false;
    dom.sourcesSheet.style.display = '';
    dom.sourcesSheet.setAttribute('aria-hidden', 'false');
    scrollLock.lock();

    // Show or hide KRX18 button based on unlock state
    const krxBtn = dom.sourcesSheet.querySelector('#krx18SourceBtn');
    if (krxBtn) krxBtn.style.display = isKrx18Unlocked() ? 'flex' : 'none';

    // Highlight active source
    dom.sourcesSheet.querySelectorAll('.source-select-btn').forEach(btn => {
      const isCur = btn.getAttribute('data-source') === state.source;
      btn.style.borderColor = isCur ? 'var(--accent-color, #3b82f6)' : 'var(--border-color)';
      btn.style.background = isCur ? 'rgba(59,130,246,0.12)' : 'rgba(255,255,255,0.04)';
    });
  }


  function closeSourcesSheet() {
    if (!dom.sourcesSheet) return;
    dom.sourcesSheet.hidden = true;
    dom.sourcesSheet.style.display = 'none';
    dom.sourcesSheet.setAttribute('aria-hidden', 'true');
    scrollLock.unlock();
  }

  function switchSource(targetId) {
    if (!dom.modal.hidden) closeModal({ pushState: false });
    if (!dom.sheet.hidden) closeSheet();
    if (!dom.categoriesSheet.hidden) closeCategoriesSheet();
    closeSourcesSheet();
    if (_listAbort) { _listAbort.abort(); _listAbort = null; }

    const s = SOURCES.find(x => x.id === targetId) || SOURCES[0];
    state.source = s.id;
    localStorage.setItem('skm.source', state.source);
    applySourceUI();
    toast(s.toast, 'success');

    state.page = 1;
    state.items = [];
    state.hasMore = true;
    state.searchQuery = '';
    state.hasError = false;
    currentCardIndex = -1;
    lastResolvedAt = 0; lastResolvedUrl = ''; lastResolvedSavelinks = '';
    clearTimeout(searchDebounceTimer);
    dom.searchInput.value = '';
    dom.searchClear.hidden = true;

    updateSectionHead();
    loadFeatured();
    loadList();
  }

  function toggleSource() {
    const idx = SOURCES.findIndex(x => x.id === state.source);
    const next = SOURCES[(idx + 1) % SOURCES.length];
    switchSource(next.id);
  }

  /* ─── Player Mode Toggle ─────────────────────────────────────────── */
  const PLAYER_MODES = [
    { id: 'inpage', label: '&#128265; In-Page', toast: 'In-Page Player সিলেক্টেড' },
    { id: 'hdhub4u', label: '&#127909; HDPlayer', toast: 'HDPlayer সিলেক্টেড (নতুন ট্যাবে খুলবে)' },
  ];

  function applyPlayerModeUI() {
    const btn = document.getElementById('playerModeBtn');
    if (!btn) return;
    const m = PLAYER_MODES.find(x => x.id === state.playerMode) || PLAYER_MODES[0];
    btn.innerHTML = m.label;
    btn.setAttribute('data-mode', state.playerMode);
  }

  function togglePlayerMode() {
    const idx = PLAYER_MODES.findIndex(x => x.id === state.playerMode);
    const next = PLAYER_MODES[(idx + 1) % PLAYER_MODES.length];
    state.playerMode = next.id;
    localStorage.setItem('skm.player', state.playerMode);
    applyPlayerModeUI();
    toast(next.toast, 'success');
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
      const adultParam = state.filter18 ? '' : 'adult=1';
      const r = await fetchJson(urlJoin(getApi().trending, adultParam));
      const items = respItems(r);
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
    // [#3 v3.5.0] CRITICAL FIX: store the PROXIED URL in data-original, NOT the raw URL.
    // The previous code stored the raw URL (e.g. https://myuijy.b-cdn.net/...),
    // which the IntersectionObserver then assigned to img.src on first viewport
    // entry. But raw BunnyCDN URLs return 403 to browser requests (BunnyCDN
    // requires a User-Agent header that the browser sends but the CDN's bot
    // protection rejects for cross-origin requests without Referer). This
    // caused ALL Fibwatch posters to silently fail and show the SVG placeholder.
    //
    // Fix: data-original now holds the proxied URL. The observer sets src to
    // the proxied URL on intersection, which fetches via /api/img with proper
    // headers. The onerror handler is preserved as a second-level fallback.
    const lazySrc = poster || originalPoster;
    const imgTag = showPoster && lazySrc
      ? `<img src="${escapeHtml(poster || PLACEHOLDER)}" alt="${escapeHtml(title)}" width="200" height="300" loading="lazy" decoding="async" data-original="${escapeHtml(lazySrc)}" onerror="handleImgError(this)">`
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
    // [#v3.5.0] data-original now holds the PROXIED URL (via imgProxy).
    // If the current src is not the proxied URL, try the proxied one.
    if (original && currentSrc !== original) {
      img.dataset.triedOriginal = '1';
      img.src = original;
      return;
    }
    // As a last resort, try the raw URL through /api/img explicitly.
    if (original && !original.startsWith('/api/img') && !original.startsWith(window.location.origin + '/api/img')) {
      img.dataset.triedOriginal = '1';
      let b64;
      try { b64 = btoa(original); } catch (_) { b64 = btoa(unescape(encodeURIComponent(original))); }
      b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      img.src = `/api/img?u=${b64}`;
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
    if (lazyImageObserver) {
      try { lazyImageObserver.disconnect(); } catch (_) {}
    }
    if (state.items.length === 0) { dom.grid.innerHTML = ''; dom.empty.hidden = !state.isLoading; currentCardIndex = -1; return; }
    dom.grid.innerHTML = state.items.map(cardHtml).join('');
    dom.empty.hidden = true;
    dom.loadMore.hidden = !state.hasMore;
    setupLazyImages();
  }

  function getLazyImageObserver() {
    if (lazyImageObserver) return lazyImageObserver;
    if (!('IntersectionObserver' in window)) return null;
    // [#12 v3.5.0] Use rootMargin 200px for smoother lazy loading.
    // The observer sets src to the value stored in data-original.
    // As of v3.5.0, data-original holds the PROXIED URL (via imgProxy),
    // so this assignment is safe — no more 403s from raw BunnyCDN URLs.
    lazyImageObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.original && img.dataset.original !== img.getAttribute('src')) {
            img.src = img.dataset.original;
            delete img.dataset.original;
          }
          img.classList.add('is-loaded');
          lazyImageObserver.unobserve(img);
        }
      });
    }, { rootMargin: '200px 0px', threshold: 0.01 });
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
  let _listAbort = null;
  async function loadList({ append = false } = {}) {
    if (state.isLoading) return;
    if (_listAbort) { _listAbort.abort(); _listAbort = null; }
    _listAbort = new AbortController();
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
        const r = await fetchJson(urlJoin(getApi().trending, state.filter18 ? '' : 'adult=1'), { signal: _listAbort.signal });
        items = respItems(r); state.hasMore = respHasMore(r); renderListResult(items, append); return;
      }
      if (state.view === 'south') {
        if (state.source === 'hdhub4u') {
          const url = `${getApi().category}&slug=${encodeURIComponent('south-indian-movies')}&page=${state.page}${adultParam}`;
          const r = await fetchJson(url, { signal: _listAbort.signal });
          items = respItems(r); state.hasMore = respHasMore(r); renderListResult(items, append); return;
        }
        const slug = state.source === 'fdm' ? 'south-indian' : 'south-indian-movies';
        const url = state.source === 'fdm'
          ? `/api/fdm/category?slug=${slug}&page=${state.page}${adultParam}`
          : `/api/south?page=${state.page}${adultParam}`;
        const r = await fetchJson(url, { signal: _listAbort.signal });
        items = respItems(r); state.hasMore = respHasMore(r); renderListResult(items, append); return;
      }
      if (state.view === 'south-hindi') {
        if (state.source === 'hdhub4u') {
          const url = `${getApi().search}&q=${encodeURIComponent('hindi dubbed')}&page=${state.page}${adultParam}`;
          const r = await fetchJson(url, { signal: _listAbort.signal });
          items = respItems(r); state.hasMore = respHasMore(r); renderListResult(items, append); return;
        }
        const url = state.source === 'fdm'
          ? `/api/fdm/search?q=hindi%20dubbed&page=${state.page}${adultParam}`
          : `/api/south?hindi=1&page=${state.page}${adultParam}`;
        const r = await fetchJson(url, { signal: _listAbort.signal });
        items = respItems(r); state.hasMore = respHasMore(r); renderListResult(items, append); return;
      }
      if (state.view === 'category') {
        let url;
        if (state.source === 'fdm' && (state.categorySlug === 'hindi-dubbed' || state.categorySlug === 'dual-audio')) {
          const query = state.categorySlug === 'hindi-dubbed' ? 'hindi dubbed' : 'dual audio';
          url = `/api/fdm/search?q=${encodeURIComponent(query)}&page=${state.page}${adultParam}`;
        } else {
          url = urlJoin(getApi().category, `slug=${encodeURIComponent(state.categorySlug)}`, `page=${state.page}`, adultParam.replace('&', ''));
        }
        const r = await fetchJson(url, { signal: _listAbort.signal });
        items = respItems(r); state.hasMore = respHasMore(r); renderListResult(items, append); return;
      }
      if (state.view === 'search') {
        if (!state.searchQuery) { state.isLoading = false; hideSkeletons(); dom.empty.hidden = false; return; }
        const r = await fetchJson(urlJoin(getApi().search, `q=${encodeURIComponent(state.searchQuery)}`, `page=${state.page}`, adultParam.replace('&', '')), { signal: _listAbort.signal });
        items = respItems(r); state.hasMore = respHasMore(r); renderListResult(items, append); return;
      }
      const params = new URLSearchParams({ page: String(state.page) });
      if (state.filter !== 'all') params.set('filter', state.filter);
      if (!state.filter18) params.set('adult', '1');
      const r = await fetchJson(urlJoin(getApi().latest, params.toString()), { signal: _listAbort.signal });
      items = respItems(r); state.hasMore = respHasMore(r);

      if (state.source === 'fojik' && items.length === 0 && !append) {
        items = await fetchFojikClientFallback();
        state.hasMore = items.length >= 12;
      }

      renderListResult(items, append);
    } catch (e) {
      if (e.name === 'AbortError') return;
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
      _listAbort = null;
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

  async function fetchFojikClientFallback() {
    try {
      let pathSuffix = '/';
      if (state.view === 'search' && state.searchQuery) {
        pathSuffix = state.page > 1 ? `/page/${state.page}/?s=${encodeURIComponent(state.searchQuery)}` : `/?s=${encodeURIComponent(state.searchQuery)}`;
      } else if (state.view === 'category' && state.categorySlug) {
        pathSuffix = state.page > 1 ? `/genre/${state.categorySlug}/page/${state.page}/` : `/genre/${state.categorySlug}/`;
      } else if (state.page > 1) {
        pathSuffix = `/page/${state.page}/`;
      }
      const targetUrl = wrapInProxy(`https://fojik.site${pathSuffix}`);
      const r = await fetch(targetUrl);
      if (r.ok) {
        const html = await r.text();
        return parseFojikHtmlClient(html);
      }
    } catch (e) {
      console.warn('Client fojik fallback error:', e);
    }
    return [];
  }

  function parseFojikHtmlClient(html) {
    const items = [];
    const seen = new Set();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const articles = doc.querySelectorAll('article, .result-item, .item, .post, .entry');
    articles.forEach(el => {
      const a = el.querySelector('.title a, h2 a, h3 a, h4 a, a[href*="/movie/"], a[href*="/series/"], a[href^="http"]');
      if (!a) return;
      const rawUrl = a.getAttribute('href') || '';
      let title = a.textContent.trim();
      const imgEl = el.querySelector('img');
      const img = imgEl ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || imgEl.getAttribute('data-lazy-src') || '') : '';
      if (!rawUrl || title.length < 3 || title.toLowerCase() === 'movie') return;
      const sm = rawUrl.match(/\/(?:movie|series)\/([^/]+)/i) || rawUrl.match(/\/([^/]+)\/?$/i);
      const slug = sm ? sm[1] : '';
      if (!slug || slug === 'movie' || slug === 'genre' || seen.has(slug)) return;
      seen.add(slug);

      const qM = title.match(/(480p|720p|1080p|2160p|4k|hdrip|web-dl|bluray|hevc)/i);
      const yM = title.match(/\b(19\d{2}|20\d{2})\b/);

      items.push({
        id: slug, slug: slug, title: title, poster: img,
        quality: qM ? qM[1].toUpperCase() : 'HD',
        year: yM ? yM[1] : '', rating: '', source: 'fojik', url: rawUrl
      });
    });

    if (items.length === 0) {
      doc.querySelectorAll('a[href*="/movie/"], a[href*="/series/"]').forEach(a => {
        const href = a.getAttribute('href') || '';
        const tText = a.textContent.trim();
        if (!tText || tText.length < 3 || /read more|download|watch/i.test(tText)) return;
        const sm = href.match(/\/(?:movie|series)\/([^/]+)/i) || href.match(/\/([^/]+)\/?$/i);
        const s = sm ? sm[1] : '';
        if (!s || s === 'movie' || seen.has(s)) return;
        seen.add(s);
        const qM = tText.match(/(480p|720p|1080p|2160p|4k|hdrip|web-dl|bluray|hevc)/i);
        const yM = tText.match(/\b(19\d{2}|20\d{2})\b/);
        items.push({
          id: s, slug: s, title: tText, poster: '',
          quality: qM ? qM[1].toUpperCase() : 'HD',
          year: yM ? yM[1] : '', rating: '', source: 'fojik', url: href
        });
      });
    }

    return items;
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

  // Normalize a movie detail response into the shape renderMovieModal expects.
  // MLSBD / FDM provide `info.{year,quality,language,imdbRating,...}` + `downloads`.
  // HDHub4u provides those fields at the top level (`year`, `genres`, `language`,
  // `imdbRating`, `downloads`, `streams`) without the nested `info` wrapper.
  function normalizeMovie(m) {
    if (!m || typeof m !== 'object') return m;
    if (m.__normalized) return m;
    if (m.info && typeof m.info === 'object') return m;
    const info = {
      year: m.year || (m.qualities && m.qualities[0] && m.qualities[0].label ? '' : ''),
      quality: m.quality || (m.qualities && m.qualities[0] && m.qualities[0].label) || '',
      language: m.language || '',
      imdbRating: m.imdbRating || '',
      cast: m.stars || m.cast || '',
      director: m.director || '',
      genre: Array.isArray(m.genres) ? m.genres.join(', ') : (m.genres || ''),
      storyline: m.storyline || '',
    };
    // [#v3.5.0] Filter + sort downloads to remove "fau" cross-reference links
    // (other movies' page links from hdhub4u.<tld> sidebar/related posts).
    const KNOWN_DL_HOSTS_RE = /hubcdn\.sbs|hubdrive\.(tips|com|net)|gadgetsweb\.xyz|hubstream\.art|hdstream4u\.com|hubcloud\.(foo|lol|com)|gdflix\.(dev|dad|com|io)|filepress\.(baby|com)|gdtot\.(dad|com|dev)|gdlink\.dev|multidownload\.website|busycdn\.xyz|indexserver\.site|fastdl|driveleech|savelinks|multicloudlinks|bdl\d+\.multicloudlinks/i;
    const filteredDownloads = (Array.isArray(m.downloads) ? m.downloads : []).filter((d) => {
      const url = d.savelinks_url || d.url || '';
      if (!url) return false;
      // Skip social/share/page-nav links
      if (/facebook|twitter|telegram|whatsapp|reddit|t\.me\/share|how-to-download|gmpg\.org|#respond|wp-content|wp-includes/i.test(url)) return false;
      // [#v3.5.0] Skip "fau" cross-reference links: any hdhub4u.<tld>/<other-slug>/
      // that points to a DIFFERENT movie's page.
      if (/hdhub4u\.(cl|ag|download|kim|lol|com|tours|yachts|skin|tv|cat)/i.test(url) ||
          /hdhub4us\.ai\.in/i.test(url)) {
        const linkSlug = url.replace(/^https?:\/\/[^\/]+\//, '').replace(/\/$/, '').split(/[?#]/)[0];
        // Only keep if it matches the current movie's slug OR is a known stream sub-path
        // (e.g. /watch/, /play/). Otherwise it's a fau link to another movie.
        if (m.slug && linkSlug !== m.slug && !linkSlug.startsWith(m.slug) &&
            !/\/watch\//i.test(url) && !/\/play\//i.test(url)) {
          return false;
        }
      }
      return true;
    }).map((d) => {
      const url = d.savelinks_url || d.url || '';
      // [#v3.5.0] Mark direct vs intermediate hosts
      let host = d.host || '';
      if (!host) {
        if (/hubcdn\.sbs/i.test(url)) host = 'HubCDN';
        else if (/hubdrive\./i.test(url)) host = 'HubDrive';
        else if (/gadgetsweb\.xyz/i.test(url)) host = 'GadgetsWeb';
        else if (/hubstream\.art/i.test(url)) host = 'HubStream';
        else if (/hdstream4u\.com/i.test(url)) host = 'HDStream4U';
        else if (/hubcloud\./i.test(url)) host = 'HubCloud';
        else if (/gdflix\./i.test(url)) host = 'GDFlix';
        else if (/filepress\./i.test(url)) host = 'FilePress';
        else if (/savelinks/i.test(url)) host = 'Savelinks';
        else if (/multicloudlinks/i.test(url)) host = 'MultiCloud';
      }
      const isDirect = KNOWN_DL_HOSTS_RE.test(url) && !/savelinks/i.test(url);
      return {
        ...d,
        savelinks_url: url,
        quality: d.quality || d.label || '',
        host,
        isDirect,
        isStream: d.isStream || /hdstream4u|hubstream/i.test(url),
      };
    });
    // [#v3.5.0] Sort: direct download hosts first, then streams, then savelinks.
    filteredDownloads.sort((a, b) => {
      const rank = (d) => {
        if (d.isDirect && !d.isStream) return 0;  // direct download
        if (d.isStream) return 1;                  // stream (iframe player)
        if (/savelinks/i.test(d.savelinks_url || '')) return 2; // intermediate
        return 3;                                  // unknown
      };
      return rank(a) - rank(b);
    });

    const out = {
      ...m,
      __normalized: true,
      info,
      title: m.title || '',
      slug: m.slug || '',
      poster: m.poster || '',
      genres: Array.isArray(m.genres) ? m.genres : (m.genres ? [m.genres] : []),
      downloads: filteredDownloads,
      screenshots: Array.isArray(m.screenshots) ? m.screenshots : [],
      trailer: m.trailer || '',
    };
    // Map HDHub4u stream players into downloads so the Play/Download sheet works.
    if (Array.isArray(m.streams) && m.streams.length) {
      const streamDownloads = m.streams.map((s) => ({
        label: s.label || s.player || 'Stream',
        url: s.url || '',
        savelinks_url: s.url || '',
        quality: '',
        size: '',
        isStream: true,
        isIframe: s.isIframe || /hubstream|hdstream4u|hdhub4u/i.test(s.url || ''),
        kind: s.kind || 'stream',
      }));
      out.downloads = out.downloads.concat(streamDownloads);
    }
    return out;
  }

  async function openMovie(slug, { pushState = true } = {}) {
    state.currentMovieSlug = slug;
    dom.modal.hidden = false; dom.modal.style.display = ''; dom.modal.setAttribute('aria-hidden', 'false');
    scrollLock.lock();
    trapFocus(dom.modal);

    const cached = prefetchCacheGet(slug);
    if (cached) {
      const m = normalizeMovie(cached);
      state.currentMovieData = m;
      recordHistory(slug);
      if (pushState) {
        const url = new URL(location.href);
        url.searchParams.set('movie', slug);
        history.pushState({ slug }, '', url.toString());
      }
      renderMovieModal(m);
      return;
    }

    dom.modalBody.innerHTML = '<div class="skm-spinner-wrapper"><div class="skm-loader"></div><div class="skm-loading-text">Loading Movie Details...</div></div>';

    try {
      const params = new URLSearchParams(location.search);
      const nocache = params.get('nocache');
      let apiUrl = `${getApi().movie}${getApi().movie.includes('?') ? '&' : '?'}slug=${encodeURIComponent(slug)}`;
      if (nocache) apiUrl += `&nocache=${nocache}`;
      const r = await fetchJson(apiUrl);
      const m = normalizeMovie(r);
      state.currentMovieData = m;
      if (pushState) {
        const url = new URL(location.href);
        url.searchParams.set('movie', slug);
        history.pushState({ slug }, '', url.toString());
      }
      recordHistory(slug);
      renderMovieModal(m);
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

    const streamsList = [];
    const seenStreams = new Set();
    (Array.isArray(m.streams) ? m.streams : []).forEach(s => {
      const u = s.url || s.savelinks_url;
      if (u && !seenStreams.has(u)) {
        seenStreams.add(u);
        streamsList.push(s);
      }
    });
    downloads.forEach(d => {
      const u = d.savelinks_url || d.url;
      if (u && !seenStreams.has(u) && (d.isStream || /watch|player|stream/i.test(d.label || '') || /hdstream4u|morencius|hubstream|javeng/i.test(u))) {
        seenStreams.add(u);
        streamsList.push(d);
      }
    });


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
              <button class="hero-btn hero-btn--ghost" id="playerModeBtn" title="Switch player">${state.playerMode === 'hdhub4u' ? '&#127909; HDPlayer' : '&#128265; In-Page'}</button>
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
        ${m.seasons && m.seasons.length ? `
          <div style="margin-top:16px;background:rgba(255,255,255,0.04);border:1px solid var(--border-color);border-radius:12px;padding:16px;">
            <div style="font-size:15px;font-weight:700;margin-bottom:10px;color:var(--text-main);">📺 Seasons & Episodes List (${m.seasons.length} Seasons)</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;">
              ${m.seasons.map(s => `<div style="background:rgba(255,255,255,0.06);padding:8px 12px;border-radius:8px;font-size:13px;"><strong>Season ${s.se}</strong><div style="font-size:11px;color:var(--text-muted);">${s.maxEp} Episodes</div></div>`).join('')}
            </div>
          </div>` : ''}
        ${streamsList.length ? `
          <div class="post-section-title stream" style="display:flex;align-items:center;justify-content:space-between;margin-top:20px;margin-bottom:12px;">
            <span>🎬 Online Stream Players (Ad-Free Sandboxed)</span>
            <span class="chip" style="background:#10b981;color:#fff;font-size:10px;padding:3px 8px;border-radius:6px;font-weight:700;">🛡️ 100% Ads & Popups Blocked</span>
          </div>
          <div class="stream-sections" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:12px;margin-bottom:20px;">
            ${streamsList.map(s => {
              const url = s.url || s.savelinks_url;
              let b64;
              try { b64 = btoa(url); } catch (_) { b64 = btoa(unescape(encodeURIComponent(url))); }
              b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
              const iframePlayerUrl = '/iframe-player.html?url=' + b64 + '&title=' + encodeURIComponent(title);
              const origLabel = s.label || s.host || 'Watch Stream';
              const isPlayer1 = /player\s*1|hdstream|morencius/i.test(origLabel);
              const isPlayer2 = /player\s*2|hubstream/i.test(origLabel);
              const isKrx = /krx|javeng/i.test(origLabel || url);

              let badgeTitle = isPlayer1 ? 'Watch Player 1 (Direct HLS)' : (isPlayer2 ? 'Watch Player 2 (Ad-Free Embed)' : (isKrx ? 'KRX18 Player (JavEng Stream)' : origLabel));
              let btnBg = isPlayer1 ? 'linear-gradient(135deg, #2563eb, #1d4ed8)' : (isPlayer2 ? 'linear-gradient(135deg, #7c3aed, #6d28d9)' : 'linear-gradient(135deg, #059669, #10b981)');

              return `
                <a class="stream-card-btn" href="${escapeHtml(iframePlayerUrl)}" target="_blank" rel="noopener" style="background:${btnBg};border-radius:12px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;color:#fff;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,0.25);transition:all 0.2s ease;">
                  <div style="display:flex;align-items:center;gap:12px;">
                    <span style="font-size:22px;">▶️</span>
                    <div style="text-align:left;">
                      <div style="font-weight:700;font-size:14px;line-height:1.2;">${escapeHtml(badgeTitle)}</div>
                      <div style="font-size:11px;opacity:0.85;margin-top:2px;">Shielded Sandboxed Player</div>
                    </div>
                  </div>
                  <span class="chip" style="background:rgba(255,255,255,0.25);color:#fff;font-size:10px;font-weight:800;border:none;">PLAY</span>
                </a>
              `;
            }).join('')}
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
                    const fu = item.fu || item.fojikFu || '';
                    const fn = item.fn || item.fojikFn || '';
                    return `<a class="dl-btn dl-btn--${cls}" data-savelinks="${escapeHtml(item.savelinks_url || item.url)}" data-quality="${escapeHtml(item.quality)}" data-size="${escapeHtml(item.size || '')}" data-fu="${escapeHtml(fu)}" data-fn="${escapeHtml(fn)}" href="${escapeHtml(item.savelinks_url || item.url)}" target="_blank" rel="noopener noreferrer"><span class="dl-btn__quality">${escapeHtml(item.host ? item.host + ' ' + (item.quality || 'DL') : (item.quality || 'Download'))}</span>${item.size ? `<span class="dl-btn__size">${escapeHtml(item.size)}</span>` : ''}</a>`;
                  }).join('')}
                </div>
              </div>`).join('')}
          </div>` : ''}

      </div>
    `;
    applyPlayerModeUI();
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
    if (document.activeElement && document.activeElement !== document.body) {
      try { document.activeElement.blur(); } catch (_) {}
    }
    releaseFocus();
    dom.modal.hidden = true; dom.modal.style.display = 'none'; dom.modal.setAttribute('aria-hidden', 'true');
    scrollLock.unlock();
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
    const movieData = state.currentMovieData || {};
    const record = {
      slug, title: movieData.title || slug, poster: movieData.poster || '',
      quality: movieData.info?.quality || '', language: movieData.info?.language || '',
      year: movieData.info?.year || '', viewedAt: Date.now()
    };
    let history = ls.get(STORE.history, []);
    history = history.filter((h) => h.slug !== slug);
    history.unshift(record);
    history = history.slice(0, 50);
    ls.set(STORE.history, history);
  }

  /* ─── Player resolution + sheet ─────────────────────────────────────── */
  let pendingResolveId = 0;
  const URL_FRESHNESS_MS = 4 * 60 * 1000;
  let lastResolvedAt = 0;
  let lastResolvedUrl = '';
  let lastResolvedSavelinks = '';

  /* ─── [FIX v3.4.0] Deep-resolve helpers ──────────────────────────────
     Background:
       MLSBD's /api/resolve scrapes savelinks.me and returns INTERMEDIATE
       page URLs (e.g. https://new.multicloudlinks.com/view/xp76vc) instead
       of direct video URLs. The frontend was passing these HTML pages
       straight to <video>.src, causing MEDIA_ELEMENT_ERROR: Format error.

     Fix:
       1. isDirectVideoUrl() — checks if URL has a video file extension.
       2. deepResolveVideoUrl() — fetches the intermediate page via
          /api/proxy, parses the HTML, and extracts the direct .mkv/.mp4
          link from common file-host patterns.
       3. ensurePlayableUrl() — orchestrates: returns a URL that is
          either a direct video URL (already wrapped in /api/proxy for
          CORS bypass) OR throws with a useful error code.
  ─────────────────────────────────────────────────────────────────────── */
  const VIDEO_EXT_RE = /\.(mp4|mkv|m3u8|webm|mov|avi|ts)(\?|#|$)|[\?&]action=watch\b/i;
  const INTERMEDIATE_HOST_RE = /multicloudlinks|multidownload|gdflix\.(dev|dad|com|io)|filepress\.(baby|com)|hubcloud\.(lol|foo|com)|hubdrive\.(tips|com|net)|gdtot\.(dad|com|dev)|gdlink\.dev|busycdn\.xyz|indexserver\.site|hubstream\.art/i;

  function isDirectVideoUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return VIDEO_EXT_RE.test(url);
  }

  function isIntermediateHostUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return INTERMEDIATE_HOST_RE.test(url);
  }

  // Wrap any direct video URL in /api/proxy so the browser gets CORS headers.
  // Idempotent: if already proxied, returns as-is.
  function ensureProxiedForVideo(rawUrl) {
    if (!rawUrl) return rawUrl;
    if (rawUrl.startsWith('/api/proxy?')) return rawUrl;
    if (rawUrl.startsWith(window.location.origin + '/api/proxy?')) return rawUrl;
    // Same-origin or data: URLs don't need proxy
    if (rawUrl.startsWith('data:') || rawUrl.startsWith('/')) return rawUrl;
    try {
      const u = new URL(rawUrl);
      // Same-origin
      if (u.origin === window.location.origin) return rawUrl;
      // Cross-origin video — always proxy to bypass CORS + add Range support
      let b64;
      try { b64 = btoa(rawUrl); } catch (_) { b64 = btoa(unescape(encodeURIComponent(rawUrl))); }
      b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return `${PROXY_WORKER_URL}?u=${b64}`;
    } catch {
      return rawUrl;
    }
  }

  // Try to extract a direct video URL from an intermediate host's HTML page.
  // Returns the direct URL (string) or null if none found.
  async function deepResolveVideoUrl(intermediateUrl, { timeoutMs = 9000 } = {}) {
    if (!isIntermediateHostUrl(intermediateUrl)) return null;
    try {
      const proxied = ensureProxiedForVideo(intermediateUrl);
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(proxied, { signal: controller.signal });
      clearTimeout(t);
      if (!resp.ok) return null;
      const ct = resp.headers.get('content-type') || '';
      // If upstream already returned a video, return the proxied URL as-is.
      if (/video\//i.test(ct)) return proxied;
      const html = await resp.text();
      // Support .m3u / #EXTM3U playlist content (e.g. Multidownload / Multicloud watch stream)
      if (html.includes('#EXTM3U') || intermediateUrl.includes('.m3u')) {
        const lines = html.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        const directUrls = lines.filter(l => /^https?:\/\//i.test(l));
        if (directUrls.length > 0) return directUrls[0];
      }

      // Extract downloadUrl from scripts / links (e.g. MultiCloud / MultiDownload links)
      const dlMatch = html.match(/downloadUrl\s*=\s*["']([^"']+)["']/i) ||
                      html.match(/href=["']([^"']+\?download=true)["']/i);
      if (dlMatch) {
        try {
          const fullDl = new URL(dlMatch[1], intermediateUrl).toString();
          return fullDl;
        } catch (e) {}
      }

      // Look for direct video URLs in the HTML.
      const urlPattern = /https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|webm|m3u8)(?:\?[^\s"'<>]*)?/gi;
      const matches = html.match(urlPattern) || [];
      // De-dup + prefer the most specific (longest path that contains the file name)
      const uniq = [...new Set(matches)];
      if (uniq.length === 0) return null;
      // Sort: prefer .mp4 > .m3u8 > .mkv > .webm (browser compat order)
      const rank = (u) => {
        const ext = (u.match(/\.(mp4|mkv|m3u8|webm)/i) || [])[1]?.toLowerCase() || '';
        return ({ mp4: 0, m3u8: 1, webm: 2, mkv: 3 })[ext] ?? 9;
      };
      uniq.sort((a, b) => rank(a) - rank(b));
      return uniq[0];

    } catch (e) {
      console.warn('deepResolveVideoUrl failed:', e);
      return null;
    }
  }

  // Orchestrate: take any URL, return a playable (proxied) URL or throw.
  async function ensurePlayableUrl(rawUrl, { timeoutMs = 9000 } = {}) {
    if (!isSafeUrl(rawUrl)) throw new Error('unsafe_url');
    // Already direct video? Just wrap in proxy for CORS.
    if (isDirectVideoUrl(rawUrl)) {
      return { playableUrl: ensureProxiedForVideo(rawUrl), source: 'direct', original: rawUrl };
    }
    // Intermediate page? Try to deep-resolve.
    if (isIntermediateHostUrl(rawUrl)) {
      const deep = await deepResolveVideoUrl(rawUrl, { timeoutMs });
      if (deep) {
        return { playableUrl: ensureProxiedForVideo(deep), source: 'deep-resolved', original: rawUrl, deepUrl: deep };
      }
      // Couldn't deep-resolve — return the page URL itself (will show fallback UI).
      return { playableUrl: null, source: 'intermediate-no-deep', original: rawUrl };
    }
    // Unknown URL type — let the player try.
    return { playableUrl: ensureProxiedForVideo(rawUrl), source: 'unknown', original: rawUrl };
  }

  // Translate a resolve response into the shape the player sheet expects:
  //   { ok, urls: [best, ...alt], hosts: [{host, url, text}] }
  // MLSBD/FDM return { ok, urls, hosts }. HDHub4u /api/hdhub4u/stream
  // returns { directUrl, streamUrl, externalUrl, proxyUrl, playerUrl, mxIntent, vlcUrl, iframe }.
  function normalizeResolve(r) {
    if (!r || typeof r !== 'object') return { ok: false, urls: [], hosts: [] };
    if (r.ok !== undefined && (r.urls || r.hosts)) return r; // already MLSBD/FDM shape
    const urls = [];
    if (r.directUrl) urls.push(r.directUrl);
    if (r.streamUrl && r.streamUrl !== r.directUrl) urls.push(r.streamUrl);
    if (r.proxyUrl && !urls.includes(r.proxyUrl)) urls.push(r.proxyUrl);
    if (r.playerUrl && !urls.includes(r.playerUrl)) urls.push(r.playerUrl);
    if (r.externalUrl && !urls.includes(r.externalUrl)) urls.push(r.externalUrl);
    const hosts = [];
    if (r.mxIntent) hosts.push({ host: 'MX Player', url: r.mxIntent, text: 'MX Player' });
    if (r.vlcUrl) hosts.push({ host: 'VLC', url: r.vlcUrl, text: 'VLC' });
    if (r.kmIntent) hosts.push({ host: 'KMPlayer', url: r.kmIntent, text: 'KMPlayer' });
    if (r.iframe) hosts.push({ host: 'Browser', url: r.iframe, text: 'Browser (fallback)' });
    const ok = !!((r.directUrl || r.streamUrl || r.externalUrl) && !r.error);
    return { ok, urls, hosts };
  }

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

  async function resolveAndOpenPlayer(savelinksUrl, title, quality, size, fojikFu, fojikFn) {
    if (fojikFu && fojikFn) {
      toast('Fojik ডাউনলোড লিংক খোলা হচ্ছে…', 'success');
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = savelinksUrl || 'https://search.technews24.site/blog.php';
      form.target = '_blank';
      form.rel = 'noreferrer noopener';

      const input1 = document.createElement('input');
      input1.type = 'hidden';
      input1.name = 'FU';
      input1.value = fojikFu;
      form.appendChild(input1);

      const input2 = document.createElement('input');
      input2.type = 'hidden';
      input2.name = 'FN';
      input2.value = fojikFn;
      form.appendChild(input2);

      document.body.appendChild(form);
      form.submit();
      document.body.removeChild(form);
      return;
    }

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
    const isKrxLink = /krx18\.com\/links\//i.test(savelinksUrl);

    if (isKrxLink) {
      toast('ডাউনলোড লিংক তৈরি করা হচ্ছে…', 'info');
      try {
        const r = await fetchJson(`${getApi().resolve}?url=${encodeURIComponent(savelinksUrl)}`);
        if (r && r.ok && r.urls && r.urls.length > 0) {
          const targetUrl = r.urls[0];
          toast('ডাউনলোড শুরু হচ্ছে…', 'success');
          window.open(targetUrl, '_blank');
          return;
        }
      } catch (e) {}
      window.open(savelinksUrl, '_blank');
      return;
    }

    if (!isSavelinks && !isFdmLink) {
      const isDirectHost = /k2s\.cc|keep2share|nitroflare|alterupload|1fichier|filebee|gofile|vikingfile|megaup|fastdl|pixeldrain|vcloud/i.test(savelinksUrl);
      if (isDirectHost) {
        toast('ডাউনলোড শুরু হচ্ছে…', 'success');
        window.open(savelinksUrl, '_blank');
        return;
      }

      // Always open resolved stream links in the Player Choice Sheet!
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
      const rRaw = await fetchJson(`${getApi().resolve}?url=${encodeURIComponent(savelinksUrl)}`, { signal: null });
      if (myId !== pendingResolveId) return;
      const r = normalizeResolve(rRaw);

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
      if (retryBtn) retryBtn.addEventListener('click', () => resolveAndOpenPlayer(savelinksUrl, title, quality, size));
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
    currentCardIndex = -1;
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
    const downloadUrl = streamUrl + (streamUrl.includes('?') ? '&' : '?') + 'dl=1';
    const d = detectDevice();
    const safeTitle = (title || '').replace(/[#;]/g, '').slice(0, 100);
    const intentStreamUrl = streamUrl.replace(/#/g, '%23').replace(/&/g, '%26');
    const btns = [];
    const mkBtn = (label, href, icon, primary = false) =>
      `<a class="sheet__btn ${primary ? 'sheet__btn--primary' : ''}" href="${escapeHtml(href)}" target="_blank" rel="noopener"><span class="sheet__btn-icon">${icon}</span>${escapeHtml(label)}</a>`;
    const dlSvg = '⬇️';

    const hdhubPlayerUrl = '/hdhub4u/player.html?url=' + encodeURIComponent(rawStreamUrl) + '&source=skmovies&title=' + encodeURIComponent(safeTitle);

    // 1. HDPlayer (Primary)
    btns.push(`<a class="sheet__btn sheet__btn--primary" href="${escapeHtml(hdhubPlayerUrl)}" target="_blank" rel="noopener"><span class="sheet__btn-icon">🎬</span>HDPlayer</a>`);

    // 2. External Player App (MX Player / VLC)
    if (d.isAndroid) {
      btns.push(mkBtn('External Player App', `intent:${intentStreamUrl}#Intent;action=android.intent.action.VIEW;type=video/*;end;`, '📱', false));
    } else {
      btns.push(mkBtn('External Player App', `vlc://${intentStreamUrl}`, '📱', false));
    }

    // 3. Direct Download
    btns.push(mkBtn('Direct Download', downloadUrl, dlSvg));

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
    if (_listAbort) { _listAbort.abort(); _listAbort = null; }
    state.view = view; state.page = 1; state.items = []; state.hasMore = true; state.hasError = false;
    state.filter = 'all'; state.searchQuery = '';
    currentCardIndex = -1;
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
    setTimeout(() => URL.revokeObjectURL(url), 1000); toast('ডেটা এক্সপোর্ট হয়েছে', 'success');
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
          const apiUrl = `${getApi().movie}${getApi().movie.includes('?') ? '&' : '?'}slug=${encodeURIComponent(slug)}`;
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
    const vw = window.innerWidth, vh = window.innerHeight;
    const mx = Math.min(touch.clientX, vw - 200);
    const my = Math.min(touch.clientY, vh - 200);
    menu.style.cssText = `
      position: fixed; top: ${my}px; left: ${mx}px;
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
          navigator.clipboard.writeText(url).then(() => toast('লিংক কপি হয়েছে', 'success')).catch(() => toast('কপি ব্যর্থ', 'error'));
          break;
        }
        case 'share': {
          const sUrl = `${location.origin}/?movie=${encodeURIComponent(slug)}`;
          if (navigator.share) navigator.share({ title, url: sUrl }).catch(() => {});
          else { navigator.clipboard.writeText(sUrl).then(() => toast('লিংক কপি হয়েছে', 'success')).catch(() => toast('কপি ব্যর্থ', 'error')); }
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
      const modeBtn = e.target.closest('#playerModeBtn');
      if (modeBtn) {
        haptic(HAPTIC.tap);
        togglePlayerMode();
        return;
      }
      const openBtn = e.target.closest('#openPlayerBtn');
      if (openBtn) {
        haptic(HAPTIC.tap);
        const first = dom.modalBody.querySelector('.dl-btn');
        if (!first) return;
        const url = first.getAttribute('data-savelinks');
        const quality = first.getAttribute('data-quality') || '';
        const size = first.getAttribute('data-size') || '';
        const title = prettyTitle(currentModalMovie ? currentModalMovie.title : 'Movie');
        if (state.playerMode === 'hdhub4u') {
          const isVideo = /\.(mp4|mkv|m3u8|webm)\b/i.test(url);
          if (isVideo) {
            const playerUrl = '/hdhub4u/player.html?url=' + encodeURIComponent(url) + '&source=skmovies&title=' + encodeURIComponent(title);
            window.open(playerUrl, '_blank', 'noopener,noreferrer');
            toast('HDPlayer খুলছে…', 'success');
          } else {
            resolveAndOpenPlayer(url, title, quality, size);
          }
        } else {
          resolveAndOpenPlayer(url, title, quality, size);
        }
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
        const fu = dlBtn.getAttribute('data-fu') || '';
        const fn = dlBtn.getAttribute('data-fn') || '';
        const title = prettyTitle(currentModalMovie.title);
        resolveAndOpenPlayer(url, title, quality, size, fu, fn);
        return;
      }
      const relatedCard = e.target.closest('.single-post');
      if (relatedCard) {
        haptic(HAPTIC.tap);
        const slug = relatedCard.getAttribute('data-slug');
        if (slug) {
          releaseFocus();
          dom.modal.hidden = true; dom.modal.style.display = 'none'; dom.modal.setAttribute('aria-hidden', 'true');
          if (dom.sheet.hidden && dom.categoriesSheet.hidden && (player.modal?.hidden ?? true)) scrollLock.unlock();
          currentModalMovie = null;
          openMovie(slug);
        }
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
      const ae = document.activeElement;
      if (!ae || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') return;
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
    if (dom.loadMoreBtn) dom.loadMoreBtn.addEventListener('click', () => {
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
    video: null, modal: null, hls: null,
    rotateAngle: 0, isStretched: false, speed: 1,

    init() {
      this.modal = document.getElementById('playerModal');
      this.video = document.getElementById('webVideoPlayer');
      if (!this.modal || !this.video) return;

      document.getElementById('playPauseBtn').addEventListener('click', () => this.togglePlay());
      this.video.addEventListener('click', () => this.togglePlay());

      const seekBar = document.getElementById('seekBar');
      seekBar.addEventListener('click', (e) => {
        if (!this.video.duration || isNaN(this.video.duration)) return;
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

    async open(rawUrl, title) {
      const t = document.getElementById('playerTitle');
      if (t) t.textContent = title || 'Movie';

      // [#1 v3.4.0] Validate + deep-resolve the URL before touching <video>.
      // This catches the "MLSBD resolve returns HTML page URL" bug at the
      // boundary instead of letting the <video> element fail cryptically.
      toast('ভিডিও লিংক যাচাই হচ্ছে…', 'success', 1800);

      let playableUrl = rawUrl;
      let urlSource = 'direct';
      let deepUrl = null;
      try {
        const r = await ensurePlayableUrl(rawUrl, { timeoutMs: 9000 });
        playableUrl = r.playableUrl || null;
        urlSource = r.source;
        deepUrl = r.deepUrl || null;
      } catch (e) {
        toast('ভিডিও লিংক অগ্রহণযোগ্য। অন্য কোয়ালিটি ট্রাই করুন।', 'error', 5000);
        return;
      }

      // If deep-resolve couldn't find a direct video URL, do NOT hand an HTML
      // page to <video>. Show a helpful sheet with manual options instead.
      if (!playableUrl) {
        this._showUnplayableSheet(rawUrl, title,
          'এই সোর্স থেকে সরাসরি ভিডিও লিংক পাওয়া যায়নি। নিচের অপশন ব্যবহার করুন।');
        return;
      }

      this.modal.hidden = false;
      this.modal.setAttribute('aria-hidden', 'false');
      scrollLock.lock();

      // Clean up previous playback
      if (this.hls) { this.hls.destroy(); this.hls = null; }
      this.video.removeAttribute('src');
      this.video.load();

      // Detect stream type from the PLAYABLE URL (after proxy wrap).
      // For proxied URLs, check the original/deep URL since /api/proxy?u=...b64
      // doesn't carry the file extension in its path.
      const checkUrl = deepUrl || rawUrl;
      const isHls = /\.m3u8(\?|$)/i.test(checkUrl);
      const isMkv = /\.(mkv)(\?|$)/i.test(checkUrl);

      // Show loading indicator
      toast('ভিডিও লোড হচ্ছে…', 'success', 2500);

      const url = playableUrl;
      if (isHls) {
        // HLS (m3u8) — use hls.js
        if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
          this.video.src = url;
          this.video.playbackRate = this.speed;
          this.video.play().catch(() => {
            toast('ভিডিও চালু করা যায়নি — অন্য কোয়ালিটি ট্রাই করুন', 'error');
          });
        } else if (window.Hls && Hls.isSupported()) {
          this.hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 90,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
          });
          this.hls.loadSource(url);
          this.hls.attachMedia(this.video);
          this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            this.video.playbackRate = this.speed;
            this.video.play().catch(() => {});
          });
          this.hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) {
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  toast('নেটওয়ার্ক এরর — রিকানেক্ট করা হচ্ছে…', 'error');
                  this.hls.startLoad();
                  break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                  toast('মিডিয়া এরর — রিকভার করা হচ্ছে…', 'error');
                  this.hls.recoverMediaError();
                  break;
                default:
                  toast('ভিডিও লোড ব্যর্থ — অন্য লিংক ট্রাই করুন', 'error', 4000);
                  this.hls.destroy();
                  this.hls = null;
                  break;
              }
            }
          });
        } else {
          toast('এই ব্রাউজারে HLS সাপোর্ট নেই — External Player ব্যবহার করুন', 'error', 4000);
        }
      } else if (isMkv) {
        // MKV — try native playback
        this.video.src = url;
        this.video.playbackRate = this.speed;
        this.video.load();

        const mkvTimeout = setTimeout(() => {
          if (this.video.readyState === 0) {
            toast('MKV ফরম্যাট এই ব্রাউজারে সরাসরি চলে না। External Player (VLC/MX Player) ব্যবহার করুন।', 'error', 5000);
          }
        }, 5000);

        this.video.addEventListener('loadeddata', () => clearTimeout(mkvTimeout), { once: true });
        this.video.addEventListener('error', () => {
          clearTimeout(mkvTimeout);
          toast('MKV প্লে ব্যর্থ — External Player ব্যবহার করুন (VLC/MX Player)', 'error', 5000);
        }, { once: true });

        this.video.play().catch(() => {
          clearTimeout(mkvTimeout);
          toast('MKV প্লে ব্যর্থ — External Player ব্যবহার করুন (VLC/MX Player)', 'error', 5000);
        });
      } else {
        // MP4 / WebM / direct URL
        this.video.src = url;
        this.video.playbackRate = this.speed;
        this.video.load();
        this.video.play().catch(() => {
          toast('ভিডিও চালু করা যায়নি — অন্য কোয়ালিটি বা প্লেয়ার ট্রাই করুন', 'error');
        });
      }

      if (!history.state?.playerOpen) {
        history.pushState({ ...history.state, playerOpen: true }, '');
      }
    },

    // [#2 v3.4.0] Show a helpful sheet when a URL can't be played in-browser.
    // Used when deep-resolve fails to find a direct video URL.
    _showUnplayableSheet(rawUrl, title, hint) {
      // Make sure player modal is closed if it was partially opened
      this.modal.hidden = true;
      this.modal.setAttribute('aria-hidden', 'true');
      if (dom.modal.hidden && dom.sheet.hidden && dom.categoriesSheet.hidden) {
        scrollLock.unlock();
      }
      const safeTitle = (title || 'Movie').replace(/[#;]/g, '').slice(0, 100);
      const hdhubPlayerUrl = '/hdhub4u/player.html?url=' + encodeURIComponent(rawUrl) +
        '&source=skmovies&title=' + encodeURIComponent(safeTitle);
      openSheet({
        title: 'প্লে করা যায়নি',
        hint: hint || 'এই লিংকটি সরাসরি প্লে করা যাচ্ছে না। নিচের অপশনগুলো ব্যবহার করুন।',
        url: rawUrl,
        tip: '💡 <b>HDPlayer</b> বেশিরভাগ ফরম্যাট প্লে করতে পারে। না চাইলে <b>VLC/MX Player</b> ব্যবহার করুন।',
        players:
          `<a class="sheet__btn sheet__btn--primary" href="${escapeHtml(hdhubPlayerUrl)}" target="_blank" rel="noopener"><span class="sheet__btn-icon">▶️</span>HDPlayer এ খুলুন (সুপারিশকৃত)</a>` +
          `<a class="sheet__btn" href="${escapeHtml(rawUrl)}" target="_blank" rel="noopener"><span class="sheet__btn-icon">🌐</span>সোর্স পেজ খুলুন</a>` +
          `<a class="sheet__btn" href="vlc://${escapeHtml(rawUrl.replace(/#/g, '%23').replace(/&/g, '%26'))}" target="_blank" rel="noopener"><span class="sheet__btn-icon">🟠</span>VLC এ খুলুন</a>` +
          `<button class="sheet__btn" id="_deepRetryBtn"><span class="sheet__btn-icon">🔄</span>আবার চেষ্টা করুন</button>`,
      });
      const retry = document.getElementById('_deepRetryBtn');
      if (retry) retry.addEventListener('click', () => {
        closeSheet();
        // Bypass cache by re-calling player.open after a tick
        setTimeout(() => player.open(rawUrl, title), 300);
      });
    },

    close({ popState = false } = {}) {
      this.modal.hidden = true;
      this.modal.setAttribute('aria-hidden', 'true');
      if (dom.modal.hidden && dom.sheet.hidden && dom.categoriesSheet.hidden) {
        scrollLock.unlock();
      }
      if (this.hls) { this.hls.destroy(); this.hls = null; }
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
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
      if (!this.video.duration || isNaN(this.video.duration)) return;
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
    // with first paint. If the document is already loaded, register directly.
    if ('serviceWorker' in navigator) {
      const registerSW = () => {
        navigator.serviceWorker.register('/sw.js')
          .then((reg) => {
            reg.onupdatefound = () => {
              const installingWorker = reg.installing;
              if (installingWorker) {
                installingWorker.onstatechange = () => {
                  if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    toast('নতুন আপডেট পাওয়া গেছে!', 'success');
                    const reloadBtn = document.createElement('button');
                    reloadBtn.textContent = 'রিলোড করুন';
                    reloadBtn.style.cssText = 'margin-left:12px;background:rgba(255,255,255,.2);color:#fff;border:1px solid rgba(255,255,255,.3);padding:4px 12px;border-radius:6px;cursor:pointer;font-size:13px';
                    reloadBtn.onclick = () => location.reload();
                    const t = document.querySelector('.toast');
                    if (t) t.appendChild(reloadBtn);
                  }
                };
              }
            };
          })
          .catch((err) => console.error('SW registration failed:', err));
      };
      if (document.readyState === 'complete') registerSW();
      else window.addEventListener('load', registerSW);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
