# F1 — retención privada de evidencia rechazada

2026-09-07 UTC. **PR #561 en borrador, no desplegada; F1 no está cerrada.**
Base del lote: `eaef4182f909a4122e33d7cbb55f54a3a0c5e673`.

## 1. Cambio y alcance

El catch real del procesador ahora conserva el diff y las miniaturas de su
informe independiente antes de registrar el fallo. No conserva candidatos ni
publica outputs por esta recuperación. Se extrajo `handleFailure` privado;
antes del arreglo, su cuerpo se contrastó con el catch previo mediante AST
TypeScript y revisión independiente. No se añadió endpoint ni validador alterno.

La política pura acepta sólo los nombres/kinds/MIME del validador existente:
`text-diff.json`, `before/after[-notes]-N.png`, o sus prefijos `input-N-` en
preservación. Máximo 1001 piezas y 16 MiB por validación completada, 10 MiB
por pieza; hasta diez grupos. El worker determina los grupos por las llamadas
de validación terminadas, no por el número de documentos adjuntos. Nunca se
trunca la evidencia ni se transfiere el presupuesto de un grupo a otro.

Se verifican bytes/SHA antes del primer PUT; reserva previa, GCM, heartbeat y
compensación siguen en `persist`. Una única señal de 15 segundos acota el IO
de todas las piezas y su compensación. Si vence, no se concede otro plazo por
archivo ni se confirma una purga no respondida. El diario de claves permanece
para recuperación/limpieza. **No es un SLA total de 15 segundos para SQL**:
Prisma conserva su timeout transaccional y el reloj DB se revalida antes de
la transición. Esta precisión sucede al diseño preliminar de D27.

`failAttempt` recibe opcionalmente evidencia y modo. En una transacción exige
lease vigente, claves previamente reservadas, ámbito exacto de usuario/job,
sin purga/alias de originales/plan/instrucciones ni IDs/keys ocupados. Inserta
metadatos en lotes de 500; evidencia con `published=false`, informe con la
visibilidad previa, transición y outbox atómicos. La clave del informe procede
del snapshot previo a await. Los callers antiguos de sólo informe mantienen
su contrato. No se cambia esquema, proveedor, diseño visual ni permisos.

## 2. Reproducción y prueba real

El exportador ejecutó el Python real dos veces sobre TXT sintético: original
`2026`, plan exacto `2027`, candidato incorrecto `2028` y control correcto
`2027`. El bundle incluye stdout/diff reales y hashes de las tres fuentes.
Se escribió EXCL/0600 en directorio 0700. El lector rechaza rutas ambiguas,
symlinks, no-regulares, crecimiento, hashes alterados y fuentes distintas
antes de abrir PostgreSQL o S3. No genera una respuesta de sustitución.

Comando local (Node 24.19.0, Python bundled):

```text
DOC_SANDBOX_TEST_PYTHON=<python absoluto> node --import tsx \
  tests/helpers/doc-sandbox-failure-evidence-bundle.ts <directorio 0700>/failure-evidence.json
exit 0
SHA256 676c7bd19ed0e634be40c85df09a7d661898e6333fcde32832cb9c44bb94f6cd
```

El mismo SHA se comprobó después de SCP y se pasó externamente a la prueba.
Las fuentes helper/exportador/validator no cambiaron entre pre y post.
Candidata Linux exclusiva:
`/home/user/deployments/doc-sandbox-phase1-tests/candidate-failure-20260906-XXHKcgmn`.

```text
bash infra/doc-validation/run-isolated-failure-retention.sh <candidata> <bundle> <SHA256>
pre-fix: 4 tests; pass 3; fail 1; skipped 0; duration_ms 4308.45901; exit 1
error: DOC_TEST_FAILED_DIFF_MISSING_AFTER_REPORT_SAVED; actual 0; expected 1
post-fix: 7 tests; pass 7; fail 0; skipped 0; duration_ms 7901.629805; exit 0
```

El pre-fix guardó realmente el informe y sólo después falló por diff ausente.
Los cuatro casos originales se conservaron; los tres nuevos añaden hash
incorrecto sin writes, cinco rechazos de reserva/propiedad/identidad sin
commit parcial y leases vencidos/fenced-out. Los snapshots incluyen estado,
eventos, metadatos y claves; originales y vecino se recuperan byte a byte.
El diff aceptado por el handler se obtiene desde GCM real, con hash/tamaño
exactos y `published=false`, sin outputs ni consumo/referencias del proveedor.

Se usaron PostgreSQL/Redis/MinIO de test, red interna y cero puertos publicados.
Runner Node 22.23.2 por imagen
`sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e`,
1 CPU/1 GiB, usuario 1000, readonly, capacidades retiradas. El script nuevo
controla timeout externo, CID propio y los IDs verificados de servicios;
intenta detenerlos todos aun si uno falla y conserva el error de ejecución.
Un primer lanzamiento falló antes de las pruebas por opciones GNU de timeout
no admitidas por BusyBox; se corrigió a sintaxis compatible y no se contó como
reproducción del defecto. No hubo escrituras en producción.

## 3. Verificaciones de código

```text
npm --prefix backend run type-check:doc-sandbox
exit 0
npm run type-check
exit 0
npm run lint
exit 0, advertencias heredadas
bash scripts/verify-ui-lock.sh
exit 0, cero cambios de UI
npm --prefix backend run test:doc-sandbox:coverage
368/368, 0 skip, duration_ms 1427.418
Lines/Statements 72.20% (2741/3796)
Branches 86.10% (1202/1396); Functions 76.13% (268/352)
exit 1: umbral de líneas 80% no satisfecho
```

La primera ejecución restringida del Mac no pudo abrir su HTTP loopback
(`EPERM`); no se usó esa medición parcial. La repetición autorizada pasó
todos los casos y falló únicamente el umbral indicado. Las quince pruebas
de política usan metadatos declarados, no acreditan bytes ni PUT de 10010
objetos. Integraciones y oráculo Python quedan fuera de cobertura estricta.
El contrato de CI focal es 7/7; obliga a exportar el bundle real, fijar SHA y
ejecutar la retención separada sin omisiones ni relajación del 80%.

Logs locales de ejecución: `output/phase1-failure-retention-postfix.log`,
`output/phase1-failure-retention-unit-coverage.log`,
`output/phase1-failure-retention-root-tests.log` y
`output/phase1-failure-retention-regression.log`. No se suman repeticiones.
El fallo pre-fix consta en la salida de la sesión, no en un log reconstruido.

Regresión final PostgreSQL/Redis/MinIO con el código corregido: **79/79**,
cero omisiones, `duration_ms 157770.222321`, exit 0, mediante
`run-isolated-integration.sh` sobre la misma candidata. Incluye la purga de
10003 objetos de D30, no se confunde con guardar 10010 evidencias en 15 s.
Suite general final recompilada: **12472/12472**, 535 suites, cero omisiones,
`duration_ms 59101.3415`, exit 0. Se descarta la ejecución general anterior
de 12471 casos porque precedía al séptimo contrato de CI.
Al terminar se comprobaron PostgreSQL, Redis y MinIO de test detenidos,
con etiqueta de ámbito esperada y cero puertos; ningún runner quedó activo.

## 4. Decisiones y revisión

D31 en `decisiones.md` sucede a D27 conservando su registro histórico.
Revisión independiente de política, extracción, evidencia transportada,
persistencia, runner y contratos CI. Se corrigieron el snapshot mutable de
la clave del informe, cleanup del runner, timeout BusyBox y una colisión de
PK de la fixture antes de cerrar las pruebas finales. No se aceptó evidencia
simulada como sustituto del validador o de PostgreSQL/MinIO reales.

Guías aplicadas: `release-orchestrator`, `quality-gates`, `secret-safety`,
`agent-validation` y `technical-docs` de `.agents/skills`.

## 5. Límites y continuidad

Consulta pública y checkout Lenovo limpio coinciden en
`100d29bc2e76bf2fb6e875514112f5cae1e40025` (#571), readiness saludable a
**2026-09-07T00:23:40.840Z**. No contienen #561. El CI del commit base
`eaef4182…` terminó: almacenamiento privado **34/34**, con 10003 objetos
purgados en una pasada; cobertura estricta **72,96%**, insuficiente. Run
`34067795895` falló por ese gate y el agregador; las verificaciones nativas
finalizaron con éxito. El nuevo lote necesita su propio CI después del push.

Este ensayo comprueba **el tramo privado de fallo**, no `process()` entero,
Anthropic remoto, aislamiento runsc, render Office o edición desde el chat.
No se verificaron aún cancel/delete durante PUT, deadline de almacenamiento
vencido, expiración durante INSERT, tres intentos completos, máximo de
10010 objetos en la ventana de IO ni cleanup de este lote fallido por el
scheduler. El ensayo paginado D30 es complementario, no prueba esas carreras.
No se confirma la matriz de aceptación completa de D27 ni el cierre de F1.

Siguen pendientes el 80%, preflight real del host/gVisor, configuración privada
R2, límite efectivo del proveedor, historial/ensayo migratorio revisado,
goldens/concurrencia y E2E autenticado. Los bloqueos de infraestructura son
los de la última inspección documentada: no se vuelven a etiquetar como
comprobaciones frescas. Sin gasto del proveedor en este lote. No se publica
con CI rojo, no se omiten guards ni se cambia DNS/reinicia producción.
