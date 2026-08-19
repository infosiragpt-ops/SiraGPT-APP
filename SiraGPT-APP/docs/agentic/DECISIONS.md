# Agentic Core Decisions

## 2026-04-26 - No ejecutar `codex exec` recursivo

Decision:

- El sprint se ejecuta directamente en el repositorio actual en lugar de lanzar otro agente con `caffeinate codex exec`.

Razon:

- Mantiene los cambios auditables en esta sesion.
- Evita procesos anidados largos con estado dificil de inspeccionar.
- Reduce riesgo de tocar UI o mezclar cambios ajenos.

## 2026-04-26 - No tocar la interfaz visual

Decision:

- Los cambios de este sprint se limitan a backend, pruebas y documentacion agentica.

Razon:

- La restriccion del usuario exige preservar layout, estilos, colores y componentes visibles.
- Los bugs visuales reportados antes deben corregirse en tareas separadas y focalizadas.

## 2026-04-26 - Contabilidad de tokens estimada primero

Decision:

- Se implementa un `token_usage_frame` estimado, sin depender de credenciales ni proveedor externo.

Razon:

- En modo dry-run o con proveedores stub no siempre existe `usage` real del modelo.
- El sistema necesita medicion consistente por usuario, conversacion, modelo y tarea para auditoria y futuros limites.
- Cuando LiteLLM o proveedores reales entreguen `usage`, el frame puede mezclar `provider_reported` con estimacion de herramientas.

## 2026-04-26 - Persistencia via audit log por ahora

Decision:

- El uso de tokens se registra inicialmente en `sira_audit_logs` como `token_usage_recorded`.

Razon:

- Evita migraciones de base de datos durante este sprint.
- Mantiene compatibilidad con el storage adapter actual.
- Permite replay y reporting basico sin acoplar la UI.

## 2026-04-26 - Presupuesto preflight antes del runtime

Decision:

- Evaluar presupuesto estimado antes de llamar al engine y al runtime.
- Registrar `token_budget_checked` en todos los turnos y bloquear con `token_budget_exceeded` cuando el modo sea `enforce`.

Razon:

- Evita gastar herramientas y llamadas LLM en solicitudes que ya exceden limites configurados.
- Mantiene el mensaje del usuario persistido para no perder contexto.
- Permite operar en modo `observe` para medir sin afectar usuarios durante rollout.

## 2026-04-26 - Execution trace frame sin payloads crudos

Decision:

- Emitir un `execution_trace_frame` desde el runtime concreto.
- Registrar en auditoria solo el resumen del trace, no inputs ni outputs de herramientas.

Razon:

- La plataforma necesita observabilidad real para diagnosticar workflows, retries y bloqueos.
- Los traces deben ser utiles para admin/soporte sin filtrar prompts, archivos ni datos sensibles.
- Mantiene la separacion entre ejecucion backend y UI: el frontend puede consumir el frame en el futuro sin cambiar el runtime.
