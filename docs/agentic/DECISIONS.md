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
