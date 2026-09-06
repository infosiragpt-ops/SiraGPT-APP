# Resultado verificado del intento gVisor — 2026-09-04

**El runtime no está habilitado. Producción conservó sus procesos y la
configuración Docker anterior quedó restaurada.** No se ejecutó el smoke runsc
ni se certificó el runtime aislado del validador documental.

## Resultado real

1. Se descargó el paquete oficial fijo `20260817.0/x86_64/gvisor.tar.bz2`:
   164966070 bytes y SHA-512
   `bd8271a7742f90e53373b2a8613f37f3ae2c765ff5e2e611a75a47167a323cab7519b149c50273307743491713525a14ad1b3e398651c93b16f3e248dfeff3dd`.
   El tar fue inspeccionado antes de extraer: seis archivos y el directorio de
   sidecars; paths/tipos/modos/propiedad/checksums estrictos y expansión acotada.
2. `dockerd --validate --config-file=/dev/stdin` del **host** devolvió exit 0 y
   `configuration OK`. Solo se montaron el ejecutable, docker-proxy y cinco
   bibliotecas exactas readonly; no se inició otro daemon.
3. Paquete instalado en `/usr/local/bin/siragpt-gvisor-20260817.0/`.
   La ejecución real de `runsc --version` devolvió
   `runsc version release-20260817.0`, `spec: 1.2.1`.
4. Se creó backup exclusivo root:root 0400 del estado original **ausente**, y
   se publicó el candidato mediante CAS y creación atómica. No se modificó el
   runtime predeterminado.
5. El helper restringido que debía enviar exclusivamente SIGHUP terminó con
   **exit 1**. Se mantuvieron AppArmor/seccomp, sin privileged ni reinicios.
   La causa precisa **es desconocida**: el stderr completo no fue persistido,
   y el clasificador existente conservó solo `remote_failure`. No se afirma que
   fuera EPERM o AppArmor. No se repitió la señal ni se ejecutó una alternativa.
6. Lecturas posteriores confirmaron runsc **ausente** de los runtimes efectivos,
   `runc` predeterminado, mismo dockerd y mismos procesos de producción.
7. Con autorización del responsable, `install-runtime-rollback.cjs` verificó
   hash del candidato, backup 0400/hash/marcador `absent`, continuidad y ausencia
   de runsc. Retiró **solo** `/etc/docker/daemon.json` creado por el intento y
   sincronizó el directorio. No envió señales. Terminó exit 0.

## Estado final comprobado

- `/etc/docker/daemon.json`: **ausente**, igual que antes del intento.
- Runtimes Docker: `runc`, `io.containerd.runc.v2`; predeterminado `runc`.
- Dockerd: PID **173770**, start ticks **7292944**, sin cambio.
- **23 contenedores preexistentes**: mismos ID, PID y StartedAt. Los servicios
  `doc-sandbox-test-*` de otro agente se excluyeron del conjunto de producción y
  no fueron alterados.
- Backend, frontend, PostgreSQL y Redis: `healthy` antes y después.
- Lock de instalación: liberado, verificando nonce propio.
- Paquete versionado: conservado, no activo como runtime Docker.
- Backup conservado:
  `/etc/docker/.siragpt-runtime-0c2b581a9644f85a13c95b80.backup`.
  SHA-256: `7925d3e9a9613a093e5eb4054b32aa39de910d2b03ba7e8046c3b4550b8de1e4`.
- SHA-256 del candidato retirado:
  `aefac65cd9aca7a94ad1c4f3b65415da9d200d3d2633036acf04ea8ef7130add`.

## Evidencia y pruebas

Evidencia privada local de la ejecución y reversión:
`/private/tmp/siragpt-runtime-evidence.h4nzac/evidence.json`.
Incluye manifiesto/hash del paquete, snapshots previos/finales,
`recovery.productionContinuityPassed: true` y `lockReleased: true`.
SHA-256 del reporte final:
`a21b724f3f3465bd9e81c186a9f8ef938248f4603ac46543b987d3dafa5753f9`.

Preflight completo previo sin escrituras:
`/private/tmp/siragpt-runtime-evidence.5wnpki/evidence.json`.
SHA-256:
`fcf0d69241b7503f5d7cb551a1a75fb07f3763e52c7613b1dd4f9fc7138825f3`.

Un primer intento de aplicación se detuvo en la primera lectura por SSH exit255,
sin adquirir lock ni escribir host:
`/private/tmp/siragpt-runtime-evidence.eQvjDG/evidence.json`.
La conexión posterior se recuperó; no se infirió un reinicio a partir del corte.

Paquete descargado conservado localmente:
`/private/tmp/siragpt-gvisor-local.AYCqyeEK/gvisor.tar.bz2`.
La descarga inicial incompleta en el tmpfs de 64 MiB de la sesión SSH se retiró
antes de continuar; ese tmpfs recuperó sus 61 MiB libres observados.

Comandos locales ejecutados:

```sh
cd /Users/luis/Documents/Siragpt/doc-sandbox-plan
node infra/doc-validation/install-runtime-apply.cjs --preflight /private/tmp/siragpt-gvisor-local.AYCqyeEK/gvisor.tar.bz2
node infra/doc-validation/install-runtime-apply.cjs --apply /private/tmp/siragpt-gvisor-local.AYCqyeEK/gvisor.tar.bz2
node infra/doc-validation/install-runtime-rollback.cjs --restore-absent /private/tmp/siragpt-runtime-evidence.h4nzac/evidence.json
node --test infra/doc-validation/install-runtime-config.test.cjs infra/doc-validation/install-runtime-apply.test.cjs infra/doc-validation/install-runtime-rollback.test.cjs
cd backend
node --import tsx --test tests/doc-sandbox-validation-contracts.test.ts
npm run type-check:doc-sandbox
```

Resultado: **38/38** tests de instalación/guardas/reversión, **14/14** contratos
del validador; typecheck exit 0. `git diff --check` exit 0. Los contratos añadidos
verifican staging privado de ruta idéntica host/worker e imagen local por SHA-256
completo. No sustituyen la prueba real de gVisor pendiente.

No se realizaron más conexiones ni escrituras después de liberar SSH al agente
de pruebas de persistencia. La siguiente habilitación requiere revisión; este
informe no proporciona una vía para eludir perfiles de seguridad.

## Recomprobación de publicación — 2026-09-05 01:44 UTC

SSH respondió y los runtimes efectivos siguen siendo `runc` e
`io.containerd.runc.v2`, con `runc` predeterminado. Un helper temporal de lectura
con `--pid host`, `CAP_KILL`, sin red y sin cambiar AppArmor/seccomp verificó la
misma identidad de dockerd y ejecutó únicamente `process.kill(173770, 0)`:

```json
{"stage":"read-identity","pid":173770,"comm":"dockerd","startTicks":"7292944","profiles":{"helper":"docker-default (enforce)","daemon":"unconfined"}}
{"stage":"permission-probe-signal-zero","allowed":true,"signalSent":false}
```

Exit 0. La señal cero no envía una señal: no acredita que SIGHUP esté permitido
ni permite atribuir el fallo previo a una protección concreta. No se repitió la
recarga, no se escribió configuración ni se usó un helper privilegiado.
Backend/frontend/DB/Redis conservaron PID/StartedAt y están `healthy`. La API
pública confirmó salud a `2026-09-05T01:44:57.907Z`, con versión `0f24e4d0`.
El acceso a una terminal administrativa del host sigue siendo la vía propuesta
para revisar la recarga sin eludir las protecciones del contenedor de despliegue.
La [documentación Docker](https://docs.docker.com/reference/cli/dockerd/#configuration-reload-behavior)
confirma que `runtimes` admite recarga; eso no prueba que el intento local funcione.
