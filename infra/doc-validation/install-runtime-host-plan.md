# Reanudación desde terminal administrativa del Lenovo

Estado: adaptador preparado y probado; **todavía no aplicado**. Complementa el
[intento anterior](install-runtime-result.md), cuyo paquete se conserva y cuyo
`daemon.json` se retiró tras fallar el helper de señal. No atribuye una causa al
exit 1 anterior. Usa exclusivamente la unidad systemd del host y conserva las
restricciones D19/D21. No utiliza el helper de señal ni modifica sus perfiles.

## Preflight revisable

Se necesita el paquete oficial ya fijado por `install-runtime-config.cjs`:
release `20260817.0`, 164966070 bytes y el SHA-512 registrado. La ruta del archivo
es argumento obligatorio. La descarga existente
`install-runtime-download.sh` mantiene HTTPS, tamaño y hash; no usar `latest`.

Desde la raíz de este checkout, en el contexto real del host:

```sh
node infra/doc-validation/install-runtime-host.cjs --preflight /ruta/absoluta/gvisor.tar.bz2
```

El preflight crea solamente evidencia privada 0700/0600 en un directorio nuevo
`/tmp/siragpt-runtime-host-evidence.*`. No modifica configuración ni crea
contenedores. Comprueba:

- Host `user-06`, Linux x64, `NoNewPrivs=0` y metadatos root del host. Una sesión
  confinada o con propietarios remapeados falla cerrada; no intenta cambiarla.
- Tar oficial completo y contenido SHA-256 de los seis ejecutables **ya
  instalados**, modos/propietario/tipos/enlaces y layout exacto. Ejecuta
  `runsc --version` únicamente después de validar todos esos bytes.
- Imagen de smoke `sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`
  e imagen candidata del validador
  `sha256:1a2be5c74d0291ffb120dbb5d8adb9689672858a181946adb7082c3398c4becc`;
  ambas Linux amd64, esta última con usuario `65532:65532`.
  La imagen base del smoke puede omitir `Config.User`: se lee con un valor vacío
  por defecto; el UID del contenedor se fija explícitamente. El validador sigue
  obligado a declarar exactamente `65532:65532`.
- `daemon.json` ausente, sin flags alternativos, mismo PID/startTicks de dockerd
  y runtime predeterminado `runc`. Este adaptador es una reanudación acotada;
  rehúsa sobrescribir una configuración nueva o un runtime `runsc` existente.
- Identidades, estado, runtime, reinicios y salud de **todos** los contenedores,
  incluidos los detenidos, sin leer entorno, documentos o logs. Exige salud de
  backend, frontend, PostgreSQL y Redis.
- La unidad de Docker debe tener exactamente una operación ExecReload:
  `/bin/kill -s HUP $MAINPID`, sin ignorar fallos. Valida el JSON con el dockerd
  del host mediante `--validate`, sin iniciar un daemon adicional.

## Aplicación tras revisión del responsable

Solo después de revisar código y evidencia fresca se ejecuta el mismo comando
con `--apply` en una sesión administrativa root del host. El adaptador no llama
a sudo ni solicita contraseñas. La disponibilidad de Docker o de `systemctl
show` no demuestra permiso administrativo; si falta, se detiene antes de tocar
la configuración.

La aplicación toma el lock utilizado por `publish.sh` y el lock del instalador.
Luego verifica nuevamente paquete, contenedores y configuración. Crea un backup
root:root 0400 con marcador `absent` y publica el candidato 0644 usando `link()`
exclusivo, que rechaza una creación concurrente de `daemon.json`. Sin modificar
el runtime predeterminado, ejecuta únicamente
`systemctl --no-ask-password reload docker`. El servicio vuelve a comprobarse
inmediatamente antes de la recarga.

Antes del `link()` exclusivo se sincronizan backup/candidato y se guarda su
identidad dev/inode/hash en evidencia mediante reemplazo atómico y `fsync()` de
archivo/directorio. Un fallo después de publicar conserva una evidencia válida
de recuperación; una actualización posterior de evidencia no la trunca.

Durante los siguientes 15 segundos exige `runsc` con la ruta fijada, identidad
de dockerd y todos los contenedores previos sin cambios. El smoke crea un único
contenedor nuevo, imagen inmutable y `--pull never`, UID 65532, sin red,
capabilities ni nuevos privilegios, raíz de solo lectura, 128 MiB, 0.5 CPU y
32 PIDs. Comprueba resultado real/runtime/exit y elimina solo su ID completo.
La continuidad se vuelve a verificar al finalizar. No reinicia servicios.

## Reversión explícita

Si se escribió configuración pero no se completa la habilitación, conservar la
evidencia y revisar el estado antes de revertir. No hay rollback silencioso.
El adaptador de reversión exige root del host y la ruta exacta de evidencia:

```sh
node infra/doc-validation/install-runtime-host-rollback.cjs --restore-absent /tmp/siragpt-runtime-host-evidence.ID/evidence.json
```

Exige backup marcador/0400/hash, candidato fijado y su **dev/inode/hash**,
identidad de daemon y continuidad. Rechaza cualquier contenedor `runsc` activo.
Retira solo el candidato propio, sincroniza el directorio y utiliza la misma
recarga SIGHUP comprobada. Confirma ausencia de `runsc` efectivo y continuidad;
conserva el paquete y backup. Un cambio concurrente bloquea la reversión.
Si una interrupción deja los dos enlaces `daemon.json` y `.candidate`, permite
exactamente esos dos enlaces solo tras comprobar la ruta registrada y que ambos
comparten dev/inode/hash. Retira únicamente `daemon.json` y conserva también el
candidato temporal como evidencia. Un tercer enlace o identidad distinta bloquea
la reversión.

## Verificación documental posterior

El smoke solo prueba que arranca un proceso aislado. A continuación debe
ejecutarse `IndependentDocumentValidator.preflight()` del módulo con la imagen
candidata y un staging privado real 0700, del UID del worker, con ruta idéntica
en host/worker. Ese preflight verifica lectura del input por hash y ejecución
real de Writer/Calc/Impress, PDF y renderizado. No sustituirlo por la mera
presencia de binarios ni por `preflight_tools()` sin aislamiento. Aún faltan
golden del motor, E2E y el resto de gates descritos en el informe de F1.

## Pruebas del adaptador

Ejecutadas en Node 24.18.0 el 2026-09-05: 15/15 pruebas de guardas de
servicio, identidad, metadatos, recuperación y ausencia de efectos al importar;
más 38/38 pruebas previas del planner/tar/rollback. Cero fallos o skips. No son
una ejecución real de la recarga. En esta sesión `node --test` agrupó por archivo;
los conteos de casos se corroboraron ejecutando directamente cada `.test.cjs`.
Las pruebas incluyen un fallo inmediatamente después de crear `daemon.json`,
fallo de persistencia de evidencia, creación concurrente de configuración y
ausencia de `Config.User` en la imagen de smoke. Usan únicamente archivos
temporales y no llaman al daemon ni a servicios del host.

```sh
node infra/doc-validation/install-runtime-host.test.cjs
node infra/doc-validation/install-runtime-config.test.cjs
node infra/doc-validation/install-runtime-apply.test.cjs
node infra/doc-validation/install-runtime-rollback.test.cjs
```

La [referencia oficial Docker](https://docs.docker.com/reference/cli/dockerd/#configuration-reload-behavior)
documenta la recarga de `runtimes` por SIGHUP. La
[instalación oficial gVisor](https://gvisor.dev/docs/user_guide/install/)
requiere mantener el paquete y sus sidecars. Estas referencias no acreditan
que una ejecución en este host haya tenido éxito.
