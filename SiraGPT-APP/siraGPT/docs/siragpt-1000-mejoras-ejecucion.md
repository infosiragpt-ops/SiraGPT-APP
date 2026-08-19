# Ejecucion profesional de las 1000 mejoras internas

Este tracker registra lotes realmente implementados y validados en el estado actual del repo. No se marca ningun lote como cerrado sin cambio concreto, prueba automatizada y verificacion local.

## Reglas de ejecucion

- Ejecutar por lotes pequenos, revisables y reversibles.
- Mantener la interfaz estable salvo solicitud explicita de UI.
- Priorizar seguridad, estabilidad de chat, pruebas, observabilidad y despliegue seguro.
- Validar con type-check, pruebas focalizadas y smoke local cuando aplique.
- No introducir secretos ni logs con datos sensibles.

## Lote 26: ayuda CLI extendida del doctor local

- Estado: implementado y validado.
- Mejora cubierta: hacer el doctor local autosuficiente para uso por humanos y scripts sin revisar codigo fuente.
- Cambio: se agregaron `scripts/local-chat-readiness.js` y `scripts/local-chat-recovery.js`, con `npm run smoke:local-chat` y `npm run doctor:local-chat`.
- Control: `scripts/local-chat-recovery.js --help` documenta opciones, reportes, limpieza, rutas configurables y codigos de salida.
- Control: la ayuda explica que los reportes redaccionan passwords y bearer tokens y solo reportan presencia de variables.
- Control: los codigos `0`, `1`, `31`, `32`, `33` y `34` quedan visibles desde la CLI.
- Pruebas: se agrego `tests/scripts/local-chat-recovery.test.ts` para comandos de recuperacion, redaccion, escritura, limpieza y ayuda CLI.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run doctor:local-chat -- --help`, `npm run doctor:local-chat` con salida `32` por backend local caido y suite completa.

## Lote 27: contrato JSON versionado para CI local

- Estado: implementado y validado.
- Mejora cubierta: permitir que consumidores automaticos detecten cambios incompatibles en la salida compacta del doctor/readiness.
- Cambio: `scripts/local-chat-readiness.js` exporta `CI_SUMMARY_SCHEMA_VERSION` e incluye `schemaVersion` en `--summary-json`.
- Control: `scripts/local-chat-recovery.js` hereda la misma version en su resumen compacto.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para fijar `schemaVersion=1` en readiness y recovery.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run doctor:local-chat -- --summary-json` con `schemaVersion=1` y suite completa.

## Lote 28: resumen de fallo primario para automatizacion local

- Estado: implementado y validado.
- Mejora cubierta: reducir parsing externo cuando una automatizacion solo necesita saber el bloqueo principal y la primera accion recomendada.
- Cambio: `scripts/local-chat-readiness.js` agrega `primaryFailure` al JSON compacto.
- Cambio: `scripts/local-chat-recovery.js` agrega `primaryAction` al JSON compacto del doctor.
- Control: `primaryFailure` ignora advertencias no bloqueantes y usa el primer check requerido fallido.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para `primaryFailure`, `primaryAction` y advertencias.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run doctor:local-chat -- --summary-json` con `primaryFailure=backend_auth` y `primaryAction=backend_dev_server`, y suite completa.

## Lote 29: seccion primaria en reporte Markdown

- Estado: implementado y validado.
- Mejora cubierta: hacer que el reporte Markdown sea accionable sin leer tablas completas.
- Cambio: `scripts/local-chat-recovery.js` agrega `Primary failure` y `Primary action` al reporte `--markdown`.
- Control: los campos provienen del contrato compacto ya saneado y no agregan secretos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar ambos campos.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run doctor:local-chat -- --markdown --timeout-ms 1000` y suite completa.

## Lote 30: deteccion segura de `.env.local`

- Estado: implementado y validado.
- Mejora cubierta: evitar falsos warnings cuando `.env.local` existe pero las variables no estan exportadas al proceso.
- Cambio: `scripts/local-chat-readiness.js` lee `.env.local` y registra solo presencia/fuente de `NEXT_PUBLIC_API_URL` y `SIRAGPT_LOCAL_API_URL`.
- Control: no serializa valores reales de entorno ni URLs internas del archivo.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para parseo seguro y ausencia de fuga de valores.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 31: timeout configurable para probes locales

- Estado: implementado y validado.
- Mejora cubierta: permitir diagnosticos rapidos o tolerantes segun el estado de compilacion local.
- Cambio: `scripts/local-chat-readiness.js` y `scripts/local-chat-recovery.js` aceptan `--timeout-ms <n>`.
- Control: el timeout se aplica por probe y conserva errores normalizados `timeout` o `request_error`.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para parsing de timeout.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run doctor:local-chat -- --markdown --timeout-ms 1000` y suite completa.

## Lote 32: modo estricto de entorno local

- Estado: implementado y validado.
- Mejora cubierta: permitir que CI local bloquee si falta configuracion explicita de API.
- Cambio: `--strict-env` convierte `local_env` de advertencia a check requerido.
- Control: el doctor recomienda crear `.env.local` sin imprimir valores y usa codigo de salida `35`.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para codigo de salida y parsing.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run doctor:local-chat -- --summary-json --strict-env --timeout-ms 1000` y suite completa.

## Lote 33: resumen compacto de fallos y detalles de acciones

- Estado: implementado y validado.
- Mejora cubierta: dar a automatizaciones un motivo corto por check y la descripcion de la accion recomendada.
- Cambio: `--summary-json` incluye `failureSummary` y cada accion incluye `detail`.
- Control: los motivos son rutas/fallos normalizados, sin cuerpos HTML ni secretos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para `failureSummary` y `actions[].detail`.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run doctor:local-chat -- --summary-json --strict-env --timeout-ms 1000` y suite completa.

## Lote 34: codigo de salud resumido

- Estado: implementado y validado.
- Mejora cubierta: dar a dashboards locales un estado estable sin parsear listas de checks.
- Cambio: `scripts/local-chat-readiness.js` agrega `healthCode` al JSON compacto.
- Control: `healthCode` usa valores discretos como `ready`, `frontend_down`, `backend_down`, `env_missing` o `blocked`.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para `healthCode=backend_down`.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run smoke:local-chat:json` con `healthCode=backend_down` y suite completa.

## Lote 35: modo quiet para automatizaciones shell

- Estado: implementado y validado.
- Mejora cubierta: permitir scripts shell simples que solo necesitan estado y accion principal.
- Cambio: `scripts/local-chat-recovery.js` acepta `--quiet` y emite `healthCode primaryAction`.
- Control: no imprime tablas, cuerpos, URLs internas de `.env.local`, tokens ni passwords.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para parsing de `--quiet`.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run doctor:local-chat -- --quiet --timeout-ms 1000` con salida `backend_down backend_dev_server` y suite completa.

## Lote 36: mapa JSON de codigos de salida

- Estado: implementado y validado.
- Mejora cubierta: hacer consumible el contrato de exit codes sin leer la ayuda humana.
- Cambio: `scripts/local-chat-recovery.js` acepta `--exit-codes-json` y devuelve el mapa estable sin ejecutar probes.
- Control: el mapa no contiene secretos ni depende del entorno local.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para `RECOVERY_EXIT_CODE_LABELS`.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run doctor:local-chat -- --exit-codes-json` y suite completa.

## Lote 37: ejemplos operativos en ayuda CLI

- Estado: implementado y validado.
- Mejora cubierta: reducir errores de uso al ejecutar diagnosticos con timeout o reporte persistente.
- Cambio: `--help` incluye ejemplos para `--summary-json --timeout-ms 1000` y `--write-report`.
- Control: los ejemplos usan rutas locales no sensibles y placeholders seguros.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para validar la seccion `Examples`.
- Verificacion: `npm run type-check`, prueba focalizada, cobertura de `usage()` y suite completa.

## Lote 38: scripts npm dedicados para diagnostico local

- Estado: implementado y validado.
- Mejora cubierta: acelerar ejecuciones repetidas sin recordar flags largos.
- Cambio: se agregaron `smoke:local-chat:json` y `doctor:local-chat:report` a `package.json`.
- Control: el reporte mantiene redaccion de secretos y escribe bajo `tmp/` por defecto.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar los scripts registrados.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run smoke:local-chat:json`, `npm run doctor:local-chat:report` y suite completa.

## Lote 39: perfiles locales de diagnostico

- Estado: implementado y validado.
- Mejora cubierta: estandarizar ejecuciones `default`, `fast` y `ci` sin repetir combinaciones de flags.
- Cambio: `scripts/local-chat-readiness.js` y `scripts/local-chat-recovery.js` aceptan `--profile <name>`.
- Control: `fast` usa timeout bajo; `ci` activa timeout estable y `strictEnv`.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para perfiles y precedencia de timeout explicito.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run doctor:local-chat:quiet`, `npm run doctor:local-chat:ci`, `npm run smoke:local-chat:ci` y suite completa.

## Lote 40: catalogo JSON de checks locales

- Estado: implementado y validado.
- Mejora cubierta: permitir que integraciones descubran checks disponibles sin ejecutar probes de red.
- Cambio: `scripts/local-chat-recovery.js` acepta `--list-checks-json` y devuelve contrato con version, perfiles y checks.
- Control: el catalogo contiene descripciones operativas y no contiene credenciales ni valores de entorno.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para fijar nombres y ausencia de secretos.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run doctor:local-chat -- --list-checks-json` y suite completa.

## Lote 41: validacion estricta de opciones numericas

- Estado: implementado y validado.
- Mejora cubierta: evitar diagnosticos ambiguos cuando se pasa un timeout o retencion invalida.
- Cambio: `--timeout-ms` y `--max-report-age-hours` rechazan valores no enteros positivos.
- Control: los errores ocurren antes de ejecutar probes o escribir reportes.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para valores invalidos y perfiles desconocidos.
- Verificacion: `npm run type-check`, prueba focalizada con valores invalidos y suite completa.

## Lote 42: redaccion ampliada de secretos en reportes

- Estado: implementado y validado.
- Mejora cubierta: reducir riesgo de fuga accidental en diagnosticos compartidos.
- Cambio: el reporte Markdown redacciona credenciales embebidas en URLs y `NPM_TOKEN`.
- Control: mantiene la redaccion existente de passwords de login y bearer tokens.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para URL con usuario/password y token npm.
- Verificacion: `npm run type-check`, prueba focalizada, `npm run doctor:local-chat:report` y suite completa.

## Lote 43: atajos npm para perfiles locales

- Estado: implementado y validado.
- Mejora cubierta: acelerar diagnosticos repetibles para terminal y CI local.
- Cambio: se agregaron `smoke:local-chat:ci`, `doctor:local-chat:quiet` y `doctor:local-chat:ci` a `package.json`.
- Control: los scripts reutilizan perfiles versionados y no contienen secretos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar los scripts registrados.
- Verificacion: `npm run type-check`, prueba focalizada, scripts reales de perfil local y suite completa.

## Lote 44: tiempos de probes locales

- Estado: implementado y validado.
- Mejora cubierta: exponer latencia de diagnosticos para detectar lentitud local o compilacion pendiente.
- Cambio: `scripts/local-chat-readiness.js` registra `durationMs` por probe/check y agrega `latencySummary` al JSON compacto.
- Cambio: `scripts/local-chat-recovery.js` muestra `Slowest probe` y tabla de latencias en el reporte Markdown.
- Control: los tiempos se agregan sin incluir cuerpos de respuesta, credenciales ni valores reales de entorno.
- Control: el exit code ya no permite que un warning de `local_env` no requerido oculte un fallo requerido de backend/frontend.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para duraciones, probe mas lento, Markdown de latencias y prioridad de exit code.
- Verificacion: `npm run type-check`, prueba focalizada, `node scripts/local-chat-readiness.js --summary-json --timeout-ms 1000`, `node scripts/local-chat-recovery.js --markdown --timeout-ms 1000`, `npm test` y `npm run lint`.

## Lote 45: contadores compactos de checks

- Estado: implementado y validado.
- Mejora cubierta: permitir dashboards locales sin recalcular conteos desde arrays.
- Cambio: `--summary-json` incluye `totalChecks`, `failedRequiredCount` y `warningCount`.
- Control: los contadores derivan del mismo contrato versionado.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para conteos requeridos y warnings.
- Verificacion: `npm run type-check`, prueba focalizada, JSON real con `totalChecks=3`, `failedRequiredCount=1`, `warningCount=0` y suite completa.

## Lote 46: codigo de salida en resumen y Markdown

- Estado: implementado y validado.
- Mejora cubierta: hacer visible el resultado operativo sin depender solo del exit status del proceso.
- Cambio: `scripts/local-chat-recovery.js` agrega `exitCode` al resumen compacto y al reporte Markdown.
- Control: el valor se calcula con la misma funcion que devuelve el proceso.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para `exitCode=32`.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:report` con `Exit code: 32` y suite completa.

## Lote 47: saneamiento de URLs en salidas

- Estado: implementado y validado.
- Mejora cubierta: evitar fuga de userinfo si una URL local contiene usuario/password.
- Cambio: `scripts/local-chat-readiness.js` sanea `frontendUrl`, `apiUrl` y lineas humanas de checks.
- Control: la URL usada para probe se conserva internamente; solo se limpia la salida.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para URLs con credenciales.
- Verificacion: `npm run type-check`, prueba focalizada con URLs con userinfo, JSON real saneado y suite completa.

## Lote 48: atajo npm para catalogo de checks

- Estado: implementado y validado.
- Mejora cubierta: consultar el contrato de checks sin recordar el flag largo.
- Cambio: se agrego `doctor:local-chat:checks` a `package.json`.
- Control: ejecuta `--list-checks-json` sin probes ni secretos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar el script.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:checks` y suite completa.

## Lote 49: probe real de login local

- Estado: implementado y validado.
- Mejora cubierta: verificar `/api/auth/login` solo cuando se solicite explicitamente.
- Cambio: `scripts/local-chat-readiness.js` acepta `--require-login` y ejecuta POST con `SIRAGPT_TEST_EMAIL` y `SIRAGPT_TEST_PASSWORD`.
- Control: el probe no imprime password ni cuerpo de respuesta.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para login exitoso con fetch simulado.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run smoke:local-chat:login` y suite completa.

## Lote 50: clasificacion de credenciales faltantes

- Estado: implementado y validado.
- Mejora cubierta: diferenciar backend caido de credenciales de prueba ausentes cuando el login es requerido.
- Cambio: el endpoint `/api/auth/login` queda bloqueado con `missing_credentials` si faltan variables de prueba.
- Control: la clasificacion reutiliza el codigo de salida `33` cuando aplica.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para credenciales faltantes.
- Verificacion: `npm run type-check`, prueba focalizada con `missing_credentials` y suite completa.

## Lote 51: ayuda CLI para login smoke

- Estado: implementado y validado.
- Mejora cubierta: documentar el flujo de login local sin exponer passwords.
- Cambio: `--help` documenta `--require-login` y ejemplo con placeholder `<password>`.
- Control: la ayuda no contiene secretos reales.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para el texto de ayuda.
- Verificacion: `npm run type-check`, prueba focalizada sobre `usage()` y suite completa.

## Lote 52: soporte de entorno inyectado para probes

- Estado: implementado y validado.
- Mejora cubierta: facilitar pruebas y automatizaciones sin depender siempre de `process.env`.
- Cambio: `runReadiness` y `checkBackend` usan `options.env` para URLs y credenciales de login.
- Control: los resultados siguen redaccionados y no persisten credenciales.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` con entorno inyectado.
- Verificacion: `npm run type-check`, prueba focalizada con `options.env` y suite completa.

## Lote 53: scripts npm para login smoke

- Estado: implementado y validado.
- Mejora cubierta: ejecutar smoke de login sin recordar flags largos.
- Cambio: se agregaron `smoke:local-chat:login` y `doctor:local-chat:login` a `package.json`.
- Control: los scripts requieren credenciales por variables temporales y no contienen secretos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar los scripts.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:login` y suite completa.

## Lote 54: salida JSON compacta para CI

- Estado: implementado y validado.
- Mejora cubierta: emitir JSON de una linea para logs y parsers simples.
- Cambio: `scripts/local-chat-readiness.js` y `scripts/local-chat-recovery.js` aceptan `--compact-json`.
- Control: reutiliza el mismo contrato de `--summary-json`; solo cambia el formato.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para `formatJson` compacto.
- Verificacion: `npm run type-check`, prueba focalizada, `node scripts/local-chat-readiness.js --compact-json --timeout-ms 1000`, `node scripts/local-chat-recovery.js --compact-json --timeout-ms 1000` y suite completa.

## Lote 55: helper unico de serializacion JSON

- Estado: implementado y validado.
- Mejora cubierta: evitar divergencias entre salidas JSON de readiness y recovery.
- Cambio: se agregaron `formatJson` y `printJson` reutilizables en `scripts/local-chat-readiness.js`.
- Control: `--exit-codes-json`, `--list-checks-json`, `--summary-json` y `--json` respetan el mismo modo compacto.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para formato pretty y compacto.
- Verificacion: `npm run type-check`, prueba focalizada, comandos JSON compactos reales y suite completa.

## Lote 56: ayuda CLI para JSON compacto

- Estado: implementado y validado.
- Mejora cubierta: documentar ejecuciones limpias con `npm --silent` para consumidores automaticos.
- Cambio: la ayuda del doctor incluye `--compact-json` y ejemplo `npm --silent run doctor:local-chat:compact`.
- Control: la documentacion usa comandos sin secretos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para validar ayuda.
- Verificacion: `npm run type-check`, prueba focalizada sobre `usage()` y suite completa.

## Lote 57: scripts npm compactos

- Estado: implementado y validado.
- Mejora cubierta: ejecutar JSON compacto sin recordar flags.
- Cambio: se agregaron `smoke:local-chat:compact` y `doctor:local-chat:compact` a `package.json`.
- Control: los scripts no contienen secretos y son compatibles con `npm --silent`.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar scripts.
- Verificacion: `npm run type-check`, prueba focalizada, scripts compactos reales por `node` y suite completa.

## Lote 58: compactacion de metadatos sin probes

- Estado: implementado y validado.
- Mejora cubierta: permitir contratos compactos tambien para mapas estaticos.
- Cambio: `--exit-codes-json` y `--list-checks-json` respetan `--compact-json`.
- Control: no ejecuta probes y no imprime valores de entorno.
- Pruebas: se cubre mediante el helper JSON compartido y parsing de flags.
- Verificacion: `npm run type-check`, prueba focalizada, `node scripts/local-chat-recovery.js --exit-codes-json --compact-json`, `node scripts/local-chat-recovery.js --list-checks-json --compact-json` y suite completa.

## Siguientes lotes

## Lote 59: extraccion estable de puertos locales

- Estado: implementado y validado.
- Mejora cubierta: identificar puertos relevantes desde URLs locales normalizadas.
- Cambio: `scripts/local-chat-readiness.js` agrega `portFromUrl` con soporte de puertos explicitos y defaults HTTP/HTTPS.
- Control: no imprime userinfo ni valores de entorno.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para puertos explicitos y `https` default.
- Verificacion: `npm run type-check`, prueba focalizada con puertos explicitos/default y suite completa.

## Lote 60: diagnostico best-effort de listeners locales

- Estado: implementado y validado.
- Mejora cubierta: detectar si los puertos esperados tienen procesos escuchando.
- Cambio: `inspectPort` consulta `lsof` de forma local y tolerante a fallo.
- Control: errores de `lsof` no rompen el doctor; retornan puerto sin listener.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` con inspector inyectado.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:ports` y suite completa.

## Lote 61: flag `--inspect-ports`

- Estado: implementado y validado.
- Mejora cubierta: activar diagnostico de puertos solo cuando se necesite.
- Cambio: readiness y recovery aceptan `--inspect-ports` y agregan `portDiagnostics` al JSON.
- Control: no ejecuta inspeccion de puertos en el flujo normal.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para parsing y contrato JSON.
- Verificacion: `npm run type-check`, prueba focalizada, JSON real con `portDiagnostics` y suite completa.

## Lote 62: puertos en reporte Markdown

- Estado: implementado y validado.
- Mejora cubierta: hacer visible en el reporte si frontend/API tienen listeners locales.
- Cambio: `scripts/local-chat-recovery.js` agrega tabla `Port diagnostics` cuando existe `portDiagnostics`.
- Control: muestra solo puerto, estado y comandos saneados.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para tabla Markdown.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat -- --inspect-ports --markdown --timeout-ms 1000` y suite completa.

## Lote 63: script npm para diagnostico de puertos

- Estado: implementado y validado.
- Mejora cubierta: ejecutar inspeccion de puertos sin recordar flags.
- Cambio: se agrego `doctor:local-chat:ports` a `package.json`.
- Control: usa `--summary-json --inspect-ports` y no contiene secretos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar el script.
- Verificacion: `npm run type-check`, prueba focalizada, `doctor:local-chat:ports` y suite completa.

## Lote 64: estado normalizado por check

- Estado: implementado y validado.
- Mejora cubierta: evitar que consumidores infieran estados desde `ok` y `required`.
- Cambio: `scripts/local-chat-readiness.js` agrega `checkStatus` y `checks[].status` con `ok`, `warning` o `blocked`.
- Control: mantiene los campos existentes para compatibilidad.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para estados `ok`, `warning` y `blocked`.
- Verificacion: `npm run type-check`, prueba focalizada de estados y suite completa.

## Lote 65: conteos de estado en JSON compacto

- Estado: implementado y validado.
- Mejora cubierta: permitir dashboards sin recalcular severidades.
- Cambio: `--summary-json` agrega `statusCounts` y `overallStatus`.
- Control: `overallStatus` prioriza `blocked` sobre `warning` y `ok`.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para `statusCounts` y `overallStatus`.
- Verificacion: `npm run type-check`, prueba focalizada de `statusCounts` y suite completa.

## Lote 66: resumen minimo de estado

- Estado: implementado y validado.
- Mejora cubierta: entregar un contrato pequeño para monitores que no necesitan checks completos.
- Cambio: `scripts/local-chat-recovery.js` acepta `--status-json` y exporta `buildStatusSummary`.
- Control: el resumen no incluye acciones completas ni comandos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para validar el contrato minimo.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:status` y suite completa.

## Lote 67: estado normalizado en Markdown

- Estado: implementado y validado.
- Mejora cubierta: hacer que el reporte humano distinga `warning` de `blocked`.
- Cambio: el reporte Markdown agrega `Overall status` y usa `checks[].status` en la tabla.
- Control: conserva `Health code`, `Exit code` y acciones recomendadas.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para `Overall status`.
- Verificacion: `npm run type-check`, prueba focalizada sobre Markdown y suite completa.

## Lote 68: script npm de estado minimo

- Estado: implementado y validado.
- Mejora cubierta: consultar estado minimo con una linea compacta.
- Cambio: se agrego `doctor:local-chat:status` a `package.json`.
- Control: usa `--status-json --compact-json` y no imprime secretos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar el script.
- Verificacion: `npm run type-check`, prueba focalizada, script real `doctor:local-chat:status` y suite completa.

## Lote 69: conteo estable de acciones recomendadas

- Estado: implementado y validado.
- Mejora cubierta: exponer cuantas acciones recomienda el doctor sin contar arrays externamente.
- Cambio: `scripts/local-chat-recovery.js` agrega `actionCount` al resumen compacto.
- Control: el conteo usa acciones ya normalizadas.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para `actionCount`.
- Verificacion: `npm run type-check`, prueba focalizada de `actionCount` y suite completa.

## Lote 70: saneamiento de comandos en JSON compacto

- Estado: implementado y validado.
- Mejora cubierta: evitar fuga accidental de secretos tambien en salidas JSON de acciones.
- Cambio: `buildRecoveryCiSummary` sanea `actions[].command` antes de serializar.
- Control: reutiliza la misma redaccion de reportes Markdown.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` con password simulado.
- Verificacion: `npm run type-check`, prueba focalizada con password simulado y suite completa.

## Lote 71: contrato JSON solo de acciones

- Estado: implementado y validado.
- Mejora cubierta: permitir que integraciones lean acciones sin checks completos ni reportes humanos.
- Cambio: `scripts/local-chat-recovery.js` acepta `--actions-json` y exporta `buildActionsSummary`.
- Control: el contrato no incluye valores de entorno ni comandos sin sanear.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para claves del contrato.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:actions` y suite completa.

## Lote 72: acciones enriquecidas en Markdown

- Estado: implementado y validado.
- Mejora cubierta: mostrar titulo y detalle de cada accion recomendada en reportes humanos.
- Cambio: la tabla `Recommended actions` incluye `ID`, `Title`, `Command` y `Detail`.
- Control: los comandos de la tabla siguen redaccionados.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para la fila de backend.
- Verificacion: `npm run type-check`, prueba focalizada de Markdown y suite completa.

## Lote 73: script npm de acciones

- Estado: implementado y validado.
- Mejora cubierta: consultar acciones en JSON compacto con un comando corto.
- Cambio: se agrego `doctor:local-chat:actions` a `package.json`.
- Control: usa `--actions-json --compact-json` y no contiene secretos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar el script.
- Verificacion: `npm run type-check`, prueba focalizada, script real `doctor:local-chat:actions` y suite completa.

## Lote 74: codigos estables de remediacion

- Estado: implementado y validado.
- Mejora cubierta: identificar acciones recomendadas con codigos estables para integraciones.
- Cambio: `scripts/local-chat-recovery.js` agrega `remediationCode` a cada accion compacta.
- Control: los codigos no dependen del texto humano ni del idioma.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para `LOCAL_BACKEND_START`.
- Verificacion: `npm run type-check`, prueba focalizada para `LOCAL_BACKEND_START` y suite completa.

## Lote 75: severidad y categoria por accion

- Estado: implementado y validado.
- Mejora cubierta: priorizar acciones recomendadas sin parsear titulos.
- Cambio: cada accion compacta incluye `severity` y `category`.
- Control: las acciones desconocidas reciben valores seguros por defecto.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para acciones conocidas y desconocidas.
- Verificacion: `npm run type-check`, prueba focalizada para acciones conocidas/desconocidas y suite completa.

## Lote 76: catalogo JSON de remediaciones

- Estado: implementado y validado.
- Mejora cubierta: descubrir remediaciones disponibles sin ejecutar probes.
- Cambio: se agrego `--remediation-catalog-json` y `buildRemediationCatalog`.
- Control: el catalogo no contiene comandos, secretos ni valores de entorno.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para catalogo saneado.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:remediations` y suite completa.

## Lote 77: remediaciones enriquecidas en Markdown

- Estado: implementado y validado.
- Mejora cubierta: mostrar codigo, severidad y categoria en reportes humanos.
- Cambio: la tabla de acciones Markdown incluye `Code`, `Severity` y `Category`.
- Control: los comandos siguen redaccionados.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para la fila de backend enriquecida.
- Verificacion: `npm run type-check`, prueba focalizada de Markdown y suite completa.

## Lote 78: script npm de catalogo de remediaciones

- Estado: implementado y validado.
- Mejora cubierta: consultar remediaciones con un comando corto.
- Cambio: se agrego `doctor:local-chat:remediations` a `package.json`.
- Control: usa `--remediation-catalog-json --compact-json` y no ejecuta probes.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar el script.
- Verificacion: `npm run type-check`, prueba focalizada, script real `doctor:local-chat:remediations` y suite completa.

## Lote 79: origen estable de acciones por check

- Estado: implementado y validado.
- Mejora cubierta: vincular cada accion recomendada con el check que la origina.
- Cambio: `RECOVERY_ACTION_CATALOG` agrega `sourceCheck` para frontend, backend, login, entorno y estado listo.
- Control: las acciones desconocidas reciben `sourceCheck: unknown` sin secretos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para acciones conocidas y desconocidas.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 80: matriz JSON de checks y acciones

- Estado: implementado y validado.
- Mejora cubierta: entregar una matriz consumible por dashboards internos.
- Cambio: `scripts/local-chat-recovery.js` exporta `buildDiagnosticsMatrix`.
- Control: la matriz sanea comandos y separa acciones no mapeadas.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` con password simulado.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 81: bandera CLI para matriz JSON

- Estado: implementado y validado.
- Mejora cubierta: consultar la matriz desde CLI sin escribir codigo auxiliar.
- Cambio: se agrego `--matrix-json` a `scripts/local-chat-recovery.js`.
- Control: respeta `--compact-json` y conserva los codigos de salida existentes.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para parseo y ayuda.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:matrix` y suite completa.

## Lote 82: matriz de acciones en Markdown

- Estado: implementado y validado.
- Mejora cubierta: hacer visible la relacion check-accion en reportes humanos.
- Cambio: el reporte Markdown agrega la seccion `Check/action matrix`.
- Control: muestra identificadores y codigos estables, no valores de entorno.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para la fila de backend.
- Verificacion: `npm run type-check`, prueba focalizada de Markdown y suite completa.

## Lote 83: script npm de matriz local

- Estado: implementado y validado.
- Mejora cubierta: consultar la matriz de diagnostico con un comando corto.
- Cambio: se agrego `doctor:local-chat:matrix` a `package.json`.
- Control: usa `--matrix-json --compact-json` para salida estable de una linea.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar el script.
- Verificacion: `npm run type-check`, prueba focalizada, script real `doctor:local-chat:matrix` y suite completa.

## Lote 84: impacto por categoria de remediacion

- Estado: implementado y validado.
- Mejora cubierta: resumir que areas internas requieren accion sin parsear textos.
- Cambio: `buildActionImpactSummary` agrega `byCategory` y buckets por categoria.
- Control: el resumen no incluye comandos ni valores de entorno.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para frontend/backend.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 85: impacto por severidad de remediacion

- Estado: implementado y validado.
- Mejora cubierta: contar acciones criticas para priorizacion automatica.
- Cambio: `buildActionImpactSummary` agrega `bySeverity` y `criticalActionCount`.
- Control: usa la metadata estable del catalogo de acciones.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para severidad `critical`.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 86: bandera CLI de impacto

- Estado: implementado y validado.
- Mejora cubierta: consultar impacto de remediaciones desde CLI.
- Cambio: se agrego `--impact-json` a `scripts/local-chat-recovery.js`.
- Control: respeta `--compact-json` y los codigos de salida existentes.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para parseo y ayuda.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:impact` y suite completa.

## Lote 87: impacto en reporte Markdown

- Estado: implementado y validado.
- Mejora cubierta: mostrar categorias y severidades en diagnosticos humanos.
- Cambio: el reporte Markdown agrega la seccion `Action impact`.
- Control: lista solo IDs de acciones, no comandos ni secretos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para filas de categoria y severidad.
- Verificacion: `npm run type-check`, prueba focalizada de Markdown y suite completa.

## Lote 88: script npm de impacto local

- Estado: implementado y validado.
- Mejora cubierta: consultar impacto de remediaciones con un comando corto.
- Cambio: se agrego `doctor:local-chat:impact` a `package.json`.
- Control: usa `--impact-json --compact-json` para salida estable.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar el script.
- Verificacion: `npm run type-check`, prueba focalizada, script real `doctor:local-chat:impact` y suite completa.

## Lote 89: puntaje estable de prioridad

- Estado: implementado y validado.
- Mejora cubierta: priorizar acciones sin depender del texto humano.
- Cambio: cada accion enriquecida agrega `priorityScore` derivado de severidad.
- Control: las acciones desconocidas reciben prioridad media segura.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para acciones conocidas y desconocidas.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 90: maxima prioridad en resumen compacto

- Estado: implementado y validado.
- Mejora cubierta: identificar rapidamente las acciones mas urgentes.
- Cambio: el resumen compacto agrega `highestPriorityScore` y `highestPriorityActions`.
- Control: no cambia `primaryAction`, solo agrega metadata estable.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para backend critico.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 91: resumen JSON de prioridad

- Estado: implementado y validado.
- Mejora cubierta: entregar un contrato de triage sin comandos ejecutables.
- Cambio: se agrego `buildPrioritySummary` y la bandera `--priority-json`.
- Control: la salida lista IDs, codigos, severidad, categoria y puntaje, no comandos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para asegurar ausencia de comandos.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:priority` y suite completa.

## Lote 92: prioridad en reporte Markdown

- Estado: implementado y validado.
- Mejora cubierta: hacer visible la prioridad en diagnosticos humanos.
- Cambio: el reporte Markdown agrega `Highest priority` y columna `Priority`.
- Control: conserva redaccion de comandos y codigos estables.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para encabezado y fila de backend.
- Verificacion: `npm run type-check`, prueba focalizada de Markdown y suite completa.

## Lote 93: script npm de prioridad local

- Estado: implementado y validado.
- Mejora cubierta: consultar prioridad de remediaciones con un comando corto.
- Cambio: se agrego `doctor:local-chat:priority` a `package.json`.
- Control: usa `--priority-json --compact-json` para salida estable.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar el script.
- Verificacion: `npm run type-check`, prueba focalizada, script real `doctor:local-chat:priority` y suite completa.

## Lote 94: siguiente mejor accion saneada

- Estado: implementado y validado.
- Mejora cubierta: seleccionar la accion de mayor prioridad para recuperacion guiada.
- Cambio: se agrego `buildNextActionSummary` con `nextAction` saneada.
- Control: si hay empate conserva el orden recomendado por el doctor.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` con password simulado.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 95: razon estable de siguiente accion

- Estado: implementado y validado.
- Mejora cubierta: explicar por que se eligio una accion sin depender del texto humano.
- Cambio: `buildNextActionSummary` agrega `reason` como `sourceCheck:severity:priority`.
- Control: no incluye valores de entorno ni comandos sin sanear.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para `backend_auth:critical:100`.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 96: bandera CLI de siguiente accion

- Estado: implementado y validado.
- Mejora cubierta: consultar la siguiente accion desde CLI.
- Cambio: se agrego `--next-action-json` a `scripts/local-chat-recovery.js`.
- Control: respeta `--compact-json` y los codigos de salida existentes.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para parseo y ayuda.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:next-action` y suite completa.

## Lote 97: siguiente accion en Markdown

- Estado: implementado y validado.
- Mejora cubierta: hacer visible la accion inmediata en reportes humanos.
- Cambio: el reporte Markdown agrega la seccion `Next action`.
- Control: el comando se redacciona con el mismo saneamiento de reportes.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para la fila de backend.
- Verificacion: `npm run type-check`, prueba focalizada de Markdown y suite completa.

## Lote 98: script npm de siguiente accion

- Estado: implementado y validado.
- Mejora cubierta: consultar la siguiente accion con un comando corto.
- Cambio: se agrego `doctor:local-chat:next-action` a `package.json`.
- Control: usa `--next-action-json --compact-json` para salida estable.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar el script.
- Verificacion: `npm run type-check`, prueba focalizada, script real `doctor:local-chat:next-action` y suite completa.

## Lote 99: plan de ejecucion priorizado

- Estado: implementado y validado.
- Mejora cubierta: ordenar acciones por prioridad para recuperacion paso a paso.
- Cambio: se agrego `buildActionExecutionPlan`.
- Control: el orden conserva estabilidad cuando hay empate de prioridad.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` con acciones media y critica.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 100: numeracion estable de pasos

- Estado: implementado y validado.
- Mejora cubierta: permitir que automatizaciones referencien pasos por numero.
- Cambio: cada entrada del plan incluye `step` secuencial y `stepCount`.
- Control: los pasos se calculan despues de ordenar por prioridad.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para pasos 1 y 2.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 101: bandera CLI de plan

- Estado: implementado y validado.
- Mejora cubierta: consultar el plan priorizado desde CLI.
- Cambio: se agrego `--plan-json` a `scripts/local-chat-recovery.js`.
- Control: respeta `--compact-json` y codigos de salida existentes.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para parseo y ayuda.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:plan` y suite completa.

## Lote 102: plan de ejecucion en Markdown

- Estado: implementado y validado.
- Mejora cubierta: mostrar los pasos ordenados en reportes humanos.
- Cambio: el reporte Markdown agrega la seccion `Execution plan`.
- Control: los comandos del plan se redaccionan antes de imprimirse.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para la fila del paso 1.
- Verificacion: `npm run type-check`, prueba focalizada de Markdown y suite completa.

## Lote 103: script npm de plan local

- Estado: implementado y validado.
- Mejora cubierta: consultar el plan priorizado con un comando corto.
- Cambio: se agrego `doctor:local-chat:plan` a `package.json`.
- Control: usa `--plan-json --compact-json` para salida estable.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar el script.
- Verificacion: `npm run type-check`, prueba focalizada, script real `doctor:local-chat:plan` y suite completa.

## Lote 104: serializacion estable de diagnostico

- Estado: implementado y validado.
- Mejora cubierta: normalizar objetos antes de comparar resultados.
- Cambio: se agrego `stableJsonStringify` con orden alfabetico de claves.
- Control: no cambia las salidas existentes salvo al calcular huellas.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` con objeto reordenado.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 105: hash estable en resumen compacto

- Estado: implementado y validado.
- Mejora cubierta: detectar cambios reales en el diagnostico entre ejecuciones.
- Cambio: el resumen compacto agrega `diagnosticHash` SHA-256.
- Control: la huella excluye comandos, tiempos y valores sensibles.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para formato hexadecimal.
- Verificacion: `npm run type-check`, prueba focalizada y suite completa.

## Lote 106: resumen JSON de huella

- Estado: implementado y validado.
- Mejora cubierta: consultar solo la huella y metadata de comparacion.
- Cambio: se agrego `buildFingerprintSummary` y `--fingerprint-json`.
- Control: incluye algoritmo y version de entrada, no comandos.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para ausencia de comandos y secretos.
- Verificacion: `npm run type-check`, prueba focalizada, `npm --silent run doctor:local-chat:fingerprint` y suite completa.

## Lote 107: huella en reporte Markdown

- Estado: implementado y validado.
- Mejora cubierta: permitir comparar reportes humanos entre corridas.
- Cambio: el reporte Markdown agrega `Diagnostic hash`.
- Control: la huella es determinista sobre campos saneados.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para hash hexadecimal en Markdown.
- Verificacion: `npm run type-check`, prueba focalizada de Markdown y suite completa.

## Lote 108: script npm de huella local

- Estado: implementado y validado.
- Mejora cubierta: consultar la huella diagnostica con un comando corto.
- Cambio: se agrego `doctor:local-chat:fingerprint` a `package.json`.
- Control: usa `--fingerprint-json --compact-json` para salida estable.
- Pruebas: se amplio `tests/scripts/local-chat-recovery.test.ts` para verificar el script.
- Verificacion: `npm run type-check`, prueba focalizada, script real `doctor:local-chat:fingerprint` y suite completa.

## Lote 109: snapshot baseline local

- Estado: implementado y validado.
- Mejora cubierta: persistir un baseline saneado del diagnostico local.
- Cambio: se agrego `buildBaselineSnapshot` a `scripts/local-chat-recovery.js`.
- Control: guarda hashes, estados y acciones sin comandos ni secretos.
- Pruebas: se agrego cobertura de snapshot y ausencia de fugas.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 110: lectura de baseline local

- Estado: implementado y validado.
- Mejora cubierta: leer baselines existentes sin fallar cuando faltan.
- Cambio: se agrego `readBaselineFile` con respuesta `found=false`.
- Control: la ruta relativa se resuelve desde el `cwd` del proceso.
- Pruebas: se cubrio archivo presente y archivo inexistente.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 111: escritura de baseline local

- Estado: implementado y validado.
- Mejora cubierta: escribir el baseline desde CLI o tests.
- Cambio: se agrego `writeBaselineFile`.
- Control: crea directorios y normaliza JSON con claves estables.
- Pruebas: se valido escritura en directorio temporal y redaccion de comandos.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 112: comparacion contra baseline

- Estado: implementado y validado.
- Mejora cubierta: detectar cambios entre diagnostico actual y baseline.
- Cambio: se agrego `buildBaselineComparison`.
- Control: reporta hash actual, hash base, cambios de checks y delta de acciones.
- Pruebas: se cubrio regresion por nuevo frontend bloqueado.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 113: CLI de baseline

- Estado: implementado y validado.
- Mejora cubierta: consultar y escribir baseline desde npm.
- Cambio: se agregaron `--baseline-json` y `--write-baseline`.
- Control: `doctor:local-chat:baseline` y `doctor:local-chat:baseline:write` usan salida compacta.
- Pruebas: se ampliaron parseo, ayuda y scripts dedicados.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 114: ranking explicito de estados

- Estado: implementado y validado.
- Mejora cubierta: comparar severidad de estados sin heuristicas fragiles.
- Cambio: se agrego `statusRank`.
- Control: `ok`, `warning`, `blocked` y `missing` tienen orden estable.
- Pruebas: se valido que `ok` supere a `blocked`.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 115: deteccion de regresiones

- Estado: implementado y validado.
- Mejora cubierta: separar cambios que empeoran el diagnostico.
- Cambio: se agrego `isCheckRegression` y `actionRegressions`.
- Control: un check nuevo no-ok cuenta como regresion.
- Pruebas: se cubrio `frontend_routes` de `missing` a `blocked`.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 116: deteccion de mejoras

- Estado: implementado y validado.
- Mejora cubierta: separar cambios que recuperan checks o acciones.
- Cambio: se agrego `isCheckImprovement` y `actionImprovements`.
- Control: una accion correctiva removida cuenta como mejora.
- Pruebas: se cubrio `backend_auth` de `blocked` a `ok`.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 117: clasificacion de tendencia

- Estado: implementado y validado.
- Mejora cubierta: resumir cambios como `regression`, `improvement`, `mixed`, `unchanged` o `no_baseline`.
- Cambio: se agrego `classifyBaselineTrend`.
- Control: no infiere tendencia desde un unico contador.
- Pruebas: se valido mejora real y baseline ausente.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 118: CLI de tendencia baseline

- Estado: implementado y validado.
- Mejora cubierta: consultar tendencia actual contra baseline desde npm.
- Cambio: se agrego `--baseline-trend-json`.
- Control: `doctor:local-chat:baseline-trend` devuelve JSON compacto y seguro.
- Pruebas: se ampliaron parseo, ayuda y script dedicado.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 119: entrada historica saneada

- Estado: implementado y validado.
- Mejora cubierta: registrar ejecuciones locales sin guardar comandos.
- Cambio: se agrego `buildHistoryEntry`.
- Control: persiste hash, estado, healthCode y accion primaria.
- Pruebas: se valido que no se escriban passwords ni comandos.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 120: historial JSONL append-only

- Estado: implementado y validado.
- Mejora cubierta: mantener historial local incremental.
- Cambio: se agrego `appendHistoryEntry`.
- Control: crea directorios y agrega una linea JSON estable por ejecucion.
- Pruebas: se escribieron dos entradas en archivo temporal.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 121: lectura de historial

- Estado: implementado y validado.
- Mejora cubierta: leer historial JSONL o iniciar vacio.
- Cambio: se agrego `readHistoryFile`.
- Control: un historial faltante devuelve `entries=[]`.
- Pruebas: se cubrieron historial existente y archivo ausente.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 122: resumen historico

- Estado: implementado y validado.
- Mejora cubierta: comparar el diagnostico actual con ejecuciones previas.
- Cambio: se agrego `buildHistorySummary`.
- Control: reporta `seenCurrentHash`, hash previo y healthCode previo.
- Pruebas: se valido resumen con dos corridas consecutivas.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 123: CLI de historial local

- Estado: implementado y validado.
- Mejora cubierta: consultar y escribir historial desde npm.
- Cambio: se agregaron `--history-json` y `--write-history`.
- Control: `doctor:local-chat:history` y `doctor:local-chat:history:write` son compactos y saneados.
- Pruebas: se ampliaron parseo, ayuda y scripts dedicados.
- Verificacion: `node -c`, type-check, prueba focalizada, scripts reales, `git diff --check` y `npm test`.

## Lote 124: comprension contextual de turnos de chat

- Estado: implementado y validado.
- Mejora cubierta: interpretar referencias conversacionales, terminos personales y correcciones del usuario antes de planificar la respuesta.
- Cambio: se agrego `backend/src/services/sira/contextual-understanding.js` como etapa backend previa al motor Sira.
- Cambio: el controlador de chat conserva el texto original y entrega al motor un prompt efectivo enriquecido con coreferencias, lexico personal y contexto de reparacion.
- Control: no se modifico ningun archivo de interfaz, rutas visuales, estilos ni componentes React.
- Pruebas: se agregaron pruebas unitarias del modulo, pruebas de envelope y pruebas de integracion del controlador.
- Verificacion: `node --test` focalizado, `npm test`, `bash scripts/verify-ui-lock.sh` y `git diff --check`.

## Lote 125: metadata atomica de artefactos de agente

- Estado: implementado y validado.
- Mejora cubierta: evitar sidecars JSON truncados o corruptos al guardar artefactos generados por agentes.
- Cambio: `saveArtifact` usa `writeJsonAtomicSync` con formato pretty para persistir metadata junto al archivo.
- Control: si falla el commit atomico de metadata, se limpia el artefacto ya escrito y no quedan temporales `.tmp` del sidecar.
- Pruebas: se agrego una regresion que simula fallo de `renameSync` en metadata y valida limpieza total.
- Verificacion: `node -c`, `node --test` focalizado de artefactos, prueba de `atomic-json-write`, revision independiente, `git diff --check` y `npm test`.

## Lote 126: aislamiento de pruebas de goal autonomo

- Estado: implementado y validado.
- Mejora cubierta: evitar que una prueba unitaria de escalacion autonoma abra persistencia real o cola Redis por accidente.
- Cambio: `maybeCreateAutonomousGoalRun` acepta inyectar `appendEvent` y `enqueueGoalRun` manteniendo los adaptadores reales como default.
- Control: la prueba usa stubs deterministas para evento inicial y encolado, sin depender de base de datos ni `REDIS_URL`.
- Pruebas: se valido que persiste el goal, registra el evento `auto_queued_from_chat` y encola exactamente el `goalRunId` esperado.
- Verificacion: `node -c`, `node --test` focalizado de goal autonomo, suite focal combinada, `git diff --check` y `npm test`.

## Siguientes lotes

- Lote 127: agregar retencion configurable del historial diagnostico local.
