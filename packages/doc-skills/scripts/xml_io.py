#!/usr/bin/env python3
"""Secure XML I/O for OOXML parts.

Never resolve entities, DTDs, XInclude or network. pretty_print is forbidden
so lexical bytes of preserved regions (terminal w:sectPr) stay intact.
"""
from __future__ import annotations

import os
from io import BytesIO

from lxml import etree

_SECURE_PARSER = etree.XMLParser(
    resolve_entities=False,
    no_network=True,
    dtd_validation=False,
    load_dtd=False,
    huge_tree=False,
    remove_blank_text=False,
    remove_comments=False,
    remove_pis=False,
    recover=False,
)


def secure_parser() -> etree.XMLParser:
    # Fresh parser per call so a poison document cannot taint later parses.
    return etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        dtd_validation=False,
        load_dtd=False,
        huge_tree=False,
        remove_blank_text=False,
        remove_comments=False,
        remove_pis=False,
        recover=False,
    )


def parse_xml_bytes(data: bytes) -> etree._ElementTree:
    if not data:
        raise ValueError("empty XML")
    # Block classic XXE payloads before they reach the parser.
    head = data[:400].lower()
    if b"<!entity" in head or b"<!doctype" in head:
        raise ValueError("DTD / entity declarations are not allowed")
    return etree.parse(BytesIO(data), secure_parser())


def parse_xml_file(path: str) -> etree._ElementTree:
    with open(path, "rb") as fh:
        return parse_xml_bytes(fh.read())


def write_xml(tree: etree._ElementTree, path: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    tree.write(
        path,
        xml_declaration=True,
        encoding="UTF-8",
        standalone=True,
        pretty_print=False,
    )
