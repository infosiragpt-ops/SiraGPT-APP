# AGENTS.md — Contratos compartidos y clientes

Alcance: `lib/**`. Complementa [la política raíz](../AGENTS.md); no redefine contratos de producto ni autoriza migraciones o despliegues.
Objetivo: impedir que un cambio en un helper compartido altere silenciosamente a sus consumidores.

## Antes de cambiar un contrato

- DEBE: inventariar imports, reexports, usos dinámicos, consumidores de servidor/cliente y tests; buscar símbolos, no solo filenames.
- DEBE: describir entradas, salidas, errores y efectos persistentes que deben conservarse antes de extraer o renombrar código.
- DEBE: mantener compatibilidad con datos ya guardados, pestañas abiertas y clientes que todavía usan la versión previa.
- NO DEBE: borrar exports aparentemente muertos sin revisar generación de código, rutas y consumidores indirectos.
- NO DEBE: ocultar una incompatibilidad con `any`, casts, valores por defecto nuevos o catches que conviertan fallos en éxito.
- DEBE: un cambio incompatible tener contrato versionado o plan explícito de compatibilidad, pruebas y reversión aprobado.

## Inventario inicial de consumidores

| Contrato compartido | Revisar productor y consumidores |
|---|---|
| Navegación | [agents-home-path.ts](agents-home-path.ts), [app/agentes/](../app/agentes/), [app/chat/](../app/chat/), [app/code/page.tsx](../app/code/page.tsx) |
| Modelo elegido y catálogo | [chat/catalog-model.ts](chat/catalog-model.ts), [chat/model-preference.ts](chat/model-preference.ts), [chat-context-integrated.tsx](chat-context-integrated.tsx), [api.ts](api.ts), [composer](../components/chat-interface-enhanced.tsx) |
| Permisos y modo rápido | [chat/composer-session.ts](chat/composer-session.ts), [menú de permisos](../components/chat/composer-permission-menu.tsx), [menú de esfuerzo](../components/chat/composer-effort-menu.tsx), [chat-context-integrated.tsx](chat-context-integrated.tsx) |
| Solicitudes y seguimiento de documentos | [document-chat-request.ts](document-chat-request.ts), [chat-context-integrated.tsx](chat-context-integrated.tsx), [composer](../components/chat-interface-enhanced.tsx) |
| Autenticación y peticiones | [auth.ts](auth.ts), [authenticated-fetch.ts](authenticated-fetch.ts), [api.ts](api.ts), [api/agents/run](../app/api/agents/run/route.ts) |
| Streaming y recuperación | [sse-client.ts](sse-client.ts), [api.ts](api.ts), [agent-task-service.ts](agent-task-service.ts), [plan-service.ts](plan-service.ts), [chat/turn-cancellation.ts](chat/turn-cancellation.ts) |
| Tipos generados | [api-types.ts](api-types.ts), [schemas backend](../backend/src/schemas/), [generador](../backend/scripts/generate-api-types.js), [api-spec/](api-spec/) |

El mapa no es exhaustivo. DEBE ampliarse en la revisión cuando el símbolo tenga más consumidores.

## Identidad, estado y preferencias

- DEBE: conservar la distinción entre usuario/tenant, conversación, turno, tarea, archivo original y versión de artefacto.
- NO DEBE: reemplazar IDs por índices, nombres visibles o “el último” global cuando el contrato exige una identidad concreta.
- DEBE: caches y recuperación de sesión respetar usuario/tenant y recurso; no reutilizar datos privados entre identidades.
- DEBE: al cambiar keys de almacenamiento, documentar compatibilidad, invalidación y pruebas de lectura de datos anteriores.
- NO DEBE: limpiar preferencias, historial o borradores del usuario como solución a errores de parseo o hidratación.
- DEBE: separar modelo guardado en conversación, última elección y preferencia fijada; un refresh no debe confundirlos.
- DEBE: preservar modelo, esfuerzo y permisos desde control → petición → persistencia → recuperación.
- NO DEBE: activar permisos, modos o proveedores por inferencia, ni sustituir en silencio una selección explícita.
- DEBE: catálogo vacío, modelo inactivo y configuración no disponible conservar errores/estados explícitos, sin defaults inventados.

## Transporte, seguridad y ejecución

- DEBE: revisar compatibilidad de payloads y respuestas con schemas del servidor, no únicamente con tipos de TypeScript.
- DEBE: conservar autenticación, status HTTP, AbortSignal, timeout acotado y cancelación al envolver `fetch`.
- NO DEBE: reintentar escrituras o creación de tareas sin conservar el contrato de idempotencia del servidor.
- DEBE: recuperación SSE mantener cursor e identidad correctos, sin duplicar mensajes o reiniciar una tarea cancelada.
- DEBE: errores distinguir fallo, cancelación, resultado vacío y tarea aceptada; no fabricar texto o artefactos para taparlos.
- NO DEBE: introducir fallback silencioso de proveedor o degradar el modelo para superar un test o latencia.
- DEBE: mantener límites de servidor/cliente; `lib` no significa automáticamente código seguro para enviar al navegador.
- NO DEBE: importar credenciales o módulos privilegiados desde clientes, ni almacenar secretos en constantes públicas.
- DEBE: mantener validación de URLs, origen, ownership y sanitización; un helper no puede debilitar controles del dueño.
- NO DEBE: convertir metadatos, nombres de archivo o contenido remoto en instrucciones ejecutables o paths sin validar.

## Código generado y extracciones

- DEBE: modificar el schema/fuente autoritativa y revisar el diff generado; no parchear archivos generados a mano.
- DEBE: verificar el comando del generador y sus dependencias antes de ejecutarlo; no regenerar paquetes ajenos al cambio.
- DEBE: preservar comportamiento de éxito, error, cancelación y persistencia al extraer una función o consolidar duplicados.
- NO DEBE: incorporar dependencias, globals, timers o side effects a helpers puros sin justificar el cambio autorizado.
- DEBE: separar contratos deseados de garantías comprobadas; describir una política no demuestra que el runtime la cumpla.

## Verificación

Comandos desde la raíz; [package.json](../package.json) define los scripts vigentes.

```bash
npm run type-check
npm run lint
npm test
npm run test:unit -- tests/lib/authenticated-fetch.test.ts tests/lib/authenticated-fetch-contract.test.ts
```

- DEBE: ejecutar las pruebas del helper y de sus consumidores relevantes, incluidos valores ausentes, inválidos y persistidos antiguos.
- DEBE: una regresión demostrar el fallo previo; ni conteos altos ni tests que comparan solo texto fuente sustituyen comportamiento.
- DEBE: probar aislamiento entre usuarios/tenants cuando cambien caches, IDs o preferencias compartidas.
- DEBE: declarar qué pruebas usan dobles de transporte y cuáles acceden a servicios reales; no mezclar sus afirmaciones.
- NO DEBE: bajar umbrales, saltar tests o cambiar snapshots para que pase una incompatibilidad.
- DEBE: si no puede validarse un consumidor afectado, registrar el límite y bloquear su publicación hasta resolverlo.
