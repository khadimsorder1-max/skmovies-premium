// functions/api/notice.js
// Reverse-engineered from https://skmovies-premium.pages.dev/api/notice
//
// Returns a static list of upcoming/featured releases. In the live deployment this
// is likely hard-coded in the backend or read from a KV store — we mirror the
// observed values as defaults but allow overriding via the NOTICES KV namespace
// or environment variable.

const DEFAULT_NOTICES = [
  'Six #iScreen - Eid2026',
  'Chokro2 #iScreen - Eid2026',
  'Cactus #Chorki - Eid2026',
  'ThakumarJhuli: S01 #Hoichoi - 20th March',
];

export async function onRequest(context) {
  // Cloudflare Pages Functions expose env bindings via context.env
  const { env } = context;
  let items = DEFAULT_NOTICES;
  try {
    if (env?.NOTICES_KV) {
      const raw = await env.NOTICES_KV.get('notices');
      if (raw) items = JSON.parse(raw);
    } else if (env?.NOTICES_JSON) {
      items = JSON.parse(env.NOTICES_JSON);
    }
  } catch (_) { /* fall back to defaults */ }

  return new Response(JSON.stringify({ ok: true, items }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
