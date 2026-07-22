// functions/sitemap.xml.js — dynamically generated sitemap (Issue #59)
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const baseUrl = url.origin;

  // Fetch latest movies from both sources
  const [mlsbdRes, fdmRes] = await Promise.all([
    fetch(`${baseUrl}/api/latest?page=1&adult=1`).catch(() => null),
    fetch(`${baseUrl}/api/fdm/latest`).catch(() => null),
  ]);

  const mlsbdData = mlsbdRes?.ok ? await mlsbdRes.json() : { items: [] };
  const fdmData = fdmRes?.ok ? await fdmRes.json() : { items: [] };

  const urls = [
    { loc: `${baseUrl}/`, priority: '1.0', changefreq: 'daily' },
    { loc: `${baseUrl}/?view=trending`, priority: '0.8', changefreq: 'daily' },
    { loc: `${baseUrl}/?view=south`, priority: '0.7', changefreq: 'weekly' },
    { loc: `${baseUrl}/?view=south-hindi`, priority: '0.7', changefreq: 'weekly' },
    { loc: `${baseUrl}/?view=favs`, priority: '0.3', changefreq: 'monthly' },
  ];

  // Add movie URLs
  (mlsbdData.items || []).forEach((m) => {
    urls.push({
      loc: `${baseUrl}/?movie=${encodeURIComponent(m.slug)}`,
      priority: '0.9',
      changefreq: 'weekly',
      lastmod: m.uploadDate,
    });
  });
  (fdmData.items || []).forEach((m) => {
    urls.push({
      loc: `${baseUrl}/?movie=${encodeURIComponent(m.slug)}&source=fdm`,
      priority: '0.9',
      changefreq: 'weekly',
    });
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${escapeXml(u.loc)}</loc>
    <priority>${u.priority}</priority>
    <changefreq>${u.changefreq}</changefreq>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}
  </url>`).join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=21600',
    },
  });
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  })[c]);
}
