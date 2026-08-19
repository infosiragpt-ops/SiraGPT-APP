# Chatagentic capability smoke report

Generated: 2026-04-27T23:24:24.255Z
Run directory: `/Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z`

## Summary

- Total cases: 37
- Passed: 37
- Skipped: 0
- Failed: 0
- Average score: 97

## Evidence

- Results JSON: `/Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/results.json`
- Generated files: `/Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files`
- Telemetry: `/Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/telemetry`

## Matrix

| ID | Category | Objective | Status | Score | Artifact | Validations | Observations |
|---|---|---|---:|---:|---|---|---|
| HTTP-001 | runtime | Backend health endpoint returns 200 OK | PASS | 100 |  | HTTP 200, response body | {"status":"OK","timestamp":"2026-04-27T23:24:20.812Z","environment":"development"} |
| HTTP-002 | runtime | Frontend chat page returns 200 OK | PASS | 100 |  | HTTP 200, html response | bytes=25031 |
| DOC-001 | artifact-generation | Create professional DOCX with APA-like structure, headers, tables and image | PASS | 94 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_professional_with_APA-like_structure_headers_tables_and_image.docx | zipOpen, contentTypes, documentXml, headings, table, media, headerFooter, toc, references, formulaContent, content | application/vnd.openxmlformats-officedocument.wordprocessingml.document; bytes=11452 |
| XLS-001 | artifact-generation | Create XLSX workbook with formulas, charts, validations and multiple sheets | PASS | 93 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_workbook_with_formulas_charts_validations_and_multiple_sheets.xlsx | zipOpen, workbook, minSheets, tablesOrData, formulas, charts, conditionalFormatting, dataValidation, freezePanes, styles | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; bytes=11172 |
| PPT-001 | artifact-generation | Create PPTX with executive slides, charts, image and speaker notes | PASS | 100 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_with_executive_slides_charts_image_and_speaker_notes._Tema_inteligencia.pptx | zipOpen, presentation, slides, charts, media, notes, text, contentSpecific, layout | application/vnd.openxmlformats-officedocument.presentationml.presentation; bytes=351753 |
| PDF-001 | artifact-generation | Create PDF from complex structured content | PASS | 94 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_from_complex_structured_content._Tema_inteligencia_artificial_aplicada.pdf | header, eof, minPages, content, metadata | application/pdf; bytes=11360 |
| CSV-001 | artifact-generation | Create valid CSV with structured rows | PASS | 85 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_valid_CSV_with_structured_rows._Tema_inteligencia_artificial_aplicada.csv | notEmpty, header, rows, table, structure | text/csv; bytes=442 |
| HTML-001 | artifact-generation | Create semantic HTML artifact with style, table and link | PASS | 91 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_semantic_HTML_artifact_with_style_table_and_link._Tema_inteligencia_artificial.html | notEmpty, title, table, links, structure | text/html; bytes=8012 |
| MD-001 | artifact-generation | Create structured Markdown artifact with table and link | PASS | 86 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_structured_Markdown_artifact_with_table_and_link._Tema_inteligencia_artificial.md | notEmpty, title, table, links, structure | text/markdown; bytes=1071 |
| SVG-001 | artifact-generation | Create valid SVG visual artifact with namespace, viewBox and graphic elements | PASS | 89 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_valid_SVG_visual_artifact_with_namespace_viewBox_and_graphic_elements.svg | notEmpty, xmlDeclaration, rootSvg, namespace, viewBox, graphicElements, accessibility, noForeignDocument | image/svg+xml; bytes=5684 |
| DOC-002 | document-understanding | Extract text from generated DOCX with mammoth | PASS | 100 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_professional_with_APA-like_structure_headers_tables_and_image.docx | mammoth extractRawText, word count | <br><br><br><br><br><br>Create professional with APA-like structure, headers, tables and image<br><br>Documento generado por el pipeline documental multiagente de siraGPT.<br><br><br><br>Portada<br><br>Se desarrolla portad |
| DOC-003 | document-internals | Inspect DOCX OOXML internals for document, header, footer and media | PASS | 100 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_professional_with_APA-like_structure_headers_tables_and_image.docx | OOXML zip, header, footer, media | entries=26 |
| XLS-002 | spreadsheet-internals | Inspect XLSX workbook sheets, formulas and charts | PASS | 100 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_workbook_with_formulas_charts_validations_and_multiple_sheets.xlsx | ExcelJS open, sheets>=4, formulas, charts | sheets=Datos, Dashboard, Interpretacion, Métricas |
| PPT-002 | presentation-internals | Inspect PPTX slides, notes, media and theme | PASS | 100 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_with_executive_slides_charts_image_and_speaker_notes._Tema_inteligencia.pptx | OOXML zip, slides>=8, speaker notes, media | slides=11; entries=104 |
| PDF-002 | pdf-operations | Load PDF and generate merge, split, rotate and watermark artifacts | PASS | 100 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/pdf-operation-watermarked.pdf | pdf-lib load, merge, split, rotate, watermark | pdf-operation-extra.pdf, pdf-operation-merged.pdf, pdf-operation-split-rotated.pdf, pdf-operation-watermarked.pdf |
| DESIGN-001 | visual-artifacts | Validate HTML design quality report for an interactive dashboard shell | PASS | 100 | /Users/luis/Desktop/siraGPT/artifacts/chatagentic-smoke/2026-04-27T23-24-20-797Z/files/Create_semantic_HTML_artifact_with_style_table_and_link._Tema_inteligencia_artificial.html | qualityReportForHtml | {"passed":true,"score":100,"issues":[],"warnings":[],"metrics":{"bodyLength":5791,"visibleTextLength":1991,"semanticSectionCount":14,"headingCount":11,"renderableMediaCount":1}} |
| ROUTE-001 | semantic-router | crea un Word profesional sobre inteligencia artificial | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=doc; pipeline=DocumentPipeline; final=docx_file; nodes=8 |
| ROUTE-002 | semantic-router | haz un excel con formulas y dashboard | PASS | 92 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=doc; pipeline=SpreadsheetPipeline; final=xlsx_file; nodes=11 |
| ROUTE-003 | semantic-router | crea una presentacion ppt de arquitectura | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=ppt; pipeline=SlidePipeline; final=pptx_file; nodes=8 |
| ROUTE-004 | semantic-router | crea un pdf con marca de agua | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=doc; pipeline=DocumentPipeline; final=pdf_file; nodes=8 |
| ROUTE-005 | semantic-router | creame un svg de una casa moderna | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=doc; pipeline=VisualArtifactPipeline; final=svg_file; nodes=8 |
| ROUTE-006 | semantic-router | crea una imagen de un perro | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=image; pipeline=ImagePipeline; final=image; nodes=8 |
| ROUTE-007 | semantic-router | busca articulos reales con DOI sobre RAG | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=web_search; pipeline=ResearchGroundingPipeline; final=grounded_chat_answer; nodes=8 |
| ROUTE-008 | semantic-router | analiza este PDF y resume | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=text; pipeline=RAGDocumentUnderstandingPipeline; final=chat_answer; nodes=8 |
| ROUTE-009 | semantic-router | programa una API en FastAPI | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=text; pipeline=CodePipeline; final=js_file; nodes=10 |
| ROUTE-010 | semantic-router | crea una web de una empresa de carros | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=webdev; pipeline=CodePipeline; final=html_file; nodes=10 |
| ROUTE-011 | semantic-router | consulta el clima actual de La Paz | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=web_search; pipeline=ResearchGroundingPipeline; final=grounded_chat_answer; nodes=8 |
| ROUTE-012 | semantic-router | resultados NBA de hoy | PASS | 94 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=web_search; pipeline=DirectAnswerPipeline; final=grounded_chat_answer; nodes=7 |
| ROUTE-013 | semantic-router | busca restaurantes cerca de mi | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=web_search; pipeline=ResearchGroundingPipeline; final=grounded_chat_answer; nodes=8 |
| ROUTE-014 | semantic-router | redacta un correo profesional de disculpa | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=gmail; pipeline=ActionExecutionPipeline; final=chat_answer; nodes=8 |
| ROUTE-015 | semantic-router | dame una receta de pasta con temporizador | PASS | 90 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=text; pipeline=DirectAnswerPipeline; final=chat_answer; nodes=7 |
| ROUTE-016 | semantic-router | crea un dashboard interactivo | PASS | 94 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=viz; pipeline=DirectAnswerPipeline; final=chat_answer; nodes=11 |
| ROUTE-017 | semantic-router | cual es la primera palabra del word ? | PASS | 98 |  | UniversalTaskContract, ExecutionGraph, chat intent | intent=text; pipeline=RAGDocumentUnderstandingPipeline; final=chat_answer; nodes=8 |
| TOOLS-001 | tool-registry | Validate all built-in ToolManifests with JSON Schema | PASS | 100 |  | JSON Schema, required fields, acceptance tests | manifests=python_exec, bash_exec, web_search, create_document, rag_retrieve, self_rag_answer, verify_artifact, run_tests |
| SEARCH-001 | web-research | SearchBrain provider catalog is available locally | PASS | 100 |  | HTTP 200, providers array, openalex, pubmed | providers=wos, scopus, openalex, scielo, semantic, crossref, pubmed, doaj |
| SEARCH-002 | web-research | Attempt a real OpenAlex academic search through SearchBrain | PASS | 100 |  | HTTP 200, SearchBrain academic/chat | citations=1; providers=openalex |
| CODE-001 | programming | Node syntax checks pass for modified backend modules | PASS | 100 |  | node --check advanced-document-pipeline, node --check semantic-intent-router |  |

## Re-run

```bash
node scripts/chatagentic-capability-smoke.cjs
```
