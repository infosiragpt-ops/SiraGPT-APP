"""Shared fixtures for the sandbox image test suite.

The suite is the proof behind capabilities.json: every library, command-line
tool and Node module the agent is told about must do real work here, offline,
as the unprivileged ``sandbox`` user. Each test produces a file (or a result)
and reopens or checks it with an independent reader; a test marked
``@pytest.mark.covers("ezdxf")`` vouches for that catalog entry, and
``test_zz_catalog_coverage.py`` fails when any entry is left without a test.

Run inside the image:  python3 -m pytest -q -p no:cacheprovider /opt/sira/tests
Run on a workstation:  SIRA_CAPABILITIES=services/sandbox/runner/capabilities.json \
                       SIRA_TESTS_SKIP_MISSING=1 python3 -m pytest services/sandbox/runner/tests
(SIRA_TESTS_SKIP_MISSING skips tests whose library or binary is absent; the
image build never sets it, so there a missing dependency is a failure.)
"""
from __future__ import annotations

import importlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
DEFAULT_CATALOG = Path("/opt/sira/capabilities.json")
REPO_CATALOG = HERE.parent / "capabilities.json"
SKIP_MISSING = os.environ.get("SIRA_TESTS_SKIP_MISSING") == "1"


def catalog_path() -> Path:
    env = os.environ.get("SIRA_CAPABILITIES")
    if env:
        return Path(env)
    return DEFAULT_CATALOG if DEFAULT_CATALOG.exists() else REPO_CATALOG


def load_catalog() -> dict:
    with catalog_path().open(encoding="utf-8") as handle:
        return json.load(handle)


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "covers(*names): catalog entries (python import names, cli binaries, node modules) this test proves",
    )


def pytest_sessionfinish(session, exitstatus):
    if exitstatus == 0:
        passed = getattr(session, "testscollected", 0) - getattr(session, "testsfailed", 0)
        print(f"\nSIRA_TESTS_OK passed={passed}")


def pytest_runtest_setup(item):
    """Outside the image, skip tests whose dependencies are not installed."""
    if not SKIP_MISSING:
        return
    catalog = item.session.config._sira_catalog  # noqa: SLF001 - set in pytest_sessionstart
    bins = {entry["bin"] for entry in catalog["cli"]}
    imports = {entry["import"] for entry in catalog["python"]}
    for marker in item.iter_markers("covers"):
        for name in marker.args:
            if name in bins and shutil.which(name) is None:
                pytest.skip(f"{name} not on PATH")
            if name in imports:
                try:
                    importlib.import_module(name)
                except Exception as exc:  # noqa: BLE001
                    pytest.skip(f"{name} not importable: {exc!r}")
            if name in catalog["node"]:
                probe = subprocess.run(["node", "-e", f"require.resolve({json.dumps(name)})"],
                                       capture_output=True, text=True, check=False)
                if probe.returncode != 0:
                    pytest.skip(f"node module {name} missing")


def pytest_sessionstart(session):
    session.config._sira_catalog = load_catalog()  # noqa: SLF001


@pytest.fixture(scope="session")
def catalog():
    return load_catalog()


@pytest.fixture
def out(tmp_path):
    """A fresh writable directory for the files one test produces."""
    return tmp_path


class Check:
    """Independent readers the tests use to prove a file is real."""

    @staticmethod
    def nonempty(path, minimum=64):
        size = os.path.getsize(path)
        assert size >= minimum, f"{os.path.basename(str(path))} is only {size} bytes"
        return size

    @staticmethod
    def pdf_pages(path) -> int:
        from pypdf import PdfReader
        return len(PdfReader(str(path)).pages)

    @staticmethod
    def pdf_text(path) -> str:
        from pypdf import PdfReader
        return "\n".join((page.extract_text() or "") for page in PdfReader(str(path)).pages)

    @staticmethod
    def image(path):
        from PIL import Image
        with Image.open(path) as img:
            img.load()
            return img.size, img.mode

    @staticmethod
    def run(cmd, timeout=180, **kwargs):
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False, **kwargs)
        if done.returncode != 0:
            raise AssertionError(f"{cmd[0]} exit {done.returncode}: {(done.stderr or done.stdout).strip()[:600]}")
        return done

    @staticmethod
    def soffice(args, work, timeout=240):
        """LibreOffice headless with a throwaway profile (parallel-safe)."""
        profile = Path(work) / ".lo-profile"
        profile.mkdir(exist_ok=True)
        return Check.run(["soffice", f"-env:UserInstallation=file://{profile}", "--headless", *args], timeout=timeout)


@pytest.fixture(scope="session")
def check():
    return Check
