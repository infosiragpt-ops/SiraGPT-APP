# F1 — limpieza paginada de evidencias privadas

2026-09-06 UTC. **PR #561 en borrador; no desplegada y sin cierre de F1.**
Base del lote: `e50ea88601e5391e75272b36a6623a4f974c5592`, que conserva la
producción `100d29bc2e76bf2fb6e875514112f5cae1e40025` (#571).

## 1. Qué se implementó

- `storage/private-storage.ts`: iteración de páginas privadas, sin acumular el
  prefijo entero. `list()` conserva intacto su límite de 10 000 claves.
- `queue/repository.ts`: registro previo de cada página bajo bloqueo del job
  borrado, con gracia vencida según reloj PostgreSQL y ámbito exacto. Reabrir
  una clave reaparecida retira su antiguo acuse; no altera fence ni eventos.
- `queue/cleanup.ts`: progreso de claves conocidas antes de LIST, diario previo
  de huérfanos y acuse de DELETE confirmados en lotes de 100 y en `finally`.
  Recorrido completo y segunda comprobación de prefijo vacío antes de finalizar.
- Pruebas reales PostgreSQL/MinIO y dos contratos unitarios pre-IO; integración
  obligatoria en el runner aislado y CI con imagen MinIO fijada, credenciales
  sintéticas y acceso sólo por loopback en el runner GitHub.
- `decisiones.md`: D30. Sin cambios en catch, motor, validador, UI ni migración.

## 2. Cómo se probó

Node local **24.19.0**. En Lenovo, runner Node **22.23.2**, imagen
`sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e`,
1 CPU/1 GiB, sin privilegios ni escritura del checkout. PostgreSQL, Redis y
MinIO exclusivamente de test en red interna, sin puertos publicados.

```text
bash infra/doc-validation/run-isolated-integration.sh <candidata aislada>
pre-fix: tests 75; pass 73; fail 2; skipped 0; duration_ms 84708.263505; exit 1
post-fix inicial: tests 77; pass 77; fail 0; skipped 0
duration_ms 156244.100467; exit 0
post-fix final: tests 79; pass 79; fail 0; skipped 0
duration_ms 156868.11316; exit 0
```

Candidata exacta:
`/home/user/deployments/doc-sandbox-phase1-tests/candidate-cleanup-20260906-XXCgPiIJ`.
Código pre-fix extraído de `e50ea886…`, sin cambiar runtime antes de reproducir.
El lock de dependencias coincide con la candidata Linux anterior por SHA-256
`f4c123e81500d87c294560dfcb65da8c7598289adcd7039872f515f727a35c5e`.
Logs privados locales: `output/phase1-cleanup-pagination-prefx.log`,
`output/phase1-cleanup-pagination-postfix.log` y
`output/phase1-cleanup-pagination-final.log`. No se suman las repeticiones.

Fallos previos exactos:

```text
cleanup round=1 remaining=10003 recordedPurged=0
cleanup must make real progress ... removed=0, recordedPurged=0
known DELETEs must reach S3 even when LIST is denied
actual { denied: 1, deleted: 0 }; expected { denied: 1, deleted: 2 }
```

Ejecución corregida inicial del caso grande (129079.034958 ms, incluye carga):

```text
cleanup round=1 remaining=5601 recordedPurged=4402
cleanup round=2 remaining=1765 recordedPurged=8237
cleanup round=3 remaining=0 recordedPurged=10003
```

La repetición final confirma 10 003 acuses en tres pasadas: quedan 5601,
1601 y 0 objetos, con 4402, 8402 y 10003 acuses, respectivamente.
Duración del caso grande: 127502.722491 ms, incluida la preparación.
Al terminar se comprobaron los tres servicios de test detenidos, sin puertos
publicados. Producción y checkout limpio continúan en `100d29bc2…`, con
readiness saludable a **2026-09-06T23:42:50.825Z**; no se publicó esta PR.

Comandos desde la raíz, con Node 24 al inicio de PATH:

```text
npm --prefix backend run type-check:doc-sandbox
exit 0
npm run type-check
exit 0
npm run lint
exit 0; 48 advertencias heredadas
bash scripts/verify-ui-lock.sh
exit 0; cero cambios de superficie visual
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
exit 0
NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test --test-reporter=spec --test-reporter-destination=output/phase1-cleanup-pagination-root-tests.log '.test-dist/tests/**/*.test.js'
tests 12471; suites 535; pass 12471; fail 0; skipped 0
duration_ms 63474.133417; exit 0
npm --prefix backend run test:doc-sandbox:coverage
tests 353; pass 353; fail 0; skipped 0; duration_ms 1734.918875
Lines/Statements 72.96% (2674/3665)
Branches 86.22% (1158/1343); Functions 76.65% (266/347)
exit 1: Coverage for lines (72.96%) does not meet global threshold (80%)
```

No se excluyen las nuevas líneas de runtime ni se cuentan integraciones para
inflar cobertura: el denominador crece y el 80 % continúa bloqueado.
Faltan al menos 258 líneas cubiertas para 2932/3665. Los logs restantes son
`output/phase1-cleanup-pagination-*.log`. Prueba TypeScript estricta focal del
spec también exit 0.

## 3. Evidencia de validación

Esto valida almacenamiento y borrado, no edición documental ni cinco jobs
reales. Los 10 003 objetos son sintéticos: 10 001 huérfanos cifrados más original
e instrucciones. Se verifica envelope GCM, recuperación/hash de muestra,
prefijo vacío, acuses durables exactos y vecino de otro propietario intacto.
Los originales de usuario no se leen ni se modifican.

El caso pequeño usa proxy HTTP real que deniega LIST: los DELETE confirmados
llegan al MinIO real y su progreso persiste; una pasada nueva termina el
huérfano. Otros dos casos verifican 18 rechazos sin efectos parciales, frontera
válida de 1000 claves y una reaparición real por PUT que reabre el acuse.
Esta última rediscovery se invoca explícitamente: no acredita que el scheduler
escanee tombstones ya finalizados.

Los dos ensayos adicionales pasan en la repetición final de 79 casos:

- Tres respuestas 204 auténticas de MinIO se consumen y pierden antes de
  llegar al SDK: el objeto ya no existe, pero su obligación durable sigue
  pendiente y sin acuse. Una pasada nueva confirma el DELETE idempotente.
- Un PUT real aparece después de capturar una respuesta LIST sin modificar
  su XML. La comprobación final descubre y registra la clave nueva, impide
  declarar terminada la limpieza y permite completarla en la pasada siguiente.
  Este caso usa LIST **no truncado**; no acredita una carrera entre páginas
  con distintos tokens de continuación.

No se atribuyen estos dos casos a los 77 iniciales. No hay uso del proveedor
ni gasto nuevo: **US$0**.

## 4. Decisiones tomadas

D30 resuelve un prerrequisito de D27. La retención del diff fallido en el catch
sigue pendiente; no se cambia su comportamiento todavía. La revisión
independiente exigió journal previo por página: una respuesta DELETE perdida
no debe hacer desaparecer la obligación de limpieza. Se conserva asimismo la
distinción entre borrado físico y confirmación durable en la prueba grande.

API contrastada con [ListObjectsV2 de AWS](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html):
páginas de hasta 1000 entradas y token opaco. No se persiste el cursor entre
pasadas, ni se reinicia un recorrido después de haber entregado páginas.

## 5. Desviaciones respecto a la especificación

Lote correctivo de F1, no reporte de cierre. El test de más de 10 000 objetos
ejercita huérfanos, no 10 000 filas de artefactos. No demuestra rendimiento de
`markArtifactPurged` para ese volumen ni aceptación con motor real.
Los nuevos tests reales se añaden al gate CI, no a la medición unitaria.

## 6. Limitaciones conocidas y riesgos

- Los 30 s limitan operaciones de storage; Prisma no recibe AbortSignal, por
  lo que no se promete un SLA duro total de 30 s para SQL.
- El recorrido se limita a 100 páginas y rechaza tokens cíclicos o metadatos
  incompletos; no certifica un recorrido parcial. Una nueva pasada conserva
  progreso y vuelve a comprobar el prefijo.
- Persistir el informe/diff fallido y límites agregados del catch, gVisor,
  R2 productivo, presupuesto efectivo, goldens, migración/recovery y E2E real
  siguen pendientes. Este cambio no sustituye esos controles.
- Un forwarding SSH de prueba desde Mac fue rechazado por el servicio. No se
  modificó sshd ni se eludió ese control: se cerró el túnel propio y se usó el
  runner de test Docker ya autorizado, sin acceso administrativo al host.

## 7. Checklist de cierre

- ✅ Dos fallos pre-fix reales; seis casos nuevos dentro de 79 integraciones
  finales aprobadas, sin omisiones.
- ✅ 10 003 objetos purgados en tres pasadas; vecino intacto y outbox confirmado.
- ✅ Tipos, 12471 generales, 353 unitarias, lint y UI-lock.
- ✅ Revisión independiente del runtime sin bloqueantes; 2/2 pre-IO y 6/6
  contratos CI corroborados localmente, sin sumar esas repeticiones.
- ✅ DELETE con respuesta perdida y escritura posterior al LIST capturado,
  repetidos en servicios reales y revisados independientemente.
- ❌ 80 %, aceptación F1 y despliegue #561.

## 8. Continuación

Subir este lote a la PR en borrador y comprobar sus controles CI. Continuar
D27 (retención de evidencia fallida) con validación real y límites antes de
activar F1; revalidar también los requisitos del host sin alterar producción.
El publicador antiguo no es apto para esta migración; no quitar sus guardas.
Sólo notificar como publicado tras activar la candidata revisada, verificar
salud/SHA y editar/descargar un documento real en siragpt.com.
