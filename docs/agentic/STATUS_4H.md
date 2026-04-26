# Agentic Core 4H Status

Fecha: 2026-04-26

## Estado

Tercera pasada completada localmente: `execution_trace_frame` integrado para observabilidad del runtime sin payloads crudos.

## Hitos

- Hito 1: completado. Inspeccion del repositorio, rama y scripts completada.
- Hito 2: completado. Implementado `backend/src/services/sira/token-ledger.js`.
- Hito 3: completado. Integrada auditoria `token_usage_recorded` en `chat-controller`.
- Hito 4: completado parcialmente. Tests, build, lint y smoke HTTP pasaron. Browser Use no pudo completar navegacion por timeout del plugin/browser.
- Hito 5: completado. Politica de presupuesto de tokens por plan/turno/conversacion/dia integrada antes del engine/runtime.
- Hito 6: completado. Frame de trazabilidad de ejecucion por workflow con contadores, timeline, nodos, herramientas, retries y auditoria resumida.

## Validaciones ejecutadas

- `git status --short`
- `find docs -maxdepth 3 -type f`
- `find backend/src/services -maxdepth 3 -type f`
- `node -e "const p=require('./package.json'); console.log(JSON.stringify(p.scripts,null,2))"`
- `rm -rf .test-dist && node ./node_modules/typescript/bin/tsc -p tests/tsconfig.json && node --test --test-name-pattern="sira token ledger|sira chat controller token accounting" .test-dist/tests/sira-token-ledger.test.js`
- `npm test`
- `npm run build`
- `npm run lint`
- `PORT=3001 npm run dev`
- `curl -I --max-time 15 http://localhost:3001/chat`
- `curl -I --max-time 10 http://localhost:3001/chat`
- `curl -L --max-time 10 http://localhost:3001/chat | head -c 500`
- `rm -rf .test-dist && node ./node_modules/typescript/bin/tsc -p tests/tsconfig.json && node --test --test-name-pattern="sira token budget" .test-dist/tests/sira-token-budget-policy.test.js`
- `node --test --test-name-pattern="token budget" .test-dist/tests/sira-token-budget-policy.test.js`
- `rm -rf .test-dist && node ./node_modules/typescript/bin/tsc -p tests/tsconfig.json && node --test --test-name-pattern="execution trace" .test-dist/tests/sira-execution-trace-frame.test.js`
- `npm test`
- `npm run build`
- `npm run lint`
- `PORT=3001 npm run dev`
- `@browser-use` via Node REPL against `http://localhost:3001/chat`
- `curl -I --max-time 20 http://localhost:3001/chat`
- `curl -L --max-time 20 http://localhost:3001/chat | head -c 800`

## Observaciones

- El arbol de trabajo contiene cambios previos no relacionados en UI, rutas, tests y `package.json`.
- El sprint no debe revertir ni mezclar esas modificaciones.
- La mejora seleccionada evita modificar componentes visuales y se integra en backend Sira.
- El primer intento de filtro mediante `npm test -- --test-name-pattern=...` corrio mas del suite por orden de argumentos del script; la validacion focalizada se ejecuto luego con `node --test` directamente.
- `npm test` paso con 231 tests y 0 fallos.
- `npm run build` compilo correctamente.
- `npm run lint` termino con exit code 0, pero conserva warnings preexistentes de `react-hooks/exhaustive-deps` y `@next/next/no-img-element`.
- Browser Use fue intentado contra `localhost:3000` y `localhost:3001`, pero el runtime del plugin expiro. El smoke HTTP contra `3001` confirmo `HTTP/1.1 200 OK` para `/chat` despues de la compilacion inicial de Next.
- El comando con patron `sira token budget` valido solo el suite de policy por coincidencia de nombre. Se ejecuto despues `token budget`, que valido policy y controlador: 5 tests, 0 fallos.
- El bloqueo por presupuesto ocurre despues de persistir el mensaje del usuario y antes de crear envelope/tool runtime, para evitar perdida de contexto y coste innecesario.
- En la segunda pasada, Browser Use volvio a expirar durante bootstrap del navegador in-app. El primer `curl` tambien expiro mientras Next compilaba `/chat`; el reintento posterior devolvio `HTTP/1.1 200 OK` y HTML de la pagina.
- En la tercera pasada, la validacion focalizada de execution trace paso con 2 tests y 0 fallos.
- `npm test` paso con 233 tests y 0 fallos.
- `npm run build` compilo correctamente.
- `npm run lint` termino con exit code 0; los warnings reportados son preexistentes en archivos de frontend no modificados por este hito.
- `@browser-use` fue intentado contra `localhost:3001`, pero el runtime del plugin expiro a los 60s durante bootstrap. El smoke HTTP local confirmo `HTTP/1.1 200 OK` y HTML SSR para `/chat`.
- El `execution_trace_frame` queda disponible en `runtime.summary.execution_trace` y auditado como `execution_trace_recorded`, sin registrar prompts, adjuntos, inputs de herramientas ni outputs de herramientas.
