#!/usr/bin/env python3
"""Apply a closed visual-patch DSL. The model never supplies XML or code.

Allowed ops (JSON list):
  {"op":"replace_text","find":"...","replace":"..."}
  {"op":"set_style","styleId":"...","textEquals":"..."}

Anything that looks like XML, markup, a path, or code is rejected.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

from xml_io import parse_xml_file, write_xml

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
ALLOWED_OPS = frozenset({"replace_text", "set_style"})
FORBIDDEN = re.compile(
    r"[<>]|</|<\?xml|w:|r:id|import |exec\(|eval\(|os\.|subprocess|"
    r"__import__|javascript:|file:|\\\\|/etc/|/proc/",
    re.I,
)
SAFE_TEXT = re.compile(r"^[\w\s.,;:()%/+\-áéíóúñüÁÉÍÓÚÑÜ¿¡'\"#@]+$", re.I)
SAFE_STYLE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")


def _die(msg: str, code: int = 2) -> None:
    sys.stderr.write(f"apply_visual_patch: {msg}\n")
    raise SystemExit(code)


def _reject_payload(value: str, label: str) -> str:
    text = str(value or "")
    if not text or len(text) > 400:
        _die(f"{label} empty or too long")
    if FORBIDDEN.search(text):
        _die(f"{label} rejected: closed DSL forbids XML/code/paths")
    if not SAFE_TEXT.match(text):
        _die(f"{label} has disallowed characters")
    return text


def load_ops(raw) -> list[dict]:
    if isinstance(raw, str):
        raw = json.loads(raw)
    if isinstance(raw, dict) and "ops" in raw:
        raw = raw["ops"]
    if not isinstance(raw, list):
        _die("DSL must be a JSON list of ops or {ops:[...]}")
    if len(raw) > 32:
        _die("too many ops (max 32)")
    ops = []
    for item in raw:
        if not isinstance(item, dict):
            _die("each op must be an object")
        op = str(item.get("op") or "")
        if op not in ALLOWED_OPS:
            _die(f"unknown op '{op}'")
        extra = set(item) - {"op", "find", "replace", "styleId", "textEquals"}
        if extra:
            _die(f"unknown keys {sorted(extra)}")
        if op == "replace_text":
            ops.append({
                "op": op,
                "find": _reject_payload(item.get("find"), "find"),
                "replace": _reject_payload(item.get("replace"), "replace"),
            })
        else:
            style = str(item.get("styleId") or "")
            if not SAFE_STYLE.match(style):
                _die("styleId must be a Word style id")
            ops.append({
                "op": op,
                "styleId": style,
                "textEquals": _reject_payload(item.get("textEquals"), "textEquals"),
            })
    return ops


def _qn(local: str) -> str:
    return f"{{{W_NS}}}{local}"


def _paragraph_text(p) -> str:
    bits = []
    for t in p.iter(_qn("t")):
        if t.text:
            bits.append(t.text)
    return "".join(bits)


def apply_ops(document_xml: str, ops: list[dict]) -> int:
    tree = parse_xml_file(document_xml)
    applied = 0
    for spec in ops:
        if spec["op"] == "replace_text":
            needle, repl = spec["find"], spec["replace"]
            for t in tree.getroot().iter(_qn("t")):
                if t.text and needle in t.text:
                    t.text = t.text.replace(needle, repl)
                    applied += 1
        elif spec["op"] == "set_style":
            for p in tree.getroot().iter(_qn("p")):
                if _paragraph_text(p) != spec["textEquals"]:
                    continue
                ppr = p.find(_qn("pPr"))
                if ppr is None:
                    ppr = etree_ppr(p)
                style = ppr.find(_qn("pStyle"))
                if style is None:
                    style = etree_el(_qn("pStyle"))
                    ppr.insert(0, style)
                style.set(_qn("val"), spec["styleId"])
                applied += 1
    write_xml(tree, document_xml)
    return applied


def etree_el(tag: str):
    from lxml import etree
    return etree.Element(tag)


def etree_ppr(p):
    from lxml import etree
    ppr = etree.Element(_qn("pPr"))
    p.insert(0, ppr)
    return ppr


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Apply closed visual-patch DSL")
    p.add_argument("--document", required=True, help="path to word/document.xml")
    p.add_argument("--ops", required=True, help="JSON ops or path to JSON file")
    args = p.parse_args(argv)
    raw = args.ops
    if os.path.isfile(raw):
        raw = open(raw, "r", encoding="utf-8").read()
    ops = load_ops(raw)
    n = apply_ops(args.document, ops)
    sys.stdout.write(f"ok applied={n}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
