# SiraGPT: 100 mejoras profesionales de alto impacto

## Objetivo

Convertir SiraGPT en una plataforma de investigación, creación de documentos,
presentaciones y trabajo empresarial con resultados verificables. Cada mejora
se considera terminada solo cuando tiene implementación, prueba automatizada,
validación en producción y evidencia de uso real.

## Estados

- `COVERED`: capacidad ya presente y verificada en el código base.
- `DELIVERED-R1`: entregada en la primera liberación de este programa.
- `DELIVERED-R2`: entregada en la segunda liberación de este programa.
- `DELIVERED-R3`: entregada en la tercera liberación de este programa.
- `DELIVERED-R4`: entregada en la cuarta liberación de este programa.
- `DELIVERED-R5`: entregada en la quinta liberación de este programa.
- `PARTIAL`: existe una base útil, pero falta completar el criterio.
- `PENDING`: todavía no cumple el criterio de aceptación.

## 1-10. Cobertura científica mundial

| # | Mejora | Estado | Criterio de aceptación |
|---:|---|---|---|
| 1 | Integración OpenAlex | COVERED | Buscar obras con paginación y metadatos normalizados. |
| 2 | Integración Crossref | COVERED | Recuperar DOI, revista, autores, citas y relaciones editoriales. |
| 3 | PubMed y Europe PMC | COVERED | Recuperar literatura biomédica desde ambos índices. |
| 4 | SciELO y Redalyc | COVERED | Priorizar cobertura científica iberoamericana. |
| 5 | arXiv, bioRxiv y medRxiv | COVERED | Recuperar preprints y conservar su procedencia. |
| 6 | Semantic Scholar, CORE, DOAJ, DBLP y DataCite | COVERED | Consultar y normalizar todos los proveedores públicos. |
| 7 | Scopus y Web of Science | COVERED | Activarse con credenciales y degradar sin interrumpir la búsqueda. |
| 8 | Enrutamiento por disciplina | DELIVERED-R3 | Seleccionar índices y vocabularios según la carrera o área. |
| 9 | Búsqueda bilingüe español-inglés | COVERED | Expandir conceptos sin desplazar el tema literal del usuario. |
| 10 | Recuperación profunda de hasta 1,000 candidatos | DELIVERED-R3 | Paginar fuentes compatibles y detenerse con límites auditables. |

## 11-20. Precisión y ranking

| # | Mejora | Estado | Criterio de aceptación |
|---:|---|---|---|
| 11 | Interpretación estructurada de la consulta | COVERED | Extraer tema, idioma, conceptos y preferencias. |
| 12 | Filtros de año, idioma y acceso abierto | COVERED | Aplicar los filtros antes del ranking final. |
| 13 | Filtro de revisión por pares | DELIVERED-R1 | Excluir preprints y etiquetar inferencias sin afirmar certeza. |
| 14 | Preferencia y filtro estricto por tipo de estudio | DELIVERED-R1 | Distinguir preferencia de solicitudes exclusivas. |
| 15 | Cobertura de conceptos compuestos | COVERED | Evitar coincidencias por una sola palabra genérica. |
| 16 | Ranking determinista por pertinencia | COVERED | Priorizar coincidencia temática aunque otra fuente tenga más citas. |
| 17 | Reordenamiento semántico con LLM | COVERED | Reordenar un conjunto acotado y degradar de forma determinista. |
| 18 | Autoridad del índice | COVERED | Incorporar reputación de la fuente sin dominar la pertinencia. |
| 19 | Señales de citas, actualidad y acceso | COVERED | Combinar señales con pesos explícitos y probados. |
| 20 | Diversidad y corroboración entre índices | COVERED | Fusionar duplicados y mostrar confirmación multifuente. |

## 21-30. Calidad e integridad de evidencia

| # | Mejora | Estado | Criterio de aceptación |
|---:|---|---|---|
| 21 | Validación sintáctica de DOI | DELIVERED-R1 | Marcar formato válido sin afirmar resolución en línea. |
| 22 | Resolución activa de DOI | DELIVERED-R2 | Confirmar HTTP, destino canónico y estado editorial con caché. |
| 23 | Detección de retractaciones y retiros | DELIVERED-R1 | Leer OpenAlex/Crossref y excluirlos por defecto. |
| 24 | Correcciones y expresiones de preocupación | DELIVERED-R1 | Conservar y mostrar el evento editorial más riesgoso. |
| 25 | Clasificación de preprints | DELIVERED-R1 | Identificar repositorios y tipos `posted-content`. |
| 26 | Estado de revisión por pares | DELIVERED-R1 | Separar confirmado, probable, no revisado y desconocido. |
| 27 | Clasificación del diseño de estudio | DELIVERED-R1 | Detectar revisiones, meta-análisis, RCT, cohortes y otros diseños. |
| 28 | Señales de integridad visibles en chat | DELIVERED-R1 | Mostrar DOI, etapa, diseño y alertas en cada resultado. |
| 29 | Contadores auditables de exclusión | DELIVERED-R1 | Informar registros únicos excluidos por integridad. |
| 30 | Extracción de hallazgos y estadísticas | COVERED | Extraer frases de resultados, dirección, cifras y trabajo futuro. |

## 31-40. Revisiones sistemáticas

| # | Mejora | Estado | Criterio de aceptación |
|---:|---|---|---|
| 31 | Constructor PICO | DELIVERED-R2 | Convertir población, intervención, comparación y resultado en consultas. |
| 32 | Constructor SPIDER | DELIVERED-R2 | Soportar investigación cualitativa y métodos mixtos. |
| 33 | Flujo PRISMA | DELIVERED-R2 | Registrar identificación, cribado, elegibilidad e inclusión. |
| 34 | Criterios de inclusión y exclusión | DELIVERED-R2 | Configurarlos, aplicarlos y explicar cada descarte. |
| 35 | Dedupe para revisión sistemática | DELIVERED-R4 | Fusionar DOI/título y permitir resolver conflictos manualmente. |
| 36 | Cribado por título y resumen | DELIVERED-R2 | Aceptar, excluir o dejar en duda con motivos. |
| 37 | Evaluación de riesgo de sesgo | DELIVERED-R4 | Evaluar texto completo por dominios, conservar evidencia y admitir juicio del revisor. |
| 38 | Gradación de certeza de evidencia | DELIVERED-R4 | Gradación GRADE con efectos, intervalos, muestra y dominios explícitos. |
| 39 | Síntesis de consenso y contradicciones | DELIVERED-R2 | Citar los estudios que sostienen cada conclusión. |
| 40 | Exportación del protocolo | DELIVERED-R2 | Descargar estrategia, filtros, decisiones y diagrama. |

## 41-50. Biblioteca y referencias

| # | Mejora | Estado | Criterio de aceptación |
|---:|---|---|---|
| 41 | Guardar fuentes en Biblioteca | DELIVERED-R4 | Persistir un resultado científico desde el chat. |
| 42 | Colecciones, carpetas y etiquetas | DELIVERED-R4 | Organizar referencias por investigación y tema. |
| 43 | Notas y anotaciones por fuente | DELIVERED-R4 | Guardar comentarios privados con referencia estable. |
| 44 | Bibliografía APA 7 | COVERED | Generar y ordenar referencias con DOI canónico. |
| 45 | Bibliografías IEEE y MLA | COVERED | Cambiar formato sin perder metadatos. |
| 46 | Exportación BibTeX y RIS | DELIVERED-R4 | Exportar la selección científica desde el mismo resultado. |
| 47 | Integración Zotero y Mendeley | DELIVERED-R4 | Enviar colecciones con deduplicación. |
| 48 | Dedupe de referencias | COVERED | Fusionar DOI y título normalizado conservando datos más ricos. |
| 49 | Auditoría de referencias citadas | DELIVERED-R4 | Detectar DOI inválido, cita huérfana o referencia no usada. |
| 50 | Grafo de citación | DELIVERED-R4 | Explorar trabajos citados, citantes y conexiones temáticas. |

## 51-60. Experiencia de investigación en chat

| # | Mejora | Estado | Criterio de aceptación |
|---:|---|---|---|
| 51 | Progreso de búsqueda en tiempo real | COVERED | Mostrar fases, conteos y proveedores durante el SSE. |
| 52 | Cancelación inmediata | COVERED | Detener proveedores, ranking y actualización visual. |
| 53 | Estado por proveedor | COVERED | Mostrar contribución, errores y agotamiento sin bloquear el resto. |
| 54 | Panel profesional de filtros | DELIVERED-R5 | Editar filtros sin reescribir el prompt. |
| 55 | Tarjetas científicas expandibles | DELIVERED-R5 | Ver resumen, metadatos, integridad y acciones por fuente. |
| 56 | Orden configurable | DELIVERED-R5 | Ordenar por pertinencia, fecha, citas, evidencia o acceso. |
| 57 | Comparación de estudios | DELIVERED-R5 | Seleccionar fuentes y comparar diseño, muestra y hallazgos. |
| 58 | Preguntas de seguimiento con contexto | DELIVERED-R5 | Reutilizar la selección sin repetir la búsqueda completa. |
| 59 | Búsquedas guardadas y alertas | DELIVERED-R5 | Reejecutar consultas y notificar literatura nueva. |
| 60 | Accesibilidad y móvil | DELIVERED-R5 | Operar búsqueda, filtros y fuentes con teclado y pantallas pequeñas. |

## 61-70. Documentos y presentaciones

| # | Mejora | Estado | Criterio de aceptación |
|---:|---|---|---|
| 61 | Convertir investigación en DOCX | PARTIAL | Generar un Word real con estructura y referencias. |
| 62 | Editar el DOCX original | COVERED | Devolver el mismo archivo con estructura preservada. |
| 63 | Convertir investigación en PPTX | PARTIAL | Crear una presentación descargable desde fuentes seleccionadas. |
| 64 | Fidelidad al prompt y número de diapositivas | PARTIAL | Cumplir tema, audiencia, extensión y restricciones exactas. |
| 65 | Citas y referencias por diapositiva | PENDING | Vincular cada afirmación a sus fuentes. |
| 66 | Tablas de evidencia editables | PARTIAL | Insertar matrices con estudio, método, muestra y resultados. |
| 67 | Esquema editable antes de generar | PENDING | Aprobar y reorganizar capítulos o diapositivas. |
| 68 | Regeneración focalizada | PARTIAL | Modificar una sección o diapositiva sin rehacer todo. |
| 69 | Procedencia de gráficos y cifras | PENDING | Adjuntar fuente, unidad y fecha a cada visualización. |
| 70 | Validación técnica del artefacto | COVERED | Abrir, renderizar y comprobar DOCX/PPTX antes de entregar. |

## 71-80. Empresas y colaboración

| # | Mejora | Estado | Criterio de aceptación |
|---:|---|---|---|
| 71 | Nombre Empresas en toda la interfaz | COVERED | Mantener rutas/permisos y cambiar solo la denominación visible. |
| 72 | Biblioteca científica por empresa | PENDING | Compartir fuentes dentro del tenant correcto. |
| 73 | Colecciones compartidas | PENDING | Colaborar con permisos por colección. |
| 74 | Roles y permisos | COVERED | Aplicar permisos de propietario, administrador y miembro. |
| 75 | Comentarios y menciones | PARTIAL | Comentar fuentes y artefactos notificando al destinatario. |
| 76 | Registro de actividad | COVERED | Auditar acciones relevantes sin exponer secretos. |
| 77 | Historial de versiones de artefactos | PENDING | Restaurar versiones de documentos y presentaciones. |
| 78 | Plantillas de investigación por empresa | PENDING | Reutilizar normas, marca, estructura y fuentes aprobadas. |
| 79 | Memoria aislada por proyecto | COVERED | Mantener archivos, chats y contexto dentro del proyecto. |
| 80 | Aislamiento multi-tenant | COVERED | Impedir acceso cruzado en datos, previews y artefactos. |

## 81-90. Agentes y automatización

| # | Mejora | Estado | Criterio de aceptación |
|---:|---|---|---|
| 81 | Agente de búsqueda federada | COVERED | Planificar, consultar, fusionar, ordenar y sintetizar. |
| 82 | Agente crítico de evidencia | PARTIAL | Revisar calidad, contradicciones y soporte de afirmaciones. |
| 83 | Agente verificador de citas | PENDING | Comprobar citas contra metadatos y texto disponible. |
| 84 | Agente de revisión sistemática | PARTIAL | Coordinar estrategia, cribado, extracción y síntesis. |
| 85 | Agente editor de documentos | COVERED | Editar archivos reales con validaciones. |
| 86 | Agente de presentaciones | COVERED | Crear PPTX y validar el artefacto. |
| 87 | Paralelismo entre proveedores | COVERED | Consultar hosts independientes de forma concurrente. |
| 88 | Reintentos y circuit breakers | COVERED | Limitar fallos, tiempos y degradación de proveedores. |
| 89 | Checkpoints y reanudación | COVERED | Recuperar tareas duraderas tras interrupciones. |
| 90 | Aprobación humana | COVERED | Bloquear acciones de alto impacto hasta autorización. |

## 91-100. Plataforma, seguridad y negocio

| # | Mejora | Estado | Criterio de aceptación |
|---:|---|---|---|
| 91 | Health checks de disponibilidad | COVERED | Exponer readiness y validar servicios requeridos. |
| 92 | Despliegue con backup y rollback | COVERED | Respaldar, desplegar sin volúmenes destructivos y revertir por SHA. |
| 93 | Observabilidad de búsqueda | DELIVERED-R3 | Medir latencia, cobertura, errores, filtros y calidad por proveedor. |
| 94 | Rate limits y colas | COVERED | Controlar abuso y mantener reintentos cancelables. |
| 95 | Gestión segura de secretos | COVERED | Evitar claves en código, logs, commits y respuestas. |
| 96 | Controles de seguridad automatizados | COVERED | Ejecutar validaciones de cadena de suministro y patrones inseguros. |
| 97 | Presupuestos de costo y tokens | COVERED | Aplicar límites por tarea, conversación y usuario. |
| 98 | Configuración administrativa de proveedores | COVERED | Activar proveedores/modelos sin cambios de código. |
| 99 | Analítica de uso y calidad | PARTIAL | Medir adopción, éxito, cancelación y satisfacción sin PII. |
| 100 | Evaluación continua de calidad | COVERED | Ejecutar pruebas, 100 controles y gates de liberación por SHA. |

## Liberación R1: integridad científica

Incluye las mejoras 13, 14 y 21-29. La liberación debe cumplir:

1. Pruebas unitarias de DOI, preprints, revisión por pares y eventos editoriales.
2. Pruebas del flujo agéntico con exclusión y contadores únicos.
3. Pruebas de revisión de literatura con metadatos de integridad.
4. Compilación, lint, bloqueo visual y escaneo de secretos.
5. Suite completa sin fallos.
6. CI verde para el SHA exacto.
7. Despliegue no destructivo, health check y búsqueda autenticada real.

## Liberación R2: revisión sistemática auditable

Incluye las mejoras 22, 31-34, 36, 39 y 40, y avanza 37-38. La liberación debe cumplir:

1. Resolver solo los DOI finalistas, con timeout, caché acotada y estados separados para resuelto, no localizado y no disponible.
2. Convertir solicitudes PICO y SPIDER en expresiones booleanas sin inventar campos ausentes.
3. Aplicar el mismo protocolo en la revisión especializada y en la búsqueda agéntica del chat.
4. Registrar decisiones `include`, `exclude` y `uncertain` con motivos deterministas.
5. Calcular el flujo PRISMA desde conteos reales de identificación, deduplicación y cribado.
6. Vincular cada consenso o contradicción con las citas de los estudios que la sostienen.
7. Descargar un Markdown con estrategia, criterios, decisiones y diagrama PRISMA.
8. Mantener riesgo de sesgo y certeza como evaluaciones preliminares hasta revisar texto completo.
9. Superar pruebas focalizadas, tipado, lint, bloqueo visual, escaneo de secretos y suite completa.
10. Desplegar sin operaciones destructivas y validar el flujo autenticado en producción.

Estado después de R2: 45 `COVERED`, 10 `DELIVERED-R1`, 8 `DELIVERED-R2`, 21 `PARTIAL` y 16 `PENDING`.

## Liberación R3: profundidad y enrutamiento científico

Incluye las mejoras 8, 10 y 93, y elimina el ruido de telemetría posterior a
la eliminación de cuentas. La liberación debe cumplir:

1. Detectar la disciplina de forma determinista y admitir una selección explícita.
2. Priorizar índices especializados sin retirar ningún proveedor mundial configurado.
3. Añadir vocabulario controlado solo cuando el concepto aparece en la consulta.
4. Aplicar el mismo plan al chat agéntico, búsqueda científica y revisión de literatura.
5. Paginar hasta el objetivo solicitado, con límite máximo de 1,000 candidatos.
6. Informar objetivo, rondas, llamadas, límites y razón exacta de finalización.
7. Medir por proveedor latencia, recibidos, filtrados, errores, aportes y selección final.
8. Registrar calidad media de las fuentes finalistas por proveedor.
9. Evitar errores P2025 de telemetría cuando una cuenta desaparece antes del vaciado.
10. Superar suites completas, tipado, lint, bloqueo visual, seguridad y validación en producción.

Estado después de R3: 45 `COVERED`, 10 `DELIVERED-R1`, 8 `DELIVERED-R2`, 3 `DELIVERED-R3`, 18 `PARTIAL` y 16 `PENDING`.

## Liberación R4: biblioteca científica y evaluación completa

Incluye las mejoras 35, 37-38, 41-43, 46-47 y 49-50. La liberación debe cumplir:

1. Persistir referencias por usuario con identidad DOI o título-año y fusionar los metadatos más ricos.
2. Crear colecciones, carpetas y etiquetas, y permitir que una referencia pertenezca a varias colecciones.
3. Guardar notas privadas y editar etiquetas sin alterar la referencia canónica.
4. Detectar conflictos de título con DOI distintos y ofrecer resolución manual auditable.
5. Exportar la selección o colección en BibTeX y RIS con DOI canónico.
6. Auditar citas numéricas y autor-año, DOI inválidos, referencias no usadas y duplicados.
7. Evaluar riesgo de sesgo desde texto completo con evidencia por dominio y overrides del revisor.
8. Calcular certeza GRADE usando diseño, sesgo, efectos, intervalos de confianza y tamaño muestral.
9. Crear un grafo de trabajos citados y citantes mediante OpenAlex con degradación local explícita.
10. Sincronizar Zotero Web API v3 y Mendeley Core API sin guardar credenciales y omitiendo duplicados.
11. Mostrar la Biblioteca científica en la interfaz y permitir guardar las fuentes finalistas desde el chat.
12. Superar migración aditiva, pruebas, tipado, lint, bloqueo visual, seguridad y validación en producción.

Estado después de R4: 45 `COVERED`, 10 `DELIVERED-R1`, 8 `DELIVERED-R2`, 3 `DELIVERED-R3`, 10 `DELIVERED-R4`, 13 `PARTIAL` y 11 `PENDING`.

## Liberación R5: banco de trabajo científico en chat

Incluye las mejoras 54-60 y conserva el progreso, cancelación y estado por
proveedor ya disponibles en 51-53. La liberación debe cumplir:

1. Editar año, acceso, revisión por pares, diseño y proveedor sin reescribir la consulta.
2. Ordenar el mismo conjunto por pertinencia, fecha, citas, evidencia o disponibilidad de acceso.
3. Expandir cada estudio para consultar resumen, DOI, integridad, resolución y procedencia.
4. Seleccionar y comparar hasta cuatro estudios en una tabla adaptable y accesible.
5. Precargar preguntas de seguimiento con la consulta y fuentes elegidas sin repetir la búsqueda.
6. Guardar, listar, pausar, ejecutar y eliminar búsquedas científicas por usuario.
7. Programar alertas diarias o semanales con un despachador horario acotado y sin solapamientos.
8. Crear una notificación solo cuando una ejecución posterior encuentre identidades científicas nuevas.
9. Operar filtros, selección, expansión, comparación y alertas con controles nativos de teclado y diseño móvil.
10. Superar migración aditiva, pruebas de servicio y rutas, pruebas de frontend, tipado, lint, seguridad y validación real en producción.

Estado después de R5: 45 `COVERED`, 10 `DELIVERED-R1`, 8 `DELIVERED-R2`, 3 `DELIVERED-R3`, 10 `DELIVERED-R4`, 7 `DELIVERED-R5`, 9 `PARTIAL` y 8 `PENDING`.
