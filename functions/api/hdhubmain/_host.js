// functions/api/hdhubmain/_host.js
// Dedicated HDHub Main Host Resolver (official lander: hdhub4u.med -> new3.hdhub4u.cl)

var KV_KEY = 'ACTIVE_HDHUBMAIN_HOST';
var KV_TTL = 3600;
var MEM_TTL_MS = 5 * 60 * 1000;
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var _memCache = { host: null, expiresAt: 0 };

function resolveLiveHost(env, waitUntil) {
  env = env || {};
  var now = Date.now();

  if (_memCache.host && now < _memCache.expiresAt) return Promise.resolve(_memCache.host);

  var host = 'https://new3.hdhub4u.cl/';
  _memCache = { host: host, expiresAt: now + MEM_TTL_MS };
  return Promise.resolve(host);
}

function json(obj, status, cacheSeconds) {
  status = status || 200;
  cacheSeconds = cacheSeconds || 30;
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=' + cacheSeconds,
    },
  });
}

module.exports = {
  resolveLiveHost: resolveLiveHost,
  json: json,
  UA: UA,
};
