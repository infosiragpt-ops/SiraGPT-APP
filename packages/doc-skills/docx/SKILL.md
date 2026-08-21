---
name: docx-ooxml
description: Edición quirúrgica de DOCX (OOXML) para SiraGPT. Transplanta contenido a plantilla sin tocar sectPr, headers, footers ni numbering.
---

# DOCX skill (SiraGPT / Luis Carrera)

Un `.docx` es un ZIP de XML. Nunca lo edites como binario.

## Pipeline

1. `python3 ../../scripts/ooxml_unpack.py FILE.docx /workspace/{jobId}/unpacked`
2. Edita XML (mínimo diff). Textos viven en `<w:t>`.
3. `python3 ../../scripts/ooxml_validate.py /workspace/{jobId}/unpacked`
4. `python3 ../../scripts/ooxml_repack.py /workspace/{jobId}/unpacked /workspace/{jobId}/out.docx`
5. `python3 ../../scripts/render_preview.py /workspace/{jobId}/out.docx /workspace/{jobId}/preview`

## transformToTemplate (formato UPN / plantilla)

Si el usuario dice "pasa este word al formato X" / "aplica la plantilla":

```
python3 ../../scripts/transform_to_template.py \
  --source SOURCE.docx --template PLANTILLA.docx --out OUT.docx
```

Contrato:

- Copia la **plantilla** como base.
- Mapea `w:styleId` source→template desde `word/styles.xml`.
- Transplanta `w:p` y `w:tbl` del source al body de la plantilla.
- **NUNCA** alteres `w:sectPr`, headers, footers ni `numbering.xml`.
- Los placeholders `XXXXXXXX` del body de la plantilla se reemplazan por el contenido real. Devolver la plantilla vacía es un bug.

## Límites de unpack

- Path traversal rechazado (`..`, rutas absolutas).
- Zip-bomb: máximo 5000 entradas / 200 MB descomprimidos.
- Conserva `[Content_Types].xml`.

## Repack

- `ZIP_DEFLATED`, `[Content_Types].xml` primero, sin `pretty_print`, conservar `nsmap`.

Vision verify (host, no sandbox): solo DeepSeek V4 Flash / Pro. OpenRouter está prohibido.
