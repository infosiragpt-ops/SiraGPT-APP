#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# siraGPT — crea .env.local para desarrollo local
# ──────────────────────────────────────────────────────────────
# Copia .env.example a .env.local (raíz), genera secretos aleatorios
# (JWT_SECRET, SESSION_SECRET, ENCRYPTION_KEY) y apunta la base de datos
# y Redis a localhost. El backend lee este archivo vía
# backend/src/config/load-env.js y Next.js lo lee de forma nativa.
#
# .env.local está ignorado por git (.gitignore: `.env*.local`).
#
# Uso:
#   bash scripts/setup-env-local.sh          # no pisa un .env.local existente
#   bash scripts/setup-env-local.sh --force  # lo regenera (guarda backup)
# ──────────────────────────────────────────────────────────────

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$ROOT_DIR/.env.example"
TARGET="$ROOT_DIR/.env.local"

if [[ ! -f "$EXAMPLE" ]]; then
  echo "No encuentro $EXAMPLE" >&2
  exit 1
fi

if [[ -f "$TARGET" ]]; then
  if [[ "${1:-}" != "--force" ]]; then
    echo ".env.local ya existe; no lo toco. Usa --force para regenerarlo."
    exit 0
  fi
  backup="$TARGET.bak.$(date +%Y%m%d%H%M%S)"
  cp "$TARGET" "$backup"
  echo "Backup del .env.local anterior: $backup"
fi

rand_hex() { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }

# Reemplaza KEY=... si existe; si no, la añade al final.
set_var() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$TARGET"; then
    KEY="$key" VALUE="$value" node -e '
      const fs = require("fs");
      const file = process.argv[1];
      const { KEY, VALUE } = process.env;
      const re = new RegExp("^" + KEY + "=.*$", "m");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(re, () => KEY + "=" + VALUE));
    ' "$TARGET"
  else
    printf '%s=%s\n' "$key" "$value" >> "$TARGET"
  fi
}

umask 077
cp "$EXAMPLE" "$TARGET"
chmod 600 "$TARGET"

{
  echo ""
  echo "# ─── Ajustes de desarrollo local (scripts/setup-env-local.sh) ───"
} >> "$TARGET"

set_var NODE_ENV development
set_var JWT_SECRET "$(rand_hex)"
set_var SESSION_SECRET "$(rand_hex)"
set_var ENCRYPTION_KEY "$(rand_hex)"
set_var POSTGRES_HOST localhost
set_var REDIS_URL redis://localhost:6379
set_var FRONTEND_URL http://localhost:3000

# Confirma que git lo ignora.
if git -C "$ROOT_DIR" check-ignore -q "$TARGET"; then
  echo "OK: $TARGET creado (permisos 600) e ignorado por git."
else
  echo "AVISO: git NO está ignorando $TARGET — revisa .gitignore." >&2
  exit 1
fi

echo "Rellena tus claves de proveedores (DEEPSEEK_API_KEY, OPENAI_API_KEY, ...) editando .env.local."
