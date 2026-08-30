# AGENTS.md — SiraGPT

Raíz = política dura y enrutado. Skills y `.agents/` = workflows.
Luis ampliará este archivo. No sustituye `.agents/`.
Código vía CloudAgent. MUST NOT: clonar el repo en máquinas de usuario.

## Enrutado

- MUST: antes de tocar un subtree, leer el `AGENTS.md` scoped más cercano (`ui/upstream/openclaw/AGENTS.md`, `src/upstream/openclaw/**`, `vendor/opencode/**` si aplica).
- MUST: preferir OSS/libs ya en el repo antes de código custom.
- MUST: núcleo chico. Nueva capacidad = skill o ruta de `/agentes`, no un tool core nuevo si ya hay terminal/files.
- MUST NOT: no agregar env/config salvo que Luis lo pida.

## UI

- MUST: UI canónica = `/agentes`.
- MUST NOT: no revivas `/code`.
- MUST NOT: no cambies la interfaz salvo pedido explícito de Luis.
- MUST: Pensando = un solo SVG de 3 barras `#38BDF8` para todo thinking/tool. Fases = etiquetas en español. Sin iconos extra.
- MUST: UI lock — si no tocas superficie visual, no toques hashes. Si tocas archivos UI-lock, actualiza hashes.

## Marca y secretos

- MUST NOT: no filtres keys, `.env`, tokens, `model_id` crudo, ni nombres de vendor DeepSeek / OpenRouter en la UI.
- MUST: marca = **Sira Rápido** / **Sira Pro**.
- MUST NOT: nunca imprimas secretos. Un `.env` en `/home/user/deployments/iliagpt/.env` — no lo volcar.

## Modelos

- MUST: cada modelo seleccionado usa SU propia API.
- MUST: Mini = Ollama sira-mini, `think` false.
- MUST: un flujo canónico. Sin fallbacks silenciosos de proveedor.

## Turnos triviales

- MUST: `hola`, `hi`, `ok`, `gracias`, `buenos días` NO son trabajos largos. Directo, segundos, primer token rápido, `disableAgentic`.
- MUST NOT: Extra/Max, test-time-compute, thinking extendido, ni bucle SiraCode / Construir / Planificar — aunque el toggle esté on.
- MUST: latencia = roundtrips al modelo. No Extra/tools en un saludo.

## Defaults = el producto

- MUST NOT: no rompas `hola`, el picker de modelo, ni `/agentes`.
- MUST NOT: no inventes menús de store, no rompas features, no amplíes el alcance.

## Reparación

- MUST: causa raíz. Leer el módulo dueño, callers, tests y el comportamiento live. Verificar la premisa antes de “arreglar”.
- MUST NOT: no escondas bugs con retries, timeouts más grandes, mocks más débiles, ni rutas paralelas.

## Fallos

- MUST: fallo silencioso > hang > feature faltante. Toda acción acaba en resultado visible o no-resultado registrado.
- MUST: nunca callejón sin salida. El error dice qué hacer después. Tools no disponibles se ocultan.
- MUST: verificar live el comportamiento visible antes de land.

## Caché de prompt

- MUST: no mutar historial ni reconstruir system/toolset a mitad de un chat (salvo compactación).
- MUST: tools scoped a la sesión, no al process env.

## Tests

- MUST: invariantes, no snapshots de catálogos ni change-detector tests.
- MUST: la regresión debe fallar en pre-fix.

## Prod

- MUST: prod = Lenovo + túnel Cloudflare. No Hostinger. No editar DNS.
- MUST NOT en `publish.sh`: `git reset --hard`, `compose down -v`.
- MUST: Caddy `encode` no aplica a `text/event-stream`.

## F7.4

- MUST: F7.4 es leak-gate.
- MUST NOT: no expongas SiraComputer a todos los usuarios ni actives F7 en `.env` salvo que Luis o SIRAGPT lo pidan.

## Git

- MUST: PRs a `production-main`. Tests en verde.
- MUST NOT: nunca push a `main`.
- MUST NOT: nunca `--admin` merge si CI está rojo.
