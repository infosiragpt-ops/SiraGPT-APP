# MVP implementado — Editor de documentos en /chat

Un editor de texto enriquecido (rich-text) orientado a humanos en el flujo
subir → editar → guardar, reutilizando la infraestructura existente
(TiptapEditor, versioning service, docx, DOMPurify) en lugar de construir
nueva plumbing de upload/persistencia.

## Alcance

- **Panel**: `components/chat/DocumentEditorPanel.tsx` — diálogo que carga el
  contenido extraído del archivo (getFileContent → `extractedText`) como
  Markdown, lo muestra en `TiptapEditor` editable, y ofrece:
  - **Guardar** → crea una nueva `FileVersion` vía `POST /files/:id/edit`
    (el original nunca se muta; "recargar conserva el estado" funciona por el
    campo aditivo `content` del FileVersion).
  - **Exportar** → `.md` / `.txt` (client-side literal) y `.docx` (docx `Packer`
    reutilizando el estilo de `lib/download-utils.ts`).
  - **Cancelar/Cerrar** → descarta.
- **Orquestador**: `lib/chat/document-editor.ts` — funciones puras e inyectadas
  por dependencia (`apiClient` pasado, nunca importado) para testeabilidad:
  `sanitizeContentForEditor`, `contentToMarkdown`, `markdownToDocxBlob`,
  `buildExportBlob`, `saveEditedDocument`, `isEditorContentWithinLimits`.
- **Backend**: `POST /files/:id/edit` y `GET /files/:id/versions/:versionId/content`
  en `backend/src/routes/files.js` (auth + ownership, mismo estilo que las rutas
  de versions). `recordFileVersion` acepta `content` opcional.
  Migración aditiva `20260811000000_add_file_version_content` añade
  `content TEXT` a `file_versions`.
- **Chat**: `components/chat-interface-enhanced.tsx` — cambios mínimos y
  aditivos: botón "Editar documento" (lápiz) en el chip de adjunto abre el
  panel (lazy `next/dynamic`, ssr:false); al guardar se asocia una turno USER
  con el fileId vía `apiClient.addMessage` (misma forma que el composer).
- **API client**: `saveDocumentEdit` y `getFileVersionContent` en `lib/api.ts`.

## Verificación

- `npx tsc --noEmit --skipLibCheck` → sin errores.
- `next lint` en archivos nuevos → sin warnings/errores.
- `vitest` (suite completa, 83 archivos / 683 tests) → verde.
  Incluye `tests/lib/document-editor.test.ts` (19 tests) y el contrato protegido
  `authenticated-fetch-contract.test.ts` (no toca raw fetch).
- Backend `test:security-documents` → 54/54.
- E2E `e2e/document-editor.spec.ts` (upload → Editar → exportar .docx → Guardar)
  y los specs de chat existentes (`chat-upload`, `chat-buttons-smoke`,
  `chat-paste-ingest`, `document-background-edit`) → verdes contra dev server.

## Scope / limitaciones honestas

- **PDF/etc.** = se edita el **texto extraído**, no se re-vectoriza el binario.
  El guardado persiste el Markdown editado como `content` de la versión;
  `downloadUrl` es `null` (no se genera un artefacto binario server-side).
- La migración está escrita a mano y es aditiva; requiere correr
  `prisma migrate deploy` (o el flujo que use el backend) para propagar la columna.
- El `content` de una versión se lee vía endpoint dedicado; la UI del historial
  de versiones existente no muestra aún un "abrir esta versión editada", solo el
  panel lo rehidrata.
