# F1: continuidad de publicación, 2026-09-06 UTC

**No desplegado. No es un cierre de fase.** La autorización de Luis para
publicar está vigente, pero faltan condiciones técnicas y acceso administrativo.
Este checkpoint sustituye las observaciones de producción antiguas, no la
especificación ni sus requisitos de aceptación.

**Actualización más reciente:** ante referencias mixtas del proveedor, el motor
conserva IDs válidos, contenedor y consumo antes de rechazar la respuesta.
Regresión PostgreSQL pre-fix **50/52**, post-fix y corroboración **52/52**;
**343/343** unitarias, cobertura **72,73 % (2593/3565)** y **12467/12467** generales.
SSH vuelve a funcionar pero sólo entra al contenedor deploy: no hay runsc ni
configuración R2/F1. Producción sigue saludable en `81f3d9a…`, sin #561.
La autorización de publicación está vigente; faltan acceso administrativo y
gates técnicos. Evidencia y límites en
[provider-reference-release-20260906.md](provider-reference-release-20260906.md).

**Registro anterior (`8be1ba856…`):** el validador Python real distingue TXT incorrecto
2028 del solicitado 2027 y conserva su diff en la salida de validación: **2/2**
casos positivos/negativos, fuera de cobertura unitaria. Se añadieron dos contratos
del motor y uno de CI: **341/341** estrictas, **72,59 % (2575/3547)**,
**12466/12466** generales. Runtime intacto. La retención del diff en el catch
continúa sin corregirse ni probarse con almacenamiento real; ensayo y límites en
[failure-evidence-release-20260906.md](failure-evidence-release-20260906.md).
No hay despliegue ni cierre de F1.

**Registro anterior (`c337481f4…`):** se corrigió la publicación con metadata de plan
incongruente y la conservación de originales ante advertencias vacías accesorias.
Ambos fallos se reprodujeron antes del arreglo. **339/339** pruebas estrictas,
cobertura **72,48 % (2571/3547)** y **49/49** integraciones nuevas PostgreSQL/Redis;
los servicios de prueba quedaron detenidos. No son jobs documentales completos
ni un ensayo migratorio PG16. Evidencia y límites en
[publication-release-20260906.md](publication-release-20260906.md).
El 80 %, la aceptación de F1 y el despliegue siguen pendientes.

**Registro anterior (`43b4f580…`):** se separaron las políticas puras de leases,
transiciones y presupuesto de intentos, conservando locks, reloj DB y orden de
IO. **336/336** pruebas estrictas y cobertura **72,48 % (2566/3540)**; **46/46**
integraciones nuevas con PostgreSQL/Redis reales de prueba pasan y sus servicios
quedaron detenidos. No son jobs completos ni un ensayo migratorio PG16.
Evidencia y límites en [policy-release-20260906.md](policy-release-20260906.md).
El 80 %, la aceptación de F1 y el despliegue siguen pendientes.

**Registro anterior (`46caed9c…`):** se corrigieron cancelaciones perdidas antes de
validar y descargas cuyo cierre podía quedar pendiente. Hay **307/307** pruebas
estrictas, cobertura **71,76 % (2486/3464)** y 14 casos nuevos. Runtime cambiado
sólo en esas guardas; sin despliegue. Evidencia y límites en
[cancellation-release-20260906.md](cancellation-release-20260906.md).
El gate del 80 % y la aceptación de F1 siguen pendientes.

Las secciones 1–8 siguientes conservan el registro de la revisión inicial y
sus continuaciones indicadas; las métricas vigentes están en el informe más
reciente. No representan una revalidación de producción a la hora de este cambio.

**Registro anterior (`db4bc8eaf…`):** la continuación de pruebas elevó la cobertura
estricta a **71,68 % (2476/3454)**, con **293/293** casos y cero omisiones.
Se añadió el control CI obligatorio del 80 %; el umbral todavía falla y la fase
sigue sin aprobarse ni desplegarse. Evidencia y límites en
[coverage-release-20260906.md](coverage-release-20260906.md). Esta medición
sustituye las cifras unitarias anteriores de este checkpoint, no los controles
pendientes de proveedor, host, almacenamiento o migración.

**Registro anterior (`162ae058…`):** se corrigió la prueba CBC inestable,
se añadieron pruebas reales de recuperación y almacenamiento privado, y se
separaron los dobles auxiliares de la medición unitaria. La cobertura estricta
era **65,34 % (2257/3454)**, no 67,08 %: aquella cifra mezclaba auxiliares con
catálogo/Docker simulados y no acredita el requisito SDK-only de §10.2.
Se mantienen todas las pruebas y el umbral del 80 %, sin excluir fuentes.

## 1. Qué se implementó

- Candidata del ensayo de migración: `8a95a2fe27d637790443cd30f13c1c7d21f43553`
  de #561. Las pruebas y este checkpoint posteriores no cambian ese runtime
  ni sus fuentes Prisma. La revisión inicial partió de `d1bd40fa4907fb649ea149652d14a849f838c748`.
- Integración `80b0aee84` con la producción
  `81f3d9a63150d241f2b22fa4b34ac98b4558a3e3`: conserva #565, #567 y #568.
  No se retrocede el arreglo de títulos PPTX, recuperación del chat ni layout
  móvil. El único conflicto de merge fue el inventario UI-lock; la lógica de
  recuperación combinada se revisó y el lock refleja los 802 archivos reales.
- Seis nuevos archivos `backend/tests/doc-sandbox-release-*.test.ts`:
  **62 casos** adicionales de lifecycle, privacidad, costos, cifrado,
  validación de entrada antes de IO y conservación de originales.
- `tests/agent-task-message-recovery.test.ts` usa el parser documental real
  al ejecutar el actualizador extraído del componente. Un caso nuevo impide
  que la recuperación de agentes adopte una burbuja documental pendiente.
- `backend/package.json` incorpora los seis archivos a la suite y un comando
  reproducible `test:doc-sandbox:coverage`, con todas las fuentes TypeScript
  del módulo y umbral de líneas del 80 %. No excluye archivos para ponerlo verde.

No se modificó el runtime documental para satisfacer pruebas, ni se activó
ningún modelo, servicio o variable de producción.

Continuación posterior a `fbfff812c`:

- `backend/tests/encryption.test.js`: corrupt padding CBC determinista; la
  alteración aleatoria anterior no siempre invalidaba el padding. Se preserva
  el comportamiento heredado; no se afirma autenticación de ese cifrado CBC.
- `doc-sandbox-storage-probe.cjs`: antes de gasto, exige CRUD real, GCM,
  bytes exactos, metadatos privados y rechazo anónimo. Journal 0600 sincronizado
  antes de PUT y confirmación de limpieza separada; un PUT incierto conserva
  su referencia y no obtiene certificado de borrado. No acredita R2 productivo.
- Dos pruebas de integración en MinIO real, incluida una política pública
  sintética que debe fallar, ejecutadas por el comando HTTP/storage y el runner
  aislado. La campaña real conserva `runsc` como primera puerta obligatoria.
- Ocho pruebas Postgres/Redis reales de recuperación, cancelación, entrega
  perdida, deduplicación y fencing. No invocan motor ni validador.
- `test:doc-sandbox:auxiliary` conserva los 18 checks con transporte Docker,
  catálogo y admisión simulados; CI los ejecuta aparte, sin sumarlos a cobertura.
  En la revisión final, sus dos contratos puros de identidad se trasladaron
  sin alterar aserciones a `doc-sandbox-validation-filesystem.test.ts`, junto
  a 16 nuevos casos con filesystem real. Quedan **16 auxiliares**, todos
  obligatorios, y **222 unitarias estrictas** tras cuatro contratos de planes
  adicionales. No se eliminó ninguna prueba ni se añadió un mock de transporte.
- Ensayo de restauración PostgreSQL 16: el backup se restauró, pero el control
  previo rechazó su historial antes de ejecutar F1. Resultado y diagnóstico
  separados en [migration-release-rehearsal.md](migration-release-rehearsal.md).

## 2. Cómo se probó

Node 24.19.0 en una copia de trabajo aislada. Backend instalado desde su
lockfile exacto con `npm ci --include=dev --ignore-scripts`, seguido del parche
de dependencia revisado y `npm run db:generate`. No se conectó a la DB productiva.

Comandos desde la raíz, salvo los que indican `--prefix backend`:

```text
npm --prefix backend run build:doc-sandbox
exit 0
npm run type-check
exit 0
npm run lint
exit 0; advertencias preexistentes, no se declara cero warnings
bash scripts/verify-ui-lock.sh
UI lock verified; 802 entradas
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
exit 0
NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test '.test-dist/tests/**/*.test.js'
tests 12462; suites 533; pass 12462; fail 0; skipped 0
duration_ms 60570.898916; exit 0 (repetición de esta continuación)
```

La corrida completa final usa reporter `spec` con destino
`output/phase1-readiness-root-tests.log`. La primera corrida, anterior a corregir el
harness de recuperación descrito abajo, falló y no se contabiliza como verde.

Medición histórica, sustituida por la estricta de §3 (no acredita el gate
SDK-only). Conteos separados, no sumar como E2E:

```text
npm --prefix backend run test:doc-sandbox:coverage
tests 217; pass 217; fail 0; skipped 0
Lines 67.08% (2317/3454), Functions 71.47%, Branches 85.74%
ERROR: Coverage for lines (67.08%) does not meet global threshold (80%)
exit 1, correctamente bloqueado por cobertura insuficiente

npm --prefix backend run test:doc-sandbox:runtime
tests 53; pass 53; fail 0; skipped 0
```

La medición anterior, repetida con el mismo comando c8 sin nuevas pruebas,
fue 155/155 y 61,46 % (2123/3454 líneas). El denominador conserva todos los
archivos TS, incluso los no ejecutados; Python y pruebas de integración no se
mezclan para superar el requisito. Los 62 casos nuevos no simulan validación,
DB, Redis ni S3: prueban operaciones puras o rechazos previos a IO. La receta
de conservación se ejecutó con Python real sobre texto/CSV sintéticos; no
equivale a abrir Word/Excel/PowerPoint ni a aislamiento gVisor.

Regresión PPTX/follow-up: desde `backend`,
`node --test --test-force-exit tests/pptx-first-slide-source-edit.test.js tests/pptx-upload-chat-regression.test.js tests/doc-followup-recovery.test.js`
dio **35/35**, cero fallos/skips. Incluye ZIP/PPTX real con alcance de slide,
no proveedor ni navegador. Guardas del publicador: **37/37**, sin publicar.
Recuperación del chat: primero **13/14** falló por una dependencia del harness
no inyectada (`parseDocumentJobPointer`); usando la implementación real y
añadiendo el caso de aislamiento documental, **15/15**, cero omisiones.

`npm audit --omit=dev` observa 7 avisos por metadatos: 2 altos, 4 moderados,
1 bajo. Los altos corresponden a `image-size` y su padre `pptxgenjs`.
`npm run security:verify-image-size` verificó los bytes del parche existente
para GHSA-w3rx-r6r6-pgpr/GHSA-5p2g-fcmc-qvqq; sus regresiones reales pasaron
**14/14**. No se informa un audit de cero avisos ni se aplicaron downgrades
automáticos. La candidata final sigue necesitando su CI y revisión de seguridad.

## 3. Evidencia de validación

No hay nuevos jobs Anthropic, informes de cinco jobs reales ni E2E completo
en esta continuación. Gasto nuevo: **US$0**. No se reinició el ledger ni se
afirma que el saldo del proveedor esté acreditado.

Resultados de la continuación (no son goldens de edición ni publicación):

```text
npm --prefix backend run test:doc-sandbox:coverage
tests 222; pass 222; fail 0; skipped 0
Lines 65.34% (2257/3454), Functions 69.06%, Branches 87.22%
exit 1: el gate 80% permanece bloqueado
npm --prefix backend run test:doc-sandbox:auxiliary
tests 16; pass 16; fail 0; skipped 0; exit 0
node --test backend/tests/encryption.test.js
tests 13; pass 13; fail 0; skipped 0; exit 0
node --import tsx --test tests/doc-sandbox-readiness-queue-recovery.integration.test.ts
tests 8; pass 8; fail 0; skipped 0; exit 0
```

La medición estricta intermedia fue 200/200 y 63,08 % (2179/3454). El nuevo
filesystem real y los contratos de planes añaden 78 líneas cubiertas, sin
cambiar las 3454 líneas medidas. Evidencia: `output/phase1-strict-coverage-final.log`.

La recuperación de la cola usa PostgreSQL 17.10 y Redis 7.2.10 efímeros propios en Mac;
no certifica compatibilidad de migración PostgreSQL 16 productiva.
Desde el Mac se ejecutó en Lenovo
`infra/doc-validation/run-isolated-integration.sh` con la candidata aislada
`/home/user/deployments/doc-sandbox-phase1-tests/candidate-readiness-20260906-XXMEmbBk`:
**66/66**, cero omisiones, 20.910 ms en la repetición final con los bytes
exactos del helper y su prueba. Evidencia privada:
`integration-final-exact.log`. PostgreSQL, Redis y MinIO de pruebas estaban detenidos
al inicio y quedaron detenidos al terminar; no hubo puertos publicados.
La imagen Node del runner está fijada en
`sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e`.

`npm run type-check`, compilación del módulo y UI-lock pasan; lint sale 0 con
advertencias heredadas. No hay cambio de superficie visual ni de validadores.

`backend/coverage/doc-sandbox-unit/coverage-summary.json` contiene la medición
local. No constituye una atestación de producción.
La evidencia Linux anterior permanece bajo el directorio privado
`/home/user/deployments/doc-sandbox-phase1-tests/entrega-561-20260905/`;
no se reetiqueta como ejecución de esta nueva combinación.

## 4. Decisiones tomadas

- Conservar los arreglos ya publicados antes de continuar #561.
- Mantener el borrador y todos los gates existentes de la especificación.
- No publicar frontend F1 deshabilitado: intercepta ediciones y produciría
  `E_NOT_READY`, interrumpiendo el flujo actual.
- No usar permisos del socket Docker para eludir la autenticación del host.
- Mantener la autorización de gVisor limitada a **sin reinicios**.

## 5. Desviaciones respecto a la especificación

Esto es un checkpoint parcial, no el reporte de cierre exigido por §12–13.
No se cumple aún el 80 % unitario ni la aceptación con proveedor/documentos.
Las fases siguientes no se declaran iniciadas ni aprobadas.

## 6. Limitaciones conocidas y riesgos

| Control | Estado fresco y acción necesaria |
| --- | --- |
| Producción | SSH y `/api/version` coinciden en `81f3d9a…`; readiness saludable a 2026-09-06 02:10 UTC. No contiene #561. |
| Acceso host | `siragpt-lenovo` entra a Alpine 3.24.1, UID 1000 deploy. No es una sesión administrativa del host. |
| Aislamiento | Docker publica únicamente runtimes runc; `runsc` no está registrado. Requiere preflight administrativo real y revisión antes de apply. |
| Configuración | R2 account/access/secret/bucket y variables DOC_SANDBOX requeridas ausentes en la última inspección del backend vivo y del archivo de despliegue. Las nuevas pruebas CRUD son del MinIO aislado, no suplen esa configuración. |
| Presupuesto | La clave Anthropic existe, pero no acredita hard cap/saldo. Mantener US$5 agregados y evidencia real vigente antes de gasto. |
| Publicación | `publish-reviewed.sh` rechaza schema/migraciones antes del backup. F1 exige un procedimiento migratorio separado y revisado; no quitar la guarda. |
| Ensayo migratorio | Backup restaurado en PostgreSQL 16 aislado; 138 filas de historial frente a 132 predecesoras esperadas. Cinco nombres extra, siete checksums distintos y una fila duplicada ya revertida. No faltan predecesoras. Se detuvo antes de migrar; no borrar ni resolver filas automáticamente. |

El paquete gVisor del runbook histórico no aparece desde el namespace del
contenedor SSH. Esto **no prueba** su ausencia en el host: verificar allí ruta,
hash e imágenes fijadas antes de ejecutar el adaptador. No repetir rutas de
`/tmp` históricas como si estuvieran confirmadas actualmente.

## 7. Checklist de cierre

- ✅ Integración de los arreglos productivos actuales y pruebas acotadas.
- ✅ Nuevas pruebas y medición íntegra reproducible, sin bajar el umbral.
- ❌ Cobertura unitarias ≥80 %.
- ❌ gVisor efectivo y preflight independiente real en su staging privado.
- ❌ R2 privado: CRUD, cifrado y rechazo anónimo comprobados. `HeadBucket`
  ya se sustituyó en el runner por una prueba real de estos contratos en S3
  aislado. Falta verificar R2 productivo y sus accesos públicos independientes.
- ❌ Goldens reales, concurrencia, E2E autenticado y muestras anonimizadas.
- ✅ Restauración del backup real en PostgreSQL 16 aislado, sin arranque de app.
- ❌ Atestación del historial existente, ensayo completo upgrade/recovery y
  release migratorio/reversión revisados. La fila revertida no demuestra por
  sí sola corrupción ni una migración actualmente pendiente.
- ❌ Publicación #561 y descarga real posterior desde siragpt.com.

## 8. Continuación

Primero habilitar sesión administrativa del **host Lenovo**, configurar los
secretos mediante el gestor privado y acreditar el límite del proveedor.
Continuar el preflight de `infra/doc-validation/install-runtime-host-plan.md`
sin reiniciar ni relajar aislamiento. Completar los controles F1 restantes.
Después: revisión independiente, aprobación, migración/publicación revisadas
y prueba real desde el dominio. Solo entonces continuar F2, F3, F4 y F5 con
sus propios reportes y criterios de aceptación; no saltarse fases para afirmar
que el editor admite cualquier documento.
