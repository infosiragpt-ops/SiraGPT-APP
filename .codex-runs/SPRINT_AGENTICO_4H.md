Actua como Staff Software Engineer, Principal AI Engineer y arquitecto senior de sistemas agenticos.

Objetivo del sprint:

- Mejorar profundamente el funcionamiento interno del software sin modificar visualmente la interfaz existente.
- Reforzar planner/orchestrator, tool routing, ejecucion, memoria, RAG, manejo de archivos, generacion de documentos, errores, trazabilidad, validacion, seguridad, tokens por usuario y preparacion de produccion.
- Inspeccionar el repositorio antes de tocar codigo.
- Crear o actualizar `docs/agentic/PLAN_4H.md`, `docs/agentic/STATUS_4H.md` y `docs/agentic/DECISIONS.md`.
- Dividir el trabajo en hitos pequenos con criterios de aceptacion y comandos de validacion.
- Ejecutar validaciones reales despues de los hitos.

Restricciones:

- No modificar apariencia, layout, estilos, tamanos, colores ni componentes visibles.
- No romper compatibilidad con produccion.
- No eliminar funcionalidades existentes.
- No inventar servicios externos sin credenciales.
- Mantener diffs modulares y revisables.
- Documentar decisiones seguras cuando falte informacion.

Prioridades:

1. Separar planner, executor, tool registry, memory, retrieval, validators y telemetry.
2. Mejorar routing de herramientas para archivos, documentos, RAG, Word, Excel, PPT, PDF, busqueda, imagenes y acciones externas.
3. Crear contratos robustos para modelos externos sin acoplar la UI.
4. Agregar errores, retries, timeouts, logs estructurados y estados de ejecucion.
5. Mejorar seguridad, permisos, limites por usuario y prevencion de acciones peligrosas.
6. Agregar o mejorar medicion de tokens por usuario, sesion, modelo y tarea.
7. Anadir pruebas minimas y smoke tests.
8. Documentar como ejecutar, probar y extender el sistema.

Entrega esperada:

- Resumen ejecutivo.
- Archivos modificados.
- Comandos ejecutados.
- Validaciones exitosas y fallidas.
- Riesgos pendientes.
- Proximos pasos recomendados.
- Estado real de produccion.
