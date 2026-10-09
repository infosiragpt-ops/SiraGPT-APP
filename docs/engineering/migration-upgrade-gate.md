# Gate incremental de migraciones con datos existentes

El required check `drizzle-migrations-dry-run` ejecuta ahora PostgreSQL pgvector16:

1. Extrae schema e historial SQL del SHA base real del PR/push. Rechaza modificar, borrar o retrofechar migraciones históricas; escanea operaciones destructivas de SQL nuevo.
2. Crea una base efímera aislada y aplica **BASE con `prisma migrate deploy`**. Inserta usuario, chat, mensaje con Unicode/metadata, saldo/reserva de créditos, uso con coste no cero y endpoint webhook.
3. Captura hashes de filas, columnas, índices, restricciones/FK, secuencias, enums, rutinas/policies e historial/checksums. Calcula `baseline-drift.sql` contra el schema BASE.
4. Aplica **HEAD con `prisma migrate deploy`**, sin `db push` ni `migrate resolve`. Exige preservar las filas/valores antiguos, tipos/defaults, índices/FK y bytes/checksums históricos. Columnas/tablas nuevas y relajar NOT NULL son cambios aditivos permitidos.
5. Calcula `upgraded-drift.sql` contra HEAD. Compara statements SQL completos normalizados: cualquier drift nuevo o modificado bloquea. La desaparición de drift antiguo se registra. Prueba FK, unicidad y checks nuevos, y exige que un segundo deploy no cambie datos.

El artifact `migration-upgrade-evidence` incluye ambos SQL, snapshots (solo hashes/conteos, nunca filas ni credenciales) y `upgrade-report.json`. No arranca la aplicación ni contacta providers. El gate no es una prueba de rollback/downgrade de aplicación ni de volumen/duración sobre datos reales.

## Drift heredado: no autoriza publicar

El rehearsal local y CI del BASE `7a05da5d0` aplicó136 migraciones, pero encontró108 statements de drift frente a su schema. HEAD aplica138 migraciones y conserva108 statements: cero drift nuevo. Se registra íntegro; **el gate schema del publisher permanece intacto y bloqueante**. No se reescribe historia ni se corrige el rehearsal con `db push`.

Plan de reconciliación separado y aditivo, sujeto a revisión de los SQL exactos:

- Inventariar el diff contra un restore aislado de un backup revisado; comparar tipos/enums y columnas existentes, no inferir estado de producción desde el DB sintético de CI.
- Añadir tablas/columnas faltantes como nullable o con defaults compatibles. Backfill por lotes con conteos e invariantes; añadir/validar restricciones en releases posteriores.
- Enums `Plan` y `ProviderType`: añadir valores necesarios sin eliminar legacy; mapear valores en código/dual-read. No ejecutar el reemplazo/drop enum sugerido automáticamente por Prisma.
- Conservar índices GIN/vector/FTS, triggers y FK históricas que Prisma no representa. Definir sus contratos explícitos; no eliminarlos para conseguir un diff vacío. Revisar nombres y acciones ON UPDATE/DELETE antes de cambiar una FK.
- Separar índices nuevos concurrentes y ventanas de validación de constraints de las migraciones transaccionales; medir lock/statement timeout en restore con volumen representativo.
- Preparar rollback de aplicación compatible con columnas aditivas, backup+restore probado y cutover revisado. Un upgrade de CI exitoso no levanta por sí solo el bloqueo del publisher.

## Durabilidad B6–B8

- SSE: RedisV2 usa una lista incremental4MiB/4000frames y máximo256KiB por frame. Los offsets son absolutos; un cursor fuera de ventana devuelve resync, nunca una cola renumerada. V1JSON se lee y migra al mutar. La memoria de respaldo es single-replica y tiene cap64MiB; Redis es best-effort.
- Tareas: eventos de progreso usan snapshots acumulativos buffered; solo `await ...Async`/`flushTaskStore()` constituye barrera durable. El writer usa fsync+rename y serializa el índice. Un SIGKILL puede perder el progreso aún buffered; no se promete lo contrario. Creación, checkpoint y terminal esperan flush; SSEpoll no cierra un terminal pendiente.
- Webhooks: la fila outbox es durable una vez enqueue retorna; HTTP es at-least-once, con `X-SiraGPT-Delivery` estable, lease fencing, `SKIP LOCKED` y cuatro entregas concurrentes por worker (máximo configurable por constructor8). Los endpoints/ownership se revalidan antes de entregar; secrets se resuelven en el momento, no se guardan en la fila.
- Pasar el cliente Prisma transaction a `publish(..., { transaction, idempotencyKey })` puede acoplar un producer SQL al enqueue. La terminal de tareas sigue siendo archivo→notificación best-effort: existe una ventana crash entre ambos; no se anuncia exactly-once entre stores distintos. El receiver debe deduplicar por delivery ID.
- Rollout: aplicar nuevas migraciones, generar Prisma, desplegar workers con hooks de stop/flush antes de disconnect DB. La compatibilidad del JSON legacy es lectura/migración V1→V2, no dual-write para un worker antiguo durante rollback.
