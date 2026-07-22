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

function unpackDeanEdwards(code) {
  try {
    var m = code.match(/}\s*\(\s*'(.*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.*?)'\.split\('\|'\)/);
    if (!m) return '';
    var p = m[1];
    var a = parseInt(m[2], 10);
    var c = parseInt(m[3], 10);
    var k = m[4].split('|');
    function unbase(n) {
      return (n < a ? '' : unbase(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    }
    var count = c;
    while (count--) {
      if (k[count]) {
        var word = unbase(count);
        var re = new RegExp('\\b' + word + '\\b', 'g');
        p = p.replace(re, k[count]);
      }
    }
    return p;
  } catch(e) { return ''; }
}

async function resolveDownloadHost(target) {
  try {
    // 1. HDStream4U / Morencius Unpacker
    if (/hdstream4u\.com|morencius\.com/i.test(target)) {
      var embedUrl = target;
      if (target.includes('hdstream4u.com')) {
        var r1 = await fetch(target, { headers: { 'User-Agent': UA, 'Referer': 'https://new3.hdhub4u.cl/' } });
        if (r1.ok) {
          var html1 = await r1.text();
          var embedM = html1.match(/<iframe[^>]+src="(https?:\/\/morencius\.com\/embed\/[^"]+)"/i) || html1.match(/(https?:\/\/morencius\.com\/embed\/[^\s"']+)/i);
          if (embedM) embedUrl = embedM[1];
          else embedUrl = target.replace('/file/', '/embed/');
        }
      }

      var r2 = await fetch(embedUrl, { headers: { 'User-Agent': UA, 'Referer': 'https://hdstream4u.com/' } });
      if (r2.ok) {
        var html2 = await r2.text();
        var packedM = html2.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)\)\)/);
        if (packedM) {
          var unpacked = unpackDeanEdwards(packedM[0]);
          var m3u8Matches = [...unpacked.matchAll(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/gi)].map(function(m) { return m[1]; });
          var relMatches = [...unpacked.matchAll(/"\/stream\/[^"]+\.m3u8"/gi)].map(function(m) { return 'https://morencius.com' + m[0].replace(/"/g, ''); });
          var allM3u8 = m3u8Matches.concat(relMatches);
          if (allM3u8.length > 0) {
            return { directUrl: allM3u8[0], iframe: embedUrl, isDirectHls: true };
          }
        }
      }
    }


    // 2. Hubstream.art (Watch Player 2) - adfree sandbox embed
    if (/hubstream\.art/i.test(target)) {
      var cleanTarget = target.replace('/#', '/embed/');
      return { directUrl: cleanTarget, iframe: cleanTarget, adFreeEmbed: true };
    }

    // 3. Fallback generic fetch
    var r = await fetch(target, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Referer': 'https://new3.hdhub4u.cl/' },
      redirect: 'follow',
    });
    if (!r.ok) return { directUrl: target, iframe: null };
    var html = await r.text();
    var mediaMatch = html.match(/(https?:\/\/[^"'<>\s]+\.(?:mp4|mkv|webm|m3u8)(?:\?[^"'<>\s]*)?)/i);
    var directUrl = mediaMatch ? mediaMatch[1] : null;
    var hubcloudMatch = html.match(/href="(https?:\/\/hubcloud\.[^"]+)"/i) || html.match(/href="(https?:\/\/filepress\.[^"]+)"/i);
    if (hubcloudMatch && !directUrl) directUrl = hubcloudMatch[1];
    var iframeMatch = html.match(/<iframe[^>]+src="(https?:\/\/[^"]+)"/i);
    var iframe = iframeMatch ? iframeMatch[1] : null;

    return { directUrl: directUrl || target, iframe: iframe };
  } catch(e) {
    return { directUrl: target, iframe: null };
  }
}

