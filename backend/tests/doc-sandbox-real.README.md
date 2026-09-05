# Pruebas sintéticas smoke/complejas e infraestructura real

Este runner prueba `DocumentSandboxProcessor`, el SDK Anthropic, PostgreSQL,
almacenamiento S3 cifrado y el validador independiente con `runsc`. **No es una
prueba E2E del navegador ni utiliza documentos reales de usuarios. No declara
automáticamente satisfechos los goldens de §10 ni los gates de la fase 1.** No hay mocks,
skips, fallback de modelo ni aprobación simulada del validador.

La suite predeterminada (`--suite=smoke`, opcional) contiene `SMOKE_DOCX` (año en Word), `SMOKE_XLSX` (una celda
numérica sin dependencias), `SMOKE_PPTX` (título y nota de una sola diapositiva),
`SMOKE_PDF_MERGE` (fusión simple de dos PDF) y `SMOKE_NOOP` (Word sin cambios).
Los originales son sintéticos. Durante ejecución pagada, la verificación exige
las cuatro capas reales y las aserciones del cambio simple, texto de control,
nombre y hashes; esto no convierte los fixtures reducidos en goldens completos.

La suite **explícita** `--suite=complex --fixtures-dir=/ruta/absoluta/corpus`
consume originales reproducibles de los generadores separados, definidos en
[`fixtures/docs/README.md`](fixtures/docs/README.md), con candidatos G1, G4, G7,
G8, G11 y G10 (aceptación F1 por devolución intacta y rechazo explícito). Incluye Word de dos páginas con tres runs, Excel
con dependencias y gráfico, PowerPoint de ocho slides y PDF con formulario,
fuente embebida y original escaneado. `fixtures/complex-cases.cjs` carga esos
originales y verifica sus hashes antes de acceder a infraestructura. No acepta
un directorio relativo, un archivo sustituido, un symlink de entrada ni un
manifiesto incompleto. No regenera originales de una campaña existente ni
cambia `SMOKE_*` por `G*` para aparentar cobertura. El presupuesto y ledger fijo
son los mismos para ambas suites; seleccionar la otra suite no los restablece.

### Oráculo complejo

`fixtures/complex-oracle.cjs` se aplica **después** de las cuatro capas reales.
El runner recupera todos los originales guardados en S3, en el orden del job,
contrasta hashes/nombres con el corpus y obtiene inventarios de los originales
y la salida mediante el validador aislado real. El oráculo no ejecuta scripts del
modelo ni evalúa sus XPath. La comparación Office adicional utiliza ZIP/XML
ya inspeccionados; no es una atestación alternativa de aislamiento.

| Caso | Aserciones obligatorias, además de las cuatro capas |
|---|---|
| G1 | Frase completa en los tres runs originales; cada `w:rPr` intacto; solo sus hojas de texto pueden cambiar; demás partes idénticas; página 2 sin regiones autorizadas y con cero píxeles cambiados |
| G4 | Solo B4=110, B5=130, B6=90; fórmulas, shared strings, reglas, merges, gráfico y otra hoja intactos; `fullCalcOnLoad`; totales esperados 2830 / 509.4 / 3339.4; baseline real de recálculo/render |
| G7 | Solo título y nota de slide 3; ocho slides y ocho notas renderizadas; otras notas, imágenes, masters y layouts idénticos |
| G8 | Merge en orden + seis overlays exactos (tres números y tres marcas de agua); páginas locales de cada input, coordenadas y tamaños exactos; texto original en orden; evidencia real de formularios/catálogo/recursos, comparación visual y textual contra baseline |
| G11 | Archivo, nombre y bytes originales; plan sin operaciones ni rechazo; `job.outcome` y resultado `unchanged` |
| G10 | Archivo original byte a byte; job `done` con `outcome=not_possible`, motivo explícito, cero cambios aplicados; no admitir un no-op silencioso como rechazo |

G1 no permite eliminar/recrear runs: el contrato F1 conserva estructura y
propiedades, y solo modifica hojas de texto. G4 admite caches originales si se
activa recálculo; el oráculo no los presenta como resultados ya recalculados.
El validador abre/recalcula y contrasta el render con su baseline independiente.
G8 usa Helvetica conforme al contrato actual de `pdf_overlay`; un número de
página global 3 dirigido al primer input (que solo tiene dos páginas) falla.

**Integrar o probar el oráculo no ejecuta estos goldens con Anthropic.** Todos los
resúmenes mantienen `specificationGoldensSatisfied: false`,
`phase1GatesSatisfied: false` y `finalUserSamplesVerified: false`, aun si todos
los candidatos pasan. Faltan la ejecución pagada autorizada y la aceptación
integral independiente; las muestras anonimizadas de usuarios no se sustituyen
por este corpus.

## Requisitos

- Compilar primero con `npm run build:doc-sandbox` desde `backend`.
- Para preflight sólo se requieren PostgreSQL, S3, cifrado y validador reales;
  no se carga la configuración Anthropic. La imagen debe estar fijada por digest
  en `DOC_SANDBOX_VALIDATOR_IMAGE` y `runsc` debe estar operativo.
- `DOC_SANDBOX_VALIDATION_STAGING_ROOT`: ruta absoluta compartida montada con la
  misma ruta en el host Docker y el worker/runner. No usar el `/tmp` privado de
  un contenedor como origen de los bind mounts del daemon del host.
- `DOC_SANDBOX_REAL_DATABASE_URL`: PostgreSQL **loopback** o el host Docker exacto
  `doc-sandbox-test-postgres`, con nombre de base de
  datos que contenga `doc_sandbox`, `doc-sandbox`, `doc_phase1` o `doc-phase1`.
  No utilizar la base de datos de producción.
- `R2_ENDPOINT`: S3/MinIO real **loopback** o el host Docker exacto
  `doc-sandbox-test-minio`, y bucket existente cuyo nombre sea
  `doc-sandbox-phase1-real` o empiece por `doc-sandbox-phase1-real-`.
  Deben existir `R2_BUCKET_NAME` o `R2_BUCKET`, `R2_ACCESS_KEY_ID` y
  `R2_SECRET_ACCESS_KEY`. No se crea un bucket.
- `DOC_SANDBOX_ENCRYPTION_KEY` es la clave real del almacenamiento de pruebas,
  codificada en base64 (32 bytes); se admiten el ID y keyring anteriores mediante
  `DOC_SANDBOX_ENCRYPTION_KEY_ID` y `DOC_SANDBOX_PREVIOUS_KEYS_JSON`.
- Un directorio de evidencia absoluto y privado, con permisos `0700`.

El runner crea sólo el esquema fijo `doc_sandbox_real_phase1` dentro de esa base
aislada. Usa las migraciones reales del módulo y una relación mínima `users` para
el dueño sintético. **Nunca borra este esquema ni resetea el presupuesto:** ahí
permanecen jobs, reservas, costes, referencias de limpieza y autorización.

## Preflight sin llamadas pagadas

Desde `backend`, con secretos ya inyectados de forma segura:

```sh
node tests/doc-sandbox-real.cjs --preflight --campaign=phase1-a --authorize-usd=5 --out=/private/path/evidence
node tests/doc-sandbox-real.cjs --preflight --suite=complex --fixtures-dir=/private/path/corpus --campaign=phase1-complex-a --authorize-usd=5 --out=/private/path/evidence
```

Debe fallar, no omitir pruebas, si falta configuración, PostgreSQL, S3 o runsc.
El preflight inspecciona los cinco smoke o los seis candidatos complejos con el validador real y realiza
cero llamadas a Messages/Files de Anthropic. **No necesita `ANTHROPIC_API_KEY`,
modelos, precios, skills, `DOC_SANDBOX_ENGINE`, `REDIS_URL` ni `R2_ACCOUNT_ID`.**
No se inventan valores de proveedor para completar el preflight. Inspeccionar
originales no acredita edición, resultados del modelo ni los goldens de §10.

## Ejecución pagada: todavía requiere evidencia del límite duro

`--execute-real` sí exige la configuración real completa aceptada por
`loadDocumentSandboxConfig`: clave Anthropic secreta, modelos y tarifas reales,
versiones de skills fijadas y todos los límites. `REDIS_URL` debe usar loopback o
`doc-sandbox-test-redis`; el runner invoca directamente el procesador y no afirma
probar BullMQ/Redis. Ninguna guarda de presupuesto se omite por haber pasado el
preflight sin proveedor.

La autorización del usuario es **US$5 en total**, no US$5 por documento ni por
campaña. Se retienen US$0,75 de margen al autorizar US$5. Un lock asesor PostgreSQL
serializa las campañas. Antes de **cada llamada** se suman los costes y reservas
de todos los jobs del dueño fijo; una reserva/coste desconocido detiene todo.
Una campaña nueva no permite restablecer ese total.

Esto no convierte estimaciones de tokens/tiempo de ejecución en facturas exactas.
Para ejecutar, un operador debe haber verificado un límite duro real de Anthropic
y poner su evidencia en el archivo privado indicado por
`DOC_SANDBOX_REAL_PROVIDER_LIMIT_PROOF_FILE`. El JSON exige estos campos:

- `provider`: `anthropic`.
- `providerEnforced`: booleano que sólo puede ser verdadero tras verificación real.
- `hardLimitUsd`: límite duro real, positivo y no mayor que la autorización.
- `remainingUsd`: saldo real positivo, no mayor que ese límite.
- `verifiedAt`: timestamp de la verificación real de las últimas 24 horas.
- `reference`: identificador o referencia de la evidencia, sin secretos.

El archivo debe ser regular, no symlink, y tener permisos privados (`0600`). El
runner identifica expresamente esta evidencia como verificación del operador;
**no inventa que consultó una API de facturación**. No crear evidencia ficticia
para desbloquearlo si el proveedor sólo ofrece avisos o límites blandos.

Sólo después de verificar realmente el límite y recibir la orden de ejecutar:

```sh
node tests/doc-sandbox-real.cjs --execute-real --campaign=phase1-a --authorize-usd=5 --out=/private/path/evidence
node tests/doc-sandbox-real.cjs --execute-real --suite=complex --fixtures-dir=/private/path/corpus --campaign=phase1-complex-a --authorize-usd=5 --out=/private/path/evidence
```

No ejecuta reintentos automáticos extra de un caso fallido/reencolado. Si un job
anterior de la misma campaña está incompleto, exige reconciliación manual. Un
caso completado puede releerse y verificarse sin volver a pagar. También se
verifica su `payload_hash`: una campaña con instrucciones o fixtures distintos
no puede apropiarse de evidencia anterior. Cada suite pasa todas sus guardas de
configuración y presupuesto, incluso al releer jobs.

## Evidencia y límites

Se guardan resúmenes `0600`, informes independientes, los originales recuperados,
artefactos privados y sus
SHA-256. Los errores sin filtrar del SDK no se imprimen. `summary.json` distingue
coste estimado, saldo desconocido, fixtures sintéticos y ausencia de E2E UI. Los
contenedores remotos no se declaran borrados por haber eliminado Files; sus TTL
siguen en el registro durable. El TTL/DELETE de los objetos locales requiere el
reconciliador del entorno de pruebas, conservando el registro de facturación.

Pruebas locales, después del build y con Python/lxml/openpyxl/Pillow/ReportLab:

```sh
DOC_FIXTURE_PYTHON=/ruta/python3 node --test tests/doc-sandbox-real.fixture.test.cjs tests/doc-sandbox-complex.fixture.test.cjs tests/doc-sandbox-complex.oracle.test.cjs
```

Validan argumentos, generadores, contrato de resultado y el propio oráculo.
Las pruebas Office invocan el inspector Python real sobre originales y mutaciones
de laboratorio; no construyen un informe de validación aprobado ficticio.
Las pruebas del plan PDF no equivalen a abrir/renderizar un PDF ni acreditar G8.
**No acreditan ningún golden del editor real, runsc ni E2E del navegador.**
