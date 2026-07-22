#!/usr/bin/env node
/**
 * Local dev server that serves /home/z/my-project/skmovies-v3.5/ static files
 * AND proxies /api/* to the production backend at skmovies-premium.pages.dev.
 *
 * Usage:
 *   node /home/z/my-project/scripts/dev_server.js
 *   # then open http://localhost:8099/
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = '/home/z/my-project/skmovies-v3.5';
const PORT = 8099;
const UPSTREAM = 'https://skmovies-premium.pages.dev';

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Proxy /api/* to upstream, BUT /api/cache gets special handling:
  // map it to the right /api/<src>/<path> endpoint on upstream.
  if (url.pathname.startsWith('/api/')) {
    let upPath = req.url;

    // Special: rewrite /api/cache?src=X&path=Y&page=Z[&slug=W] to /api/<X>/<Y>?page=Z[&slug=W]
    if (url.pathname === '/api/cache') {
      const src = url.searchParams.get('src') || 'mlsbd';
      let path = url.searchParams.get('path') || 'latest';
      const page = url.searchParams.get('page') || '1';
      const slug = url.searchParams.get('slug') || '';
      const adult = url.searchParams.get('adult') || '';
      const q = url.searchParams.get('q') || '';
      if (path === 'home') path = 'latest';

      let newPath;
      const params = new URLSearchParams();
      if (page) params.set('page', page);
      if (slug) params.set('slug', slug);
      if (q) params.set('q', q);
      if (adult) params.set('adult', adult);

      if (path === 'movie') newPath = src === 'mlsbd' ? '/api/movie' : `/api/${src}/movie`;
      else if (path === 'category') newPath = src === 'mlsbd' ? '/api/category' : `/api/${src}/category`;
      else if (path === 'trending') newPath = src === 'mlsbd' ? '/api/trending' : `/api/${src}/trending`;
      else if (path === 'latest') newPath = src === 'mlsbd' ? '/api/latest' : `/api/${src}/latest`;
      else newPath = `/api/${src}/${path}`;

      // HDHub uses /list?type= instead of /latest
      if ((src === 'hdhub4u' || src === 'hdhubmain') && (path === 'latest' || path === 'home')) {
        newPath = `/api/${src}/list`;
        params.set('type', 'home');
      }
      if ((src === 'hdhub4u' || src === 'hdhubmain') && path === 'category') {
        newPath = `/api/${src}/list`;
        params.set('type', 'category');
      }
      // moviebox: latest maps to trending
      if (src === 'moviebox' && path === 'latest') {
        newPath = '/api/moviebox/trending';
      }

      upPath = newPath + (params.toString() ? '?' + params.toString() : '');
    }

    const proxyReq = https.request({
      method: req.method,
      hostname: 'skmovies-premium.pages.dev',
      path: upPath,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Host': 'skmovies-premium.pages.dev',
      },
    }, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      delete headers['access-control-allow-origin'];
      headers['access-control-allow-origin'] = '*';
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    req.pipe(proxyReq);
    return;
  }

  // Serve static files
  let filePath = path.join(ROOT, url.pathname);
  if (url.pathname === '/' || !fs.existsSync(filePath)) {
    filePath = path.join(ROOT, 'index.html');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + url.pathname);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Dev server: http://localhost:${PORT}/`);
  console.log(`Static root: ${ROOT}`);
  console.log(`API proxy: ${UPSTREAM}/api/*`);
});
