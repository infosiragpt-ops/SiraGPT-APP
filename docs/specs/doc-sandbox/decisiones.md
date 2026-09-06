# Sandbox de documentos: registro de decisiones

Fecha: 2026-09-04. Base auditada: `0f24e4d004f156eae838e21592539cca91f53cd3`.

Estado: **D01–D18 aprobadas para iniciar F1** mediante “procede con la fase 1”; implementación en curso, no declaración de cierre ni autorización de publicación. Se conserva la redacción de las propuestas originales para trazabilidad. La especificación recibida se conserva sin reescribir en [SPEC-sandbox-edicion-documentos.md](SPEC-sandbox-edicion-documentos.md). Ver [contexto](00-contexto-repo.md) y [plan](01-plan-por-fases.md).

## D01. Rutas y compatibilidad con el repositorio

- Contexto: el backend real es Express/CommonJS en `backend/`; la UI canónica es `/agentes` según `AGENTS.md` §§1,18. La especificación propone `server/modules/` y una página independiente `/documentos`, pero §0.1 permite adaptar al repositorio.
- Opciones: otra aplicación/superficie, o módulo acotado integrado en los flujos existentes.
- Propuesta: `backend/src/modules/doc-sandbox/`, con adaptador mínimo desde las rutas existentes; resultados en chat y Biblioteca. No revivir `/code` ni crear navegación paralela. La UI concreta se aprobará en F2/F3; si Luis quiere además `/documentos`, requiere una excepción explícita.
- Consecuencias: se conserva la funcionalidad de §9, no necesariamente su URL propuesta. No habilitar el `doc-engine` alternativo ni mantener dos orquestadores para el mismo trabajo.

## D02. TypeScript estricto sin convertir todo Express

- Contexto: `backend/package.json` arranca JavaScript CommonJS y su build actual no compila un módulo TypeScript. `tsx` existente no sustituye comprobación de tipos.
- Opciones: migración global a ESM/TS o compilación aislada.
- Propuesta: módulo TS estricto compilado a CommonJS mediante configuración propia; JavaScript solo en el puente de carga. Integrar compilación en CI, imagen y arranque antes de montar la ruta. Tipos estrechos para dependencias heredadas, sin `any` indiscriminado.
- Consecuencias: tocar build/Docker/package scripts es necesario y debe figurar en el reporte. No atribuir al `type-check` del frontend cobertura del nuevo backend.

## D03. Ninguna descarga validada con controles incompletos

- Contexto: §1/§5 exige cinco niveles siempre; §8/F1 y §11 posponen apertura/visual. Hay LibreOffice en las imágenes actuales, pero no se ha verificado su ejecución real para este módulo.
- Opciones: F1 experimental sin entrega pública, o adelantar los mínimos reales de apertura y visual.
- Propuesta preferida: adelantar niveles 2/3 mínimos reales a F1 para Office/PDF; F2 mejora precisión, control de cambios y presentación. Ningún resultado se publica si falta un control exigible. Sin infraestructura disponible, F1 queda bloqueada para publicación, no se marca un nivel como aprobado artificialmente.
- Consecuencias: aumenta trabajo de F1. Los cuatro validadores son independientes; el nivel 5 es la política que restaura el original y reintenta, no una quinta prueba de contenido.

## D04. El agente editor no aprueba su propio trabajo

- Contexto: confiar en `parts_modified` o `pages_affected` del modelo permite excluir de validación cualquier cambio accidental. El criterio de substring en el diff también acepta modificaciones adicionales.
- Opciones: aceptar el autoinforme o derivar y congelar restricciones verificables en el servidor.
- Propuesta: inventario independiente del original; plan versionado con hashes, referencias a inputs y operaciones tipadas; autorización exacta de nodos/celdas/regiones/partes. Congelar el plan antes de editar. El reporte del modelo se contrasta, nunca amplía permisos. En `approval`, cualquier cambio de plan invalida la aprobación anterior.
- Consecuencias: cambios fuera de la región autorizada bloquean incluso en páginas afectadas; sin localización fiable, fallo explicado. Antes/después debe corresponder exactamente al diff normalizado del formato, no solo contener una subcadena.

## D05. Validación externa, pero también aislada

- Contexto: LibreOffice, parsers XML y PDF procesan inputs no confiables. Ejecutarlos con los secretos del worker traslada el riesgo fuera del sandbox editor.
- Opciones: procesos con privilegios del worker o un segundo entorno aislado dirigido por él.
- Propuesta: el worker conserva autoridad de validación y ejecuta herramientas en un sandbox validador independiente: sin red, sin secretos, inputs de solo lectura, sin macros/enlaces externos, perfil LibreOffice único, CPU/memoria/PIDs y timeout duro. Sin volumen de escritura compartido con el editor. XML sin entidades externas/DTD/red. Solo el servicio de lanzamiento autorizado controla el runtime; no exponer socket Docker al código generado.
- Consecuencias: F1 necesita imagen/ejecutor de validación aunque el Motor B editor llegue en F4. Verificar aislamiento, no solo la presencia de flags en un Dockerfile.

## D06. ZIP, sniffing y documentos activos

- Contexto: ya hay límites y sniffing en uploads; no equivalen a todos los controles de §5/§6. El límite de expansión 20× puede rechazar XML legítimo muy compresible.
- Opciones: relajar silenciosamente el límite o mantenerlo y medir con fixtures representativas.
- Propuesta: conservar 20× hasta una decisión documentada con evidencia; además limitar bytes expandidos en streaming, bytes por entrada, número de entradas y anidamiento. Rechazar rutas absolutas/UNC, traversal, enlaces, entradas duplicadas y XML hostil antes de extraer o llamar al proveedor. Macros solo preservadas, nunca ejecutadas; nada de contenido activo en previews HTML/SVG.
- Consecuencias: los falsos positivos se reportan para aprobación, no se convierten en bypass. `.xlsm` se habilita con G6 en F2; `.docm/.pptm`, mencionados solo en seguridad y no en la matriz de formatos, se rechazan como no soportados hasta ampliar expresamente el alcance.

## D07. No-op, estilos y revisiones de Word

- Contexto: el editor actual exige cambio de bytes (`source-preserving-document-edit.js:4971`), incompatible con G11/G12. Conservar solo el estilo del primer run puede borrar negritas intermedias.
- Opciones: reconstruir párrafos o editar segmentos conservando estructura y atributos.
- Propuesta: preservar propiedades de formato tanto dentro como fuera del texto autorizado. Cambiar contenido no autoriza cambiar `w:rPr`, `a:rPr` ni estilos de celda. Mapear explícitamente estilos por segmento, conservar negritas intermedias, campos, bookmarks y revisiones preexistentes; sin mapeo inequívoco, pedir decisión o declarar `not_possible`. Para no-op devolver el original exacto, con plan vacío y reporte real. En control de cambios, verificar vistas aceptada/rechazada y asignar autor/fecha/IDs no colisionantes.
- Consecuencias: G1 se refuerza con estilos mixtos y G3 no se limita a contar etiquetas. Una edición ambigua que cambia formato no se ejecuta a medias.

## D08. Operaciones por formato y aplicabilidad de controles

- Contexto: un esquema de reemplazo textual no representa rotaciones, overlays, eliminación de slides, fórmulas o combinación de inputs. `Content_Types` admite tipos por extensión, no necesariamente una entrada individual por parte.
- Opciones: forzar todas las operaciones a `before/after`, o una unión discriminada por operación.
- Propuesta: operaciones de texto, nodo, celda/fórmula, página y overlay con reglas específicas; manifiesto por input/output. Cambios estructurales solicitados autorizan solo sus relaciones/tipos asociados. Recalcular copias para validar Excel; no guardar el original mediante LibreOffice. Numeración/marca de agua se separa del texto original en G8.
- Consecuencias: matriz de validación por formato. Texto plano conserva encoding/EOL y parsing; no inventar una apertura Office o paginación para CSV/JSON. Un control no aplicable debe estar justificado por tipo, nunca contado como una ejecución exitosa. Office/PDF sí requieren comparación visual real.

## D09. PDF: redacción segura, firmas y límites de fidelidad

- Contexto: guardado incremental puede conservar revisiones anteriores, incompatible con eliminar información mediante redacción. El editor actual rechaza sustitución de texto PDF conservadora (`source-preserving-document-edit.js:3920`).
- Opciones: guardar siempre incremental o separar las operaciones y sus garantías.
- Propuesta: `secure_redact` exige eliminación física del contenido y guardado no incremental con limpieza, más prueba de no recuperación textual; microedición solo con fuente compatible y texto que quepa. Firmas/cifrado se detectan y se rechaza o pide consentimiento informado antes de invalidarlos. Sin reflujo perfecto ni sustitución silenciosa por una imagen.
- Consecuencias: excepción explícita a la regla incremental, pendiente de aprobación. [Documentación de guardado de PyMuPDF](https://pymupdf.readthedocs.io/en/latest/document.html#Document.save) respalda distinguir estas modalidades. Los originales privados se conservan según retención, aunque el derivado esté redactado.

## D10. Skills y licencias

- Contexto: el README de `anthropics/skills` distingue las cuatro skills documentales como source-available; no todas tienen licencia Apache. La licencia documental restringe copia fuera del servicio y obras derivadas.
- Opciones: obtener permisos compatibles, utilizar skills hospedadas mediante API, o escribir skills propias independientes.
- Propuesta: Motor A usa la API permitida; Motor B usa skills SiraGPT originales y bibliotecas con licencias compatibles. No vendorizar las cuatro skills restringidas sin permiso. La adopción de PyMuPDF requiere resolver su licencia AGPL/comercial antes de integrar o distribuir; una alternativa necesita demostrar la misma cobertura.
- Consecuencias: bloque de revisión de licencias en F1/F4; no equivale a asesoramiento jurídico ni a una licencia concedida. Fuentes: [README oficial](https://github.com/anthropics/skills), [licencia DOCX](https://raw.githubusercontent.com/anthropics/skills/main/skills/docx/LICENSE.txt), [licencia PyMuPDF](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright).

## D11. Contrato Anthropic verificado, no copiado de memoria

- Contexto: lock actual del backend: SDK `0.92.0`. La documentación consultada el 2026-09-04 muestra API GA; la ruta heredada hace un upload JSON/base64 (`anthropic-route.js:119`), no el multipart documentado. No se ejecutó una llamada real a Anthropic durante este diagnóstico.
- Opciones: seguir el pseudocódigo literalmente o fijar un contrato comprobado contra la versión instalada/seleccionada.
- Propuesta: multipart para Files, `container_upload` para originales y objetos `container.skills` con tipo/ID/versión fijada y orden estable. `code_execution_20260521` sí está documentado; comprobar compatibilidad del modelo. Aislar el SDK en un adaptador y actualizarlo solo si sus firmas/versiones lo requieren, con regresión del uso existente.
- Consecuencias: endpoints GA `files/messages` frente a `beta` dependen de SDK/compatibilidad, no se mezclan a ciegas. Guardar originales propios: la API permite descargar archivos generados, no recuperar los uploads originales. Fuentes: [Files](https://platform.claude.com/docs/en/build-with-claude/files), [inicio rápido](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/quickstart), [code execution](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool).

## D12. Sesión, continuación, resultados y costos del Motor A

- Contexto: una respuesta puede detenerse en `pause_turn`; carpetas internas no garantizan exportación de todos sus archivos. El modo approval se detiene antes de `result.json`, aunque la interfaz lo exige siempre.
- Opciones: una llamada/un resultado rígido, o protocolo de estados con límites acumulativos.
- Propuesta: resultado discriminado `planned | edited | not_possible`; `edited` sí exige manifiesto y resultado válidos. Continuación acotada en el mismo contenedor, presupuesto agregado de turnos/tokens/tiempo/reintentos. Exportar receta y manifiestos explícitamente desde la ubicación de salida documentada. Fallar si falta cualquier artefacto obligatorio; no omitir descargas fallidas.
- Consecuencias: costo incluye caché y herramientas además de tokens cuando aplique; tabla versionada, costos desconocidos como desconocidos, no cero. Sin sesiones compartidas entre usuarios. Skills hospedadas tienen alcance de workspace y no garantizan ZDR; revisar tratamiento de documentos sensibles. Fuentes: [ejecución](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool), [guía de skills](https://platform.claude.com/docs/en/build-with-claude/skills-guide), [overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview).

## D13. Durabilidad, idempotencia y cancelación

- Contexto: las rutas actuales permiten trabajo en proceso y fallback local; el store tiene sincronización Prisma best-effort. Esto no demuestra supervivencia a reinicios ni publicación única.
- Opciones: envolverlo sin cambios o separar persistencia autoritativa y ejecución.
- Propuesta: Postgres como fuente de verdad; creación de job/evento pendiente de encolar en la misma transacción (outbox); Redis solo IDs, nunca documentos. Lease y fencing por intento, secuencia única por job, publicación atómica de artefactos y estado. Ejecución al menos una vez, publicación idempotente; no prometer ejecución exactamente una vez.
- Consecuencias: recuperación de jobs, reentrega y SSE requieren pruebas de caída real. Cancelar/borrar prevalece sobre un worker atrasado; nunca aparece una salida posterior a cancelación. SSE lee historial durable con `Last-Event-ID`, sin depender solo de pub/sub ni de un evento perdido al reconectar.

## D14. Almacenamiento, cifrado y borrado verificable

- Contexto: hay R2/S3 y helpers de URL firmada; un adaptador usa 900 s, mayor que 10 min. No se ha auditado la configuración del bucket en vivo. La API revisada no demuestra una operación remota de destrucción inmediata del contenedor.
- Opciones: asumir privacidad/cifrado, o comprobar la política y registrar limpieza pendiente.
- Propuesta: bucket privado con SSE verificado; si se elige cifrado de aplicación autenticado, diseñar además su descifrado seguro de descarga. URL firmada ≤600 s **mediada por la aplicación**, ligada a usuario/job/artefacto y revisada contra el tombstone en cada solicitud; no entregar al cliente una URL directa a R2/S3 que evite la revocación. Respuesta sin caché. `destroy()` elimina todos los file IDs conocidos, incluidos outputs, y registra fallos con reintentos. No prometer borrado instantáneo del contenedor del proveedor. Retención 30 días; transcripts/diffs privados, nunca logs.
- Consecuencias: DELETE revoca nuevos accesos mediante tombstone, corta streams controlados por la aplicación, cancela ejecución y purga objetos; no puede retirar bytes ya descargados. Si la limpieza remota sigue pendiente se informa como pendiente. Probar obtener URL, borrar job y reutilizar la misma URL: debe denegarse. Una sesión nueva por follow-up reenvía el resultado validado; reutilización remota solo con política aprobada. Las URLs directas son reutilizables hasta expirar y no consultan la DB: [S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html). Límites del contenedor: [code execution](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool).

## D15. Distribución completa por fases y permisos de ejecución

- Contexto: §11 pide todos los endpoints en F1 sin approval; sitúa G12 en F2 pero follow-up en F3; la tabla sitúa batch en v2 aunque F3 lo incluye; reformat carece de fase. §13 exige control de cambios incluso al corroborar F1 preserve.
- Opciones: implementar stubs o modificar explícitamente la matriz de entrega.
- Propuesta: núcleo + planos en F1; XLSM/G6 y tracked en F2; approve/followup/G12/batch en F3; Motor B en F4; reformat y formatos restantes en F5. G10 rechazo conservador se prueba desde F1; OCR continúa en F5. Cada corroboración exige las capacidades acumuladas de la fase, sin atribuir a una fase algo aún pendiente.
- Consecuencias: el [plan](01-plan-por-fases.md) contiene la matriz exacta. El clasificador mechanical/academic opera dentro del job ya enrutado, no cambia el router global ni una selección explícita. No activar modelos deshabilitados, cambiar permisos o introducir fallback silencioso. Pruebas de proveedor necesitan credencial de test y presupuesto aprobados por canal seguro.

## D16. Namespace `/api/docs` ya utilizado

- Contexto: `backend/index.js:1196` monta un alias de Swagger bajo `/api/docs` según configuración.
- Opciones: cambiar el contrato público propuesto, o conservarlo y resolver el orden de rutas específicas.
- Propuesta: mantener `/api/docs/jobs` y montar el router autenticado específico antes del middleware Swagger, con prueba de todos los métodos y errores. No modificar en silencio los aliases de documentación existentes.
- Consecuencias: requiere cambio acotado en `backend/index.js`, pruebas con documentación habilitada/deshabilitada y verificación de que ningún job pasa por un handler anónimo.

## D17. Criterios medibles, capacidad y dependencias humanas

- Contexto: §10.5 exige p95 pero no fija objetivo; existen límites por fichero y job, no un presupuesto autorizado de API. Los 3–5 documentos reales anonimizados deben ser aportados por Sira.
- Opciones: prometer tiempos universales o acordar un benchmark acotado.
- Propuesta inicial para aprobar: 10 jobs mechanical, inputs distintos ≤2 MB y ≤20 páginas; p95 de extremo a extremo ≤10 min, recepción de job p95 ≤2 s, cero mezcla entre usuarios. Medir por separado cola/motor/validación. Documentar hardware, modelo, versiones y costo; archivos grandes/academic tienen límites separados, no la misma promesa.
- Consecuencias: límites por usuario/instancia, concurrencia y presupuesto global se fijan antes de las llamadas reales. No arrancar 10 llamadas pagadas solo porque haya una clave. Falta de credencial no convierte el job CI de motor real en verde por `skip`; bloquea el gate correspondiente. Estas son metas propuestas, no resultados medidos.

## D18. Comparación visual y validación parcial de una instrucción

- Contexto: las fuentes y el renderizado varían entre entornos; ignorar páginas afectadas deja sin vigilancia tablas/imágenes vecinas. §4 permite `not_possible` mientras §1 exige solo el cambio solicitado.
- Opciones: comparación tolerante indiscriminada o baseline reproducible con semántica explícita de resultado.
- Propuesta: renderizar original y salida en el mismo entorno fijado, con fuentes auditadas, locale y perfil iguales; aplicar 0,05 % fuera de regiones autorizadas, registrar medidas dentro. La región autoriza cambios de glifos por contenido, no pérdida de estilo: D07 y los checks estructurales/textuales siguen siendo obligatorios dentro de ella. Una petición indivisible no se entrega parcialmente: `not_possible` preserva el archivo, o se pide aprobación de un plan reducido. Para G10 no hay modificación y se devuelve warning verificable.
- Consecuencias: faltan fuentes o paginación estable → fallo explicado, no éxito aparente. Toda excepción visual debe surgir del plan aprobado, no del autoinforme del modelo.

## D19. Presupuesto y entorno de pruebas autorizado en F1

- Contexto: el usuario aprobó F1 y autorizó US$5 en total para pruebas Anthropic; posteriormente autorizó usar el Lenovo con aislamiento y registrar gVisor únicamente sin reiniciar producción.
- Decisión: Postgres/Redis/S3 de test independientes, sin puertos públicos ni configuración/datos productivos. Las solicitudes pagadas requieren reservas durables agregadas entre campañas e intentos; costo desconocido conserva la reserva y detiene nuevos gastos. El runner no confunde estimaciones con factura y pide evidencia verificable del límite del proveedor.
- Consecuencias: disponer de una clave configurada no certifica ese límite. Hasta verificarlo, cero llamadas pagadas. La autorización de runtime no autoriza reiniciar Docker, cambiar el runtime predeterminado, migrar datos productivos ni publicar la aplicación.

## D20. Objetos privados, cargas en vuelo y limpieza honesta

- Contexto: una caída puede ocurrir entre almacenamiento y registro DB; una respuesta del proveedor puede llegar después de cancelar.
- Decisión: reservar claves antes de escribir, cifrar AES-256-GCM con AAD del propietario/job/objeto y mantener originales inmutables. Revocar acceso inmediatamente mediante tombstone/fencing y esperar 15 minutos antes de purga física para solicitudes acotadas a 120 segundos. Conservar TTL de contenedores y reservas de costo incierto; borrar Files no prueba destruir el contenedor remoto.
- Consecuencias: el borrado lógico es inmediato, pero la confirmación física puede permanecer pendiente. Las filas tombstone y la FK restrictiva necesitan integración final con borrado de cuentas; no fingir cumplimiento completo de retención antes de probarlo. GET/LIST/DELETE pueden reintentarse tres veces ante fallos transitorios dentro del mismo deadline; PUT condicional no se reintenta ni transforma un 412 en éxito.
- Compatibilidad S3: un proxy de fallos real mostró que el wrapper de checksum opcional del SDK podía ocultar un stream interrumpido. Solo el cliente de este módulo usa `responseChecksumValidation: WHEN_REQUIRED`, conforme a la [configuración oficial AWS](https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html). Se conserva el checksum de subida predeterminado y la autenticación GCM obligatoria; los documentos además se contrastan contra SHA-256 esperado. Esto no cambia los cuatro niveles de validación documental ni configura otros clientes de la aplicación.

## D21. Directorio compartido del validador y artefactos inmutables

- Contexto: Docker resuelve bind mounts en el host, no en el filesystem privado del worker.
- Decisión: `DOC_SANDBOX_VALIDATION_STAGING_ROOT` obligatorio, ruta absoluta idéntica en host/worker, directorio 0700 del UID del worker, sin symlinks. Solo el subdirectorio de inputs por invocación entra en el validador en lectura. Aceptar imagen de registro por digest o ID local SHA-256 completo; no tags mutables.
- Consecuencias: una ruta mal montada falla cerrada; deben probarse contenedores reales y reconciliación de staging huérfano antes del cierre. Esto no habilita el Motor B: el editor de F1 sigue siendo Anthropic.

## D22. Evidencia parcial no equivale a los golden de la especificación

- Contexto: la revisión independiente encontró que las primeras fixtures del runner son ejemplos pequeños, sin la complejidad exigida por G1/G4/G7/G8.
- Decisión: tratarlas únicamente como smoke tests, nunca como sustitutos de los golden. Mantener como pendiente ejecutar casos reales, carga de diez jobs y E2E canónico. El corpus complejo y el contrato de preservación `not_possible` se implementaron después de este hallazgo; sus pruebas de componentes no cierran los golden reales.
- Consecuencias: F1 no está cerrada ni aprobada para producción aunque sus pruebas unitarias y servicios aislados pasen. La revisión no autoriza reducir alcance; los hallazgos se corrigen dentro de F1 antes de pedir cierre.

## D23. Admisión verificable y conservación honesta en el chat

- Contexto: la revisión de lanzamiento detectó ausencia de preflight de herramientas, desconexiones Redis no reflejadas en la admisión, rechazo de carga que retenía busy y frases naturales que podían llegar al editor antiguo.
- Decisión: no admitir antes del preflight runsc real; lease renovable del productor y ambas conexiones del worker; recuperar por clave idempotente del dueño. El cliente mantiene modelo/permisos seleccionados, originales binarios y controles existentes, sin nuevo diseño visual ni fallback silencioso.
- Consecuencias: `done` ya no equivale necesariamente a edición. `outcome` distingue `edited`, `unchanged`, `not_possible`; este último requiere todos los originales intactos, informes independientes y warning. Una carga no confirmada no se anuncia como cancelación ni se duplica. Sin endpoint seguro para mutar mensajes ASSISTANT, un puntero anterior al POST se reconsulta de forma acotada al navegar/recargar, no en un bucle de render. E2E y aprobación del hash UI siguen pendientes.

## D24. Cancelación antes de lanzar y rechazo de descargas sin espera de limpieza

- Contexto: cancelar durante la lectura asíncrona del manifiesto podía perder el evento antes de instalar su listener. En descargas, esperar la promesa de `cancel()` podía dejar abierta la operación; un rechazo de esa promesa también sustituía el error original.
- Opciones: mantener la espera del transporte, añadir más timeouts, o separar el resultado local del intento de limpieza y revalidar la señal al cruzar el límite asíncrono.
- Decisión: comprobar la señal tras leer el manifiesto y de nuevo antes de `spawn`; conservar `E_CANCELLED` sin exponer el motivo privado. En descargas, solicitar cancelación observada sin bloquear el rechazo por HTTP/tamaño/abort; conservar `finally` para liberar lock/listener. No ocultar errores de lectura ni devolver bytes parciales.
- Consecuencias: cancelación solicitada no significa limpieza remota confirmada. Los registros de borrado de Files y la reconciliación Docker existente no se cambian. Las regresiones usan streams y filesystem reales, no un validador simulado; el ensayo integral con runtime real sigue pendiente. Evidencia en [cancellation-release-20260906.md](cancellation-release-20260906.md).

## D25. Políticas puras sin trasladar la autoridad de persistencia

- Contexto: las decisiones de lease/transición y presupuesto estaban mezcladas con IO, dificultando probar sus límites sin simular DB o el procesador completo.
- Decisión: funciones puras sobre proyecciones tipadas del dominio, llamadas desde el mismo punto de las operaciones originales. El repositorio mantiene fila bloqueada, reloj DB, transacciones, fencing y SQL; el procesador mantiene inspección, heartbeat, deadlines, motor y reservas de costo. La aritmética y precedencia de errores se conservan.
- Consecuencias: 29 pruebas nuevas de políticas, revisión independiente y 46 integraciones reales PostgreSQL/Redis separadas de la cobertura estricta. Un snapshot no acredita propiedad concurrente ni puede sustituir una reserva transaccional. No se debilita el 80 %, no se cambia el tratamiento heredado de metadata inválida ni se declara F1 aprobada. Evidencia y límites en [policy-release-20260906.md](policy-release-20260906.md).

## Consulta externa y límites de este diagnóstico

Se consultaron las referencias accesibles de §15 y las licencias anteriores. El antiguo sitemap `docs.claude.com/en/docs_site_map.md` no se pudo recuperar; se utilizó el [índice oficial actual](https://platform.claude.com/llms.txt). La consulta documental no prueba permisos de la cuenta, disponibilidad del modelo ni firmas ejecutadas del SDK. Todo ello se verifica nuevamente y mediante tests reales en F1, tras aprobación.
