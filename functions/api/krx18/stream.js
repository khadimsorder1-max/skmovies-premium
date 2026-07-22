var hostLib = require('./_host.js');
var json = hostLib.json;

export async function onRequest(context) {
  var url = new URL(context.request.url);
  var target = (url.searchParams.get('url') || '').trim();

  if (!target) return json({ ok: false, error: 'Missing ?url= param' }, 200);

  return json({
    ok: true,
    directUrl: target,
    streamUrl: target,
    externalUrl: target,
    iframe: target,
    ts: Date.now(),
  }, 200, 60);
}
