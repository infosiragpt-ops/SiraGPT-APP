# AGENTS.md — Prisma: cambios de datos reversibles y auditables

Aplica a esquema, migraciones y semillas de `backend/prisma/`. Complementa
[backend](../AGENTS.md) y [raíz](../../AGENTS.md). Una solicitud de refactor,
mejora o despliegue no autoriza pérdida de datos ni reparación improvisada del historial.

## Identificar antes de ejecutar

- DEBE verificar rama, commit, cambios existentes y destino efectivo antes de cualquier comando conectado.
- DEBE identificar entorno, base y rol sin imprimir credenciales, cadenas de conexión ni datos privados.
- NO DEBE inferir que una base es de pruebas por `NODE_ENV`, hostname, alias SSH o nombre del directorio.
- DEBE leer [schema.prisma](schema.prisma), migraciones previas del área y consumidores afectados.
- DEBE revisar [la resolución de arranque](../scripts/start-with-migrations.js) y variables efectivas;
  el URL del runtime y el de migración pueden diferir. No copiar defaults de documentación como destino.
- DEBE documentar tablas, relaciones, índices, restricciones, volumen esperado y permisos afectados.
- DEBE separar revisión/generación local de ejecución en una base compartida o productiva.

## Evolución compatible: expandir, migrar, retirar

- DEBERÍA preferir cambios aditivos compatibles con la versión desplegada y la siguiente.
- DEBE planificar lectura/escritura compatible antes de renombrar, retirar o reinterpretar un campo.
- DEBE hacer backfills controlados, reanudables y verificables, con selección acotada e idempotencia.
- DEBE comprobar datos existentes antes de imponer `NOT NULL`, unicidad, claves foráneas o nuevos enums.
- DEBE evaluar locks, duración, transacciones y disponibilidad con datos sintéticos representativos.
- DEBE preservar valores, precisión, zonas horarias, soft-delete y pertenencia a usuario/organización/empresa.
- NO DEBE sustituir una migración de datos por borrar/recrear tablas o regenerar IDs referenciados.
- DEBE explicitar la compatibilidad de rollback: revertir código no revierte automáticamente el esquema.
- DEBE separar la fase destructiva de la expansión; retirar datos requiere autorización específica y evidencia.
- NO DEBE ejecutar `DROP`, `TRUNCATE`, cascadas amplias o actualizaciones masivas fuera del alcance aprobado.

## Historial de migraciones: no alterar evidencias

- DEBE tratar migraciones aplicadas como inmutables: contenido SQL, nombre, orden e identidad.
- NO DEBE editar checksums ni filas de `_prisma_migrations` para hacer pasar arranque o despliegue.
- NO DEBE borrar, renombrar o reescribir una migración aplicada, aunque parezca equivalente en Git.
- DEBE corregir mediante una migración nueva, revisada y compatible con el estado real.
- DEBE detener la ejecución si hay deriva, migraciones fallidas, divergencia de checksums o historial desconocido.
- DEBE reunir evidencia de Git, esquema e historial con consultas de lectura y datos redactados.
- NO DEBE ejecutar `migrate resolve`, baseline o reparación de historial como salida automática de un error.
- Una recuperación excepcional DEBE tener diagnóstico, runbook revisado, backup verificable y autorización específica.
- NO DEBE ampliar excepciones del wrapper ni suprimir un gate para que una migración parezca aplicada.
- DEBE mantener separados «SQL ejecutado», «historial registrado», «arranque sano» y «flujo de usuario verificado».

## Atomicidad, concurrencia y aislamiento

- DEBE mantener invariantes de negocio dentro de la transacción que decide la mutación.
- DEBE verificar autorización y pertenencia al recurso sin abrir una carrera entre comprobación y escritura.
- DEBE preservar claves únicas de idempotencia, locks, leases y comprobaciones de fencing existentes.
- DEBE impedir que un worker vencido, cancelado o de otro tenant publique resultados o modifique saldos.
- DEBE probar carreras, repetición de requests, rollback y recuperación en PostgreSQL real aislado cuando correspondan.
- NO DEBE sustituir una restricción o transacción de DB por una comprobación solo en memoria.
- DEBE coordinar eventos/outbox con el commit; un evento emitido no garantiza que la escritura persistió.
- DEBE definir compensación para efectos externos; una transacción SQL no revierte almacenamiento o pagos remotos.
- DEBE preservar contabilidad y auditoría; no recalcular, perdonar ni duplicar cargos durante una recuperación.
- NO DEBE añadir un `onDelete: Cascade` sin inventario del alcance y autorización para su efecto destructivo.

## Pruebas y backup antes de bases compartidas

- DEBE probar la cadena desde una base vacía y la actualización desde un estado anterior representativo.
- DEBE usar PostgreSQL real aislado para afirmar compatibilidad SQL; un mock o SQLite no lo demuestra.
- DEBE comprobar las restricciones afectadas con casos válidos e inválidos y que vecinos no cambiaron.
- DEBE verificar backup previo, cobertura de datos necesarios y procedimiento de restauración antes de migrar producción.
- DEBE probar la restauración en un destino aislado; NO DEBE sobrescribir producción para ensayar recuperación.
- DEBE preservar cifrado, acceso mínimo y retención aprobada de backups; no subirlos a Git ni exponer su contenido.
- DEBE comprobar finalización y validación del backup; archivo existente o tamaño distinto de cero no basta.
- DEBE documentar rollback o recuperación, sus límites y quién autoriza ejecutarlos; no asumir recuperación instantánea.
- Referencias: [backup](../../scripts/backup-db.sh), [workflow](../../.github/workflows/db-backup.yml)
  y [pruebas del arranque](../tests/start-with-migrations.test.js); revisar el destino antes de usarlos.

## Comandos: conocer el efecto no concede permiso

- DEBE consultar los scripts reales en [package.json](../package.json) y el [CI](../../.github/workflows/ci.yml).
- Desde `backend/`, `npm run db:generate` genera el cliente; no migra una base ni demuestra compatibilidad del SQL.
- `npm run db:migrate` usa `prisma migrate dev`: solo en desarrollo aislado y con destino comprobado.
- NO DEBE ejecutar `db:push`, `db:reset`, `prisma migrate reset`, `seed` o scripts de setup en producción.
- NO DEBE usar `--accept-data-loss` ni ampliar privilegios para eludir errores de esquema.
- `prisma migrate deploy` modifica datos/esquema: solo mediante el procedimiento y autorización del entorno.
- DEBE ejecutar las comprobaciones de esquema y migración que el CI vigente exige, sin rebajar sus condiciones.
- DEBE mantener secretos fuera del comando visible, logs, fixtures, commits y descripción de PR.
- Si el comando puede cargar variables o conectarse automáticamente, DEBE revisar ese comportamiento antes de lanzarlo.

## Cierre y bloqueo seguro

- DEBE entregar SQL revisado, alcance, compatibilidad, pruebas y evidencia de restauración cuando sea necesaria.
- DEBE diferenciar validación local, CI y aplicación real; no afirmar «migrado» por generar el cliente.
- Ante destino incierto, autorización insuficiente o historial divergente, DEBE parar solo la mutación afectada.
- PUEDE continuar revisión y pruebas aisladas; NO DEBE improvisar cambios de producción para desbloquearse.
- Este archivo es preventivo: no ejecuta ni autoriza una migración, seed, restore o despliegue por sí mismo.
