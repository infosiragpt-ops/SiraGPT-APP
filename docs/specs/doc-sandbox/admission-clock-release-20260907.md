# F1 — vencimiento durante la admisión del validador

2026-09-07 UTC. **PR #561 no desplegada; F1 continúa pendiente.**
Base del arreglo: `40f86de4ea8f793526649076e09d22dec41e2a6f`.

## Defecto reproducido y alcance del arreglo

El valor predeterminado de `now` en `assertInvocationLaunchable` se calculaba
antes de leer el manifiesto privado de forma asíncrona. Si esa lectura o la
continuación del proceso cruzaba el deadline, la admisión seguía usando el
reloj anterior y podía aceptar una invocación vencida. Se reprodujo con el
lifecycle real, filesystem y proceso hijo; no es una incidencia observada en
producción ni una prueba de acceso remoto al manifiesto privado del worker.

El runtime sólo cambia esa comprobación: `now?: number` y
`now ?? Date.now()` después de leer el manifiesto y comprobar cancelación.
El reloj explícito conserva su significado, incluido cero. No cambian las
comprobaciones de identidad, cuarentena, permisos, cierre ni cleanup.

## Regresión reproducible, sin sustituir IO ni reloj

Un hijo carga la fuente real y crea una invocación de un segundo. Primero
debe superar una admisión genuina. La segunda inicia `lstat` y, en el mismo
turno de JavaScript, comunica su estado y se detiene con SIGSTOP. El padre
comprueba el estado T del PID de su propio hijo mediante `ps`; sólo envía
SIGCONT después del deadline. El resultado exige
`VALIDATOR_INVOCATION_EXPIRED`, no un timeout genérico ni un error de arranque.
La semántica de señales está descrita por
[Node.js](https://nodejs.org/api/process.html#processkillpid-signal).

También exige que un `now` histórico explícito siga admitido y que el hash
del manifiesto, sus permisos, los bytes originales y un vecino no cambien.
No modifica Date, filesystem, Docker ni los helpers FIFO anteriores. Los
watchdogs de arranque/operación siempre fallan, matan únicamente ese hijo y
esperan `close` antes de permitir la limpieza de la fixture. La consulta de
estado del proceso propio requiere permiso fuera del sandbox local de macOS;
una denegación es fallo del harness, nunca evidencia del defecto ni éxito.

```text
node --import ./backend/node_modules/tsx/dist/loader.mjs --test backend/tests/doc-sandbox-validation-filesystem.test.ts
Mac Node 24.19.0, pre-fix: 44/45; 1 fail; 0 skip; 1640.630667 ms; exit 1
  esperado: DocumentValidationError / VALIDATOR_INVOCATION_EXPIRED
  recibido: fulfilled; controles temporales, positivos e integridad aprobados
Mac post-fix: 45/45; 0 fail/skip; 1866.712541 ms; exit 0
Linux Node 22.23.2, post-fix: 45/45; 0 fail/skip; 6452.295057 ms; exit 0
```

El ensayo Linux usa un candidato privado separado del checkout productivo,
imagen fija `sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e`,
usuario 1000, filesystem readonly, sin red ni socket Docker, 1 CPU/1 GiB y
timeout interno de 90 s. `ps -o stat= -p PID` se comprobó en esa imagen antes
del ensayo. Fuente y prueba coinciden por SHA-256 entre Mac y Lenovo:

```text
lifecycle.ts: 9d4ff08553177075e35e6530dc252b5c844247b619ce12c78ec2abe6b730e7d3
filesystem.test.ts: 9431b9d3c82383f633bfb42f74acf7f232e20ce2d103487ae7b6c065fcd481da
```

Al terminar no quedó runner de este lote; PostgreSQL/Redis/MinIO de pruebas
seguían detenidos y sin puertos publicados. No se usaron secretos productivos.

## Controles de regresión y límite de publicación

```text
npm --prefix backend run test:doc-sandbox:coverage
378/378; 0 fail/skip; 2064.689666 ms
Lines/Statements: 72.41% (2751/3799)
Branches: 86.46% (1227/1419); Functions: 76.13% (268/352)
exit 1: no cumple el 80% unitario, intacto
```

Generales recompiladas: **12472/12472**, 535 suites, cero omisiones,
`duration_ms 64205.758917`, exit 0. Tipos raíz/backend/focal, UI-lock y
diff-check: exit 0; lint: exit 0 con advertencias heredadas. Scripts, selección
de pruebas y definición de cobertura intactos; sin integrar pruebas de DB o
servicios en la métrica unitaria. Revisión independiente de runtime y harness
sin P1/P2. No hay cambio de frontend ni de esquema.

Logs locales ignorados: `output/phase1-admission-clock-prefixed.log`,
`-postfix.log`, `-linux.log`, `-unit-coverage.log`, `-root-tests.log`
(todos con el mismo prefijo).

## Continuidad

CI del padre `40f86de4`, run `34072756572`, falló cobertura/agregador;
el informe auxiliar de readiness no sustituye al CI principal. Este nuevo
arreglo requiere CI propio. A las **2026-09-07T03:16:22.932Z**, checkout Lenovo
limpio y API pública coinciden en `100d29bc2e76bf2fb6e875514112f5cae1e40025`,
readiness HTTP 200 saludable, no #561. La rama remota `production-main`
avanzó durante este lote a `546a8156b2ec63c468157a4125aebcb4705f80db`;
ese avance no acredita publicación y no se ha integrado en este arreglo.
Corresponde a #572, fusionada a las 03:10:22Z, con 33 archivos; no toca el
módulo documental. El solapamiento con la rama F1 es `backend/package.json`
(scripts de pruebas, sin dependencias): una integración posterior debe
conservar ambos grupos de scripts y repetir pruebas de agentes/recuperación.
A las 03:18:07Z, sus CI `34078736477` y Docker `34078736479` siguen en curso.
Los resultados anteriores son sobre `40f86de4`/`100d29bc2`, **no** sobre esa
combinación todavía no probada. No se hizo fetch, merge ni checkout de #572.

La prueba acredita admisión, **no** lanzamiento Docker ni aislamiento gVisor.
Quedan separadas la observación estática del mínimo de 1 ms antes de `spawn`
en el caller, los cambios del reloj del sistema, la falta de atomicidad entre
comprobar/lanzar y el posible crecimiento del archivo después de stat. No se
afirma resolverlas con este delta. Tampoco se acredita el proceso documental
completo, aceptación auténtica, infraestructura privada o ensayo migratorio.
Gasto nuevo US$0; sin despliegue, reinicio, DNS ni modificación productiva.

Guías utilizadas: `agent-validation`, `quality-gates`, `secret-safety`,
`release-orchestrator` y `technical-docs`. Sus controles mantienen separadas
la evidencia de código y la autorización técnica para producción.
