# Company OS — plan maestro: /code como empresa autónoma

> 2026-07-26. Une y supera los tres roadmaps previos
> ([autonomía](./autonomous-company-roadmap.md) ·
> [paridad Claude Code](./claude-code-parity.md) ·
> [cowork /chat](../chat/cowork-pro-roadmap.md)) bajo la visión completa:
> el mejor agente de codificación del mundo + una empresa que se gestiona
> sola (contenido, clientes, ventas, correos) con el CEO Office derivando
> trabajo desde el análisis global del negocio.

## 0 · Decisión: OpenClaw se ADAPTA, no se recrea

OpenClaw (MIT) es un gateway personal multi-canal con 25+ canales, skills,
cron, nodos y canvas. Recrear su código en este stack no aporta: es otro
runtime, otro workspace pnpm, otra UI. Lo que se integra son sus PATRONES,
y el mapeo contra lo que ya existe es este:

| Patrón OpenClaw | Equivalente siraGPT hoy | Acción |
|---|---|---|
| Gateway = control plane único de sesiones/canales/eventos | Parcial: SSE por run + session-manager sin UI | **Construir Gateway-lite** (P2) |
| Multi-channel inbox (WhatsApp/Telegram/Slack/…) | Solo Telegram bridge (inerte) + WebChat | **Channel adapters** (P2) |
| DM pairing + allowlist (seguridad de canal) | No existe | **Copiar tal cual** (P2) |
| Multi-agent routing (canal→agente aislado) | proactive-engine por departamentos | Extender routing canal→departamento |
| Workspace prompt files (AGENTS.md/SOUL.md) | `.sira/notes.md` | **SIRA.md + SOUL.md** = misión/visión (P3) |
| Skills registry (ClawHub) | skills-registry.js (14) + use_skill | Ampliar a registro por empresa |
| Cron jobs por usuario | system-cron global + skill cron_schedule | **ScheduledAgentTask** (cowork E4) |
| Sandbox modes por sesión | runner + sandbox-providers contract | Ya alineado |
| Canvas vivo (A2UI) | Oficina 3D + timeline SSE | **Live code stream** (P4) |

## P1 · EL MEJOR AGENTE DE CÓDIGO — flotas por departamento

Objetivo declarado: codificar con flotas masivas de agentes en paralelo.
La verdad de ingeniería: "miles" es un knob de concurrencia; lo que
convierte una flota en EL MEJOR agente es orquestación + verificación +
memoria. Piezas:

- **P1.1 Fleet orchestrator** (`codex/fleet-orchestrator.js`): descompone
  un objetivo en un DAG de tareas (el subagente `planner` ya existe),
  lanza N runs concurrentes (N = tamaño del departamento, configurable
  por el usuario al "abrir" un departamento en la oficina), con
  `run-queue` (BullMQ ya existe) como plano de ejecución y prioridades.
- **P1.2 Prerequisito duro: rama git por run + merge** (OT-7 de paridad).
  Sin esto, dos agentes sobre un workspace se pisan. Merge-queue con
  verificación por rama antes de mergear (tsc + tests + browser_check).
- **P1.3 Contratación dinámica**: "abrir un departamento" en la UI de la
  oficina = crear un pool de workers con presupuesto y misión; el fleet
  orchestrator reparte el DAG entre pools. La oficina 3D ya renderiza
  workers por departamento desde datos reales — solo consume el pool.
- **P1.4 Calidad de flota**: cada tarea del DAG lleva acceptance criteria;
  un run `qa_reviewer` por lote verifica integración cruzada; fallos
  re-encolan con contexto del ledger. (= F2 del roadmap de autonomía.)
- **P1.5 Paridad Claude Code completa** (los 4 tramos de
  claude-code-parity.md) como base del agente individual: caching,
  file-state, resume, MCP, hooks, background tasks.

## P2 · GATEWAY-LITE — canales del negocio con seguridad OpenClaw

- **P2.1 Modelo**: `BusinessChannel {id, companyId, kind (telegram|
  whatsapp|slack|discord|email|instagram|facebook|x), credentials
  (cifradas, patrón token-vault), dmPolicy (pairing|allowlist|open),
  allowFrom[]}` + `InboxMessage {channelId, externalId, from, body,
  attachments, direction, status}`.
- **P2.2 Adapters**: interfaz común `channel-adapter.js {receive, send,
  listThreads}`. Orden: Telegram (bridge YA desplegado — promover),
  Email (IMAP/Gmail: OAuth de Google ya existe en routes/auth.js),
  WhatsApp vía Twilio, Slack/Discord webhooks. Meta/IG comments vía
  social-company (oauth ya hecho).
- **P2.3 Seguridad copiada de OpenClaw**: pairing por código para
  remitentes desconocidos, allowlist local, `doctor` que audita políticas
  arriesgadas. Ningún canal nace en modo `open`.
- **P2.4 Router canal→departamento**: mensaje entrante → clasificador
  (intent ya existe: intent-attribution-graph) → cola del departamento
  (ventas/soporte/ingeniería) → respuesta como run con contexto de la
  empresa. Respuestas salientes en modo `review` por defecto (bandeja de
  aprobaciones = cowork E5); `auto` por canal solo con opt-in explícito.

## P3 · CEREBRO DE NEGOCIO — el CEO Office con datos reales

- **P3.1 Company model**: `Company {id, userId, name, mission, vision,
  brief, urls{web,landing,socials{}}, industry}` — el "Empresas" pedido.
  SOUL.md/SIRA.md del workspace se generan desde aquí (misión/visión
  inyectadas a TODOS los agentes de la empresa).
- **P3.2 Business presence audit** (`business-analyzer.js`): dado el
  nombre/URLs de la empresa, auditar con las herramientas REALES que ya
  existen (web_search + Brave + browser del research-agent): ¿tiene
  landing? ¿redes activas? ¿software propio? ¿SEO básico? → informe con
  gaps priorizados que alimenta al CEO Office.
- **P3.3 CEO Office global**: hoy propone tareas por round-robin ciego.
  Cambio: consume (a) el presence audit, (b) el ledger, (c) los OKRs de
  `brief.objectives[]`, y deriva tareas al departamento correcto con
  prioridad — incluida la decisión "no tiene landing → que Ingeniería la
  construya" (el generador Vite/Next del builder YA la produce) y
  "landing existente → run de mejora sobre ella" (document/codex edit).
- **P3.4 Lead-gen + CRM con guardarraíles**: `Lead {companyId, source,
  contact, stage (new|qualified|contacted|negotiating|won|lost), notes}`.
  El departamento Growth busca prospectos con búsqueda REAL (searchBrain/
  web-search/scientific ya existen), los cualifica contra el brief y
  PREPARA outreach (borradores). Enviar = siempre aprobación humana
  (bandeja E5) hasta que el usuario active `auto` por canal — cumplimiento
  de ToS de plataformas y anti-spam es parte del diseño, no un extra.
- **P3.5 Email del negocio**: adapter email (P2.2) + triage (deep-document
  -analyzer ya clasifica) → resumen diario de pendientes + borradores de
  respuesta en la bandeja. "Cerrar ventas" = mover stage con evidencia
  (hilo, presupuesto aceptado) y draft de cierre; el humano aprueba el
  envío.

## P4 · EXPERIENCIA — resúmenes, audio y streaming en vivo

- **P4.1 Summary-first**: todo run/ciclo proactivo termina con
  `run_summary` (ya existe el evento en codex) redactado ejecutivo:
  qué se hizo, qué falta, qué decisión se necesita. El chat responde
  resumen primero, detalle colapsado.
- **P4.2 Audio-resumen**: cuando el usuario pide audio, generar el
  resumen y pasarlo por `/api/ai/generate-speech` (endpoint determinista
  YA verificado en prod) → el mensaje lleva el MP3 del resumen, no del
  texto completo.
- **P4.3 Live code stream**: panel "en vivo" en /code: los eventos
  action_start/action_end + diffs por archivo ya viajan por SSE — añadir
  evento `file_delta {path, hunk}` emitido por las tools write/edit y un
  visor tipo editor que reproduce los cambios en tiempo real (mismo
  patrón del timeline, superficie nueva, sin tocar UI existente).
- **P4.4 Digest del CEO**: informe diario por Telegram/email (notify de
  cowork E5): ciclos, flotas activas, leads nuevos, correos pendientes,
  aprobaciones esperando, gasto.

## Secuencia maestra

```
1. P1.2 (ramas+merge-queue)  →  P1.1/P1.3 (flotas)     [el mejor agente]
2. P4.1/P4.2/P4.3 (resumen+audio+stream)                [se VE potente ya]
3. P3.1/P3.2/P3.3 (Company + audit + CEO real)          [cerebro]
4. Cowork E5 (aprobaciones+notify) — prerequisito de todo lo externo
5. P2 (canales con pairing)  →  P3.4/P3.5 (leads+email) [negocio]
6. P1.5 tramos de paridad en paralelo continuo
```

## Reglas no negociables

1. Toda acción EXTERNA (enviar, publicar, contactar) nace en modo
   `review`; `auto` es opt-in por canal y queda en `AgentAuditLog`.
2. Presupuestos como kill-switch, no como ahorro: flotas sin tope de
   coste diario no se despliegan.
3. Cada pieza: servicio puro + tests offline (el sharder ya los descubre)
   + CI verde + push. Sin tocar UI existente fuera de superficies nuevas.
