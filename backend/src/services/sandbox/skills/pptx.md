# Skill: PPTX editing & professional design

## Golden rule: SURGICAL edits — never regenerate the deck
Open the ORIGINAL file, touch ONLY the shapes/slides asked about, and return
the SAME file. Text lives in a:t of slideN.xml and notesSlideN.xml — for
TEXT-ONLY changes prefer unpack + direct XML patch (lxml) preserving a:rPr.
FORBIDDEN unless "modo reformateo": layouts, masters, theme,
presentation.xml (slide order lives in p:sldIdLst — edit it together with
rels + [Content_Types] overrides if reordering). Beware autofit when
lengthening text.

## Contract: SURGICAL edits on uploaded decks
When the user uploads a .pptx and asks for a change, the edited deck MUST keep
the original theme, masters, layouts, fonts and colors. Follow this contract:

1. **Never rebuild the deck.** Open the ORIGINAL file with `python-pptx` and
   mutate only the shapes/slides the user asked about.
2. **New slides must use the deck's own layouts** (`prs.slide_layouts`) so they
   inherit the master's fonts/colors — never hardcode a generic look into a
   themed deck.
3. **Text edits happen at run level** (`run.text = ...`), preserving each
   run's font, size, bold and color.
4. **Minimal diff:** slide order, notes, media and transitions you were not
   asked to change stay untouched.
5. **Save to a new file** (`*_editado.pptx`).

## Preferred library
```python
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
```

## Analyze the deck first
```python
prs = Presentation('deck.pptx')
print('slide size:', prs.slide_width, prs.slide_height)
for i, slide in enumerate(prs.slides):
    print(f'--- slide {i} layout={slide.slide_layout.name}')
    for shape in slide.shapes:
        kind = shape.shape_type
        text = shape.text_frame.text[:60] if shape.has_text_frame else ''
        print(f'    {shape.shape_id} {kind} | {text}')
```

## Edit text preserving formatting
```python
for slide in prs.slides:
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        for para in shape.text_frame.paragraphs:
            for run in para.runs:
                if 'old' in run.text:
                    run.text = run.text.replace('old', 'new')
```

## Add a slide that matches the deck
```python
# Pick the layout by NAME from the deck's own master — never index blindly.
names = [l.name for l in prs.slide_layouts]
layout = next((l for l in prs.slide_layouts if 'Title and Content' in l.name or 'Título y contenido' in l.name), prs.slide_layouts[0])
slide = prs.slides.add_slide(layout)
slide.shapes.title.text = 'Nuevo título'
body = slide.placeholders[1]
tf = body.text_frame
tf.text = 'Primer punto'
p = tf.add_paragraph(); p.text = 'Segundo punto'; p.level = 0
```

## Single-layout decks (PptxGenJS / platform-generated)
These decks ship ONE layout (`DEFAULT`) with NO placeholders — `layouts[6]`
and any 'Title and Content' lookup FAIL. Fall back to `layouts[0]` and build
title + body with text boxes sized from the slide canvas:
```python
from pptx.util import Inches
slide = prs.slides.add_slide(prs.slide_layouts[0])
W, H = prs.slide_width, prs.slide_height
title_box = slide.shapes.add_textbox(Inches(0.7), Inches(0.4), W - Inches(1.4), Inches(0.8))
title_box.text_frame.text = 'Nuevo título'
body_box = slide.shapes.add_textbox(Inches(0.9), Inches(1.8), W - Inches(1.8), H - Inches(2.6))
tf = body_box.text_frame
tf.text = 'Primer punto'
p = tf.add_paragraph(); p.text = 'Segundo punto'; p.level = 0
assert len(prs.slides) == expected_count, 'slide was not added'
```

## Speaker notes
```python
slide.notes_slide.notes_text_frame.text = 'Guion del presentador…'
```

## Professional design rules (when GENERATING new decks)
- **One idea per slide.** Title ≤ 8 words; max 4 bullets, ≤ 12 words each.
- **Consistent grid:** margins ≥ 0.65", aligned left edges, equal gutters.
- **Typography hierarchy:** display font for titles (28–40pt), body 13–17pt,
  captions 9–11pt. Never below 9pt.
- **User-directed palette:** distinguish background, text, accents, and colors
  assigned to each chart series/category. Preserve exact requested colors and
  map them by series name. A series color is not a slide background request.
  When unspecified, choose a restrained palette with distinguishable series.
- **Charts carry the data, text carries the message:** follow the requested
  layout (full width, side by side, chart plus takeaway, dashboard). Use readable
  spacing and label the source; no mandatory single layout for every chart.
- **Real data only.** Never invent statistics for decoration.
- **Speaker notes on every slide** — what to SAY, not what is written.
- **Section dividers** (dark background, big title) to chunk long decks.
- Chart type: honor the requested type, orientation and stacking. When omitted,
  time series usually use lines and comparisons use bars/columns. Pie/doughnut
  requires nonnegative parts of a whole. Do not truncate source categories to
  fit a template; resize, divide charts, or clarify an impossible density.
- Prefer native editable charts with their embedded workbook, not screenshots.
  Reopen the result to check chart types, series, values, colors and placement;
  then render for overlap, clipping, contrast, and readable labels.

## Common pitfalls
- `shape.text = ...` nukes run formatting — edit runs instead.
- Placeholders differ per layout: check `placeholder_format.idx` before use.
- Charts inserted by python-pptx need `chart_data`; to EDIT an existing chart's
  values, replace via `chart.replace_data(new_chart_data)`.
- The slide-id list lives in `ppt/presentation.xml` — python-pptx keeps it in
  sync; if you patch XML manually, update `p:sldIdLst`, the slide's
  `[Content_Types].xml` override and its `_rels` entry together.
- Images live in `ppt/media/`; reuse relationship ids when swapping.


## New decks and explicitly requested redesign
- Start with the audience, one message per slide, a consistent grid and intentional
  whitespace. Use precise coordinates in the actual slide dimensions.
- Prefer portable fonts. Aim for 30–44 pt titles, 16–24 pt body, and at least 9 pt
  captions; avoid shrinking all text to make an overloaded slide fit.
- Measure or render long text. Enlarge the box, reflow the layout or split content
  while respecting an exact requested slide count. Never silently omit content.
- Keep text, shapes, tables and charts editable; preserve chart data and notes.
- Reopen the saved PPTX. The static design audit can report slide/shape identifiers
  for invisible text, invalid geometry or tiny fonts. Fix those objects and run
  the check again before delivering; a task-content check cannot waive this gate.
- When a renderer is available, inspect the actual exported slides, including the
  last slide. Fix clipped text, accidental overlaps and poor contrast. Record
  which slides were checked. A static pass or a partial render is not proof that
  every slide was visually inspected; state unperformed checks accurately.
- For uploaded decks, the surgical preservation rules above still apply. A local
  text correction does not authorize a global redesign.
