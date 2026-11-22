# Skill: PDF — Estudio Ejecutivo de Análisis, Edición y Maquetación

## Protocolo operativo (estilo Cowork)
1. **Inspección íntegra antes de actuar**: lee todas las páginas relevantes, tablas, anexos y metadatos; si el archivo es un reporte exportado (p. ej. Turnitin/Moodle), ignora la portada de similitud y trabaja sobre el contenido real del autor.
2. **Planificación visible (`≤ 7` fases en español)**: en tareas multi-paso (auditoría, combinación, extracción masiva o generación de entregable) registra primero el plan con `update_plan` y actualízalo al cerrar cada fase.
3. **Regla de oro para modificar un PDF existente (elige el nivel de mayor fidelidad)**:
   - **(A) Operaciones estructurales** (unir, dividir, reordenar, rotar, numerar páginas, marca de agua, rellenar formularios AcroForm, redactar datos sensibles): usa `pypdf` / `pymupdf` (`fitz`) conservando el 100 % de la tipografía y vectores originales.
   - **(B) Micro-ediciones puntuales de una línea** (fechas, importes, nombres de longitud similar): localiza la caja exacta con `fitz` (`page.search_for`), aplica redacción limpia sobre el rectángulo e inserta con métrica y fuente equivalentes.
   - **(C) Reescrituras profundas o inserción de secciones largas** («agrega una conclusión de 2 páginas», «reestructura los capítulos»): si no hay `.docx` fuente, convierte con fidelidad o maqueta una edición limpia advirtiendo si algún elemento decorativo requiere revisión.

## Maquetación de PDFs nuevos con calidad editorial
- Usa `reportlab.platypus` (`SimpleDocTemplate`, `Paragraph`, `Spacer`, `Table`, `TableStyle`, `KeepTogether`) o HTML→PDF con márgenes generosos (`20–25 mm`), jerarquía tipográfica clara (título `18–22 pt`, H1 `14 pt`, cuerpo `10.5–11 pt`, interlineado `1.35×`) y paleta sobria de alto contraste.
- **Tablas profesionales**: encabezado con fondo sutil (`#F4F4F5` o primario corporativo), alineación derecha en importes/cifras, `repeatRows=1` para saltos de página y nunca celdas cortadas a mitad de fila.
- **Cero texto de relleno**: prohibido entregar `Lorem ipsum`, `[INSERTAR AQUÍ]` o cifras inventadas; toda cifra proviene del material del usuario o se declara como supuesto explícito.

## Recetas verificadas en sandbox

### Inspección y extracción estructurada por página (`pypdf` / `fitz`)
```python
from pypdf import PdfReader

reader = PdfReader("entrada.pdf")
for idx, page in enumerate(reader.pages, start=1):
    txt = (page.extract_text() or "").strip()
    print(f"=== Página {idx}/{len(reader.pages)} ({len(txt)} chars) ===")
```

### Combinar, reordenar o extraer rangos preservando calidad vectorial
```python
from pypdf import PdfReader, PdfWriter

writer = PdfWriter()
for path in ["parte_1.pdf", "parte_2.pdf"]:
    r = PdfReader(path)
    for page in r.pages:
        writer.add_page(page)
with open("documento_unificado.pdf", "wb") as f:
    writer.write(f)
```

### Verificación obligatoria antes de entregar
- Comprueba que el archivo abre con `PdfReader`, tiene `len(reader.pages) >= 1`, ningún texto se superpone ni sale de los márgenes, y el texto clave solicitado está presente en las páginas finales.
