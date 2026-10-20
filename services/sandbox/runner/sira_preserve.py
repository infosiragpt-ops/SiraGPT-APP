"""Read-only, exhaustive protection of OOXML parts and unrequested XML values.

``verify_preservation(before, after, contract)`` accepts a version 1 contract::

    {"version": 1, "namespaces": {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"},
     "allow": [{"part": "word/document.xml",
                "xpath": "/w:document/w:body/w:p[1]/w:r[1]/w:t", "text": True}],
     "added_parts": [], "removed_parts": []}

Each selector must identify exactly one element at the SAME structural address
in both packages. It permits only that element's direct text and/or the values
of explicitly named, already present attributes (QNames use ``namespaces``).
Children, tails, count, ordering, names, other attributes and all other ZIP
parts remain protected. No subtree or wildcard permission exists. Selectors
use only absolute child steps, optionally [N] or [@qname='literal']; no XPath
functions, descendants, unions, variables or extension evaluation.

The complete protected XML is compared using C14N, including comments. Prefix
renaming or whitespace changes can be rejected conservatively. The contract is
NOT proof of requested content or visual layout: use content/render checks too.
Limits fail closed; a bounded list of diagnostics never bounds verification.
"""
from __future__ import annotations

import os
import re
import stat
import zipfile
from collections import defaultdict
from typing import Any, Dict

from lxml import etree

MAX_PARTS = 4096
MAX_TOTAL_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_PART_BYTES = 32 * 1024 * 1024
MAX_XML_BYTES = 16 * 1024 * 1024
MAX_RULES = 256
MAX_NODES = 250_000
MAX_DIAGNOSTICS = 40
_QNAME = r"[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?"
_STEP = re.compile(r"^(?P<name>" + _QNAME + r")(?:\[(?:(?P<index>[1-9][0-9]{0,6})|@(?P<attr>" + _QNAME + r")=(?P<quote>['\"])(?P<value>[^'\"/\[\]<>]*)(?P=quote))\])?$")
_XML_NS = "http://www.w3.org/XML/1998/namespace"


class PreservationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _fail(code, message):
    raise PreservationError(code, message)


def _part_name(name):
    if (not isinstance(name, str) or not name or len(name) > 1024
            or name.startswith('/') or '\\' in name or ':' in name
            or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or any(p in ('', '.', '..') for p in name.rstrip('/').split('/'))):
        _fail('preserve_invalid_package', 'Nombre de parte ZIP no seguro.')
    return name


def _qname(name, namespaces):
    if not isinstance(name, str) or not re.fullmatch(_QNAME, name):
        _fail('preserve_invalid_contract', 'Nombre XML inválido.')
    if ':' not in name:
        return name
    prefix, local = name.split(':')
    if prefix not in namespaces:
        _fail('preserve_invalid_contract', 'El selector usa un prefijo XML no declarado.')
    return '{%s}%s' % (namespaces[prefix], local)


def _steps(xpath, namespaces):
    if not isinstance(xpath, str) or not xpath.startswith('/') or len(xpath) > 2048:
        _fail('preserve_invalid_contract', 'Se requiere un selector XML absoluto acotado.')
    paths = xpath[1:].split('/')
    if not paths or len(paths) > 64:
        _fail('preserve_invalid_contract', 'Demasiados pasos en el selector XML.')
    result = []
    for segment in paths:
        match = _STEP.fullmatch(segment)
        if not match:
            _fail('preserve_invalid_contract', 'El selector solo admite hijos explícitos, [N] o [@atributo=\'valor\'].')
        result.append((_qname(match['name'], namespaces), int(match['index']) if match['index'] else None,
                       _qname(match['attr'], namespaces) if match['attr'] else None, match['value']))
    return result


def _contract(contract):
    keys = {'version', 'namespaces', 'allow', 'added_parts', 'removed_parts'}
    if not isinstance(contract, dict) or set(contract) - keys or type(contract.get('version')) is not int or contract['version'] != 1:
        _fail('preserve_invalid_contract', 'Contrato de preservación desconocido; se requiere version: 1.')
    ns = contract.get('namespaces')
    if not isinstance(ns, dict) or len(ns) > 32:
        _fail('preserve_invalid_contract', 'Declara namespaces explícitos en el contrato.')
    for prefix, uri in ns.items():
        if (not isinstance(prefix, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]*', prefix)
                or prefix == 'xmlns' or not isinstance(uri, str) or not uri or len(uri) > 1024
                or any(c.isspace() or ord(c) < 32 for c in uri)
                or (prefix == 'xml' and uri != _XML_NS)):
            _fail('preserve_invalid_contract', 'Namespace XML inválido.')
    rules = contract.get('allow', [])
    if not isinstance(rules, list) or len(rules) > MAX_RULES:
        _fail('preserve_invalid_contract', 'Lista de permisos XML inválida o demasiado grande.')
    by_part = defaultdict(list)
    for rule in rules:
        if not isinstance(rule, dict) or set(rule) - {'part', 'xpath', 'text', 'attributes'}:
            _fail('preserve_invalid_contract', 'Permiso XML desconocido.')
        try:
            part = _part_name(rule.get('part'))
        except PreservationError:
            _fail('preserve_invalid_contract', 'Parte inválida en el contrato.')
        if not part.lower().endswith(('.xml', '.rels')):
            _fail('preserve_invalid_contract', 'Los permisos de valores solo se aplican a partes XML.')
        if 'text' in rule and rule['text'] is not True:
            _fail('preserve_invalid_contract', 'text solo admite true; omítelo para proteger el texto.')
        attrs = rule.get('attributes', [])
        if not isinstance(attrs, list) or len(attrs) > 32 or ('attributes' in rule and not attrs):
            _fail('preserve_invalid_contract', 'Lista de atributos inválida.')
        attrs = [_qname(attr, ns) for attr in attrs]
        if len(set(attrs)) != len(attrs) or (not rule.get('text') and not attrs):
            _fail('preserve_invalid_contract', 'El permiso XML debe autorizar valores concretos sin duplicados.')
        by_part[part].append((_steps(rule.get('xpath'), ns), bool(rule.get('text')), attrs))
    permissions = []
    for key in ('added_parts', 'removed_parts'):
        values = contract.get(key, [])
        if not isinstance(values, list) or len(values) > MAX_RULES:
            _fail('preserve_invalid_contract', 'Lista de partes inválida.')
        try:
            values = [_part_name(value) for value in values]
        except PreservationError:
            _fail('preserve_invalid_contract', 'Parte inválida en el contrato.')
        if len(set(values)) != len(values):
            _fail('preserve_invalid_contract', 'Permisos de partes duplicados.')
        permissions.append(set(values))
    added, removed = permissions
    if added & removed or (added | removed) & set(by_part) or (not by_part and not added and not removed):
        _fail('preserve_invalid_contract', 'Contrato vacío o con permisos de partes contradictorios.')
    return by_part, added, removed


def _open_package(path):
    path = os.fspath(path)
    info = os.stat(path)
    if not stat.S_ISREG(info.st_mode):
        _fail('preserve_invalid_package', 'El paquete debe ser un archivo regular.')
    # Bound the ZIP directory allocation before ZipFile reads its metadata.
    if info.st_size > MAX_ARCHIVE_BYTES:
        _fail('preserve_limit', 'El ZIP excede el límite para verificación completa.')
    return zipfile.ZipFile(path)


def _inventory(archive):
    entries = archive.infolist()
    if len(entries) > MAX_PARTS:
        _fail('preserve_limit', 'El paquete excede el límite de partes para verificación completa.')
    files = {}
    total = 0
    for info in entries:
        name = _part_name(info.filename)
        if name in files or info.orig_filename != info.filename or info.flag_bits & 1:
            _fail('preserve_invalid_package', 'El ZIP contiene partes duplicadas, cifradas o nombres ambiguos.')
        mode = stat.S_IFMT(info.external_attr >> 16)
        if mode not in (0, stat.S_IFREG, stat.S_IFDIR) or (mode == stat.S_IFDIR and not info.is_dir()):
            _fail('preserve_invalid_package', 'El ZIP contiene una parte no regular.')
        if info.file_size > MAX_PART_BYTES:
            _fail('preserve_limit', 'Una parte excede el límite de tamaño para verificación completa.')
        total += info.file_size
        if total > MAX_TOTAL_BYTES:
            _fail('preserve_limit', 'El paquete excede el límite de tamaño para verificación completa.')
        files[name] = info
    if '[Content_Types].xml' not in files:
        _fail('preserve_invalid_package', 'Se requiere un paquete OOXML con [Content_Types].xml.')
    return files


def _read(archive, info):
    # A bounded read also checks CRC. Do not extract files or follow ZIP paths.
    with archive.open(info) as stream:
        data = stream.read(MAX_PART_BYTES + 1)
        if len(data) > MAX_PART_BYTES or len(data) != info.file_size or stream.read(1):
            _fail('preserve_limit', 'La parte ZIP no coincide con su tamaño declarado.')
    return data


def _xml(data):
    if len(data) > MAX_XML_BYTES:
        _fail('preserve_limit', 'El XML excede el límite para verificación completa.')
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True,
                             huge_tree=False, remove_blank_text=False, strip_cdata=False, recover=False)
    try:
        root = etree.fromstring(data, parser)
    except etree.XMLSyntaxError:
        _fail('preserve_invalid_package', 'Una parte XML no es válida o excede los límites del analizador.')
    if root.getroottree().docinfo.doctype or any(isinstance(node, etree._Entity) for node in root.iter()):
        _fail('preserve_invalid_package', 'No se admiten DTD ni entidades XML en la verificación.')
    if sum(1 for _ in root.iter()) > MAX_NODES:
        _fail('preserve_limit', 'El XML excede el límite de nodos para verificación completa.')
    return root


def _select(root, steps):
    current = [root]
    for i, (tag, index, attr, value) in enumerate(steps):
        selected = []
        for parent in current:
            candidates = [parent] if i == 0 else list(parent)
            matches = [node for node in candidates if node.tag == tag and (attr is None or node.get(attr) == value)]
            selected.extend(matches[index - 1:index] if index is not None else matches)
        current = selected
    if len(current) != 1:
        _fail('preserve_selector_mismatch', 'Cada selector debe identificar exactamente un elemento en ambos archivos.')
    return current[0]


def _address(node):
    address = []
    while node.getparent() is not None:
        parent = node.getparent()
        address.append(parent.index(node))
        node = parent
    return tuple(reversed(address))


def _protected_xml(before, after, rules):
    a, b = _xml(before), _xml(after)
    permissions = []
    seen = set()
    # Resolve every selector BEFORE masking so one permission cannot change
    # another selector's meaning. Structural addresses include comments/PIs.
    for steps, text, attributes in rules:
        left, right = _select(a, steps), _select(b, steps)
        address = _address(left)
        if address != _address(right):
            _fail('preserve_selector_mismatch', 'El elemento autorizado cambió de posición estructural.')
        for field in (['#text'] if text else []) + attributes:
            if (address, field) in seen:
                _fail('preserve_invalid_contract', 'Permisos XML superpuestos para el mismo valor.')
            seen.add((address, field))
        for attr in attributes:
            if attr not in left.attrib or attr not in right.attrib:
                _fail('preserve_selector_mismatch', 'Un atributo autorizado falta en uno de los archivos; no se permite añadirlo ni eliminarlo.')
        permissions.append((left, right, text, attributes))
    for left, right, text, attributes in permissions:
        if text:
            left.text = right.text = None
        for attr in attributes:
            left.set(attr, '')
            right.set(attr, '')
    # Compare the whole XML document, including comments and processing
    # instructions before/after its root, not only the selected element.
    try:
        return etree.tostring(a.getroottree(), method='c14n', with_comments=True) == etree.tostring(b.getroottree(), method='c14n', with_comments=True)
    except etree.C14NError:
        _fail('preserve_invalid_package', 'No se pudo canonicalizar el XML de forma completa.')


def verify_preservation(before: str, after: str, contract: Dict[str, Any]) -> Dict[str, Any]:
    """Return a fail-closed report. This function never writes either input.

    ``complete`` means every protected part/value was examined. It remains
    false on malformed inputs, unsupported contracts, missing selectors, or
    limits. A complete comparison may still fail due to collateral changes.
    ``violation_count`` is exhaustive even if diagnostics are capped.
    """
    report = {'ok': False, 'complete': False, 'code': 'preserve_invalid_contract',
              'scope': 'ooxml_values', 'parts_compared': 0, 'changed_parts': [],
              'violations': [], 'violation_count': 0, 'diagnostics_truncated': False}

    def violation(code, part=None, message=None):
        report['violation_count'] += 1
        if len(report['violations']) < MAX_DIAGNOSTICS:
            record = {'code': code}
            if part is not None:
                record['part'] = part
            if message is not None:
                record['message'] = message
            report['violations'].append(record)
        else:
            report['diagnostics_truncated'] = True

    try:
        rules, allowed_added, allowed_removed = _contract(contract)
        if not before or not after:
            _fail('preserve_invalid_contract', 'La preservación requiere el archivo original y el editado.')
        with _open_package(before) as a, _open_package(after) as b:
            af, bf = _inventory(a), _inventory(b)
            added, removed = set(bf) - set(af), set(af) - set(bf)
            if not allowed_added <= added or not allowed_removed <= removed:
                _fail('preserve_invalid_contract', 'Una parte declarada añadida/eliminada no coincide con los archivos.')
            if not set(rules) <= set(af) & set(bf):
                _fail('preserve_selector_mismatch', 'Una parte con permisos XML falta en uno de los archivos.')
            for name in sorted(set(af) | set(bf)):
                left = _read(a, af[name]) if name in af else None
                right = _read(b, bf[name]) if name in bf else None
                report['parts_compared'] += 1
                if left != right:
                    report['changed_parts'].append(name)
                if name in added:
                    if name not in allowed_added:
                        violation('preserve_unexpected_added_part', name)
                    elif name.lower().endswith(('.xml', '.rels')):
                        _xml(right)
                elif name in removed:
                    if name not in allowed_removed:
                        violation('preserve_unexpected_removed_part', name)
                elif name in rules:
                    if not _protected_xml(left, right, rules[name]):
                        violation('preserve_protected_xml_changed', name)
                elif left != right:
                    violation('preserve_protected_part_changed', name)
        report['complete'] = True
        report['ok'] = report['violation_count'] == 0
        report['code'] = 'preserve_ok' if report['ok'] else 'preserve_collateral_change'
    except PreservationError as error:
        report['code'] = error.code
        violation(error.code, message=str(error))
    except (OSError, ValueError, TypeError, RuntimeError, zipfile.BadZipFile, NotImplementedError, etree.LxmlError):
        report['code'] = 'preserve_invalid_package'
        violation('preserve_invalid_package', message='No se pudo leer y verificar completamente el paquete OOXML.')
    report['summary'] = ('Preservación comprobada: solo cambiaron los valores y partes autorizados.' if report['ok']
                         else 'No se confirmó la preservación: hay cambios no autorizados.' if report['complete']
                         else 'Verificación de preservación incompleta; no se puede dar por preservado el documento.')
    return report
