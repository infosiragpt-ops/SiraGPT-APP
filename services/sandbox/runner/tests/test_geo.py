"""Area "geo": vector + raster GIS, maps, GPS formats and geocoding math, offline.

Every test writes a real file into ``out`` and reopens it with an independent
reader (pyogrio/fiona-free geopandas, rasterio, gpxpy, pyshp, plain XML/HTML
inspection) or checks a numeric result against a known geographic fact.
Heavy libraries are imported inside the tests so this module collects anywhere.
"""
from __future__ import annotations

import json
import math
import os

import pytest

# Three districts of Lima as small polygons in WGS84 (lon, lat).
LIMA_POLYGONS = {
    "Miraflores": [(-77.05, -12.13), (-77.02, -12.13), (-77.02, -12.11), (-77.05, -12.11)],
    "San Isidro": [(-77.05, -12.11), (-77.02, -12.11), (-77.02, -12.09), (-77.05, -12.09)],
    "Barranco": [(-77.03, -12.15), (-77.01, -12.15), (-77.01, -12.13), (-77.03, -12.13)],
}
LIMA = (-12.0464, -77.0428)  # lat, lon
CUSCO = (-13.5319, -71.9675)


def _lima_gdf():
    import geopandas as gpd
    from shapely.geometry import Polygon

    rows = []
    for index, (name, ring) in enumerate(LIMA_POLYGONS.items(), start=1):
        rows.append({
            "código": index,
            "distrito": name,
            "población": 80_000 + 10_000 * index,
            "región": "Lima Metropolitana",
            "geometry": Polygon(ring),
        })
    return gpd.GeoDataFrame(rows, crs="EPSG:4326")


@pytest.mark.covers("geopandas", "pyogrio")
def test_geopandas_roundtrip_gpkg_shp_geojson(out):
    import geopandas as gpd

    gdf = _lima_gdf()
    assert gdf.crs.to_epsg() == 4326

    paths = {
        "gpkg": out / "distritos.gpkg",
        "shp": out / "distritos.shp",
        "geojson": out / "distritos.geojson",
    }
    gdf.to_file(paths["gpkg"], driver="GPKG", layer="distritos", engine="pyogrio")
    gdf.to_file(paths["shp"], driver="ESRI Shapefile", engine="pyogrio")
    gdf.to_file(paths["geojson"], driver="GeoJSON", engine="pyogrio")

    for fmt, path in paths.items():
        assert os.path.getsize(path) > 0, fmt
        back = gpd.read_file(path, engine="pyogrio")
        assert len(back) == 3, fmt
        assert set(back["distrito"]) == set(LIMA_POLYGONS), fmt
        assert back.crs is not None and back.crs.to_epsg() == 4326, fmt
        assert back.geometry.geom_type.eq("Polygon").all(), fmt
        # Accented attribute names survive GPKG and GeoJSON verbatim; the
        # shapefile DBF header is limited to 10 bytes / legacy encodings so we
        # only require the data columns to exist there.
        if fmt in ("gpkg", "geojson"):
            assert "población" in back.columns and "código" in back.columns, (fmt, list(back.columns))
            assert int(back.loc[back["distrito"] == "Barranco", "población"].iloc[0]) == 110_000
        else:
            assert len(back.columns) >= 5, list(back.columns)

    # GeoJSON must also be valid JSON with the Spanish property names intact.
    with open(paths["geojson"], encoding="utf-8") as handle:
        doc = json.load(handle)
    assert doc["type"] == "FeatureCollection"
    assert doc["features"][0]["properties"]["región"] == "Lima Metropolitana"


@pytest.mark.covers("geopandas", "pyproj")
def test_reproject_to_utm18s_and_measure_area_in_m2(out):
    import pyproj

    gdf = _lima_gdf()
    utm = gdf.to_crs(epsg=32718)  # WGS84 / UTM zone 18S (Lima)
    assert utm.crs.to_epsg() == 32718
    assert utm.crs.axis_info[0].unit_name == "metre"

    # Each box is ~0.03° × 0.02° ≈ 3.3 km × 2.2 km ≈ 7.2 km² (first two) ;
    # the third is 0.02° × 0.02° ≈ 4.8 km².
    areas_km2 = utm.geometry.area / 1e6
    assert 6.5 < areas_km2.iloc[0] < 8.0, areas_km2.tolist()
    assert 4.0 < areas_km2.iloc[2] < 5.5, areas_km2.tolist()
    # Coordinates are now in metres: eastings ~ 270-290 km, northings ~ 8.65 Mm.
    centroid = utm.geometry.iloc[0].centroid
    assert 250_000 < centroid.x < 320_000
    assert 8_600_000 < centroid.y < 8_700_000

    # Cross-check one point with pyproj directly.
    transformer = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:32718", always_xy=True)
    east, north = transformer.transform(-77.0428, -12.0464)
    assert 270_000 < east < 290_000 and 8_660_000 < north < 8_670_000
    lon, lat = transformer.transform(east, north, direction="INVERSE")
    assert math.isclose(lon, -77.0428, abs_tol=1e-6) and math.isclose(lat, -12.0464, abs_tol=1e-6)
    assert pyproj.CRS("EPSG:32718").name.startswith("WGS 84 / UTM zone 18S")

    # And a plot of the projected layer.
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ax = utm.plot(column="población", legend=True, edgecolor="black")
    ax.set_title("Distritos de Lima (UTM 18S)")
    png = out / "distritos.png"
    ax.figure.savefig(png, dpi=90)
    plt.close(ax.figure)
    assert os.path.getsize(png) > 5_000
    from PIL import Image
    with Image.open(png) as img:
        assert img.size[0] > 200 and img.size[1] > 200


@pytest.mark.covers("rasterio")
def test_rasterio_geotiff_roundtrip(out):
    import numpy as np
    import rasterio
    from rasterio.crs import CRS
    from rasterio.transform import from_origin

    height, width = 20, 30
    data = np.arange(height * width, dtype="float32").reshape(height, width) / 10.0
    res = 0.01
    transform = from_origin(-77.2, -11.9, res, res)  # west, north, xres, yres
    path = out / "altura.tif"
    with rasterio.open(
        path, "w", driver="GTiff", height=height, width=width, count=1,
        dtype="float32", crs=CRS.from_epsg(4326), transform=transform, nodata=-9999.0,
    ) as dst:
        dst.write(data, 1)
        dst.update_tags(descripcion="modelo de prueba")

    assert os.path.getsize(path) > 1_000
    with rasterio.open(path) as src:
        assert src.count == 1 and src.width == width and src.height == height
        assert src.crs.to_epsg() == 4326
        assert src.dtypes[0] == "float32"
        assert src.nodata == -9999.0
        bounds = src.bounds
        assert math.isclose(bounds.left, -77.2, abs_tol=1e-9)
        assert math.isclose(bounds.top, -11.9, abs_tol=1e-9)
        assert math.isclose(bounds.right, -77.2 + width * res, abs_tol=1e-9)
        assert math.isclose(bounds.bottom, -11.9 - height * res, abs_tol=1e-9)
        back = src.read(1)
        assert back.shape == (height, width)
        assert np.allclose(back, data)
        assert float(back[3, 4]) == pytest.approx((3 * width + 4) / 10.0)
        assert src.tags()["descripcion"] == "modelo de prueba"
        # Pixel ↔ coordinate mapping is consistent with the transform.
        row, col = src.index(-77.195, -11.905)
        assert (row, col) == (0, 0)
        x, y = src.xy(0, 0)
        assert math.isclose(x, -77.195, abs_tol=1e-9) and math.isclose(y, -11.905, abs_tol=1e-9)


@pytest.mark.covers("mapclassify")
def test_mapclassify_quantiles_and_natural_breaks():
    import mapclassify
    import numpy as np

    values = np.array([1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 50, 51, 52, 53, 54], dtype=float)
    quant = mapclassify.Quantiles(values, k=3)
    assert quant.k == 3
    assert len(quant.bins) == 3
    assert quant.bins[-1] == 54
    assert sorted(quant.counts) == [5, 5, 5]
    assert set(quant.yb) == {0, 1, 2}

    natural = mapclassify.NaturalBreaks(values, k=3)
    assert natural.k == 3
    # Jenks finds the three obvious clusters: 1-5, 10-14, 50-54.
    assert list(natural.counts) == [5, 5, 5]
    assert natural.bins[0] >= 5 and natural.bins[0] < 10
    assert natural.bins[1] >= 14 and natural.bins[1] < 50
    assert natural.bins[2] == 54
    # The classifier also tells us which bin a new value belongs to.
    assert list(np.atleast_1d(natural.find_bin(12))) == [1]


@pytest.mark.covers("folium")
def test_folium_map_with_marker_and_geojson(out):
    import folium

    fmap = folium.Map(location=list(LIMA), zoom_start=12, tiles="OpenStreetMap")
    folium.Marker(list(LIMA), popup="Plaza de Armas de Lima", tooltip="Lima").add_to(fmap)
    ring = [[lon, lat] for lon, lat in LIMA_POLYGONS["Miraflores"]]
    ring.append(ring[0])
    feature = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"distrito": "Miraflores"},
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        }],
    }
    folium.GeoJson(feature, name="distritos", tooltip=folium.GeoJsonTooltip(fields=["distrito"])).add_to(fmap)
    folium.LayerControl().add_to(fmap)
    path = out / "mapa.html"
    fmap.save(str(path))

    assert os.path.getsize(path) > 2_000
    html = path.read_text(encoding="utf-8")
    assert "leaflet" in html.lower()
    assert "Plaza de Armas de Lima" in html
    assert "Miraflores" in html
    assert "L.marker" in html or "marker" in html
    assert "L.geoJson" in html or "geo_json" in html


@pytest.mark.covers("simplekml")
def test_simplekml_point_and_linestring(out):
    import xml.etree.ElementTree as ET

    import simplekml

    kml = simplekml.Kml(name="Ruta Lima–Cusco")
    point = kml.newpoint(name="Lima", description="Capital del Perú", coords=[(LIMA[1], LIMA[0])])
    point.style.iconstyle.color = simplekml.Color.red
    line = kml.newlinestring(name="Vuelo", coords=[(LIMA[1], LIMA[0]), (CUSCO[1], CUSCO[0])])
    line.style.linestyle.width = 3
    line.altitudemode = simplekml.AltitudeMode.clamptoground
    path = out / "ruta.kml"
    kml.save(str(path))

    assert os.path.getsize(path) > 300
    root = ET.parse(path).getroot()
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    assert root.tag == "{http://www.opengis.net/kml/2.2}kml"
    placemarks = root.findall(".//k:Placemark", ns)
    assert len(placemarks) == 2
    names = {pm.find("k:name", ns).text for pm in placemarks}
    assert names == {"Lima", "Vuelo"}
    assert root.find(".//k:Point/k:coordinates", ns) is not None
    line_coords = root.find(".//k:LineString/k:coordinates", ns).text.split()
    assert len(line_coords) == 2
    assert line_coords[0].startswith("-77.0428,-12.0464")
    assert "Capital del Perú" in path.read_text(encoding="utf-8")

    kmz = out / "ruta.kmz"
    kml.savekmz(str(kmz))
    import zipfile
    with zipfile.ZipFile(kmz) as archive:
        assert "doc.kml" in archive.namelist()


@pytest.mark.covers("gpxpy")
def test_gpxpy_track_length(out):
    import datetime as dt

    import gpxpy
    import gpxpy.gpx

    gpx = gpxpy.gpx.GPX()
    gpx.name = "Caminata en Miraflores"
    track = gpxpy.gpx.GPXTrack(name="Malecón")
    gpx.tracks.append(track)
    segment = gpxpy.gpx.GPXTrackSegment()
    track.segments.append(segment)
    start = dt.datetime(2026, 1, 15, 8, 0, tzinfo=dt.timezone.utc)
    points = [(-12.1200, -77.0300, 80.0), (-12.1250, -77.0300, 82.0), (-12.1300, -77.0300, 85.0)]
    for index, (lat, lon, ele) in enumerate(points):
        segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon, elevation=ele,
                                                      time=start + dt.timedelta(minutes=5 * index)))
    path = out / "ruta.gpx"
    path.write_text(gpx.to_xml(), encoding="utf-8")

    assert os.path.getsize(path) > 300
    with open(path, encoding="utf-8") as handle:
        back = gpxpy.parse(handle)
    assert back.name == "Caminata en Miraflores"
    assert len(back.tracks) == 1 and len(back.tracks[0].segments[0].points) == 3
    # 0.01° of latitude ≈ 1.11 km in total (two legs of 0.005°).
    length = back.length_2d()
    assert 1_050 < length < 1_170, length
    assert back.get_points_no() == 3
    uphill, downhill = back.get_uphill_downhill()
    assert uphill == pytest.approx(5.0) and downhill == 0
    assert back.get_duration() == 600
    bounds = back.get_bounds()
    assert bounds.min_latitude == pytest.approx(-12.13) and bounds.max_latitude == pytest.approx(-12.12)


@pytest.mark.covers("geopy")
def test_geopy_geodesic_distance_lima_cusco():
    from geopy import distance

    km = distance.geodesic(LIMA, CUSCO).km
    assert 570 <= km <= 590, km
    assert distance.geodesic(LIMA, LIMA).m == 0
    # great_circle is a few km off from the ellipsoidal distance but close.
    assert abs(distance.great_circle(LIMA, CUSCO).km - km) < 5
    # Units convert consistently.
    assert distance.geodesic(LIMA, CUSCO).miles == pytest.approx(km * 0.621371, rel=1e-3)
    # Destination along a bearing returns a Point.
    north = distance.geodesic(kilometers=100).destination(LIMA, bearing=0)
    assert north.latitude > LIMA[0] and math.isclose(north.longitude, LIMA[1], abs_tol=1e-6)


@pytest.mark.covers("h3")
def test_h3_cell_and_boundary():
    import h3

    cell = h3.latlng_to_cell(LIMA[0], LIMA[1], 9)
    assert isinstance(cell, str) and len(cell) == 15
    assert h3.is_valid_cell(cell)
    assert h3.get_resolution(cell) == 9
    lat, lon = h3.cell_to_latlng(cell)
    assert abs(lat - LIMA[0]) < 0.01 and abs(lon - LIMA[1]) < 0.01

    boundary = h3.cell_to_boundary(cell)
    assert len(boundary) in (5, 6)  # hexagon (pentagons are rare)
    for blat, blon in boundary:
        assert abs(blat - LIMA[0]) < 0.01 and abs(blon - LIMA[1]) < 0.01

    neighbours = h3.grid_disk(cell, 1)
    assert len(neighbours) == 7 and cell in neighbours
    parent = h3.cell_to_parent(cell, 8)
    assert h3.get_resolution(parent) == 8
    assert cell in h3.cell_to_children(parent, 9)
    # Area at resolution 9 is about 0.1 km².
    assert 0.08 < h3.cell_area(cell, unit="km^2") < 0.14
    cusco = h3.latlng_to_cell(CUSCO[0], CUSCO[1], 9)
    assert cusco != cell and h3.great_circle_distance(LIMA, CUSCO, unit="km") > 500


@pytest.mark.covers("shapefile")
def test_pyshp_write_and_read_records(out):
    import shapefile

    base = str(out / "ciudades")
    with shapefile.Writer(base, shapeType=shapefile.POINT, encoding="utf-8") as writer:
        writer.field("nombre", "C", size=40)
        writer.field("poblacion", "N", size=10, decimal=0)
        writer.field("altitud", "F", size=10, decimal=2)
        writer.point(LIMA[1], LIMA[0])
        writer.record("Lima", 9_700_000, 154.0)
        writer.point(CUSCO[1], CUSCO[0])
        writer.record("Cusco", 430_000, 3399.5)
        writer.point(-71.5375, -16.4090)
        writer.record("Arequipa", 1_100_000, 2335.0)

    for ext in (".shp", ".shx", ".dbf"):
        assert os.path.getsize(base + ext) > 0, ext

    with shapefile.Reader(base, encoding="utf-8") as reader:
        assert reader.shapeType == shapefile.POINT
        assert len(reader) == 3
        assert [f[0] for f in reader.fields[1:]] == ["nombre", "poblacion", "altitud"]
        records = reader.records()
        assert records[1]["nombre"] == "Cusco"
        assert records[1]["poblacion"] == 430_000
        assert records[1]["altitud"] == pytest.approx(3399.5)
        shape = reader.shape(0)
        assert shape.points[0] == pytest.approx([LIMA[1], LIMA[0]])
        bbox = reader.bbox
        assert bbox[0] == pytest.approx(-77.0428) and bbox[2] == pytest.approx(-71.5375)
        # __geo_interface__ makes it interoperable with GeoJSON tooling.
        geo = reader.shapeRecord(2).__geo_interface__
        assert geo["geometry"]["type"] == "Point" and geo["properties"]["nombre"] == "Arequipa"


@pytest.mark.covers("geojson")
def test_geojson_feature_collection_validity(out):
    import geojson

    lima = geojson.Point((LIMA[1], LIMA[0]))
    cusco = geojson.Point((CUSCO[1], CUSCO[0]))
    route = geojson.LineString([(LIMA[1], LIMA[0]), (CUSCO[1], CUSCO[0])])
    ring = list(LIMA_POLYGONS["Miraflores"])
    ring.append(ring[0])
    polygon = geojson.Polygon([ring])
    for geometry in (lima, cusco, route, polygon):
        assert geometry.is_valid, geometry.errors()

    collection = geojson.FeatureCollection([
        geojson.Feature(geometry=lima, properties={"ciudad": "Lima", "región": "Costa"}, id=1),
        geojson.Feature(geometry=cusco, properties={"ciudad": "Cusco", "región": "Sierra"}, id=2),
        geojson.Feature(geometry=route, properties={"nombre": "Vuelo Lima–Cusco"}),
        geojson.Feature(geometry=polygon, properties={"distrito": "Miraflores"}),
    ])
    assert collection.is_valid, collection.errors()
    assert len(collection["features"]) == 4

    path = out / "lugares.geojson"
    path.write_text(geojson.dumps(collection, ensure_ascii=False, indent=2), encoding="utf-8")
    back = geojson.loads(path.read_text(encoding="utf-8"))
    assert isinstance(back, geojson.FeatureCollection) and back.is_valid
    assert back["features"][1]["properties"]["región"] == "Sierra"
    assert back["features"][1]["geometry"]["coordinates"] == [CUSCO[1], CUSCO[0]]
    assert [c for c in geojson.utils.coords(back["features"][2])] == [(LIMA[1], LIMA[0]), (CUSCO[1], CUSCO[0])]

    # Invalid geometries are flagged, not silently accepted.
    bad = geojson.Point((-77.0,))  # a position needs at least two numbers
    assert not bad.is_valid and bad.errors()
    assert not geojson.Polygon([[(0, 0), (1, 0), (1, 1)]]).is_valid  # unclosed ring, < 4 positions
    assert not geojson.LineString([(0, 0)]).is_valid  # a line needs two positions


@pytest.mark.covers("rtree")
def test_rtree_nearest_query():
    import rtree
    from rtree import index

    assert tuple(int(p) for p in rtree.__version__.split(".")[:2]) >= (1, 2)
    idx = index.Index()
    cities = {
        0: ("Lima", LIMA[1], LIMA[0]),
        1: ("Cusco", CUSCO[1], CUSCO[0]),
        2: ("Arequipa", -71.5375, -16.4090),
        3: ("Trujillo", -79.0290, -8.1120),
        4: ("Iquitos", -73.2516, -3.7437),
    }
    for cid, (_, lon, lat) in cities.items():
        idx.insert(cid, (lon, lat, lon, lat), obj=cities[cid][0])
    assert idx.count(idx.bounds) == 5

    # Nearest to Callao (just west of Lima) is Lima.
    nearest = list(idx.nearest((-77.12, -12.05, -77.12, -12.05), 1))
    assert nearest == [0]
    # Two nearest to Puno (far south, near Arequipa then Cusco).
    two = list(idx.nearest((-70.02, -15.84, -70.02, -15.84), 2, objects=True))
    assert [hit.object for hit in two] == ["Arequipa", "Cusco"]
    # Bounding-box intersection: only the northern cities.
    north = sorted(idx.intersection((-80, -9, -72, -3)))
    assert north == [3, 4]
    # Deleting an entry removes it from queries.
    idx.delete(0, (LIMA[1], LIMA[0], LIMA[1], LIMA[0]))
    assert list(idx.nearest((-77.12, -12.05, -77.12, -12.05), 1)) != [0]
