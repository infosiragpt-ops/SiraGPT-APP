# AGENTS.md — Rutas, páginas y frontera HTTP

Alcance: `app/**`. Complementa [la política raíz](../AGENTS.md) y [las reglas de componentes](../components/AGENTS.md) cuando se toca UI.
Objetivo: conservar rutas públicas, sesiones y contratos HTTP mientras se modifica únicamente el recorrido autorizado.

## Mapa de entrada

| Superficie | Fuente que debe leerse |
|---|---|
| UI canónica | [agentes/page.tsx](agentes/page.tsx), [agentes/[id]/page.tsx](agentes/[id]/page.tsx), [AgentsHomeSurface](../components/agents-home-surface.tsx) |
| Compatibilidad histórica | [chat/page.tsx](chat/page.tsx), [chat/[id]/page.tsx](chat/[id]/page.tsx), [code/page.tsx](code/page.tsx), [agents-home-path](../lib/agents-home-path.ts) |
| Administración | [admin/layout.tsx](admin/layout.tsx), [admin/models/page.tsx](admin/models/page.tsx), autorización de la API correspondiente |
| Ejecución HTTP de agentes | [api/agents/run/route.ts](api/agents/run/route.ts), [auth.ts](../lib/auth.ts), [server/agents/](../server/agents/) |
| URLs y cliente HTTP | [api-base-url.ts](../lib/api-base-url.ts), [api.ts](../lib/api.ts), [authenticated-fetch.ts](../lib/authenticated-fetch.ts) |
| Layout y apariencia | [layout.tsx](layout.tsx), [globals.css](globals.css), [UI-lock](../docs/UI_LOCK_HASHES.txt) |

DEBE: completar este mapa con los handlers, rewrites y consumidores reales del cambio; no asumir que todas las APIs viven en Next.js.

## Rutas y navegación

- DEBE: conservar `/agentes` como UI canónica y los aliases existentes como compatibilidad, no como productos nuevos.
- NO DEBE: revivir `/code`, crear otro chat ni duplicar páginas para eludir un fallo del recorrido canónico.
- DEBE: redirects conservar IDs y parámetros válidos, incluidos valores repetidos; probar enlaces guardados y navegación atrás/adelante.
- DEBE: conservar fragmentos cuando los maneje el cliente; no asumir que el servidor recibe el hash de una URL.
- DEBE: validar destinos post-login; no aceptar URLs externas o rutas privilegiadas mediante un parámetro `next` no confiable.
- NO DEBE: romper links de conversaciones, Biblioteca, artefactos o pantallas autenticadas por cambiar nombres de archivos/rutas.
- DEBE: verificar estados loading/error/not-found y refresh directo, no solo navegación desde la home.
- NO DEBE: resolver una discrepancia de producto abierta en una refactorización de routing o layout.

## Autenticación y autorización

- DEBE: proteger cada handler en servidor; ocultar un botón o usar `AuthGuard` en cliente no concede autorización a la API.
- DEBE: mantener validación de sesión activa y permisos por usuario/tenant/recurso cuando corresponda.
- NO DEBE: sustituir validación de sesión activa por verificar únicamente la firma JWT; revocación y expiración deben seguir aplicando.
- NO DEBE: confiar en `userId`, `isAdmin`, headers o IDs del cuerpo como prueba de propiedad o rol.
- DEBE: cubrir anónimo, sesión revocada/expirada, rol insuficiente y acceso a recursos de otro usuario.
- DEBE: una autoridad de autenticación no disponible denegar acceso, sin modo demo ni bypass de desarrollo.
- NO DEBE: ampliar CORS, cookies, CSP o validación de origen para que un test o entorno local funcione.
- DEBE: preservar defensas CSRF/origen en mutaciones, y el tratamiento correcto de credenciales y headers reenviados.

## Contratos HTTP y ejecución

- DEBE: revisar método, schema, status, headers y consumidor antes de alterar un `route.ts`.
- DEBE: conservar validación de entrada, tamaño permitido, errores y semántica de idempotencia ya definidos por el dueño.
- NO DEBE: presentar una aceptación o apertura HTTP 200 del stream como éxito final.
  DEBE conservar status/eventos del contrato; no emitir `done` exitoso o artefactos ficticios si falla la operación.
- DEBE: un error conservar su código público seguro; no enviar stack, tokens, rutas privadas ni respuestas crudas del proveedor.
- DEBE: preservar streaming, cancelación, heartbeat y cleanup al cerrar la conexión; no introducir buffering accidental.
- NO DEBE: reintentar automáticamente mutaciones no idempotentes ni extender timeouts para esconder un bloqueo.
- DEBE: efectos externos mantener sus aprobaciones y controles en servidor, incluso si el cliente omite el control visual.
- NO DEBE: sustituir el backend autoritativo por una implementación paralela en Next.js sin un cambio de arquitectura aprobado.

## Configuración y frontera de servidor

- DEBE: tratar `NEXT_PUBLIC_*` como datos públicos incluidos en el bundle, nunca como almacén de secretos.
- DEBE: verificar URLs públicas y rewrites en el entorno objetivo; `localhost` local no es configuración productiva válida por defecto.
- NO DEBE: agregar env, credenciales de ejemplo, endpoints alternativos o configuración productiva en un cambio de UI.
- NO DEBE: importar módulos privilegiados a un archivo `use client` ni serializar secretos en props, errores o HTML.
- DEBE: mantener el runtime requerido por cada ruta; un cambio Node/Edge necesita inventario de dependencias y verificación.
- DEBE: previews, archivos y contenido generado conservar sus límites de origen, sanitización y aislamiento existentes.

## Verificación y salida segura

Comandos desde la raíz y alcance elegido según el diff; [package.json](../package.json) y [playwright.config.ts](../playwright.config.ts) son la referencia ejecutable.

```bash
npm run type-check
npm run lint
npm run ui-lock:verify
npm test
```

- DEBE: añadir/verificar casos focales de rutas, auth, parámetros y estados HTTP afectados; un type-check no prueba autorización.
- DEBE: probar el recorrido visible con datos sintéticos en entorno aislado y registrar qué servicios fueron reales o interceptados.
- DEBE: distinguir compilación, CI, respuesta de health y operación real; ninguna de ellas implica por sí sola despliegue exitoso.
- NO DEBE: actualizar snapshots, hashes o expectativas para admitir redirects incorrectos o accesos indebidos.
- DEBE: ante una regresión, detener la publicación, acotar el cambio y conservar evidencia; no cambiar DNS ni permisos como parche.
- Un cambio de instrucciones en este archivo no habilita rutas ni constituye una autorización de despliegue.
