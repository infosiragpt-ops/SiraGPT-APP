#!/usr/bin/env python3
"""Fail the image build when capabilities.json promises something the image lacks.

Runs at build time (Dockerfile), in CI and against the live sandbox before a
production publish. Every python[].import must import, every cli[].bin must
be on PATH, every node[] module must resolve from the global npm root, every
NLTK data package in python_data.nltk must be findable and every spaCy model
in python_data.spacy_models must load. Prints one line per failure and exits
1; the functional proof of each entry is the pytest suite in tests/.
"""
import importlib
import json
import os
import shutil
import subprocess
import sys

CATALOG = os.environ.get("SIRA_CAPABILITIES", "/opt/sira/capabilities.json")

# nltk.downloader package id -> a resource path nltk.data.find() understands.
NLTK_RESOURCE = {
    "punkt": "tokenizers/punkt",
    "punkt_tab": "tokenizers/punkt_tab",
    "stopwords": "corpora/stopwords",
    "wordnet": "corpora/wordnet",
    "omw-1.4": "corpora/omw-1.4",
    "omw-2.0": "corpora/omw-2.0",
    "cmudict": "corpora/cmudict",
    "averaged_perceptron_tagger_eng": "taggers/averaged_perceptron_tagger_eng",
    "vader_lexicon": "sentiment/vader_lexicon",
    "snowball_data": "stemmers/snowball_data",
}


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
    data = catalog.get("python_data", {})
    if data.get("nltk"):
        try:
            import nltk  # noqa: PLC0415
            for package in data["nltk"]:
                resource = NLTK_RESOURCE.get(package)
                if resource is None:
                    failures.append(f"nltk data {package}: no resource path known to verify_env.py")
                    continue
                try:
                    nltk.data.find(resource)
                except LookupError:
                    failures.append(f"nltk data {package} ({resource}) not found under {os.environ.get('NLTK_DATA', 'nltk default paths')}")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"nltk unavailable to verify data: {exc!r}")
    for model in data.get("spacy_models", []):
        try:
            import spacy  # noqa: PLC0415
            spacy.load(model)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"spacy model {model}: {exc!r}")
    for line in failures:
        print(f"MISSING {line}", file=sys.stderr)
    if failures:
        return 1
    print(
        f"SIRA_ENV_OK python={len(catalog['python'])} cli={len(catalog['cli'])} node={len(catalog['node'])} "
        f"nltk={len(data.get('nltk', []))} spacy_models={len(data.get('spacy_models', []))}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
