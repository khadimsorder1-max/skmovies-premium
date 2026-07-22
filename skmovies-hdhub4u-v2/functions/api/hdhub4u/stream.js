/**
 * GET /api/hdhub4u/stream?url=<player-url>
 * -----------------------------------------
 * Resolve a HDHub4u player URL to a direct, playable video URL
 * (.mp4 / .m3u8 / .mkv) suitable for MX Player, VLC, KMPlayer, or
 * an HTML5 <video> element.
 *
 * Per requirement #5 — resolved URLs cached 7 days in KV + Cache API
 * so we don't burn Worker requests on repeat plays of the same movie.
 *
 * Three modes:
 *
 *  (A) ?url=<player-url>&mode=iframe   (default for embed)
 *      Returns an HTML page that embeds the original player in a
 *      sandboxed, full-viewport iframe. Pop-ups, redirects, ads
 *      blocked via sandbox attributes.
 *
 *  (B) ?url=<player-url>&mode=direct   (default)
 *      Probes the player page and extracts the direct video URL.
 *      Returns JSON:
 *        {
 *          "source":   "hubstream" | "hdstream4u" | "hubdrive" | ...,
 *          "directUrl":  "https://.../movie.mp4",   // when found
 *          "streamUrl":  "https://.../index.m3u8",  // when HLS
 *          "gdriveId":   "1AbC...",                  // when GDrive
 *          "iframe":     "https://.../embed/...",   // last-resort embed
 *          "proxyUrl":   "/api/hdhub4u/proxy?url=...", // CORS-safe proxy
 *          "playerUrl":  "/player.html?url=...",    // OUR ad-free player
 *          "mxIntent":   "intent://...#Intent;package=com.mxtech.videoplayer.ad;S.title=...;end",
 *          "vlcUrl":     "vlc://https://...",       // VLC deep link
 *          "kmIntent":   "intent://...#Intent;package=com.kmplayer;S.title=...;end",
 *          "externalUrl": "https://...mp4"          // raw URL for "Open in app"
 *        }
 *
 *  (C) ?url=<player-url>&mode=player
 *      Returns an HTML page that loads OUR ad-free player (player.html)
 *      with the resolved direct URL. Used by the UI's openStream().
 */
const {
  fetchHTML,
  corsHeaders,
  jsonResponse,
  htmlResponse,
  HTMLParser,
  decodeHTMLEntities,
  setEnv,
  setWaitUntil,
} = require('./_lib.js');
const { TTL, cached, cacheKey } = require('./_cache.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

/**
 * Try to find a direct video URL inside a player page.
 * Different hosts use different conventions.
 */
async function resolveDirect(playerUrl) {
  let source = 'unknown';
  if (/hubstream\.art/i.test(playerUrl))  source = 'hubstream';
  else if (/hdstream4u\.com/i.test(playerUrl)) source = 'hdstream4u';
  else if (/hubdrive\.(?:tips|com|net)/i.test(playerUrl)) source = 'hubdrive';
  else if (/hubcdn\.sbs/i.test(playerUrl)) source = 'hubcdn';
  else if (/gadgetsweb\.xyz/i.test(playerUrl)) source = 'gadgetsweb';
  else if (/\.(?:mp4|mkv|webm|m3u8)(\?|$)/i.test(playerUrl)) source = 'directfile';

  // ---------- directfile ----------
  if (source === 'directfile') {
    return buildResponse({
      source,
      directUrl: /\.m3u8/i.test(playerUrl) ? undefined : playerUrl,
      streamUrl: /\.m3u8/i.test(playerUrl) ? playerUrl : undefined,
      iframe: playerUrl,
    });
  }

  // ---------- hubstream.art ----------
  if (source === 'hubstream') {
    try {
      const hashM = playerUrl.match(/#(\w+)/);
      const id = hashM ? hashM[1] : '';
      const embedUrl = 'https://hubstream.art/embed/' + id;
      const html = await fetchHTML(embedUrl);

      // Pattern 1: sources: [{ file: "https://..." }]  (JW Player config)
      const jwM = html.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["'](https?:\/\/[^"']+)["']/i);
      if (jwM) return buildResponse({ source, directUrl: jwM[1], iframe: embedUrl });

      // Pattern 2: "file": "https://..."
      const fileM = html.match(/["']?file["']?\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8|mkv)[^"']*)["']/i);
      if (fileM) {
        const u = fileM[1];
        return buildResponse({
          source,
          directUrl: /\.m3u8/i.test(u) ? undefined : u,
          streamUrl: /\.m3u8/i.test(u) ? u : undefined,
          iframe: embedUrl,
        });
      }

      // Pattern 3: <video><source src="...">
      const srcM = html.match(/<source[^>]+src=["']([^"']+)["']/i);
      if (srcM) return buildResponse({ source, directUrl: srcM[1], iframe: embedUrl });

      // Pattern 4: <video src="...">
      const vidM = html.match(/<video[^>]+src=["']([^"']+)["']/i);
      if (vidM) return buildResponse({ source, directUrl: vidM[1], iframe: embedUrl });

      // Pattern 5: any mp4/m3u8 URL anywhere in the page
      const anyM = html.match(/https?:\/\/[^"'\s<>]+\.(?:mp4|m3u8|mkv)(\?[^"'\s<>]*)?/i);
      if (anyM) {
        const u = anyM[0];
        return buildResponse({
          source,
          directUrl: /\.m3u8/i.test(u) ? undefined : u,
          streamUrl: /\.m3u8/i.test(u) ? u : undefined,
          iframe: embedUrl,
        });
      }

      // Pattern 6: nested iframe chain
      const ifM = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (ifM) {
        // Recursively resolve the nested iframe.
        try {
          const nested = await resolveDirect(ifM[1]);
          if (nested.directUrl || nested.streamUrl) return { ...nested, source };
        } catch (_) {}
        return buildResponse({ source, iframe: ifM[1] });
      }

      return buildResponse({ source, iframe: embedUrl });
    } catch (e) {
      return buildResponse({ source, error: String(e && e.message || e), iframe: playerUrl });
    }
  }

  // ---------- hdstream4u.com ----------
  if (source === 'hdstream4u') {
    try {
      const html = await fetchHTML(playerUrl);

      const jwM = html.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["'](https?:\/\/[^"']+)["']/i);
      if (jwM) return buildResponse({ source, directUrl: jwM[1], iframe: playerUrl });

      const fileM = html.match(/["']?file["']?\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8|mkv)[^"']*)["']/i);
      if (fileM) {
        const u = fileM[1];
        return buildResponse({
          source,
          directUrl: /\.m3u8/i.test(u) ? undefined : u,
          streamUrl: /\.m3u8/i.test(u) ? u : undefined,
          iframe: playerUrl,
        });
      }

      const srcM = html.match(/<source[^>]+src=["']([^"']+)["']/i);
      if (srcM) return buildResponse({ source, directUrl: srcM[1], iframe: playerUrl });

      const vidM = html.match(/<video[^>]+src=["']([^"']+)["']/i);
      if (vidM) return buildResponse({ source, directUrl: vidM[1], iframe: playerUrl });

      const anyM = html.match(/https?:\/\/[^"'\s<>]+\.(?:mp4|m3u8|mkv)(\?[^"'\s<>]*)?/i);
      if (anyM) {
        const u = anyM[0];
        return buildResponse({
          source,
          directUrl: /\.m3u8/i.test(u) ? undefined : u,
          streamUrl: /\.m3u8/i.test(u) ? u : undefined,
          iframe: playerUrl,
        });
      }

      const ifM = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (ifM) return buildResponse({ source, iframe: ifM[1] });

      return buildResponse({ source, iframe: playerUrl });
    } catch (e) {
      return buildResponse({ source, error: String(e && e.message || e), iframe: playerUrl });
    }
  }

  // ---------- hubdrive.* (GDrive) ----------
  if (source === 'hubdrive') {
    try {
      const html = await fetchHTML(playerUrl);

      const dlM = html.match(/https?:\/\/[^"'\s<>]+\.(?:mp4|mkv|m3u8)(\?[^"'\s<>]*)?/i);
      if (dlM) return buildResponse({ source, directUrl: dlM[0], iframe: playerUrl });

      const gdM = html.match(/(?:file\/d\/|id=)([a-zA-Z0-9_-]{20,})/);
      if (gdM) {
        const gdriveId = gdM[1];
        return buildResponse({
          source,
          gdriveId,
          directUrl: 'https://drive.google.com/uc?export=download&id=' + gdriveId,
          iframe: 'https://drive.google.com/file/d/' + gdriveId + '/preview',
        });
      }
      return buildResponse({ source, iframe: playerUrl });
    } catch (e) {
      return buildResponse({ source, error: String(e && e.message || e), iframe: playerUrl });
    }
  }

  // ---------- hubcdn.sbs ----------
  if (source === 'hubcdn') {
    try {
      const r = await fetch(playerUrl, {
        method: 'GET',
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      const finalUrl = r.url || playerUrl;
      if (/\.(?:mp4|mkv|m3u8)(\?|$)/i.test(finalUrl)) {
        return buildResponse({
          source,
          directUrl: /\.m3u8/i.test(finalUrl) ? undefined : finalUrl,
          streamUrl: /\.m3u8/i.test(finalUrl) ? finalUrl : undefined,
          iframe: playerUrl,
        });
      }
      const html = await r.text();
      const dlM = html.match(/https?:\/\/[^"'\s<>]+\.(?:mp4|mkv|m3u8)(\?[^"'\s<>]*)?/i);
      if (dlM) return buildResponse({ source, directUrl: dlM[0], iframe: playerUrl });
      return buildResponse({ source, iframe: playerUrl });
    } catch (e) {
      return buildResponse({ source, error: String(e && e.message || e), iframe: playerUrl });
    }
  }

  // ---------- gadgetsweb.xyz ----------
  if (source === 'gadgetsweb') {
    try {
      const r = await fetch(playerUrl, {
        method: 'GET',
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      const finalUrl = r.url || playerUrl;
      const html = await r.text();
      const dlM = html.match(/https?:\/\/[^"'\s<>]+\.(?:mp4|mkv|m3u8)(\?[^"'\s<>]*)?/i);
      if (dlM) return buildResponse({ source, directUrl: dlM[0], iframe: finalUrl });
      const locM = html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
      if (locM) {
        try {
          const nested = await resolveDirect(locM[1]);
          if (nested.directUrl || nested.streamUrl) return { ...nested, source };
        } catch (_) {}
        return buildResponse({ source, iframe: locM[1] });
      }
      return buildResponse({ source, iframe: finalUrl });
    } catch (e) {
      return buildResponse({ source, error: String(e && e.message || e), iframe: playerUrl });
    }
  }

  // Unknown host — return iframe fallback.
  return buildResponse({ source, iframe: playerUrl });
}

function buildResponse(info) {
  const { directUrl, streamUrl, gdriveId, iframe, source } = info;

  const playableUrl = directUrl || streamUrl ||
    (gdriveId ? 'https://drive.google.com/uc?export=download&id=' + gdriveId : null) ||
    iframe;

  // MX Player intent:// URI (free version)
  let mxIntent = '';
  if (playableUrl) {
    try {
      const u = new URL(playableUrl);
      mxIntent = 'intent://' + u.host + u.pathname + u.search +
                 '#Intent;package=com.mxtech.videoplayer.ad;S.title=HDHub4u;end';
    } catch (_) {
      mxIntent = 'intent://' + playableUrl.replace(/^https?:\/\//, '') +
                 '#Intent;package=com.mxtech.videoplayer.ad;S.title=HDHub4u;end';
    }
  }

  // VLC deep link (works on Android + iOS)
  let vlcUrl = '';
  if (playableUrl) vlcUrl = 'vlc://' + playableUrl;

  // KMPlayer intent (Android)
  let kmIntent = '';
  if (playableUrl) {
    try {
      const u = new URL(playableUrl);
      kmIntent = 'intent://' + u.host + u.pathname + u.search +
                 '#Intent;package=com.kmplayer;S.title=HDHub4u;end';
    } catch (_) {}
  }

  // Our own ad-free player page
  let playerUrl = '';
  if (playableUrl) {
    playerUrl = '/player.html?url=' + encodeURIComponent(playableUrl) +
                '&source=' + encodeURIComponent(source || 'unknown');
  }

  // CORS-safe proxy URL
  let proxyUrl = '';
  if (directUrl || streamUrl) {
    proxyUrl = '/api/hdhub4u/proxy?url=' + encodeURIComponent(playableUrl);
  }

  return {
    ...info,
    playableUrl,
    proxyUrl,
    playerUrl,
    mxIntent,
    vlcUrl,
    kmIntent,
    externalUrl: playableUrl,
    ts: Date.now(),
  };
}

/** Build the sandboxed iframe wrapper page used in mode=iframe. */
function buildIframePage(playerUrl, title = 'HDHub4u Player') {
  const safeTitle = title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeUrl   = playerUrl.replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${safeTitle}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
  .player-wrap { width: 100vw; height: 100vh; position: relative; }
  iframe {
    position: absolute; inset: 0; width: 100%; height: 100%;
    border: 0; background: #000;
  }
  .topbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 99;
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px;
    background: linear-gradient(to bottom, rgba(0,0,0,.85), transparent);
    color: #fff; font: 13px/1.4 -apple-system, system-ui, sans-serif;
    pointer-events: none; opacity: 0; transition: opacity .25s;
  }
  .player-wrap:hover .topbar, .topbar.show { opacity: 1; pointer-events: auto; }
  .topbar button {
    pointer-events: auto; cursor: pointer;
    background: rgba(255,221,149,.15); color: #ffdd95;
    border: 1px solid rgba(255,221,149,.4);
    padding: 6px 12px; border-radius: 18px; font-size: 12px;
    text-decoration: none;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .topbar button:hover { background: rgba(255,221,149,.3); }
  .topbar a {
    pointer-events: auto; cursor: pointer;
    background: rgba(93,173,226,.15); color: #5dade2;
    border: 1px solid rgba(93,173,226,.4);
    padding: 6px 12px; border-radius: 18px; font-size: 12px;
    text-decoration: none;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .topbar a:hover { background: rgba(93,173,226,.3); }
  .topbar .title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body>
<div class="player-wrap">
  <div class="topbar" id="topbar">
    <button onclick="history.back()">← Back</button>
    <span class="title">${safeTitle}</span>
    <button onclick="toggleFs()">⛶ FS</button>
    <a id="mxBtn" href="#" style="display:none">▶ MX</a>
    <a id="vlcBtn" href="#" style="display:none">▶ VLC</a>
    <a id="extBtn" href="#" style="display:none">↗ Open</a>
    <a id="myBtn"  href="#" target="_blank" style="display:inline-flex">⚡ Ad-free</a>
  </div>
  <iframe
    src="${safeUrl}"
    sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"
    allowfullscreen
    allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
    referrerpolicy="no-referrer"
  ></iframe>
</div>
<script>
  let showTimer;
  document.addEventListener('mousemove', () => {
    const bar = document.getElementById('topbar');
    bar.classList.add('show');
    clearTimeout(showTimer);
    showTimer = setTimeout(() => bar.classList.remove('show'), 2800);
  });
  document.addEventListener('touchstart', () => {
    const bar = document.getElementById('topbar');
    bar.classList.add('show');
    clearTimeout(showTimer);
    showTimer = setTimeout(() => bar.classList.remove('show'), 2800);
  });
  function toggleFs() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
  // Resolve underlying direct URL for MX / VLC / external buttons in parallel.
  fetch('/api/hdhub4u/stream?url=' + encodeURIComponent('${safeUrl}') + '&mode=direct')
    .then(r => r.json())
    .then(j => {
      if (j.mxIntent)    { document.getElementById('mxBtn').href  = j.mxIntent;    document.getElementById('mxBtn').style.display  = 'inline-flex'; }
      if (j.vlcUrl)      { document.getElementById('vlcBtn').href = j.vlcUrl;      document.getElementById('vlcBtn').style.display = 'inline-flex'; }
      if (j.externalUrl) { document.getElementById('extBtn').href = j.externalUrl; document.getElementById('extBtn').style.display = 'inline-flex'; }
      if (j.playerUrl)   { document.getElementById('myBtn').href  = j.playerUrl; }
    })
    .catch(() => {});
</script>
</body>
</html>`;
}

/** mode=player — return our own ad-free player page wrapper (redirect-style). */
function buildPlayerRedirectPage(playerUrl, title) {
  const safeTitle = (title || 'HDHub4u Player').replace(/</g, '&lt;');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${safeTitle}</title>
<meta http-equiv="refresh" content="0;url=/player.html?url=${encodeURIComponent(playerUrl)}"></head>
<body style="background:#000;color:#fff;font-family:system-ui;padding:24px">Loading ad-free player…</body></html>`;
}

export async function onRequestGet(ctx) {
  setEnv(ctx.env || {});
  if (ctx.waitUntil) setWaitUntil(ctx.waitUntil.bind(ctx));

  const url = new URL(ctx.request.url);
  const playerUrl = url.searchParams.get('url');
  const mode = url.searchParams.get('mode') || 'direct';
  const title = url.searchParams.get('title') || 'HDHub4u Player';

  if (!playerUrl) {
    return jsonResponse({ error: 'Missing ?url=<player-url>' }, 400);
  }

  if (mode === 'iframe') {
    return htmlResponse(buildIframePage(playerUrl, title));
  }
  if (mode === 'player') {
    return htmlResponse(buildPlayerRedirectPage(playerUrl, title));
  }

  // Default: direct mode — resolve underlying stream URL (cached 7 days).
  try {
    const key = cacheKey('stream', playerUrl);
    const { value: info, fromCache } = await cached(key, async () => {
      return await resolveDirect(playerUrl);
    }, TTL.STREAM);

    info._cache = fromCache;
    info.ts = Date.now();
    return jsonResponse(info);
  } catch (e) {
    return jsonResponse(
      { error: 'Failed to resolve stream', message: String(e && e.message || e) },
      502
    );
  }
}
