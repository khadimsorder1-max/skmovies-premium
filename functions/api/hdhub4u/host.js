/**
 * GET /api/hdhub4u/host
 * ---------------------
 * Returns the currently active HDHub4u mirror URL.
 *
 * The HDHub4u network rotates mirrors frequently. The landing page
 * hdhub4u.med embeds a JS that races several "host resolver" CDNs and
 * redirects to whichever mirror is currently live. We replicate that
 * logic here so the front-end always knows which mirror to display.
 *
 * Cache layers (per requirement #5 — no extra Worker requests):
 *   1. In-isolate memory cache (5 min TTL)
 *   2. Cloudflare KV          (6h TTL, cross-region)
 *   3. Cloudflare Cache API   (6h TTL, edge)
 *   4. Fresh probe of landing page + resolvers race
 *
 * Response:
 *   {
 *     "host":     "https://new3.hdhub4u.cl/",
 *     "landing":  "https://hdhub4u.med",
 *     "resolvers":[ "https://h4.suncdn.org/host/", ... ],
 *     "cached":   true,
 *     "ts":       1784318447000
 *   }
 */
const {
  resolveActiveHost,
  jsonResponse,
  HOST_RESOLVERS,
  LANDING_PAGE,
  setEnv,
  setWaitUntil,
} = require('./_lib.js');

export async function onRequestGet(ctx) {
  // Wire env + waitUntil into shared lib so other helpers can use them.
  setEnv(ctx.env || {});
  if (ctx.waitUntil) setWaitUntil(ctx.waitUntil.bind(ctx));

  try {
    const host = await resolveActiveHost();
    return jsonResponse({
      host,
      landing: LANDING_PAGE,
      resolvers: HOST_RESOLVERS,
      cached: false,
      ts: Date.now(),
    });
  } catch (e) {
    return jsonResponse(
      { error: 'Failed to resolve host', message: String(e && e.message || e) },
      502
    );
  }
}
