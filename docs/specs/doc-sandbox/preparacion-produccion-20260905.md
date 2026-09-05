# Preparación de producción de la PR #561

## Estado comprobado tras recuperación de OpenClaw

Actualización 2026-09-05, posterior a los apartados históricos siguientes.
La autorización de Luis para publicar sigue vigente. **No se ha publicado F1,
ejecutado migración productiva ni reiniciado Docker.**

- Recuperada la candidata `b51cc6e6`, integrada con #563/#564 mediante
  `5b5354d974de59a51766f48f274863798d726190` y corregidas dos regresiones de CI
  en `1c7496d20a5ca8257ee4cb7c81c622a6b05a2907`. Ambos commits están en la rama
  remota y en el worktree aislado Lenovo; el checkout productivo no se cambió.
- Escritura GitHub y SSH ya funcionan. Se autorizó la clave pública dedicada
  exclusivamente para este repositorio y se verificó autenticación. El acceso
  SSH entra al contenedor de despliegue, **no a una sesión administrativa del
  host**; esta distinción mantiene pendiente el preflight de gVisor.
- Regresión general local sobre `5b5354d9`: 12.442 pruebas, cero fallos/skips;
  TypeScript, lint, UI-lock y licencias pasan. Integración documental Linux real
  HTTP/PostgreSQL/Redis/S3 aislados: **64/64**, cero fallos/skips. Corpus/oracle:
  16; comprobación de herramientas: 2; validador Python independiente: 42.
- CI de `5b5354d9` encontró dos fallos genuinos. El fondo de una diapositiva
  estaba oculto por un rectángulo opaco; ahora solo se recolorea la primera
  forma inequívoca de fondo a tamaño completo. El fixture de borrado de usuario
  omitía la nueva desactivación previa: ahora cubre respuestas 200/202 con
  revocación y auditoría. No se debilitaron las aserciones ni el runtime admin.
- Sobre `1c7496d2`, **30/30** regresiones Linux con render real, cero skips, en
  `regressions-ci-1c7496d20.CDcFDB`; prueba PNG roja antes del arreglo en
  `png-before-5b5354d97.dFikAK`. Una primera invocación dejó sockets Redis de
  test abiertos y fue detenida; la ejecución válida usa `--test-force-exit`,
  igual que el runner CI del repositorio. Los contenedores de test se retiraron.
- Evidencia Linux bajo
  `/home/user/deployments/doc-sandbox-phase1-tests/entrega-561-20260905/`:
  `linux-direct-5b5354d97.LHKkjJ`, `integration-5b5354d97.ADnaNo` y los dos
  directorios de regresión anteriores. Son pruebas sin llamadas al proveedor;
  **no acreditan aceptación Anthropic ni gVisor efectivo**.
- La medición exclusiva de unitarias, sin integración/Python, pasa **155/155**
  tras cuatro casos nuevos del contrato de publicación. Cobertura TS completa:
  **2123/3454 líneas (61,46 %)**, funciones 58,53 %, ramas 86,60 %. No satisface
  el umbral del 80 %. Se usó `NODE_V8_COVERAGE` + API oficial `c8.Report` debido
  a incompatibilidad del CLI con Node 26, conservando `--all` y remapeo fuente.
  Evidencia local: `/tmp/doc561-unit-coverage-after-7pi5thbw/`.
- La API existente de Anthropic respondió a consultas de metadatos, sin
  generaciones ni gasto. Versiones exactas observadas: docx `20260831`, xlsx
  `20260829`, pptx `20260828`, pdf `20260709`. No se configuró `latest`.
  El catálogo activo consultado solo tiene `claude-fable-5-1` de Anthropic;
  todavía no permite configurar dos niveles distintos de forma coherente.
- Siguen ausentes R2 y la configuración F1 en el backend vivo. `runsc` no
  figura entre las claves reales de Docker Runtimes. No se trasladaron secretos
  desde el chat ni se intentó eludir autenticación mediante Docker.

CI de las correcciones: [run 33999203724](https://github.com/infosiragpt-ops/SiraGPT-APP/actions/runs/33999203724).
Después de cualquier commit posterior, verificar la ejecución de su SHA exacto.
El job visual informativo de este run no encontró tests y devuelve success por
su wrapper: **no equivale a una comparación pixel-perfect**. El gate E2E crítico
es independiente.

La revisión de release detectó que `deploy/iliagpt/publish-reviewed.sh` de #563
rechaza schema/migrations **antes del backup**. No se quitó esa guarda ni se
usó el publisher legacy. Sigue pendiente una vía revisada F1 con manifiesto de
migración exacto, ensayo de restauración, migración estricta, backend listo
antes del frontend y rollback que conserve reconciliación de jobs. Apagar
`DOC_SANDBOX_ENGINE` no es una pausa de admisión compatible con dicho rollback.
El SQL conserva el hash histórico probado que figura más abajo.

Además del acceso administrativo/R2, permanecen abiertos aceptación real con
presupuesto Anthropic acreditado, concurrencia, muestras, E2E completo,
cobertura y release con migración. No confundir CI verde con cierre de F1.
La última versión pública observada continúa en #564 (`ff61eeb9`), saludable;
verificar de nuevo antes de cualquier acción productiva.

## Estado vigente de la reanudación de acceso

**Antecedentes conservados:** este apartado describe el checkpoint anterior;
las afirmaciones de GitHub/SSH bloqueados quedan sustituidas por el estado
comprobado de recuperación de arriba.

El candidato de código `161284ab` incorpora por merge la versión productiva
`ff61eeb9d980775cb75900d5350278c58e098243` (#564), partiendo del checkpoint
`85866985e516e8cbc5fdba5d64da8e23f874222d`. Se resolvieron siete archivos;
los seis archivos de código y tests incorporados coinciden exactamente con
#564. UI-lock conserva 800 entradas y actualiza solo los hashes de CSS y del
selector de esfuerzo. La auditoría independiente confirmó 4.892 archivos
protegidos idénticos al checkpoint anterior, incluidos backend, lib, validación
documental, documentación F1 y chat. El checkout productivo no se modificó.

Pasaron compilación de tests, TypeScript frontend, lint con advertencias,
UI-lock y los tres archivos de tests específicos del selector. Logs:
`/tmp/doc-sandbox-ff61-checks-{tests-compile,frontend-typecheck,lint,ui-lock,targeted-tests}.log`.
Las 12.375 pruebas generales y la integración de backend del informe son
evidencia anterior; no se repitieron al conservarse ese código.

Chromium pasó los dos casos reales de cancelación en 44.3 s: 17.3 s en chat
nuevo y 26.0 s en chat vacío. Login y subida reales, petición de capacidades
real, motor deshabilitado, cero llamadas pagadas. Las cuatro capturas revisadas
confirman Detener y la restauración del borrador con su original; no aparece
POST tardío de admisión. Esto no sustituye la aceptación con proveedor.
Evidencia: `/tmp/doc-sandbox-ff61-browser.log` y
`/tmp/doc-sandbox-browser-561-f/browser`.

La comprobación auxiliar de interfaz con API simulada pasó 7/8 inicialmente.
El caso restante esperaba «Escribe un mensaje…» con un navegador configurado
en inglés, que mostró correctamente «Type a message…». Ese mismo caso pasó
con locale `es-PE` en 22.3 s (23.3 s total), conservando sus aserciones y el
código publicado. Un intento intermedio no llegó a cargar la página porque
el runner anterior ya había retirado los servicios; la comprobación válida
arrancó su propio entorno aislado. Evidencia:
`/tmp/doc-sandbox-ff61-browser-es.log` y `/tmp/doc-sandbox-browser-561-g`.
Esta suite auxiliar no acredita edición documental real.

Ambos runners retiraron sus aplicaciones y relays. La comprobación final
confirma puertos 15161/15162 libres y los cuatro servicios sintéticos detenidos,
conservando sus datos. Ningún servicio productivo se modificó.

La integración GitHub sigue en `push:false`. Se preparó una clave SSH de
despliegue exclusiva en el host, sin modificar la configuración SSH global ni
incluir la clave privada en Git. La clave pública está pendiente de añadirse
como deploy key con escritura al repositorio. La comprobación SSH con la
identidad dedicada y la huella oficial verificada devuelve todavía
`Permission denied (publickey)`.

`sudo -n` sigue requiriendo contraseña. Se intentó el preflight mediante el
diálogo administrativo del sistema, pero no se completó la autenticación; se
canceló únicamente esa solicitud pendiente. No se aplicó gVisor ni se publicó
#561. El comando de preflight de este informe contiene la ruta correcta:
`/tmp/siragpt-gvisor-20260817.0.QH6smq1z/gvisor.tar.bz2`.

## Solicitud y alcance

El 2026-09-05 Luis solicitó continuar la PR #561 y dejarla en producción en
`siragpt.com`. Esta solicitud autoriza la publicación cuando estén completos
los controles aplicables; sustituye la restricción histórica de entregar solo
un borrador. Se continúa F1, sin iniciar F2 ni cambiar DNS.

El trabajo se realiza en el worktree existente
`/home/user/deployments/doc-sandbox-phase1-tests/candidate-git-561`.
Se conservaron los cambios previos de continuidad. Al comenzar, el checkout de
despliegue `/home/user/SiraGPT-APP` tenía cambios ajenos de interfaz que no se
incorporaron. Otra tarea los confirmó y publicó durante esta revisión; véase
la comprobación de producción al final.
Base común de la integración: `09fa991cf78a3f425499caefde3d2e68ae58b3b0`.
Referencia productiva comprobada en esta reanudación:
`ff61eeb9d980775cb75900d5350278c58e098243` (#564).

## Correcciones verificadas

- CI instala dependencias de desarrollo antes de compilar TypeScript. El CI del
  HEAD original fallaba por faltar los tipos de Express y Multer bajo
  `NODE_ENV=production`. El inventario de licencias se regeneró: 1564 entradas.
- Cuotas documentales reservadas y conciliadas con el consumo de cuenta;
  revocación inmediata y purga diferida de documentos al borrar una cuenta.
- El modelo solicitado se conserva hasta el motor: un cambio de configuración
  rechaza el trabajo antes de reservar o enviar otra llamada al proveedor.
- Las cuarentenas del validador impiden reabrir admisión mientras su limpieza
  no está acreditada, incluso durante el periodo de gracia.
- El chat exige admisión, resultado e informe coherentes antes de mostrar una
  descarga validada; conserva borrador y propietario de admisión al crear chat.
- El control Detener existente permanece disponible durante la admisión en
  chats nuevos/vacíos. Las consultas inequívocas de lectura no invocan edición;
  se conserva la aclaración de solicitudes ambiguas según el contrato anterior.
- El adaptador administrativo guarda evidencia durable antes de crear
  `daemon.json`; tolera la ausencia de `Config.User` solo en la imagen de smoke,
  manteniendo el UID obligatorio del validador.

## Evidencia histórica anterior a la integración de #564

Las siguientes suites se ejecutaron en revisiones anteriores y tienen alcances
distintos; no se suman como E2E. Los checks repetidos sobre la integración de
#564 se enumeran en el estado vigente al principio de este informe.

| Verificación | Resultado |
| --- | --- |
| Integración HTTP/PostgreSQL/Redis/S3 aislados | 63/63, cero fallos/skips, 18.688 s |
| Storage real, suite ampliada de limpieza | 10/10; fallo real de DELETE mantiene purga pendiente y recuperación respeta al otro propietario |
| Motor SDK con proveedor controlado | 52/52; incluye rechazo del cambio de modelo antes de gasto |
| Ciclo de vida del validador | 9/9 |
| Pagos HTTP, regresión de planes/cancelación | 9/9 |
| Cliente documental | 51/51 |
| Intención documental | 53/53, más 1 follow-up |
| Hook del chat montado | 14/14 |
| Navegador Chromium con login y subida reales, motor deshabilitado | 2/2, 43.2 s; Detener en chat nuevo y vacío conserva borrador/original y no envía POST de admisión |
| Regresión general del repositorio | 12.375/12.375, 532 suites, cero fallos/skips |
| Guardas de instalación y recuperación | 53/53; no equivalen a instalar gVisor |
| Typecheck backend/frontend y licencias | Exit 0 |
| Migración histórica real | 132 migraciones base → F1 (133) → deploy idempotente y status exit 0 |

La cobertura combinada de suites existentes mide 78.77 % de líneas TypeScript
y 93.61 % de líneas ejecutables Python. El agregado descriptivo es 81.52 %,
pero incluye integración y no mide ramas Python: no acredita el requisito
unitario de §10.2. Ver [revisión backend](revision-backend-20260905.md).

La migración se ejecutó con Prisma contra PostgreSQL 16.14/pgvector 0.8.6 en
una base sintética nueva, sin datos productivos, `db push` ni `migrate resolve`.
Se comprobaron checksums históricos, conservación de una fila de usuario,
`docQuotaEpoch=0`, las tres tablas nuevas y rechazo real por FK, idempotencia y
restricción de publicación. Evidencia privada:
`/tmp/doc-sandbox-migration-history.3KO5hMXe/report.json`.
SHA-256 del SQL F1 probado:
`a699ad981695f8dd4d48b327ba6fe77c4cc0b7e0f2b0c3183fbf33c0b369ba21`.

Una comparación AST de aquella revisión contra `09fa991c` confirma idénticos los 1011 nodos
JSX, 785 atributos `className` y 8 `style` del chat. SHA-256 del inventario JSX:
`066996ac3726dd929b3934e1deeb52627affb1be7edd51b76fea1b5876fb1421`.
Esto acredita conservación de markup, no equivalencia de comportamiento ni
una prueba de navegador. Las condiciones de disponibilidad de Detener cambiaron
intencionalmente para corregir la cancelación.

En aquella revisión, tras comprobar el diff funcional y la comparación AST, se actualizaron
únicamente las cinco entradas esperadas del UI-lock (chat, clasificador y tres
módulos documentales). `ui-lock:verify` pasa; no se cambió CSS ni se aceptaron
archivos de otros worktrees. Es verificación de integridad del código revisado,
no sustituto del E2E ni permiso para omitirlo. La integración posterior de #564
sí incorpora el CSS ya publicado de esa versión, conservando sus bytes.

El navegador se ejecutó sobre el candidato basado en `09fa991c`, con los
ajustes finales del spec, en aplicaciones aisladas y sin salida de red. Ambos
casos esperan la finalización de la petición real de capacidades después de
Detener y vuelven a verificar que no aparece una admisión tardía. No se
sustituyeron respuestas de API y no hubo errores de JavaScript de página.
Evidencia: `/tmp/doc-sandbox-browser-561-d-run.log` y capturas `stop-*` /
`restored-*` bajo `/tmp/doc-sandbox-browser-561-d/browser`.

La DB del navegador es una copia sintética derivada, alineada como en CI con
`db push`; se repusieron únicamente las tablas históricas de créditos y su enum
que quedan fuera del datamodel Prisma. La DB original de la prueba histórica
no cambió. Esta preparación no acredita resolver esa deriva de esquema en
producción. Ver [reproducción del navegador](../../../infra/doc-validation/browser-testing.md).

Las capturas confirman Detener durante admisión y el borrador con adjunto al
cancelar. Se observa un toast genérico «No se pudo iniciar la edición
verificada» también al cancelar: detalle de experiencia pendiente, sin pérdida
del original. Estos dos casos no prueban la edición con Anthropic ni la
descarga validada. Estas ejecuciones históricas no acreditan por sí solas la
combinación actual con `ff61`.

En aquella ejecución el runner retiró las aplicaciones y relays de prueba y dejó libres los puertos
15161/15162. Tras liberar la tarea de navegador, también se detuvo el PostgreSQL
histórico sintético, comprobando scope, imagen fijada y red interna sin puertos
publicados. Se conservaron la base y el volumen; los cuatro servicios de prueba
quedaron detenidos.

## Bloqueo administrativo de gVisor

Se descargó de nuevo el paquete oficial `20260817.0`, comprobando los 164966070
bytes y el SHA-512 fijado. Se verificaron los seis binarios instalados contra
ese paquete. Archivo:
`/tmp/siragpt-gvisor-20260817.0.QH6smq1z/gvisor.tar.bz2`.

El primer preflight real falló en el lector de `Config.User` de la imagen de
smoke; se corrigió y probó. El segundo llegó a validar con `dockerd`, pero ese
comando rechazó la ejecución sin root. Su evidencia conserva
`hostWrites:false`: `/tmp/siragpt-runtime-host-evidence.5Y8VIv/evidence.json`.
La ejecución aprobada de `sudo -n ... --preflight ...` respondió
`sudo: se requiere una contraseña`. No se intentó eludir sudo mediante Docker,
helpers privilegiados ni cambios de perfiles.

Desde una terminal administrativa del Lenovo debe repetirse el preflight:

```sh
sudo /usr/bin/node /home/user/deployments/doc-sandbox-phase1-tests/candidate-git-561/infra/doc-validation/install-runtime-host.cjs --preflight /tmp/siragpt-gvisor-20260817.0.QH6smq1z/gvisor.tar.bz2
```

Solo si pasa y se revisa su evidencia fresca, ejecutar el mismo adaptador con
`--apply`. Este únicamente registra `runsc` y recarga Docker por SIGHUP;
verifica continuidad de contenedores y no reinicia servicios. Después debe
pasar `IndependentDocumentValidator.preflight()` real con staging privado.
El paquete en `/tmp` debe conservarse o descargarse/verificarse otra vez si
el host reinicia. Ver [plan administrativo](../../../infra/doc-validation/install-runtime-host-plan.md).

## Controles todavía abiertos

- Escritura en GitHub: el `push` HTTPS falla porque no hay credenciales, el
  intento con la identidad SSH dedicada devuelve `Permission denied (publickey)`
  y la integración GitHub informa `push:false`
  para este repositorio; `create_blob` devuelve `403 Resource not accessible by
  integration`. Ninguna de estas operaciones actualizó la rama remota ni lanzó
  CI para las correcciones nuevas.
- gVisor efectivo y preflight documental aislado con Writer/Calc/Impress/PDF.
- Almacenamiento privado productivo: una comprobación de presencia, sin imprimir
  valores ni secretos, confirmó `ANTHROPIC_API_KEY` presente y
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
  ausentes del entorno del contenedor backend. También están ausentes las
  variables del módulo. Una lectura limitada a booleanos de esas claves en la
  configuración del host también confirmó su ausencia (incluido `R2_BUCKET`).
  Falta provisionar/referenciar R2 antes de habilitarlo.
- Evidencia fresca del límite duro de Anthropic de US$5 y saldo compartido de
  campaña. No se enviaron llamadas pagadas en esta reanudación.
- Cinco jobs reales, corpus y muestras anonimizadas representativas, apertura
  manual requerida y descarga verificada desde el dominio tras publicar.
- E2E autenticado completo con proveedor, cobertura global ≥80 % incluyendo
  validador y CI verde del candidato final. Las unitarias solas no acreditan
  esa cobertura; no se bajó el umbral ni se excluyeron archivos para alcanzarlo.
- Configuración productiva del módulo y staging, revisión final, merge y
  publicación canónica con backup/canary. No publicar el frontend con F1
  apagada: intercepta edición explícita y devolvería `E_NOT_READY`.

Este informe acredita preparación y correcciones, no cierre de F1 ni despliegue.

## Checkpoint local y publicación pendiente

El código integrado está en el merge local `161284ab`, sobre `85866985`, con
#564 preservada. Los commits `66f37cf`, `1108af81` y `85866985` conservan los
checkpoints anteriores. La consulta remota de esta reanudación confirma
`production-main` en `ff61eeb9` y la rama de #561 todavía en
`f085ebac9cbbb24e4164e852cc83a8fdc07f4d89`. Las correcciones locales no están
publicadas.

No se ejecutaron `publish.sh`, merge a `production-main`, migraciones productivas
ni cambios del runtime Docker. Se necesita acceso de escritura al repositorio
`infosiragpt-ops/SiraGPT-APP` para subir la rama y obtener CI del candidato final.
Una vez resueltos también runtime, R2 y validación real, la publicación canónica
debe preservar los cambios ajenos del checkout principal mediante un checkout
limpio y mantener el backup/canary previsto por el procedimiento existente.

La comprobación fresca del 2026-09-05 a las 22:37:45 UTC devuelve
`ff61eeb9d980775cb75900d5350278c58e098243`, versión
`0.4.4-production-main.ff61eeb9.20260905T220338Z`. Readiness y todas sus
dependencias reportan `healthy`. El checkout `/home/user/SiraGPT-APP` está
limpio en ese mismo HEAD. Este despliegue no contiene #561. Evidencia:
`/tmp/doc-sandbox-ff61-production-observation.json`.

### Observaciones históricas de producción

Comprobación de producción del 2026-09-05 a las 20:57 UTC: `/api/version`
devuelve `28058d750ee63aa4daa5aec5f5dfec71dff98f45`, versión
`0.4.4-production-main.28058d75.20260905T204619Z`; `/api/health/ready` devuelve
`healthy`, incluidas base de datos, migraciones y Redis. Ese despliegue fue
realizado por otra tarea y **no contiene #561**. El checkout principal está
limpio en `codex/effort-polish-production`, mientras `origin/production-main`
después de un fetch sigue en `09fa991c`. Antes de publicar F1 hay que reconciliar
esa actualización del selector de esfuerzo y repetir las comprobaciones
afectadas para conservar la interfaz actualmente publicada.

Una comprobación posterior a las 21:11:56 UTC observó otra publicación de esa
tarea: `886ec72fbf629cd7511ffcdf8b50a5c3f43c0965`, versión
`0.4.4-production-main.886ec72f.20260905T210539Z`, con readiness `healthy`.
Refina el mismo selector de esfuerzo y tampoco contiene #561. Esta observación
es histórica: la versión vigente comprobada en la nueva reanudación es
`ff61eeb9d980775cb75900d5350278c58e098243` (#564).

Se conserva además una copia privada de la evidencia seleccionada fuera de
`/tmp`, en `/home/user/deployments/doc-sandbox-phase1-tests/entrega-561-20260905`.
`evidence-manifest.json` identifica el origen, tamaño y SHA-256 de cada archivo.
Incluye pruebas generales, integración, limpieza, cobertura, migración, revisión
AST y preflight administrativo rechazado. No es una autorización de despliegue.
