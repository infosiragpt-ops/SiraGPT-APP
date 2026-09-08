# Migración histórica completa — evidencia F1

Ejecutada el 2026-09-05 entre 18:26:42Z y 18:26:56Z. **Resultado: PASS**.
Prisma 6.19.3, PostgreSQL 16.14 y pgvector 0.8.6; exclusivamente datos sintéticos
en una base nueva de test. No se usaron `db push`, `migrate resolve`, copias de
datos productivos ni variables de entorno de producción.

- Base `production-main`: `09fa991cf78a3f425499caefde3d2e68ae58b3b0`.
- HEAD del candidato: `f085ebac9cbbb24e4164e852cc83a8fdc07f4d89`.
- F1 SQL SHA-256: `a699ad981695f8dd4d48b327ba6fe77c4cc0b7e0f2b0c3183fbf33c0b369ba21`.
- Evidencia JSON y logs Prisma: `/tmp/doc-sandbox-migration-history.3KO5hMXe/`.
- DB conservada para E2E: `doc_sandbox_history_46398ff88700c639`, schema `public`,
  contenedor `doc-sandbox-history-postgres`, red interna `doc-sandbox-phase1-test`.

El runner aplicó las **132 migraciones históricas** desde una DB vacía. Verificó
que todos los SQL históricos del candidato conservan sus hashes y que cada fila
en `_prisma_migrations` está terminada, sin rollback y con checksum correcto.
Después insertó un usuario sintético y aplicó la migración F1: **133 migraciones**
totales. El usuario conservó todos sus campos anteriores y recibió
`docQuotaEpoch=0`; las únicas tablas añadidas fueron `doc_jobs`,
`doc_job_events` y `doc_job_artifacts`.

SQL real confirmó que un job sin propietario existente falla con `23503`, una
clave de idempotencia duplicada falla con `23505` y publicar un resultado sin la
validación requerida falla con `23514`.

Una segunda ejecución de `prisma migrate deploy` terminó con exit 0 y
`No pending migrations to apply.`. Las filas completas del historial no
cambiaron y el job sintético persistió una sola vez. `prisma migrate status`
terminó con exit 0: `Database schema is up to date!`.

## Reproducción

El contenedor usado tiene imagen inmutable
`sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b`
(`pgvector/pgvector:pg16`), usuario `999:999`, raíz de solo lectura, todas las
capabilities eliminadas, `no-new-privileges`, 0.5 CPU, 1 GiB RAM, 128 PIDs y
cero puertos publicados. Sus datos están en el volumen nuevo y etiquetado de
test `doc-sandbox-history-pgdata`. No comparte mounts con producción.
Las credenciales sintéticas son las fijadas en el runner y coinciden con las
del resto de fixtures de integración.

Con ese servicio de test ya iniciado:

```sh
bash infra/doc-validation/test-migration-history.sh \
  /home/user/deployments/doc-sandbox-phase1-tests/candidate-git-561 \
  09fa991cf78a3f425499caefde3d2e68ae58b3b0
```

El wrapper no inicia ni detiene servicios. Exige imagen y etiqueta de test,
ausencia de puertos publicados y red interna. Archiva únicamente el subtree
Prisma de la revisión base, crea otra base con nombre aleatorio y deja reporte
privado y logs reproducibles en un directorio `/tmp/doc-sandbox-migration-history.*`.

Esta evidencia cubre la historia de migraciones y el upgrade F1. La equivalencia
total entre el datamodel y SQL histórico, el E2E de aplicación y el runtime de
validación documental se comprueban por separado.
