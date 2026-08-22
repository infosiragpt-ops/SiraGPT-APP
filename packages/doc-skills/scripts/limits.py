#!/usr/bin/env python3
"""Shared safety limits for the isolated doc-engine sandbox.

These numbers are the contract the control plane tests against.
Do not raise them without updating the tests and docs/doc-engine.md.
"""
from __future__ import annotations

MAX_ENTRIES = 5000
MAX_UNCOMPRESSED = 200 * 1024 * 1024  # 200 MiB
MAX_SINGLE_ENTRY = 80 * 1024 * 1024
CONTENT_TYPES = "[Content_Types].xml"
SOFFICE_TIMEOUT_SEC = 90
PDFTOPPM_DPI = 110
FIXED_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
SANDBOX_UID = 10001
WORKSPACE_TMPFS_BYTES = 536_870_912
