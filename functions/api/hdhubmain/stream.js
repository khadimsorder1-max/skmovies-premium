var hostLib = require('./_host.js');
var json = hostLib.json;
var UA = hostLib.UA;

export async function onRequest(context) {
  var url = new URL(context.request.url);
  var target = (url.searchParams.get('url') || '').trim();

  if (!target) return json({ ok: false, error: 'Missing ?url= param' }, 200);

  try {
    var resolved = await resolveDownloadHost(target);
    var directUrl = resolved.directUrl || target;
    var iframe = resolved.iframe || '';

    var b64 = btoa(directUrl).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    var proxyUrl = '/api/proxy?u=' + b64;
    var playerUrl = '/hdhub4u/player.html?url=' + encodeURIComponent(directUrl) + '&source=skmovies';

    return json({
      ok: true,
      directUrl: directUrl,
      streamUrl: directUrl,
      externalUrl: iframe || directUrl,
      proxyUrl: proxyUrl,
      playerUrl: playerUrl,
      mxIntent: 'intent:' + directUrl + '#Intent;package=com.mxtech.videoplayer.ad;S.title=SKMovies;end',
      vlcUrl: 'vlc://' + directUrl.replace(/^https?:\/\//, ''),
      kmIntent: 'intent:' + directUrl + '#Intent;package=com.kmplayer;S.title=SKMovies;end',
      iframe: iframe,
      ts: Date.now(),
    }, 200, 60);
  } catch (e) {
    return json({ ok: false, error: e.message }, 200);
  }
}

function resolveDownloadHost(target) {
  return fetch(target, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://new3.hdhub4u.cl/',
    },
    redirect: 'follow',
  }).then(function(r) {
    if (!r.ok) return { directUrl: target, iframe: null };
    return r.text().then(function(html) {
      var mediaMatch = html.match(/(https?:\/\/[^"'<>\s]+\.(?:mp4|mkv|webm|m3u8)(?:\?[^"'<>\s]*)?)/i);
      var directUrl = mediaMatch ? mediaMatch[1] : null;

      var hubcloudMatch = html.match(/href="(https?:\/\/hubcloud\.[^"]+)"/i) || html.match(/href="(https?:\/\/filepress\.[^"]+)"/i);
      if (hubcloudMatch && !directUrl) directUrl = hubcloudMatch[1];

      var iframeMatch = html.match(/<iframe[^>]+src="(https?:\/\/[^"]+)"/i);
      var iframe = iframeMatch ? iframeMatch[1] : null;

      return { directUrl: directUrl || target, iframe: iframe };
    });
  }).catch(function() {
    return { directUrl: target, iframe: null };
  });
}
