# Skill: DOCX editing

## Preferred library
Use `python-docx`. Always import as:
```python
from docx import Document
```

## Read a document
```python
from docx import Document
doc = Document('file.docx')
for para in doc.paragraphs:
    print(para.style.name, '|', para.text)
```

## Edit paragraph text (preserve style)
Never replace `para.text` directly — it clears runs and loses formatting.
Use run-level edits:
```python
for para in doc.paragraphs:
    for run in para.runs:
        if 'old text' in run.text:
            run.text = run.text.replace('old text', 'new text')
```

## Edit tables
```python
for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            if 'TARGET' in cell.text:
                cell.paragraphs[0].runs[0].text = 'REPLACEMENT'
```

## Add paragraph at end
```python
doc.add_paragraph('New paragraph text', style='Normal')
```

## Save
Always save to a new file to preserve the original:
```python
doc.save('file_edited.docx')
```

## When python-docx is insufficient
For complex XML changes (e.g., section properties, numbering, tracked changes):
```python
import zipfile, shutil, re

shutil.copy('file.docx', 'file_edited.docx')
with zipfile.ZipFile('file_edited.docx', 'r') as z:
    content = z.read('word/document.xml').decode('utf-8')

content = content.replace('<old_xml>', '<new_xml>')

with zipfile.ZipFile('file_edited.docx', 'w', zipfile.ZIP_DEFLATED) as zout:
    with zipfile.ZipFile('file.docx', 'r') as zin:
        for item in zin.infolist():
            if item.filename == 'word/document.xml':
                zout.writestr(item, content.encode('utf-8'))
            else:
                zout.writestr(item, zin.read(item.filename))
```

## Common pitfalls
- `para.text` is read-only in terms of formatting — always edit runs.
- Merged table cells create duplicate `<w:tc>` references — iterate with care.
- Images are in `word/media/` — to replace, swap via the ZIP method above.
