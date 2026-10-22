# Migraciones heredadas (temporal)

La copia vieja `siraGPT/` se retiró en #1060. Solo quedan estos archivos de
migraciones y esquema porque el `publish.sh` instalado en la Lenovo
(fuente revisada: `deploy/iliagpt/publish-reviewed.sh`) rechaza cualquier
publicación cuyo diff toque `**/migrations/**`, `**/schema.prisma`,
`**/schema.sql` o `**/drizzle/**`, aunque sea para borrar archivos que
nunca se compilan ni se sirven.

No se usan en ningún lado. Se pueden borrar en una publicación revisada
aparte, o cuando el gate se limite a las rutas reales del esquema
(`backend/prisma/**`).
