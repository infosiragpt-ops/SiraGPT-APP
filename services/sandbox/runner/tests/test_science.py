"""Area "science": statistics, time series, symbolic maths, units, graphs,
astronomy, bioinformatics, chemistry and discrete-event simulation.

Each test computes something with a known answer (a slope of 2, a median
survival time, ethanol's molecular weight, a Hamming distance…) and asserts
it numerically; where the library writes files (FITS, FASTA, PNG) the file is
reopened in ``out``. Heavy imports stay inside the tests.
"""
from __future__ import annotations

import math
import warnings

import pytest


def _xy(n=60, slope=2.0, intercept=1.0, noise=0.05, seed=0):
    import numpy as np
    rng = np.random.default_rng(seed)
    x = np.linspace(0, 10, n)
    return x, intercept + slope * x + rng.normal(0, noise, n)


@pytest.mark.covers("scipy")
def test_scipy_regression_integration_optimisation():
    import numpy as np
    from scipy import integrate, optimize, stats
    x, y = _xy()
    fit = stats.linregress(x, y)
    assert fit.slope == pytest.approx(2.0, abs=0.02)
    assert fit.intercept == pytest.approx(1.0, abs=0.05)
    assert fit.rvalue > 0.999
    area, _ = integrate.quad(np.sin, 0, np.pi)
    assert area == pytest.approx(2.0)
    root = optimize.brentq(lambda t: t**3 - 2, 0, 2)
    assert root == pytest.approx(2 ** (1 / 3))
    res = optimize.minimize(lambda v: (v[0] - 3) ** 2 + (v[1] + 1) ** 2, [0, 0])
    assert np.allclose(res.x, [3, -1], atol=1e-4)
    t = stats.ttest_ind([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])
    assert t.statistic == pytest.approx(-5.0) and t.pvalue == pytest.approx(0.0010528, abs=1e-6)


@pytest.mark.covers("statsmodels")
def test_statsmodels_ols_summary():
    import statsmodels.api as sm
    x, y = _xy()
    model = sm.OLS(y, sm.add_constant(x)).fit()
    assert model.params[1] == pytest.approx(2.0, abs=0.02)
    assert model.params[0] == pytest.approx(1.0, abs=0.05)
    assert model.rsquared > 0.999
    assert model.pvalues[1] < 1e-10
    assert "OLS Regression Results" in str(model.summary())


@pytest.mark.covers("pingouin")
def test_pingouin_ttest_dataframe():
    import pingouin as pg
    a = [5.1, 4.9, 5.3, 5.0, 5.2, 4.8, 5.1, 5.0]
    b = [6.0, 6.2, 5.9, 6.1, 6.3, 5.8, 6.0, 6.1]
    result = pg.ttest(a, b)
    # pingouin 0.5 names the column "p-val"; 0.7 renamed it "p_val" (and "cohen-d" -> "cohen_d").
    pcol = "p-val" if "p-val" in result.columns else "p_val"
    assert pcol in result.columns and ({"cohen-d", "cohen_d"} & set(result.columns))
    assert float(result[pcol].iloc[0]) < 1e-6
    assert float(result["T"].iloc[0]) < 0
    corr = pg.corr(list(range(10)), [2 * v + 1 for v in range(10)])
    assert float(corr["r"].iloc[0]) == pytest.approx(1.0)


@pytest.mark.covers("scikit_posthocs")
def test_scikit_posthocs_dunn_matrix():
    import numpy as np
    import scikit_posthocs as sp
    rng = np.random.default_rng(1)
    groups = [rng.normal(0, 1, 20), rng.normal(0, 1, 20), rng.normal(4, 1, 20)]
    p = sp.posthoc_dunn(groups, p_adjust="holm")
    assert p.shape == (3, 3)
    assert np.allclose(np.diag(p.values), 1.0)
    assert p.iloc[0, 1] > 0.05 and p.iloc[0, 2] < 0.01 and p.iloc[1, 2] < 0.01


@pytest.mark.covers("lifelines")
def test_lifelines_kaplan_meier_median():
    from lifelines import KaplanMeierFitter
    durations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    observed = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    km = KaplanMeierFitter().fit(durations, event_observed=observed)
    assert km.median_survival_time_ == 5.0  # S(5) = 0.5 exactly with no censoring
    assert float(km.survival_function_at_times(3).iloc[0]) == pytest.approx(0.7)
    censored = KaplanMeierFitter().fit([2, 4, 6, 8, 10, 12], event_observed=[1, 1, 0, 1, 0, 1])
    assert censored.median_survival_time_ == 8.0


@pytest.mark.covers("linearmodels")
def test_linearmodels_panel_and_iv():
    import numpy as np
    import pandas as pd
    from linearmodels.iv import IV2SLS
    from linearmodels.panel import PanelOLS
    rng = np.random.default_rng(2)
    entities, periods = 20, 8
    idx = pd.MultiIndex.from_product([range(entities), range(periods)], names=["entidad", "tiempo"])
    effect = np.repeat(rng.normal(size=entities), periods)
    x = rng.normal(size=len(idx))
    y = 3.0 * x + effect + rng.normal(0, 0.1, len(idx))
    panel = pd.DataFrame({"y": y, "x": x}, index=idx)
    fe = PanelOLS(panel["y"], panel[["x"]], entity_effects=True).fit()
    assert fe.params["x"] == pytest.approx(3.0, abs=0.05)

    n = 2000
    z = rng.normal(size=n)
    u = rng.normal(size=n)
    x_endog = z + u + rng.normal(0, 0.3, n)
    y_iv = 1.5 * x_endog + u  # OLS is biased upward; IV recovers 1.5
    frame = pd.DataFrame({"y": y_iv, "x": x_endog, "z": z, "const": 1.0})
    iv = IV2SLS(frame["y"], frame[["const"]], frame[["x"]], frame[["z"]]).fit()
    assert iv.params["x"] == pytest.approx(1.5, abs=0.1)


@pytest.mark.covers("arch")
def test_arch_garch_fit():
    import numpy as np
    from arch import arch_model
    rng = np.random.default_rng(3)
    returns = rng.standard_t(5, size=400) * 0.01 * 100
    model = arch_model(returns, vol="GARCH", p=1, q=1, mean="Constant")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        res = model.fit(disp="off", show_warning=False)
    assert {"omega", "alpha[1]", "beta[1]"} <= set(res.params.index)
    assert res.params["alpha[1]"] >= 0 and res.params["beta[1]"] >= 0
    assert math.isfinite(res.loglikelihood)
    forecast = res.forecast(horizon=3)
    assert forecast.variance.shape[1] == 3 and (forecast.variance.values > 0).all()


@pytest.mark.covers("pmdarima")
def test_pmdarima_auto_arima_forecast_length():
    import numpy as np
    import pmdarima as pm
    rng = np.random.default_rng(4)
    series = 10 + 0.5 * np.arange(60) + rng.normal(0, 0.5, 60)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model = pm.auto_arima(series, seasonal=False, suppress_warnings=True, error_action="ignore",
                              stepwise=True, max_p=2, max_q=2, max_d=2)
    forecast = model.predict(n_periods=5)
    assert len(forecast) == 5
    assert np.all(np.isfinite(forecast))
    # A linear trend continues: forecasts sit around 40 and climb.
    assert 36 < float(np.asarray(forecast)[0]) < 44
    assert float(np.asarray(forecast)[-1]) > float(np.asarray(forecast)[0]) - 1.0


@pytest.mark.covers("sympy")
def test_sympy_solve_integrate_latex():
    import sympy as sp
    x = sp.symbols("x")
    assert set(sp.solve(x**2 - 5 * x + 6, x)) == {2, 3}
    assert sp.integrate(x**2, (x, 0, 3)) == 9
    assert sp.integrate(sp.exp(-x**2), (x, -sp.oo, sp.oo)) == sp.sqrt(sp.pi)
    assert sp.diff(sp.sin(x) * x, x) == x * sp.cos(x) + sp.sin(x)
    assert sp.latex(sp.Integral(x**2, x)) == r"\int x^{2}\, dx"
    assert sp.limit(sp.sin(x) / x, x, 0) == 1
    m = sp.Matrix([[2, 1], [1, 3]])
    assert m.det() == 5 and m.inv() * m == sp.eye(2)


@pytest.mark.covers("uncertainties")
def test_uncertainties_propagation():
    from uncertainties import ufloat, umath
    a = ufloat(10.0, 0.5)
    b = ufloat(4.0, 0.3)
    s = a + b
    assert s.nominal_value == 14.0 and s.std_dev == pytest.approx(math.hypot(0.5, 0.3))
    p = a * b
    assert p.std_dev == pytest.approx(math.hypot(4.0 * 0.5, 10.0 * 0.3))
    assert (a - a).std_dev == 0.0  # correlated terms cancel
    r = umath.sqrt(a)
    assert r.nominal_value == pytest.approx(math.sqrt(10)) and r.std_dev == pytest.approx(0.5 / (2 * math.sqrt(10)))


@pytest.mark.covers("pint")
def test_pint_unit_conversions():
    import pint
    ureg = pint.UnitRegistry()
    assert (3 * ureg.kilometer).to(ureg.meter).magnitude == 3000
    speed = (90 * ureg.kilometer / ureg.hour).to(ureg.meter / ureg.second)
    assert speed.magnitude == pytest.approx(25.0)
    energy = (2 * ureg.kilogram * (3 * ureg.meter / ureg.second) ** 2 / 2).to(ureg.joule)
    assert energy.magnitude == pytest.approx(9.0)
    temp = ureg.Quantity(100, ureg.degC).to(ureg.kelvin)
    assert temp.magnitude == pytest.approx(373.15)
    with pytest.raises(pint.DimensionalityError):
        (1 * ureg.meter).to(ureg.second)
    assert f"{(1.5 * ureg.liter):~P}" == "1.5 l" or "l" in f"{(1.5 * ureg.liter):~}"


@pytest.mark.covers("networkx")
def test_networkx_shortest_path_and_centrality(out):
    import networkx as nx
    g = nx.Graph()
    g.add_weighted_edges_from([("A", "B", 1), ("B", "C", 2), ("A", "C", 5), ("C", "D", 1), ("B", "D", 4)])
    assert nx.shortest_path(g, "A", "D", weight="weight") == ["A", "B", "C", "D"]
    assert nx.shortest_path_length(g, "A", "D", weight="weight") == 4
    assert nx.is_connected(g) and nx.number_connected_components(g) == 1
    degree = nx.degree_centrality(g)
    assert degree["B"] == degree["C"] == 1.0
    tree = nx.minimum_spanning_tree(g)
    assert tree.size(weight="weight") == 4
    path = out / "grafo.graphml"
    nx.write_graphml(g, path)
    again = nx.read_graphml(path)
    assert set(again.nodes) == {"A", "B", "C", "D"} and again.number_of_edges() == 5


@pytest.mark.covers("astropy")
def test_astropy_units_coordinates_fits_table(out):
    import astropy.units as u
    import numpy as np
    from astropy.coordinates import SkyCoord
    from astropy.io import fits
    from astropy.table import Table
    assert (1 * u.parsec).to(u.lightyear).value == pytest.approx(3.26156, rel=1e-4)
    assert (300 * u.km / u.s).to(u.m / u.s).value == 300_000
    c1 = SkyCoord(ra=10 * u.deg, dec=0 * u.deg)
    c2 = SkyCoord(ra=11 * u.deg, dec=0 * u.deg)
    assert c1.separation(c2).deg == pytest.approx(1.0)
    pole = SkyCoord(ra=0 * u.deg, dec=90 * u.deg)
    assert pole.separation(c1).deg == pytest.approx(90.0)

    table = Table({"estrella": ["Sirio", "Vega", "Alnilam"], "mag": np.array([-1.46, 0.03, 1.69])})
    path = out / "estrellas.fits"
    table.write(path, format="fits", overwrite=True)
    with fits.open(path) as hdul:
        assert len(hdul) == 2 and hdul[1].header["NAXIS2"] == 3
        assert list(hdul[1].data["estrella"]) == ["Sirio", "Vega", "Alnilam"]
    again = Table.read(path)
    assert float(again["mag"].min()) == pytest.approx(-1.46)


@pytest.mark.covers("Bio")
def test_biopython_sequences_fasta_alignment(out):
    from Bio import SeqIO
    from Bio.Align import PairwiseAligner
    from Bio.Seq import Seq
    from Bio.SeqRecord import SeqRecord
    dna = Seq("ATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAG")
    assert str(dna.reverse_complement()) == "CTATCGGGCACCCTTTCAGCGGCCCATTACAATGGCCAT"
    assert str(dna.translate(to_stop=True)) == "MAIVMGR"
    assert str(dna.transcribe()).startswith("AUGGCC")
    records = [SeqRecord(dna, id="gen1", description="secuencia de prueba"),
               SeqRecord(Seq("GATTACA"), id="gen2", description="corta")]
    path = out / "secuencias.fasta"
    assert SeqIO.write(records, path, "fasta") == 2
    text = path.read_text()
    assert text.startswith(">gen1 secuencia de prueba\n")
    back = {r.id: r for r in SeqIO.parse(path, "fasta")}
    assert str(back["gen2"].seq) == "GATTACA" and len(back["gen1"].seq) == len(dna)

    aligner = PairwiseAligner()
    aligner.mode = "global"
    aligner.match_score, aligner.mismatch_score = 1, 0
    assert aligner.score("GATTACA", "GATTACA") == 7
    # Hamming distance of two equal-length strings.
    hamming = sum(a != b for a, b in zip("GATTACA", "GACTATA"))
    assert hamming == 2


@pytest.mark.covers("rdkit")
def test_rdkit_ethanol_properties_and_depiction(out, check):
    from rdkit import Chem
    from rdkit.Chem import Descriptors, Draw
    mol = Chem.MolFromSmiles("CCO")
    assert mol is not None and mol.GetNumAtoms() == 3
    assert Descriptors.MolWt(mol) == pytest.approx(46.07, abs=0.01)
    assert Chem.MolToSmiles(mol) == "CCO"
    assert Chem.rdMolDescriptors.CalcMolFormula(mol) == "C2H6O"
    aspirin = Chem.MolFromSmiles("CC(=O)Oc1ccccc1C(=O)O")
    assert Descriptors.MolWt(aspirin) == pytest.approx(180.16, abs=0.01)
    assert aspirin.HasSubstructMatch(Chem.MolFromSmarts("C(=O)O"))
    png = out / "etanol.png"
    Draw.MolToFile(mol, str(png), size=(300, 200))
    (width, height), _ = check.image(png)
    assert (width, height) == (300, 200)
    check.nonempty(png, 500)


@pytest.mark.covers("simpy")
def test_simpy_single_server_queue():
    import simpy
    env = simpy.Environment()
    server = simpy.Resource(env, capacity=1)
    log = []

    def customer(name, arrival, service):
        yield env.timeout(arrival)
        with server.request() as req:
            yield req
            start = env.now
            yield env.timeout(service)
            log.append((name, start, env.now))

    for i, (arrival, service) in enumerate([(0, 5), (1, 3), (2, 2)]):
        env.process(customer(f"c{i}", arrival, service))
    env.run()
    # c0 serves 0-5, c1 waits until 5 and serves 5-8, c2 serves 8-10.
    assert log == [("c0", 0, 5), ("c1", 5, 8), ("c2", 8, 10)]
    assert env.now == 10
