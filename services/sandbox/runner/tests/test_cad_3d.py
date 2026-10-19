"""Areas "cad" (ezdxf, shapely, svgpathtools) and "3d" (trimesh, manifold3d,
mapbox_earcut, numpy-stl, meshio, pygltflib).

Every test builds real geometry, writes it to disk and reads it back with a
different library or a fresh parser, asserting on entity counts, layers,
units, areas, volumes and watertightness. Heavy libraries are imported inside
the tests so the module collects on any machine.
"""
from __future__ import annotations

import math

import pytest


def _ink(path, min_size=(100, 100), min_dark=100):
    """Assert a raster preview is not blank (real size, non-white pixels)."""
    from PIL import Image
    with Image.open(path) as img:
        img.load()
        size = img.size
        gray = img.convert("L")
    assert size[0] >= min_size[0] and size[1] >= min_size[1], f"{path} is only {size}"
    lo, hi = gray.getextrema()
    assert hi - lo > 60, f"{path} is a flat image (extrema {lo}-{hi})"
    dark = sum(gray.histogram()[:200])
    assert dark >= min_dark, f"{path} has only {dark} inked pixels"
    return size


# =========================================================================== CAD

@pytest.mark.covers("ezdxf")
def test_ezdxf_floor_plan_round_trip_and_previews(out, check):
    import ezdxf
    from ezdxf import units
    from ezdxf.addons.drawing import matplotlib as drawing

    doc = ezdxf.new("R2018", setup=True)
    doc.units = units.M
    for name, color in (("MUROS", 1), ("TEXTO", 7), ("COTAS", 3), ("MOBILIARIO", 5), ("PISO", 8)):
        doc.layers.add(name, color=color)
    msp = doc.modelspace()

    # Walls: outer footprint plus an interior partition.
    msp.add_lwpolyline([(0, 0), (8, 0), (8, 6), (0, 6)], close=True, dxfattribs={"layer": "MUROS"})
    msp.add_lwpolyline([(4, 0), (4, 6)], dxfattribs={"layer": "MUROS"})
    # Room labels.
    msp.add_text("Sala 24 m²", dxfattribs={"layer": "TEXTO", "height": 0.3}).set_placement((1, 3))
    msp.add_text("Cocina", dxfattribs={"layer": "TEXTO", "height": 0.3}).set_placement((5, 3))
    # A door symbol as a block, inserted twice.
    door = doc.blocks.new("PUERTA")
    door.add_line((0, 0), (0.9, 0))
    door.add_arc(center=(0, 0), radius=0.9, start_angle=0, end_angle=90)
    msp.add_blockref("PUERTA", (1, 0), dxfattribs={"layer": "MOBILIARIO"})
    msp.add_blockref("PUERTA", (5, 0), dxfattribs={"layer": "MOBILIARIO", "xscale": -1})
    # Linear dimension across the facade, rendered into its geometry block.
    msp.add_linear_dim(base=(0, -1), p1=(0, 0), p2=(8, 0), dimstyle="EZDXF",
                       dxfattribs={"layer": "COTAS"}).render()
    # Hatched floor finish in the kitchen.
    hatch = msp.add_hatch(color=8, dxfattribs={"layer": "PISO"})
    hatch.set_pattern_fill("ANSI31", scale=0.5)
    hatch.paths.add_polyline_path([(4.1, 0.1), (7.9, 0.1), (7.9, 5.9), (4.1, 5.9)], is_closed=True)

    path = out / "plano.dxf"
    doc.saveas(path)
    check.nonempty(path, 20_000)

    again = ezdxf.readfile(str(path))
    assert again.dxfversion == "AC1032"  # R2018
    assert again.units == units.M, "drawing units did not round-trip"
    space = again.modelspace()
    assert len(space.query("LWPOLYLINE")) == 2
    assert len(space.query("TEXT")) == 2
    assert len(space.query("INSERT")) == 2
    assert len(space.query("DIMENSION")) == 1
    assert len(space.query("HATCH")) == 1
    assert len(space.query('LWPOLYLINE[layer=="MUROS"]')) == 2
    assert {layer.dxf.name for layer in again.layers} >= {"MUROS", "TEXTO", "COTAS", "MOBILIARIO", "PISO"}
    assert "PUERTA" in again.blocks
    assert len(list(again.blocks.get("PUERTA"))) == 2
    dim = space.query("DIMENSION").first
    assert abs(dim.get_measurement() - 8.0) < 1e-9
    assert dim.get_geometry_block() is not None, "dimension geometry block missing"
    assert again.audit().has_errors is False
    texts = sorted(t.dxf.text for t in space.query("TEXT"))
    assert texts == ["Cocina", "Sala 24 m²"]

    png, pdf = out / "plano.png", out / "plano.pdf"
    drawing.qsave(space, str(png), bg="#FFFFFF", dpi=120)
    drawing.qsave(space, str(pdf), bg="#FFFFFF")
    _ink(png, min_size=(300, 200), min_dark=500)
    assert check.pdf_pages(pdf) == 1
    check.nonempty(pdf, 2000)


@pytest.mark.covers("shapely")
def test_shapely_areas_unions_buffers_and_wkt(out):
    import shapely
    from shapely import wkt
    from shapely.geometry import LineString, Point, Polygon, box
    from shapely.ops import unary_union

    lote = Polygon([(0, 0), (12, 0), (12, 8), (0, 8)])
    assert lote.area == 96 and lote.length == 40
    a, b = box(0, 0, 4, 4), box(2, 2, 6, 6)
    union = a.union(b)
    assert union.area == 16 + 16 - 4
    assert a.intersection(b).area == 4
    assert a.difference(b).area == 12
    assert unary_union([a, b, box(10, 10, 11, 11)]).geom_type == "MultiPolygon"

    disco = Point(0, 0).buffer(1.0, quad_segs=64)
    assert abs(disco.area - math.pi) / math.pi < 0.002
    camino = LineString([(0, 0), (3, 4)])
    assert camino.length == 5
    franja = camino.buffer(0.5, cap_style="flat")
    assert abs(franja.area - 5.0) < 1e-9
    assert lote.contains(Point(6, 4)) and not lote.contains(Point(13, 4))
    assert Point(6, 4).distance(lote.exterior) == 4

    con_hueco = Polygon(lote.exterior.coords, [box(2, 2, 4, 4).exterior.coords])
    assert con_hueco.area == 96 - 4 and len(con_hueco.interiors) == 1
    assert con_hueco.is_valid

    texto = con_hueco.wkt
    assert texto.startswith("POLYGON")
    assert wkt.loads(texto).equals(con_hueco)
    archivo = out / "lote.wkt"
    archivo.write_text(texto, encoding="utf-8")
    leido = shapely.from_wkt(archivo.read_text(encoding="utf-8"))
    assert leido.equals(con_hueco) and leido.area == 92
    geojson = shapely.to_geojson(leido)
    assert '"type": "Polygon"' in geojson or '"type":"Polygon"' in geojson
    assert shapely.from_geojson(geojson).equals(leido)
    simplificado = disco.simplify(0.1)
    assert len(simplificado.exterior.coords) < len(disco.exterior.coords)


@pytest.mark.covers("svgpathtools")
def test_svgpathtools_parse_measure_write_and_reread(out):
    from svgpathtools import Line, Path, parse_path, svg2paths, wsvg

    path = parse_path("M 0 0 L 100 0 L 100 100 Z")
    assert len(path) == 3
    assert path.isclosed()
    expected = 100 + 100 + 100 * math.sqrt(2)
    assert abs(path.length() - expected) < 1e-6
    xmin, xmax, ymin, ymax = path.bbox()
    assert (xmin, xmax, ymin, ymax) == (0, 100, 0, 100)
    assert abs(abs(path.area()) - 5000) < 1e-6

    curva = parse_path("M 0 0 C 0 50 100 50 100 0")
    assert 100 < curva.length() < 150
    punto = curva.point(0.5)
    assert abs(punto.real - 50) < 1e-9 and 30 < punto.imag < 40

    tramo = Path(Line(0 + 0j, 30 + 40j))
    assert tramo.length() == 50

    archivo = out / "formas.svg"
    wsvg([path, curva, tramo], colors=["#2a6f97", "#d62828", "#333333"], stroke_widths=[2, 2, 2],
         filename=str(archivo))
    assert archivo.exists()
    leidos, atributos = svg2paths(str(archivo))
    assert len(leidos) == 3
    assert abs(leidos[0].length() - expected) < 1e-6
    assert atributos[1]["stroke"] == "#d62828"


# =========================================================================== 3D

@pytest.mark.covers("trimesh")
def test_trimesh_export_and_reload_stl_obj_glb_ply(out, check):
    import numpy as np
    import trimesh

    caja = trimesh.creation.box(extents=(10, 20, 5))
    assert caja.is_watertight and abs(caja.volume - 1000) < 1e-6
    assert len(caja.faces) == 12
    cilindro = trimesh.creation.cylinder(radius=3, height=10, sections=64)
    assert abs(cilindro.volume - math.pi * 9 * 10) / (math.pi * 90) < 0.01

    for ext in ("stl", "obj", "glb", "ply"):
        path = out / f"pieza.{ext}"
        caja.export(str(path))
        check.nonempty(path, 100)
        otra = trimesh.load(str(path), force="mesh")
        assert isinstance(otra, trimesh.Trimesh), f"{ext}: {type(otra)}"
        assert abs(otra.volume - 1000) < 1e-3, f"{ext}: volume {otra.volume}"
        assert otra.is_watertight, f"{ext}: not watertight after reload"
        assert np.allclose(otra.bounds, caja.bounds, atol=1e-6)

    ascii_stl = out / "pieza-ascii.stl"
    caja.export(str(ascii_stl), file_type="stl_ascii")
    assert ascii_stl.read_text(encoding="utf-8").lstrip().startswith("solid")
    escena = trimesh.Scene([caja, cilindro.apply_translation((20, 0, 0))])
    escena.export(str(out / "escena.glb"))
    cargada = trimesh.load(str(out / "escena.glb"))
    assert isinstance(cargada, trimesh.Scene) and len(cargada.geometry) == 2
    assert abs(cargada.to_mesh().volume - (1000 + cilindro.volume)) < 1e-2


@pytest.mark.covers("trimesh", "manifold3d")
def test_manifold_boolean_union_and_difference(out):
    import manifold3d
    import trimesh

    a = trimesh.creation.box(extents=(10, 10, 10))
    b = trimesh.creation.box(extents=(10, 10, 10)).apply_translation((5, 0, 0))
    union = trimesh.boolean.union([a, b], engine="manifold")
    assert union.is_watertight and union.is_volume
    assert abs(union.volume - 1500) < 1e-6, union.volume
    inter = trimesh.boolean.intersection([a, b], engine="manifold")
    assert abs(inter.volume - 500) < 1e-6
    resta = trimesh.boolean.difference([a, b], engine="manifold")
    assert abs(resta.volume - 500) < 1e-6

    esfera = trimesh.creation.icosphere(subdivisions=3, radius=4)
    con_hueco = trimesh.boolean.difference([a, esfera], engine="manifold")
    assert con_hueco.is_watertight
    assert 1000 - esfera.volume - 1e-6 < con_hueco.volume < 1000

    # The manifold library itself: cube minus cylinder via its own API.
    cubo = manifold3d.Manifold.cube((10, 10, 10), center=True)
    taladro = manifold3d.Manifold.cylinder(12, 2, 2, 64, center=True)
    pieza = cubo - taladro
    assert pieza.num_tri() > 0 and pieza.volume() < cubo.volume()
    assert abs(cubo.volume() - 1000) < 1e-6
    salida = out / "pieza.stl"
    trimesh.Trimesh(*_mesh_arrays(pieza.to_mesh())).export(str(salida))
    recargada = trimesh.load(str(salida), force="mesh")
    assert recargada.is_watertight and abs(recargada.volume - pieza.volume()) < 1e-3


def _mesh_arrays(mesh):
    """Vertices and faces from a manifold3d MeshGL (float positions, uint32 triangles)."""
    import numpy as np
    verts = np.asarray(mesh.vert_properties, dtype=float)[:, :3]
    faces = np.asarray(mesh.tri_verts, dtype=np.int64).reshape(-1, 3)
    return verts, faces


@pytest.mark.covers("mapbox_earcut", "trimesh")
def test_earcut_triangulation_and_polygon_extrusion(out):
    import mapbox_earcut as earcut
    import numpy as np
    import trimesh
    from shapely.geometry import Polygon

    # Direct earcut: a square with a square hole -> 8 triangles.
    verts = np.array([[0, 0], [10, 0], [10, 10], [0, 10],
                      [3, 3], [7, 3], [7, 7], [3, 7]], dtype=np.float64)
    rings = np.array([4, 8], dtype=np.uint32)
    tri = earcut.triangulate_float64(verts, rings)
    assert len(tri) % 3 == 0 and len(tri) // 3 == 8
    area = 0.0
    for i in range(0, len(tri), 3):
        p, q, r = verts[tri[i]], verts[tri[i + 1]], verts[tri[i + 2]]
        area += abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2
    assert abs(area - (100 - 16)) < 1e-9

    # trimesh uses earcut to triangulate the cap when extruding a shapely polygon.
    planta = Polygon([(0, 0), (12, 0), (12, 8), (0, 8)], [[(2, 2), (4, 2), (4, 4), (2, 4)]])
    solido = trimesh.creation.extrude_polygon(planta, height=3, engine="earcut")
    assert solido.is_watertight
    assert abs(solido.volume - (96 - 4) * 3) < 1e-6
    path = out / "losa.stl"
    solido.export(str(path))
    assert abs(trimesh.load(str(path), force="mesh").volume - 276) < 1e-3


@pytest.mark.covers("stl")
def test_numpy_stl_reads_and_writes(out):
    import numpy as np
    import stl
    import trimesh

    origen = out / "caja.stl"
    trimesh.creation.box(extents=(10, 20, 5)).export(str(origen))
    malla = stl.mesh.Mesh.from_file(str(origen))
    assert len(malla.vectors) == 12
    volumen, cog, _ = malla.get_mass_properties()
    assert abs(volumen - 1000) < 1e-6
    assert np.allclose(cog, (0, 0, 0), atol=1e-6)
    assert np.allclose(malla.max_ - malla.min_, (10, 20, 5))

    # Build a tetrahedron with numpy-stl itself; write ASCII and binary; reread.
    datos = np.zeros(4, dtype=stl.mesh.Mesh.dtype)
    p0, p1, p2, p3 = np.array([[0, 0, 0], [6, 0, 0], [0, 6, 0], [0, 0, 6]], dtype=float)
    for i, tri in enumerate(((p0, p2, p1), (p0, p1, p3), (p0, p3, p2), (p1, p2, p3))):
        datos["vectors"][i] = np.array(tri)
    tetra = stl.mesh.Mesh(datos)
    tetra.update_normals()
    ascii_path, bin_path = out / "tetra-ascii.stl", out / "tetra-bin.stl"
    tetra.save(str(ascii_path), mode=stl.Mode.ASCII)
    tetra.save(str(bin_path), mode=stl.Mode.BINARY)
    assert ascii_path.read_text(encoding="utf-8").startswith("solid")
    for path in (ascii_path, bin_path):
        releida = stl.mesh.Mesh.from_file(str(path))
        assert len(releida.vectors) == 4
        assert abs(releida.get_mass_properties()[0] - 36) < 1e-6  # 6^3 / 6
    assert trimesh.load(str(bin_path), force="mesh").is_watertight


@pytest.mark.covers("meshio")
def test_meshio_write_and_read_vtk_off_ply(out, check):
    import meshio
    import numpy as np

    puntos = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0.5, 0.5, 1]], dtype=float)
    triangulos = np.array([[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4], [0, 2, 1], [0, 3, 2]])
    malla = meshio.Mesh(puntos, [("triangle", triangulos)],
                        point_data={"temperatura": np.linspace(20, 60, 5)})
    for ext in ("vtk", "off", "ply", "obj"):
        path = out / f"piramide.{ext}"
        malla.write(str(path))
        check.nonempty(path, 60)
        otra = meshio.read(str(path))
        assert otra.points.shape == (5, 3), ext
        tri = [c for c in otra.cells if c.type == "triangle"]
        assert tri and tri[0].data.shape == (6, 3), ext
        assert np.allclose(otra.points, puntos, atol=1e-6), ext
    vtk = meshio.read(str(out / "piramide.vtk"))
    assert np.allclose(vtk.point_data["temperatura"], np.linspace(20, 60, 5))
    assert (out / "piramide.off").read_text(encoding="utf-8").lstrip().startswith("OFF")


@pytest.mark.covers("pygltflib", "trimesh")
def test_pygltflib_inspects_and_resaves_glb(out):
    import pygltflib
    import trimesh

    origen = out / "pieza.glb"
    caja = trimesh.creation.box(extents=(10, 20, 5))
    caja.export(str(origen))

    gltf = pygltflib.GLTF2().load(str(origen))
    assert gltf.asset.version == "2.0"
    assert len(gltf.meshes) >= 1 and len(gltf.nodes) >= 1 and len(gltf.scenes) >= 1
    prim = gltf.meshes[0].primitives[0]
    assert prim.attributes.POSITION is not None and prim.indices is not None
    pos = gltf.accessors[prim.attributes.POSITION]
    assert pos.type == "VEC3" and pos.count >= 8
    assert [round(v, 6) for v in pos.min] == [-5, -10, -2.5]
    assert [round(v, 6) for v in pos.max] == [5, 10, 2.5]
    idx = gltf.accessors[prim.indices]
    assert idx.count == 36  # 12 triangles
    assert gltf.binary_blob() and len(gltf.binary_blob()) == gltf.buffers[0].byteLength

    gltf.meshes[0].name = "Caja principal"
    copia = out / "copia.glb"
    gltf.save(str(copia))
    de_nuevo = pygltflib.GLTF2().load(str(copia))
    assert de_nuevo.meshes[0].name == "Caja principal"
    recargada = trimesh.load(str(copia), force="mesh")
    assert abs(recargada.volume - 1000) < 1e-3 and recargada.is_watertight

    gltf_json = out / "copia.gltf"
    gltf.convert_buffers(pygltflib.BufferFormat.DATAURI)
    gltf.save(str(gltf_json))
    texto = gltf_json.read_text(encoding="utf-8")
    assert '"asset"' in texto and "data:application/octet-stream;base64," in texto
