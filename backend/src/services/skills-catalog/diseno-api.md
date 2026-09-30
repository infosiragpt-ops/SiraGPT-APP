---
name: diseno-api
title: Diseño de APIs
description: Diseña o revisa APIs REST con recursos, códigos HTTP, errores, paginación, versionado y OpenAPI. Úsala antes de implementar o exponer una API.
category: Ingeniería
added: 2026-09-22
---

# Diseño de APIs

Diseña APIs HTTP predecibles, seguras y fáciles de evolucionar, y deja el contrato
escrito (OpenAPI) antes de implementarlo.

## Cuándo usar
- Diseñar endpoints nuevos o una API completa.
- Revisar una API existente (consistencia, errores, seguridad, compatibilidad).
- Generar o corregir una especificación OpenAPI.

## Procedimiento
1. **Entiende el dominio y los consumidores:** entidades, relaciones, casos de uso,
   quién consume la API (frontend propio, terceros, servicios internos) y requisitos
   de volumen y latencia.
2. **Modela recursos, no acciones:** sustantivos en plural y minúsculas con guiones
   (`/orders`, `/orders/{orderId}/items`). Anidar como máximo un nivel.
3. **Usa los métodos con su semántica:**
   - `GET` leer (seguro, idempotente) · `POST` crear o acción no idempotente ·
     `PUT` reemplazar (idempotente) · `PATCH` modificar parcialmente · `DELETE` eliminar
     (idempotente).
   - Acciones que no encajan: sub-recurso de acción (`POST /orders/{id}/cancel`).
4. **Códigos de estado correctos:** 200 OK, 201 Created (+ cabecera `Location`),
   204 No Content, 400 entrada inválida, 401 no autenticado, 403 sin permiso,
   404 no existe, 409 conflicto de estado, 422 validación semántica (si se usa, de forma
   consistente), 429 límite de tasa (+ `Retry-After`), 500 error interno,
   503 no disponible.
5. **Formato de error único** en toda la API, por ejemplo RFC 9457 (Problem Details):
   `{ "type", "title", "status", "detail", "instance" }` más `errors` por campo y un
   `code` estable para máquinas. Nunca exponer stack traces ni SQL.
6. **Colecciones:** paginación por cursor para datos que cambian (`?limit=50&cursor=…`,
   respuesta con `nextCursor`) u offset para conjuntos pequeños; filtros y orden
   explícitos (`?status=paid&sort=-createdAt`); límite máximo de página.
7. **Convenciones de datos:** un solo estilo de nombres (camelCase o snake_case), fechas
   ISO 8601 en UTC, importes en unidades mínimas o decimales como cadena con moneda,
   IDs opacos.
8. **Idempotencia:** `Idempotency-Key` en `POST` que crean pagos u órdenes; control de
   concurrencia optimista con `ETag`/`If-Match` cuando haya ediciones simultáneas.
9. **Seguridad:** autenticación (tokens Bearer/OAuth 2.0), autorización por recurso
   (verificar propiedad en cada acceso), validación de entrada con esquema, límites de
   tasa, CORS restrictivo, sin datos sensibles en URLs, HTTPS obligatorio.
10. **Versionado y evolución:** cambios aditivos no rompen; los que rompen van en nueva
    versión (`/v2` o cabecera) con política de deprecación y aviso (`Deprecation`,
    `Sunset`).
11. **Escribe el contrato OpenAPI 3.1** con esquemas, ejemplos y respuestas de error.

## Formato de salida
```
## Resumen de recursos
| Método | Ruta | Descripción | Auth | Respuestas |

## Modelos
Esquemas principales con tipos y campos obligatorios.

## Errores
Formato y catálogo de códigos.

## Paginación, filtros y versionado

## Especificación OpenAPI
<bloque yaml>

## Decisiones y alternativas
- Decisión → motivo.
```

## Criterios de calidad
- [ ] Nombres y formatos consistentes en todos los endpoints.
- [ ] Cada endpoint documenta éxito y errores posibles.
- [ ] La autorización se verifica a nivel de recurso.
- [ ] Las colecciones están paginadas con límite máximo.
- [ ] La especificación OpenAPI es válida y coincide con la tabla.
- [ ] Los cambios propuestos a una API existente indican si rompen compatibilidad.

## Errores a evitar
- Verbos en las rutas (`/getUsers`, `/createOrder`).
- Devolver 200 con `{ "error": ... }` en el cuerpo.
- Filtrar datos de otros usuarios por IDs secuenciales sin comprobar propiedad.
- Respuestas sin paginar que crecen sin límite.
- Romper contratos existentes sin versionar.
