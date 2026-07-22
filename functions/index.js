// functions/index.js — handles root requests with ?movie= param for SSR/OG tag injections (Issue #42)
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // If it's a request for a file/api or doesn't have the ?movie= param, fall through
  if (url.pathname !== '/' || !url.searchParams.has('movie')) {
    return env.ASSETS ? await env.ASSETS.fetch(request) : fetch(request);
  }

  const slug = url.searchParams.get('movie');
  const source = url.searchParams.get('source') || 'mlsbd';

  // Fetch movie data from local API endpoint using origin
  const apiUrl = `${url.origin}/api/${source === 'fdm' ? 'fdm/' : ''}movie?slug=${encodeURIComponent(slug)}`;

  let movieData = null;
  try {
    const r = await fetch(apiUrl, { headers: { Accept: 'application/json' } });
    if (r.ok) movieData = await r.json();
  } catch (err) {
    console.error('SSR fetch error:', err);
  }

  // Fetch static index.html
  let html = '';
  try {
    const staticResponse = env.ASSETS 
      ? await env.ASSETS.fetch(new Request(url.origin + '/', request))
      : await fetch(new Request(url.origin + '/', request));
    html = await staticResponse.text();
  } catch (err) {
    return new Response('Error loading template', { status: 500 });
  }

  if (movieData) {
    const title = movieData.title || 'SKMovies';
    const poster = movieData.poster || `${url.origin}/assets/og-image.webp`;
    const description = movieData.info?.storyline || movieData.info?.genre || 'Watch on SKMovies';
    const canonicalUrl = `${url.origin}/?movie=${encodeURIComponent(slug)}${source === 'fdm' ? '&source=fdm' : ''}`;

    // Clean html template metadata tags
    html = html.replace(
      /<title>[^<]*<\/title>/,
      `<title>${escapeHtmlAttr(title)} — SKMovies</title>`
    );

    html = html.replace(
      /<meta property="og:title"[^>]*>/,
      `<meta property="og:title" content="${escapeHtmlAttr(title)} — SKMovies" />`
    );
    html = html.replace(
      /<meta property="og:description"[^>]*>/,
      `<meta property="og:description" content="${escapeHtmlAttr(description)}" />`
    );
    html = html.replace(
      /<meta property="og:image"[^>]*>/,
      `<meta property="og:image" content="${escapeHtmlAttr(poster)}" />`
    );
    html = html.replace(
      /<meta property="og:url"[^>]*>/,
      `<meta property="og:url" content="${escapeHtmlAttr(canonicalUrl)}" />`
    );
    html = html.replace(
      /<meta property="og:type"[^>]*>/,
      `<meta property="og:type" content="video.movie" />`
    );

    html = html.replace(
      /<meta name="twitter:title"[^>]*>/,
      `<meta name="twitter:title" content="${escapeHtmlAttr(title)} — SKMovies" />`
    );
    html = html.replace(
      /<meta name="twitter:image"[^>]*>/,
      `<meta name="twitter:image" content="${escapeHtmlAttr(poster)}" />`
    );

    // Canonical link
    if (!html.includes('rel="canonical"')) {
      html = html.replace('</head>', `<link rel="canonical" href="${escapeHtmlAttr(canonicalUrl)}" />\n</head>`);
    } else {
      html = html.replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${escapeHtmlAttr(canonicalUrl)}" />`);
    }

    // Add JSON-LD structured data (Issue #60)
    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "Movie",
      "name": title,
      "image": poster,
      "description": description,
      ...(movieData.info?.year ? { "datePublished": movieData.info.year } : {}),
      ...(movieData.info?.director ? { "director": { "@type": "Person", "name": movieData.info.director } } : {}),
      ...(movieData.info?.cast ? { "actor": movieData.info.cast.map(name => ({ "@type": "Person", "name": name })) } : {}),
      ...(movieData.info?.imdbRating ? { "aggregateRating": { "@type": "AggregateRating", "ratingValue": movieData.info.imdbRating.replace(/[^0-9.]/g, '') } } : {}),
    };
    html = html.replace('</head>', `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>\n</head>`);
  }

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=300',
    },
  });
}

function escapeHtmlAttr(s) {
  return String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
