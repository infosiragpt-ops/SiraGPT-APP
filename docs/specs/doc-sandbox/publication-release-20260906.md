# F1 — publicación coherente y negativas conservadoras, 2026-09-06

**PR #561 en borrador, sin merge ni despliegue. No cierra F1.** Lote posterior a
`43b4f5800802d0181f347a552aac6cef7a6101bf`, con base `production-main`
verificada en `81f3d9a63150d241f2b22fa4b34ac98b4558a3e3`.

## 1. Qué se implementó

- `publishValidated` exige exactamente un artefacto `edit_plan` del intento
  vigente, no purgado, con clave y SHA-256 iguales al plan congelado en la fila
  bloqueada. Rechaza discrepancias antes de publicar o modificar el estado.
  Conserva la rama `done` idempotente, SQL, reloj, leases y orden del IO.
- `createConservativeBundle` descarta únicamente advertencias vacías accesorias
  de una negativa válida. Valida primero los límites originales de 100 entradas
  y 2000 caracteres por entrada; exige al menos un motivo útil, conserva su texto
  exacto y no modifica el array de entrada ni los documentos originales.
- Tres regresiones de persistencia y tres unitarias estrictas nuevas. El control
  positivo de persistencia ahora congela y registra la misma clave de plan.

El procesador ya conserva un único `planRecord` propio y filtra planes del
proveedor. El primer hallazgo es una debilidad del contrato interno de
publicación, no un exploit público demostrado. No cambian frontend, API pública,
migraciones, dependencias, configuración ni el procesador.

## 2. Reproducción antes y después

**Publicación:** con el repositorio aún sin modificar, las tres pruebas nuevas
fallaron por `Missing expected rejection.`: clave distinta con hash correcto,
hash distinto con clave correcta y plan adicional incongruente junto al correcto.
Resultado previo: **49 pruebas, 46 pasan, 3 fallan, 0 omitidas**. Tras las dos
líneas de guarda: **49/49**, 0 fallos ni omisiones. Las regresiones comprueban
snapshot completo, estado, fence, artefactos, eventos y visibilidad sin cambios
tras el rechazo. El control positivo conserva publicación atómica e idempotencia.

Evidencia privada local, con datos sintéticos nuevos en cada ejecución:

```text
/private/tmp/siragpt-phase1-publication-23CkXH/tests.tap   # pre-fix
/private/tmp/siragpt-phase1-publication-6nZIQ4/tests.tap   # post-fix
```

**Negativas:** una respuesta admitida por el schema y el clasificador, como
`["Cannot preserve the requested change.", ""]`, causaba `E_VALIDATION` al
conservar los originales. El procesador podía tratarla como un fallo reintentable.
Suite focal previa: **8 pruebas, 6 pasan, 2 fallan**. Tras normalizar en el bundle:
**8/8**, 0 omisiones. Comprueba ambas fases, motivos todos vacíos, límites antes
del filtrado, texto útil exacto, no mutación, bytes y hashes de todos los originales.
Evidencia: `/private/tmp/siragpt-refusal-warnings.yrFLxu/{pre-fix,post-fix}.log`.

No se sustituyeron DB, Redis, almacenamiento ni validadores por mocks. Los gates
aportados a la prueba de persistencia son metadata del contrato del repositorio,
no un certificado de validación de Office. Las negativas usan schema,
clasificador, Buffer, SHA y Python reales; no simulan un job documental completo.

## 3. Validación del lote

Node **24.19.0**, `PATH=/Users/luis/.local/node/bin:$PATH`. Desde la raíz:

```text
npm --prefix backend run test:doc-sandbox:coverage
tests 339; pass 339; fail 0; cancelled 0; skipped 0
Statements/Lines 72.48% (2571/3547)
Branches 86.39% (1111/1286); Functions 75.07% (259/345)
exit 1: Coverage for lines (72.48%) does not meet global threshold (80%)
npm --prefix backend run test:doc-sandbox:auxiliary
tests 16; pass 16; fail 0; skipped 0; exit 0
npm --prefix backend run type-check:doc-sandbox
exit 0
npm run type-check
exit 0
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
exit 0
NODE_ENV=test node --require ./tests/register-ts-paths.cjs --test --test-reporter=spec --test-reporter-destination=output/phase1-publication-root-tests-node24.log '.test-dist/tests/**/*.test.js'
tests 12465; suites 534; pass 12465; fail 0; skipped 0
duration_ms 63340.758042; exit 0
npm run lint
exit 0; 48 advertencias heredadas, mismo conteo que el lote anterior
bash scripts/verify-ui-lock.sh
UI lock verified — zero changes to frontend files; exit 0
git diff --check
exit 0
```

Logs locales: `output/phase1-publication-*-node24.log` y
`output/phase1-publication-*-typecheck.log`. Una revisión independiente de ambos
diffs no encontró bloqueantes; comprobó límites, originalidad de bytes,
transacción, intento vigente, plan congelado y rama idempotente. Sus repeticiones
focales no se suman a los conteos. TypeScript estricto focal de las pruebas pasa.
El control de secretos del repositorio pasa sobre los siete archivos del lote;
no se incluyeron logs privados, contraseñas ni archivos de entorno en Git.

## 4. Integración real aislada

PostgreSQL **17.10** y Redis **7.2.10** nuevos, efímeros y sólo loopback:

```text
# Desde backend, con variables exclusivamente sintéticas del harness:
node --import tsx --test --test-concurrency=1 tests/doc-sandbox-persistence.integration.test.ts tests/doc-sandbox-persistence.queue.test.ts tests/doc-sandbox-readiness-queue-recovery.integration.test.ts
tests 49; pass 49; fail 0; cancelled 0; skipped 0; todo 0
duration_ms 1612.252375; exit 0
```

El harness local usa el loader tsx absoluto y reporter TAP. Crea directorios
0700, logs privados, contraseñas sintéticas, puertos nuevos y verifica versión,
directorio y PID. No carga `.env` ni bases existentes. Las dos ejecuciones
confirman `servicesStopped: true` y `cleanupErrors: []`; todos sus procesos
finalizan. Se conserva evidencia privada local, no se publica la contraseña.
SHA-256 del harness revisado:
`0994136f1be70b13f2a06149bede7635aa519c2a17cef02fc8fab4252a5b1e7e`.

Esto prueba contratos de repositorio y cola, no un E2E documental ni el ensayo
migratorio de PostgreSQL 16. No usa Docker, R2, gVisor ni modelos de pago.

## 5. Decisión y cobertura

D26: la coherencia del plan es condición de publicación transaccional; una
negativa canónicamente válida no se transforma en error por entradas vacías
accesorias. No confiar en el tipo de artefacto sin su identidad congelada.

El porcentaje estricto sigue en **72,48 %**, ahora **2571/3547**: las cinco líneas
ejecutadas adicionales y las dos guardas de repositorio amplían el denominador.
Quedan **976 líneas sin ejecutar** y faltan al menos **267** cubiertas para
2838/3547 (80 %). Las 49 integraciones no se incorporan a cobertura unitaria.
No se cambian umbral, fuentes, exclusiones, aserciones ni comandos de CI.

El CI del commit anterior `43b4f580…` terminó: run `34043534371`, frontend y
demás pruebas completadas correctamente; shard 1 falla sólo por el 80 % y el
agregador obligatorio falla en consecuencia. Los tres workflows nativos pasan.
Es evidencia del commit anterior, no del nuevo diff ni de producción.

## 6. Límites y siguiente hallazgo

- Inspección de código: el validador devuelve `text_diff` y miniaturas incluso
  al fallar. En `processor.ts`, `OutputValidationFailure` ocurre antes del bucle
  de persistencia exitoso; el `catch` excluye `report.artifacts` y conserva sólo
  el JSON. Falta reproducir y corregir la retención privada de esa evidencia con
  un validador real y dependencias reales. No se presenta como regresión integrada
  demostrada ni se cambió el procesador en este lote.
- La auditoría de reconciliación no demostró otro defecto. No se modifica
  limpieza únicamente para mejorar cobertura.
- No se repitieron goldens, R2, runtime Linux completo ni E2E autenticado. El Mac
  usa procesos de prueba, no aislamiento gVisor/cgroups. No ejecuta código
  generado ni documentos de usuarios.
- Producción no fue modificada ni revalidada. Gasto nuevo Anthropic: **US$0**.
  Acceso administrativo, configuración, migración/recuperación y muestras
  representativas siguen sujetos a los controles del checkpoint.

## 7. Aceptación

- ✅ Fallos reproducidos antes del arreglo y regresiones aprobadas después.
- ✅ 339 unitarias estrictas, 16 auxiliares, 12465 generales; cero omisiones.
- ✅ 49 integraciones reales separadas, servicios cerrados y revisión independiente.
- ✅ Tipos y UI-lock; lint sin advertencias nuevas, no sin advertencias.
- ❌ 80 %, goldens, E2E, migración y recuperación completas, cierre de F1.
- ❌ Merge, activación y publicación en siragpt.com.

## 8. Continuación

Subir únicamente a `feat/doc-sandbox-fase-1` y mantener #561 en borrador.
Revisar el CI del commit resultante, sin anunciar como regresión el fallo
exclusivo del umbral ya conocido. Ante otro fallo, detener cualquier avance de
publicación y reproducir/corregir su causa en el borrador; no saltar controles.
Próximo lote: reproducir la pérdida de
evidencia de validación fallida con TXT sintético (solicitar 2026→2027 y observar
2028), probar retención privada sin publicar outputs, y diseñar la corrección
antes de implementarla. No simular validadores o persistencia para contabilizar
cobertura estricta. No producción, reinicios, F2 ni gasto de proveedor.
