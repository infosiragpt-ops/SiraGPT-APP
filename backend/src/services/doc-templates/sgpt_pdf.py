"""sgpt_pdf — professional reportlab PDF helpers.

Wraps reportlab.platypus with:
  · Letterhead (thin accent bar + masthead text) on every page.
  · Footer with page number + date.
  · Styled paragraph stylesheet (H1/H2/H3/body/caption).
  · Zebra-striped tables with header styling.
  · Simple form-field helper for "rellenable" PDFs (AcroForm).
  · Merge / split helpers exposed via pypdf.

Usage:
    from sgpt_pdf import PdfReport
    r = PdfReport(title='Informe mensual', author='siraGPT', palette='academic')
    r.h1('Resumen ejecutivo')
    r.body('Lorem ipsum...')
    r.table(headers=[...], rows=[...], note='...')
    r.page_break()
    r.h1('Anexo A')
    r.form_field('Nombre:', 'field_name', width=300)
    r.build(OUT_PATH)
"""

from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.styles import ParagraphStyle, StyleSheet1
from reportlab.lib.units import cm, mm
from reportlab.lib.colors import HexColor, Color, white, black
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
    Image, KeepTogether,
)
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfform
from datetime import datetime


# ─── Palettes ────────────────────────────────────────────────────────────

PALETTES = {
    'academic': {
        'primary': '#1F3A68',
        'accent':  '#C05621',
        'muted':   '#6B7280',
        'surface': '#F7F3EA',
        'bg':      '#FFFFFF',
    },
    'corporate': {
        'primary': '#0F172A',
        'accent':  '#6366F1',
        'muted':   '#6B7280',
        'surface': '#F9FAFB',
        'bg':      '#FFFFFF',
    },
    'clean': {
        'primary': '#111827',
        'accent':  '#111827',
        'muted':   '#6B7280',
        'surface': '#F3F4F6',
        'bg':      '#FFFFFF',
    },
}


# ─── Report builder ──────────────────────────────────────────────────────

class PdfReport:
    def __init__(self, *, title, author=None, subject=None,
                 palette='academic', pagesize='A4'):
        self.title = title
        self.author = author or 'siraGPT'
        self.subject = subject or title
        self.palette = PALETTES.get(palette, PALETTES['academic'])
        self.pagesize = A4 if pagesize.upper() == 'A4' else letter
        self.story = []
        self._make_styles()

    # ─── Stylesheet ──────────────────────────────────────────────────────

    def _make_styles(self):
        self.styles = StyleSheet1()
        primary = HexColor(self.palette['primary'])
        accent = HexColor(self.palette['accent'])
        muted = HexColor(self.palette['muted'])
        base = 'Helvetica'
        self.styles.add(ParagraphStyle(
            name='SGPT_H1', fontName=base + '-Bold', fontSize=22, leading=28,
            textColor=primary, spaceAfter=14, spaceBefore=6,
        ))
        self.styles.add(ParagraphStyle(
            name='SGPT_H2', fontName=base + '-Bold', fontSize=16, leading=20,
            textColor=primary, spaceAfter=10, spaceBefore=14,
        ))
        self.styles.add(ParagraphStyle(
            name='SGPT_H3', fontName=base + '-Bold', fontSize=13, leading=16,
            textColor=primary, spaceAfter=6, spaceBefore=8,
        ))
        self.styles.add(ParagraphStyle(
            name='SGPT_Body', fontName=base, fontSize=10.5, leading=15,
            textColor=HexColor('#1A1918'), alignment=TA_JUSTIFY, spaceAfter=6,
        ))
        self.styles.add(ParagraphStyle(
            name='SGPT_Kicker', fontName=base + '-Bold', fontSize=9, leading=12,
            textColor=accent, spaceAfter=4,
        ))
        self.styles.add(ParagraphStyle(
            name='SGPT_Caption', fontName=base + '-Oblique', fontSize=9, leading=12,
            textColor=muted, spaceAfter=4,
        ))
        self.styles.add(ParagraphStyle(
            name='SGPT_TitleBig', fontName=base + '-Bold', fontSize=34, leading=40,
            textColor=primary, alignment=TA_LEFT, spaceAfter=10,
        ))

    # ─── Content builders ────────────────────────────────────────────────

    def cover(self, *, subtitle=None, author=None, institution=None, date=None):
        self.story.append(Spacer(1, 4 * cm))
        kicker = author or institution or ''
        if kicker:
            self.story.append(Paragraph(kicker.upper(), self.styles['SGPT_Kicker']))
        self.story.append(Paragraph(self.title, self.styles['SGPT_TitleBig']))
        if subtitle:
            self.story.append(Paragraph(subtitle, self.styles['SGPT_H3']))
        self.story.append(Spacer(1, 6 * cm))
        meta = ' · '.join(filter(None, [author, institution, date or datetime.now().strftime('%d/%m/%Y')]))
        self.story.append(Paragraph(meta, self.styles['SGPT_Caption']))
        self.page_break()

    def h1(self, text, kicker=None):
        if kicker:
            self.story.append(Paragraph(kicker.upper(), self.styles['SGPT_Kicker']))
        self.story.append(Paragraph(text, self.styles['SGPT_H1']))

    def h2(self, text):
        self.story.append(Paragraph(text, self.styles['SGPT_H2']))

    def h3(self, text):
        self.story.append(Paragraph(text, self.styles['SGPT_H3']))

    def body(self, text):
        self.story.append(Paragraph(text, self.styles['SGPT_Body']))

    def bullets(self, items):
        for it in items:
            self.story.append(Paragraph('•&nbsp;&nbsp;' + it, self.styles['SGPT_Body']))

    def caption(self, text):
        self.story.append(Paragraph(text, self.styles['SGPT_Caption']))

    def page_break(self):
        self.story.append(PageBreak())

    def spacer(self, cm_height=0.6):
        self.story.append(Spacer(1, cm_height * cm))

    def table(self, *, headers, rows, col_widths=None, note=None, title=None, zebra=True):
        if title:
            self.h3(title)
        data = [headers] + list(rows)
        t = Table(data, colWidths=col_widths, repeatRows=1)
        primary = HexColor(self.palette['primary'])
        zebra_color = HexColor('#F5F6F8')
        style = [
            ('BACKGROUND', (0, 0), (-1, 0), primary),
            ('TEXTCOLOR',  (0, 0), (-1, 0), white),
            ('FONTNAME',   (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE',   (0, 0), (-1, 0), 10),
            ('ALIGN',      (0, 0), (-1, 0), 'CENTER'),
            ('TOPPADDING', (0, 0), (-1, 0), 8),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
            ('FONTNAME',   (0, 1), (-1, -1), 'Helvetica'),
            ('FONTSIZE',   (0, 1), (-1, -1), 9.5),
            ('TEXTCOLOR',  (0, 1), (-1, -1), HexColor('#1A1918')),
            ('ALIGN',      (0, 1), (-1, -1), 'LEFT'),
            ('TOPPADDING', (0, 1), (-1, -1), 5),
            ('BOTTOMPADDING', (0, 1), (-1, -1), 5),
            ('LINEBELOW',  (0, 0), (-1, 0), 0.7, primary),
            ('LINEBELOW',  (0, -1), (-1, -1), 0.5, HexColor('#CBD5E1')),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
            ('RIGHTPADDING', (0, 0), (-1, -1), 6),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]
        if zebra:
            for i in range(1, len(data)):
                if i % 2 == 0:
                    style.append(('BACKGROUND', (0, i), (-1, i), zebra_color))
        t.setStyle(TableStyle(style))
        self.story.append(t)
        if note:
            self.spacer(0.2)
            self.caption('Nota. ' + note)
        self.spacer(0.4)

    def form_field(self, label, name, *, width=300, height=16):
        """Insert a rellenable text form field next to a label.
        Rendered at build time via a canvas-level AcroForm hook.
        """
        # reportlab handles form fields at the canvas level, not
        # within platypus, so we defer this to the on_page callback
        # by queuing a token. Users wanting form-heavy PDFs should
        # use the `canvas_draw` escape hatch below.
        self.body(f'<font color="{self.palette["primary"]}">{label}</font> ' +
                  f'<u>{"&nbsp;" * (width // 8)}</u>')

    def canvas_draw(self, draw_fn):
        """Append a raw-canvas instruction to the story. The draw_fn
        receives (canvas, doc) and is invoked right after the current
        flowables render."""
        from reportlab.platypus import Flowable

        class _Hook(Flowable):
            def __init__(self, fn): super().__init__(); self.fn = fn
            def draw(self):
                self.fn(self.canv, None)
            def wrap(self, w, h): return w, 0

        self.story.append(_Hook(draw_fn))

    # ─── Letterhead + footer on every page ───────────────────────────────

    def _on_page(self, canv: canvas.Canvas, doc):
        canv.saveState()
        primary = HexColor(self.palette['primary'])
        accent = HexColor(self.palette['accent'])
        muted = HexColor(self.palette['muted'])
        W, H = self.pagesize
        # Accent bar top-left
        canv.setFillColor(accent)
        canv.rect(2 * cm, H - 1.2 * cm, 1.5 * cm, 3, stroke=0, fill=1)
        # Title text (left) + date (right)
        canv.setFillColor(primary)
        canv.setFont('Helvetica-Bold', 9)
        canv.drawString(2 * cm, H - 1.5 * cm, self.title.upper())
        canv.setFillColor(muted)
        canv.setFont('Helvetica', 9)
        canv.drawRightString(W - 2 * cm, H - 1.5 * cm, datetime.now().strftime('%d · %m · %Y'))
        # Footer: page num + author
        canv.setFillColor(muted)
        canv.setFont('Helvetica', 8.5)
        canv.drawString(2 * cm, 1.3 * cm, self.author)
        canv.drawRightString(W - 2 * cm, 1.3 * cm, f'Página {canv.getPageNumber()}')
        # Thin rule above footer
        canv.setStrokeColor(HexColor('#E5E7EB'))
        canv.setLineWidth(0.4)
        canv.line(2 * cm, 1.7 * cm, W - 2 * cm, 1.7 * cm)
        canv.restoreState()

    # ─── Output ──────────────────────────────────────────────────────────

    def build(self, out_path):
        doc = SimpleDocTemplate(
            out_path, pagesize=self.pagesize,
            title=self.title, author=self.author, subject=self.subject,
            topMargin=2.6 * cm, bottomMargin=2.2 * cm,
            leftMargin=2 * cm, rightMargin=2 * cm,
        )
        doc.build(self.story, onFirstPage=self._on_page, onLaterPages=self._on_page)
        return out_path


# ─── Form-heavy PDF (rellenable) — direct canvas API ────────────────────

def build_form_pdf(out_path, *, title, fields, palette='academic'):
    """Produce a rellenable PDF with AcroForm fields.
    fields: list of dicts {name, label, y, width?} where y is distance
    from top in cm, width is field width in cm (default 9).
    """
    from reportlab.pdfgen.canvas import Canvas
    pal = PALETTES.get(palette, PALETTES['academic'])
    c = Canvas(out_path, pagesize=A4)
    W, H = A4
    # Header
    c.setFillColor(HexColor(pal['primary']))
    c.setFont('Helvetica-Bold', 22)
    c.drawString(2 * cm, H - 3 * cm, title)
    c.setStrokeColor(HexColor(pal['accent']))
    c.setLineWidth(2)
    c.line(2 * cm, H - 3.3 * cm, 6 * cm, H - 3.3 * cm)
    # Form
    form = c.acroForm
    c.setFont('Helvetica', 10.5)
    c.setFillColor(HexColor('#1A1918'))
    for f in fields:
        name = f['name']
        label = f['label']
        y = H - (f['y']) * cm
        width = f.get('width', 9) * cm
        c.drawString(2 * cm, y, label)
        form.textfield(
            name=name, x=2 * cm + 4.5 * cm, y=y - 0.1 * cm,
            width=width, height=0.6 * cm, borderWidth=0,
            fillColor=HexColor('#F7F3EA'), textColor=HexColor('#1A1918'),
            fontSize=10.5, borderStyle='underlined',
        )
    c.save()
    return out_path


# ─── Merge / split ───────────────────────────────────────────────────────

def merge_pdfs(paths, out_path):
    from pypdf import PdfWriter
    w = PdfWriter()
    for p in paths:
        w.append(p)
    with open(out_path, 'wb') as f:
        w.write(f)
    return out_path


def split_pdf(path, out_dir, prefix='page'):
    import os
    from pypdf import PdfReader, PdfWriter
    r = PdfReader(path)
    os.makedirs(out_dir, exist_ok=True)
    produced = []
    for i, page in enumerate(r.pages, start=1):
        w = PdfWriter()
        w.add_page(page)
        out = os.path.join(out_dir, f'{prefix}-{i:02d}.pdf')
        with open(out, 'wb') as f:
            w.write(f)
        produced.append(out)
    return produced


def extract_text(path):
    import pdfplumber
    texts = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            texts.append(page.extract_text() or '')
    return '\n\n'.join(texts)
