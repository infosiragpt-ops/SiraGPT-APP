"""Areas "ml", "optimization" and "finance".

Models train on tiny synthetic datasets with fixed seeds and must beat a
stated accuracy; solvers must reach a known optimum; financial functions must
return textbook values (the IRR of a known cash flow, Black-Scholes NPV, a par
bond priced at 100). Heavy imports stay inside the tests so the module
collects without the image; every test stays well under 30 s.
"""
from __future__ import annotations

import json
import sys
from datetime import date

import pytest


def _classification(n=400, seed=0):
    from sklearn.datasets import make_classification
    return make_classification(n_samples=n, n_features=8, n_informative=5, n_redundant=1,
                               random_state=seed, class_sep=1.5)


# --- ml ---------------------------------------------------------------------

@pytest.mark.covers("sklearn")
def test_sklearn_pipeline_regression_and_classification():
    import numpy as np
    from sklearn.linear_model import LinearRegression, LogisticRegression
    from sklearn.metrics import accuracy_score, r2_score
    from sklearn.model_selection import train_test_split
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    rng = np.random.default_rng(0)
    x = np.linspace(0, 10, 100).reshape(-1, 1)
    y = 1.0 + 2.0 * x.ravel() + rng.normal(0, 0.05, 100)
    reg = LinearRegression().fit(x, y)
    assert reg.coef_[0] == pytest.approx(2.0, abs=0.02)
    assert reg.intercept_ == pytest.approx(1.0, abs=0.05)
    assert r2_score(y, reg.predict(x)) > 0.999

    features, labels = _classification()
    xtr, xte, ytr, yte = train_test_split(features, labels, test_size=0.25, random_state=0)
    pipe = make_pipeline(StandardScaler(), LogisticRegression(max_iter=500)).fit(xtr, ytr)
    assert accuracy_score(yte, pipe.predict(xte)) > 0.85


@pytest.mark.covers("lightgbm")
def test_lightgbm_classifier_accuracy():
    import lightgbm as lgb
    from sklearn.metrics import accuracy_score
    from sklearn.model_selection import train_test_split
    features, labels = _classification()
    xtr, xte, ytr, yte = train_test_split(features, labels, test_size=0.25, random_state=0)
    clf = lgb.LGBMClassifier(n_estimators=60, num_leaves=15, verbose=-1, n_jobs=1, random_state=0)
    clf.fit(xtr, ytr)
    assert accuracy_score(yte, clf.predict(xte)) > 0.8
    assert clf.booster_.num_trees() == 60


@pytest.mark.covers("xgboost")
def test_xgboost_classifier_accuracy():
    import xgboost
    from sklearn.metrics import accuracy_score
    from sklearn.model_selection import train_test_split
    features, labels = _classification()
    xtr, xte, ytr, yte = train_test_split(features, labels, test_size=0.25, random_state=0)
    clf = xgboost.XGBClassifier(n_estimators=60, max_depth=3, verbosity=0, n_jobs=1, random_state=0)
    clf.fit(xtr, ytr)
    assert accuracy_score(yte, clf.predict(xte)) > 0.8
    assert clf.get_booster().num_boosted_rounds() == 60


@pytest.mark.covers("imblearn")
def test_imblearn_smote_balances_classes():
    import numpy as np
    from imblearn.over_sampling import SMOTE
    from sklearn.datasets import make_classification
    x, y = make_classification(n_samples=300, n_features=6, n_informative=4, weights=[0.9, 0.1],
                               random_state=0)
    before = np.bincount(y)
    assert before[1] < before[0] * 0.25
    xr, yr = SMOTE(random_state=0, k_neighbors=3).fit_resample(x, y)
    after = np.bincount(yr)
    assert after[0] == after[1] == before[0]
    assert xr.shape == (2 * before[0], 6)


@pytest.mark.covers("numba")
def test_numba_njit_matches_numpy():
    import numpy as np
    from numba import njit

    @njit(cache=False)
    def total(values):
        acc = 0.0
        for v in values:
            acc += v
        return acc

    data = np.arange(1, 10_001, dtype=np.float64)
    assert total(data) == pytest.approx(data.sum())
    assert total(data) == 50_005_000.0
    assert total.signatures  # compiled at least once


@pytest.mark.covers("umap")
def test_umap_embeds_to_two_dimensions():
    import numpy as np
    import umap
    from sklearn.datasets import make_blobs
    x, y = make_blobs(n_samples=200, centers=2, n_features=10, cluster_std=0.5, random_state=0)
    reducer = umap.UMAP(n_components=2, n_neighbors=10, random_state=0, n_jobs=1)
    emb = reducer.fit_transform(x)
    assert emb.shape == (200, 2) and np.isfinite(emb).all()
    # The two blobs stay apart: centroids further than the spread of either cluster.
    c0, c1 = emb[y == 0].mean(0), emb[y == 1].mean(0)
    spread = max(emb[y == 0].std(), emb[y == 1].std())
    assert np.linalg.norm(c0 - c1) > 2 * spread


@pytest.mark.covers("hdbscan")
def test_hdbscan_finds_clusters_on_blobs():
    import hdbscan
    from sklearn.datasets import make_blobs
    x, _ = make_blobs(n_samples=240, centers=3, n_features=2, cluster_std=0.4, random_state=0)
    labels = hdbscan.HDBSCAN(min_cluster_size=15).fit_predict(x)
    found = {label for label in labels if label >= 0}
    assert len(found) >= 2
    assert (labels >= 0).mean() > 0.8  # most points assigned, little noise


@pytest.mark.covers("joblib")
def test_joblib_dump_load_model_and_parallel_map(out):
    import joblib
    from sklearn.linear_model import LogisticRegression
    features, labels = _classification(n=200)
    model = LogisticRegression(max_iter=500).fit(features, labels)
    path = out / "modelo.joblib"
    joblib.dump(model, path, compress=3)
    loaded = joblib.load(path)
    assert (loaded.predict(features) == model.predict(features)).all()
    assert path.stat().st_size > 200
    squares = joblib.Parallel(n_jobs=2, backend="threading")(joblib.delayed(lambda v: v * v)(i) for i in range(8))
    assert squares == [i * i for i in range(8)]


# --- optimization -----------------------------------------------------------

# ortools and highspy each bundle their own HiGHS shared library and resolve its
# symbols process-wide; whichever loads second fails with an undefined symbol.
# The agent runs every script in a fresh interpreter, so each solver works on
# its own - the tests mirror that by running these three in child processes.
LP_PROBLEM = """
# maximise 3x + 4y  s.t.  x + 2y <= 14, 3x - y >= 0, x - y <= 2, x, y >= 0  -> 34 at (6, 4)
"""

HIGHSPY_SCRIPT = LP_PROBLEM + """
import json, highspy
h = highspy.Highs()
h.silent()
inf = highspy.kHighsInf
x = h.addVariable(0, inf)
y = h.addVariable(0, inf)
h.addConstr(x + 2 * y <= 14)
h.addConstr(3 * x - y >= 0)
h.addConstr(x - y <= 2)
h.maximize(3 * x + 4 * y)
print(json.dumps({"status": str(h.getModelStatus()), "obj": h.getInfo().objective_function_value,
                  "x": list(h.getSolution().col_value), "version": h.version()}))
"""

PYOMO_SCRIPT = LP_PROBLEM + """
import json
import pyomo.environ as pyo
from pyomo.contrib.appsi.solvers import Highs
model = pyo.ConcreteModel()
model.x = pyo.Var(domain=pyo.NonNegativeReals)
model.y = pyo.Var(domain=pyo.NonNegativeReals)
model.obj = pyo.Objective(expr=3 * model.x + 4 * model.y, sense=pyo.maximize)
model.c1 = pyo.Constraint(expr=model.x + 2 * model.y <= 14)
model.c2 = pyo.Constraint(expr=3 * model.x - model.y >= 0)
model.c3 = pyo.Constraint(expr=model.x - model.y <= 2)
solver = Highs()
assert solver.available(), "appsi_highs not available"
result = solver.solve(model)
print(json.dumps({"term": str(result.termination_condition), "obj": pyo.value(model.obj),
                  "x": [pyo.value(model.x), pyo.value(model.y)]}))
"""

ORTOOLS_SCRIPT = LP_PROBLEM + """
import json
from ortools.linear_solver import pywraplp
from ortools.sat.python import cp_model
# Three tasks on one machine, durations 3/2/4, minimise the makespan: optimum 9.
model = cp_model.CpModel()
horizon = 20
intervals, ends = [], []
for i, d in enumerate([3, 2, 4]):
    start = model.NewIntVar(0, horizon, f"s{i}")
    end = model.NewIntVar(0, horizon, f"e{i}")
    intervals.append(model.NewIntervalVar(start, d, end, f"i{i}"))
    ends.append(end)
model.AddNoOverlap(intervals)
makespan = model.NewIntVar(0, horizon, "makespan")
model.AddMaxEquality(makespan, ends)
model.Minimize(makespan)
solver = cp_model.CpSolver()
solver.parameters.num_workers = 1
solver.parameters.max_time_in_seconds = 10
status = solver.Solve(model)
lp = pywraplp.Solver.CreateSolver("GLOP")
x = lp.NumVar(0, lp.infinity(), "x")
y = lp.NumVar(0, lp.infinity(), "y")
lp.Add(x + 2 * y <= 14)
lp.Add(3 * x - y >= 0)
lp.Add(x - y <= 2)
lp.Maximize(3 * x + 4 * y)
lp_status = lp.Solve()
print(json.dumps({"cp_optimal": status == cp_model.OPTIMAL, "makespan": solver.Value(makespan),
                  "lp_optimal": lp_status == pywraplp.Solver.OPTIMAL, "obj": lp.Objective().Value(),
                  "x": [x.solution_value(), y.solution_value()]}))
"""


def _fresh_process(check, script, cwd):
    done = check.run([sys.executable, "-c", script], cwd=str(cwd), timeout=120)
    return json.loads(done.stdout.strip().splitlines()[-1])


@pytest.mark.covers("highspy")
def test_highspy_direct_lp(out, check):
    result = _fresh_process(check, HIGHSPY_SCRIPT, out)
    assert result["status"].endswith("kOptimal")
    assert result["obj"] == pytest.approx(34.0)
    assert result["x"] == pytest.approx([6.0, 4.0])
    assert result["version"].split(".")[0] == "1"


@pytest.mark.covers("pyomo", "highspy")
def test_pyomo_lp_with_appsi_highs(out, check):
    result = _fresh_process(check, PYOMO_SCRIPT, out)
    assert result["term"].endswith("optimal")
    assert result["obj"] == pytest.approx(34.0)
    assert result["x"] == pytest.approx([6.0, 4.0])


@pytest.mark.covers("ortools")
def test_ortools_cpsat_scheduling_and_glop_lp(out, check):
    result = _fresh_process(check, ORTOOLS_SCRIPT, out)
    assert result["cp_optimal"] and result["makespan"] == 9
    assert result["lp_optimal"] and result["obj"] == pytest.approx(34.0)
    assert result["x"] == pytest.approx([6.0, 4.0])


@pytest.mark.covers("pulp")
def test_pulp_cbc_integer_program():
    import pulp
    prob = pulp.LpProblem("mochila", pulp.LpMaximize)
    items = {"a": (4, 12), "b": (2, 2), "c": (6, 4), "d": (5, 10), "e": (1, 1)}  # weight, value
    take = {k: pulp.LpVariable(f"x_{k}", cat="Binary") for k in items}
    prob += pulp.lpSum(items[k][1] * take[k] for k in items)
    prob += pulp.lpSum(items[k][0] * take[k] for k in items) <= 10
    status = prob.solve(pulp.PULP_CBC_CMD(msg=False))
    assert pulp.LpStatus[status] == "Optimal"
    assert pulp.value(prob.objective) == pytest.approx(23.0)  # a + d + e
    assert {k for k in items if take[k].value() > 0.5} == {"a", "d", "e"}


@pytest.mark.covers("cvxpy")
def test_cvxpy_least_squares_and_lp():
    import cvxpy as cp
    import numpy as np
    x = cp.Variable(2)
    constraints = [x[0] + 2 * x[1] <= 14, 3 * x[0] - x[1] >= 0, x[0] - x[1] <= 2, x >= 0]
    prob = cp.Problem(cp.Maximize(3 * x[0] + 4 * x[1]), constraints)
    # Clarabel ships with cvxpy and is its default conic solver; naming it keeps the
    # result independent of whichever other solver (HiGHS via scipy, OSQP) is on the box.
    prob.solve(solver=cp.CLARABEL)
    assert prob.status == cp.OPTIMAL
    assert prob.value == pytest.approx(34.0, abs=1e-4)
    assert np.allclose(x.value, [6.0, 4.0], atol=1e-4)

    rng = np.random.default_rng(0)
    a = rng.normal(size=(30, 3))
    truth = np.array([1.0, -2.0, 0.5])
    b = a @ truth
    beta = cp.Variable(3)
    lsq = cp.Problem(cp.Minimize(cp.sum_squares(a @ beta - b)))
    lsq.solve(solver=cp.CLARABEL)
    assert lsq.status == cp.OPTIMAL and lsq.value == pytest.approx(0.0, abs=1e-6)
    assert np.allclose(beta.value, truth, atol=1e-4)


@pytest.mark.covers("deap")
def test_deap_genetic_algorithm_improves_onemax():
    import random

    from deap import algorithms, base, creator, tools
    random.seed(7)
    if not hasattr(creator, "FitnessMaxSira"):
        creator.create("FitnessMaxSira", base.Fitness, weights=(1.0,))
        creator.create("IndividualSira", list, fitness=creator.FitnessMaxSira)
    toolbox = base.Toolbox()
    toolbox.register("attr_bool", random.randint, 0, 1)
    toolbox.register("individual", tools.initRepeat, creator.IndividualSira, toolbox.attr_bool, 30)
    toolbox.register("population", tools.initRepeat, list, toolbox.individual)
    toolbox.register("evaluate", lambda ind: (sum(ind),))
    toolbox.register("mate", tools.cxTwoPoint)
    toolbox.register("mutate", tools.mutFlipBit, indpb=0.05)
    toolbox.register("select", tools.selTournament, tournsize=3)
    pop = toolbox.population(n=40)
    for ind in pop:
        ind.fitness.values = toolbox.evaluate(ind)
    best_before = max(ind.fitness.values[0] for ind in pop)
    hof = tools.HallOfFame(1)
    algorithms.eaSimple(pop, toolbox, cxpb=0.6, mutpb=0.3, ngen=25, halloffame=hof, verbose=False)
    best_after = hof[0].fitness.values[0]
    assert best_after > best_before
    assert best_after >= 27  # out of 30 ones


# --- finance ----------------------------------------------------------------

@pytest.mark.covers("numpy_financial")
def test_numpy_financial_npv_irr_pmt():
    import numpy_financial as npf
    flows = [-100.0, 60.0, 60.0]
    irr = npf.irr(flows)
    assert irr == pytest.approx(0.130662, abs=1e-5)  # 60/(1+r) + 60/(1+r)^2 = 100
    assert npf.npv(irr, flows) == pytest.approx(0.0, abs=1e-6)
    assert npf.npv(0.10, flows) == pytest.approx(4.1322, abs=1e-3)
    payment = npf.pmt(0.05 / 12, 30 * 12, 200_000)
    assert payment == pytest.approx(-1073.64, abs=0.01)
    assert npf.fv(0.05, 10, 0, -1000) == pytest.approx(1628.89, abs=0.01)


@pytest.mark.covers("pyxirr")
def test_pyxirr_xirr_on_dated_flows():
    import pyxirr
    dates = [date(2024, 1, 1), date(2025, 1, 1), date(2026, 1, 1)]
    amounts = [-100.0, 60.0, 60.0]
    rate = pyxirr.xirr(dates, amounts)
    assert rate == pytest.approx(0.1307, abs=0.002)  # yearly spacing ≈ plain IRR
    assert pyxirr.xnpv(rate, dates, amounts) == pytest.approx(0.0, abs=1e-6)
    assert pyxirr.irr(amounts) == pytest.approx(0.130662, abs=1e-5)
    doubled = pyxirr.xirr([date(2024, 1, 1), date(2025, 1, 1)], [-100.0, 200.0])
    assert doubled == pytest.approx(1.0, abs=0.01)


@pytest.mark.covers("QuantLib")
def test_quantlib_bond_price_schedule_and_black_scholes():
    import QuantLib as ql
    today = ql.Date(15, ql.January, 2025)
    ql.Settings.instance().evaluationDate = today
    calendar = ql.NullCalendar()
    schedule = ql.Schedule(ql.Date(15, ql.January, 2025), ql.Date(15, ql.January, 2030),
                           ql.Period(ql.Annual), calendar, ql.Unadjusted, ql.Unadjusted,
                           ql.DateGeneration.Backward, False)
    assert len(list(schedule)) == 6  # 5 annual coupons + issue date
    day_count = ql.Actual360()
    assert day_count.dayCount(ql.Date(1, ql.January, 2025), ql.Date(1, ql.February, 2025)) == 31
    assert ql.Thirty360(ql.Thirty360.BondBasis).dayCount(ql.Date(1, 1, 2025), ql.Date(1, 2, 2025)) == 30

    # A 5 % annual bond discounted at a flat 5 % (same compounding/day-count) is at par.
    flat = ql.YieldTermStructureHandle(ql.FlatForward(today, 0.05, ql.SimpleDayCounter(), ql.Compounded, ql.Annual))
    bond = ql.FixedRateBond(0, 100.0, schedule, [0.05], ql.SimpleDayCounter())
    bond.setPricingEngine(ql.DiscountingBondEngine(flat))
    assert bond.cleanPrice() == pytest.approx(100.0, abs=0.01)
    assert bond.bondYield(ql.SimpleDayCounter(), ql.Compounded, ql.Annual) == pytest.approx(0.05, abs=1e-4)

    # Black-Scholes European call: S=100, K=100, r=5 %, sigma=20 %, T=1y -> 10.4506.
    spot = ql.QuoteHandle(ql.SimpleQuote(100.0))
    dc = ql.Actual365Fixed()
    rate = ql.YieldTermStructureHandle(ql.FlatForward(today, 0.05, dc))
    div = ql.YieldTermStructureHandle(ql.FlatForward(today, 0.0, dc))
    vol = ql.BlackVolTermStructureHandle(ql.BlackConstantVol(today, calendar, 0.20, dc))
    process = ql.BlackScholesMertonProcess(spot, div, rate, vol)
    maturity = today + ql.Period(365, ql.Days)
    option = ql.VanillaOption(ql.PlainVanillaPayoff(ql.Option.Call, 100.0), ql.EuropeanExercise(maturity))
    option.setPricingEngine(ql.AnalyticEuropeanEngine(process))
    assert option.NPV() == pytest.approx(10.4506, abs=0.001)
    assert option.delta() == pytest.approx(0.6368, abs=0.001)


@pytest.mark.covers("ta")
def test_ta_rsi_on_synthetic_prices():
    import numpy as np
    import pandas as pd
    import ta
    from ta.momentum import RSIIndicator
    from ta.trend import SMAIndicator
    rising = pd.Series(np.linspace(100, 160, 40))
    rsi_up = RSIIndicator(close=rising, window=14).rsi()
    assert rsi_up.iloc[-1] == pytest.approx(100.0)  # no down days at all
    falling = pd.Series(np.linspace(160, 100, 40))
    assert RSIIndicator(close=falling, window=14).rsi().iloc[-1] == pytest.approx(0.0)
    rng = np.random.default_rng(0)
    noisy = pd.Series(100 + np.cumsum(rng.normal(0, 1, 120)))
    rsi = RSIIndicator(close=noisy, window=14).rsi()
    assert rsi.isna().sum() == 14 - 1 or rsi.isna().sum() == 14
    assert rsi.dropna().between(0, 100).all()
    sma = SMAIndicator(close=rising, window=5).sma_indicator()
    assert sma.iloc[-1] == pytest.approx(rising.iloc[-5:].mean())
    frame = pd.DataFrame({"close": noisy})
    frame["rsi"] = ta.momentum.rsi(frame["close"], window=14)
    assert frame["rsi"].notna().sum() >= 100
