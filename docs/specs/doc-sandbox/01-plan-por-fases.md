# Plan de implementación — fase 1 autorizada

Fecha: 2026-09-04. Base auditada: `0f24e4d004f156eae838e21592539cca91f53cd3`.

**F1 en implementación, autorizada por Luis: “procede con la fase 1”.** Se aprobó un presupuesto total de US$5 para pruebas Anthropic y usar el Lenovo para pruebas aisladas. La instalación de gVisor solo está autorizada sin reiniciar Docker ni producción. Las secciones siguientes conservan el plan aprobado; no certifican que ya se haya ejecutado todo. Las fases 2–5 y la publicación siguen requiriendo aprobación independiente. [Especificación](SPEC-sandbox-edicion-documentos.md) · [Decisiones](decisiones.md) · [Diagnóstico](00-contexto-repo.md) · [Evidencia inicial](evidencia-diagnostico.md).

## Objetivo y estrategia

Editar el archivo original, conservar nombre/formato y modificar únicamente lo solicitado; procesar de forma duradera, verificar independientemente, devolver receta/diff/reporte y permitir cancelación/borrado. Reutilizar auth, Postgres/Prisma, Redis/BullMQ y storage existentes; sustituir gradualmente el flujo documental, no duplicar todo SiraGPT.

Una rama por fase: `feat/doc-sandbox-fase-N`, siempre basada en el último `production-main`. Cada fase requiere implementación, pruebas propias, revisión independiente, reporte de ocho secciones de §12 y aprobación antes de la siguiente. El plan inicial fue solo documentación; F1 ya añade código y migraciones aditivas, todavía sin publicación.

| Fase | Entrega | Estimación de ingeniería |
| --- | --- | --- |
| 1 | Núcleo duradero, Motor A, preserve y validación mínima completa | 5–8 días |
| 2 | Fidelidad ampliada, XLSM, control de cambios y comparación visible | 4–7 días |
| 3 | Plan aprobado, seguimiento, lote y experiencia integrada completa | 3–5 días |
| 4 | Motor B Docker con paridad e aislamiento comprobado | 4–6 días |
| 5 | ODF/legacy/OCR/imágenes y reformat explícito | 4–7 días |

Total orientativo: **20–33 días de ingeniería**, no promesa de tiempo de reloj ni de ejecución continua del agente. Incluye pruebas/correcciones; depende de documentos reales, licencias, acceso de test, cuota y hardware. Cada estimación se revisa al cerrar la fase anterior. No se promete fidelidad perfecta en PDF con reflujo ni Google Docs nativo.

## Cambios contractuales que se someten a aprobación

1. Adelantar controles mínimos reales de apertura y visual a F1; ningún formato se publica con un control exigible ausente (D03).
2. Integrar UI en `/agentes` y Biblioteca; no nueva navegación `/documentos` sin aprobación específica (D01).
3. F1 incluye DOCX/XLSX/PPTX/PDF y planos; XLSM se habilita al pasar G6 en F2. Approval/follow-up/G12/batch se entregan en F3; reformat en F5 (D06/D15).
4. Validación aislada bajo autoridad del worker, plan verificable y congelado, borrado remoto con estado real, y sustitución de vendorización restringida por skills propias (D04/D05/D10/D14).

## Fase 1 — Núcleo y Motor A

### Trabajo y archivos previstos

- Crear `backend/src/modules/doc-sandbox/{api,queue,engine,agent,validation,storage,events,types}/`; `README.md`; prompts versionados y esquemas estrictos. Interfaz intercambiable, Motor A único disponible inicialmente; Motor B no se simula ni anuncia como disponible.
- Crear `backend/tsconfig.doc-sandbox.json` y punto de entrada compilado; modificar `backend/package.json`, lock, build y `backend/Dockerfile` para compilar/cargar el módulo (D02).
- Modificar `backend/prisma/schema.prisma`; crear migración aditiva `backend/prisma/migrations/<timestamp>_doc_sandbox_core/migration.sql`, con instrucciones de reversión segura.
- Crear router específico en el módulo; integrar montaje en `backend/index.js` antes del alias Swagger, reutilizando auth/rate limit/CSRF y comprobación de usuario en cada acceso.
- Crear worker/procesador con outbox, lease, secuencias, recuperación y cancelación. Reutilizar conexiones existentes de Redis/Prisma; no guardar bytes en Redis ni fallback local en producción.
- Crear adapter privado de storage con cifrado comprobado, original inmutable, hashes, nombre original por artefacto, descarga firmada mediada ≤600 s y revocable por tombstone, purga y registro de limpieza del proveedor. Archivos de igual nombre en un lote se distinguen por IDs, no sobreescrituras.
- Crear `engine/anthropic-engine.ts` y pruebas de contrato. Verificar SDK/Files multipart, skills versionadas, continuación, abort, límites, receta exportada, descargas completas y usage agregado (D11/D12).
- Crear `validation/` y `infra/doc-validation/` para validadores reales externos al editor: estructura, apertura, visual y diff con aislamiento, perfil y fuentes fijados. Tres intentos totales máximo, cada uno desde input prístino.
- Crear `observability/{metrics,alerts,logger}.ts` dentro del módulo e integrar con registro/exportador y alertas existentes, sin contenido documental en logs. Métricas por job/fase y agregadas: éxito, p50/p95, costo medio, rollback y fallos por nivel; alertar al superar 20 % de fallos en ventana de 1 h o el timeout del job. Histograma/counters sin etiquetas por job/usuario de cardinalidad ilimitada; IDs solo en logs privados/trazas. Extender reglas y sus tests de `docs/prometheus-rules.yml` si ese es el mecanismo confirmado.
- Crear fixtures reproducibles bajo `backend/tests/fixtures/docs/`, generador y suites del módulo. Añadir scripts propuestos `test:doc-sandbox`, `test:doc-sandbox:real`, `type-check:doc-sandbox` y `test:e2e:docs`; hoy no existen con ese contrato.
- Integrar sin rediseño desde `backend/src/services/agent-harness/tools/document-edit-tool.js`, `backend/src/routes/doc.js`/`agent-task.js` y `lib/ai-service.ts` solo donde sea imprescindible para que la edición canónica use el job validado. Las rutas antiguas no deben entregar una salida de esta capacidad saltándose el gate.
- Actualizar `.env.example`, runbook y CI; registrar hashes/versiones de prompts, recetas, imágenes y herramientas. Cambios de UI de detalle se reservarán a F2/F3, salvo adapter mínimo de estado/artefacto autorizado en esta fase.

### Migración y dependencias

- Tres tablas requeridas: jobs, eventos y artefactos, con FK de propietario y padre, estado validado, secuencia por job, expiración e índices. Añadir campos de versión de plan/input, lease/fencing, idempotencia y limpieza. Usar eventos transaccionales como outbox para evitar una cuarta fuente de estado.
- Migración aditiva y compatible hacia atrás; probar desde base limpia y snapshot de test. Rollback de aplicación conserva datos. No DROP de datos productivos, ni `db push --accept-data-loss` fuera de DB efímera de tests. Una reversión destructiva solo aplica a entorno vacío o tras exportación/aprobación específica.
- Reutilizar BullMQ, Prisma, S3/presigner, zod, file-type y logger. Añadir herramientas TS de build necesarias, con versiones exactas acordes al lock. No actualizar todo el SDK por conveniencia: evaluar compatibilidad y pruebas primero.
- Imagen de validación con LibreOffice/poppler/qpdf, Python/lxml y comparador visual fijados por versión/digest; auditar fuentes y licencias. No usar código de skills documentales restringidas ni incorporar PyMuPDF antes de resolver D10.
- Variables nuevas solicitadas por la spec se documentan con tipo/default: familia `DOC_SANDBOX_*` para motor, modelos, retención, límites, timeout, tolerancia, costo y presupuesto. Reutilizar credenciales existentes mediante secretos del entorno; nunca texto en Git o conversación. Sin cambios al catálogo público de modelos.

### Pruebas y gate de salida

- Unitarios ≥80 % del módulo nuevo; SDK simulado solamente en sus unitarios. Todos los validadores ejecutan herramientas reales. Separar suites para que integración/E2E no hereden mocks de API/DB.
- G1/G4/G7/G8/G11 con Motor A real; G10 sin alterar PDF escaneado y pruebas de preservación de TXT/MD/CSV/JSON/HTML. Dos inputs para una fusión PDF no equivalen todavía a batch padre/hijos.
- ZIP/XML hostil, MIME falso, tamaño/páginas, dueño ajeno, URL vencida, no-op, ausencia de artefactos, plan malicioso, salida incompleta, caída de proveedor, cleanup fallido y texto sensible no presente en logs.
- Matar worker durante ejecución y antes/después de publicar; reentregar job; cancelar/borrar durante validación; comprobar que no reaparece output. SSE reconecta con secuencia consistente y snapshot sin perder terminales.
- Diez jobs concurrentes con contenidos distintos y presupuesto aprobado; medir SLO propuesto en D17, consumo, cola y aislamiento. No fabricar números de latencia.
- Inducir fallos/timeout en entorno de test, comprobar actualización de métricas y disparo/recuperación de ambas alertas mediante receptor de test, sin enviar incidentes falsos al canal operativo. Obtener enlace, borrar trabajo y verificar denegación al reutilizar la URL; el borrado pendiente no permite nuevas descargas.
- Al menos cinco jobs reales con receta, manifiesto, validación independiente, miniaturas/diff y costo. Apertura manual en Office de los formatos disponibles. Reporte `reporte-fase-1.md` con evidencia y revisión independiente.
- Sin credenciales, herramientas, licencias o presupuesto necesarios, se conserva el trabajo revisable y se declara bloqueado el gate. No publicar ni llamar «validado» al resultado incompleto.

### Riesgos y reversión

Riesgos altos: semántica de edición, render/fuentes, SDK cambiante, costo y carrera cancelación/publicación. Prueba pre/post de rutas heredadas evita regresión. Revertir la versión de la aplicación si falla el canary; detener admisión de jobs nuevos y drenar/cancelar con estado persistente. No retroceder a un editor que omita validación ni borrar tablas/volúmenes.

## Fase 2 — Fidelidad, XLSM y control de cambios

- **Archivos:** ampliar `validation/{structural,openability,visual,textual}.ts`, helpers OOXML y prompt/skills propios; fixtures y tests. Integrar miniaturas/diff/reporte en componentes de artefactos documentales existentes bajo `components/` y estado en `lib/chat-context-integrated.tsx`. Confirmar propietarios exactos en la rama al iniciar, sin duplicar vistas.
- **Trabajo:** preservar runs mixtos/revisiones previas; verificar vistas aceptada/rechazada de DOCX; recalcular copias de XLSX/XLSM con macros desactivadas; comprobar hashes de VBA/gráficos/relaciones; microedición PDF solo dentro de garantías aprobadas. Validar también regiones no cambiadas de páginas afectadas y estilos dentro del texto editado. Mostrar costo/usage sin inventar cero para datos desconocidos, respetando `DOC_SANDBOX_SHOW_COST`.
- **Migraciones:** ninguna nueva tabla prevista; metadata de validación versionada en JSON/artefactos. Si surge un cambio de esquema, justificarlo antes de implementarlo.
- **Dependencias:** ampliar fuentes/herramientas visuales solo con licencia y necesidad demostrada; renderer igual para ambos lados. Resolver biblioteca PDF sin degradar G9 en silencio.
- **Pruebas:** G2/G3/G5/G6/G9/G10 más toda F1; fallo real de validación en intento 1, restauración y éxito en 2; límite de 3 intentos; XLSM jamás ejecuta macro; golden de revisiones preexistentes y run con negrita intermedia. G12 de follow-up queda expresamente en F3, no se reporta aquí.
- **Riesgos:** falso positivo visual, fuentes faltantes, plan incompleto y pérdida de estilos. Ante fallo, conservar original y no publicar resultado. Rollback de componentes/validador a una versión compatible, nunca desactivar el nivel que falla.
- **Cierre:** `reporte-fase-2.md`, cinco jobs reales, control de cambios abierto en Word y gráficos/fórmulas comprobados en Excel; pruebas UI con backend real, no interceptando todas las APIs. Actualizar UI-lock solo por el cambio visual autorizado.

## Fase 3 — Approval, seguimiento y lotes

- **Archivos:** `api/`, `types/`, máquina de estados y `queue/`; `engine/` para política de sesión; componentes de detalle/plan en el chat y Biblioteca; cliente SSE y pruebas Playwright; skills originales en `agent/skills/` y su configuración/versionado.
- **Trabajo:** editar/quitar `after` del plan y aprobar su hash exacto antes de ejecutar; follow-up desde salida validada; no-op G12; batch padre/hijos, progreso agregado, costos y cancelación definidos. Un hijo fallido no convierte automáticamente el padre en éxito total.
- **Migraciones:** utilizar `parent_job_id` y plan/versionado de F1; índices adicionales solo si mediciones los justifican. Ninguna necesidad prevista de nuevo sistema de jobs.
- **Dependencias:** reutilizar cliente HTTP/SSE y UI existente. Custom skills se suben solo cuando sean propias, autorizadas y estén versionadas; nunca inputs privados como contenido global de una skill.
- **Pruebas:** G12 real, aprobación no ejecuta antes, plan obsoleto rechazado, aislamiento entre usuarios/archivos de igual nombre, recarga/reconexión, limpieza de sesión expirada, follow-up con nueva sesión y batch parcialmente fallido. Cada custom skill tiene golden propio con evaluación de formato y contenido solicitado.
- **Riesgos:** privacidad de sesión, carrera de aprobación y UX que oculte fallos parciales. Reutilizar contenedor remoto exige consentimiento/política definida en D14; una sesión nueva debe conservar continuidad mediante input validado, no por conversación implícita.
- **Cierre/reversión:** `reporte-fase-3.md`, experiencia de §9 completa en la superficie aprobada, tests de usuario real y accesibilidad. Deshabilitar admisión de modos nuevos si es necesario; no borrar jobs previos ni degradarlos silenciosamente a preserve.

## Fase 4 — Motor B Docker

- **Archivos:** `engine/docker-engine.ts`, loop y herramientas en `agent/`, skills propias; `infra/doc-sandbox/` con Dockerfile/lock de paquetes, launcher y reconciliador; pruebas de aislamiento/paridad, workflow CI y runbook.
- **Trabajo:** sesión efímera sin red/rootfs de solo lectura, usuario no privilegiado, capacidades eliminadas, límites y kill real; gVisor para usuarios no verificados según política. Editor y validador permanecen separados. Limpiar huérfanos tras crash.
- **Migraciones:** ninguna prevista; sesiones/engine/attempt ya pertenecen al modelo de F1.
- **Dependencias:** reutilizar ejecutor actual si demuestra garantías; `dockerode` solo si mejora la interfaz sin duplicarlo. Imagen fijada; skills originales, no copia de las cuatro skills con licencia restringida. El pool de 2–4 contenedores solo se usa con espacios limpios exclusivos por job y presupuesto de capacidad.
- **Pruebas:** G1–G12 aplicables con `engine=docker`, sin llamadas editoras a Files API; acceso a red y recursos del host rechazado, límites de procesos/tiempo, ejecución cancelada y huérfanos eliminados. Pruebas adversariales de archivos en outputs y escapes de rutas.
- **Riesgos:** privilegios del launcher, aislamiento insuficiente, costos de operación y contaminación del pool. Reversión: parar admisión Motor B; retorno explícito y aprobado a Motor A, nunca fallback silencioso ni reaprovechar contenedores contaminados.
- **Cierre:** `reporte-fase-4.md`, evidencia del runtime realmente utilizado, licencia/SBOM y paridad medible con Motor A.

## Fase 5 — Formatos adicionales y reformat

- **Archivos:** adaptadores/skills/validadores por formato; fixtures ODF/legacy/imagen/OCR, tests y controles del modo reformat dentro de la UI aprobada.
- **Trabajo:** ODF con `mimetype` primero/sin compresión; conversión legacy con consentimiento y aviso de posible pérdida; imágenes y OCR sin atribuir fidelidad perfecta a reescritura; reformat modifica solo propiedades expresamente aprobadas en el plan.
- **Migraciones:** ninguna prevista salvo metadata justificada y versionada; no rehacer las tres tablas.
- **Dependencias:** OCRmyPDF/Tesseract/Pillow y herramientas requeridas, con versiones/licencias auditadas; ejecución siempre aislada y sin macros. No publicar un formato si el motor elegido no dispone de las herramientas y validadores correspondientes.
- **Pruebas:** golden por formato y por cada modificación de formato autorizada; no-op, encoding, OCR, compresión/orden ODF, seguridad y regresión G1–G12. Confirmación explícita antes de conversión con pérdida; no confundir OCR estructural con fidelidad editable original.
- **Riesgos:** pérdida inevitable de conversión, fuentes y anotaciones; mostrar limitación antes de ejecutar. Reversión: retirar admisión del formato afectado, preservar originales y resultados ya verificados.
- **Cierre:** `reporte-fase-5.md`, muestra real por formato, reporte acumulado y límites permanentes visibles al usuario.

## Matriz de endpoints y primeras pruebas exigidas

Todos los endpoints propuestos requieren auth/ownership. Hasta su fase no se anuncian ni se crean como simulaciones.

| Endpoint | Fase | Prueba mínima |
| --- | --- | --- |
| `POST /api/docs/jobs` | F1 | multipart, sniffing, permisos, límites, idempotencia y rechazo de modo no disponible |
| `GET /api/docs/jobs/:id` | F1 | snapshot durable; 403 dueño ajeno; sin secreto/documento en log |
| `GET /api/docs/jobs/:id/events` | F1 | SSE real con Last-Event-ID, replay, reconexión y terminal |
| `GET /api/docs/jobs/:id/artifacts/:artifactId` | F1 | owner; documento editado solo tras validar; reportes de fallo sí accesibles; URL mediada ≤600 s y revocable |
| `POST /api/docs/jobs/:id/cancel` | F1 | cancelación idempotente, kill y no publicación posterior |
| `DELETE /api/docs/jobs/:id` | F1 | acceso revocado, objetos purgados, limpieza remota pendiente visible |
| `POST /api/docs/jobs/:id/approve` | F3 | plan/schema/hash válido; ninguna ejecución antes de aprobar |
| `POST /api/docs/jobs/:id/followup` | F3 | hijo aislado desde versión validada; G12 y sesión expirada |

La lista de jobs requerida por la experiencia se integrará en el mecanismo existente de Biblioteca o se propondrá un `GET /api/docs/jobs` paginado/owner-scoped en F3; el contrato definitivo se aprobará antes de añadirlo. No asumir que el detalle `GET :id` ya proporciona una lista.

## Verificación, CI y publicación futura

Comandos **existentes** de referencia (no todos ejecutados en este diagnóstico):

```sh
npm run lint
npm run type-check
npm test
npm run test:unit
npm --prefix backend test
bash scripts/verify-ui-lock.sh
```

La especificación escribe `typecheck`; el script actual se llama `type-check`. El módulo añadirá sus scripts compilados y `test:e2e:docs`, con bases de test aisladas y dependencias reales. El job CI de motor real será requerido para publicar y no se declarará aprobado al faltar credenciales. Cobertura ≥80 % del módulo, no porcentaje inflado por excluir validadores. Integraciones existentes con mocks se etiquetan como tales.

Cada cierre seguirá exactamente las ocho secciones de §12. La evidencia privada de documentos, recetas y transcripts queda en almacenamiento protegido; solo fixtures anónimas y reportes sin secretos se incorporan a Git. La revisión independiente ejecutará pruebas sin confiar en los números del implementador.

Después de aprobar el cierre: PR a `production-main`, CI requerida verde y autorización de publicación. Preflight de versión vigente, backup y comprobación de migraciones; despliegue por runbook existente, sin DNS ni borrado de volúmenes. Verificar SHA real, health, un job completo autenticado y descarga/validación del archivo desde el dominio. Un health verde por sí solo no valida la edición. Si falla el canary, rollback de aplicación preservando datos y estados de los jobs.

## Solicitud histórica — F1 posteriormente aprobada

Se solicitó **solo el inicio de F1**, con D01–D18 y los cambios de orden anteriores, y el usuario lo aprobó. Autorizó US$5 en total para Anthropic y pruebas aisladas en el Lenovo; habilitar gVisor está autorizado únicamente sin reiniciar Docker ni contenedores productivos. Siguen faltando los documentos anonimizados representativos y la evidencia completa del gate. Esto no autoriza publicar una implementación incompleta, activar modelos administrativamente deshabilitados ni ejecutar todas las fases sin revisión.
