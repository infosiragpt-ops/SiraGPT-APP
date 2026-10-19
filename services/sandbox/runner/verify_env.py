#!/usr/bin/env python3
"""Fail the image build when capabilities.json promises something the image lacks.

Runs at build time (Dockerfile) and again in CI. Every python[].import must
import, every cli[].bin must be on PATH and every node[] module must resolve
from the global npm root. Prints one line per failure and exits 1.
"""
import importlib
import json
import os
import shutil
import subprocess
import sys

CATALOG = os.environ.get("SIRA_CAPABILITIES", "/opt/sira/capabilities.json")


def main() -> int:
    with open(CATALOG, encoding="utf-8") as handle:
        catalog = json.load(handle)
    failures = []
    for entry in catalog["python"]:
        try:
            importlib.import_module(entry["import"])
        except Exception as exc:  # noqa: BLE001 - report every broken import
            failures.append(f"python import {entry['import']} ({entry['pip']}): {exc!r}")
    for entry in catalog["cli"]:
        if shutil.which(entry["bin"]) is None:
            failures.append(f"cli {entry['bin']} not on PATH")
    for module in catalog["node"]:
        probe = subprocess.run(
            ["node", "-e", f"require.resolve({json.dumps(module)})"],
            capture_output=True, text=True, check=False,
        )
        if probe.returncode != 0:
            failures.append(f"node module {module} does not resolve: {probe.stderr.strip()[:200]}")
    for line in failures:
        print(f"MISSING {line}", file=sys.stderr)
    if failures:
        return 1
    print(f"SIRA_ENV_OK python={len(catalog['python'])} cli={len(catalog['cli'])} node={len(catalog['node'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
