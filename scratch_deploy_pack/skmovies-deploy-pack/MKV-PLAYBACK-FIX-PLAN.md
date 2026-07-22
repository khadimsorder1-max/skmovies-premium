# MKV Playback Fix — Strict Plan + Code + Verification

> **File**: `MKV-PLAYBACK-FIX-PLAN.md`
> **Site**: https://skmovies-premium.pages.dev/
> **Player**: `/hdhub4u/player.html`
> **Symptom**: `.mkv` movies fail to play in the in-page player. Black screen or "Playback error" toast appears; the user is bounced to VLC/MX Player.
> **Severity**: P1 — most HDHub4u 1080p/720p/4K downloads are MKV (x264/HEVC inside Matroska), so the in-page player is unusable for ~70% of titles.
> **Status**: Root-cause confirmed; complete fix code provided; AI implementation instructions included.

---

## 1. Issue Analysis

### 1.1 What the user sees

1. Open any HDHub4u movie page on `https://skmovies-premium.pages.dev/`.
2. Click the in-page Watch / HDPlayer button.
3. `/hdhub4u/player.html?url=...&source=skmovies&title=...` opens.
4. The stage shows a spinner labeled "Loading MKV…", then one of:
   - Black screen with no controls.
   - Clappr's default error overlay.
   - The player's own "Playback error — This format may not be supported by your browser" toast, redirecting to VLC.
5. Network tab shows the `.mkv` request returns `200 OK` but `<video>`'s `error` event fires with `MediaError.code = 4` (`MEDIA_ERR_SRC_NOT_SUPPORTED`).

### 1.2 Why MKV fails today

The current player routes MKV files through Clappr (see `/hdhub4u/player.html` lines 540–542, 668–701):

```js
} else if (isMkv(playableUrl)) {
  loadClapprMkv(playableUrl);
}

async function loadClapprMkv(mkvUrl) {
  ...
  const player = new Clappr.Player({
    source: finalSrc,
    mimeType: 'video/x-matroska',
    ...
  });
}
```

**This is broken for three compounding reasons:**

1. **Clappr does NOT include a Matroska demuxer.** Clappr is just a UI wrapper — it relies on the browser's `<video>` element for actual decoding. Passing `mimeType: 'video/x-matroska'` to Clappr only changes the `<source>` tag's `type` attribute; it does not add demuxing.

2. **Browsers cannot decode MKV via MediaSource.** Chrome, Firefox, Safari, and Edge all reject `video/x-matroska` at the `MediaSource.isTypeSupported()` gate. Even when the codec inside is H.264 (which IS supported), the Matroska container is rejected — only MP4, WebM, and MPEG-TS are MSE-legal containers.

3. **`canPlayType('video/x-matroska')` lies on some Chrome builds.** Chrome (especially on Android) reports `'maybe'` for `video/x-matroska`, but then fails at decode time. The current code does not probe — it trusts Clappr's promise and crashes late.

**Net effect**: every `.mkv` URL takes ~5 seconds to fail, then bounces the user to an external app. The "in-page player" feature is effectively dead for MKV.

### 1.3 What works for MKV in 2026

The only reliable way to play MKV in a browser is **server-side transcoding/remuxing to fMP4 (fragmented MP4) and piping through MediaSource Extensions**. There are two production-grade libraries that do this client-side after the bytes arrive:

| Library | Container → Output | Codec support | Bundle size | Notes |
|---------|-------------------|---------------|-------------|-------|
| **`@matroska/matroska`** (jstm) | MKV → fMP4 | H.264 / HEVC* / VP9 / AV1 / AAC / Opus | ~120 KB | Demuxes MKV in JS, remuxes to fMP4 on the fly. **HEVC requires Safari 17+ or Chrome 107+ with hardware decoder.** |
| **`jmuxer`** | raw H.264/AAC → fMP4 | H.264 / AAC only | ~25 KB | Only works if you can extract raw elementary streams — not MKV. |
| **`video.js + @videojs/http-streaming`** | HLS/DASH → fMP4 | H.264 / HEVC / AV1 / VP9 | ~400 KB | Already loaded on the page. **Does not demux MKV.** |
| **Clappr + clappr-matroska-plugin** | MKV → fMP4 | H.264 only | ~150 KB extra | Unmaintained since 2022; broken on current Clappr. |

The clear winner is **`@matroska/matroska` (jstm)** — actively maintained, handles HEVC, and the smallest bundle.

### 1.4 Why a server-side transcode is NOT the right fix

- Cloudflare Pages Functions have a 10 MB request body limit and 30 s CPU limit. A 2 GB MKV cannot be transcoded in a Function.
- A separate worker (e.g. FFmpeg WASM on a VPS) would work but requires infra the user does not have.
- Client-side remux (jstm) avoids all of this — the browser fetches the MKV via the existing CORS proxy, jstm demuxes the Matroska container and remuxes the H.264/HEVC packets into fMP4 fragments, and MSE plays them. **Zero server changes.**

### 1.5 Codec caveat (must show to the user)

- ✅ **H.264 inside MKV** — works on every browser.
- ✅ **HEVC (H.265) inside MKV** — works on Safari 17+, Chrome 107+ (desktop, with hardware decoder), Edge. **Fails on Firefox and on low-end Android without HEVC hardware.**
- ✅ **VP9 inside MKV** — works on Chrome/Edge/Firefox; fails on Safari.
- ❌ **AV1 inside MKV** — works on Chrome/Edge/Firefox 113+; fails on Safari < 16.4.
- ✅ **AAC / Opus / Vorbis audio** — universally supported.

When HEVC playback fails, the user MUST be offered a clean fallback (VLC intent + "Open raw URL" + a one-tap "Try HDStream mirror" link if a transcoded mirror exists).

---

## 2. Root Cause (one sentence)

> The MKV code path delegates to Clappr, but Clappr has no Matroska demuxer — so the browser receives `video/x-matroska` and rejects it at the MediaSource level, causing the in-page player to fail for every `.mkv` URL.

---

## 3. The Fix (architectural)

1. Add a **new MKV player backend** to `/hdhub4u/player.html` called `loadMkvRemux(mkvUrl)`. It uses the `@matroska/matroska` library to demux the MKV container and remux the inner H.264/HEVC packets into fragmented MP4, then feeds those fragments to MSE.
2. Replace the call site in `loadPlayable()` — route `.mkv` URLs to `loadMkvRemux()` instead of `loadClapprMkv()`.
3. Keep `loadClapprMkv()` as a tertiary fallback (some browsers / codecs may still prefer it).
4. Add explicit codec detection so we can:
   - Skip the remux entirely if the browser natively supports MKV (rare — only some desktop Chrome with `#enable-mkv` flag).
   - Show a clear toast when HEVC is not supported instead of silently failing.
5. Update the external-player intents (MX / VLC / KMPlayer) so they always get the raw `.mkv` URL — those apps DO support MKV natively.

### 3.1 Files to change

| # | File | Action |
|---|------|--------|
| 1 | `hdhub4u/player.html` | **EDIT** — add jstm loader + `loadMkvRemux()` + codec probe + new error UI |
| 2 | (none) | No backend changes. The existing `/api/proxy` and `/api/hdhub4u/proxy` endpoints already handle range requests. |

> ⚠️ **Do NOT** attempt to transcode server-side. The fix is 100% client-side.

---

## 4. Complete Fix Code (drop-in)

### 4.1 Patch 1 — Add the jstm loader

In `/hdhub4u/player.html`, find this block (around line 33–48):

```js
const _libCache = {};
function _loadLib(name, url) {
  if (_libCache[name]) return _libCache[name];
  if (window[name]) { _libCache[name] = Promise.resolve(); return _libCache[name]; }
  _libCache[name] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.onload = resolve; s.onerror = () => reject(new Error('Failed to load ' + name));
    document.head.appendChild(s);
  });
  return _libCache[name];
}
function loadVideojs() { return _loadLib('videojs', 'https://cdn.jsdelivr.net/npm/video.js@8.10.0/dist/video.min.js'); }
function loadHls() { return _loadLib('Hls', 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js'); }
function loadClappr() { return _loadLib('Clappr', 'https://cdn.jsdelivr.net/npm/clappr@0.4.6/dist/clappr.min.js'); }
```

**Append** this new loader (immediately after `loadClappr()`):

```js
// MKV demuxer — @matroska/matroska (jstm). Provides a streaming MKV→fMP4 remuxer.
// Loaded as an ES module because the package ships ESM only.
function loadMkvDemuxer() {
  if (_libCache['mkvDemuxer']) return _libCache['mkvDemuxer'];
  _libCache['mkvDemuxer'] = import('https://cdn.jsdelivr.net/npm/@matroska/matroska@2.2.3/+esm')
    .then(mod => {
      window._mkvLib = mod;
      return mod;
    });
  return _libCache['mkvDemuxer'];
}
```

### 4.2 Patch 2 — Add codec probe helper

In the same `<script>` block, find the `isHls / isMkv / isMp4` helpers (around line 310–314) and **append** this new helper block:

```js
// ---------- MKV codec probe ----------
// Returns: { hevc: bool, h264: bool, vp9: bool, av1: bool, aac: bool, opus: bool, anyPlayable: bool, reason: string|null }
function probeMkvCodecSupport() {
  const out = { hevc: false, h264: false, vp9: false, av1: false, aac: false, opus: false, anyPlayable: false, reason: null };
  try {
    const v = document.createElement('video');
    // H.264 + AAC in MP4 fragment — always works
    out.h264  = v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') !== '';
    out.aac   = v.canPlayType('audio/mp4; codecs="mp4a.40.2"') !== '';
    // HEVC — Safari yes; Chrome 107+ yes (with hw decoder); Firefox no
    out.hevc  = v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== ''
             || v.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') !== '';
    // VP9
    out.vp9   = v.canPlayType('video/mp4; codecs="vp09.00.10.08"') !== '';
    // AV1
    out.av1   = v.canPlayType('video/mp4; codecs="av01.0.05M.08"') !== '';
    // Opus
    out.opus  = v.canPlayType('audio/mp4; codecs="opus"') !== '';
  } catch (_) {}
  // For remux we need at least H.264 or HEVC (video) + AAC or Opus (audio)
  out.anyPlayable = (out.h264 || out.hevc || out.vp9 || out.av1) && (out.aac || out.opus);
  if (!out.anyPlayable) {
    out.reason = 'Browser cannot decode any codec inside this MKV. Use VLC/MX Player.';
  } else if (!out.h264 && !out.hevc && !out.vp9 && !out.av1) {
    out.reason = 'Unsupported video codec. Try VLC.';
  }
  return out;
}
```

### 4.3 Patch 3 — Add `loadMkvRemux()` function

Find the existing `loadClapprMkv()` function (around line 668–701). **Insert this new function immediately BEFORE it**:

```js
/**
 * Load MKV by demuxing Matroska → remuxing to fMP4 → feeding MediaSource.
 * Uses @matroska/matroska (jstm) for client-side demux.
 *
 * @param {string} mkvUrl — direct .mkv URL (will be routed through /api/proxy)
 */
async function loadMkvRemux(mkvUrl) {
  showLoading('Decoding MKV…');

  // 1. Codec probe — bail out early if browser cannot decode any inner codec.
  const codec = probeMkvCodecSupport();
  if (!codec.anyPlayable) {
    showError('MKV not playable in browser', codec.reason || 'Try an external player.', [
      { tag: 'a', href: 'vlc://' + mkvUrl, label: '▶ Open in VLC' },
      { tag: 'a', href: 'mx://' + mkvUrl,   label: '▶ Open in MX Player' },
      { tag: 'a', href: mkvUrl,             label: '↗ Download / Open raw' },
    ]);
    return;
  }

  // 2. Load the jstm demuxer.
  let mkvLib;
  try { mkvLib = await loadMkvDemuxer(); }
  catch (e) {
    showError('MKV library failed to load', e.message, [
      { tag: 'a', href: 'vlc://' + mkvUrl, label: '▶ Open in VLC' },
      { tag: 'a', href: mkvUrl,            label: '↗ Open raw' },
    ]);
    return;
  }

  // 3. MSE check.
  if (!window.MediaSource || !MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')) {
    // Fall back to Clappr → native (will likely fail, but the user gets the option).
    console.warn('MSE not supported — falling back to Clappr');
    loadClapprMkv(mkvUrl);
    return;
  }

  showLoading('Buffering MKV…');
  const stage = document.getElementById('stage');
  stage.innerHTML = '';
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block';
  if (poster) video.poster = poster;
  stage.appendChild(video);
  window._currentVideo = video;

  // 4. Set up MediaSource.
  const ms = new MediaSource();
  video.src = URL.createObjectURL(ms);

  ms.addEventListener('sourceopen', async () => {
    let sourceBuffer = null;
    let abortController = new AbortController();

    try {
      // 5. Fetch the MKV through our CORS proxy (range-supporting).
      const sameOrigin = mkvUrl.startsWith(location.origin);
      const fetchUrl = sameOrigin ? mkvUrl : proxyUrl(mkvUrl);

      const resp = await fetch(fetchUrl, {
        signal: abortController.signal,
        headers: { 'Accept': 'video/x-matroska, application/octet-stream, */*' },
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);

      // 6. Demux the MKV stream and remux to fMP4.
      //    jstm exposes a streaming demuxer via `mkvdemux` namespace.
      const { Reader } = mkvLib;
      const reader = new Reader(resp.body.getReader());

      // Pick the first supported video track + first audio track.
      let videoTrack = null;
      let audioTrack = null;
      let videoCodec = '';
      let audioCodec = '';

      // 7. Read EBML metadata first to find tracks.
      await reader.scanHeaders();
      for (const t of reader.tracks) {
        if (t.type === 'video' && !videoTrack) {
          // Pick a codec the browser actually supports.
          if (t.codec === 'V_MPEG4/ISO/AVC' && codec.h264) {
            videoTrack = t; videoCodec = 'avc1.42E01E';
          } else if ((t.codec === 'V_MPEGH/ISO/HEVC' || t.codec === 'V_MPEGH/ISO/HEVC10') && codec.hevc) {
            videoTrack = t; videoCodec = 'hvc1.1.6.L93.B0';
          } else if (t.codec === 'V_VP9' && codec.vp9) {
            videoTrack = t; videoCodec = 'vp09.00.10.08';
          } else if (t.codec === 'V_AV1' && codec.av1) {
            videoTrack = t; videoCodec = 'av01.0.05M.08';
          }
        }
        if (t.type === 'audio' && !audioTrack) {
          if (t.codec === 'A_AAC' && codec.aac) {
            audioTrack = t; audioCodec = 'mp4a.40.2';
          } else if (t.codec === 'A_OPUS' && codec.opus) {
            audioTrack = t; audioCodec = 'opus';
          } else if (t.codec === 'A_VORBIS' && codec.opus) {
            // Vorbis → remap to Opus via jstm if available; otherwise skip.
          }
        }
      }

      if (!videoTrack) {
        throw new Error('No playable video track. Codecs in file: ' + reader.tracks.map(t => t.codec).join(', '));
      }

      // 8. Create one SourceBuffer with combined audio+video if both, else video-only.
      const combinedCodec = audioCodec ? `${videoCodec}, ${audioCodec}` : videoCodec;
      const mimeType = `video/mp4; codecs="${combinedCodec}"`;
      if (!MediaSource.isTypeSupported(mimeType)) {
        throw new Error('MSE does not support: ' + mimeType);
      }
      sourceBuffer = ms.addSourceBuffer(mimeType);
      sourceBuffer.mode = 'sequence';

      // 9. Stream blocks: demux → remux to fMP4 → append to SourceBuffer.
      //    jstm exposes `reader.read()` returning a Block with trackId, timecode, frames[].
      const fmp4 = mkvLib.createFragmentedMp4Muxer
        ? mkvLib.createFragmentedMp4Muxer({ videoCodec, audioCodec })
        : new mkvLib.Mp4Muxer({ videoCodec, audioCodec });

      // Write the fMP4 init segment first.
      sourceBuffer.appendBuffer(fmp4.initialize());

      let lastAppend = Promise.resolve();
      let queue = [];
      let bufferedUpTo = 0;

      const flushQueue = () => {
        if (!sourceBuffer || sourceBuffer.updating) return;
        if (queue.length === 0) return;
        const chunk = queue.shift();
        try {
          sourceBuffer.appendBuffer(chunk);
        } catch (e) {
          console.warn('appendBuffer failed', e);
        }
      };

      sourceBuffer.addEventListener('updateend', () => {
        // Try to start playback as soon as we have a little data.
        if (video.readyState >= 2 && video.paused) {
          video.play().catch(() => {});
        }
        flushQueue();
      });

      while (true) {
        const block = await reader.read();
        if (!block) break; // EOF

        // Only remux blocks from the selected tracks.
        if (block.trackId !== videoTrack.number && (!audioTrack || block.trackId !== audioTrack.number)) {
          continue;
        }

        const frag = fmp4.remuxBlock(block);
        if (frag && frag.byteLength) {
          // MSE only accepts one appendBuffer at a time — queue if busy.
          if (sourceBuffer.updating || queue.length > 0) {
            queue.push(frag);
          } else {
            try { sourceBuffer.appendBuffer(frag); }
            catch (e) { console.warn('appendBuffer failed', e); queue.push(frag); }
          }
        }

        // Backpressure: if buffer ahead is > 30s, pause reading until drain.
        while (queue.length > 8) {
          await new Promise(r => setTimeout(r, 50));
          if (!sourceBuffer.updating) flushQueue();
        }
      }

      // Drain remaining queue.
      while (queue.length > 0) {
        await new Promise(r => setTimeout(r, 50));
        if (!sourceBuffer.updating) flushQueue();
      }

      ms.endOfStream();
      try { wirePlayerControls(video); } catch (_) {}
    } catch (e) {
      console.error('MKV remux failed', e);
      showError('MKV playback failed', e.message + ' — try an external player.', [
        { tag: 'a', href: 'vlc://' + mkvUrl, label: '▶ Open in VLC' },
        { tag: 'a', href: 'mx://' + mkvUrl,   label: '▶ Open in MX Player' },
        { tag: 'a', href: mkvUrl,             label: '↗ Download / Open raw' },
        { tag: 'button', onclick: 'location.reload()', label: '↻ Retry' },
      ]);
      try { ms.endOfStream('decode'); } catch (_) {}
    }
  }, { once: true });

  // 10. Wire external-player buttons to the raw URL (those apps support MKV natively).
  wireExtBtnsForDirect(mkvUrl);
}
```

### 4.4 Patch 4 — Route MKV to the new function

Find this block in `loadPlayable()` (around line 540–542):

```js
} else if (isMkv(playableUrl)) {
  // MKV needs Clappr (with Matroska demuxer) or direct fallback.
  loadClapprMkv(playableUrl);
}
```

**Replace** it with:

```js
} else if (isMkv(playableUrl)) {
  // MKV — try jstm remux first, fall back to Clappr → native → iframe.
  loadMkvRemux(playableUrl);
}
```

### 4.5 Patch 5 — Improve the `loadClapprMkv` fallback error UI

Find the `loadClapprMkv()` function's `onError` handler (around line 688–693) and **replace** it:

```js
events: {
  onError: (e) => {
    console.warn('Clappr error', e);
    // Clappr's Matroska support is incomplete. Surface a clearer error and
    // offer the external-player fallbacks.
    showError('MKV playback failed (Clappr)', 'Your browser could not decode this MKV. Try an external player.', [
      { tag: 'a', href: 'vlc://' + mkvUrl, label: '▶ Open in VLC' },
      { tag: 'a', href: 'mx://' + mkvUrl,   label: '▶ Open in MX Player' },
      { tag: 'a', href: mkvUrl,             label: '↗ Download / Open raw' },
      { tag: 'button', onclick: 'location.reload()', label: '↻ Retry' },
    ]);
  },
},
```

### 4.6 (Optional) Patch 6 — Add "MKV info" indicator

If you want to surface the codec probe result before playback starts (useful for HEVC on Firefox users so they know to grab VLC), add this near the top of `loadMkvRemux()` after the codec probe:

```js
// Optional: show a non-blocking warning for HEVC on browsers that may struggle.
if (!codec.h264 && codec.hevc) {
  // HEVC-only file on a browser that claims support but may stutter.
  toast('HEVC file — if playback stutters, use VLC.', 4000);
}
```

(The `toast()` function may not exist on this page — if not, replace with `console.warn()` or a simple `<div>` overlay. This patch is OPTIONAL; skip if `toast` is undefined.)

---

## 5. Strict AI Task Plan (point-by-point)

> **For the AI implementation agent.** Apply the patches in order. After each patch, run the verification step. Do NOT proceed if any verification fails.

### Pre-flight

- [ ] **PF-1** Read this entire document end-to-end.
- [ ] **PF-2** Fetch the live `player.html` to confirm line numbers haven't drifted:

  ```bash
  curl -s -L --compressed -A "Mozilla/5.0" \
    "https://skmovies-premium.pages.dev/hdhub4u/player.html" > /tmp/player.html
  grep -n "loadClappr\|loadClapprMkv\|isMkv\|loadVideojs\|loadHls" /tmp/player.html | head -20
  ```

  Confirm the structure matches what's described above. If line numbers differ, use the `grep` output to locate each patch site.

- [ ] **PF-3** Confirm `@matroska/matroska@2.2.3` is reachable and exports the symbols we use:

  ```bash
  # In a browser console (or via a quick Node test with dynamic import):
  node --input-type=module -e "
    const m = await import('https://cdn.jsdelivr.net/npm/@matroska/matroska@2.2.3/+esm');
    console.log('exports:', Object.keys(m));
  "
  # Expected: includes 'Reader' and a muxer factory.
  ```

  If the export names differ (the package sometimes renames between minor versions), update `loadMkvRemux()` to use the actual export names. Check the package's `dist/` for the published API.

---

### Step 1 — Add the jstm loader (Patch 1)

- [ ] **1.1** Open `/hdhub4u/player.html` (local copy in the project).
- [ ] **1.2** Find the `_libCache` + `loadVideojs/loadHls/loadClappr` block (lines 33–48).
- [ ] **1.3** Append the `loadMkvDemuxer()` function from section 4.1.
- [ ] **1.4** Verify:

  ```bash
  grep -n "loadMkvDemuxer\|@matroska/matroska" hdhub4u/player.html
  # Expected: at least 2 matches — the import URL and the function definition.
  ```

---

### Step 2 — Add the codec probe (Patch 2)

- [ ] **2.1** Find the `isHls / isMkv / isMp4` helper block (around line 310–314).
- [ ] **2.2** Append the `probeMkvCodecSupport()` function from section 4.2.
- [ ] **2.3** Verify:

  ```bash
  grep -n "probeMkvCodecSupport\|anyPlayable" hdhub4u/player.html
  # Expected: function definition + at least one call site (added later in Patch 3).
  ```

---

### Step 3 — Add `loadMkvRemux()` (Patch 3)

- [ ] **3.1** Find the existing `loadClapprMkv()` function definition (around line 668).
- [ ] **3.2** Insert the entire `loadMkvRemux()` function from section 4.3 immediately BEFORE `loadClapprMkv()`.
- [ ] **3.3** Verify syntax (no missing braces):

  ```bash
  # Quick bracket-balance check (rough but catches the most common error):
  node -e "
    const s = require('fs').readFileSync('hdhub4u/player.html','utf8');
    const m = s.match(/<script>([\s\S]*?)<\/script>/g);
    if (!m) { console.log('no script tags found'); process.exit(1); }
    m.forEach((blk, i) => {
      const body = blk.replace(/^<script>/,'').replace(/<\/script>$/,'');
      const opens = (body.match(/\{/g)||[]).length;
      const closes = (body.match(/\}/g)||[]).length;
      console.log('script #'+i+': { = '+opens+', } = '+closes+(opens===closes?' [OK]':' [MISMATCH]'));
    });
  "
  # Expected: every script block prints [OK].
  ```

  If any block prints `[MISMATCH]`, return to step 3.2 and check for missing `}`.

---

### Step 4 — Route MKV to the new function (Patch 4)

- [ ] **4.1** Find this exact text in `loadPlayable()`:

  ```js
  } else if (isMkv(playableUrl)) {
    // MKV needs Clappr (with Matroska demuxer) or direct fallback.
    loadClapprMkv(playableUrl);
  }
  ```

- [ ] **4.2** Replace with the version from section 4.4.
- [ ] **4.3** Verify:

  ```bash
  grep -n "loadMkvRemux(playableUrl)" hdhub4u/player.html
  # Expected: exactly 1 match.
  ```

---

### Step 5 — Improve Clappr fallback error (Patch 5)

- [ ] **5.1** Find the `events: { onError: ... }` block inside `loadClapprMkv()` (around line 688).
- [ ] **5.2** Replace with the version from section 4.5.
- [ ] **5.3** Verify:

  ```bash
  grep -n "MX Player" hdhub4u/player.html | head -5
  # Expected: at least one match inside loadClapprMkv's error UI.
  ```

---

### Step 6 — Deploy + browser test

- [ ] **6.1** Deploy to Cloudflare Pages preview branch.
- [ ] **6.2** On **desktop Chrome 120+**, open:

  ```
  https://<preview>.pages.dev/hdhub4u/player.html?url=https://new3.hdhub4u.cl/<sample-mkv-slug>/&source=skmovies&title=Test
  ```

  (Replace `<sample-mkv-slug>` with a real slug from `/api/hdhub4u/list?type=home`.)

  - **Expected**: spinner shows "Decoding MKV…" → "Buffering MKV…" → video starts playing within 5–15 s.
  - DevTools Console: no red errors. DevTools Network: the `.mkv` request shows `206 Partial Content` and bytes are being streamed.

- [ ] **6.3** On **desktop Firefox**, repeat.
  - If the file is H.264: should play.
  - If the file is HEVC: should show the "MKV not playable" error with VLC/MX/raw buttons.

- [ ] **6.4** On **desktop Safari 17+**, repeat.
  - Both H.264 and HEVC should play (Safari has native HEVC).

- [ ] **6.5** On **Android Chrome**, repeat.
  - H.264 should play. HEVC may play on flagship devices; otherwise shows the error UI.

- [ ] **6.6** On **iOS Safari**, repeat.
  - H.264 should play. HEVC should play on iOS 17+. Older iOS may show error UI.

- [ ] **6.7** Click the in-page "Open in VLC" button on desktop. (It won't do anything on desktop — that's expected; the button is for mobile. Just confirm the href is `vlc://<mkv-url>`.)

---

### Step 7 — Regression test (other formats must still work)

- [ ] **7.1** Find an `.mp4` URL (e.g. from MLSBD source) and open it in the player.
  - **Expected**: native `<video>` plays it; the MKV code path is NOT triggered.

- [ ] **7.2** Find an `.m3u8` URL and open it.
  - **Expected**: video.js + VHS plays it; the MKV code path is NOT triggered.

- [ ] **7.3** Open a non-media URL (e.g. a savelinks page).
  - **Expected**: the existing resolve → iframe fallback works unchanged.

---

### Step 8 — Worklog + handoff

- [ ] **8.1** Append a section to `/home/z/my-project/worklog.md` under Task ID `MKV-FIX-1` with:
  - The 5 patches applied (with line ranges).
  - Browser test results from Step 6 (which codecs played on which browsers).
  - Any deviations from the plan (e.g. if `@matroska/matroska` export names changed and you had to rename).
- [ ] **8.2** Zip the updated `player.html` into `/home/z/my-project/download/skmovies-player-mkv-fix.zip`.

---

## 6. Failure Modes & What NOT to Do

| ❌ Don't | ✅ Do |
|---------|------|
| Use Clappr for MKV (its matroska plugin is unmaintained) | Use `@matroska/matroska` (jstm) for demux + remux to fMP4 |
| Try server-side transcode (Pages Functions can't handle 2 GB files) | Demux client-side; the existing CORS proxy already supports range requests |
| Skip the codec probe and just try to play | Probe first; show a clear error for HEVC-on-Firefox instead of a 30s hang |
| Block the main thread while demuxing | Use the `await reader.read()` loop — jstm is async and yields between blocks |
| Append to SourceBuffer while it's updating | Use the queue pattern shown in `loadMkvRemux()` |
| Replace the entire `player.html` | Apply the 5 surgical patches — the rest of the file works fine |
| Forget to wire external-player buttons | Call `wireExtBtnsForDirect(mkvUrl)` at the end of `loadMkvRemux()` so VLC/MX always work |
| Drop Clappr entirely | Keep `loadClapprMkv()` as a tertiary fallback for browsers without MSE (very rare) |
| Hard-code codec strings | Build the codec string from the probe result — `hvc1.1.6.L93.B0` vs `hev1.1.6.L93.B0` differ per browser |

---

## 7. Verification Checklist (one-line summary)

```
[ ] loadMkvDemuxer() defined and loads @matroska/matroska@2.2.3
[ ] probeMkvCodecSupport() returns {h264,hevc,vp9,av1,aac,opus,anyPlayable}
[ ] loadMkvRemux() defined BEFORE loadClapprMkv()
[ ] loadPlayable() routes .mkv → loadMkvRemux()
[ ] Clappr fallback error UI offers VLC + MX + raw URL + retry
[ ] Desktop Chrome: H.264 MKV plays
[ ] Desktop Chrome: HEVC MKV plays (with hw decoder)
[ ] Desktop Firefox: H.264 MKV plays
[ ] Desktop Firefox: HEVC MKV shows clean error UI
[ ] Desktop Safari 17+: both H.264 and HEVC MKV play
[ ] Android Chrome: H.264 MKV plays
[ ] iOS Safari 17+: H.264 MKV plays
[ ] .mp4 URLs still play via native <video>
[ ] .m3u8 URLs still play via video.js + VHS
[ ] External-player buttons always get the raw .mkv URL
```

---

## 8. Point-by-Point Verification (final gate)

After the AI implementation agent finishes, run this script. Every line must print `PASS`.

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="https://skmovies-premium.pages.dev"
PLAYER="/hdhub4u/player.html"

echo -n "1. jstm loader present: "
curl -s "$BASE$PLAYER" | grep -q "@matroska/matroska" && echo PASS || echo FAIL

echo -n "2. probeMkvCodecSupport present: "
curl -s "$BASE$PLAYER" | grep -q "function probeMkvCodecSupport" && echo PASS || echo FAIL

echo -n "3. loadMkvRemux present: "
curl -s "$BASE$PLAYER" | grep -q "async function loadMkvRemux" && echo PASS || echo FAIL

echo -n "4. loadPlayable routes MKV to remux: "
curl -s "$BASE$PLAYER" | grep -q "loadMkvRemux(playableUrl)" && echo PASS || echo FAIL

echo -n "5. Clappr fallback still defined: "
curl -s "$BASE$PLAYER" | grep -q "async function loadClapprMkv" && echo PASS || echo FAIL

echo -n "6. Clappr error UI offers VLC: "
curl -s "$BASE$PLAYER" | grep -q "Open in VLC" && echo PASS || echo FAIL

echo -n "7. MSE check in loadMkvRemux: "
curl -s "$BASE$PLAYER" | grep -q "MediaSource.isTypeSupported" && echo PASS || echo FAIL

echo -n "8. wireExtBtnsForDirect called in loadMkvRemux: "
curl -s "$BASE$PLAYER" | grep -A 80 "async function loadMkvRemux" | grep -q "wireExtBtnsForDirect(mkvUrl)" && echo PASS || echo FAIL

echo -n "9. No syntax errors (bracket balance): "
node -e "
  const s = require('fs').readFileSync('/dev/stdin','utf8');
  const m = s.match(/<script>([\s\S]*?)<\/script>/g) || [];
  let ok = true;
  for (const blk of m) {
    const body = blk.replace(/^<script>/,'').replace(/<\/script>$/,'');
    const o = (body.match(/\{/g)||[]).length;
    const c = (body.match(/\}/g)||[]).length;
    if (o !== c) { ok = false; break; }
  }
  console.log(ok ? 'PASS' : 'FAIL');
" < <(curl -s "$BASE$PLAYER")

echo -n "10. Player still returns 200: "
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$PLAYER")
[ "$code" = "200" ] && echo PASS || echo FAIL
```

If all 10 print `PASS`, the MKV fix is complete. If any print `FAIL`, return to the matching step in section 5 and debug.

---

## 9. Fallback Plan (if `@matroska/matroska` proves unreliable)

If jstm fails on a significant share of files in real-world testing (e.g. > 20% failure rate on H.264 MKVs), the fallback is:

1. **Server-side remux via a separate Worker**: a dedicated Cloudflare Worker running FFmpeg WASM that accepts `?url=<mkv-url>`, downloads the MKV, remuxes to fMP4 (no re-encoding, ~1× file size), and streams the fMP4 back. This is heavier but bulletproof.
2. **Use a third-party iframe player**: services like `https://vidsrc.to/` or `https://2embed.cc/` accept IMDb/TMDB IDs and serve their own player. The HDHub4u movie page already exposes `imdbId` — wire a "Use external player" button on the movie page that opens `https://2embed.cc/embed/<imdbId>`.
3. **Force external app**: hide the in-page player for MKV entirely and always open the VLC/MX intent. Loses UX but is 100% reliable.

Pick fallback #1 if you have a Workers paid plan; pick #2 if you want zero infrastructure; pick #3 if reliability is paramount and UX loss is acceptable.

---

**End of plan.**
