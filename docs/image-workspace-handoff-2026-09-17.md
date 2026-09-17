# Traspaso: generación y edición de imágenes

Luis pidió terminar esta PR de traspaso y publicarla. No añade comportamiento de producto: el código ya estaba en `production-main` vía [#734](https://github.com/infosiragpt-ops/SiraGPT-APP/pull/734).

## Cierre (17 de septiembre de 2026, ~21:30 UTC)

| Elemento | Estado |
| --- | --- |
| Código en `production-main` | [#734](https://github.com/infosiragpt-ops/SiraGPT-APP/pull/734) `7c0474c0236b1e9c552ff6b889357dd0234c0ef4` |
| Publicación Lenovo de #734 | [35267096258](https://github.com/infosiragpt-ops/SiraGPT-APP/actions/runs/35267096258) **success** |
| Live al cerrar el traspaso | `/api/version.commit` `b0f0ebe94aff0739c69a5c040ac3e527ebfdc91b` ([#718](https://github.com/infosiragpt-ops/SiraGPT-APP/pull/718)), **incluye** #734; `/api/health/ready` 200 `healthy` |
| Esta PR | docs de continuidad; se saca de borrador y se squash-merge a `production-main` (nunca `main`) |

No se relanzó un segundo `publish.sh` mientras #734 ya estaba ancestro del SHA live. No se hizo prueba autenticada de generación (Access/Google bloqueó elegir cuenta; no se elude con cookies ni tokens).

## Problema y resultado implementado

Las capturas 1–2 muestran una playa horizontal seguida de «la misma imagen pero vertical» que termina en una montaña distinta. Las capturas 3–6 fijan el visor blanco, imagen completa, herramientas, zoom, miniaturas y edición.

- Generación nueva, edición y cambio de formato se distinguen. Una edición queda vinculada al archivo, mensaje y conversación de origen.
- El cambio de formato prepara un lienzo real y conserva los píxeles protegidos. Las selecciones de borrado se envían como máscaras reales.
- Se respeta el modelo seleccionado; los errores no disparan cambios silenciosos de proveedor.
- Chat y Biblioteca reutilizan un visor blanco (ajuste, zoom 25–200 %, miniaturas, anotaciones, comentarios, borrado, tamaño, descarga, volver al chat).
- Ediciones y anotaciones guardan versiones con relación al original. Ocultar una imagen afecta a ese adjunto.

## Dónde está el código

- `backend/src/services/media/image-source.js`
- `backend/src/services/media/image-input-selection.js`
- `backend/src/services/media/image-edit-canvas.js`
- `backend/src/services/media/image-engine.js`
- `backend/src/routes/ai.js`, `backend/src/routes/images.js`, `backend/src/services/media/image-workspace-assets.js`
- `components/ui/image-modal.tsx`, `components/images/ImageWorkspace.tsx`
- `lib/image-workspace.ts`, `lib/image-viewer.ts`, `lib/api.ts`
- `components/chat-interface-enhanced.tsx`, `components/message-component.tsx`, `components/Library/LibraryTabs.tsx`

## Precauciones

- No `main`. No `git reset --hard`. No Hostinger. No volcar `.env`.
- `docs/license-policy.md` del checkout original no se incluye ni se modifica.
- Prueba autenticada playa→vertical sigue pendiente de Access con la cuenta de Luis.
