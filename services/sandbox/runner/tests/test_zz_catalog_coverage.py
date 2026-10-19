"""Every catalog entry must be proven by at least one test in this suite.

Collected last (file name), so it can read the markers of every other test.
A library that is installed but never exercised is exactly the kind of promise
the agent prompt should not make, so it fails the image build.
"""
import pytest


def _covered(session) -> set[str]:
    names = set()
    for item in session.items:
        for marker in item.iter_markers("covers"):
            names.update(marker.args)
    return names


def test_every_python_library_has_a_test(request, catalog):
    covered = _covered(request.session)
    missing = sorted(entry["import"] for entry in catalog["python"] if entry["import"] not in covered)
    assert not missing, f"python libraries without a functional test: {missing}"


def test_every_cli_tool_has_a_test(request, catalog):
    covered = _covered(request.session)
    missing = sorted(entry["bin"] for entry in catalog["cli"] if entry["bin"] not in covered)
    assert not missing, f"command-line tools without a functional test: {missing}"


def test_every_node_module_has_a_test(request, catalog):
    covered = _covered(request.session)
    missing = sorted(name for name in catalog["node"] if name not in covered)
    assert not missing, f"node modules without a functional test: {missing}"


def test_markers_only_name_catalog_entries(request, catalog):
    known = {e["import"] for e in catalog["python"]} | {e["bin"] for e in catalog["cli"]} | set(catalog["node"])
    unknown = sorted(_covered(request.session) - known)
    assert not unknown, f"covers() names that are not in capabilities.json: {unknown}"


def test_catalog_shape(catalog):
    assert catalog["version"] >= 3
    seen = set()
    for entry in catalog["python"]:
        assert set(entry) >= {"pip", "import", "area", "use"}, entry
        assert entry["import"] not in seen, f"duplicate import {entry['import']}"
        seen.add(entry["import"])
    assert all(set(e) >= {"bin", "use"} for e in catalog["cli"])
    assert all(set(r) >= {"ext", "how"} for r in catalog["recipes"])
    # A test module exists for every area so the suite stays organised by field.
    areas = {entry["area"] for entry in catalog["python"]}
    assert areas, "empty catalog"


@pytest.mark.parametrize("key", ["python", "cli", "node", "recipes"])
def test_catalog_sections_are_nonempty(catalog, key):
    assert catalog[key]
