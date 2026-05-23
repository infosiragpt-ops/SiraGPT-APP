/**
 * plan-generator — natural-language brief → professional DXF floor plan.
 *
 * Two-stage pipeline:
 *   1. LLM emits a strict JSON describing the plan (rooms, walls, doors,
 *      windows, fixtures, grid, dimensions). Never raw DXF — that path
 *      is too fragile.
 *   2. Deterministic DXF writer converts the JSON to a CAD drawing
 *      with professional conventions:
 *        · Double-line walls + SOLID HATCH fill (looks like a real
 *          published plan, not a wireframe).
 *        · Dimensions drawn geometrically (extension lines, 3 mm tick
 *          marks, text) — we do NOT rely on DIMENSION entities because
 *          their rendering varies between AutoCAD/LibreCAD/Revit.
 *        · Structural grid with lettered/numbered bubbles (A, B, C /
 *          1, 2, 3) — the "skeleton" every architect expects.
 *        · Title block anchored bottom-right with project metadata.
 *        · Standard ISO arrow and 5 m scale bar.
 *        · Per-room stamp: NAME + area m² in a thin bubble.
 *
 * Output is AutoCAD R2013 (AC1021) compatible — opens cleanly in
 * AutoCAD, BricsCAD, LibreCAD, QCAD, DraftSight, Revit (via DWG
 * linking), and Vectorworks.
 *
 * Layer map (US AIA CAD standard):
 *   A-GRID        — structural grid lines (dashed, grey)
 *   A-GRID-IDEN   — grid bubbles and letters
 *   A-WALL        — exterior walls (outline)
 *   A-WALL-FULL   — exterior walls solid fill
 *   A-WALL-PART   — interior partitions (outline)
 *   A-WALL-PFULL  — interior partitions solid fill
 *   A-DOOR        — door leaves + swing arcs + jambs
 *   A-GLAZ        — windows / glazing
 *   A-FURN        — furniture & fixtures (FF&E)
 *   A-SANR        — sanitary fixtures (toilets, sinks, etc.)
 *   A-FLOR        — stair / slab linework
 *   A-ANNO-DIMS   — dimensions
 *   A-ANNO-TEXT   — room names + areas
 *   A-ANNO-IDEN   — title block, north, scale bar
 */

const OpenAI = require('openai');
const {
  DxfWriter, point3d, point2d,
  HatchPolylineBoundary, HatchBoundaryPaths, HatchPredefinedPatterns,
  pattern,
} = require('@tarikjabiri/dxf');

// ─── Provider routing ────────────────────────────────────────────────────

function clientForModel(modelName) {
  if (!modelName) {
    return { provider: 'OpenAI', client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) };
  }
  const m = String(modelName);
  if (/^deepseek-(v\d|chat|reasoner)/i.test(m.trim())) {
    return {
      provider: 'DeepSeek',
      client: new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com',
      }),
    };
  }
  if (/^(anthropic|x-ai|openrouter|meta-llama|deepseek|mistralai|qwen|z-ai|google|moonshotai)\//i.test(m)
      || m.includes('/gpt-oss')) {
    return {
      provider: 'OpenRouter',
      client: new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    };
  }
  if (m.includes('gemini')) {
    return {
      provider: 'Gemini',
      client: new OpenAI({
        apiKey: process.env.GEMINI_API_KEY,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      }),
    };
  }
  return { provider: 'OpenAI', client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) };
}

// ─── System prompt — stricter, with an embedded example ──────────────────

const SYSTEM_PROMPT = `You are a senior residential architect. Produce a floor plan as STRICT JSON.

All units are MILLIMETRES. Origin (0,0) at lower-left of the site. +X east, +Y north.
Round all coordinates to 50 mm. Realistic residential ranges:
  · Exterior wall thickness 200-250 mm
  · Interior partition thickness 100-150 mm
  · Standard door 800-900 mm, bathroom door 700-800 mm
  · Standard room width ≥ 2700 mm, bedroom ≥ 3000 mm, master ≥ 3500 mm
  · Ceiling height 2500-2700 (informational, not drawn)

Schema (all fields required unless marked optional):
{
  "project": { "name": string, "client": string, "location": string },
  "title": string,                   // e.g. "PLANTA BAJA"
  "scale": "1:50" | "1:75" | "1:100",
  "site": { "w": number, "h": number },  // bbox of the building footprint
  "grid": {                          // structural grid — at least 2x2
    "x": [number, ...],              // x positions of vertical grid lines
    "y": [number, ...],              // y positions of horizontal grid lines
    "labels_x": [string, ...],       // letters A, B, C... same length as x
    "labels_y": [string, ...]        // numbers 1, 2, 3... same length as y
  },
  "walls": [
    { "kind": "exterior"|"interior", "thickness": number, "path": [[x,y], ...] }
  ],
  "rooms": [
    { "name": string, "polygon": [[x,y], ...] }   // must close back to first point
  ],
  "doors": [
    { "position": [x,y], "width": number, "rotation_deg": number, "swing": "left"|"right", "type": "interior"|"entry"|"sliding" }
  ],
  "windows": [
    { "start": [x,y], "end": [x,y], "sill_height": number }
  ],
  "fixtures": [    // sanitary + kitchen only
    { "kind": "toilet"|"sink"|"shower"|"bathtub"|"stove"|"fridge"|"kitchen_sink", "position": [x,y], "size": [w,h], "rotation_deg": number }
  ],
  "furniture": [   // optional FF&E, keep sparse
    { "kind": "bed_single"|"bed_double"|"sofa"|"table"|"desk"|"wardrobe", "position": [x,y], "size": [w,h], "rotation_deg": number }
  ],
  "dimensions": [  // 4-10 critical dims. from/to must align horizontally OR vertically.
    { "from": [x,y], "to": [x,y], "side": "top"|"bottom"|"left"|"right", "offset": number }
  ]
}

Hard rules:
- Walls MUST form a closed exterior polygon. Do not leave gaps.
- Rooms MUST NOT overlap. Each room's polygon aligns with wall inside faces.
- Doors/windows sit ON a wall centre-line segment.
- Keep the grid aligned with the main structural axes (column centres or main walls).
- Dimension "from" and "to" must share X or Y (orthogonal only). "offset" = mm from the measured line to the dim line (typical 600-1200).
- Include at minimum: overall exterior width and height dimensions, plus one interior bay per floor side.
- Output VALID JSON only. No prose, no code fences, no comments.

Concrete example of an acceptable start (3 br × 2 ba, 108 m²):
{"project":{"name":"Casa Luna","client":"Privado","location":"Santa Cruz"},
 "title":"PLANTA BAJA","scale":"1:75",
 "site":{"w":12000,"h":9000},
 "grid":{"x":[0,6000,12000],"y":[0,4500,9000],"labels_x":["A","B","C"],"labels_y":["1","2","3"]},
 "walls":[{"kind":"exterior","thickness":250,"path":[[125,125],[11875,125],[11875,8875],[125,8875],[125,125]]},
          {"kind":"interior","thickness":150,"path":[[6000,125],[6000,4500]]},
          {"kind":"interior","thickness":150,"path":[[125,4500],[11875,4500]]}],
 "rooms":[{"name":"Sala","polygon":[[250,250],[5925,250],[5925,4425],[250,4425],[250,250]]},
          {"name":"Cocina","polygon":[[6075,250],[11750,250],[11750,4425],[6075,4425],[6075,250]]},
          {"name":"Dormitorio 1","polygon":[[250,4575],[5925,4575],[5925,8750],[250,8750],[250,4575]]},
          {"name":"Dormitorio 2","polygon":[[6075,4575],[11750,4575],[11750,8750],[6075,8750],[6075,4575]]}],
 "doors":[{"position":[1500,125],"width":900,"rotation_deg":90,"swing":"right","type":"entry"},
          {"position":[3000,4500],"width":800,"rotation_deg":90,"swing":"right","type":"interior"},
          {"position":[9000,4500],"width":800,"rotation_deg":90,"swing":"right","type":"interior"}],
 "windows":[{"start":[2000,8875],"end":[4000,8875],"sill_height":900},
            {"start":[8000,8875],"end":[10000,8875],"sill_height":900}],
 "fixtures":[{"kind":"kitchen_sink","position":[7000,3800],"size":[800,500],"rotation_deg":0},
             {"kind":"stove","position":[8000,3800],"size":[700,600],"rotation_deg":0}],
 "furniture":[{"kind":"bed_double","position":[500,6500],"size":[2000,1600],"rotation_deg":0}],
 "dimensions":[{"from":[125,125],"to":[11875,125],"side":"bottom","offset":900},
               {"from":[125,125],"to":[125,8875],"side":"left","offset":900},
               {"from":[125,125],"to":[6000,125],"side":"bottom","offset":300},
               {"from":[6000,125],"to":[11875,125],"side":"bottom","offset":300}]}

Now generate a similar-quality plan for the user's brief.`;

// ─── Geometry helpers ────────────────────────────────────────────────────

function rotate(p, c, deg) {
  const r = (deg * Math.PI) / 180;
  const dx = p[0] - c[0], dy = p[1] - c[1];
  return [c[0] + dx * Math.cos(r) - dy * Math.sin(r),
          c[1] + dx * Math.sin(r) + dy * Math.cos(r)];
}

function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[i + 1];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function polygonCentroid(poly) {
  let cx = 0, cy = 0, a = 0;
  const n = poly.length - 1; // assume closed, skip dup last
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  a *= 3;
  if (a === 0) return poly[0];
  return [cx / a, cy / a];
}

function offsetPolyline(path, thickness) {
  // ±t/2 perpendicular offsets. Good enough for orthogonal residential
  // walls; acute angles will gap but that's out of scope for houses.
  const t = thickness / 2;
  const left = [], right = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[i];
    const c = path[Math.min(path.length - 1, i + 1)];
    let nx = 0, ny = 0;
    const segs = [];
    if (i > 0) segs.push([a, b]);
    if (i < path.length - 1) segs.push([b, c]);
    for (const [p, q] of segs) {
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      nx += -dy / len;
      ny += dx / len;
    }
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    left.push([b[0] + nx * t, b[1] + ny * t]);
    right.push([b[0] - nx * t, b[1] - ny * t]);
  }
  return { left, right };
}

// ─── Validator / sanitiser ───────────────────────────────────────────────
//
// LLMs often return 90%-correct plans with small structural issues —
// unclosed polygons, rooms slightly outside walls, doors off-centre.
// This pass fixes what it can and drops what it can't.

function sanitizePlan(raw) {
  const p = { ...raw };
  p.project = p.project || { name: 'Plano', client: '', location: '' };
  p.title = p.title || 'PLANTA';
  p.scale = p.scale || '1:100';
  p.site = p.site || { w: 10000, h: 8000 };
  p.grid = p.grid || { x: [0, p.site.w], y: [0, p.site.h], labels_x: ['A', 'B'], labels_y: ['1', '2'] };
  const round = (v) => Math.round(v / 10) * 10;
  const closePoly = (poly) => {
    if (!Array.isArray(poly) || poly.length < 3) return null;
    const first = poly[0], last = poly[poly.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) return [...poly, first];
    return poly;
  };
  const roundPair = ([x, y]) => [round(x), round(y)];

  p.walls = (p.walls || []).map(w => ({
    kind: w.kind === 'exterior' ? 'exterior' : 'interior',
    thickness: w.thickness || (w.kind === 'exterior' ? 250 : 150),
    path: (w.path || []).map(roundPair),
  })).filter(w => w.path.length >= 2);

  p.rooms = (p.rooms || []).map(r => ({
    name: (r.name || 'Ambiente').slice(0, 60),
    polygon: closePoly((r.polygon || []).map(roundPair)),
  })).filter(r => r.polygon);

  p.doors = (p.doors || []).map(d => ({
    position: roundPair(d.position || [0, 0]),
    width: d.width || 800,
    rotation_deg: d.rotation_deg || 0,
    swing: d.swing === 'left' ? 'left' : 'right',
    type: d.type || 'interior',
  }));

  p.windows = (p.windows || []).map(w => ({
    start: roundPair(w.start || [0, 0]),
    end: roundPair(w.end || [0, 0]),
    sill_height: w.sill_height || 900,
  }));

  p.fixtures = (p.fixtures || []).map(f => ({
    kind: f.kind || 'sink',
    position: roundPair(f.position || [0, 0]),
    size: [round((f.size || [500, 500])[0]), round((f.size || [500, 500])[1])],
    rotation_deg: f.rotation_deg || 0,
  }));

  p.furniture = (p.furniture || []).map(f => ({
    kind: f.kind || 'table',
    position: roundPair(f.position || [0, 0]),
    size: [round((f.size || [1000, 500])[0]), round((f.size || [1000, 500])[1])],
    rotation_deg: f.rotation_deg || 0,
  }));

  p.dimensions = (p.dimensions || []).map(d => ({
    from: roundPair(d.from || [0, 0]),
    to: roundPair(d.to || [0, 0]),
    side: d.side || 'bottom',
    offset: d.offset || 800,
  }));

  return p;
}

// ─── DXF drawing primitives ──────────────────────────────────────────────

function addSolidHatch(writer, poly, layerName) {
  try {
    const boundary = new HatchPolylineBoundary();
    poly.forEach(([x, y]) => boundary.add({ x, y }));
    const paths = new HatchBoundaryPaths();
    paths.addPolylineBoundary(boundary);
    // Predefined SOLID pattern — fills the region.
    const pat = pattern({ name: HatchPredefinedPatterns.SOLID });
    writer.addHatch(paths, pat, { layerName });
  } catch (err) {
    // Hatching fails silently for complex/self-intersecting paths; the
    // double-line walls still render, we just lose the solid fill on
    // that segment. Acceptable degradation.
  }
}

function drawWall(writer, wall) {
  const isExt = wall.kind === 'exterior';
  const outlineLayer = isExt ? 'A-WALL' : 'A-WALL-PART';
  const fillLayer = isExt ? 'A-WALL-FULL' : 'A-WALL-PFULL';
  const { left, right } = offsetPolyline(wall.path, wall.thickness);

  // Draw the solid fill first (under the outline).
  const fillPoly = [...left, ...right.slice().reverse(), left[0]];
  addSolidHatch(writer, fillPoly, fillLayer);

  // Outline both edges as polylines.
  writer.addLWPolyline(left.map(([x, y]) => ({ point: point2d(x, y) })), { layerName: outlineLayer });
  writer.addLWPolyline(right.map(([x, y]) => ({ point: point2d(x, y) })), { layerName: outlineLayer });
  // End caps.
  writer.addLine(point3d(left[0][0], left[0][1], 0), point3d(right[0][0], right[0][1], 0), { layerName: outlineLayer });
  const n = left.length - 1;
  writer.addLine(point3d(left[n][0], left[n][1], 0), point3d(right[n][0], right[n][1], 0), { layerName: outlineLayer });
}

function drawDoor(writer, door) {
  const { position: [x, y], width: w, rotation_deg: rot = 0, swing = 'right' } = door;
  const leafEnd = rotate([x + w, y], [x, y], rot);
  // Jamb ticks (short perpendicular strokes at pivot and closed-side).
  const perpAt = (pt, deg) => {
    const t = 60;
    const p1 = rotate([pt[0], pt[1] + t], pt, deg);
    const p2 = rotate([pt[0], pt[1] - t], pt, deg);
    writer.addLine(point3d(p1[0], p1[1], 0), point3d(p2[0], p2[1], 0), { layerName: 'A-DOOR' });
  };
  perpAt([x, y], rot);
  perpAt(leafEnd, rot);
  // Leaf — solid line from pivot rotated 90° into the room (the "open" position).
  const openAngle = swing === 'right' ? rot + 90 : rot - 90;
  const leafOpen = rotate([x + w, y], [x, y], openAngle);
  writer.addLine(point3d(x, y, 0), point3d(leafOpen[0], leafOpen[1], 0), { layerName: 'A-DOOR' });
  // Swing arc (from closed to open).
  const a0 = Math.min(rot, openAngle);
  const a1 = Math.max(rot, openAngle);
  writer.addArc(point3d(x, y, 0), w, a0, a1, { layerName: 'A-DOOR' });
}

function drawWindow(writer, win) {
  const [x1, y1] = win.start;
  const [x2, y2] = win.end;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const off = 90;
  // Three parallel lines: two glass faces + centre mullion.
  for (const k of [-1, 0, 1]) {
    writer.addLine(
      point3d(x1 + nx * off * k, y1 + ny * off * k, 0),
      point3d(x2 + nx * off * k, y2 + ny * off * k, 0),
      { layerName: 'A-GLAZ' },
    );
  }
  // End caps.
  writer.addLine(point3d(x1 + nx * off, y1 + ny * off, 0), point3d(x1 - nx * off, y1 - ny * off, 0), { layerName: 'A-GLAZ' });
  writer.addLine(point3d(x2 + nx * off, y2 + ny * off, 0), point3d(x2 - nx * off, y2 - ny * off, 0), { layerName: 'A-GLAZ' });
}

function drawRoomStamp(writer, room) {
  const area = polygonArea(room.polygon) / 1_000_000; // m²
  const [cx, cy] = polygonCentroid(room.polygon);
  // Name on top (uppercase, 300mm at 1:100 ≈ 3mm on paper).
  writer.addText(
    point3d(cx, cy + 180, 0),
    300,
    room.name.toUpperCase(),
    { layerName: 'A-ANNO-TEXT' },
  );
  writer.addText(
    point3d(cx, cy - 280, 0),
    220,
    `${area.toFixed(2)} m²`,
    { layerName: 'A-ANNO-TEXT' },
  );
}

function drawFixture(writer, f) {
  const [x, y] = f.position;
  const [w, h] = f.size;
  const rot = f.rotation_deg || 0;
  const layer = ['toilet', 'sink', 'shower', 'bathtub', 'kitchen_sink'].includes(f.kind)
    ? 'A-SANR' : 'A-FURN';
  const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]
    .map(p => rotate(p, [x, y], rot));
  writer.addLWPolyline(corners.map(([px, py]) => ({ point: point2d(px, py) })), { layerName: layer });

  const cx = x + w / 2, cy = y + h / 2;
  const cxr = rotate([cx, cy], [x, y], rot);

  if (f.kind === 'toilet') {
    // Oval bowl + rectangular tank at the back.
    writer.addEllipse?.(
      point3d(cxr[0], cxr[1] - h * 0.15, 0),
      point3d(w * 0.4, 0, 0),
      h * 0.5 / (w * 0.4),
      0, 2 * Math.PI,
      { layerName: layer },
    );
    writer.addCircle(point3d(cxr[0], cxr[1] - h * 0.15, 0), Math.min(w, h) * 0.35, { layerName: layer });
  } else if (f.kind === 'sink' || f.kind === 'kitchen_sink') {
    // Inner bowl rectangle.
    const inset = Math.min(w, h) * 0.12;
    const inner = [[x + inset, y + inset], [x + w - inset, y + inset], [x + w - inset, y + h - inset], [x + inset, y + h - inset], [x + inset, y + inset]]
      .map(p => rotate(p, [x, y], rot));
    writer.addLWPolyline(inner.map(([px, py]) => ({ point: point2d(px, py) })), { layerName: layer });
    // Tap circle.
    writer.addCircle(point3d(cxr[0], cxr[1] + h * 0.35, 0), 40, { layerName: layer });
  } else if (f.kind === 'shower') {
    // Diagonal cross to indicate drain + water.
    const p1 = rotate([x, y], [x, y], rot);
    const p2 = rotate([x + w, y + h], [x, y], rot);
    const p3 = rotate([x + w, y], [x, y], rot);
    const p4 = rotate([x, y + h], [x, y], rot);
    writer.addLine(point3d(p1[0], p1[1], 0), point3d(p2[0], p2[1], 0), { layerName: layer });
    writer.addLine(point3d(p3[0], p3[1], 0), point3d(p4[0], p4[1], 0), { layerName: layer });
    writer.addCircle(point3d(cxr[0], cxr[1], 0), 60, { layerName: layer });
  } else if (f.kind === 'bathtub') {
    const inset = Math.min(w, h) * 0.1;
    const inner = [[x + inset, y + inset], [x + w - inset, y + inset], [x + w - inset, y + h - inset], [x + inset, y + h - inset], [x + inset, y + inset]]
      .map(p => rotate(p, [x, y], rot));
    writer.addLWPolyline(inner.map(([px, py]) => ({ point: point2d(px, py) })), { layerName: layer });
  } else if (f.kind === 'stove') {
    // Four burner circles.
    for (let i = 0; i < 4; i++) {
      const bx = x + w * (0.28 + 0.44 * (i % 2));
      const by = y + h * (0.28 + 0.44 * Math.floor(i / 2));
      const rp = rotate([bx, by], [x, y], rot);
      writer.addCircle(point3d(rp[0], rp[1], 0), Math.min(w, h) * 0.1, { layerName: layer });
    }
  } else if (f.kind === 'fridge') {
    // Door divider line.
    const mx = x + w * 0.1;
    const p1 = rotate([mx, y], [x, y], rot);
    const p2 = rotate([mx, y + h], [x, y], rot);
    writer.addLine(point3d(p1[0], p1[1], 0), point3d(p2[0], p2[1], 0), { layerName: layer });
  }
}

function drawFurniturePiece(writer, f) {
  const [x, y] = f.position;
  const [w, h] = f.size;
  const rot = f.rotation_deg || 0;
  const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]
    .map(p => rotate(p, [x, y], rot));
  writer.addLWPolyline(corners.map(([px, py]) => ({ point: point2d(px, py) })), { layerName: 'A-FURN' });

  if (f.kind === 'bed_single' || f.kind === 'bed_double') {
    // Pillow line at top-long edge.
    const pillowY = y + h * 0.82;
    const p1 = rotate([x + w * 0.1, pillowY], [x, y], rot);
    const p2 = rotate([x + w * 0.9, pillowY], [x, y], rot);
    writer.addLine(point3d(p1[0], p1[1], 0), point3d(p2[0], p2[1], 0), { layerName: 'A-FURN' });
    // Pillows — two rects along the top.
    if (f.kind === 'bed_double') {
      const pw = w * 0.35, ph = h * 0.15;
      for (const px of [x + w * 0.1, x + w * 0.55]) {
        const pts = [[px, pillowY + 20], [px + pw, pillowY + 20], [px + pw, pillowY + 20 + ph], [px, pillowY + 20 + ph], [px, pillowY + 20]]
          .map(p => rotate(p, [x, y], rot));
        writer.addLWPolyline(pts.map(([qx, qy]) => ({ point: point2d(qx, qy) })), { layerName: 'A-FURN' });
      }
    }
  } else if (f.kind === 'sofa') {
    // Back-rest strip.
    const pts = [[x, y + h * 0.75], [x + w, y + h * 0.75]]
      .map(p => rotate(p, [x, y], rot));
    writer.addLine(point3d(pts[0][0], pts[0][1], 0), point3d(pts[1][0], pts[1][1], 0), { layerName: 'A-FURN' });
  }
}

function drawGrid(writer, plan) {
  const { grid, site } = plan;
  const pad = 1500;
  const bubbleR = 350;
  // Vertical grid lines (labelled A, B, C...) running full height.
  grid.x.forEach((gx, i) => {
    writer.addLine(point3d(gx, -pad, 0), point3d(gx, site.h + pad, 0), { layerName: 'A-GRID' });
    writer.addCircle(point3d(gx, site.h + pad + bubbleR, 0), bubbleR, { layerName: 'A-GRID-IDEN' });
    writer.addCircle(point3d(gx, -pad - bubbleR, 0), bubbleR, { layerName: 'A-GRID-IDEN' });
    const label = (grid.labels_x && grid.labels_x[i]) || String.fromCharCode(65 + i);
    writer.addText(point3d(gx - 100, site.h + pad + bubbleR - 140, 0), 280, label, { layerName: 'A-GRID-IDEN' });
    writer.addText(point3d(gx - 100, -pad - bubbleR - 140, 0), 280, label, { layerName: 'A-GRID-IDEN' });
  });
  // Horizontal grid lines (1, 2, 3...).
  grid.y.forEach((gy, i) => {
    writer.addLine(point3d(-pad, gy, 0), point3d(site.w + pad, gy, 0), { layerName: 'A-GRID' });
    writer.addCircle(point3d(site.w + pad + bubbleR, gy, 0), bubbleR, { layerName: 'A-GRID-IDEN' });
    writer.addCircle(point3d(-pad - bubbleR, gy, 0), bubbleR, { layerName: 'A-GRID-IDEN' });
    const label = (grid.labels_y && grid.labels_y[i]) || String(i + 1);
    writer.addText(point3d(site.w + pad + bubbleR - 100, gy - 120, 0), 280, label, { layerName: 'A-GRID-IDEN' });
    writer.addText(point3d(-pad - bubbleR - 100, gy - 120, 0), 280, label, { layerName: 'A-GRID-IDEN' });
  });
}

function drawDimension(writer, d) {
  // Only horizontal/vertical dims supported. LLM is instructed to
  // produce orthogonal ones; if it slips, we project to the dominant axis.
  const [x1, y1] = d.from;
  const [x2, y2] = d.to;
  const side = d.side;
  const off = d.offset || 800;
  const tick = 150;
  const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
  let dx1, dy1, dx2, dy2, tx, ty, rot = 0;

  if (horizontal) {
    const sign = (side === 'top') ? 1 : -1;
    const dimY = (side === 'top' ? Math.max(y1, y2) : Math.min(y1, y2)) + sign * off;
    // Extension lines from measured point to the dim line.
    writer.addLine(point3d(x1, y1 + sign * 80, 0), point3d(x1, dimY + sign * 80, 0), { layerName: 'A-ANNO-DIMS' });
    writer.addLine(point3d(x2, y2 + sign * 80, 0), point3d(x2, dimY + sign * 80, 0), { layerName: 'A-ANNO-DIMS' });
    // Dim line.
    writer.addLine(point3d(x1, dimY, 0), point3d(x2, dimY, 0), { layerName: 'A-ANNO-DIMS' });
    // Tick marks — 45° short strokes at each end.
    const t = tick;
    writer.addLine(point3d(x1 - t, dimY - t, 0), point3d(x1 + t, dimY + t, 0), { layerName: 'A-ANNO-DIMS' });
    writer.addLine(point3d(x2 - t, dimY - t, 0), point3d(x2 + t, dimY + t, 0), { layerName: 'A-ANNO-DIMS' });
    // Text centred above the line.
    tx = (x1 + x2) / 2;
    ty = dimY + 120;
  } else {
    const sign = (side === 'right') ? 1 : -1;
    const dimX = (side === 'right' ? Math.max(x1, x2) : Math.min(x1, x2)) + sign * off;
    writer.addLine(point3d(x1 + sign * 80, y1, 0), point3d(dimX + sign * 80, y1, 0), { layerName: 'A-ANNO-DIMS' });
    writer.addLine(point3d(x2 + sign * 80, y2, 0), point3d(dimX + sign * 80, y2, 0), { layerName: 'A-ANNO-DIMS' });
    writer.addLine(point3d(dimX, y1, 0), point3d(dimX, y2, 0), { layerName: 'A-ANNO-DIMS' });
    const t = tick;
    writer.addLine(point3d(dimX - t, y1 - t, 0), point3d(dimX + t, y1 + t, 0), { layerName: 'A-ANNO-DIMS' });
    writer.addLine(point3d(dimX - t, y2 - t, 0), point3d(dimX + t, y2 + t, 0), { layerName: 'A-ANNO-DIMS' });
    tx = dimX + 120;
    ty = (y1 + y2) / 2;
    rot = 90;
  }
  const value = Math.round(Math.hypot(x2 - x1, y2 - y1));
  writer.addText(
    point3d(tx - (horizontal ? 0 : 0), ty, 0),
    220,
    `${value}`,
    { layerName: 'A-ANNO-DIMS', rotation: rot },
  );
}

function drawNorthArrow(writer, site, angleDeg = 0) {
  const x = site.w + 2200;
  const y = site.h - 1500;
  const r = 700;
  writer.addCircle(point3d(x, y, 0), r, { layerName: 'A-ANNO-IDEN' });
  writer.addCircle(point3d(x, y, 0), r * 0.92, { layerName: 'A-ANNO-IDEN' });
  const tip = rotate([x, y + r - 120], [x, y], -angleDeg);
  const base1 = rotate([x - r * 0.25, y - r * 0.2], [x, y], -angleDeg);
  const base2 = rotate([x + r * 0.25, y - r * 0.2], [x, y], -angleDeg);
  // Solid north pointer + open south pointer for ISO style.
  writer.addLWPolyline(
    [tip, base1, [x, y], tip].map(([px, py]) => ({ point: point2d(px, py) })),
    { layerName: 'A-ANNO-IDEN' },
  );
  writer.addLWPolyline(
    [tip, base2, [x, y], tip].map(([px, py]) => ({ point: point2d(px, py) })),
    { layerName: 'A-ANNO-IDEN' },
  );
  // "N" label at top.
  const lx = rotate([x, y + r + 500], [x, y], -angleDeg);
  writer.addText(point3d(lx[0] - 140, lx[1] - 140, 0), 380, 'N', { layerName: 'A-ANNO-IDEN' });
}

function drawScaleBar(writer, site) {
  const x = -2000;
  const y = -3500;
  const totalM = 5;
  const segM = 1;
  const mm = 1000;
  for (let i = 0; i < totalM / segM; i++) {
    const x0 = x + i * segM * mm;
    const x1 = x0 + segM * mm;
    const pts = [[x0, y], [x1, y], [x1, y + 200], [x0, y + 200], [x0, y]];
    writer.addLWPolyline(pts.map(([px, py]) => ({ point: point2d(px, py) })), { layerName: 'A-ANNO-IDEN' });
    if (i % 2 === 0) addSolidHatch(writer, pts, 'A-ANNO-IDEN');
  }
  for (let i = 0; i <= totalM; i++) {
    writer.addText(point3d(x + i * mm - 100, y + 280, 0), 200, String(i), { layerName: 'A-ANNO-IDEN' });
  }
  writer.addText(point3d(x, y - 400, 0), 220, 'ESCALA GRÁFICA (m)', { layerName: 'A-ANNO-IDEN' });
}

function drawTitleBlock(writer, plan) {
  const { site, project, title, scale } = plan;
  // Bottom-right of the site; ~ A4 aspect-ratio block.
  const w = 6000, h = 3000;
  const x0 = site.w - w, y0 = -h - 2500;
  const box = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]];
  writer.addLWPolyline(box.map(([x, y]) => ({ point: point2d(x, y) })), { layerName: 'A-ANNO-IDEN' });
  // Inner divisions: three horizontal bands + one vertical split.
  writer.addLine(point3d(x0, y0 + h * 0.33, 0), point3d(x0 + w, y0 + h * 0.33, 0), { layerName: 'A-ANNO-IDEN' });
  writer.addLine(point3d(x0, y0 + h * 0.66, 0), point3d(x0 + w, y0 + h * 0.66, 0), { layerName: 'A-ANNO-IDEN' });
  writer.addLine(point3d(x0 + w * 0.7, y0, 0), point3d(x0 + w * 0.7, y0 + h, 0), { layerName: 'A-ANNO-IDEN' });

  const line = (x, y, txt, size = 260) =>
    writer.addText(point3d(x, y, 0), size, txt, { layerName: 'A-ANNO-IDEN' });

  // Top band — project name.
  line(x0 + 300, y0 + h * 0.66 + 400, 'PROYECTO', 180);
  line(x0 + 300, y0 + h * 0.66 + 100, (project?.name || 'Sin título').toUpperCase(), 340);
  // Middle band — client + location.
  line(x0 + 300, y0 + h * 0.33 + 400, 'CLIENTE', 180);
  line(x0 + 300, y0 + h * 0.33 + 100, project?.client || '—', 260);
  line(x0 + w * 0.35, y0 + h * 0.33 + 400, 'UBICACIÓN', 180);
  line(x0 + w * 0.35, y0 + h * 0.33 + 100, project?.location || '—', 260);
  // Bottom band — title + scale + date.
  line(x0 + 300, y0 + 400, 'LÁMINA', 180);
  line(x0 + 300, y0 + 100, title.toUpperCase(), 300);
  line(x0 + w * 0.35, y0 + 400, 'ESCALA', 180);
  line(x0 + w * 0.35, y0 + 100, scale, 280);

  // Right column — date + drawn by.
  const today = new Date().toISOString().slice(0, 10);
  line(x0 + w * 0.72, y0 + h * 0.66 + 400, 'FECHA', 180);
  line(x0 + w * 0.72, y0 + h * 0.66 + 100, today, 260);
  line(x0 + w * 0.72, y0 + h * 0.33 + 400, 'DIBUJÓ', 180);
  line(x0 + w * 0.72, y0 + h * 0.33 + 100, 'siraGPT', 260);
  line(x0 + w * 0.72, y0 + 400, 'LÁMINA N°', 180);
  line(x0 + w * 0.72, y0 + 100, 'A-01', 300);
}

// ─── Top-level DXF build ─────────────────────────────────────────────────

// ─── SVG renderer ─────────────────────────────────────────────────────────
//
// Produces an inline-renderable SVG tuned to look like a published
// architectural plan: thin strokes, subtle room fills with legible
// hatching patterns for wet/outdoor areas, dimensioned room stamps,
// north arrow, scale bar, legend. Intended as the primary chat
// artifact (vs. DXF which stays as the pro download).
//
// Coordinate system is millimetres (same as the JSON). We flip Y at
// the SVG boundary so plan-up is geographic north.

function roomStyle(name) {
  const n = String(name || '').toLowerCase();
  if (/(cocin|kitchen)/.test(n)) return { fill: 'url(#patCross)', label: '#0b3a5a' };
  if (/(baño|bano|bath|lavand|laundry|aseo|toilet)/.test(n)) return { fill: 'url(#patCrossLight)', label: '#0b3a5a' };
  if (/(patio|jardí|jardin|garden|terrace|terraza|balcón|balcon)/.test(n)) return { fill: 'url(#patDots)', label: '#14532d' };
  if (/(garaj|garag|cochera|parking)/.test(n)) return { fill: 'url(#patDiag)', label: '#4b5563' };
  return { fill: '#F5EFE3', label: '#1f2937' };
}

function furnitureStyle(kind) {
  const k = String(kind || '').toLowerCase();
  if (/(bed|cama|sof|sofa)/.test(k)) return { fill: '#C7B8F1', stroke: '#6b5ca7' };
  if (/(toilet|inodoro|sink|lavabo|shower|ducha|bathtub|tina|kitchen_sink|fridge|nevera|stove|horno|cocina)/.test(k)) return { fill: '#BEDBF0', stroke: '#3b6a8f' };
  return { fill: '#E7E3D7', stroke: '#8a8576' };
}

function svgEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function offsetPolygonClosed(path, thickness) {
  // Same as offsetPolyline but returns a closed polygon outlining the
  // whole wall thickness — used to draw filled double-line walls as a
  // single SVG path.
  const { left, right } = offsetPolyline(path, thickness);
  return [...left, ...right.slice().reverse()];
}

function pathD(pts) {
  if (!pts.length) return '';
  return 'M' + pts.map(([x, y], i) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L') + ' Z';
}

function planToSvg(rawPlan) {
  const plan = sanitizePlan(rawPlan);
  const { site } = plan;

  // Padding around the drawing for labels + scale bar + north arrow.
  const padX = 1200;
  const padTop = 800;
  const padBottom = 2200;   // scale bar + legend
  const W = site.w + padX * 2;
  const H = site.h + padTop + padBottom;

  // Coordinate helpers: SVG y grows downward, plan y grows upward.
  const X = (x) => (x + padX).toFixed(1);
  const Y = (y) => (site.h - y + padTop).toFixed(1);

  // Build groups as string chunks — fastest to concat, easiest to read.
  const out = [];

  // Walls as filled polygons (exterior = dark grey, interior = medium).
  const wallsExt = [];
  const wallsInt = [];
  for (const wall of plan.walls) {
    const poly = offsetPolygonClosed(wall.path, wall.thickness);
    const pts = poly.map(([x, y]) => [Number(X(x)), Number(Y(y))]);
    const target = wall.kind === 'exterior' ? wallsExt : wallsInt;
    target.push(pathD(pts));
  }

  // Room fills (must render BEFORE walls so walls cover the edges).
  const rooms = [];
  for (const room of plan.rooms) {
    const { fill, label } = roomStyle(room.name);
    const pts = room.polygon.map(([x, y]) => [Number(X(x)), Number(Y(y))]);
    rooms.push(`<path d="${pathD(pts)}" fill="${fill}" stroke="none" />`);
    // Label in centroid
    const area = polygonArea(room.polygon) / 1_000_000;
    const [cx, cy] = polygonCentroid(room.polygon);
    // Room bounding box for dimension string.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [px, py] of room.polygon) {
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    const wMeters = ((maxX - minX) / 1000).toFixed(1);
    const hMeters = ((maxY - minY) / 1000).toFixed(1);
    rooms.push(
      `<g text-anchor="middle" font-family="Inter, system-ui, sans-serif" fill="${label}">` +
      `<text x="${X(cx)}" y="${Y(cy) - 4}" font-size="14" font-weight="600">${svgEscape(room.name)}</text>` +
      `<text x="${X(cx)}" y="${Y(cy) + 14}" font-size="11" opacity="0.7">${wMeters} × ${hMeters} m</text>` +
      `</g>`
    );
  }

  // Furniture / fixtures.
  const furn = [];
  for (const f of [...(plan.fixtures || []), ...(plan.furniture || [])]) {
    const [x, y] = f.position;
    const [w, h] = f.size;
    const rot = f.rotation_deg || 0;
    const style = furnitureStyle(f.kind);
    const cx = Number(X(x + w / 2));
    const cy = Number(Y(y + h / 2));
    furn.push(
      `<g transform="translate(${X(x)} ${Y(y + h)}) rotate(${-rot})">` +
      `<rect x="0" y="0" width="${w.toFixed(1)}" height="${h.toFixed(1)}" ` +
      `rx="3" fill="${style.fill}" stroke="${style.stroke}" stroke-width="0.8" opacity="0.9" />` +
      `</g>`
    );
  }

  // Doors.
  const openings = [];
  for (const d of plan.doors) {
    const { position: [x, y], width: w, rotation_deg: rot = 0, swing = 'right' } = d;
    const openAngle = swing === 'right' ? rot + 90 : rot - 90;
    const [lx, ly] = rotate([x + w, y], [x, y], openAngle);
    // Wall break (white masking rectangle) — omitted; we instead rely on
    // the swing arc being the visual cue.
    openings.push(
      `<g fill="none" stroke="#1f2937" stroke-width="1" stroke-linecap="round">` +
      `<path d="M ${X(x)} ${Y(y)} A ${w.toFixed(1)} ${w.toFixed(1)} 0 0 ${swing === 'right' ? 1 : 0} ${X(lx)} ${Y(ly)}" opacity="0.5" />` +
      `<line x1="${X(x)}" y1="${Y(y)}" x2="${X(lx)}" y2="${Y(ly)}" />` +
      `</g>`
    );
  }

  // Windows — three parallel lines perpendicular to the wall.
  const windows = [];
  for (const win of plan.windows) {
    const [x1, y1] = win.start;
    const [x2, y2] = win.end;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const off = 90;
    for (const k of [-1, 0, 1]) {
      windows.push(
        `<line x1="${X(x1 + nx * off * k)}" y1="${Y(y1 + ny * off * k)}" ` +
        `x2="${X(x2 + nx * off * k)}" y2="${Y(y2 + ny * off * k)}" ` +
        `stroke="#1f2937" stroke-width="${k === 0 ? 0.6 : 0.9}" />`
      );
    }
  }

  // Scale bar bottom-left.
  const scaleY = site.h + padTop + 300;
  const scaleX = padX;
  const totalM = 6, seg = 3, mm = 1000;
  let scaleBar = `<g font-family="Inter, system-ui, sans-serif" font-size="11" fill="#4b5563">`;
  scaleBar += `<line x1="${scaleX}" y1="${scaleY}" x2="${scaleX + totalM * mm}" y2="${scaleY}" stroke="#4b5563" stroke-width="1" />`;
  for (let i = 0; i <= totalM; i += seg) {
    const x = scaleX + i * mm;
    scaleBar += `<line x1="${x}" y1="${scaleY - 6}" x2="${x}" y2="${scaleY + 6}" stroke="#4b5563" stroke-width="1" />`;
    scaleBar += `<text x="${x}" y="${scaleY + 22}" text-anchor="middle">${i === 0 ? '0' : i + ' m'}</text>`;
  }
  scaleBar += `</g>`;

  // North arrow top-right.
  const northX = site.w + padX - 100;
  const northY = padTop + 80;
  const northArrow = `
    <g transform="translate(${northX} ${northY})" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#1f2937">
      <circle r="22" fill="none" stroke="#9ca3af" stroke-width="0.8" />
      <path d="M 0 -18 L -5 6 L 0 2 L 5 6 Z" fill="#1f2937" stroke="none" />
      <text x="0" y="-28" text-anchor="middle" font-weight="600">N</text>
    </g>`;

  // Legend bottom-right.
  const legendY = site.h + padTop + 300;
  const legendX = W - padX - 400;
  const legend = `
    <g font-family="Inter, system-ui, sans-serif" font-size="11" fill="#4b5563" transform="translate(${legendX} ${legendY})">
      <g>
        <path d="M 0 0 A 14 14 0 0 1 14 14" fill="none" stroke="#1f2937" stroke-width="0.8" />
        <line x1="0" y1="0" x2="0" y2="-14" stroke="#1f2937" stroke-width="1" />
        <text x="22" y="8">Puerta</text>
      </g>
      <g transform="translate(100 0)">
        <line x1="0" y1="4" x2="30" y2="4" stroke="#1f2937" stroke-width="1.2" />
        <line x1="0" y1="8" x2="30" y2="8" stroke="#1f2937" stroke-width="0.6" />
        <text x="36" y="12">Ventana</text>
      </g>
      <g transform="translate(200 0)">
        <rect x="0" y="0" width="30" height="14" fill="url(#patCross)" stroke="#6b7280" stroke-width="0.5" />
        <text x="38" y="12">Área húmeda</text>
      </g>
    </g>`;

  // Title at top-centre.
  const title = plan.title || plan.project?.name || 'Planta arquitectónica';
  const areaTotal = plan.rooms.reduce((s, r) => s + polygonArea(r.polygon) / 1_000_000, 0);
  const titleBlock = `
    <g font-family="Inter, system-ui, sans-serif" fill="#1f2937" text-anchor="middle">
      <text x="${W / 2}" y="${padTop / 2}" font-size="15" font-weight="600">${svgEscape(title)} — ${areaTotal.toFixed(1)} m²</text>
    </g>`;

  // Defs: hatching patterns.
  const defs = `
    <defs>
      <pattern id="patDots" width="12" height="12" patternUnits="userSpaceOnUse">
        <rect width="12" height="12" fill="#EFF5E6" />
        <circle cx="6" cy="6" r="1.2" fill="#7fa35b" />
      </pattern>
      <pattern id="patCross" width="10" height="10" patternUnits="userSpaceOnUse">
        <rect width="10" height="10" fill="#DCEAF2" />
        <path d="M 0 10 L 10 0 M -2 2 L 2 -2 M 8 12 L 12 8" stroke="#6b9cbb" stroke-width="0.5" />
        <path d="M 0 0 L 10 10 M -2 8 L 2 12 M 8 -2 L 12 2" stroke="#6b9cbb" stroke-width="0.5" />
      </pattern>
      <pattern id="patCrossLight" width="10" height="10" patternUnits="userSpaceOnUse">
        <rect width="10" height="10" fill="#E9F1F6" />
        <path d="M 0 10 L 10 0" stroke="#93b7ce" stroke-width="0.5" />
        <path d="M 0 0 L 10 10" stroke="#93b7ce" stroke-width="0.5" />
      </pattern>
      <pattern id="patDiag" width="8" height="8" patternUnits="userSpaceOnUse">
        <rect width="8" height="8" fill="#EEEEEE" />
        <path d="M 0 8 L 8 0" stroke="#9ca3af" stroke-width="0.4" />
      </pattern>
    </defs>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="font-family:Inter,system-ui,sans-serif;background:#fafaf7">
${defs}
<rect width="${W}" height="${H}" fill="#fafaf7" />
${titleBlock}
<g>${rooms.join('\n')}</g>
<g fill="#6b6b6b" stroke="none" fill-opacity="0.92">${wallsInt.map(d => `<path d="${d}" />`).join('')}</g>
<g fill="#2f2f2f" stroke="none">${wallsExt.map(d => `<path d="${d}" />`).join('')}</g>
<g>${furn.join('\n')}</g>
<g>${openings.join('\n')}</g>
<g>${windows.join('\n')}</g>
${scaleBar}
${northArrow}
${legend}
</svg>`;
}

function planToDxf(rawPlan) {
  const plan = sanitizePlan(rawPlan);
  const w = new DxfWriter();

  // Layer palette — ACI colours. Fill layers use a mid-grey so walls
  // look printed on paper, not fluorescent.
  w.addLayer('A-GRID', 8, 'Continuous');
  w.addLayer('A-GRID-IDEN', 7, 'Continuous');
  w.addLayer('A-WALL', 7, 'Continuous');
  w.addLayer('A-WALL-FULL', 250, 'Continuous');
  w.addLayer('A-WALL-PART', 8, 'Continuous');
  w.addLayer('A-WALL-PFULL', 252, 'Continuous');
  w.addLayer('A-DOOR', 4, 'Continuous');
  w.addLayer('A-GLAZ', 5, 'Continuous');
  w.addLayer('A-FURN', 9, 'Continuous');
  w.addLayer('A-SANR', 4, 'Continuous');
  w.addLayer('A-FLOR', 7, 'Continuous');
  w.addLayer('A-ANNO-DIMS', 6, 'Continuous');
  w.addLayer('A-ANNO-TEXT', 3, 'Continuous');
  w.addLayer('A-ANNO-IDEN', 1, 'Continuous');

  // Draw order: grid first (bottom), then wall fills, then wall
  // outlines, then openings, then fixtures, then annotations on top.
  drawGrid(w, plan);
  for (const wall of plan.walls) drawWall(w, wall);
  for (const d of plan.doors) drawDoor(w, d);
  for (const win of plan.windows) drawWindow(w, win);
  for (const f of plan.fixtures) drawFixture(w, f);
  for (const f of plan.furniture) drawFurniturePiece(w, f);
  for (const room of plan.rooms) drawRoomStamp(w, room);
  for (const dim of plan.dimensions) drawDimension(w, dim);

  drawNorthArrow(w, plan.site, 0);
  drawScaleBar(w, plan.site);
  drawTitleBlock(w, plan);

  return w.stringify();
}

// ─── LLM wrapper ─────────────────────────────────────────────────────────

// Robust JSON extraction:
//  1. Direct parse
//  2. Strip ```json fences
//  3. Slice from first `{` to last `}` (handles preface/epilogue prose)
//  4. Attempt to close truncated JSON by counting brackets (common when
//     the model hits max_tokens mid-object)
function extractJson(raw) {
  if (!raw) throw new Error('empty response');
  const attempts = [];
  attempts.push(raw);
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  attempts.push(stripped);
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(stripped.slice(first, last + 1));
  // Truncation recovery — close outstanding [ / { up to first parse success.
  if (first >= 0) {
    const slice = stripped.slice(first);
    let depth = 0, bDepth = 0, inStr = false, esc = false, lastGood = -1;
    for (let i = 0; i < slice.length; i++) {
      const ch = slice[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0 && bDepth === 0) lastGood = i; }
      else if (ch === '[') bDepth++;
      else if (ch === ']') bDepth--;
    }
    if (lastGood > 0) attempts.push(slice.slice(0, lastGood + 1));
    // Force-close: append missing ] and } and try.
    if (depth > 0 || bDepth > 0) {
      let patched = slice;
      // Drop trailing comma / partial key.
      patched = patched.replace(/,\s*"[^"]*"?\s*:?\s*$/, '').replace(/,\s*$/, '');
      patched = patched + (']'.repeat(Math.max(0, bDepth))) + ('}'.repeat(Math.max(0, depth)));
      attempts.push(patched);
    }
  }
  let lastErr;
  for (const candidate of attempts) {
    try { return JSON.parse(candidate); }
    catch (e) { lastErr = e; }
  }
  throw new Error(`JSON parse failed after ${attempts.length} attempts: ${lastErr?.message}`);
}

async function generatePlanJson({ brief, model, signal }) {
  const routed = clientForModel(model);
  if (!routed.client) throw new Error(`plan-generator: no API key for "${model}"`);

  const callModel = async (useJsonMode) => {
    const params = {
      model: model || 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: brief },
      ],
      temperature: 0.2,
      max_tokens: 8000,
    };
    // OpenAI + some OpenRouter-hosted models support response_format; Gemini
    // via the OpenAI-compatible shim doesn't. Fall back gracefully.
    if (useJsonMode && routed.provider !== 'Gemini') {
      params.response_format = { type: 'json_object' };
    }
    return routed.client.chat.completions.create(params, { signal });
  };

  let resp;
  try {
    resp = await callModel(true);
  } catch (err) {
    // Provider rejected response_format — retry without it.
    if (/response_format|json_object|invalid.*param/i.test(err?.message || '')) {
      resp = await callModel(false);
    } else {
      throw err;
    }
  }

  const raw = resp.choices?.[0]?.message?.content || '';
  const finishReason = resp.choices?.[0]?.finish_reason;
  try {
    return extractJson(raw);
  } catch (parseErr) {
    // One retry: ask the model again with a shorter, firmer instruction.
    // The most common cause is truncation on a weak/small model.
    console.warn('[plan-generator] first parse failed, retrying. finish_reason=', finishReason);
    const retry = await routed.client.chat.completions.create({
      model: model || 'gpt-4o',
      messages: [
        { role: 'system', content: 'You output ONLY a valid JSON object. No prose, no fences. Keep it compact — every coordinate rounded to 100 mm, max 6 rooms, max 4 dimensions.' },
        { role: 'user', content: `${brief}\n\nReturn a floor-plan JSON with keys: project, title, scale, site, grid, walls, rooms, doors, windows, fixtures, furniture, dimensions. All coordinates in millimetres.` },
      ],
      temperature: 0.15,
      max_tokens: 4000,
    }, { signal });
    const raw2 = retry.choices?.[0]?.message?.content || '';
    return extractJson(raw2);
  }
}

async function generatePlan({ brief, model, signal }) {
  const plan = await generatePlanJson({ brief, model, signal });
  const dxf = planToDxf(plan);
  return { plan: sanitizePlan(plan), dxf };
}

// ─── Streaming variant — emits progress events ────────────────────────────
//
// Yields a sequence of events the HTTP layer can forward to the browser
// as SSE frames. This is what the chat-integrated endpoint consumes so
// the user sees "Analizando brief… · Consultando modelo (2.3k tokens)…
// · Dibujando paredes…" in real time instead of a silent 30-60s wait.
//
// Event shapes:
//   { type: 'stage', label: string, pct: 0..100 }
//   { type: 'tokens', count: number, pct: 0..100 }
//   { type: 'final', plan, dxf }
//   { type: 'error', error: string }
async function* streamPlan({ brief, model, signal }) {
  yield { type: 'stage', label: 'Analizando el brief', pct: 3 };

  const routed = clientForModel(model);
  if (!routed.client) {
    yield { type: 'error', error: `Sin API key para "${model}"` };
    return;
  }

  yield { type: 'stage', label: `Consultando modelo (${routed.provider})`, pct: 10 };

  // LLM streaming call.
  let full = '';
  let tokenCount = 0;
  let finishReason = 'stop';

  const callStream = async (useJsonMode) => {
    const params = {
      model: model || 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: brief },
      ],
      temperature: 0.2,
      max_tokens: 8000,
      stream: true,
    };
    if (useJsonMode && routed.provider !== 'Gemini') {
      params.response_format = { type: 'json_object' };
    }
    return routed.client.chat.completions.create(params, { signal });
  };

  let stream;
  try {
    stream = await callStream(true);
  } catch (err) {
    if (/response_format|json_object|invalid.*param/i.test(err?.message || '')) {
      stream = await callStream(false);
    } else {
      yield { type: 'error', error: err?.message || 'LLM call failed' };
      return;
    }
  }

  try {
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || '';
      if (delta) {
        full += delta;
        tokenCount += delta.length;
        // 10% → 70% as the model emits tokens (approximate).
        const pct = Math.min(70, 10 + Math.floor(tokenCount / 80));
        if (tokenCount % 512 < delta.length) {
          yield { type: 'tokens', count: tokenCount, pct };
        }
      }
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      yield { type: 'error', error: 'aborted' };
      return;
    }
    yield { type: 'error', error: err?.message || 'stream failed' };
    return;
  }

  yield { type: 'stage', label: 'Interpretando la geometría', pct: 75 };

  let plan;
  try {
    plan = extractJson(full);
  } catch (parseErr) {
    yield { type: 'stage', label: 'Reintentando con instrucciones más firmes', pct: 78 };
    try {
      const retry = await routed.client.chat.completions.create({
        model: model || 'gpt-4o',
        messages: [
          { role: 'system', content: 'You output ONLY a valid JSON object. No prose, no fences. Keep it compact — every coordinate rounded to 100 mm, max 6 rooms, max 4 dimensions.' },
          { role: 'user', content: `${brief}\n\nReturn a floor-plan JSON with keys: project, title, scale, site, grid, walls, rooms, doors, windows, fixtures, furniture, dimensions. All coordinates in millimetres.` },
        ],
        temperature: 0.15,
        max_tokens: 4000,
      }, { signal });
      plan = extractJson(retry.choices?.[0]?.message?.content || '');
    } catch (retryErr) {
      yield { type: 'error', error: `El modelo no devolvió JSON válido (finish=${finishReason}). Probá con un modelo más capaz (GPT-4o, Claude) o una descripción más corta.` };
      return;
    }
  }

  yield { type: 'stage', label: 'Dibujando muros, puertas y ventanas', pct: 85 };
  const sanitised = sanitizePlan(plan);

  yield { type: 'stage', label: 'Dibujando plano vectorial', pct: 93 };
  let svg;
  try {
    svg = planToSvg(sanitised);
  } catch (err) {
    yield { type: 'error', error: `Error compilando SVG: ${err?.message}` };
    return;
  }

  yield { type: 'stage', label: 'Exportando archivo DXF', pct: 97 };
  let dxf;
  try {
    dxf = planToDxf(sanitised);
  } catch (err) {
    // DXF failure is non-fatal — SVG is enough for the chat artifact.
    console.warn('[plan-generator] DXF compile warning:', err?.message);
    dxf = null;
  }

  yield { type: 'final', plan: sanitised, svg, dxf };
}

module.exports = { generatePlan, streamPlan, planToDxf, planToSvg, generatePlanJson, sanitizePlan, clientForModel };
