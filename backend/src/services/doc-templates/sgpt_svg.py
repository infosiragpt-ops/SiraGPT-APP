"""sgpt_svg — architectural / urban map SVG builder.

Tailored to the "mapa arquitectónico" use case (e.g. San Marcos Huari):
a clear, printable vector that shows buildings, plazas, streets,
cardinal marker, scale bar, title block, and optional legend zones.

Design goals:
  · Thin strokes (1-2 px at 1000-unit viewport) — reads well printed.
  · Earthy neutral palette (cream bg, warm grey streets, terracotta
    building fills, olive green plazas).
  · Self-contained file — no external fonts / scripts. Any viewer
    renders it.

Usage:
    from sgpt_svg import ArchMap
    m = ArchMap(title="Plaza de Armas · San Marcos Huari",
                width=1400, height=1000, palette="earthy")
    m.street([(100,500),(1300,500)], name="Av. Central", width=24)
    m.building([(200,100),(500,100),(500,450),(200,450)], name="Municipalidad")
    m.plaza([(560,120),(900,120),(900,460),(560,460)], name="Plaza Mayor")
    m.point((700, 290), label="Fuente")
    m.north(x=1320, y=80)
    m.scale_bar(x=100, y=940, total_m=100, seg_m=25, unit="m")
    m.legend(items=[
        ("#c05621", "Edificación"),
        ("#9aaf7a", "Plaza"),
        ("#b8aa8a", "Calle"),
    ])
    svg = m.to_svg()
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(svg)
"""

PALETTES = {
    'earthy': {
        'bg':       '#faf4e8',
        'building': '#c05621',
        'building_stroke': '#7a3514',
        'plaza':    '#b8c49a',
        'plaza_stroke': '#6e7d4f',
        'street':   '#d6cbb0',
        'street_stroke': '#8a7f6a',
        'ink':      '#1a1918',
        'accent':   '#1f3a68',
    },
    'mono': {
        'bg':       '#ffffff',
        'building': '#e5e7eb',
        'building_stroke': '#374151',
        'plaza':    '#f3f4f6',
        'plaza_stroke': '#6b7280',
        'street':   '#fafafa',
        'street_stroke': '#9ca3af',
        'ink':      '#111827',
        'accent':   '#111827',
    },
}


def _escape(s):
    return (str(s)
            .replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            .replace('"', '&quot;'))


class ArchMap:
    def __init__(self, *, title, width=1400, height=1000, palette='earthy'):
        self.title = title
        self.w = width
        self.h = height
        self.pal = PALETTES.get(palette, PALETTES['earthy'])
        self.shapes = []
        self.labels = []
        self.overlays = []

    # ─── Primitives ──────────────────────────────────────────────────────

    def street(self, path, *, name=None, width=20):
        stroke = self.pal['street']
        edge = self.pal['street_stroke']
        d = 'M ' + ' L '.join(f'{x},{y}' for x, y in path)
        # Wide warm-grey base + thin darker edges (double-line effect).
        self.shapes.append(
            f'<path d="{d}" fill="none" stroke="{stroke}" '
            f'stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round" />'
        )
        self.shapes.append(
            f'<path d="{d}" fill="none" stroke="{edge}" '
            f'stroke-width="{width + 2}" stroke-linecap="round" stroke-linejoin="round" opacity="0.22" />'
        )
        if name:
            mid = path[len(path) // 2]
            self._label_at(mid, name, size=11, weight=500, italic=True, color=self.pal['ink'])

    def building(self, points, *, name=None, floors=None):
        d = 'M ' + ' L '.join(f'{x},{y}' for x, y in points) + ' Z'
        self.shapes.append(
            f'<path d="{d}" fill="{self.pal["building"]}" fill-opacity="0.65" '
            f'stroke="{self.pal["building_stroke"]}" stroke-width="1.4" stroke-linejoin="round" />'
        )
        if name:
            cx = sum(p[0] for p in points) / len(points)
            cy = sum(p[1] for p in points) / len(points)
            self._label_at((cx, cy), name, size=12, weight=600, color=self.pal['ink'])
            if floors:
                self._label_at((cx, cy + 14), f'{floors} nivel' + ('es' if floors != 1 else ''),
                               size=10, color=self.pal['ink'], opacity=0.7)

    def plaza(self, points, *, name=None):
        d = 'M ' + ' L '.join(f'{x},{y}' for x, y in points) + ' Z'
        self.shapes.append(
            f'<path d="{d}" fill="{self.pal["plaza"]}" fill-opacity="0.6" '
            f'stroke="{self.pal["plaza_stroke"]}" stroke-width="1.2" stroke-dasharray="4 3" stroke-linejoin="round" />'
        )
        if name:
            cx = sum(p[0] for p in points) / len(points)
            cy = sum(p[1] for p in points) / len(points)
            self._label_at((cx, cy), name, size=13, weight=600, color=self.pal['ink'])

    def water(self, points, *, name=None):
        d = 'M ' + ' L '.join(f'{x},{y}' for x, y in points) + ' Z'
        self.shapes.append(
            f'<path d="{d}" fill="#9fbfd4" fill-opacity="0.6" '
            f'stroke="#5c7b90" stroke-width="1" stroke-linejoin="round" />'
        )
        if name:
            cx = sum(p[0] for p in points) / len(points)
            cy = sum(p[1] for p in points) / len(points)
            self._label_at((cx, cy), name, size=11, italic=True, color='#2c4459')

    def point(self, xy, *, label=None, color=None):
        c = color or self.pal['accent']
        x, y = xy
        self.shapes.append(
            f'<circle cx="{x}" cy="{y}" r="4" fill="{c}" stroke="white" stroke-width="1.5" />'
        )
        if label:
            self._label_at((x + 8, y + 4), label, size=10, color=self.pal['ink'])

    # ─── Cartographic furniture ──────────────────────────────────────────

    def north(self, *, x=None, y=None, size=50):
        if x is None: x = self.w - 80
        if y is None: y = 80
        ink = self.pal['ink']
        # Two-tone arrow, compact, framed by a thin circle.
        self.overlays.append(f'''
<g transform="translate({x} {y})">
  <circle r="{size/2}" fill="none" stroke="{ink}" stroke-width="1" />
  <path d="M 0 {-size/2 + 4} L {-size/4} {size/4 - 2} L 0 {size/8} Z" fill="{ink}" />
  <path d="M 0 {-size/2 + 4} L { size/4} {size/4 - 2} L 0 {size/8} Z" fill="none" stroke="{ink}" stroke-width="1" />
  <text x="0" y="{-size/2 - 8}" text-anchor="middle" font-family="Inter, system-ui" font-size="13" font-weight="700" fill="{ink}">N</text>
</g>''')

    def scale_bar(self, *, x=80, y=None, total_m=100, seg_m=25, unit='m'):
        if y is None: y = self.h - 60
        ink = self.pal['ink']
        # Map metres to px: assume a default pixel-per-meter derived
        # from the map width (heuristic — caller can adjust total_m).
        px_per_m = (self.w - 200) / max(total_m, 1) * 0.25
        parts = [f'<g transform="translate({x} {y})" font-family="Inter, system-ui" font-size="10" fill="{ink}">']
        segs = int(total_m / seg_m)
        for i in range(segs):
            x0 = i * seg_m * px_per_m
            x1 = x0 + seg_m * px_per_m
            fill = ink if i % 2 == 0 else 'white'
            parts.append(
                f'<rect x="{x0}" y="0" width="{x1 - x0}" height="6" '
                f'fill="{fill}" stroke="{ink}" stroke-width="0.8" />'
            )
        for i in range(segs + 1):
            tx = i * seg_m * px_per_m
            parts.append(f'<text x="{tx}" y="20" text-anchor="middle">{int(i * seg_m)}</text>')
        parts.append(f'<text x="{(segs * seg_m * px_per_m) + 10}" y="6" font-weight="600">{unit}</text>')
        parts.append('</g>')
        self.overlays.append('\n'.join(parts))

    def legend(self, *, items, x=None, y=None):
        if x is None: x = 40
        if y is None: y = self.h - 180
        ink = self.pal['ink']
        rows = []
        for i, (color, label) in enumerate(items):
            yy = i * 22
            rows.append(
                f'<rect x="0" y="{yy}" width="18" height="12" fill="{color}" stroke="{ink}" stroke-width="0.6" />'
                f'<text x="26" y="{yy + 10}" font-size="11" font-family="Inter, system-ui" fill="{ink}">{_escape(label)}</text>'
            )
        self.overlays.append(
            f'<g transform="translate({x} {y})">{"".join(rows)}</g>'
        )

    def title_block(self):
        ink = self.pal['ink']
        accent = self.pal['accent']
        return f'''
<g>
  <text x="40" y="40" font-family="Inter, system-ui" font-size="22" font-weight="700" fill="{ink}">{_escape(self.title)}</text>
  <rect x="40" y="52" width="60" height="3" fill="{accent}" />
</g>'''

    # ─── Text helper ─────────────────────────────────────────────────────

    def _label_at(self, xy, text, *, size=11, weight=400, italic=False,
                  color=None, opacity=1.0):
        x, y = xy
        style = f'font-family="Inter, system-ui" font-size="{size}" '
        style += f'font-weight="{weight}" '
        if italic: style += 'font-style="italic" '
        c = color or self.pal['ink']
        self.labels.append(
            f'<text x="{x}" y="{y}" text-anchor="middle" {style}'
            f'fill="{c}" opacity="{opacity}">{_escape(text)}</text>'
        )

    # ─── Render ──────────────────────────────────────────────────────────

    def to_svg(self):
        body = []
        body.append(self.title_block())
        body.extend(self.shapes)
        body.extend(self.labels)
        body.extend(self.overlays)
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" '
            f'width="100%" preserveAspectRatio="xMidYMid meet" '
            f'style="background:{self.pal["bg"]};font-family:Inter,system-ui">'
            + '\n'.join(body)
            + '</svg>'
        )

    def save(self, out_path):
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(self.to_svg())
        return out_path
