# Skill: PPTX editing & professional design

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
layout = next(l for l in prs.slide_layouts if 'Title and Content' in l.name or 'Título y contenido' in l.name)
slide = prs.slides.add_slide(layout)
slide.shapes.title.text = 'Nuevo título'
body = slide.placeholders[1]
tf = body.text_frame
tf.text = 'Primer punto'
p = tf.add_paragraph(); p.text = 'Segundo punto'; p.level = 0
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
- **Restrained palette:** one background, one ink, ONE accent (+1 secondary).
  Use the accent only for emphasis — numbers, key phrases, chart series.
- **Charts carry the data, text carries the message:** chart on the left,
  takeaway card on the right. Label the source under every chart.
- **Real data only.** Never invent statistics for decoration.
- **Speaker notes on every slide** — what to SAY, not what is written.
- **Section dividers** (dark background, big title) to chunk long decks.
- Chart type: time series → line; parts of a whole (sums ≈100%) → doughnut;
  category comparison → bar. Max ~6 categories per chart.

## Common pitfalls
- `shape.text = ...` nukes run formatting — edit runs instead.
- Placeholders differ per layout: check `placeholder_format.idx` before use.
- Charts inserted by python-pptx need `chart_data`; to EDIT an existing chart's
  values, replace via `chart.replace_data(new_chart_data)`.
- The slide-id list lives in `ppt/presentation.xml` — python-pptx keeps it in
  sync; if you patch XML manually, update `p:sldIdLst`, the slide's
  `[Content_Types].xml` override and its `_rels` entry together.
- Images live in `ppt/media/`; reuse relationship ids when swapping.
