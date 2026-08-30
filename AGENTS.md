# AGENTS.md — SiraGPT

Instrucciones permanentes para agentes de código y chat. Luis las irá ampliando.
No sustituye `.agents/`. Sin secretos. Sin dumps de `model_id`. Nunca imprimas nombres de vendor de modelos en la UI.

## UI

- MUST: la UI canónica es `/agentes`.
- MUST NOT: no revivas `/code`.
- MUST NOT: no cambies la interfaz salvo que Luis lo pida explícitamente.
- MUST: el indicador de pensamiento es un único SVG de 3 barras `#38BDF8` para todo estado thinking/tool. Las fases son solo etiquetas en español. Sin iconos extra.

## Marca y secretos

- MUST NOT: no filtres keys, `.env`, tokens, model ids crudos, ni los nombres de vendor DeepSeek / OpenRouter en la UI.
- MUST: marca de usuario = **Sira Rápido** / **Sira Pro**.

## Modelos

- MUST: cada modelo seleccionado usa SU propia API.
- MUST: Mini = Ollama sira-mini, `think` false.
- MUST NOT: no hay fallbacks silenciosos.

## Turnos triviales

- MUST: saludos y chat de una palabra (`hola`, `hi`, `ok`, `gracias`, `buenos días`) NO son trabajos largos.
- MUST: respuesta directa en segundos. Primer token rápido.
- MUST: `disableAgentic`.
- MUST NOT: Extra/Max, test-time-compute, thinking extendido, ni bucles de tools / SiraCode / Construir / Planificar — aunque esos toggles estén activos.

## Producción y deploy

- MUST NOT: no volcar `/home/user/deployments/iliagpt/.env`.
- MUST: prod es Lenovo + túnel Cloudflare. No Hostinger. No editar DNS.
- MUST NOT en `publish.sh`: `git reset --hard`, `compose down -v`.
- MUST: Caddy `encode` no debe aplicarse a `text/event-stream`.

## F7.4

- MUST: F7.4 es leak-gate.
- MUST NOT: no expongas SiraComputer a todos los usuarios ni actives F7 en `.env` salvo que Luis o SIRAGPT lo pidan.

## Git y CI

- MUST: PRs a `production-main`.
- MUST NOT: nunca push a `main`.
- MUST NOT: nunca `--admin` merge si CI está rojo.
- MUST: tests en verde.
- MUST: si tocas archivos UI-lock, actualiza hashes; si no, no los toques.

## Alcance

- MUST NOT: no inventes menús de store.
- MUST NOT: no rompas features existentes.
- MUST NOT: no amplíes el alcance.
