---
name: sql-avanzado
title: SQL avanzado
description: Escribe, optimiza y explica consultas SQL con CTEs, funciones de ventana e índices. Úsala para consultas complejas o lentas.
category: Datos y análisis
added: 2026-09-22
---

# SQL avanzado

Produce consultas SQL correctas, legibles y eficientes, y explica por qué funcionan.
Prioriza la corrección de resultados sobre la elegancia y la medición sobre la intuición.

## Cuándo usar
- Consultas con varias uniones, agregaciones por grupo, rankings o acumulados.
- Una consulta existente es lenta, devuelve duplicados o totales incorrectos.
- Hay que traducir una pregunta de negocio a SQL o migrar entre dialectos.

## Procedimiento
1. **Identifica el motor y la versión** (PostgreSQL, MySQL 8, SQL Server, SQLite,
   BigQuery, Oracle). Si no se indica, pregunta o asume PostgreSQL y dilo.
2. **Pide o reconstruye el esquema**: tablas, columnas, tipos, claves primarias y
   foráneas, cardinalidad aproximada. No inventes columnas: si falta una, pregunta.
3. **Define la granularidad del resultado**: "una fila por cliente y mes". Esto evita
   el error más común (duplicación por joins uno-a-muchos antes de agregar).
4. **Construye por capas con CTEs** (`WITH`): filtrado → unión → agregación → ranking.
   Cada CTE con nombre que describa su contenido.
5. **Usa el patrón adecuado:**
   - Top-N por grupo: `ROW_NUMBER() OVER (PARTITION BY grupo ORDER BY valor DESC)` y
     filtrar `rn <= N` en la consulta externa.
   - Acumulados y medias móviles: `SUM(x) OVER (PARTITION BY ... ORDER BY fecha
     ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)`.
   - Variación contra el periodo anterior: `LAG(valor) OVER (ORDER BY periodo)`.
   - Deduplicar quedándose con el último registro: `ROW_NUMBER()` + `rn = 1`
     (o `DISTINCT ON` en PostgreSQL).
   - Existencia: `EXISTS` / `NOT EXISTS` en lugar de `IN` con subconsultas que pueden
     devolver NULL (`NOT IN` con un NULL devuelve cero filas).
   - Pivotes: `SUM(CASE WHEN ... THEN x END)` o `FILTER (WHERE ...)` en PostgreSQL.
   - Jerarquías: `WITH RECURSIVE` con condición de parada y control de ciclos.
   - Huecos e islas: diferencia entre `ROW_NUMBER()` y la fecha para agrupar rachas.
6. **Maneja NULL explícitamente**: `COALESCE`, `COUNT(col)` vs `COUNT(*)`, comparaciones
   con `IS NULL`, divisiones con `NULLIF(den, 0)`.
7. **Optimiza con evidencia:** pide o ejecuta `EXPLAIN (ANALYZE, BUFFERS)` (PostgreSQL),
   `EXPLAIN ANALYZE` (MySQL 8.0.18+) o el plan real en SQL Server. Busca Seq Scan sobre
   tablas grandes con filtro selectivo, estimaciones de filas muy distintas de las reales,
   Nested Loop con muchas filas externas, ordenamientos que se desbordan a disco.
8. **Propón índices razonados:** columnas del `WHERE` por igualdad primero, luego rango,
   luego las de `ORDER BY`; índices cubrientes (`INCLUDE`) cuando evitan ir a la tabla.
   Advierte del costo en escrituras.
9. **Evita predicados no indexables**: funciones sobre la columna (`DATE(created_at) = ...`)
   → reescribe como rango (`created_at >= '2026-01-01' AND created_at < '2026-02-01'`).
10. **Verifica**: sugiere una consulta de control (conteo de filas por clave, suma
    comparada con la tabla base) para confirmar que no hay duplicación.

## Formato de salida
1. Supuestos (motor, esquema, granularidad) en viñetas.
2. La consulta en un bloque de código `sql`, con comentarios breves por CTE.
3. Explicación paso a paso (qué hace cada capa).
4. Si hubo optimización: plan antes/después o cambios esperados, índices propuestos
   con su `CREATE INDEX`, y cómo medirlo.
5. Consulta de verificación.

## Criterios de calidad
- [ ] La granularidad del resultado está declarada y respetada.
- [ ] No hay `SELECT *` en consultas finales.
- [ ] Los NULL están contemplados en filtros, conteos y divisiones.
- [ ] Sintaxis válida para el dialecto indicado.
- [ ] Toda recomendación de rendimiento se apoya en el plan o se marca como hipótesis.
- [ ] Consultas que modifican datos (`UPDATE`/`DELETE`) llevan `WHERE` revisado,
      recomendación de transacción y un `SELECT` previo para comprobar el alcance.

## Errores a evitar
- Agregar después de un join uno-a-muchos y duplicar sumas.
- `NOT IN` con subconsultas que contienen NULL.
- Filtrar en `WHERE` una tabla del lado derecho de un `LEFT JOIN` (lo convierte en INNER).
- Asumir orden sin `ORDER BY`.
- Recomendar índices en todas las columnas.
- Concatenar entradas del usuario en SQL: usar siempre consultas parametrizadas.
