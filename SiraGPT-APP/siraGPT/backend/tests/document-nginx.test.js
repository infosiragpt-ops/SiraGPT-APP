'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-nginx');
const { extractNginx, buildNginxForFiles, renderNginxBlock, _internal } = engine;
const { isNginxLike } = _internal;

const NGINX_FIXTURE = `upstream backend {
  server 127.0.0.1:8080;
  server 127.0.0.1:8081;
}

server {
  listen 80;
  listen [::]:80;
  server_name example.com www.example.com;

  return 301 https://$server_name$request_uri;
}

server {
  listen 443 ssl http2;
  server_name example.com;

  ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers HIGH:!aNULL:!MD5;

  root /var/www/html;
  index index.html;

  access_log /var/log/nginx/access.log main;
  error_log /var/log/nginx/error.log warn;

  gzip on;
  gzip_types text/plain text/css application/json;

  limit_req zone=api burst=20 nodelay;

  location / {
    try_files $uri $uri/ /index.html;
  }

  location /api/ {
    proxy_pass http://backend;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  location ~ \\.php$ {
    return 404;
  }
}`;

test('empty / non-string tolerated', () => {
  assert.equal(extractNginx('').total, 0);
  assert.equal(extractNginx(null).total, 0);
});

test('non-Nginx text returns empty', () => {
  const r = extractNginx('Just regular text without nginx directives');
  assert.equal(r.total, 0);
});

test('isNginxLike heuristic', () => {
  assert.ok(isNginxLike('server { listen 80; }'));
  assert.ok(isNginxLike('proxy_pass http://x'));
  assert.ok(!isNginxLike('plain text'));
});

test('detects server blocks', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.totals.serverBlock >= 2);
});

test('detects upstream blocks', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'upstream' && e.name === 'backend'));
});

test('detects listen directives', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'listen' && /80/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'listen' && /443.*ssl/.test(e.name)));
});

test('detects server_name', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'serverName' && /example\.com/.test(e.name)));
});

test('detects location blocks', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'location' && e.name === '/'));
  assert.ok(r.entries.some((e) => e.kind === 'location' && e.name === '/api/'));
});

test('detects proxy_pass', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'proxyPass' && /backend/.test(e.name)));
});

test('detects SSL certificates', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'sslCert' && e.name === 'ssl_certificate'));
  assert.ok(r.entries.some((e) => e.kind === 'sslCert' && e.name === 'ssl_certificate_key'));
});

test('detects SSL options (protocols / ciphers)', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'sslOpt' && e.name === 'ssl_protocols'));
  assert.ok(r.entries.some((e) => e.kind === 'sslOpt' && e.name === 'ssl_ciphers'));
});

test('detects routing directives (root / index / try_files / return)', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'routing' && e.name === 'root'));
  assert.ok(r.entries.some((e) => e.kind === 'routing' && e.name === 'try_files'));
  assert.ok(r.entries.some((e) => e.kind === 'routing' && e.name === 'return'));
});

test('detects headers (proxy_set_header)', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'header' && e.name === 'proxy_set_header'));
});

test('detects compression (gzip)', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'compression' && e.name === 'gzip'));
});

test('detects rate limiting (limit_req)', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'rateLimit' && e.name === 'limit_req'));
});

test('detects logs (access_log / error_log)', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'log' && e.name === 'access_log'));
  assert.ok(r.entries.some((e) => e.kind === 'log' && e.name === 'error_log'));
});

test('dedupes identical locations', () => {
  const r = extractNginx('server {}\nlocation /a {}\nlocation /a {}');
  assert.equal(r.entries.filter((e) => e.kind === 'location' && e.name === '/a').length, 1);
});

test('caps entries per file', () => {
  let text = 'server {}\n';
  for (let i = 0; i < 50; i++) text += `location /path-${i} {}\n`;
  const r = extractNginx(text);
  assert.ok(r.entries.length <= 30);
});

test('counts totals by kind', () => {
  const r = extractNginx(NGINX_FIXTURE);
  assert.ok(r.totals.location >= 3);
  assert.ok(r.totals.listen >= 3);
});

test('buildNginxForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.conf', extractedText: 'server { listen 80; server_name a.com; }' },
    { name: 'b.conf', extractedText: 'upstream b { server 10.0.0.1; }' },
  ];
  const r = buildNginxForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderNginxBlock returns markdown when entries exist', () => {
  const files = [{ name: 'nginx.conf', extractedText: NGINX_FIXTURE }];
  const r = buildNginxForFiles(files);
  const md = renderNginxBlock(r);
  assert.match(md, /^## NGINX/);
});

test('renderNginxBlock empty when nothing surfaces', () => {
  assert.equal(renderNginxBlock({ perFile: [] }), '');
  assert.equal(renderNginxBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildNginxForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: NGINX_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
