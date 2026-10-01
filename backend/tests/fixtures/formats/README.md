# Fixtures de formatos reales

Estos archivos se exportaron con LibreOffice a partir de los fixtures versionados de `../office`. No contienen archivos del ZIP adjunto por el usuario ni ejecutan sus scripts.

| Archivo | Original | Filtro LibreOffice |
| --- | --- | --- |
| tesis_demo.odt | tesis_demo.docx | writer8 |
| tesis_demo.rtf | tesis_demo.docx | Rich Text Format |
| presupuesto_demo.ods | presupuesto_demo.xlsx | calc8 |
| defensa_demo.odp | defensa_demo.pptx | impress8 |

Se pueden regenerar con `soffice --headless --convert-to EXT --outdir DEST ORIGINAL`. Las pruebas usan los bytes guardados, de modo que CI no necesita LibreOffice para verificar los lectores. El alcance es abrir el formato y comprobar su estructura, no probar fidelidad visual ni una edición solicitada.
