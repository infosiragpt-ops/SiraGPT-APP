# VISION.md

Dirección de producto y alcance de merge. `AGENTS.md` es el juicio. `ROADMAP.md` / `STATE.md` / `ARCHITECTURE.md` son operación y diseño de fase.

## Misión

SiraGPT es un agente que **ejecuta** (archivos reales, computadora del chat), **mide** (prueba, no éxito declarado) y **responde con el modelo que el usuario eligió**.

Anti-patrón: clasificar intención y mandar a pipelines fijos. Patrón: un loop genérico. Lo simple es rápido. Lo difícil muestra pasos y tokens.

## Superficie canónica

- Producto: `/agentes`. `/chat` redirige. `/code` retirada: no revivirla.
- DeepSeek Flash/Pro se muestran como Sira Rápido / Sira Pro. Nunca la palabra DeepSeek ni el `model_id` en UI.
- El picker gana: Grok/Claude/GPT/Kimi no se silencian a otro API.

## Ship

Repo `infosiragpt-ops/SiraGPT-APP`. Rama `production-main` (nunca `main`). PR → CI `CI · required checks passed` → squash-merge. Publicar origen Cloudflare (Lenovo) con `deployments/iliagpt/publish.sh`. Nunca `git reset --hard`. Nunca `docker compose down -v`. Hostinger no es origen vivo.

## Fuera de alcance hasta que VISION lo abra

Dump de OpenCode/Hermes/OpenClaw en el árbol. Epic de 100 ítems. Chrome/catálogo como “Conectada”. Secretos en el chat.
