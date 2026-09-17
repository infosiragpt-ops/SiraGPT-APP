# F1 — ensayo aislado de backup, migración y recuperación

## Alcance

Ensayo operativo separado del publicador y de la instalación de gVisor. Utiliza
una **copia privada de un backup existente**, nunca una conexión a PostgreSQL
productivo. No inicia la web, workers, correo, integraciones ni modelos. No
aplica cambios al host, DNS o servicios productivos.

Herramientas acotadas:

- `tests/phase1-migration-rehearsal.cjs`: manifiesto de fuentes y auditoría real de
  PostgreSQL en tres fases. No contiene Docker, SSH ni arranque de aplicación.
- `tests/phase1-migration-rehearsal.sh`: wrapper específico del Lenovo. Crea su
  propio PostgreSQL y red interna, restaura, ejecuta las fases y detiene sólo su
  contenedor identificado por ID completo, imagen, scope y nonce.
- `tests/phase1-migration-rehearsal.test.cjs`: guards puros. **No equivalen a una
  restauración real**, aunque inspeccionen el SQL y el Git reales del checkout.

## Fuentes y límites fijados

La migración es `20260905000000_doc_sandbox_core`, con SHA-256:

`a699ad981695f8dd4d48b327ba6fe77c4cc0b7e0f2b0c3183fbf33c0b369ba21`.

El wrapper está fijado al backup previo a la publicación de `81f3d9a`:

`/home/user/deployments/iliagpt/backups/reviewed-81f3d9a63150-mBFiKm/database.dump.gz`

SHA-256 comprobado por lectura el 2026-09-06 UTC:
`48f4917bea18aec60d81fdf2f0754a3309b430b8af7bef47f0e7c45c383ffb16`.
Tamaño: 36.244.966 bytes; permisos `0600`. El nombre identifica la publicación
que creó el backup: **no significa que su contenido ya incluya ese despliegue**.
Cambiar de backup requiere revisión y actualización explícita del wrapper; no
se aceptan rutas arbitrarias.

PostgreSQL 16 con pgvector, imagen ya instalada:
`sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b`.
Cliente Node ya instalado:
`sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e`.

La etiqueta compartida es `siragpt.scope=doc-sandbox-phase1-rehearsal`, además
de un nonce único por ejecución. PostgreSQL tiene CPU ≤1, memoria ≤2 GiB,
sin puertos publicados, usuario `999:999`, raíz read-only, capabilities
eliminadas y `no-new-privileges`. Sus datos de prueba viven en tmpfs, no en un
volumen productivo. Los clientes tienen CPU ≤1 y memoria ≤1 GiB, usuario
`1000:1000`, la misma red interna y mounts de lectura limitados a Prisma,
package/lock/dependencias, helper y manifiesto. No se monta Docker socket,
checkout completo ni `.env`.

## Preparación y ejecución coordinada

1. Obtener autorización para el ensayo aislado. No ejecutar el wrapper de una
   revisión genérica: crea y modifica **sus bases de pruebas**.
2. Generar el manifiesto desde el checkout y el SHA exacto ya confirmado. La
   función `sourceAttestation(repo, sha)` exportada por el helper compara cada
   SQL, schema y package/lock con `git show` de ese SHA. Rechaza cambios locales
   en cualquiera de esas fuentes. El hash del propio helper queda incluido.
3. Guardar el JSON en un directorio nuevo `0700`, archivo `0600` y creación
   exclusiva. Transferir sólo helper, wrapper y manifiesto al directorio
   privado `rehearsal-client-*`. Verificar sus hashes tras la transferencia.
4. Preparar un candidato aislado `candidate-*` cuyos Prisma, package/lock y
   dependencias correspondan al manifiesto. No editar `/home/user/SiraGPT-APP`.
   Las dependencias proceden de instalación verificada por el lock; el helper
   exige Prisma `6.19.3` y PostgreSQL `16.x`.
5. Confirmar que `doc-sandbox-rehearsal-postgres` no existe. El wrapper no
   sustituye ni borra uno anterior, ni elimina volúmenes para poder repetir.
6. Desde el acceso deploy del Lenovo, con los cuatro argumentos verificados:

   ```bash
   bash /ruta/privada/phase1-migration-rehearsal.sh \
     /home/user/deployments/doc-sandbox-phase1-tests/candidate-IDENTIDAD \
     SHA_CANDIDATO_COMPLETO \
     /home/user/deployments/doc-sandbox-phase1-tests/rehearsal-client-IDENTIDAD \
     SHA256_MANIFIESTO
   ```

Los marcadores deben sustituirse por identidades ya comprobadas. El wrapper
rechaza rutas fuera de esos directorios y SHAs abreviados. No recibe URLs de
base de datos ni secretos de producción. Sólo admite la cuenta sintética de
su nuevo PostgreSQL; las dos bases llevan nombres aleatorios
`doc_sandbox_rehearsal_<32 hex>`.

## Evidencia exigida

- **baseline:** restauración con `pg_restore --single-transaction
  --exit-on-error --no-owner --no-privileges`. Historial completo y checksums
  exactamente anteriores a F1. Huellas SHA-256 de todas las filas y estructuras
  de tablas públicas, secuencias, enums, extensiones y definiciones de
  funciones/vistas/triggers/políticas. No se imprimen filas ni definiciones.
- **upgrade:** `prisma migrate deploy` real y estricto, fuera del arranque de la
  aplicación, con entorno mínimo y SQL exacto. Espera de locks 5 s y sentencia
  60 s en esta base de pruebas; proceso y contenedor con límites externos.
  Sólo aparecen las tres tablas F1 y `users.docQuotaEpoch=0`; los datos anteriores
  y el historial permanecen. SQL real rechaza propietario inexistente,
  idempotencia duplicada y publicación sin validación. Una segunda ejecución
  de migrate deploy no cambia nada.
- **recovered:** un nuevo `pg_dump -Fc` de la base migrada se comprime, verifica
  y restaura en una segunda base aleatoria. Deben coincidir todas las huellas,
  incluido el fixture sintético cancelado con reserva de coste no resuelta,
  cuota reservada, artefacto, tombstone y evento de limpieza pendiente. No se
  crean recursos remotos reales ni se ejecuta el trabajo sintético.

Los errores van a logs privados; la salida del agente sólo lleva estado,
conteos y códigos. El wrapper conserva la copia fuente, el dump post-F1,
reportes JSON y hashes dentro de un nuevo `migration-rehearsal-*` privado.
Después detiene su PostgreSQL: el tmpfs de test se descarta, pero los dumps y
la evidencia quedan. Contenedores detenidos y red etiquetada se conservan para
inspección; su retiro posterior requiere identificar exclusivamente ese nonce.

## Lo que NO demuestra

- No prueba un downgrade de la aplicación. El reporte siempre declara
  `applicationDowngradeVerified:false` y `productionMigrationExecuted:false`.
- No valida grants/propietarios productivos: se omiten deliberadamente al
  restaurar en la cuenta aislada. Es necesario revisarlos en el release real.
- Se rechazan esquemas de datos no públicos, large objects, tablas externas y
  vistas materializadas: no se excluyen silenciosamente de la comparación.
- No demuestra gVisor, Anthropic, R2, navegador, cobertura o gates de F1.
- No autoriza restaurar el backup pre-F1 sobre producción tras admitir jobs:
  eso perdería obligaciones nuevas. El rollback de aplicación debe conservar
  tablas, ledger, tombstones y un reconciliador compatible.

`publish-reviewed.sh` sigue rechazando cambios de schema/migrations. Este
ensayo no elimina esa guarda; el release migratorio continúa siendo un
procedimiento separado, revisado, con backend listo antes del nuevo frontend.

Auditoría de fuente del 2026-09-06: `start-with-migrations.js --migrate-only`
no basta para garantizar que el historial permanezca intacto ante P3009.
`runMigrations` puede invocar `rollbackSafeFailedMigrations` incluso en modo
estricto. El procedimiento F1 revisado deberá fijar
`PRISMA_AUTO_ROLLBACK_SAFE_MIGRATIONS=0` únicamente en ese proceso y abortar
P3005/P3009; no editar el entorno productivo ni usar `migrate resolve` para
aprobar el ensayo. Es lectura de código, no una nueva ejecución migratoria.

## Resultado registrado

Guards locales: **17/17 PASS**, cero skips, contra fuentes confirmadas en Git
antes del ensayo. Sintaxis Node/Bash y `git diff --check` correctos. La revisión
independiente no encontró acceso a producción; se endureció además el wrapper
para mantener privado stderr de `pg_dump` y no afirmar limpieza exitosa cuando
su estado es `2`. Esos dos cambios posteriores **no se ejecutaron remotamente**.

### Ensayo real del 2026-09-06 UTC: detenido antes de F1

- Candidato atestado: `8a95a2fe27d637790443cd30f13c1c7d21f43553`.
- Manifiesto: `b00dd4435a360ee495e65916c25ab9f9e444faf7cbb7d89703378eea0e703774`.
- Helper ejecutado: `4eded313d78f2cd568ae1311336db4ad1b342e3593ea859814ddbc25fa371fc3`.
- Wrapper ejecutado: `bd3bcac1bc852043deb129271b8bd155865ff47fa52908b52dd26b1cc3f31563`.
- Evidencia privada: `/home/user/deployments/doc-sandbox-phase1-tests/migration-rehearsal-XXfCfDkd`.
- **PASS:** copia byte-idéntica del backup fijado, CRC gzip y restauración real
  completa en PostgreSQL 16/pgvector aislado, sin puertos publicados.
- **FAIL cerrado:** `baseline` devolvió `REHEARSAL_HISTORY_MISMATCH` antes de
  aplicar SQL F1. No existen resultados `upgrade` ni `recovered`, y no se ha
  demostrado compatibilidad o recuperación posterior a F1 con este backup.
- PostgreSQL propio detenido y verificado `exited`:
  `78d59ce71d234f51cfcc42203eec3015f69adbc8e1c4da63aaf77a46c4b2287a`.
  Memoria 2 GiB, CPU 1, cero puertos publicados. No se borraron volúmenes ni
  backups originales; no se conectó ni migró la base productiva.

Un segundo diagnóstico autorizado extrajo **sólo** el contenido permitido de
`_prisma_migrations` del dump: nombres, checksums y estados, sin logs SQL ni
filas de usuarios. Usó dos herramientas efímeras `--network none`, root
read-only y las mismas imágenes fijadas; ambas finalizaron `exited|0`.
Resultado privado: `history-diagnostic.json` dentro de la carpeta de evidencia.

El repositorio espera 132 predecesoras; el backup contiene 138 filas. **No falta
ninguna predecesora**. Existen cinco nombres históricos adicionales:

- `20260524033500_ensure_prod_admin_account`
- `20260527000000_reset_admin_password`
- `20260628171000_force_reset_prod_admin_password`
- `20260805213000_add_user_is_super_admin`
- `20260805214000_align_fresh_schema_additive`

Siete migraciones terminadas tienen checksums distintos de los SQL del
candidato:

- `20260508140000_add_document_nodes`
- `20260519000000_add_performance_indexes`
- `20260524030000_backfill_user_roles_and_credits`
- `20260619120000_add_hostinger_publishing`
- `20260620120000_add_deploy_env`
- `20260704050000_add_cross_chat_recall_support`
- `20260713070000_add_product_quality_analytics_indexes`

Además, `20260827180000_add_chat_pinned_app_ids` aparece dos veces: una entrada
histórica figura marcada como revertida (`rolledBack=true`, `finished=false`).
Esto **no se interpreta como migración pendiente o corrupción**: el ensayo
exigía historial exactamente idéntico y su guarda lo rechaza. Tampoco basta
para concluir que F1 es incompatible; prueba que falta revisar y atestar el
baseline histórico real, no que el backup sea simplemente antiguo.

### Procedencia Git comprobada después del ensayo

Auditoría de sólo lectura sobre las 34 referencias locales disponibles (repo
no shallow), con una segunda comparación independiente de SHA-256. **10/10
versiones históricas cotejadas coinciden byte a byte con los checksums del
backup**. No se imprimió ni copió SQL al informe; las migraciones administrativas
históricas pueden contener valores sensibles y no deben restaurarse al código.

| Migración con checksum distinto | Commit con la versión que coincide |
| --- | --- |
| `20260508140000_add_document_nodes` | `cf15c60b6d3f46beec14a335bc1f93cd114fda43` |
| `20260519000000_add_performance_indexes` | `cf15c60b6d3f46beec14a335bc1f93cd114fda43` |
| `20260524030000_backfill_user_roles_and_credits` | `cf15c60b6d3f46beec14a335bc1f93cd114fda43` |
| `20260619120000_add_hostinger_publishing` | `21d76f89756955e706150fbf9eb1bc2ae8600079` |
| `20260620120000_add_deploy_env` | `6080f20b2e6ae5678a308c565f2791ef824857f6` |
| `20260704050000_add_cross_chat_recall_support` | `1c6ce59f6832abbd1cb8c75d4597d0ce3e793a59` |
| `20260713070000_add_product_quality_analytics_indexes` | `e2f1b36e7cb2728560b51e45fe4d2c1fbcb78b35` |

Las siete versiones actuales fueron introducidas conjuntamente por
`930f89343a750def1e61c83b347c31a4fd4d007b` (2026-07-21), ancestro del candidato.
Esto explica los checksums distintos, **no acredita equivalencia del schema**.

Las tres migraciones administrativas extra coinciden, respectivamente, con
`cf15c60b6d3f46beec14a335bc1f93cd114fda43`,
`a9d3254b77578c7ad550b02860b4c6734b280441` y
`8d76d6ab0c9b56bf572ce4adeb0a74b5b2849543`. Sus archivos fueron retirados juntos
por `a0c71b8227de188b0e32f1ae70a57f54fa281bb0` (2026-08-01). Eso explica que
consten como aplicadas sin existir ya en el candidato.

Las dos migraciones adicionales `20260805213000_add_user_is_super_admin` y
`20260805214000_align_fresh_schema_additive` no tienen procedencia encontrada
en las referencias locales examinadas, ni una ruta histórica alternativa.
No se atribuye autoría ni se supone corrupción. Falta evidencia operativa
para atestar ese baseline; no se relajó `verifyHistory` ni se repitió el ensayo.

### Siguiente paso seguro

1. Comparar las siete diferencias de checksum y cinco migraciones adicionales
   con su procedencia Git/operativa, sin volcar SQL que pueda contener secretos.
   Clasificar explícitamente la entrada revertida, sin borrar filas del
   historial ni usar `migrate resolve` para obtener un resultado favorable.
2. Diseñar y revisar una atestación del baseline real: historial y huellas de
   schema/data, con las diferencias históricas explicadas y fijadas. La guarda
   estricta actual queda intacta; cualquier adaptación necesita revisión.
3. Sólo después, autorizar un nuevo ensayo aislado con identidad nueva y un
   backup revisado, exigir aplicación exclusiva del SQL F1, preservación de
   datos/obligaciones y restauración posterior completa.
4. Mantener bloqueada la publicación migratoria. El publicador ordinario,
   la base productiva y el runtime del host no se modificaron en este ensayo.
