'use strict';

/**
 * hosting/nginx.service — generate an nginx server block + the (idempotent)
 * remote shell command to install/enable it on a VPS over SSH. Makes the
 * "Rasta A (VPS)" path actually serve the site at a domain:
 *   static → serve files from a web root (with SPA fallback)
 *   node   → reverse-proxy the domain to the app's local port
 * Optional Let's Encrypt SSL via certbot (best-effort).
 */

const DOMAIN_RE = /^[a-z0-9.-]+$/i;

function safeDomain(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d || !DOMAIN_RE.test(d) || d.includes('..')) {
    const e = new Error('Dominio inválido para nginx');
    e.status = 400;
    e.code = 'invalid_domain';
    throw e;
  }
  return d;
}

function buildStaticConfig(domain, webroot) {
  return `server {
    listen 80;
    listen [::]:80;
    server_name ${domain} www.${domain};
    root ${webroot};
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
    location ~* \\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$ { expires 7d; access_log off; }
}
`;
}

function buildProxyConfig(domain, port) {
  const p = Number(port) || 3000;
  return `server {
    listen 80;
    listen [::]:80;
    server_name ${domain} www.${domain};
    location / {
        proxy_pass http://127.0.0.1:${p};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
`;
}

function shellSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the remote command that installs nginx (if missing), writes + enables
 * the server block and reloads nginx. The config is base64-encoded so quoting
 * never breaks. `ssl` adds a best-effort certbot run.
 */
function setupCommand({ domain, config, ssl = false, email } = {}) {
  const d = safeDomain(domain);
  const b64 = Buffer.from(config, 'utf8').toString('base64');
  const certEmail = email && /^[^@\s]+@[^@\s]+$/.test(email) ? email : `admin@${d}`;
  const lines = [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    `DOMAIN=${shellSingleQuote(d)}`,
    'command -v nginx >/dev/null 2>&1 || { apt-get update -y && apt-get install -y nginx; }',
    'mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled',
    `printf %s ${shellSingleQuote(b64)} | base64 -d > "/etc/nginx/sites-available/$DOMAIN"`,
    `ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"`,
    'rm -f /etc/nginx/sites-enabled/default',
    'nginx -t',
    // Free port 80 from the most common conflict (Apache) so nginx can bind it.
    'if systemctl is-active --quiet apache2 2>/dev/null; then echo "[nginx] apache2 ocupa el puerto 80 — deteniéndolo"; systemctl stop apache2 || true; systemctl disable apache2 || true; fi',
    // Start nginx (it may be installed-but-stopped; reload won\'t work then).
    'systemctl enable nginx >/dev/null 2>&1 || true',
    'if ! (systemctl restart nginx 2>/dev/null || service nginx restart 2>/dev/null); then echo "[nginx] ERROR: nginx no pudo iniciar. El puerto 80 lo ocupa:"; (ss -ltnp 2>/dev/null | grep ":80 " || lsof -i:80 2>/dev/null || true); echo "[nginx] Detén ese servicio (o úsalo) y vuelve a publicar."; exit 1; fi',
    'echo "[nginx] nginx activo en el puerto 80"',
  ];
  if (ssl) {
    lines.push(
      `command -v certbot >/dev/null 2>&1 || apt-get install -y certbot python3-certbot-nginx`,
      `certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos -m ${shellSingleQuote(certEmail)} --redirect || echo "[nginx] certbot skipped (DNS may not be ready yet)"`,
    );
  }
  return lines.join('\n');
}

/** Convenience: full command for a static web root. */
function staticSetupCommand({ domain, webroot, ssl, email }) {
  const d = safeDomain(domain);
  return setupCommand({ domain: d, config: buildStaticConfig(d, webroot), ssl, email });
}

/** Convenience: full command for a reverse proxy to a local port. */
function proxySetupCommand({ domain, port, ssl, email }) {
  const d = safeDomain(domain);
  return setupCommand({ domain: d, config: buildProxyConfig(d, port), ssl, email });
}

module.exports = { safeDomain, buildStaticConfig, buildProxyConfig, setupCommand, staticSetupCommand, proxySetupCommand };
