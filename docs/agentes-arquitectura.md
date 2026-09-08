# Agentes de codificación — arquitectura

> Agente de programación 100 % en línea y multiusuario en
> `https://siragpt.com/agentes`. Nunca aplicación local. Estado: **Fase 1**
> (cimiento: catálogo, política, flag, salud). Ver `docs/oss-catalog.md`
> para el inventario completo de fuentes.

## Planos

```text
/agentes (única UI)
   │  chat + IDE (chat, árbol, editor, terminal, diff, preview)
   ▼
Plano de control — backend SiraGPT (Express)
   proyectos · sesiones Postgres · créditos · colas BullMQ/Redis ·
   streaming SSE · auth + facturación existentes
   │  WebSocket/JSON-RPC
   ▼
Harness (dentro del sandbox) — pi + opencode server mode
   bash · editor por diff · ripgrep/ast-grep/serena · git ·
   Playwright · plan/tareas · aprobaciones · checkpoints · compactación
   ▼
Ejecución remota — OpenSandbox (Docker dev / K8s prod)
   sandbox aislado por sesión · TTL · CPU/RAM · egreso allowlist ·
   volúmenes persistentes · previews por subdominio firmado
```

## Decisiones tomadas (fase 1)

1. **Backend es TypeScript** (no existe `pyproject.toml`): harness sobre
   `earendil-works/pi` + modo servidor de `anomalyco/opencode`. El SDK
   Python de OpenHands queda como referencia, no se vendoriza.
2. **Modelos en prod**: solo DeepSeek V4 Flash/Pro. Modelos abiertos
   (vLLM/Qwen3-Coder/llama.cpp/Ollama) solo para evaluación y dev local.
3. **Convención de vendorizado**: `vendor/<slug>/` + `LICENSE` + entrada en
   `THIRD_PARTY_NOTICES.md` (+ snapshot en `.agents/<origen>-upstream`
   cuando aplique). `third_party/` no se crea: es la misma regla con otro
   nombre.
4. **LSP y edición**: Aider (repomap) y Continue como referencia; edición
   por diff con `diff2html` en revisión.
5. **Entrega**: modelo sesión→rama→change request (suna) + revisión con
   comentarios en línea (vibe-kanban); despliegue vía Coolify/Dokploy API.

## Despliegue

Todo tras el flag `AGENTES_CODING_V2` (off por defecto). Rutas nuevas
responden 404 con el flag apagado salvo `/health` (siempre 200, sin caché).
`GET /api/agentes-coding/health` → `{ ok, enabled, phase }`.

## Fases

1. **Cimiento** (este cambio): catálogo, política ejecutable, flag, salud,
   arquitectura. Cero código copiado.
2. **Sandbox**: OpenSandbox en Docker (compose dev) + API interna
   crear/ejecutar/archivos/puertos/destruir con TTL, límites y allowlist.
3. **Harness**: pi + opencode server dentro de la imagen + plugins.
4. **Plano de control + UI**: sesiones, Redis, WS, créditos, IDE en
   `/agentes`, git por proyecto, Deploy/Export, e2e todo-app Next.js.
