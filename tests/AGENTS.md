# AGENTS.md — Pruebas que detectan regresiones

Aplica a `tests/`. Complementa [el raíz](../AGENTS.md); también debe leerse
cuando se cambien pruebas en otro subtree, junto con su contrato específico.
Objetivo: demostrar conservación de comportamiento, no aumentar artificialmente un contador.

## Elegir la evidencia

- DEBE: identificar contrato, fallo observable y frontera bajo prueba antes de escribir expectativas.
- DEBE: en una corrección, demostrar el caso previo y posterior; si no es reproducible, declarar el límite.
- DEBE: leer runner, configuración, fixtures y scripts reales; un archivo nuevo no garantiza que CI lo descubra.
- DEBE: cubrir éxito, error y efectos laterales, no solo texto fuente, mocks llamados o HTTP 200.
- DEBE: incluir cancelación, timeout, duplicados, concurrencia y reanudación cuando se toque su contrato.
- DEBE: verificar permisos, pertenencia y rechazo entre usuarios/tenants cuando se toque acceso a recursos.
- DEBE: para documentos, comprobar bytes finales, cambio solicitado, formato y conservación del original.
- DEBE: una operación rechazada no dejar un trabajo, cobro, archivo o acceso adicional no autorizado.

## Asincronía y aislamiento

- DEBE: esperar una condición observable con límite; respuesta HTTP y cleanup pueden terminar en momentos distintos.
- NO DEBE: usar una espera arbitraria, ampliar retries o quitar un assert para disimular una carrera.
- DEBE: conservar la aserción y corregir sincronización o implementación según el contrato real.
- DEBE: usar datos sintéticos, IDs y recursos propios; restaurar globals, temporizadores y variables alterados.
- DEBE: comprobar destino efectivo antes de comandos que conectan DB, Redis, storage o proveedores.
- NO DEBE: usar documentos privados, credenciales, cuentas reales o producción como fixtures por defecto.
- DEBE: cleanup limitado al recurso creado por la prueba; no borrar carpetas compartidas ni procesos ajenos.
- DEBE: separar fallo del producto, fallo del test y falta de infraestructura; ninguno permite inventar un pase.

## Dobles y controles de calidad

- DEBE: respetar las restricciones de dobles del módulo; declarar servicios reales, simulados y no comprobados.
- NO DEBE: afirmar integración SQL, aislamiento de sandbox o edición real a partir de mocks de esas fronteras.
- NO DEBE: introducir `.only`, `skip`, exclusiones, cuarentena o `continue-on-error` para hacer pasar un cambio.
- NO DEBE: debilitar asserts, thresholds, snapshots o baselines de rendimiento/cobertura por conveniencia.
- DEBE: un cambio intencional de contrato actualizar expectativas solo con alcance aprobado y evidencia revisada.
- DEBE: investigar un fallo antes de repetir CI; un rerun transitorio requiere causa y evidencia documentadas.
- DEBE: cero pruebas descubiertas fallar como validación, no contabilizarse como éxito.

## Runners reales del checkout

Revisar [package.json](../package.json), [backend/package.json](../backend/package.json)
y [CI](../.github/workflows/ci.yml). Estos ejemplos no son una lista universal de gates:

- Raíz: `npm test` compila [tsconfig de pruebas](tsconfig.json) y usa el registro de paths.
- Raíz: `npm run test:unit -- --pool=threads` ejecuta Vitest.
- Backend: `npm test` usa una lista manual; no equivale al descubrimiento completo de los shards de CI.
- Backend: [scripts/test-shard.sh](../backend/scripts/test-shard.sh) descubre las suites JS;
  verificar total, shard y exclusiones del pipeline antes de elegir un subconjunto.
- Navegador: leer [e2e/AGENTS.md](../e2e/AGENTS.md) y [playwright.config.ts](../playwright.config.ts).
- DEBE: inspeccionar hooks de preparación antes de ejecutar; generar el cliente Prisma no autoriza migraciones.
- DEBE: usar runtime y umbrales del pipeline vigente; no copiar scripts inexistentes de guías antiguas.

## Entrega de resultados

- DEBE: registrar comando, cwd, SHA, runtime, entorno, resultado, exclusiones y dependencias de la prueba.
- DEBE: distinguir unitarias, integración, navegador con API interceptada y E2E con servicios reales.
- NO DEBE: sumar reruns de los mismos casos como pruebas distintas ni afirmar cobertura sin denominador medido.
- DEBE: conservar evidencia sanitizada de fallos; no publicar storage state, tokens, cuerpos privados o dumps.
- Para cambios solo documentales, validar enlaces, comandos, conflictos y diff; no declarar pruebas runtime no ejecutadas.
