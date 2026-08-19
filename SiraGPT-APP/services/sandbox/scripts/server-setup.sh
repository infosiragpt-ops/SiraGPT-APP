#!/usr/bin/env bash
#
# server-setup.sh — reproducible deploy of the SiraGPT sandbox microservice on
# a dedicated Docker host (e.g. the Lenovo). Idempotent; run as the service
# user (`lenovo`) which must be in the `docker` group and able to `sudo`.
#
# This is the EXACT procedure used in production. It does NOT contain secrets:
# the API key is generated here and written to ./.env + ~/secrets, never echoed.
#
# Usage (from /home/lenovo/siragpt-sandbox after the code is rsync'd here):
#   bash scripts/server-setup.sh [--harden-ssh]
#
# The public hostname is exposed via a DEDICATED named Cloudflare tunnel —
# intentionally NOT by editing the host's existing/shared cloudflared config,
# so a mistake here can never take down the SSH tunnel or other ingresses.
set -euo pipefail

APP_DIR="/home/lenovo/siragpt-sandbox"
IMAGE="siragpt-doc-sandbox:latest"
TUNNEL_NAME="siragpt-sandbox"
HOSTNAME_PUBLIC="sandbox.chatagic.com"
SECRETS="$HOME/secrets/lenovo-server.txt"
cd "$APP_DIR"

echo "==> 1. Build the runner image (python-docx/openpyxl/python-pptx/pypdf + LibreOffice)"
docker build -t "$IMAGE" runner

echo "==> 2. Service config (generate a strong key once; persist to .env + ~/secrets)"
mkdir -p "$HOME/secrets"; chmod 700 "$HOME/secrets"
if [ -f .env ] && grep -q '^SANDBOX_API_KEY=.\+' .env; then
  echo "    reusing existing SANDBOX_API_KEY"
else
  KEY=$(openssl rand -hex 32)
  cp -n .env.example .env
  sed -i "s|^SANDBOX_API_KEY=.*|SANDBOX_API_KEY=$KEY|" .env
  { echo "# SiraGPT sandbox — generated $(date -u +%FT%TZ)";
    echo "SANDBOX_SERVICE_URL=https://${HOSTNAME_PUBLIC}";
    echo "SANDBOX_API_KEY=$KEY"; } > "$SECRETS"
  chmod 600 "$SECRETS"
fi
chmod 600 .env

echo "==> 3. systemd unit (binds 127.0.0.1:4000 only)"
sudo cp siragpt-sandbox.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now siragpt-sandbox
sleep 2
curl -fsS http://127.0.0.1:4000/health >/dev/null && echo "    /health OK"

echo "==> 4. Dedicated Cloudflare tunnel for ${HOSTNAME_PUBLIC} (isolated from the SSH tunnel)"
if ! cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  cloudflared tunnel create "$TUNNEL_NAME"
fi
TID=$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n{print $1}')
cat > "$HOME/.cloudflared/sandbox-config.yml" <<CFG
tunnel: ${TID}
credentials-file: ${HOME}/.cloudflared/${TID}.json
ingress:
  - hostname: ${HOSTNAME_PUBLIC}
    service: http://localhost:4000
  - service: http_status:404
CFG
cloudflared tunnel --config "$HOME/.cloudflared/sandbox-config.yml" ingress validate
# Route DNS to THIS tunnel by explicit UUID (avoids the default-config picking
# a different tunnel). --overwrite-dns is safe: the hostname is dedicated.
cloudflared tunnel route dns --overwrite-dns "$TID" "$HOSTNAME_PUBLIC"
CF=$(command -v cloudflared)
sudo tee /etc/systemd/system/cloudflared-sandbox.service >/dev/null <<UNIT
[Unit]
Description=Cloudflare Tunnel for SiraGPT sandbox (${HOSTNAME_PUBLIC})
After=network.target
[Service]
User=lenovo
ExecStart=${CF} --no-autoupdate --config ${HOME}/.cloudflared/sandbox-config.yml tunnel run
Restart=always
RestartSec=5
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-sandbox
echo "    tunnel up — verify: curl https://${HOSTNAME_PUBLIC}/health"

if [ "${1:-}" = "--harden-ssh" ]; then
  echo "==> 5. SSH hardening (key-only auth, no root, fail2ban, unattended-upgrades)"
  echo "    (ensure your SSH KEY login already works before running this!)"
  sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban unattended-upgrades
  printf '[sshd]\nenabled = true\nmaxretry = 4\nbantime = 1h\nfindtime = 10m\n' | sudo tee /etc/fail2ban/jail.d/sshd-siragpt.conf >/dev/null
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' | sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null
  # Drop-in is parsed at the `Include` line (top of sshd_config) → wins over the
  # main file's later `yes` lines (first-match-wins).
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nPubkeyAuthentication yes\n' | sudo tee /etc/ssh/sshd_config.d/99-siragpt-hardening.conf >/dev/null
  sudo sshd -t
  sudo systemctl reload ssh
  sudo systemctl enable --now fail2ban
  echo "    effective:"; sudo sshd -T | grep -iE '^(passwordauthentication|permitrootlogin|pubkeyauthentication)\b'
  echo "    NOW rotate the login password manually: openssl rand -base64 24 | passwd ..."
fi
echo "==> done."
