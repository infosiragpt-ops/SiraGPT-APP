# /code continuity (ilación)

Frontend ships as a Next.js **standalone image**. Host TSX is **not** read at
runtime (unlike backend `FEATURE_DOC_ENGINE` bind-mounts). Therefore:

1. **Source of truth** = GitHub `production-main` (merge `feat/restore-code-lost`).
2. Before any `build frontend` / `up -d --no-deps --force-recreate frontend`:
   ```bash
   bash scripts/preserve-code-patches.sh
   ```
3. Rebuild recipe (prod stack — do **not** include base `docker-compose.yml`):
   ```bash
   docker compose -f docker-compose.prod.yml -f docker-compose.production.override.yml --env-file .env build frontend
   docker compose -f docker-compose.prod.yml -f docker-compose.production.override.yml --env-file .env up -d --no-deps --force-recreate frontend
   ```
4. Never `compose down -v`. Never recreate backend just to ship FE.
5. ACS viewer: same-origin `https://siragpt.com/agent-computer/...` via Caddy
   `forward_auth` + `orch-client.js` `reconnect=1` embed URLs.
