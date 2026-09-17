# Propuesta revisable: gVisor sin reiniciar producción

Estado: **paquete instalado; recarga fallida; configuración anterior restaurada**.
El resultado comprobado está en [install-runtime-result.md](install-runtime-result.md).
runsc no está registrado en Docker y no se ejecutó el smoke. No reintentar la
habilitación ni cambiar perfiles de seguridad sin revisión independiente.
Ámbito autorizado: añadir un runtime al Lenovo sin reiniciar Docker ni ningún
servicio de producción. Esta propuesta no autoriza DNS, despliegue de la app,
cambios en secretos, Docker privilegiado, ni modificaciones de otros stacks.

## Evidencia de solo lectura — 2026-09-04

- Entrada: alias SSH `siragpt-lenovo`, usuario `deploy`, UID 1000. La sesión es
  un contenedor Alpine con acceso al socket, no una terminal root del host.
- Host: Linux 6.8.0-40-generic x86_64; Docker 29.1.3; 32 CPU; 67,132,821,504 B RAM.
- Runtime predeterminado `runc`; disponibles `runc` e `io.containerd.runc.v2`.
- `/etc/docker/daemon.json` del **host** no existe. No existe una configuración
  alternativa por flag `--config-file` ni un flag `--add-runtime`.
- Proceso dockerd: PID 173770, start ticks 7292944. **Releer antes de señalizar**;
  estos números son evidencia temporal, no parámetros permanentes de instalación.
- `/usr/local/bin/runsc`, `containerd-shim-runsc-v1`, `gvisor-bin` ausentes.
- Backend, frontend, PostgreSQL y Redis reportaron `healthy`. Backend PID 3483371
  e inicio `2026-09-04T20:31:10.391548279Z`; frontend PID 3482843 e inicio
  `2026-09-04T20:30:58.072512409Z`; PostgreSQL PID 3169014 y Redis PID 3169004.
- Helper existente, consultado por ID inmutable:
  `sha256:0efa5d4f999ae8493821248e37cd7745cc439a292fb4c13385905ae5e5d3f5da`.
  No se ejecutó código dentro del backend en producción.

El script `install-runtime-preflight.sh` crea un helper temporal con red nula,
capabilities vacías, raíz de solo lectura, 128 MiB, 0.25 CPU y 32 PIDs. Los binds
del host son solo lectura. Lee únicamente configuración/identidad del daemon y
metadatos de runtime; nunca `.env`, `Config.Env` ni `proc/*/environ`.

## Artefacto fijo propuesto

Release oficial comprobado: [20260817.0](https://github.com/google/gvisor/releases/tag/release-20260817.0).
La descarga será exclusivamente HTTPS, con límite de tamaño/tiempo y sin
redirecciones fuera del proveedor aprobado:

```text
https://storage.googleapis.com/gvisor/releases/release/20260817.0/x86_64/gvisor.tar.bz2
Tamaño observado: 164966070 bytes
SHA-512 esperado:
bd8271a7742f90e53373b2a8613f37f3ae2c765ff5e2e611a75a47167a323cab7519b149c50273307743491713525a14ad1b3e398651c93b16f3e248dfeff3dd
```

El paquete completo fue descargado localmente y su tamaño y SHA-512 coincidieron
con el proveedor. Se inspeccionaron sus siete entradas antes de instalarlo en
un directorio nuevo `/usr/local/bin/siragpt-gvisor-20260817.0/`, manteniendo juntos
`runsc`, el shim y `gvisor-bin/`. No sobrescribir ejecutables preexistentes. La
[documentación oficial](https://gvisor.dev/docs/user_guide/install/) exige conservar
los sidecars junto al runtime; no utilizar el instalador binario heredado ni su
descarga automática. El directorio nuevo y sus archivos ejecutables tendrán modo
0755, root:root, sin bits SUID/SGID ni escritura para grupo/otros.

## Secuencia propuesta para revisión

1. Serializar esta operación con un lock exclusivo, anotar timestamp y capturar
   **todos** los contenedores existentes con ID, PID, StartedAt, estado y salud.
   Capturar dockerd PID/startTicks, runtime predeterminado, hash/ausencia de
   daemon.json y salud HTTP del backend. Si ya hay un despliegue concurrente,
   posponer; no competir por el daemon.
2. Descargar en staging privado, comprobar hash/tamaño. Inspeccionar el tar antes
   de extraer: rechazar traversal, rutas absolutas, nombres duplicados, enlaces
   simbólicos/duros, dispositivos, atributos especiales y expansión excesiva.
   Registrar manifiesto de archivos y hashes. No ejecutar un paquete no verificado.
3. Preparar backup privado e inmutable por procedimiento: creación exclusiva,
   permisos 0400, SHA-256 registrado fuera del directorio modificable y nunca
   reescribirlo. Si no había configuración, registrar un marcador `absent`.
   Esto es **protección procedimental**, no WORM ni `chattr +i`; no afirmar
   inmutabilidad de kernel si no fue comprobada.
4. Instalar la carpeta versionada como operación nueva. Preparar daemon.json
   candidato con `planConfiguration` de `install-runtime-config.cjs`, conservando
   todos los campos previos. Única adición:

   ```json
   {"runtimes":{"runsc":{"path":"/usr/local/bin/siragpt-gvisor-20260817.0/runsc"}}}
   ```

   No establecer ni cambiar `default-runtime`. Si ya existe `runsc` diferente,
   detenerse; no reemplazarlo. Validar el candidato con **el dockerd del host**
   mediante `dockerd --validate --config-file <candidato>` sin arrancar un daemon.
   Si no se puede efectuar esa validación desde la sesión actual, detenerse y
   resolver el acceso host con el agente responsable, sin `--privileged`.
5. Releer hash/ausencia y PID/startTicks: deben coincidir con el preflight.
   Publicar la configuración mediante rename atómico en el mismo filesystem,
   preservando dueño/modo del archivo anterior (root:root 0644 si era ausente).
6. **Solo recargar**. La [referencia oficial de Docker](https://docs.docker.com/reference/cli/dockerd/#configuration-reload-behavior)
   declara `runtimes` recargable por SIGHUP sin reiniciar el daemon. Preferir
   `systemctl reload docker` desde una sesión del host. La sesión Alpine actual
   no tiene systemctl: alternativa propuesta, todavía no ejecutada ni aprobada
   por el revisor, es un helper sin red/privileged, de código fijo revisado,
   `--pid=host`, que compruebe PID/comm/startTicks y envíe **solo SIGHUP** al
   proceso verificado. Si AppArmor/seccomp lo bloquea, no relajarlos ni escalar
   automáticamente. No usar restart, stop, down, SIGTERM ni SIGKILL contra el
   daemon o contenedores preexistentes. El cleanup forzado se limita al ID completo
   del nuevo contenedor de smoke creado por esta operación.
7. Consultar Docker hasta que publique `runsc` con el path exacto esperado;
   máximo 15 s. El predeterminado debe seguir siendo el original. Releer todos
   los ID/PID/StartedAt y salud. `assertProductionUnchanged` rechaza cualquier
   cambio en un contenedor preexistente o pérdida de salud; los contenedores
   aislados nuevos no se confunden con reinicios de producción.
8. Crear **un contenedor nuevo de prueba** con nombre/label propios y runtime
   explícito runsc, imagen por digest ya disponible, `--pull never`, sin red,
   sin capabilities, read-only, usuario no root, límites de RAM/CPU/PIDs y timeout.
   Verificar `inspect.HostConfig.Runtime`, arranque y salida real; eliminar solo
   ese contenedor conocido. Luego ejecutar validador real de documentos bajo
   runsc, revisar herramientas, fuentes y cuatro niveles. El smoke de runsc no
   equivale a haber validado edición, seguridad completa o G1–G12.

## Reversión acotada

Si el nuevo runtime no arranca, nunca recurrir a reiniciar Docker. Verificar CAS
contra el hash del candidato y restaurar únicamente la configuración original;
si era ausente, retirar solo el archivo creado cuya identidad/hash coincidan.
Recargar por el mismo mecanismo revisado y comprobar estado de producción. Si
hubo cambios concurrentes, no revertir ciegamente: detenerse y reportar. Conservar
el backup y el paquete versionado como evidencia, sin borrados recursivos. Un
fallo de recarga/restauración mantiene el servicio de edición cerrado; no se
declara listo ni se sustituye silenciosamente runsc por runc.

## Archivos y pruebas locales

```sh
sh -n infra/doc-validation/install-runtime-preflight.sh
node --test infra/doc-validation/install-runtime-config.test.cjs
```

Resultado local: **38/38 tests** de planificación/CAS/identidad/continuidad de
procesos, tar seguro y evidencia de reversión; cero saltados. Son pruebas puras,
no una instalación simulada y no certifican recarga real. El responsable revisó
la aplicación y el helper PID antes de ejecutarlos; tras fallar la recarga,
autorizó la reversión CAS del único archivo creado, verificada con éxito.
