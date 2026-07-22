# External Player Integration — `intent://` + `vlc://` deep dive

The HDHub4u+ module lets users tap a button on your site and have the
stream open directly in **MX Player**, **VLC**, or **KMPlayer** — no
copy-paste required. This document explains how each works, how to
customise them, and how to troubleshoot when they don't.

Per requirement #3: *"External player eo jeno play hoy mathai rekho."*

---

## How `intent://` URLs work (MX Player / KMPlayer)

Android Chrome (and most other Android browsers) understand a special
URL scheme called `intent://`. When the browser navigates to such a
URL, instead of fetching it like a normal HTTP URL, it:

1. Parses the URL into an Android `Intent` object.
2. Looks at the `package` parameter to find the target app.
3. If the app is installed, hands the Intent to it.
4. If the app is not installed, looks for a `browser_fallback_url`
   parameter and navigates to that. If there's no fallback, the
   browser shows "No app found to handle this URL".

The syntax is:

```
intent://<host>/<path>?<query>#Intent;package=<app-package>;S.<extra-key>=<extra-value>;end
```

- The part between `intent://` and `#Intent;` is the **data URL** —
  the URL of the video that MX Player should play.
- `package=com.mxtech.videoplayer.ad` — the free version's package
  name. Use `com.mxtech.videoplayer.pro` for the Pro version.
- `S.<key>=<value>` — string extras passed to the Intent. MX Player
  reads `S.title` as the video title shown in the player UI.

### Example

```
intent://hubstream-cdn.example.com/avatars3.mp4#Intent;package=com.mxtech.videoplayer.ad;S.title=Avatar%20Fire%20and%20Ash;end
```

This tells Android: "Open MX Player (free) and play the video at
`https://hubstream-cdn.example.com/avatars3.mp4`, with the
title 'Avatar Fire and Ash'."

Note that the `https://` scheme prefix is **stripped** — only the
host + path + query goes between `intent://` and `#Intent;`. This
is an Android quirk; the player re-adds `https://` automatically.

---

## How `vlc://` URLs work

VLC on Android and iOS registers the `vlc://` URL scheme. Unlike
`intent://`, VLC expects the **full** URL including the `https://`
prefix:

```
vlc://https://hubstream-cdn.example.com/avatars3.mp4
```

Tapping this on Android / iOS with VLC installed will hand the URL
to VLC, which then opens the network stream.

On desktop, VLC doesn't register `vlc://` — users have to copy the
URL and use VLC's "Open Network Stream" dialog manually.

---

## What the HDHub4u+ module does

When you click the **▶ MX** / **▶ VLC** / **▶ KM** button, the
front-end calls:

```js
const info = await api.resolveStream(playerUrl);
// info.mxIntent  -> "intent://…#Intent;package=com.mxtech.videoplayer.ad;…;end"
// info.vlcUrl    -> "vlc://https://…"
// info.kmIntent  -> "intent://…#Intent;package=com.kmplayer;…;end"
// info.externalUrl -> "https://…" (raw URL)
```

The server-side `/api/hdhub4u/stream?mode=direct` endpoint:

1. Fetches the player page (e.g. `https://hubstream.art/embed/<id>`).
2. Parses the HTML for direct video URLs (`.mp4`, `.m3u8`, `.mkv`).
3. If found, builds the three external-player URLs + the raw URL.
4. Returns them in the JSON response.

The front-end sets them as the `href` of `<a>` tags. When the user
taps a link on Android, the browser hands the Intent to MX Player
/ KMPlayer. On iOS, the VLC link opens VLC. On desktop, the raw
URL link starts a download.

---

## Player support matrix

| Player     | Android | iOS    | Desktop | URL scheme                       |
|------------|---------|--------|---------|----------------------------------|
| MX Player  | ✓ (free / Pro) | ✗ | ✗       | `intent://…#Intent;package=com.mxtech.videoplayer.ad;…;end` |
| MX Player Pro | ✓ | ✗    | ✗       | Same, with `package=com.mxtech.videoplayer.pro` |
| KMPlayer   | ✓       | ✗      | ✗       | `intent://…#Intent;package=com.kmplayer;…;end` |
| VLC        | ✓       | ✓ (3.x+) | ✗ (manual) | `vlc://https://…` |
| Raw URL    | ✓       | ✓      | ✓       | (no scheme — direct download) |

---

## MX Player's URL support

MX Player can play:

| Format                       | Example                                              | Notes                                |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------ |
| Direct `.mp4` / `.mkv`       | `https://example.com/movie.mp4`                      | Best — seekable, fast                |
| HLS `.m3u8`                 | `https://example.com/master.m3u8`                    | Adaptive streaming — recommended     |
| DASH `.mpd`                  | `https://example.com/stream.mpd`                     | Supported in MX Player 1.20+         |
| Google Drive file ID         | `https://drive.google.com/uc?export=download&id=...` | Works but rate-limited by Google     |
| YouTube                      | `https://youtube.com/watch?v=...`                    | MX Player has a built-in YT extractor|

**Not supported** (will fail to open):

- Player pages that require JavaScript to construct the stream URL
  (e.g. some ad-heavy sites that wrap the stream in a JS obfuscation
  layer) — but our resolver handles this server-side
- Encrypted streams (Widevine, FairPlay) — MX Player is not a DRM
  client
- RTMP / RTSP live streams (mostly)

If the resolver can't find a direct URL, the `mxIntent` field is
empty and the front-end falls back to opening the iframe player
inside the sandbox.

---

## Customising the Intent

### Switch to MX Player Pro

Edit `functions/api/hdhub4u/stream.js`, find the `buildResponse()`
function and change the package:

```js
const MX_PACKAGE = 'com.mxtech.videoplayer.pro';  // instead of .ad
```

Or for both MX Player variants, you can build two intents and let
the UI show both buttons.

### Pass a custom title

```js
const title = encodeURIComponent(movie.title || 'HDHub4u');
const mxIntent = `intent://${u.host}${u.pathname}${u.search}` +
                 `#Intent;package=${MX_PACKAGE};S.title=${title};end`;
```

### Add a browser fallback URL

If MX Player isn't installed, Android will navigate to the fallback
URL. Add this to the Intent:

```js
const fallback = encodeURIComponent('https://play.google.com/store/apps/details?id=com.mxtech.videoplayer.ad');
const mxIntent = `intent://${u.host}${u.pathname}${u.search}` +
                 `#Intent;package=${MX_PACKAGE};S.title=${title};` +
                 `S.browser_fallback_url=${fallback};end`;
```

### Add a "Download with MX Player" button

MX Player can also download the file for offline viewing. Add the
`S.download=true` extra:

```js
const mxIntent = `intent://${u.host}${u.pathname}${u.search}` +
                 `#Intent;package=${MX_PACKAGE};S.title=${title};S.download=true;end`;
```

---

## Detecting Android / MX Player on the front-end

If you want to show the MX Player button **only** on Android devices
where MX Player is installed, you can use User-Agent detection
(JavaScript cannot directly check if an app is installed for security
reasons):

```js
const isAndroid = /android/i.test(navigator.userAgent);
const isIOS     = /iPad|iPhone|iPod/.test(navigator.userAgent);

// Show MX + KM buttons only on Android
document.getElementById('mx-btn').style.display = isAndroid ? 'inline-flex' : 'none';
document.getElementById('km-btn').style.display = isAndroid ? 'inline-flex' : 'none';

// Show VLC button on Android + iOS
document.getElementById('vlc-btn').style.display = (isAndroid || isIOS) ? 'inline-flex' : 'none';

// Always show the raw-URL button (works everywhere as a download)
document.getElementById('ext-btn').style.display = 'inline-flex';
```

For non-Android devices, the same URL becomes a regular download
link — clicking it downloads the `.mp4` file. This is useful for
desktop users who want to save the file and play it in VLC or MPC.

---

## Using VLC instead of MX Player

VLC on Android uses a different scheme: `vlc://`. To open a stream
in VLC:

```js
const vlcUrl = 'vlc://' + playableUrl;
```

(Note: VLC's URL scheme requires the full `https://` prefix, unlike
MX Player's `intent://` which strips it.)

You can offer both buttons:

```html
<a id="mx-btn"  href="#">MX Player</a>
<a id="vlc-btn" href="#">VLC</a>
<a id="km-btn"  href="#">KMPlayer</a>
```

```js
api.resolveStream(playerUrl).then((info) => {
  if (info.mxIntent) {
    document.getElementById('mx-btn').href = info.mxIntent;
  }
  if (info.kmIntent) {
    document.getElementById('km-btn').href = info.kmIntent;
  }
  if (info.vlcUrl) {
    document.getElementById('vlc-btn').href = info.vlcUrl;
  }
});
```

---

## iOS support

iOS does **not** support `intent://` URLs. iOS users have these options:

1. **Open in VLC for iOS** — VLC iOS registers the `vlc://` scheme.
   Use the same `vlc://` URL as Android.

2. **Use the in-page ad-free player** — the HDHub4u+ module
   includes `/player.html` which uses Video.js + hls.js. HLS streams
   play natively on iOS Safari (no plugin needed). MP4 / WebM play
   natively too. MKV is not supported on iOS browsers — use VLC.

3. **Download and "Open In…"** — set the `<a download>` attribute
   and iOS will offer to open the file in any installed video app
   (VLC, Infuse, PlayerXtreme, nPlayer, etc.).

---

## Troubleshooting

### "The button does nothing when I tap it"

**Cause 1:** The `mxIntent` field is empty (resolver couldn't find a
direct URL). Check the network tab — the `/api/hdhub4u/stream`
response should have `mxIntent: "intent://…"`. If it's empty, the
upstream player page changed and the regexes in `stream.js` need
updating.

**Cause 2:** You're not on Android. `intent://` URLs are silently
ignored on iOS and desktop browsers. The VLC button works on iOS,
and the raw-URL button works everywhere.

**Cause 3:** The app is not installed. Add the
`S.browser_fallback_url=…` extra (see above) to redirect to the
Play Store.

### "MX Player opens but shows 'Cannot play this URL'"

The URL MX Player received is not a directly playable format.
Common causes:

- The URL is a player page (`https://hubstream.art/#abc`), not a
  video file. The resolver should have followed the redirect —
  check the `iframe` field in the JSON response. If `iframe` is
  the same as the input URL, the resolver couldn't follow it.
- The URL is encrypted / DRM-protected. No client-side fix is
  possible.
- The URL is geo-blocked. Try fetching from a different Cloudflare
  Pages region (Workers can run in different colos — there's no
  direct way to pin a region, but deploying to a Workers Paid plan
  gives you more control).

### "MX Player opens but the video stutters"

The stream is probably HLS (`.m3u8`). MX Player handles HLS but
it's CPU-intensive on older devices. Try a lower quality — pick a
`480p` or `720p` download link instead of `4K`.

Alternatively, use VLC — its HLS demuxer is more efficient on
older devices.

### "VLC button doesn't open VLC"

Make sure VLC is installed and registered the `vlc://` URL scheme.

- **Android:** VLC registers `vlc://` automatically on install.
- **iOS:** You need VLC 3.x or newer.
- **Desktop:** VLC doesn't register `vlc://` on desktop. Use the
  raw URL button instead and paste it into VLC's "Open Network
  Stream" dialog (Ctrl+N).

### "KMPlayer button doesn't open KMPlayer"

KMPlayer's package name is `com.kmplayer`. If you have a different
variant installed (e.g. KMPlayer Pro), check the actual package
name in Android Settings → Apps → KMPlayer → App info. Update the
`buildResponse()` function in `stream.js` accordingly.

### "Can I make this work without server-side resolution?"

No — the player pages use JavaScript to construct the stream URL,
and that JavaScript often depends on cookies / referer headers that
browsers don't let you forge client-side. The server-side resolver
in `/api/hdhub4u/stream` is necessary.

You could cache resolved URLs in `localStorage` to skip the
resolution step on subsequent plays of the same movie — and that's
exactly what the front-end client does (24h TTL by default):

```js
async function resolveWithCache(playerUrl) {
  const cacheKey = 'hdhub4u:stream:' + playerUrl;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }
  const info = await api.resolveStream(playerUrl);
  localStorage.setItem(cacheKey, JSON.stringify(info));
  return info;
}
```

The HDHub4uClient class already does this automatically. Cache TTL:
24 hours is reasonable. Stream URLs typically don't change that
fast. The server side also caches for 7 days in KV / Cache API, so
even a cache-miss on the client is fast.
