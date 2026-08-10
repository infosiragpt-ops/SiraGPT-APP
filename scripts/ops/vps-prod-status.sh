#!/usr/bin/env bash
# Read-only production status for /opt/siragpt (run on the VPS as root).
set -euo pipefail
echo "=== host ==="; hostname; date -u; uptime
echo "=== disk ==="; df -h / /opt /var/lib/docker 2>/dev/null | head -20
echo "=== docker ==="; docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" | head -40
echo "=== git ==="
cd /opt/siragpt
git log -3 --oneline
git status -sb
echo "HEAD=$(git rev-parse HEAD)"
echo "=== compose ==="
docker compose -f docker-compose.prod.yml -f docker-compose.production.override.yml --env-file .env ps | head -40
echo "=== backups ==="
ls -la /root/siragpt-backups/ 2>/dev/null | tail -20
echo "=== health ==="
curl -sS -m 10 https://siragpt.com/api/version; echo
curl -sS -m 10 https://siragpt.com/api/health/ready | head -c 500; echo
echo "=== env key names only ==="
sed -n 's/=.*//p' .env | head -80
echo "ENV_LINE_COUNT=$(wc -l < .env)"
echo DONE
