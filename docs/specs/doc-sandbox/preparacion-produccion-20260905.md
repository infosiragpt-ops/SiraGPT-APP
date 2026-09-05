# Preparación de producción de la PR #561

## Solicitud y alcance

El 2026-09-05 Luis solicitó continuar la PR #561 y dejarla en producción en
`siragpt.com`. Esta solicitud autoriza la publicación cuando estén completos
los controles aplicables; sustituye la restricción histórica de entregar solo
un borrador. Se continúa F1, sin iniciar F2 ni cambiar DNS.

El trabajo se realiza en el worktree existente
`/home/user/deployments/doc-sandbox-phase1-tests/candidate-git-561`.
Se conservaron los cambios previos de continuidad. El checkout de despliegue
`/home/user/SiraGPT-APP` tiene cambios ajenos de interfaz que no se incorporan.
Base remota comprobada: `09fa991cf78a3f425499caefde3d2e68ae58b3b0`.

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

## Evidencia nueva y límites

Las siguientes suites tienen alcances distintos; no se suman como E2E.

| Verificación | Resultado |
| --- | --- |
| Integración HTTP/PostgreSQL/Redis/S3 aislados | 63/63, cero fallos/skips, 18.688 s |
| Motor SDK con proveedor controlado | 52/52; incluye rechazo del cambio de modelo antes de gasto |
| Ciclo de vida del validador | 9/9 |
| Pagos HTTP, regresión de planes/cancelación | 9/9 |
| Cliente documental | 51/51 |
| Intención documental | 53/53, más 1 follow-up |
| Hook del chat montado | 14/14 |
| Regresión general del repositorio | 12.375/12.375, 532 suites, cero fallos/skips |
| Guardas de instalación y recuperación | 53/53; no equivalen a instalar gVisor |
| Typecheck backend/frontend y licencias | Exit 0 |
| Migración histórica real | 132 migraciones base → F1 (133) → deploy idempotente y status exit 0 |

La migración se ejecutó con Prisma contra PostgreSQL 16.14/pgvector 0.8.6 en
una base sintética nueva, sin datos productivos, `db push` ni `migrate resolve`.
Se comprobaron checksums históricos, conservación de una fila de usuario,
`docQuotaEpoch=0`, las tres tablas nuevas y rechazo real por FK, idempotencia y
restricción de publicación. Evidencia privada:
`/tmp/doc-sandbox-migration-history.3KO5hMXe/report.json`.
SHA-256 del SQL F1 probado:
`a699ad981695f8dd4d48b327ba6fe77c4cc0b7e0f2b0c3183fbf33c0b369ba21`.

Una comparación AST nueva contra `09fa991c` confirma idénticos los 1011 nodos
JSX, 785 atributos `className` y 8 `style` del chat. SHA-256 del inventario JSX:
`066996ac3726dd929b3934e1deeb52627affb1be7edd51b76fea1b5876fb1421`.
Esto acredita conservación de markup, no equivalencia de comportamiento ni
una prueba de navegador. Las condiciones de disponibilidad de Detener cambiaron
intencionalmente para corregir la cancelación.

Tras revisar el diff funcional y esa comparación nueva, se actualizaron
únicamente las cinco entradas esperadas del UI-lock (chat, clasificador y tres
módulos documentales). `ui-lock:verify` pasa; no se cambió CSS ni se aceptaron
archivos de otros worktrees. Es verificación de integridad del código revisado,
no sustituto del E2E ni permiso para omitirlo.

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
