# Skill: DOCX editing

## Contract: SURGICAL, FORMAT-PRESERVING edits
When the user uploads a Word document and asks for a change, the deliverable
MUST look like the original document with only the requested change applied.
Follow this contract:

1. **Never rebuild the document from extracted text.** Rebuilding loses
   styles, fonts, headers/footers, numbering, images and tables. Always open
   the ORIGINAL file and mutate it in place (python-docx) or patch its XML
   (ZIP method below).
2. **Minimal diff.** Touch only the paragraphs/cells the user asked about.
   Everything else — including whitespace and rsid attributes — stays as-is.
3. **Analyze BEFORE editing.** Read the document structure first (headings,
   styles in use, tables, lists). State what you found, map the user's request
   to specific locations, then edit those locations only.
4. **Clone neighbour formatting for insertions.** New paragraphs must copy the
   `style`/`pPr`/`rPr` of an adjacent paragraph of the same role (body text
   copies body text; a new list item copies an existing list item, keeping its
   `numPr` so Word renders the real marker).
5. **Never touch the final `sectPr`** (page size/margins/columns live there).
   Appends go BEFORE it.
6. **Save to a new file** (`*_editado.docx`) — the original is never mutated.

## Preferred library
Use `python-docx`. Always import as:
```python
from docx import Document
```

## Analyze the document first
```python
from docx import Document
doc = Document('file.docx')
for i, para in enumerate(doc.paragraphs):
    print(i, para.style.name, '|', para.text[:80])
for t, table in enumerate(doc.tables):
    print('table', t, len(table.rows), 'x', len(table.columns))
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

### Needle split across runs
Word often splits a sentence into several runs (spell-check, style changes).
If the needle is not inside a single run, join the paragraph text, apply the
replacement, then write the result back into the FIRST run and empty the
others — this keeps the first run's formatting for the whole paragraph:
```python
full = ''.join(run.text for run in para.runs)
if 'old text' in full and para.runs:
    updated = full.replace('old text', 'new text')
    para.runs[0].text = updated
    for run in para.runs[1:]:
        run.text = ''
```

## Insert a paragraph that matches the document
Copy the style of an adjacent paragraph instead of using defaults:
```python
anchor = doc.paragraphs[12]              # the paragraph to insert after
new_para = anchor.insert_paragraph_before('')   # then move text in
new_para.style = anchor.style           # same named style = same look
new_para.add_run('Texto nuevo')
```
For list items, anchor on an EXISTING list item so `numPr` (numbering) is
inherited via the style — the new item shows the same bullet/number format.

## Edit tables
```python
for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            if 'TARGET' in cell.text:
                cell.paragraphs[0].runs[0].text = 'REPLACEMENT'
```
Only rewrite the text inside cells (`w:t`); never rebuild `tcPr`/`tblPr` —
cell shading, borders and widths live there.

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
Rules for the ZIP method:
- Repack EVERY original entry byte-for-byte except the one you edited.
- Keep `[Content_Types].xml` and `_rels/` untouched unless you added media.
- Verify the result opens: re-read the ZIP and check `word/document.xml`
  parses and the change is present.

## Common pitfalls
- `para.text` is read-only in terms of formatting — always edit runs.
- Merged table cells create duplicate `<w:tc>` references — iterate with care.
- Images are in `word/media/` — to replace, swap via the ZIP method above.
- Headings detection: check `para.style.name` (Heading 1..6, Título 1..6) —
  never assume by font size alone.
- Numbered lists: the numbering DEFINITION lives in `word/numbering.xml`;
  paragraphs only reference it via `numPr`. Reuse existing `numId`s; never
  invent new ones without adding the definition.
