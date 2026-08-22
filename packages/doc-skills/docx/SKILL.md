---
name: docx-ooxml
description: Edición quirúrgica de DOCX (OOXML) para SiraGPT. Transplanta contenido a plantilla sin tocar sectPr, headers, footers ni numbering.
---

# DOCX skill (SiraGPT / Luis Carrera)

Un `.docx` es un ZIP de XML. Nunca lo edites como binario.

## When to use

- "pasa este word al formato UPN / plantilla"
- Transplantar `w:p` / `w:tbl` del source al body de una plantilla
- Preview PDF/PNG y verify visual (host)

## When not to use

- PDF (no es OOXML; ver `../pdf/SKILL.md`)
- Reconstruir el documento desde texto extraído
- Pedir XML o código al modelo de visión

## Pipeline

1. `python3 ../../scripts/ooxml_unpack.py FILE.docx /workspace/{jobId}/unpacked`
2. Edita XML (mínimo diff). Textos viven en `<w:t>`.
3. `python3 ../../scripts/ooxml_validate.py /workspace/{jobId}/unpacked`
4. `python3 ../../scripts/ooxml_repack.py /workspace/{jobId}/unpacked /workspace/{jobId}/out.docx`
5. `python3 ../../scripts/render_preview.py /workspace/{jobId}/out.docx /workspace/{jobId}/preview`

## transformToTemplate (formato UPN / plantilla)

```
python3 ../../scripts/transform_to_template.py \
  --source SOURCE.docx --template PLANTILLA.docx --out OUT.docx
```

Contrato:

- Copia la **plantilla** como base.
- Mapea `w:styleId` source→template desde `word/styles.xml`.
- Transplanta `w:p` y `w:tbl` del source al body de la plantilla.
- **NUNCA** alteres `w:sectPr` (último / terminal, SHA-256 byte-idéntico), headers, footers ni `numbering.xml`.
- Rechaza OLE / ActiveX / macros.
- Los placeholders `XXXXXXXX` del body se reemplazan por el contenido real.

## Visual patch (closed DSL)

El modelo de visión (DeepSeek V4 Flash/Pro, host) solo puede emitir JSON:

```
{"ops":[{"op":"replace_text","find":"XXXXXXXX","replace":"Titulo"}]}
```

`apply_visual_patch.py` rechaza XML, código o paths. Nunca pidas `document.xml` al modelo.

## Safety / limits

- Path traversal (`..`, absolutas) y symlinks rechazados.
- Zip-bomb: máximo 5000 entradas / 200 MB. Sin `extractall`.
- Requiere `[Content_Types].xml`.
- Repack: `ZIP_DEFLATED`, Content_Types primero, timestamps 1980-01-01, sin `pretty_print`.
- Parser XML seguro (sin DTD / entidades / red).

Vision verify (host, no sandbox): solo DeepSeek V4 Flash / Pro. OpenRouter está prohibido.
