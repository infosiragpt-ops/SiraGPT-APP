#!/usr/bin/env python3
"""Turn capabilities.json into the lists the Dockerfile installs from.

Writes into the directory given as the only argument:
  requirements.txt   every python[].pip, one per line
  sdist-ok.txt       python_sdist_ok + python_sdist_ok_deps keys, comma-joined (pip --no-binary=...)
  nltk-data.txt      python_data.nltk joined by spaces (nltk.downloader)
  spacy-models.txt   one wheel URL per spaCy model of the INSTALLED spaCy
                     minor version (only meaningful after the pip step)
The catalog stays the single source of truth; nothing is listed twice.
"""
import json
import os
import sys

CATALOG = os.environ.get("SIRA_CAPABILITIES", "/opt/sira/capabilities.json")
SPACY_RELEASES = "https://github.com/explosion/spacy-models/releases/download/{model}-{version}/{model}-{version}-py3-none-any.whl"


def spacy_model_version() -> str:
    try:
        import spacy  # noqa: PLC0415 - only available after the pip step
    except ImportError:
        return ""
    major, minor = spacy.__version__.split(".")[:2]
    return f"{major}.{minor}.0"


def main() -> int:
    target = sys.argv[1]
    os.makedirs(target, exist_ok=True)
    with open(CATALOG, encoding="utf-8") as handle:
        catalog = json.load(handle)
    with open(os.path.join(target, "requirements.txt"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(entry["pip"] for entry in catalog["python"]) + "\n")
    with open(os.path.join(target, "sdist-ok.txt"), "w", encoding="utf-8") as handle:
        # Catalog entries without a wheel, plus the few pure-Python dependencies in the same situation.
        handle.write(",".join([*catalog.get("python_sdist_ok", []), *catalog.get("python_sdist_ok_deps", {})]))
    data = catalog.get("python_data", {})
    with open(os.path.join(target, "nltk-data.txt"), "w", encoding="utf-8") as handle:
        handle.write(" ".join(data.get("nltk", [])))
    version = spacy_model_version()
    with open(os.path.join(target, "spacy-models.txt"), "w", encoding="utf-8") as handle:
        if version:
            handle.write("\n".join(SPACY_RELEASES.format(model=m, version=version) for m in data.get("spacy_models", [])) + "\n")
    print(f"manifests written to {target} (spacy models for {version or 'n/a'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
