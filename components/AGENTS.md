# AGENTS.md — Componentes y experiencia de usuario

Alcance: `components/**`. Complementa [la política raíz](../AGENTS.md); no autoriza cambios de producto, permisos ni despliegues.
Objetivo: mejorar el componente solicitado sin romper los recorridos, datos o controles que ya funcionan.

## Antes de editar

- DEBE: delimitar el cambio visual autorizado y registrar qué comportamiento debe permanecer idéntico.
- DEBE: leer el componente, sus consumidores, helpers, estilos y pruebas antes de extraer, sustituir o eliminar lógica.
- DEBE: distinguir el frontend canónico de componentes heredados; un nombre `chat` o `code` en disco no autoriza otra superficie.
- NO DEBE: reordenar navegación, duplicar paneles, cambiar estilos globales o modernizar componentes vecinos sin pedido.
- NO DEBE: borrar una variante porque parece duplicada sin inventario de imports, rutas y consumidores dinámicos.

## Mapa de revisión

| Si cambia | Revisar también |
|---|---|
| Entrada de agentes | [agents-home-surface.tsx](agents-home-surface.tsx), [rutas canónicas](../app/agentes/), [helpers de navegación](../lib/agents-home-path.ts) |
| Composer | [chat-interface-enhanced.tsx](chat-interface-enhanced.tsx), [sesión](../lib/chat/composer-session.ts), [contexto del chat](../lib/chat-context-integrated.tsx) |
| Esfuerzo y permisos | [composer-effort-menu.tsx](chat/composer-effort-menu.tsx), [composer-permission-menu.tsx](chat/composer-permission-menu.tsx), [estilos](../app/globals.css) |
| Artefactos | [document-artifact-chrome.tsx](doc/document-artifact-chrome.tsx), [doc-artifact-display.tsx](doc/doc-artifact-display.tsx), [agentic-steps.tsx](agentic-steps.tsx), [document-preview.tsx](document-preview.tsx) |
| Primitivas reutilizadas | [ui/](ui/), todos sus imports y los menús, diálogos o formularios que las consumen |

Este mapa es un punto de partida, no un inventario exhaustivo. DEBE actualizarse si se mueven los archivos citados.

## Controles compactos sin perder funcionalidad

- DEBE: un cambio de etiqueta a solo icono conservar apertura, selección, estado activo, nombre accesible y ayuda contextual.
- DEBE: preservar `type="button"`, estados disabled/loading, foco visible y navegación por teclado cuando correspondan.
- DEBE: probar abrir, seleccionar, cerrar con Escape y devolver el foco al disparador; incluir teclado y puntero.
- DEBE: mantener las selecciones de modelo, esfuerzo, permisos y modo rápido coherentes con el payload enviado y su persistencia.
- NO DEBE: cambiar IDs, defaults, significado de controles o permisos para simplificar su presentación.
- NO DEBE: usar solo color, un SVG sin nombre accesible o un elemento no interactivo para una acción.
- DEBE: conservar envío único, cola, Stop/cancelación, adjuntos y contenido del borrador al cambiar un control.
- NO DEBE: convertir un saludo o un render en selección, envío o activación automática de capacidades.

## Historial, modelos y documentos

- DEBE: respetar el catálogo activo y elegible; un error o lista vacía debe ser visible, no ocultarse con modelos inventados.
- NO DEBE: sustituir silenciosamente el modelo elegido ni reescribir conversaciones al compactar la UI.
- DEBE: preservar identidad de chat, mensaje, archivo y versión; preview y descarga deben referirse al artefacto correcto.
- DEBE: mantener nombre, formato, icono de tipo, historial y metadatos coherentes entre el archivo inicial y sus revisiones.
- NO DEBE: mostrar “Validado”, “Editado” o éxito por el mero hecho de recibir una URL o renderizar una tarjeta.
- DEBE: reflejar fallos y estados incompletos del backend sin fabricar contenido o marcar el trabajo terminado.
- NO DEBE: sobrescribir originales o perder enlaces de versiones previas por una refactorización visual.

## Compatibilidad y límites cliente/servidor

- DEBE: comprobar escritorio y móvil, tema claro/oscuro, zoom, textos largos, adjuntos y menús cerca del borde.
- DEBE: evitar overflow horizontal, controles recortados, overlays que intercepten acciones y cambios de tamaño al escribir.
- DEBE: conservar SSR/hidratación; acceder a `window` o almacenamiento solo en el contexto apropiado.
- NO DEBE: importar secretos, SDK privilegiados, credenciales o módulos de servidor a componentes cliente.
- NO DEBE: añadir logs de prompts, documentos, tokens o respuestas privadas para diagnosticar la interfaz.
- DEBE: conservar sanitización y aislamiento de previews; contenido generado o adjunto sigue siendo dato no confiable.

## Pruebas y evidencia del cambio

Comandos desde la raíz; comprobar los scripts vigentes de [package.json](../package.json) antes de usarlos.

```bash
npm run type-check
npm run lint
npm run ui-lock:verify
npm run test:unit -- tests/components/document-artifact-uniform.test.tsx
npm run test:e2e -- e2e/document-artifact-consistency.spec.ts --project=chromium
```

- DEBE: elegir además pruebas del componente modificado; los ejemplos de documentos no cubren todo el composer.
- DEBE: para una regresión, comprobar que el caso detecta el fallo previo y pasa con la corrección.
- DEBE: identificar fixtures, autenticación/API interceptadas y límites de la evidencia; navegador sintético no prueba edición real.
- NO DEBE: ejecutar fixtures mutantes contra producción ni cambiar su destino para obtener un verde.
- NO DEBE: regenerar UI-lock o snapshots para ocultar diferencias inesperadas; revisar cada diferencia antes de aceptarla.
- DEBE: actualizar hashes solo para archivos y cambios visuales autorizados, conservando evidencia de antes/después.
- DEBE: si una comprobación falla, registrar causa y alcance; no borrar tests, relajar expectativas ni declarar el control listo.
