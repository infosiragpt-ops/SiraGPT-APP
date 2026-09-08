# OpenClaw → SiraGPT: integración nativa y fiabilidad del runtime

Fecha de auditoría: 2026-09-06. Estado: **primer lote implementado en una rama aislada; no desplegado**.

## Alcance y fuentes

- Base SiraGPT: `production-main` en `81f3d9a63150d241f2b22fa4b34ac98b4558a3e3`.
- Rama de trabajo: `feat/openclaw-runtime-hardening-20260906`.
- OpenClaw consultado: [`74fe7d64709d4e7beb0f49df85c3667542954ff9`](https://github.com/openclaw/openclaw/tree/74fe7d64709d4e7beb0f49df85c3667542954ff9), incluyendo README, licencia y detección de bucles.
- Referencia local previa: `.agents/openclaw-upstream`, pin `b56ddcc6ffdfc5be78c1c9c93926518367b876eb`. No se reemplazó ni activó como runtime.
- Política de adaptación: [OpenClaw port charter](code/openclaw-port-charter.md) y [programa nativo existente](openclaw-native-rewrite-program.md).

El pedido de integrar capacidades faltantes no equivale a sustituir el backend por el gateway personal de OpenClaw. Su modelo de confianza para un operador no prueba aislamiento multiusuario. Este lote reutiliza módulos y utilidades propios; **no copia código upstream**, añade dependencias, cambia variables de entorno, abre puertos ni activa conectores. No modifica la interfaz, `/agentes`, F7, la PR #561 ni producción.

## Qué existe y qué está realmente conectado

| Capacidad | Ruta comprobada en SiraGPT | Evidencia y límite |
|---|---|---|
| Ejecución del agente | `agent-task-runner.js` → `services/react-agent.js`; `routes/agent-task.js` | Hay runtime y guardas de finalización; no necesita un segundo gateway para existir. No se auditó cada herramienta. |
| Tareas y recuperación | `task-flow-store.js`, `task_flow_*`, `agent-task-runner.js` | Persistencia, revisiones y recuperación existentes. No demuestra coordinación distribuida ni recuperación de todos los checkpoints inválidos. |
| Herramientas de chat | `agentic-chat-stream.js` → `agents/tool-call-retry.js` | Caller productivo comprobado; política de reintentos corregida en este lote. |
| Sesiones y memoria | `agent-tools.js`: `session_search/list/history` | Lecturas con ámbito de propietario; no se importan sesiones ni credenciales de OpenClaw. |
| Plugins | `agentic-chat-stream.js` → `agent-plugin-lifecycle.js` | Registro trusted-only existente. Un archivo en upstream no es un plugin activado. |
| Cron canónico | `skills/cron_schedule/handler.js` → `services/scheduler/scheduler.js`; conexión en `backend/index.js` | Invoker, clasificador y arranque conectados. Se añadió exclusión de solapamientos por proceso. |
| Cron de gateway | `agent-cron/index.js` → `cron-as-turn.js` | Ruta alternativa; no se encontró un scheduler productivo que llame a `createCron.tick()`. Sus pruebas no acreditan el cron canónico. |
| Bridge multicanal | `orchestration-context.js` → `multichannel/openclaw-adapter.js` | El adaptador puede devolver `accepted:true`; esto por sí solo no acredita un envío real ni autorización del canal. |
| Inventario OpenClaw | `openclaw-public-skill-adapter.js`, `openclaw-playbook-bridge.js` | Mapeo local: 36 skills upstream marcadas covered, 33 SiraGPT, 0 public skills inventariadas. Es cobertura de rutas/referencias, **no 100% de paridad funcional**. |

## Cambios de este lote

### 1. Reintentos de herramientas con consentimiento técnico explícito

`runToolWithRetry` usa `retrySafe:false` por defecto. Solo ocho lecturas auditadas se habilitan desde código propio: `web_search`, `read_url`, `web_extract`, `session_search`, `session_list`, `session_history`, `github_search` y `scientific_search`.

Escrituras, acciones de navegador, creación/envío a subagentes, ejecutores genéricos de apps y herramientas desconocidas reciben **un solo intento del wrapper**. El nombre o metadata de una herramienta externa no habilita reintentos. Esto evita repetir automáticamente una escritura que se confirmó remotamente antes de fallar la conexión; no evita que el modelo vuelva a solicitarla en otro turno.

Solo se reintentan errores lanzados y clasificados explícitamente como transitorios. Hay como máximo tres reintentos adicionales y esperas de hasta 30 s. Un cooldown del proveedor mayor se devuelve como error, sin recortarlo y reintentar antes de tiempo. No se amplió ningún timeout de ejecución.

### 2. Stop en despacho y espera

La señal original llega al handler. Se comprueba antes de comenzar, entre intentos y después del resultado; el backoff se cancela y libera su listener. **La cancelación remota del handler ya iniciado sigue siendo cooperativa**: no se afirma que una promesa rechazada deshaga una operación.

### 3. Resultados de cron y cola de fallos veraces

`cron-as-turn.js` espera un `startAgent` asíncrono y propaga rechazos o `{ok:false}` de ambos contratos. Un gateway síncrono puede confirmar **aceptación**, no terminación. La ausencia de dispatcher devuelve un error específico, no un reintento recursivo que acaba disfrazado de solapamiento.

La confirmación del sink de fallos se espera como máximo 1 s, sin reintentar. Ausencia, rechazo, resultado negativo o plazo agotado dan `deadLettered:false`. Ese valor significa confirmación no obtenida, no prueba de que el sink no pueda escribir más tarde. Los sinks históricos con retorno vacío conservan su contrato de aceptación al completar la llamada; esto no es evidencia de persistencia duradera.

El timer del dispatcher se cancela antes de esperar el sink. Un fallo cerca del deadline ya no aborta tardíamente otra ejecución de la misma sesión. `abortSession` recibe el propietario. Se normalizan códigos de fallo y se redactan secretos; no se devuelven objetos o mensajes arbitrarios como códigos.

### 4. Solapamiento local y pruebas herméticas

El cron de gateway separa el mapa por propietario + job y una finalización antigua no libera una entrada nueva. El scheduler canónico rechaza una segunda ejecución simultánea del mismo job con `overlap_skipped`, permite jobs distintos y libera el guard tras éxito o fallo. **Son guardas por proceso, no leases distribuidos**.

La prueba histórica de `scheduler` modificaba `_paths`, pero el módulo había capturado constantes y escribía en `backend/data`. El harness ahora compila la fuente íntegra real en un módulo con `__dirname` temporal y resuelve dependencias reales desde su ubicación original. No parchea globalmente `fs/path`, no altera configuración y usa persistencia real confinada al temporal.

## Verificación reproducible

Node empleado: 24.19.0. Sin llamadas pagadas, credenciales reales ni escrituras en producción. Los lockfiles no cambian.

```bash
npm run agent:openclaw:map -- --json
npm run skill:validate:agents
npm --prefix backend run test:openclaw-native
npm run type-check
npm run lint
bash scripts/verify-ui-lock.sh
git diff --check
```

`test:openclaw-native` conserva sus suites previas y agrega las regresiones de retry, adaptador real de chat, transporte HTTP, dispatcher cron y scheduler. El workflow CI ya ejecuta este comando. No se omitieron ni debilitaron tests históricos. El carril HTTP requiere permiso de escucha en `127.0.0.1:0`: en un sandbox que lo prohíbe falla con `EPERM`; no se omite silenciosamente.

| Comprobación | Resultado local |
|---|---|
| Suite nativa antes de cambios | 54/54 pasan, cero omitidas |
| Retry antes de corregir | 11 regresiones fallaban |
| Dispatcher antes de corregir | 11/12 fallaban; otras 3 regresiones de timer/owner fallaron antes de su arreglo |
| Scheduler antes del guard | 15/16 pasan; el mismo job invocaba dos veces |
| Suite nativa ampliada final (incluye HTTP real) | 173/173 pasan, cero omitidas, 11.92 s; permiso de escucha loopback concedido |
| Transporte HTTP real, ejecución independiente | 3/3 pasan: 503→200, efecto confirmado seguido de ECONNRESET sin repetición y Stop durante backoff |
| Utilidades retry/abort y variantes react-agent relacionadas | 71/71 pasan, cero omitidas |
| TypeScript | Pasa |
| ESLint sobre los nueve archivos JS modificados/nuevos | Pasa con cero errores y cero avisos |
| Escáner de secretos sobre los once archivos del lote | Pasa; es un control por patrones, no prueba absoluta de ausencia de secretos |
| Lint raíz | Exit 0 con 48 avisos en frontend no modificado; no significa cero avisos ni satisface el umbral de 45 de la skill |
| UI-lock | Pasa; cero archivos de interfaz modificados |
| Revisión independiente | Retry y scheduler sin hallazgos bloqueantes; P2 de timer cron corregido y revalidado |
| Subconjunto histórico 3H14 (8 pruebas de gateway/cron/health) | 5 pasan / 3 fallan: BE-005, BE-014 y BE-015, tanto en la base exacta como después. No se modificaron ni omitieron. |

Reproducción del subconjunto histórico (exit 1 esperado mientras esas brechas sigan abiertas):

```bash
node --test --test-name-pattern='3H14-BE-00[1-5]|3H14-BE-01[3-5]' backend/tests/ola-3h14-invariants.test.js
```

Para acreditar el estado previo sin revertir cambios, la revisión independiente cargó la fuente original de `cron-as-turn.js` obtenida con `git show` de la base en un módulo temporal; gateway, health y test se comprobaron idénticos a la base. El resultado fue exactamente los mismos tres fallos. No se restauraron archivos sobre el worktree ni se tocaron datos del scheduler.

Esta tabla no equivale a toda la suite del repositorio, E2E en navegador, rendimiento, cobertura global o funcionamiento productivo. Los controles globales y las brechas siguientes impiden declarar integración completa.

## Brechas comprobadas que no se ocultan

1. `cron-as-turn.js` y `agent-gateway/index.js` intentan usar `claimTurnIdentityUnique`, inexistente en los exports de `chat-turn-idempotency.js`. En cron se traga el error y una misma identidad puede repetirse; en gateway una primera llamada con `idempotencyKey` puede fallar como duplicada. La prueba histórica `3H14-BE-014` sigue fallando y no fue omitida. Sustituirlo por otra Map no demostraría garantía entre procesos.
2. `agent-cron.tick()` todavía ignora un resultado negativo del dispatcher y registra éxito. Este caller alternativo necesita su propia corrección antes de activarlo.
3. Redis/BullMQ requieren pruebas de reinicio, partición de red y confirmación de efectos. La disponibilidad nominal de una cola no acredita exactly-once.
4. Existen runners LangGraph con `MemorySaver`; debe comprobarse recuperación persistente por ruta sin borrar el almacén durable propio existente.
5. Faltan pruebas E2E reales de cada canal/proveedor autorizado y recuperación del flujo documental. La PR #561 permanece separada.
6. `3H14-BE-015` espera helpers de salud del gateway que el módulo actual no exporta. Revisar si el contrato fue retirado o si falta conexión; no crear stubs verdes para ocultarlo.

## Repositorios OSS: aprovechar primero lo ya incorporado

Versiones son las observadas en manifiestos/lockfiles; no se actualizaron. Los SHAs upstream consultados se registran para repetibilidad, **no son una recomendación de instalar `main`**.

| Proyecto y fuente primaria | Situación en SiraGPT | Uso de mayor impacto / condición |
|---|---|---|
| [BullMQ](https://github.com/taskforcesh/bullmq/tree/fe88496516f318b5c229a6e2e4fd9b7e99ca5fcf), MIT | Backend `^5.76.10`, colas existentes | Probar reinicios/deduplicación sobre Redis real. BullMQ Pro tiene condiciones separadas. |
| [LangGraph JS](https://github.com/langchain-ai/langgraphjs/tree/bbbdb5aa8a50f7115bdfbb6e3cf020ee239e1842), MIT | 1.2.9, runners existentes | Persistencia/checkpoints por tenant. El checkpoint-postgres upstream pide core `^1.1.44`, mientras raíz fija 1.1.41: revisar compatibilidad, no instalar a ciegas. |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/5119ee7fd7790e335a3fb60ef36f85334e2a6326) | Lock backend 1.30.0 MIT; cliente con controles SSRF | Probar revocación, reconexión y catálogo. Upstream migra MIT→Apache-2.0 y docs CC-BY-4.0: revisar licencia por versión. |
| [Playwright](https://github.com/microsoft/playwright/tree/46cd5008d12d4e1297793d921e6cc3b595e388da), Apache-2.0 + NOTICE | Raíz `^1.60.0`, backend `^1.56.1`; E2E raíz Chromium | Adjuntar, editar, descargar y reabrir archivos reales; sumar WebKit/Firefox y revisar compatibilidad de versiones. |
| [OpenTelemetry JS](https://github.com/open-telemetry/opentelemetry-js/tree/d898a551c2b335deb17d42711650cb173f4acbd8), Apache-2.0 | SDK/exportadores ya declarados | Seguir una traza a través de colas y validar redacción/cardinalidad. SDK instalado no implica exportación activa. |
| [Langfuse](https://github.com/langfuse/langfuse/tree/7637df1e1aadddbbfd0a45b960ecc97451381ce5) | Clientes y observabilidad existentes | Evaluaciones y costos. Servidor MIT salvo directorios EE comerciales; Cloud separado. No habilitar nuevos destinos de datos sin autorización. |

### Dos incorporaciones nuevas recomendadas, aún no instaladas

- **[Toxiproxy](https://github.com/Shopify/toxiproxy/tree/40f7fd31bee529d824116bd2a11a9e3425e904ec), MIT:** proxy efímero solo en pruebas para inducir cortes/latencia en Redis y PostgreSQL. Comprobar que no se repiten efectos ni cargos y que el estado se recupera. No aplicarlo sobre tráfico productivo ni publicar sus puertos administrativos.
- **[OPA](https://github.com/open-policy-agent/opa/tree/855776c6b19d2a0498b88566a2ef882ecfe1a2c8), Apache-2.0:** aparece nominalmente en catálogos, pero no se encontró runtime ni reglas Rego activas. Primera incorporación propuesta: comprobaciones offline de decisiones de permisos en CI, conservando el RBAC actual. No introducir otra dependencia remota en el camino de cada mensaje.

## Continuidad y reversión

Orden: (1) cerrar idempotencia y contrato del caller, (2) validar workers con Redis real y fallos inducidos, (3) recuperación persistente por tenant, (4) evaluar políticas offline, (5) E2E de herramientas/canales, (6) release separado con rollback y pruebas públicas. No hace falta reescribir todo el producto ni habilitar todos los conectores simultáneamente.

Este lote no requiere migraciones, secretos ni cambios de infraestructura. Antes de una eventual publicación, ejecutar CI completo y corregir las brechas correspondientes a las rutas que se activen. Si aparecen regresiones, revertir solo el commit de este lote en una rama de revisión; no resetear el repositorio, tocar bases de datos ni usar limpiezas de volúmenes. No hay un despliegue que revertir ahora.
