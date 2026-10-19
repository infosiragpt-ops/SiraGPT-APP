"""Area "data": tabular/columnar formats, databases, serialisation.

Every test writes a real file with one library and reads it back with an
independent reader (another library or a command-line tool), asserting the
values that came back. One dataset carries Spanish column names with accents
so Unicode round-trips are proven, not assumed. Heavy imports live inside the
tests so the module collects on a workstation without the image.
"""
from __future__ import annotations

import json
import os
import shutil
import sys

import pytest

# Spanish headers with accents and a euro sign: the Unicode fixture for the area.
COLS = ["Año", "Región", "Ventas €", "Población"]
ROWS = [
    (2022, "Andalucía", 1250.5, 8_500_000),
    (2023, "Cataluña", 1980.25, 7_700_000),
    (2024, "País Vasco", 760.0, 2_200_000),
]


def _frame():
    import pandas as pd
    return pd.DataFrame(ROWS, columns=COLS)


def _cli(name: str) -> str | None:
    """A console script: on PATH in the image, next to the interpreter in a venv."""
    found = shutil.which(name)
    if found:
        return found
    candidate = os.path.join(sys.prefix, "bin", name)
    return candidate if os.path.exists(candidate) else None


@pytest.mark.covers("numpy")
def test_numpy_linear_algebra_and_npz_roundtrip(out):
    import numpy as np
    a = np.array([[2.0, 1.0], [1.0, 3.0]])
    b = np.array([3.0, 5.0])
    x = np.linalg.solve(a, b)
    assert np.allclose(a @ x, b)
    assert np.isclose(np.linalg.det(a), 5.0)
    path = out / "matrices.npz"
    np.savez_compressed(path, a=a, x=x)
    with np.load(path) as loaded:
        assert np.allclose(loaded["a"], a)
        assert np.allclose(loaded["x"], x)
    # The float64 payload must be real bytes, not an empty archive.
    assert os.path.getsize(path) > 100


@pytest.mark.covers("pandas", "csvkit", "csvlook")
def test_pandas_csv_unicode_read_by_csvkit(out, check):
    import csvkit  # noqa: F401 - the python package ships the CLI used below
    import pandas as pd
    frame = _frame()
    path = out / "ventas.csv"
    frame.to_csv(path, index=False, encoding="utf-8")
    again = pd.read_csv(path)
    assert list(again.columns) == COLS
    assert again["Ventas €"].sum() == pytest.approx(3990.75)
    assert again.loc[2, "Región"] == "País Vasco"
    csvlook = _cli("csvlook")
    assert csvlook, "csvlook (csvkit) not installed"
    table = check.run([csvlook, str(path)]).stdout
    assert "Región" in table and "País Vasco" in table and "Año" in table
    csvstat = _cli("csvstat")
    if csvstat:
        stats = check.run([csvstat, "--sum", "-c", "Ventas €", str(path)]).stdout
        assert "3.990,75" in stats or "3,990.75" in stats or "3990.75" in stats


@pytest.mark.covers("pyarrow", "fastparquet")
def test_parquet_written_by_pyarrow_read_by_fastparquet_and_back(out):
    import fastparquet
    import pyarrow as pa
    import pyarrow.parquet as pq
    frame = _frame()
    path_a = out / "pyarrow.parquet"
    pq.write_table(pa.Table.from_pandas(frame), path_a)
    via_fp = fastparquet.ParquetFile(str(path_a)).to_pandas()
    assert list(via_fp.columns) == COLS
    assert via_fp["Población"].tolist() == [r[3] for r in ROWS]
    assert via_fp["Región"].tolist() == [r[1] for r in ROWS]

    path_b = out / "fastparquet.parquet"
    fastparquet.write(str(path_b), frame)
    via_pa = pq.read_table(path_b)
    assert via_pa.num_rows == 3
    assert via_pa.column("Ventas €").to_pylist() == pytest.approx([r[2] for r in ROWS])


@pytest.mark.covers("pyarrow")
def test_arrow_feather_ipc_roundtrip(out):
    import pyarrow as pa
    from pyarrow import feather, ipc
    table = pa.table({"id": pa.array([1, 2, 3], pa.int32()), "nombre": ["á", "é", "ñ"]})
    feather_path = out / "tabla.feather"
    feather.write_feather(table, feather_path, compression="zstd")
    back = feather.read_table(feather_path)
    assert back.equals(table)

    ipc_path = out / "tabla.arrow"
    with pa.OSFile(str(ipc_path), "wb") as sink, ipc.new_file(sink, table.schema) as writer:
        writer.write_table(table)
    with pa.memory_map(str(ipc_path)) as source:
        again = ipc.open_file(source).read_all()
    assert again.column("nombre").to_pylist() == ["á", "é", "ñ"]


@pytest.mark.covers("polars")
def test_polars_lazy_scan_csv_groupby(out):
    import polars as pl
    path = out / "pedidos.csv"
    pl.DataFrame({
        "Región": ["Norte", "Sur", "Norte", "Sur", "Centro"],
        "importe": [10.0, 20.0, 30.0, 40.0, 5.5],
    }).write_csv(path)
    lazy = pl.scan_csv(path)
    result = (
        lazy.group_by("Región")
        .agg(pl.col("importe").sum().alias("total"))
        .sort("Región")
        .collect()
    )
    assert result["Región"].to_list() == ["Centro", "Norte", "Sur"]
    assert result["total"].to_list() == [5.5, 40.0, 60.0]
    assert "SCAN" in lazy.explain().upper()  # the plan still reads from the CSV lazily


@pytest.mark.covers("duckdb")
def test_duckdb_queries_parquet_file(out):
    import duckdb
    import pyarrow as pa
    import pyarrow.parquet as pq
    path = out / "hechos.parquet"
    pq.write_table(pa.table({"categoría": ["a", "b", "a", "c"], "valor": [1, 2, 3, 4]}), path)
    con = duckdb.connect()
    rows = con.execute(
        f"SELECT \"categoría\", SUM(valor) AS total FROM read_parquet('{path.as_posix()}') "
        "GROUP BY 1 ORDER BY 1"
    ).fetchall()
    assert rows == [("a", 4), ("b", 2), ("c", 4)]
    db = out / "almacen.duckdb"
    con2 = duckdb.connect(str(db))
    con2.execute("CREATE TABLE t AS SELECT * FROM range(10) r(i)")
    assert con2.execute("SELECT SUM(i) FROM t").fetchone()[0] == 45
    con2.close()
    assert os.path.getsize(db) > 1000


@pytest.mark.covers("sqlalchemy", "sqlite3")
def test_sqlalchemy_orm_on_sqlite_file_read_by_sqlite3_cli(out, check):
    from sqlalchemy import Column, Float, Integer, String, create_engine, func, select
    from sqlalchemy.orm import DeclarativeBase, Session

    class Base(DeclarativeBase):
        pass

    # Column() instead of Mapped[] annotations: with postponed annotations the
    # declarative scan cannot resolve names defined inside a function.
    class Producto(Base):
        __tablename__ = "productos"
        id = Column(Integer, primary_key=True)
        nombre = Column(String(50))
        precio = Column(Float)

    db = out / "tienda.sqlite"
    engine = create_engine(f"sqlite:///{db}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add_all([Producto(nombre="Café", precio=3.5), Producto(nombre="Té", precio=2.25)])
        session.commit()
        total = session.scalar(select(func.sum(Producto.precio)))
        assert total == pytest.approx(5.75)
        assert session.scalar(select(Producto.nombre).where(Producto.precio < 3)) == "Té"
    engine.dispose()
    sqlite3 = shutil.which("sqlite3")
    assert sqlite3, "sqlite3 CLI missing"
    listing = check.run([sqlite3, str(db), "SELECT nombre, precio FROM productos ORDER BY id"]).stdout
    assert listing.strip().splitlines() == ["Café|3.5", "Té|2.25"]


@pytest.mark.covers("sqlite_utils")
def test_sqlite_utils_insert_and_query(out):
    import sqlite3 as sqlite3_mod

    import sqlite_utils
    path = out / "notas.db"
    db = sqlite_utils.Database(str(path))
    db["notas"].insert_all([
        {"id": 1, "título": "Primera", "puntos": 4},
        {"id": 2, "título": "Segunda", "puntos": 6},
    ], pk="id")
    assert db["notas"].count == 2
    assert {c.name for c in db["notas"].columns} == {"id", "título", "puntos"}
    rows = list(db.query("SELECT SUM(puntos) AS s FROM notas"))
    assert rows[0]["s"] == 10
    # Independent reader: the stdlib driver.
    with sqlite3_mod.connect(path) as raw:
        assert raw.execute("SELECT título FROM notas WHERE id = 2").fetchone()[0] == "Segunda"


@pytest.mark.covers("sqlparse", "sqlglot")
def test_sqlparse_format_and_sqlglot_transpile():
    import sqlglot
    import sqlparse
    ugly = "select a,b from t where a>1 and b in (select x from u) order by a"
    pretty = sqlparse.format(ugly, reindent=True, keyword_case="upper")
    assert pretty.startswith("SELECT")
    assert "\nFROM t" in pretty and "WHERE" in pretty and "ORDER BY" in pretty
    assert len(sqlparse.parse("select 1; select 2;")) == 2

    sqlite_sql = "SELECT strftime('%Y', fecha) AS anio, IFNULL(x, 0) FROM ventas LIMIT 5"
    (pg,) = sqlglot.transpile(sqlite_sql, read="sqlite", write="postgres")
    assert "COALESCE(x, 0)" in pg
    assert "strftime" not in pg.lower() or "TO_CHAR" in pg.upper()
    assert "LIMIT 5" in pg
    tree = sqlglot.parse_one("SELECT a, SUM(b) FROM t GROUP BY a")
    assert [c.name for c in tree.find_all(sqlglot.exp.Column)] == ["a", "b", "a"]


@pytest.mark.covers("h5py", "tables")
def test_hdf5_h5py_dataset_and_pandas_to_hdf(out):
    import h5py
    import numpy as np
    import pandas as pd
    import tables  # noqa: F401 - PyTables backs DataFrame.to_hdf
    path = out / "datos.h5"
    data = np.arange(24, dtype="float32").reshape(4, 6)
    with h5py.File(path, "w") as h5:
        dset = h5.create_dataset("medidas", data=data, compression="gzip")
        dset.attrs["unidad"] = "°C"
    with h5py.File(path, "r") as h5:
        back = h5["medidas"][...]
        assert back.shape == (4, 6) and back.sum() == pytest.approx(276.0)
        assert h5["medidas"].attrs["unidad"] == "°C"

    frame = _frame()
    store = out / "tabla.h5"
    frame.to_hdf(store, key="ventas", mode="w", format="table")
    again = pd.read_hdf(store, "ventas")
    pd.testing.assert_frame_equal(again, frame)
    with h5py.File(store, "r") as h5:  # independent reader sees the PyTables group
        assert "ventas" in h5 and "table" in h5["ventas"]


@pytest.mark.covers("xarray", "netCDF4", "cftime")
def test_netcdf_written_by_xarray_read_by_netcdf4(out):
    """A NetCDF climate file with a calendar-aware (cftime, 'noleap') time axis survives both readers."""
    import cftime
    import netCDF4
    import numpy as np
    import xarray as xr
    temps = np.array([[15.0, 16.5], [18.0, 20.5], [21.0, 19.0]])
    tiempo = [cftime.DatetimeNoLeap(2026, 2, 27), cftime.DatetimeNoLeap(2026, 2, 28), cftime.DatetimeNoLeap(2026, 3, 1)]
    ds = xr.Dataset(
        {"temperatura": (("tiempo", "estación"), temps)},
        coords={"tiempo": tiempo, "estación": ["Madrid", "Sevilla"]},
        attrs={"título": "Temperaturas diarias"},
    )
    path = out / "clima.nc"
    ds.to_netcdf(path, engine="netcdf4")
    with netCDF4.Dataset(path) as nc:
        assert nc.getncattr("título") == "Temperaturas diarias"
        var = nc.variables["temperatura"]
        assert var.shape == (3, 2)
        assert float(var[:].mean()) == pytest.approx(temps.mean())
        times = nc.variables["tiempo"]
        assert times.calendar == "noleap"
        decoded = cftime.num2date(times[:], units=times.units, calendar=times.calendar)
        assert [(d.month, d.day) for d in decoded] == [(2, 27), (2, 28), (3, 1)]
    again = xr.open_dataset(path, use_cftime=True)
    assert float(again["temperatura"].sel(estación="Sevilla").max()) == 20.5
    assert isinstance(again["tiempo"].values[0], cftime.DatetimeNoLeap)
    # In a noleap calendar 28 Feb + 1 day is 1 March, never 29 Feb.
    assert (again["tiempo"].values[1] + (again["tiempo"].values[2] - again["tiempo"].values[1])).day == 1
    again.close()


@pytest.mark.covers("dask")
def test_dask_dataframe_over_partitions(out):
    import dask
    import dask.dataframe as dd
    import pandas as pd
    dask.config.set(scheduler="synchronous")
    for i in range(3):
        pd.DataFrame({"grupo": ["x", "y"] * 5, "n": range(i * 10, i * 10 + 10)}).to_csv(
            out / f"parte-{i}.csv", index=False)
    ddf = dd.read_csv(str(out / "parte-*.csv"))
    assert ddf.npartitions == 3
    assert int(ddf["n"].sum().compute()) == sum(range(30))
    grouped = ddf.groupby("grupo")["n"].count().compute()
    assert grouped.loc["x"] == 15 and grouped.loc["y"] == 15
    target = out / "salida"
    ddf.to_parquet(str(target), write_index=False)
    assert dd.read_parquet(str(target))["n"].max().compute() == 29


@pytest.mark.covers("pyreadstat")
def test_pyreadstat_sav_and_dta_roundtrip(out):
    import pandas as pd
    import pyreadstat
    frame = pd.DataFrame({
        "edad": [23.0, 45.0, 31.0],
        "ciudad": ["Bogotá", "Lima", "Asunción"],
    })
    sav = out / "encuesta.sav"
    pyreadstat.write_sav(frame, str(sav), column_labels=["Edad en años", "Ciudad de residencia"])
    back, meta = pyreadstat.read_sav(str(sav))
    assert back["edad"].tolist() == [23.0, 45.0, 31.0]
    assert back["ciudad"].tolist() == ["Bogotá", "Lima", "Asunción"]
    assert meta.column_labels == ["Edad en años", "Ciudad de residencia"]
    assert pd.read_spss(sav)["edad"].sum() == 99.0  # pandas reads it too (via pyreadstat)

    dta = out / "encuesta.dta"
    pyreadstat.write_dta(frame, str(dta))
    stata = pd.read_stata(dta)  # pandas' own Stata reader: independent of pyreadstat
    assert stata["ciudad"].tolist() == ["Bogotá", "Lima", "Asunción"]
    assert stata["edad"].mean() == pytest.approx(33.0)


@pytest.mark.covers("msgpack", "orjson")
def test_msgpack_and_orjson_binary_and_json(out):
    import msgpack
    import numpy as np
    import orjson
    payload = {"nombre": "Señal", "valores": [1, 2, 3], "ok": True, "anidado": {"π": 3.14159}}
    packed = msgpack.packb(payload, use_bin_type=True)
    (out / "datos.msgpack").write_bytes(packed)
    assert msgpack.unpackb((out / "datos.msgpack").read_bytes(), raw=False) == payload

    doc = orjson.dumps({**payload, "array": np.arange(3)}, option=orjson.OPT_SERIALIZE_NUMPY)
    (out / "datos.json").write_bytes(doc)
    parsed = json.loads((out / "datos.json").read_text(encoding="utf-8"))  # stdlib reader
    assert parsed["array"] == [0, 1, 2] and parsed["anidado"]["π"] == 3.14159
    assert orjson.loads(doc)["nombre"] == "Señal"


@pytest.mark.covers("fastavro")
def test_fastavro_write_and_read_with_schema(out):
    import fastavro
    schema = fastavro.parse_schema({
        "type": "record", "name": "Cliente",
        "fields": [{"name": "id", "type": "long"}, {"name": "nombre", "type": "string"},
                   {"name": "saldo", "type": "double"}],
    })
    records = [{"id": 1, "nombre": "Ñandú S.A.", "saldo": 10.5}, {"id": 2, "nombre": "Ágora", "saldo": -3.0}]
    path = out / "clientes.avro"
    with path.open("wb") as handle:
        fastavro.writer(handle, schema, records, codec="deflate")
    with path.open("rb") as handle:
        reader = fastavro.reader(handle)
        assert reader.writer_schema["name"] == "Cliente"
        assert list(reader) == records
    assert path.read_bytes().startswith(b"Obj\x01")  # Avro container magic


@pytest.mark.covers("xmltodict")
def test_xmltodict_parse_and_unparse(out):
    import xml.etree.ElementTree as ET

    import xmltodict
    doc = {"factura": {"@número": "F-001", "cliente": "Compañía Ñ", "líneas": {"línea": [
        {"@cant": "2", "#text": "Lápiz"}, {"@cant": "1", "#text": "Cuaderno"}]}}}
    xml = xmltodict.unparse(doc, pretty=True)
    path = out / "factura.xml"
    path.write_text(xml, encoding="utf-8")
    root = ET.parse(path).getroot()  # stdlib parser as the independent reader
    assert root.tag == "factura" and root.attrib["número"] == "F-001"
    assert [e.text for e in root.iter("línea")] == ["Lápiz", "Cuaderno"]
    again = xmltodict.parse(path.read_bytes())
    assert again["factura"]["líneas"]["línea"][1]["@cant"] == "1"


@pytest.mark.covers("jsonschema", "pydantic")
def test_jsonschema_validation_and_pydantic_v2_models():
    import jsonschema
    from pydantic import BaseModel, Field, ValidationError
    schema = {"type": "object", "required": ["edad"],
              "properties": {"edad": {"type": "integer", "minimum": 0}}}
    jsonschema.validate({"edad": 30}, schema)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"edad": -1}, schema)

    class Persona(BaseModel):
        nombre: str
        edad: int = Field(ge=0)
        correo: str | None = None

    p = Persona.model_validate({"nombre": "Ana", "edad": "42"})
    assert p.edad == 42 and p.model_dump() == {"nombre": "Ana", "edad": 42, "correo": None}
    assert json.loads(p.model_dump_json())["nombre"] == "Ana"
    with pytest.raises(ValidationError) as excinfo:
        Persona.model_validate({"nombre": "Luis", "edad": -5})
    assert excinfo.value.errors()[0]["loc"] == ("edad",)
    assert Persona.model_json_schema()["required"] == ["nombre", "edad"]


@pytest.mark.covers("tabulate")
def test_tabulate_markdown_and_pandas_to_markdown():
    from tabulate import tabulate
    table = tabulate([["Ana", 3.5], ["Ñoño", 12]], headers=["Nombre", "Valor"], tablefmt="github")
    lines = table.splitlines()
    assert lines[0].startswith("| Nombre") and set(lines[1]) <= set("|-: ")
    assert "Ñoño" in lines[3]
    md = _frame().to_markdown(index=False)  # pandas delegates to tabulate
    assert md.splitlines()[0].count("|") == 5 and "País Vasco" in md


@pytest.mark.covers("jq", "yq")
def test_jq_and_yq_transform_files(out, check):
    data = {"ventas": [{"región": "Norte", "total": 10}, {"región": "Sur", "total": 32}]}
    jpath = out / "ventas.json"
    jpath.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    total = check.run(["jq", "[.ventas[].total] | add", str(jpath)]).stdout.strip()
    assert total == "42"
    names = check.run(["jq", "-r", '.ventas[]."región"', str(jpath)]).stdout.split()
    assert names == ["Norte", "Sur"]

    ypath = out / "config.yaml"
    ypath.write_text("servicio:\n  nombre: siragpt\n  puertos: [5000, 3000]\n", encoding="utf-8")
    version = check.run(["yq", "--version"]).stdout + check.run(["yq", "--version"]).stderr
    if "mikefarah" in version or "https://github.com/mikefarah" in version:
        name = check.run(["yq", ".servicio.nombre", str(ypath)]).stdout.strip()
        ports = check.run(["yq", ".servicio.puertos | length", str(ypath)]).stdout.strip()
    else:  # python-yq (jq wrapper) prints JSON
        name = check.run(["yq", "-r", ".servicio.nombre", str(ypath)]).stdout.strip()
        ports = check.run(["yq", ".servicio.puertos | length", str(ypath)]).stdout.strip()
    assert name == "siragpt" and ports == "2"


@pytest.mark.covers("bc")
def test_bc_arbitrary_precision(check):
    sqrt2 = check.run(["bc", "-l"], input="scale=30; sqrt(2)\n").stdout.strip()
    assert sqrt2.startswith("1.41421356237309504880168872420")
    big = check.run(["bc"], input="2^200\n").stdout.replace("\\\n", "").strip()
    assert big == str(2 ** 200)
