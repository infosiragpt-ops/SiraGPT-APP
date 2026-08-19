# Skill: PDF editing

## Read text from PDF
Use `pypdf` (formerly PyPDF2):
```python
from pypdf import PdfReader
reader = PdfReader('file.pdf')
for i, page in enumerate(reader.pages):
    text = page.extract_text()
    print(f'--- Page {i+1} ---')
    print(text)
```

## Merge PDFs
```python
from pypdf import PdfMerger
merger = PdfMerger()
merger.append('file1.pdf')
merger.append('file2.pdf')
merger.write('merged.pdf')
merger.close()
```

## Extract specific pages
```python
from pypdf import PdfReader, PdfWriter
reader = PdfReader('file.pdf')
writer = PdfWriter()
for page_num in [0, 2, 4]:  # 0-indexed
    writer.add_page(reader.pages[page_num])
with open('extracted.pdf', 'wb') as f:
    writer.write(f)
```

## Add text overlay (stamp/watermark)
```python
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
import io

packet = io.BytesIO()
c = canvas.Canvas(packet)
c.setFont('Helvetica', 12)
c.drawString(100, 700, 'CONFIDENTIAL')
c.save()
packet.seek(0)

stamp = PdfReader(packet)
reader = PdfReader('file.pdf')
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(stamp.pages[0])
    writer.add_page(page)

with open('stamped.pdf', 'wb') as f:
    writer.write(f)
```

## Generate a new PDF from scratch
```python
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

c = canvas.Canvas('output.pdf', pagesize=A4)
width, height = A4
c.setFont('Helvetica-Bold', 16)
c.drawString(72, height - 72, 'Title')
c.setFont('Helvetica', 12)
c.drawString(72, height - 100, 'Body text goes here.')
c.save()
```

## Limitations
- PDF is a presentation format — text extraction may lose layout/order.
- Scanned PDFs require OCR (not available in sandbox).
- True in-place text editing is not supported by pypdf — generate a new PDF or use overlay approach.
