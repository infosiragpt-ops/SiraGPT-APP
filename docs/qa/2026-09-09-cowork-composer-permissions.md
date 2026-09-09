# Publicación parcial: permisos Cowork y regresión de enrutado

## Alcance

Base viva observada: `99f96b715626486eb7652e6f3757e11c38f790bc`, `production-main`.
Este incremento separa cuatro entradas del clasificador de permisos del
piloto chat-first. No incorpora ni habilita el piloto, ejecución de proyectos,
preview ejecutable, rediseño visual, flags, proveedores o migraciones.

Durante la revisión, `production-main` incorporó #664. Se reprodujo una
regresión: manuales/informes sobre software podían bloquear Office y anunciar
`web_artifact`; Word con gráficos podía enrutarse a visualización. Este PR
incluye una corrección acotada de esa base: distinguir el objeto documental de
su tema, preservar prioridad documental en ambos clasificadores frontend y
evitar señales web contradictorias en backend. Se mantienen los builds web
auténticos y las rutas existentes del agente para pedidos compuestos.

No se modifica ningún componente visual en esta corrección. La actualización
del UI lock corresponde exclusivamente a `lib/ai-service.ts` y
`lib/software-build-intent.ts`. También se restaura en `backend/package.json`
el smoke `agentes-coding-harness-todo-smoke.test.js` eliminado por #664;
no se retiran pruebas, excepciones ni umbrales.

- `ws_write`, `ws_edit`, `ws_move`, `ws_delete` usan la política de escritura
  del compositor ya existente.
- `read` bloquea esas cuatro operaciones incluso con aprobación.
- `protected` exige aprobación explícita en el contexto confiable. No añade
  una nueva interfaz de aprobación ni acepta permisos en los argumentos del modelo.
- `default`, `workspace`, `full` conservan sus decisiones anteriores.
- `ws_read`, `ws_glob`, `ws_grep` conservan lectura/búsqueda sin aprobación.
- La confirmación propia de borrado del harness no se modifica.

No certifica todos los efectos secundarios de otras herramientas de Cowork
ni la aceptación del MVP de programación. La integración privada de ese MVP,
cuotas persistentes, aislamiento y demostración completa siguen pendientes.

Límite preexistente comprobado contra `a133aeba7` (antes de #664):
el manual sin formato explícito mantiene `chat_only` en la política de entrega,
aunque el router semántico lo reconoce como documento. El informe sobre una
app conserva contrato semántico de texto y política de entrega documental.
Este parche no certifica ni rediseña esas inconsistencias anteriores; impide
los nuevos bloqueos Office y formatos web contradictorios.

## Evidencia local

Las 45 pruebas nuevas de política se ejecutaron antes del cambio de código:
16 pasaron y 29 fallaron. Después del cambio pasan las 45.

Regresión de #664: nuevos casos fallaron antes del parche. Las expectativas
se contrastaron con módulos de `a133aeba7` evaluados aisladamente, sin red;
no se atribuyeron a #664 comportamientos anteriores. Tras corregir, pasan
66 pruebas frontend de intención/solicitud documental y 58 pruebas backend
de clasificador, router semántico y política de documentos.

Con regresiones existentes: 61/61 pruebas de política pasan. Cobertura unitaria
separada del módulo Composer y del gate: 95.32% líneas, 96.10% ramas, 93.75%
funciones; umbrales de 80% conservados en las tres métricas.

17/17 pruebas adicionales conducen el dispatcher ReAct real y el gate real,
con modelo determinista y herramientas espía en memoria. No son aceptación
HTTP/auth/base de datos, no invocan proveedores y no se suman a cobertura unitaria.

```sh
node --max-old-space-size=256 --test --test-timeout=10000 \
  --experimental-test-coverage \
  --test-coverage-include='backend/src/services/composer-permission.js' \
  --test-coverage-include='backend/src/services/agents/chat-tool-policy.js' \
  --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 \
  backend/tests/composer-permission.test.js \
  backend/tests/composer-cowork-permission.test.js \
  backend/tests/chat-tool-policy.test.js

node --max-old-space-size=256 --test --test-timeout=10000 \
  backend/tests/composer-cowork-dispatch.test.js

bash scripts/check-secrets.sh backend/src/services/composer-permission.js \
  backend/tests/composer-cowork-permission.test.js \
  backend/tests/composer-cowork-dispatch.test.js CHANGELOG.md \
  docs/qa/2026-09-09-cowork-composer-permissions.md
bash scripts/verify-ui-lock.sh
git diff --check
```

Se usaron dependencias ya instaladas sin regenerar el cliente Prisma ni
modificar el checkout de otros trabajos. Los dos archivos de pruebas están
en el descubrimiento ordinario de CI; no hay excepciones ni skips añadidos.

## Controles de publicación (no equivalen a evidencia de despliegue)

1. PR a `production-main`, checks obligatorios verdes para el SHA exacto,
   revisión y squash normal; nunca `--admin` ni push a `main`.
2. Revalidar SHA vivo, checkout limpio, lock, colas y checkpoints antes de
   activar. No sobrescribir publicaciones concurrentes.
3. Respaldar uploads/checkpoints además del dump PostgreSQL que crea el
   publicador revisado. Verificar archivo, permisos y lectura del respaldo.
4. Confirmar que el diff no contiene esquema/migraciones ni configuración.
   Ejecutar el publicador Lenovo con SHA objetivo y SHA vivo esperado.
5. Verificar SHA público, readiness, `/agentes`, política en la imagen activa
   y compatibilidad visual. DB, Redis y gateway conservan sus identidades.

Estado al escribir este documento: cambio local preparado, no publicado.
El resultado efectivo de PR/CI/publicación se registra por separado; no
interpretar este documento como confirmación de producción ni como MVP completo.
