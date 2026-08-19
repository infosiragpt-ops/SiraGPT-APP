'use strict';

const test = require('node:test');
const assert = require('node:assert');

const nginx = require('../src/services/hosting/nginx.service');

test('safeDomain validates + normalizes', () => {
  assert.equal(nginx.safeDomain('https://Foo.com/path'), 'foo.com');
  assert.throws(() => nginx.safeDomain('bad domain!'), /inválido/i);
  assert.throws(() => nginx.safeDomain('a..b'), /inválido/i);
});

test('buildStaticConfig has root + SPA fallback', () => {
  const cfg = nginx.buildStaticConfig('x.com', '/var/www/x.com');
  assert.match(cfg, /server_name x\.com www\.x\.com;/);
  assert.match(cfg, /root \/var\/www\/x\.com;/);
  assert.match(cfg, /try_files \$uri \$uri\/ \/index\.html;/);
});

test('buildProxyConfig proxies to the port', () => {
  const cfg = nginx.buildProxyConfig('x.com', 3000);
  assert.match(cfg, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
})

test('staticSetupCommand installs nginx + writes config (base64) + reloads', () => {
  const cmd = nginx.staticSetupCommand({ domain: 'x.com', webroot: '/var/www/x.com' });
  assert.match(cmd, /command -v nginx/);
  assert.match(cmd, /base64 -d > "\/etc\/nginx\/sites-available\/\$DOMAIN"/);
  assert.match(cmd, /nginx -t/);
  assert.ok(!/certbot/.test(cmd), 'no certbot without ssl');
})

test('proxySetupCommand with ssl adds certbot', () => {
  const cmd = nginx.proxySetupCommand({ domain: 'x.com', port: 4000, ssl: true, email: 'me@x.com' });
  assert.match(cmd, /certbot --nginx -d "\$DOMAIN"/);
  assert.match(cmd, /me@x\.com/);
})
