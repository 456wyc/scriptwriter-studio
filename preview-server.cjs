'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve('e:/xspace/scriptwriter/src/renderer');
const landingRoot = path.resolve('e:/xspace/scriptwriter/docs');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};
http.createServer((req, res) => {
  const clean = decodeURIComponent((req.url || '/').split('?')[0]);
  const isLanding = clean === '/landing' || clean === '/landing/' || clean.startsWith('/landing/');
  const base = isLanding ? landingRoot : root;
  const rel = isLanding
    ? (clean.replace(/^\/landing\/?/, '') || 'index.html')
    : (clean === '/' ? 'index.html' : clean.replace(/^\/+/, ''));
  const file = path.resolve(base, rel);
  if (!file.startsWith(base)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}).listen(8123, '127.0.0.1');
