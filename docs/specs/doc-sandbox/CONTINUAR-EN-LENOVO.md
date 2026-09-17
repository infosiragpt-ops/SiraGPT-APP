# Continuar F1 en Lenovo — entrega GitHub, sin despliegue

**Actualización:** Luis solicitó después continuar #561 y publicarla. Consultar
[preparación de producción del 2026-09-05](preparacion-produccion-20260905.md)
para las correcciones, nuevas pruebas y bloqueos administrativos/configuración
comprobados en Lenovo. La solicitud de publicación está vigente; las notas
siguientes conservan el estado histórico de la entrega inicial.

Estado al 2026-09-05: el usuario continuará desde el servidor y solicitó guardar
los cambios en GitHub. Se prepara la rama `feat/doc-sandbox-fase-1` como entrega
de revisión, con PR en borrador hacia `production-main`. **No se ejecutó
publish.sh, ninguna migración productiva ni ningún reinicio.** El último intento
SSH solicitó renovar Cloudflare Access y terminó en timeout antes de ejecutar
el comando remoto. No contiene claves.

## Contenido y base exacta

El archivo `siragpt-fase1-cambios.tar.gz` contiene únicamente archivos nuevos o
modificados de F1, con sus rutas relativas. **Es un paquete de cambios, no un
repositorio completo ni una versión lista para desplegar.** No contiene `.git`,
`node_modules`, `.env`, credenciales, documentos de usuarios ni imágenes Docker.
`.env.example` solo documenta configuración.

- Base original de F1 y del paquete anterior: `0f24e4d004f156eae838e21592539cca91f53cd3`.
- Base actual de la rama de entrega: `b30b48bc9b7c2510e86ff85c293852967ba31dc9`.
  El 2026-09-05 se actualizó mediante rebase limpio, conservando VoiceStudio
  (#560). La rama remota, no el paquete anterior, es la referencia de continuidad.
- Rama de entrega: `feat/doc-sandbox-fase-1`. Verificar el commit remoto y la PR
  en borrador antes de continuar; no confundir la subida de código con un deploy.
- Repo: `infosiragpt-ops/SiraGPT-APP`; destino de PR: `production-main`.
- Worktree Mac: `/Users/luis/Documents/Siragpt/doc-sandbox-plan`.
- No extraer el paquete sobre `/home/user/SiraGPT-APP` ni sobre un checkout con
  cambios propios. Crear antes un worktree separado desde la base exacta y
  revisar todas las diferencias. Nunca `git reset --hard` ni restaurar archivos
  ajenos para hacerlo encajar.

## Continuar desde GitHub sin alterar producción

Desde el repositorio existente en Lenovo, comprobar primero `git status` y que
el commit base indicado está disponible. Después de confirmar la subida de la
rama a GitHub, puede descargarse sin cambiar el checkout productivo:

```sh
git fetch origin feat/doc-sandbox-fase-1
git log -1 --format='%H %s' origin/feat/doc-sandbox-fase-1
```

Crear un worktree **separado** desde esa referencia para seguir trabajando. No
hacer checkout de esta rama sobre el directorio productivo, no mergear a
`production-main` y no ejecutar `publish.sh` hasta cerrar los controles abajo.
La imagen frontend actual debe conservarse mientras la nueva capacidad siga
sin habilitarse. Los archivos del paquete son una instantánea anterior; la rama
verificada en GitHub es la referencia para la continuación posterior.

No reutilizar la comparación AST previa como prueba de la combinación actual
con VoiceStudio. Las pruebas locales repetidas tras el rebase se registran en
la PR; no sustituyen el E2E autenticado ni los controles de producción pendientes.

## Riesgo concreto de publicar todo desactivado

El frontend nuevo intercepta instrucciones de edición antes del editor antiguo.
Si el backend devuelve `enabled:false`/`ready:false`, devuelve `E_NOT_READY`,
conserva el borrador y no continúa al editor previo. Publicarlo completo con F1
apagada bloquearía esas ediciones; también retendría las ediciones en cola de
otros chats. **No publicar ese conjunto como un cambio inocuo.**

Una eventual preparación **solo backend** debe mantener exactamente la imagen
frontend actual y completar su revisión/CI/migraciones antes de publicar. No
activa la edición F1. Es una opción pendiente de ejecución y validación, no un
despliegue realizado ni un sustituto del cierre de fase.

El estado apagado exige `DOC_SANDBOX_ENGINE` **ausente o vacío**. No escribir
`off`, `false` ni `0`: son valores truthy que la configuración rechaza y pueden
impedir el arranque. No copiar ni imprimir el `.env` de producción; no cambiarlo
como parte de la extracción del paquete.

## Aislamiento, presupuesto y pruebas

- La última lectura confirmada de Docker dio `DefaultRuntime=runc` y
  `runscRegistered=false`. El paquete gVisor está instalado, pero no registrado.
- La recarga anterior falló; el `daemon.json` recién creado se retiró mediante
  backup/hash verificado, sin reinicios. No repetir el instalador a ciegas, ni
  relajar AppArmor/seccomp, ni usar un helper privilegiado para eludir el fallo.
- Hace falta una sesión administrativa revisada en el **host Lenovo**, no solo
  el contenedor Alpine de despliegue. La autorización sigue limitada a no
  reiniciar Docker ni los contenedores productivos.
- US$5 autorizados en total; US$0 en llamadas ejecutadas. No restablecer el ledger
  al cambiar de campaña. El runner real requiere el límite del proveedor
  acreditado y superar preflight antes de cualquier gasto.
- Imágenes y evidencia de componentes: `infra/doc-validation/image-build-result.md`.
  Existen imágenes candidatas en Lenovo; no equivalen a un despliegue de la app.
- Servicios aislados de test conocidos: `doc-sandbox-test-postgres`,
  `doc-sandbox-test-redis`, `doc-sandbox-test-minio`. La última comprobación los
  dejó detenidos; verificar de nuevo antes de usarlos. No usar la DB de producción.

## Gates que no deben omitirse

Consultar `reporte-fase-1.md`: 137 unitarias, 55 integraciones reales, 42 pruebas
del validador Linux, 16 corpus/G10, 11 aperturas, 2 herramientas y 5 Redis real.
Los 53+12 tests de frontend son auxiliares, no E2E del navegador.

Quedan gVisor real, motor Anthropic/casos completos, documentos anonimizados del
usuario, E2E autenticado, cobertura global requerida, CI, migración histórica,
retención/cuotas y reconciliación de recursos huérfanos. UI-lock detecta cuatro
archivos intencionales; la comparación AST prueba JSX/CSS idéntico, no E2E ni
permiso para ignorar el control. No cambiar hashes simplemente para ponerlo verde.

Después de cerrar los controles aplicables: PR a `production-main`, CI requerida
verde, revisión, backup y runbook vigente. No `--admin` con CI roja, no DNS, no
`compose down -v`, no borrado de volúmenes, no instalación sobre producción.
Una autorización de publicación no demuestra que la versión ya sea publicable.

La última versión pública comprobada era `0f24e4d004f156eae838e21592539cca91f53cd3`,
API `healthy` a `2026-09-05T05:03:29.910Z`. Es evidencia anterior: verificar SHA,
salud y documento descargado después de cualquier futura publicación.
