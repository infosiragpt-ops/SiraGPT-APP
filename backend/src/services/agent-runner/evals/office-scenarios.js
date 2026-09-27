'use strict';

/**
 * Edición milimétrica — Fase F: the 10 eval scenarios of the SPEC
 * (docs/specs/edicion-milimetrica/SPEC.md §9 F.1) with deterministic
 * graders.
 *
 * A scenario is a real user request on one of the versioned fixtures
 * (backend/tests/fixtures/office). The grader compares the ORIGINAL file with
 * the file the agent delivered, using the same engine the agent uses
 * (sira_office.py): paragraph / run / cell / shape level checks, changed
 * package parts, and — when a renderer is available — the page-level visual
 * diff (only the expected pages change, fast scan on long documents).
 *
 * Graders never trust the agent's own verification: they re-derive every
 * fact from the two files. Run them through gradeOfficeOutput() (a sandbox
 * with python3 + lxml + LibreOffice; the production sandbox image has all
 * of it).
 */

const SCENARIOS = Object.freeze([
  {
    id: 'docx-portada-anio',
    n: 1,
    fixture: 'tesis_demo.docx',
    prompt: 'Cambia 2024 por 2025 en la portada.',
    expectation: 'solo cambia la pág. 1; el run rojo sigue rojo',
  },
  {
    id: 'docx-parafraseo-cita',
    n: 2,
    fixture: 'tesis_demo.docx',
    prompt: 'Parafrasea el párrafo que cita a García (2020) sin tocar la cita.',
    expectation: 'el campo de cita queda intacto; el texto cambia',
  },
  {
    id: 'docx-negrita-fragmento',
    n: 3,
    fixture: 'tesis_demo.docx',
    prompt: 'Pon en negrita solo «baja capacidad portante».',
    expectation: 'solo ese fragmento en negrita',
  },
  {
    id: 'docx-sangria-justificado',
    n: 4,
    fixture: 'tesis_demo.docx',
    prompt: 'En la introducción pon sangría de primera línea de 1,25 cm y texto justificado.',
    expectation: 'w:ind firstLine=709 y jc=both en los párrafos de la introducción',
  },
  {
    id: 'docx-tabla-control-cambios',
    n: 5,
    fixture: 'tesis_demo.docx',
    prompt: 'En la tabla corrige 14,6 por 15,1 con control de cambios.',
    expectation: 'w:del / w:ins con autor SiraGPT',
  },
  {
    id: 'xlsx-cantidad-resaltado',
    n: 6,
    fixture: 'presupuesto_demo.xlsx',
    prompt: 'Sube a 15 los ensayos de compresión no confinada y resalta esa celda.',
    expectation: 'total recalculado 2231; la celda resaltada',
  },
  {
    id: 'xlsx-fila-imprevistos',
    n: 7,
    fixture: 'presupuesto_demo.xlsx',
    prompt: 'Agrega una fila «Imprevistos» con el 5 % del total.',
    expectation: 'fórmula nueva (102,55); sin calcChain',
  },
  {
    id: 'pptx-portada-anio',
    n: 8,
    fixture: 'defensa_demo.pptx',
    prompt: 'Cambia el año de la portada a 2025.',
    expectation: 'solo la lámina 1',
  },
  {
    id: 'pptx-nota-mover-verde',
    n: 9,
    fixture: 'defensa_demo.pptx',
    prompt: 'Mueve la nota 2 mm a la derecha y ponla verde.',
    expectation: 'x +72 000 EMU; relleno verde',
  },
  {
    id: 'docx-larga-subtitulo',
    n: 10,
    fixture: 'tesis_larga_demo.docx',
    prompt: 'En el capítulo 5 cambia el subtítulo «DESARROLLO 5» por «ANÁLISIS DE RESULTADOS».',
    expectation: 'barrido rápido; 1 página cambia',
  },
]);

// Runs inside the sandbox: python3 grader.py <engine.py> <args.json>
const GRADER_PY = String.raw`
import importlib.util, json, re, sys, traceback

spec = importlib.util.spec_from_file_location("sira_office", sys.argv[1])
so = importlib.util.module_from_spec(spec)
sys.modules["sira_office"] = so  # dataclasses resolve their module by name
spec.loader.exec_module(so)
args = json.load(open(sys.argv[2], encoding="utf-8"))
before, after, sid, outdir = args["before"], args["after"], args["scenario"], args["outdir"]
render = bool(args.get("render", True))
checks = []

def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:300]})

W = so.W
def paras(path): return so.docx_paragraphs(so.OfficePackage(path))
def texts(path): return [so.docx_para_text(p) for p in paras(path)]
def run_text(r): return "".join(t.text or "" for t in r.iter(W("t")))
def rpr_val(r, tag):
    el = r.find(W("rPr") + "/" + W(tag))
    if el is None: return None
    return el.get(W("val"), "true")
def is_on(r, tag):
    v = rpr_val(r, tag)
    return v is not None and v not in ("0", "false", "none")
def changed_parts():
    d = so.part_diff(before, after)
    return sorted(d["changed"] + d["added"] + d["removed"])
def only_these_changed(tb, ta, allowed):
    if len(tb) != len(ta):
        return False, "%d → %d párrafos" % (len(tb), len(ta))
    extra = [i for i, (x, y) in enumerate(zip(tb, ta)) if x != y and i not in allowed]
    return (not extra), ("también cambiaron los párrafos %s" % extra[:8] if extra else "")
def visual(expect=None):
    if not render:
        return None
    return so.verify(before, after, outdir, dpi=90, expect=expect or {})
def pages_check(rep, pages):
    if rep is None:
        return
    v = rep["visual"]
    check("solo cambian las páginas %s" % pages, v["pages_changed"] == pages, "cambiaron: %s" % v["pages_changed"])
    check("misma cantidad de páginas", v["page_count_before"] == v["page_count_after"],
          "%s → %s" % (v["page_count_before"], v["page_count_after"]))
def xl_cell(path, sheet, ref):
    pkg = so.OfficePackage(path)
    part = so._xl_sheet_part(pkg, sheet)
    c = so._xl_get_cell(pkg.xml(part), ref, create=False)
    return c, pkg
def xl_value(path, sheet, ref):
    c, pkg = xl_cell(path, sheet, ref)
    if c is None: return None, None
    v = so._xl_cell_value(c, so._xl_shared_strings(pkg))
    return v[0], v[1]
try:
    if sid == "docx-portada-anio":
        tb, ta = texts(before), texts(after)
        check("la portada dice «Lima, 2025»", ta[8].strip() == "Lima, 2025", repr(ta[8]))
        p = paras(after)[8]
        red = [run_text(r) for r in p.iter(W("r")) if rpr_val(r, "color") == "C00000"]
        check("el run rojo sigue rojo", any("25" in t for t in red), "runs rojos: %s" % red)
        ok, d = only_these_changed(tb, ta, {8}); check("ningún otro párrafo cambia", ok, d)
        check("solo cambia word/document.xml", changed_parts() == ["word/document.xml"], changed_parts())
        pages_check(visual(), [1])

    elif sid == "docx-parafraseo-cita":
        tb, ta = texts(before), texts(after)
        idx = next(i for i, t in enumerate(tb) if "García, 2020" in t)
        check("el párrafo cambió", tb[idx] != ta[idx], ta[idx][:160])
        p = paras(after)[idx]
        kinds = [f.get(W("fldCharType")) for f in p.iter(W("fldChar"))]
        instr = "".join(t.text or "" for t in p.iter(W("instrText")))
        check("el campo de cita sigue entero", kinds == ["begin", "separate", "end"] and "CSL_CITATION" in instr,
              "fldChar=%s" % kinds)
        check("la cita visible sigue siendo «(García, 2020)»", "(García, 2020)" in ta[idx], ta[idx][:160])
        ok, d = only_these_changed(tb, ta, {idx}); check("ningún otro párrafo cambia", ok, d)

    elif sid == "docx-negrita-fragmento":
        tb, ta = texts(before), texts(after)
        idx = next(i for i, t in enumerate(tb) if "baja capacidad portante" in t)
        p = paras(after)[idx]
        bold = [run_text(r) for r in p.iter(W("r")) if is_on(r, "b") and run_text(r)]
        check("solo «baja capacidad portante» en negrita", "".join(bold).strip() == "baja capacidad portante", "negrita: %s" % bold)
        check("el texto del párrafo no cambia", ta[idx] == tb[idx], ta[idx][:120])
        ok, d = only_these_changed(tb, ta, set()); check("ningún otro párrafo cambia", ok, d)

    elif sid == "docx-sangria-justificado":
        tb, ta = texts(before), texts(after)
        pa = paras(after)
        body = [i for i in range(10, 14)]
        bad = []
        for i in body:
            ppr = pa[i].find(W("pPr"))
            ind = ppr.find(W("ind")) if ppr is not None else None
            jc = ppr.find(W("jc")) if ppr is not None else None
            first = ind.get(W("firstLine")) if ind is not None else None
            if not (first and abs(int(first) - 709) <= 2 and jc is not None and jc.get(W("val")) == "both"):
                bad.append((i, first, jc.get(W("val")) if jc is not None else None))
        check("sangría 1,25 cm (firstLine≈709) y justificado en la introducción", not bad, "fallan: %s" % bad[:4])
        pb = paras(before)
        def ppr_xml(p):
            ppr = p.find(W("pPr"))
            return so.etree.tostring(ppr) if ppr is not None else b""
        touched = [i for i in range(0, 10) if ppr_xml(pa[i]) != ppr_xml(pb[i])]
        check("la portada y el título no cambian de formato", not touched, "cambiaron: %s" % touched)
        ok, d = only_these_changed(tb, ta, set()); check("el texto no cambia", ok, d)

    elif sid == "docx-tabla-control-cambios":
        pkg = so.OfficePackage(after)
        root = pkg.xml("word/document.xml")
        tbl = next(root.iter(W("tbl")))
        dels = [d for d in tbl.iter(W("del"))]
        inss = [i for i in tbl.iter(W("ins"))]
        authors = {e.get(W("author")) for e in dels + inss}
        check("hay w:del y w:ins en la tabla", bool(dels) and bool(inss), "del=%d ins=%d" % (len(dels), len(inss)))
        check("autor «SiraGPT»", authors == {"SiraGPT"}, "autores: %s" % sorted(a for a in authors if a))
        cell_text = None
        for tc in tbl.iter(W("tc")):
            t = "".join(so.docx_para_text(p) for p in tc.iter(W("p")))
            if "15,1" in t:
                cell_text = t
        deleted = "".join(t.text or "" for d in dels for t in d.iter(W("delText")))
        check("la celda muestra 15,1", cell_text is not None and cell_text.strip() == "15,1", repr(cell_text))
        check("lo borrado reconstruye 14,6", ("14,6".endswith(deleted) or deleted == "14,6") and deleted != "", "borrado: %r" % deleted)
        tb, ta = texts(before), texts(after)
        extra = [i for i, (x, y) in enumerate(zip(tb, ta)) if x != y and "14,6" not in x]
        check("ningún otro texto cambia", len(tb) == len(ta) and not extra, "cambiaron: %s" % extra[:8])

    elif sid == "xlsx-cantidad-resaltado":
        v, _ = xl_value(after, "Presupuesto", "B4")
        check("B4 = 15", v == 15 or v == "15" or v == 15.0, repr(v))
        c_after, pkg_a = xl_cell(after, "Presupuesto", "B4")
        c_before, pkg_b = xl_cell(before, "Presupuesto", "B4")
        st_a = so.XlStyles(pkg_a).describe(int(c_after.get("s") or 0))
        st_b = so.XlStyles(pkg_b).describe(int(c_before.get("s") or 0))
        check("B4 resaltada con relleno FFF2CC", str(st_a.get("fill") or "").upper() == "FFF2CC" and st_a.get("fill") != st_b.get("fill"), "relleno: %s" % st_a.get("fill"))
        same = []
        for ref in ("A4", "C4", "D4", "B2", "B3", "B5", "D6"):
            ca, _ = xl_cell(after, "Presupuesto", ref); cb, _ = xl_cell(before, "Presupuesto", ref)
            if (ca.get("s") if ca is not None else None) != (cb.get("s") if cb is not None else None):
                same.append(ref)
        check("el estilo de las demás celdas no cambia", not same, "cambiaron: %s" % same)
        if render:
            vals = so.recalc_values(after, ["Presupuesto!D4", "Presupuesto!D6", "Resumen!B1"])
            check("D4 = 900 (recalculado)", vals.get("Presupuesto!D4") == 900, vals.get("Presupuesto!D4"))
            check("total = 2231 (recalculado, también en Resumen)", vals.get("Presupuesto!D6") == 2231 and vals.get("Resumen!B1") == 2231,
                  "%s / %s" % (vals.get("Presupuesto!D6"), vals.get("Resumen!B1")))

    elif sid == "xlsx-fila-imprevistos":
        pkg = so.OfficePackage(after)
        part = so._xl_sheet_part(pkg, "Presupuesto")
        root = pkg.xml(part)
        sst = so._xl_shared_strings(pkg)
        row_ref = None
        for c in root.iter(so.S("c")):
            val = so._xl_cell_value(c, sst)[0]
            if isinstance(val, str) and re.search(r"imprevist", val, re.I):
                row_ref = re.sub(r"[A-Z]+", "", c.get("r"))
        check("hay una fila «Imprevistos»", row_ref is not None, row_ref)
        formula_cells = []
        if row_ref:
            for c in root.iter(so.S("c")):
                if re.sub(r"[A-Z]+", "", c.get("r")) == row_ref and c.find(so.S("f")) is not None:
                    formula_cells.append(c.get("r"))
        check("con una fórmula nueva", bool(formula_cells), formula_cells)
        check("sin calcChain.xml", not pkg.has("xl/calcChain.xml"), "")
        for ref, want in (("B2", 4), ("B3", 4), ("B4", 12), ("B5", 6)):
            v, _ = xl_value(after, "Presupuesto", ref)
            if v != want:
                check("las partidas no cambian", False, "%s=%r" % (ref, v)); break
        else:
            check("las partidas no cambian", True)
        if render and formula_cells:
            vals = so.recalc_values(after, ["Presupuesto!" + r for r in formula_cells])
            got = [vals.get("Presupuesto!" + r) for r in formula_cells]
            check("imprevistos = 5 % de 2051 (102,55)", any(isinstance(g, (int, float)) and abs(g - 102.55) < 0.01 for g in got), got)

    elif sid == "pptx-portada-anio":
        info = so.inspect(after, slide=1)
        texts_s1 = " ".join((sh.get("text") or "") for sh in info["slides"][0]["shapes"])
        check("la portada dice «Sustentación 2025»", "Sustentación 2025" in texts_s1 and "2024" not in texts_s1, texts_s1[:160])
        check("solo cambia la lámina 1", changed_parts() == ["ppt/slides/slide1.xml"], changed_parts())
        pages_check(visual(), [1])

    elif sid == "pptx-nota-mover-verde":
        pkg_a, pkg_b = so.OfficePackage(after), so.OfficePackage(before)
        el_a, _, _ = so._pp_find_shape(pkg_a, so._pp_slide_part(pkg_a, 2), "Nota")
        el_b, _, _ = so._pp_find_shape(pkg_b, so._pp_slide_part(pkg_b, 2), "Nota")
        xa, xb = so._pp_xfrm(el_a), so._pp_xfrm(el_b)
        off_a, off_b = xa.find(so.A("off")), xb.find(so.A("off"))
        ext_a, ext_b = xa.find(so.A("ext")), xb.find(so.A("ext"))
        dx = int(off_a.get("x")) - int(off_b.get("x"))
        check("x +72 000 EMU (2 mm)", abs(dx - 72000) <= 1, "dx=%d EMU" % dx)
        check("y y tamaño iguales", off_a.get("y") == off_b.get("y") and ext_a.get("cx") == ext_b.get("cx") and ext_a.get("cy") == ext_b.get("cy"), "")
        info = so.inspect(after, slide=2)
        fill = next((sh.get("fill") for sh in info["slides"][0]["shapes"] if sh.get("name") == "Nota"), None)
        check("relleno verde 2E7D32", str(fill or "").upper() == "2E7D32", "relleno: %s" % fill)
        check("solo cambia la lámina 2", changed_parts() == ["ppt/slides/slide2.xml"], changed_parts())

    elif sid == "docx-larga-subtitulo":
        tb, ta = texts(before), texts(after)
        idx = next(i for i, t in enumerate(tb) if t.startswith("CAPÍTULO 5."))
        check("el capítulo 5 se titula «ANÁLISIS DE RESULTADOS»", ta[idx].strip() == "CAPÍTULO 5. ANÁLISIS DE RESULTADOS", repr(ta[idx]))
        st = paras(after)[idx].find(W("pPr") + "/" + W("pStyle"))
        check("conserva el estilo Heading1", st is not None and st.get(W("val")) == "Heading1", "")
        ok, d = only_these_changed(tb, ta, {idx}); check("ningún otro párrafo cambia", ok, d)
        rep = visual()
        if rep is not None:
            v = rep["visual"]
            check("barrido rápido", bool(v.get("fast_scan")), "")
            check("1 página cambia", len(v["pages_changed"]) == 1, "cambiaron: %s" % v["pages_changed"])
    else:
        check("escenario conocido", False, sid)
except Exception as exc:
    check("el archivo se pudo analizar", False, "%s: %s" % (type(exc).__name__, exc))

print(json.dumps({"ok": bool(checks) and all(c["ok"] for c in checks), "checks": checks}, ensure_ascii=False))
`;

function scenarioById(id) {
  return SCENARIOS.find((s) => s.id === id) || null;
}

module.exports = {
  SCENARIOS,
  GRADER_PY,
  scenarioById,
};
