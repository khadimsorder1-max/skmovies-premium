var hostLib = require('./_host.js');
var resolveLiveHost = hostLib.resolveLiveHost;
var fetchUpstream = hostLib.fetchUpstream;
var json = hostLib.json;

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function onRequest(context) {
  var url = new URL(context.request.url);
  var slug = (url.searchParams.get('slug') || '').trim();
  var target = (url.searchParams.get('url') || '').trim();

  if (!slug && !target) {
    return json({ ok: false, error: 'Missing ?slug= or ?url= param' }, 200);
  }

  var env = context.env || {};
  var waitUntil = context.waitUntil ? context.waitUntil.bind(context) : null;

  try {
    if (!target && slug) {
      var host = await resolveLiveHost(env, waitUntil);
      var movieUrl = host.replace(/\/$/, '') + '/' + slug + '/';
      var r = await fetchUpstream(movieUrl);
      if (!r.ok) return json({ ok: false, error: 'Movie HTTP ' + r.status }, 200);
      var html = await r.text();
      var dlMatch = html.match(/<a[^>]+href="(https?:\/\/(gadgetsweb\.xyz|4khdhub\.one|hubcloud\.[a-z]+|gdflix\.[a-z]+|filepress\.[a-z]+|indexserver\.site|busycdn\.xyz)[^"]+)"/i);
      if (!dlMatch) return json({ ok: false, error: 'No downloadable stream link found' }, 200);
      target = dlMatch[1];
    }

    var resolved = await resolveDownloadHost(target);
    var directUrl = resolved.directUrl;
    var iframe = resolved.iframe;
    if (!directUrl && !iframe) {
      return json({ ok: false, error: 'Could not resolve a playable URL' }, 200);
    }

    var finalUrl = directUrl || iframe;
    var b64 = btoa(finalUrl).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    var proxyUrl = '/api/proxy?u=' + b64;
    var playerUrl = '/hdhub4u/player.html?url=' + encodeURIComponent(finalUrl) + '&source=skmovies';

    return json({
      ok: true,
      directUrl: directUrl || '',
      streamUrl: directUrl || '',
      externalUrl: iframe || '',
      proxyUrl: proxyUrl,
      playerUrl: playerUrl,
      mxIntent: 'intent:' + finalUrl + '#Intent;package=com.mxtech.videoplayer.ad;S.title=SKMovies;end',
      vlcUrl: 'vlc://' + finalUrl.replace(/^https?:\/\//, ''),
      kmIntent: 'intent:' + finalUrl + '#Intent;package=com.kmplayer;S.title=SKMovies;end',
      iframe: iframe || '',
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
      'Referer': 'https://hdhub4u.skin/',
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