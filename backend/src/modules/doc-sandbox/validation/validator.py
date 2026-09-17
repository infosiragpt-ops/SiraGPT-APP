#!/usr/bin/env python3
"""Independent, offline document validator. JSON stdin/stdout; never executes recipes.

The production caller runs this program in the dedicated validator container. Direct
execution is for developer fixtures only and is not evidence of runtime isolation.
"""
from __future__ import annotations

import base64
import ast
import csv
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import zipfile
from urllib.parse import unquote

from lxml import etree

MAX_FILE = 50 * 1024 * 1024
MAX_EXPANDED = 200 * 1024 * 1024
MAX_ENTRY = 50 * 1024 * 1024
MAX_ENTRIES = 10000
MAX_PAGES = 500
MAX_TEXT = 8 * 1024 * 1024
NS = {
    'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    's': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'r': 'http://schemas.openxmlformats.org/package/2006/relationships',
    'ct': 'http://schemas.openxmlformats.org/package/2006/content-types',
}
FORMATS = {
    'docx': ('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    'xlsx': ('xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    'pptx': ('ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
}
FLAT = {'txt', 'md', 'csv', 'json', 'html'}
TEXT_TAGS = {f'{{{NS["w"]}}}t', f'{{{NS["w"]}}}delText', f'{{{NS["a"]}}}t',
             f'{{{NS["s"]}}}t', f'{{{NS["s"]}}}v', f'{{{NS["s"]}}}f'}


class ValidationFailure(Exception):
    def __init__(self, code: str, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(code)


def require(ok: bool, code: str, detail: str):
    if not ok:
        raise ValidationFailure(code, detail)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def xml(data: bytes):
    require(len(data) <= MAX_ENTRY, 'XML_TOO_LARGE', 'XML exceeds the per-part limit.')
    # Reject declarations even with UTF-16 encoding; parser also disables entities,
    # DTD loading and all network resolution. Never recover malformed XML.
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True,
                             recover=False, huge_tree=False, remove_blank_text=False)
    try:
        root = etree.fromstring(data, parser)
    except (etree.XMLSyntaxError, ValueError):
        raise ValidationFailure('INVALID_XML', 'Malformed XML part.')
    require(not root.getroottree().docinfo.doctype and
            not any(isinstance(n, etree._Entity) for n in root.iter()),
            'XML_DTD_FORBIDDEN', 'Document types and entities are forbidden.')
    return root


def safe_name(name: str):
    decoded = unquote(name)
    p = PurePosixPath(decoded)
    require(bool(name) and '\\' not in decoded and '\x00' not in decoded and
            not p.is_absolute() and not re.match(r'^[A-Za-z]:', decoded) and
            all(x not in ('..', '.') for x in decoded.split('/')) and
            len(p.parts) <= 30, 'ZIP_PATH_UNSAFE', 'Unsafe archive entry path.')


def safe_zip(data: bytes) -> tuple[dict[str, bytes], list[str]]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        entries = archive.infolist()
        require(0 < len(entries) <= MAX_ENTRIES, 'ZIP_ENTRY_LIMIT', 'Archive entry limit exceeded.')
        declared = sum(e.file_size for e in entries)
        compressed = sum(e.compress_size for e in entries)
        require(declared <= MAX_EXPANDED and declared <= max(1, compressed) * 20,
                'ZIP_BOMB', 'Archive expansion exceeds the approved 20x or absolute limit.')
        parts: dict[str, bytes] = {}
        order: list[str] = []
        used: set[str] = set()
        total = 0
        for entry in entries:
            safe_name(entry.filename.rstrip('/') if entry.is_dir() else entry.filename)
            require(entry.filename not in used, 'ZIP_DUPLICATE', 'Duplicate archive entry.')
            used.add(entry.filename)
            mode = entry.external_attr >> 16
            require(not stat.S_ISLNK(mode) and (stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR)),
                    'ZIP_SPECIAL_FILE', 'Archive contains a link or special file.')
            require(not (entry.flag_bits & 1), 'ZIP_ENCRYPTED', 'Encrypted ZIP entries are unsupported.')
            require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                    'ZIP_COMPRESSION_UNSUPPORTED', 'Unsupported archive compression.')
            require(entry.file_size <= MAX_ENTRY, 'ZIP_ENTRY_LIMIT', 'Expanded archive entry is too large.')
            if entry.is_dir():
                continue
            chunks: list[bytes] = []
            consumed = 0
            with archive.open(entry) as stream:
                while True:
                    chunk = stream.read(65536)
                    if not chunk:
                        break
                    consumed += len(chunk)
                    total += len(chunk)
                    require(consumed <= MAX_ENTRY and total <= MAX_EXPANDED and
                            total <= max(1, compressed) * 20, 'ZIP_BOMB', 'Stream expansion limit exceeded.')
                    chunks.append(chunk)
            require(consumed == entry.file_size, 'ZIP_SIZE_MISMATCH', 'Archive entry length mismatch.')
            parts[entry.filename] = b''.join(chunks)
            order.append(entry.filename)
        archive.close()
        return parts, order
    except (zipfile.BadZipFile, RuntimeError, EOFError, OSError):
        raise ValidationFailure('INVALID_ZIP', 'Archive is corrupt or could not be read.')


def inspect_xml_package(parts: dict[str, bytes], fmt: str):
    require('[Content_Types].xml' in parts and '_rels/.rels' in parts and
            FORMATS[fmt][0] in parts, 'OOXML_MISSING_PART', 'Required OOXML parts are absent.')
    roots = {name: xml(data) for name, data in parts.items()
             if name.endswith('.xml') or name.endswith('.rels')}
    ct = roots['[Content_Types].xml']
    require(ct.tag == f'{{{NS["ct"]}}}Types', 'OOXML_CONTENT_TYPES', 'Invalid content types root.')
    defaults: dict[str, str] = {}
    overrides: dict[str, str] = {}
    for entry in ct:
        if entry.tag == f'{{{NS["ct"]}}}Default':
            key = entry.get('Extension', '')
            require(key and key not in defaults, 'OOXML_CONTENT_TYPES', 'Duplicate or empty content type.')
            defaults[key] = entry.get('ContentType', '')
        elif entry.tag == f'{{{NS["ct"]}}}Override':
            raw = entry.get('PartName', '')
            require(raw.startswith('/'), 'OOXML_CONTENT_TYPES', 'Invalid override path.')
            key = raw[1:]
            require(key in parts and key not in overrides, 'OOXML_CONTENT_TYPES', 'Missing or duplicate override.')
            overrides[key] = entry.get('ContentType', '')
        else:
            raise ValidationFailure('OOXML_CONTENT_TYPES', 'Unknown content type declaration.')
    for name in parts:
        if name != '[Content_Types].xml':
            require(name in overrides or name.rsplit('.', 1)[-1] in defaults,
                    'OOXML_CONTENT_TYPES', 'A package part has no declared content type.')
    main_type = overrides.get(FORMATS[fmt][0], '')
    require(main_type.endswith('.main+xml') and
            {'docx': 'wordprocessingml.document', 'xlsx': 'spreadsheetml.sheet',
             'pptx': 'presentationml.presentation'}[fmt] in main_type,
            'MIME_MISMATCH', 'Package type does not match its extension.')
    for name, root in roots.items():
        if name.endswith('.rels'):
            require(root.tag == f'{{{NS["r"]}}}Relationships', 'INVALID_RELATIONSHIP', 'Invalid relationship root.')
            seen = set()
            base = PurePosixPath(name).parent.parent
            for rel in root:
                rid = rel.get('Id', '')
                require(rid and rid not in seen, 'INVALID_RELATIONSHIP', 'Duplicate relationship ID.')
                seen.add(rid)
                target = unquote(rel.get('Target', '')).split('#')[0]
                if rel.get('TargetMode') == 'External':
                    require(rel.get('Type', '').endswith('/hyperlink'), 'EXTERNAL_CONTENT',
                            'External content links cannot be opened safely.')
                    continue
                if not target:
                    continue
                normalized = os.path.normpath(str(base / target)) if not target.startswith('/') else target[1:]
                require(not normalized.startswith('../') and normalized in parts,
                        'INVALID_RELATIONSHIP', 'Relationship target is absent or unsafe.')
    require(not any(re.search(r'(?i)(vbaProject|activeX|embeddings/|externalLinks/)', name) for name in parts),
            'ACTIVE_CONTENT_UNSUPPORTED', 'Macros and embedded active content require a later supported phase.')
    return roots


def decode_plain(data: bytes) -> tuple[str, str]:
    encoding = 'utf-8'
    if data.startswith(b'\xff\xfe'):
        encoding = 'utf-16-le'
    elif data.startswith(b'\xfe\xff'):
        encoding = 'utf-16-be'
    elif data.startswith(b'\xef\xbb\xbf'):
        encoding = 'utf-8-sig'
    try:
        text = data.decode(encoding)
    except UnicodeError:
        raise ValidationFailure('TEXT_ENCODING_UNSUPPORTED', 'Supported encodings are UTF-8 and BOM-marked UTF-16.')
    require('\x00' not in text and not any(ord(c) < 32 and c not in '\t\r\n' for c in text),
            'MIME_MISMATCH', 'Binary data is not a supported text file.')
    require(len(data) <= MAX_TEXT, 'TEXT_TOO_LARGE', 'Text exceeds the inspection budget.')
    return text, encoding


def plain_check(text: str, fmt: str):
    try:
        if fmt == 'json':
            json.loads(text)
        elif fmt == 'csv':
            sample = text[:8192]
            dialect = csv.Sniffer().sniff(sample)
            rows = list(csv.reader(io.StringIO(text), dialect, strict=True))
            require(bool(rows) and len({len(row) for row in rows}) <= 1,
                    'CSV_STRUCTURE', 'CSV rows have inconsistent columns.')
        elif fmt == 'html':
            require(bool(re.search(r'<(?:!doctype\s+html|html|head|body|div|p)[\s>]', text, re.I)),
                    'MIME_MISMATCH', 'HTML markup was not detected.')
            # Never render HTML. Reject executable/remote content in this capacity.
            require(not re.search(r'<(?:script|iframe|object|embed)\b|\bon\w+\s*=|javascript:', text, re.I),
                    'HTML_ACTIVE_CONTENT', 'Executable HTML is not accepted for document preview.')
    except (ValueError, csv.Error):
        raise ValidationFailure('TEXT_STRUCTURE', 'Text does not parse as the requested format.')


def command(args: list[str], timeout: int = 120, cwd: Path | None = None) -> bytes:
    require(shutil.which(args[0]) is not None, 'TOOL_UNAVAILABLE', f'Required validator tool is unavailable: {args[0]}.')
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, cwd=cwd, check=False,
                                env={**os.environ, 'LC_ALL': 'C.UTF-8', 'TZ': 'UTC'})
    except subprocess.TimeoutExpired:
        raise ValidationFailure('TOOL_TIMEOUT', 'A validation tool exceeded its time limit.')
    require(result.returncode == 0, 'TOOL_FAILED', f'Validator tool failed: {args[0]}.')
    require(len(result.stdout) <= MAX_TEXT, 'TOOL_OUTPUT_LIMIT', 'Validator output exceeded its budget.')
    return result.stdout


def pdf_pages(path: Path) -> int:
    output = command(['pdfinfo', str(path)]).decode('utf-8', errors='replace')
    require(not re.search(r'^Encrypted:\s+yes', output, re.M), 'PDF_ENCRYPTED', 'Encrypted PDFs are not supported.')
    match = re.search(r'^Pages:\s+(\d+)', output, re.M)
    require(match is not None, 'PDF_PAGE_COUNT', 'Could not determine the page count.')
    count = int(match.group(1))
    require(0 < count <= MAX_PAGES, 'PAGE_LIMIT', 'Document page limit exceeded.')
    return count


def inspect(path: Path, name: str) -> dict:
    require(path.is_file() and not path.is_symlink(), 'INPUT_NOT_REGULAR', 'Document must be a regular file.')
    require(0 < path.stat().st_size <= MAX_FILE, 'FILE_SIZE_LIMIT', 'Document size limit exceeded.')
    require(Path(name).name == name and name not in ('.', '..') and '\\' not in name,
            'FILENAME_UNSAFE', 'Unsafe document filename.')
    fmt = Path(name).suffix.lower()[1:]
    require(fmt in FORMATS or fmt in FLAT or fmt == 'pdf', 'FORMAT_UNSUPPORTED', 'Format is not enabled in phase one.')
    data = path.read_bytes()
    result = {'format': fmt, 'sha256': digest(data), 'size': len(data), 'name': name,
              'parts': {}, 'units': [], 'warnings': []}
    if fmt in FORMATS:
        require(data.startswith(b'PK\x03\x04'), 'MIME_MISMATCH', 'Office package signature mismatch.')
        parts, order = safe_zip(data)
        roots = inspect_xml_package(parts, fmt)
        result['parts'] = {n: digest(b) for n, b in parts.items()}
        result['partOrder'] = order
        result['mime'] = FORMATS[fmt][1]
        for part, root in roots.items():
            for node in root.iter():
                if node.tag in TEXT_TAGS:
                    result['units'].append({'part': part, 'locator': root.getroottree().getpath(node),
                                            'text': node.text or '', 'kind': etree.QName(node).localname})
        require(sum(len(u['text']) for u in result['units']) <= MAX_TEXT,
                'TEXT_TOO_LARGE', 'Extracted text exceeds the inspection budget.')
    elif fmt == 'pdf':
        require(data.startswith(b'%PDF-'), 'MIME_MISMATCH', 'PDF signature mismatch.')
        # qpdf is a required structural gate, not optional even on no-op jobs.
        command(['qpdf', '--check', str(path)])
        from pypdf import PdfReader
        reader = PdfReader(str(path), strict=True)
        require(not reader.is_encrypted, 'PDF_ENCRYPTED', 'Encrypted PDFs are not supported.')
        audit_pdf_objects(reader.trailer['/Root'])
        for page in reader.pages:
            for annotation in page.get('/Annots', []):
                obj = annotation.get_object()
                require(obj.get('/FT') != '/Sig', 'PDF_SIGNED', 'Signed PDF editing needs informed consent.')
        require(not re.search(rb'/(?:JavaScript|JS|Launch|EmbeddedFile|XFA)\b', data),
                'PDF_ACTIVE_CONTENT', 'Active PDF content is not supported.')
        result['pages'] = pdf_pages(path)
        result['mime'] = 'application/pdf'
        text = command(['pdftotext', '-layout', str(path), '-']).decode('utf-8')
        result['units'] = [{'part': '$document', 'locator': f'page[{i+1}]', 'text': t, 'kind': 'page'}
                           for i, t in enumerate(text.split('\f')[:result['pages']])]
    else:
        require(not data.startswith((b'%PDF-', b'PK\x03\x04')), 'MIME_MISMATCH', 'Binary document mislabeled as text.')
        text, encoding = decode_plain(data)
        plain_check(text.lstrip('\ufeff'), fmt)
        result['encoding'] = encoding
        result['mime'] = {'json': 'application/json', 'html': 'text/html', 'csv': 'text/csv'}.get(fmt, 'text/plain')
        result['units'] = [{'part': '$document', 'locator': 'text', 'text': text, 'kind': 'text'}]
    return result


def locate(root, locator: str):
    # Only exact paths already emitted by this inventory. Never evaluate XPath
    # expressions supplied by the model (functions/unions/predicates).
    matches = [node for node in root.iter() if node.tag in TEXT_TAGS and root.getroottree().getpath(node) == locator]
    require(len(matches) == 1, 'PLAN_LOCATOR', 'Plan locator is absent or ambiguous.')
    return matches[0]


def check_plan(inventory: dict, plan: dict):
    require(isinstance(plan, dict) and plan.get('inputSha256') == inventory['sha256'] and
            plan.get('mode') == 'preserve', 'PLAN_INPUT_MISMATCH', 'Plan does not target this immutable original.')
    operations = plan.get('operations')
    require(isinstance(operations, list) and len(operations) <= 1000, 'PLAN_SCHEMA', 'Invalid operation list.')
    units = {(x['part'], x['locator']): x for x in inventory['units']}
    seen = set()
    for edit in operations:
        require(isinstance(edit, dict) and edit.get('kind') == 'replace_text',
                'OPERATION_UNSUPPORTED', 'Operation has no independent validator in this phase.')
        key = (edit.get('part'), edit.get('locator'))
        require(key in units and key not in seen, 'PLAN_LOCATOR', 'Each exact text unit may be edited once.')
        seen.add(key)
        require(isinstance(edit.get('before'), str) and isinstance(edit.get('after'), str) and
                edit['before'] == units[key]['text'] and edit['before'] != edit['after'],
                'PLAN_TEXT_MISMATCH', 'Before must match the entire inspected unit; no-op requires an empty plan.')
        require(len(edit['after']) <= MAX_TEXT, 'PLAN_TEXT_LIMIT', 'Replacement exceeds its budget.')
    return operations


def structural(original: Path, output: Path, before: dict, after: dict, operations: list):
    require(before['format'] == after['format'], 'OUTPUT_FORMAT', 'Output changed document format.')
    if not operations:
        # Stronger than per-part equality: no-op returns the original ZIP bytes too.
        require(before['sha256'] == after['sha256'], 'NOOP_CHANGED', 'An empty plan requires byte-identical output.')
    if before['format'] in FORMATS:
        a_parts, a_order = safe_zip(original.read_bytes())
        b_parts, b_order = safe_zip(output.read_bytes())
        require(set(a_parts) == set(b_parts) and a_order == b_order, 'PART_SET_CHANGED', 'Package parts or ordering changed.')
        edited = {e['part'] for e in operations}
        forbidden = re.compile(r'(?:^|/)(?:styles\.xml|numbering\.xml|settings\.xml|theme/|slideLayouts/|slideMasters/)|\.rels$|^\[Content_Types\]\.xml$')
        for part in a_parts:
            recalc_only = before['format'] == 'xlsx' and part == 'xl/workbook.xml' and bool(operations)
            if recalc_only:
                a_root, b_root = xml(a_parts[part]), xml(b_parts[part])
                a_calc, b_calc = a_root.find('s:calcPr', NS), b_root.find('s:calcPr', NS)
                require(b_calc is not None and b_calc.get('fullCalcOnLoad') == '1',
                        'FORMULA_RECALC_REQUIRED', 'Edited workbooks must explicitly request recalculation on load.')
                if a_calc is None:
                    a_calc = etree.SubElement(a_root, f'{{{NS["s"]}}}calcPr')
                a_calc.set('fullCalcOnLoad', '1')
                require(etree.tostring(a_root, method='c14n') == etree.tostring(b_root, method='c14n'),
                        'WORKBOOK_UNAUTHORIZED_CHANGE', 'Only derived fullCalcOnLoad may change in workbook metadata.')
                continue
            if part not in edited:
                require(a_parts[part] == b_parts[part], 'UNAUTHORIZED_PART', 'An unplanned package part changed.')
            else:
                require(not forbidden.search(part), 'FORBIDDEN_PART', 'Preserve mode cannot edit formatting or relationships.')
                require(part != 'xl/sharedStrings.xml', 'SHARED_STRING_EDIT_UNSUPPORTED',
                        'Shared-string edits require cell-scoped cloning validation from phase two.')
                root = xml(a_parts[part])
                for edit in operations:
                    if edit['part'] == part:
                        locate(root, edit['locator']).text = edit['after']
                require(etree.tostring(root, method='c14n') == etree.tostring(xml(b_parts[part]), method='c14n'),
                        'UNAUTHORIZED_XML_CHANGE', 'XML changed outside exactly authorized text leaves; styles/attributes must be preserved.')
        return {'parts': len(a_parts), 'changedParts': sorted(edited), 'exactNodeChanges': len(operations)}
    if before['format'] == 'pdf':
        require(before['pages'] == after['pages'], 'PAGE_COUNT_CHANGED', 'No validated structural operation permits page count changes.')
        require(not operations, 'PDF_EDIT_VALIDATOR_UNAVAILABLE', 'PDF editing requires an independently verified object/region plan; preserve no-op is supported.')
    elif before['format'] in FLAT:
        require(before.get('encoding') == after.get('encoding'), 'ENCODING_CHANGED', 'Text encoding changed.')
        require(re.findall(r'\r\n|\r|\n', before['units'][0]['text']) ==
                re.findall(r'\r\n|\r|\n', after['units'][0]['text']), 'LINE_ENDINGS_CHANGED', 'Line ending structure changed in preserve mode.')
    return {'byteIdentical': before['sha256'] == after['sha256']}


def visual_operations(original: Path, before: dict, operations: list):
    if before['format'] not in ('docx', 'pptx'):
        return operations
    parts, _ = safe_zip(original.read_bytes())
    groups = {}
    for edit in operations:
        root = xml(parts[edit['part']])
        node = locate(root, edit['locator'])
        parent = node
        paragraph_tags = {f'{{{NS["w"]}}}p', f'{{{NS["a"]}}}p'}
        while parent.getparent() is not None and parent.tag not in paragraph_tags:
            parent = parent.getparent()
        require(parent.tag in paragraph_tags, 'VISUAL_LOCATOR_UNAVAILABLE', 'Text has no independently identifiable paragraph.')
        locator = root.getroottree().getpath(parent)
        groups.setdefault((edit['part'], locator), []).append(edit)
    derived = []
    for (part, locator), edits in groups.items():
        root = xml(parts[part])
        paragraph = next(n for n in root.iter() if root.getroottree().getpath(n) == locator)
        text_before = ''.join(n.text or '' for n in paragraph.iter() if n.tag in TEXT_TAGS)
        for edit in edits:
            locate(root, edit['locator']).text = edit['after']
        text_after = ''.join(n.text or '' for n in paragraph.iter() if n.tag in TEXT_TAGS)
        derived.append({'before': text_before, 'after': text_after})
    return derived


def lo_profile(directory: Path) -> Path:
    profile = directory / 'profile'
    user = profile / 'user'
    user.mkdir(parents=True)
    (user / 'registrymodifications.xcu').write_text('''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>''', encoding='utf-8')
    return profile


def convert_pdf(path: Path, directory: Path, fmt: str, notes: bool = False) -> Path:
    directory.mkdir(parents=True)
    if fmt == 'pdf':
        target = directory / 'document.pdf'
        shutil.copyfile(path, target)
    else:
        profile = lo_profile(directory)
        export_filter = 'pdf'
        if fmt == 'pptx':
            options = {'ExportHiddenSlides': {'type': 'boolean', 'value': 'true'}}
            if notes:
                options.update(ExportNotesPages={'type': 'boolean', 'value': 'true'},
                               ExportOnlyNotesPages={'type': 'boolean', 'value': 'true'})
            export_filter = 'pdf:impress_pdf_Export:' + json.dumps(options, separators=(',', ':'))
        command(['soffice', f'-env:UserInstallation={profile.as_uri()}', '--headless', '--nologo',
                 '--nodefault', '--norestore', '--convert-to', export_filter, '--outdir', str(directory), str(path)])
        target = directory / (path.stem + '.pdf')
    require(target.is_file() and target.stat().st_size > 0, 'OPENABILITY_FAILED', 'Opening/export produced no PDF.')
    pdf_pages(target)
    return target


def formula_errors(path: Path, directory: Path) -> set[tuple[str, str, str]]:
    directory.mkdir(parents=True)
    profile = lo_profile(directory)
    command(['soffice', f'-env:UserInstallation={profile.as_uri()}', '--headless', '--nologo', '--norestore',
             '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', str(directory), str(path)])
    target = directory / (path.stem + '.xlsx')
    require(target.is_file(), 'RECALC_FAILED', 'Workbook recalculation produced no result.')
    parts, _ = safe_zip(target.read_bytes())
    errors = set()
    for name, data in parts.items():
        if re.match(r'xl/worksheets/sheet\d+\.xml$', name):
            for cell in xml(data).findall('.//s:c', NS):
                if cell.get('t') == 'e':
                    errors.add((name, cell.get('r', ''), cell.findtext('s:v', '', NS)))
    return errors


def opening(original: Path, output: Path, before: dict, work: Path):
    if before['format'] in FLAT:
        return {'applicable': False, 'reason': 'Text parser and encoding checks replace Office opening for this format.'}, None, None
    first = convert_pdf(original, work / 'before-open', before['format'])
    second = convert_pdf(output, work / 'after-open', before['format'])
    require(pdf_pages(first) == pdf_pages(second), 'PAGINATION_CHANGED', 'Preserve-mode rendering changed pagination.')
    if before['format'] == 'xlsx':
        original_errors = formula_errors(original, work / 'before-recalc')
        output_errors = formula_errors(output, work / 'after-recalc')
        require(not (output_errors - original_errors), 'FORMULA_ERROR_NEW', 'Recalculation introduced new cell errors.')
    return {'applicable': True, 'pages': pdf_pages(first), 'openedBoth': True,
            'formulasRecalculated': before['format'] == 'xlsx'}, first, second


def word_boxes(pdf: Path):
    data = command(['pdftotext', '-bbox-layout', str(pdf), '-'])
    # Poppler emits a fixed XHTML doctype. It is not user XML; strip the
    # declaration before applying the same no-DTD parser to its generated data.
    data = re.sub(rb'<!DOCTYPE[^>]*>', b'', data)
    root = xml(data)
    ns = {'h': 'http://www.w3.org/1999/xhtml'}
    pages = []
    for page in root.findall('.//h:page', ns):
        words = []
        for node in page.findall('.//h:word', ns):
            words.append({'text': ''.join(node.itertext()), 'box': tuple(float(node.get(k, '0')) for k in ('xMin', 'yMin', 'xMax', 'yMax'))})
        pages.append(words)
    return pages


def phrase_regions(pages: list, phrase: str):
    # The authorization comes from inspected before/after text, never page_hint or
    # pages_affected. Non-unique placement fails closed instead of masking a page.
    wanted = phrase.split()
    require(bool(wanted), 'VISUAL_LOCATOR_EMPTY', 'Cannot derive a visual region for empty text.')
    matches = []
    for page_index, words in enumerate(pages):
        for start in range(len(words) - len(wanted) + 1):
            subset = words[start:start + len(wanted)]
            if [x['text'] for x in subset] == wanted:
                matches.append((page_index, [x['box'] for x in subset]))
    require(len(matches) == 1, 'VISUAL_LOCATOR_AMBIGUOUS', 'Text cannot be mapped uniquely to a rendered region.')
    return matches[0]


def visual(before_pdf: Path | None, after_pdf: Path | None, operations: list, work: Path):
    if before_pdf is None or after_pdf is None:
        return {'applicable': False, 'reason': 'Plain text has no Office/PDF page raster; exact byte/text checks apply.'}
    from PIL import Image, ImageChops, ImageDraw
    first_boxes, second_boxes = word_boxes(before_pdf), word_boxes(after_pdf)
    regions: dict[int, list] = {}
    for edit in operations:
        a_page, a_boxes = phrase_regions(first_boxes, edit['before'])
        b_page, b_boxes = phrase_regions(second_boxes, edit['after'])
        require(a_page == b_page, 'VISUAL_PAGE_CHANGED', 'Edited content moved to a different page.')
        regions.setdefault(a_page, []).extend(a_boxes + b_boxes)
    pages = pdf_pages(before_pdf)
    measurements = []
    for page in range(1, pages + 1):
        prefix_a, prefix_b = work / f'before-{page}', work / f'after-{page}'
        command(['pdftoppm', '-f', str(page), '-l', str(page), '-r', '72', '-singlefile', '-png', str(before_pdf), str(prefix_a)])
        command(['pdftoppm', '-f', str(page), '-l', str(page), '-r', '72', '-singlefile', '-png', str(after_pdf), str(prefix_b)])
        with Image.open(str(prefix_a) + '.png') as aa, Image.open(str(prefix_b) + '.png') as bb:
            a, b = aa.convert('RGB'), bb.convert('RGB')
            require(a.size == b.size, 'VISUAL_PAGE_SIZE', 'Page dimensions changed.')
            changed = ImageChops.difference(a, b).convert('RGB')
            # Any channel delta > 16 counts; small anti-aliasing variation is
            # measured by a fixed independent 0.05% outside-region allowance.
            mask = ImageChops.lighter(ImageChops.lighter(*changed.split()[:2]), changed.split()[2]).point(lambda x: 255 if x > 16 else 0)
            all_changed = mask.histogram()[255]
            outside = mask.copy()
            draw = ImageDraw.Draw(outside)
            for x1, y1, x2, y2 in regions.get(page - 1, []):
                draw.rectangle((int(x1)-1, int(y1)-1, int(x2)+1, int(y2)+1), fill=0)
            fraction = outside.histogram()[255] / (a.width * a.height)
            require(fraction <= 0.0005, 'VISUAL_UNAUTHORIZED_CHANGE', 'Pixels outside independently derived text regions changed.')
            measurements.append({'page': page, 'changedFraction': all_changed / (a.width * a.height),
                                 'outsideFraction': fraction, 'authorizedRegions': len(regions.get(page-1, []))})
    return {'applicable': True, 'dpi': 72, 'tolerance': 0.0005, 'pages': measurements}


def textual(before: dict, after: dict, operations: list):
    expected = {(x['part'], x['locator']): x['text'] for x in before['units']}
    actual = {(x['part'], x['locator']): x['text'] for x in after['units']}
    for edit in operations:
        expected[(edit['part'], edit['locator'])] = edit['after']
    require(expected == actual, 'TEXT_DIFF_UNPLANNED', 'Extracted text differs from the complete expected plan.')
    return {'exact': True, 'changedUnits': len(operations), 'unitsChecked': len(expected)}


def pdf_object(value, seen=None, depth=0):
    """Resolve PDF object identities without trusting indirect reference numbers."""
    from pypdf.generic import IndirectObject, DictionaryObject, ArrayObject, StreamObject
    require(depth < 50, 'PDF_OBJECT_DEPTH', 'PDF object nesting exceeds its limit.')
    seen = set() if seen is None else seen
    if isinstance(value, IndirectObject):
        key = (id(value.pdf), value.idnum, value.generation)
        if key in seen:
            return '<cycle>'
        return pdf_object(value.get_object(), seen | {key}, depth + 1)
    if isinstance(value, StreamObject):
        data = value.get_data()
        require(len(data) <= MAX_ENTRY, 'PDF_STREAM_LIMIT', 'PDF stream is too large.')
        return {'streamHash': digest(data), 'dictionary': {str(k): pdf_object(v, seen, depth + 1)
            for k, v in value.items() if k not in ('/Length', '/Filter', '/DecodeParms')}}
    if isinstance(value, DictionaryObject):
        return {str(k): pdf_object(v, seen, depth + 1) for k, v in value.items() if k not in ('/Parent', '/P')}
    if isinstance(value, ArrayObject):
        return [pdf_object(v, seen, depth + 1) for v in value]
    if isinstance(value, bytes):
        return {'bytes': digest(value)}
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    return str(value)


def audit_pdf_objects(value, seen=None, counter=None, depth=0):
    from pypdf.generic import IndirectObject, DictionaryObject, ArrayObject
    seen = set() if seen is None else seen
    counter = [0] if counter is None else counter
    counter[0] += 1
    require(counter[0] <= 100000 and depth <= 60, 'PDF_OBJECT_LIMIT', 'PDF object graph exceeds its safety budget.')
    if isinstance(value, IndirectObject):
        key = (id(value.pdf), value.idnum, value.generation)
        if key in seen:
            return
        seen.add(key)
        return audit_pdf_objects(value.get_object(), seen, counter, depth + 1)
    if isinstance(value, DictionaryObject):
        require(value.get('/FT') != '/Sig' and '/Perms' not in value,
                'PDF_SIGNED', 'Signed PDF editing requires informed consent.')
        forbidden = {'/JS', '/JavaScript', '/Launch', '/EmbeddedFiles', '/EmbeddedFile', '/XFA', '/AA'}
        require(not (set(value) & forbidden) and value.get('/S') not in ('/JavaScript', '/Launch', '/GoToR', '/SubmitForm', '/ImportData'),
                'PDF_ACTIVE_CONTENT', 'PDF contains an active action or embedded content.')
        for child in value.values():
            audit_pdf_objects(child, seen, counter, depth + 1)
    elif isinstance(value, ArrayObject):
        for child in value:
            audit_pdf_objects(child, seen, counter, depth + 1)


def expected_ooxml(original: Path, operations: list, destination: Path, fmt: str) -> Path:
    # Rebuild a *validator baseline*, not the user's artifact: apply the exact leaf
    # operations independently and recalculate a copy. This permits the visual
    # consequences of formula dependencies without trusting model page hints.
    parts, order = safe_zip(original.read_bytes())
    modified = {}
    for edit in operations:
        root = modified.setdefault(edit['part'], xml(parts[edit['part']]))
        locate(root, edit['locator']).text = edit['after']
    if fmt == 'xlsx' and operations:
        workbook = modified.setdefault('xl/workbook.xml', xml(parts['xl/workbook.xml']))
        calc = workbook.find('s:calcPr', NS)
        if calc is None:
            calc = etree.SubElement(workbook, f'{{{NS["s"]}}}calcPr')
        calc.set('fullCalcOnLoad', '1')
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name in order:
            archive.writestr(name, etree.tostring(modified[name]) if name in modified else parts[name])
    return destination


def expected_pdf(inputs: list, operations: list, destination: Path) -> Path:
    """Build a validator-owned baseline from pristine inputs, not model outputs.

    Coordinates are PDF points, origin bottom-left, Helvetica black text. Operations
    target input page numbers; merge order is explicit and inputs occur once.
    """
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase.pdfmetrics import stringWidth
    by_id = {item['id']: item for item in inputs}
    merges = [e for e in operations if e['kind'] == 'pdf_merge']
    require(len(merges) <= 1, 'PDF_PLAN', 'Only one explicit merge is allowed.')
    ids = merges[0]['inputIds'] if merges else [inputs[0]['id']]
    require(len(ids) == len(set(ids)) and set(ids) == set(by_id), 'PDF_PLAN', 'Every input must occur exactly once in the merge.')
    writer = PdfWriter()
    offsets = {}
    for input_id in ids:
        reader = PdfReader(by_id[input_id]['path'], strict=True)
        offsets[input_id] = (len(writer.pages), len(reader.pages))
        writer.append(reader)
    # Preserve user document metadata rather than synthesizing author/creation.
    first = PdfReader(by_id[ids[0]]['path'], strict=True)
    writer.metadata = first.metadata
    for edit in operations:
        kind = edit['kind']
        require(kind in ('pdf_merge', 'pdf_overlay', 'pdf_rotate'), 'OPERATION_UNSUPPORTED', 'Unsupported PDF operation.')
        if kind == 'pdf_merge':
            continue
        require(edit.get('inputId') in offsets, 'PDF_PLAN', 'Unknown input in PDF operation.')
        offset, count = offsets[edit['inputId']]
        pages = edit['pages'] if kind == 'pdf_rotate' else [edit['page']]
        require(all(isinstance(n, int) and 1 <= n <= count for n in pages) and len(set(pages)) == len(pages),
                'PDF_PLAN_PAGE', 'PDF operation references a missing or repeated page.')
        for number in pages:
            page = writer.pages[offset + number - 1]
            if kind == 'pdf_rotate':
                require(edit['degrees'] in (90, 180, 270), 'PDF_PLAN_ROTATION', 'Invalid PDF rotation.')
                page.rotate(edit['degrees'])
            else:
                require(page.rotation == 0, 'PDF_OVERLAY_ROTATED', 'Overlay onto rotated pages needs a separate approved coordinate transform.')
                text = edit['text']
                require(text and '\n' not in text and '\r' not in text and all(32 <= ord(c) <= 255 for c in text),
                        'PDF_OVERLAY_TEXT', 'Single-line Latin text is required by the phase-one Helvetica overlay contract.')
                x, y, size = edit['x'], edit['y'], edit['fontSize']
                width, height = float(page.mediabox.width), float(page.mediabox.height)
                require(0 < size <= 200 and 0 <= x and 0 <= y and
                        x + stringWidth(text, 'Helvetica', size) <= width and y + size <= height,
                        'PDF_OVERLAY_BOUNDS', 'Overlay would fall outside the page.')
                temporary = io.BytesIO()
                drawing = canvas.Canvas(temporary, pagesize=(width, height), invariant=1)
                drawing.setFont('Helvetica', size)
                drawing.setFillColorRGB(0, 0, 0)
                drawing.drawString(x, y, text)
                drawing.save()
                temporary.seek(0)
                page.merge_page(PdfReader(temporary).pages[0], over=True)
    writer.write(str(destination))
    writer.close()
    return destination


def pdf_structure(expected: Path, output: Path):
    from pypdf import PdfReader
    first, second = PdfReader(str(expected), strict=True), PdfReader(str(output), strict=True)
    require(len(first.pages) == len(second.pages), 'PDF_PAGE_COUNT', 'PDF page count differs from the approved operations.')
    require(pdf_object(first.metadata) == pdf_object(second.metadata), 'PDF_METADATA_CHANGED', 'Unplanned PDF metadata changed.')
    # Preserve non-visual data too: a raster comparison alone cannot detect dropped
    # forms or annotations. Resource identities are not compared by object number.
    for a, b in zip(first.pages, second.pages):
        for key in (set(a) | set(b)) - {'/Parent', '/Contents', '/Resources'}:
            require(pdf_object(a.get(key)) == pdf_object(b.get(key)), 'PDF_OBJECT_CHANGED', 'Unplanned PDF page object or annotation changed.')
        # Resource names can be rewritten by a PDF writer; compare resolved
        # content instead of trusting resource object IDs or font names alone.
        require(pdf_object(a.get('/Resources')) == pdf_object(b.get('/Resources')),
                'PDF_RESOURCE_CHANGED', 'PDF fonts, images or resource data differ from the approved baseline.')
    for key in (set(first.trailer['/Root']) | set(second.trailer['/Root'])) - {'/Pages'}:
        require(pdf_object(first.trailer['/Root'].get(key)) == pdf_object(second.trailer['/Root'].get(key)),
                'PDF_CATALOG_CHANGED', 'Unplanned PDF catalog data changed.')
    return {'expectedPages': len(first.pages), 'formsAndAnnotationsChecked': True}


def preflight_tools() -> dict:
    """Exercise installed Office/PDF tools on fixed, synthetic documents, offline.

    This is a startup capability check, not a fidelity golden or isolation proof.
    Every Office application must actually export a one-page document to PDF.
    """
    sentinel = 'SiraGPT validator readiness'
    namespaces = ('xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
                  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
                  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
                  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
                  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"')
    bodies = {
        'writer': ('fodt', 'text', f'<office:text><text:p>{sentinel}</text:p></office:text>'),
        'calc': ('fods', 'spreadsheet', '<office:spreadsheet><table:table table:name="Check">'
                 '<table:table-row><table:table-cell office:value-type="string">'
                 f'<text:p>{sentinel}</text:p></table:table-cell></table:table-row>'
                 '</table:table></office:spreadsheet>'),
        'impress': ('fodp', 'presentation', '<office:presentation><draw:page draw:name="Check">'
                    '<draw:frame svg:x="1cm" svg:y="1cm" svg:width="20cm" svg:height="3cm">'
                    f'<draw:text-box><text:p>{sentinel}</text:p></draw:text-box></draw:frame>'
                    '</draw:page></office:presentation>'),
    }
    hashes = {}
    with tempfile.TemporaryDirectory(prefix='validator-preflight-') as temporary:
        root = Path(temporary)
        for application, (extension, kind, body) in bodies.items():
            source = root / f'{application}.{extension}'
            source.write_text(f'<?xml version="1.0" encoding="UTF-8"?>'
                f'<office:document {namespaces} office:version="1.2" '
                f'office:mimetype="application/vnd.oasis.opendocument.{kind}">'
                f'<office:body>{body}</office:body></office:document>', encoding='utf-8')
            pdf = convert_pdf(source, root / f'{application}-pdf', 'pptx' if application == 'impress' else extension)
            command(['qpdf', '--check', str(pdf)])
            require(pdf_pages(pdf) == 1, 'PREFLIGHT_PAGINATION', 'The startup sample must have one page.')
            extracted = command(['pdftotext', '-layout', str(pdf), '-']).decode('utf-8')
            require(sentinel in extracted, 'PREFLIGHT_TEXT', 'Office/PDF startup text was not preserved.')
            prefix = root / f'{application}-render'
            command(['pdftoppm', '-f', '1', '-l', '1', '-singlefile', '-r', '72', '-png', str(pdf), str(prefix)])
            from PIL import Image
            png = prefix.with_suffix('.png')
            with Image.open(png) as rendered:
                require(rendered.width > 100 and rendered.height > 100, 'PREFLIGHT_RENDER', 'Empty startup render.')
                rendered.verify()
            hashes[application] = digest(png.read_bytes())
    return {'schemaVersion': 1, 'applications': hashes}


def run(request: dict) -> dict:
    inputs = request.get('inputs') or [{'id': 'input', 'path': request['originalPath'], 'name': request['originalName']}]
    original = Path(inputs[0]['path']).resolve()
    name = inputs[0]['name']
    if request['command'] == 'preflight':
        # Check execution identity and namespace without changing protections or
        # connecting to an external service. Docker launch still enforces runsc.
        require(os.getuid() == 65532 and os.getgid() == 65532,
                'PREFLIGHT_IDENTITY', 'Unexpected validator identity.')
        require({name for _, name in socket.if_nameindex()} == {'lo'},
                'PREFLIGHT_NETWORK', 'Validator must not have a network interface.')
        inventory = inspect(original, name)
        require(inventory['format'] == 'txt', 'PREFLIGHT_INPUT', 'Unexpected startup sample.')
        return {'ok': True, 'preflight': {**preflight_tools(), 'inputSha256': inventory['sha256']}}
    if request['command'] == 'inspect_recipe':
        require(original.is_file() and not original.is_symlink() and 0 < original.stat().st_size <= 16 * 1024 * 1024,
                'RECIPE_SIZE_LIMIT', 'Recipe archive exceeds its limit.')
        parts, order = safe_zip(original.read_bytes())
        require(0 < len(parts) <= 500 and sum(map(len, parts.values())) <= 16 * 1024 * 1024,
                'RECIPE_SIZE_LIMIT', 'Recipe archive expanded size exceeds its limit.')
        scripts = []
        for part, data in parts.items():
            suffix = Path(part).suffix.lower()
            require(suffix in ('.py', '.js', '.sh', '.json', '.md', '.txt'),
                    'RECIPE_FILE_UNSUPPORTED', 'Recipe contains an executable binary, nested archive or unsupported file.')
            text, _ = decode_plain(data)
            if suffix == '.py':
                try:
                    ast.parse(text)
                except SyntaxError:
                    raise ValidationFailure('RECIPE_SYNTAX', 'Python recipe cannot be parsed; it was not executed.')
            if suffix in ('.py', '.js', '.sh'):
                scripts.append(part)
        require(bool(scripts), 'RECIPE_MISSING_SCRIPT', 'Recipe must contain at least one reproducible script.')
        return {'ok': True, 'recipe': {'sha256': digest(original.read_bytes()), 'size': original.stat().st_size,
            'expandedBytes': sum(map(len, parts.values())), 'scripts': scripts,
            'parts': {part: digest(data) for part, data in parts.items()}}}
    if request['command'] == 'inspect':
        inventories = [{'id': item['id'], **inspect(Path(item['path']), item['name'])} for item in inputs]
        return {'ok': True, 'inventories': inventories}
    require(request['command'] == 'validate', 'COMMAND_INVALID', 'Unknown validator command.')
    output = Path(request['outputPath']).resolve()
    report = {'schemaVersion': 1, 'passed': False, 'levels': [], 'originalSha256': '', 'outputSha256': '',
              'artifactFiles': [], 'artifactData': {}, 'changes': []}
    level = 1
    start = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='doc-validation-') as temporary:
        work = Path(temporary)
        before, after = None, None
        try:
            inventories = {item['id']: inspect(Path(item['path']), item['name']) for item in inputs}
            plan = request['plan']
            require(plan.get('schemaVersion') == 1 and plan.get('mode') == 'preserve' and plan.get('outputName') == name and
                    plan.get('inputHashes') == {i: x['sha256'] for i, x in inventories.items()},
                    'PLAN_INPUT_MISMATCH', 'Plan does not target the exact pristine inputs and filename.')
            before, after = inventories[inputs[0]['id']], inspect(output, name)
            report.update(originalSha256=before['sha256'], outputSha256=after['sha256'])
            pdf_mode = before['format'] == 'pdf' and bool(plan['edits'])
            if pdf_mode:
                require(all(i['format'] == 'pdf' for i in inventories.values()), 'PDF_INPUT_FORMAT', 'Merge inputs must all be PDFs.')
                expected = expected_pdf(inputs, plan['edits'], work / 'expected.pdf')
                checks = pdf_structure(expected, output)
                operations = []
            else:
                require(len(inputs) == 1, 'MULTIPLE_OUTPUT_UNSUPPORTED', 'Phase one supports multiple inputs only for an explicit PDF merge.')
                require(all(e['kind'] in ('text', 'cell') and e['inputId'] == inputs[0]['id'] for e in plan['edits']),
                        'OPERATION_UNSUPPORTED', 'Operation is not valid for this document.')
                operations = [{**e, 'kind': 'replace_text'} for e in plan['edits']]
                check_plan(before, {'inputSha256': before['sha256'], 'mode': 'preserve', 'operations': operations})
                checks = structural(original, output, before, after, operations)
            report['levels'].append({'level': 1, 'passed': True, 'applicable': True, 'details': checks, 'durationMs': round((time.monotonic()-start)*1000)})
            level, start = 2, time.monotonic()
            checks, first_pdf, second_pdf = opening(expected if pdf_mode else original, output, before, work)
            report['levels'].append({'level': 2, 'passed': checks['applicable'], 'applicable': checks['applicable'], 'details': checks, 'durationMs': round((time.monotonic()-start)*1000)})
            level, start = 3, time.monotonic()
            if before['format'] == 'xlsx' and operations:
                baseline = expected_ooxml(original, operations, work / 'expected.xlsx', 'xlsx')
                expected_render = convert_pdf(baseline, work / 'expected-open', 'xlsx')
                checks = visual(expected_render, second_pdf, [], work)
                checks['baseline'] = 'independently-applied-cell-edits-and-recalculation'
            else:
                visible_operations = [edit for edit in operations if not edit['part'].startswith('ppt/notesSlides/')]
                checks = visual(first_pdf, second_pdf, visual_operations(original, before, visible_operations), work)
            if before['format'] == 'pptx':
                baseline = expected_ooxml(original, operations, work / 'expected.pptx', 'pptx')
                expected_notes = convert_pdf(baseline, work / 'expected-notes-open', 'pptx', notes=True)
                actual_notes = convert_pdf(output, work / 'actual-notes-open', 'pptx', notes=True)
                notes_work = work / 'notes-visual'
                notes_work.mkdir()
                checks['notes'] = visual(expected_notes, actual_notes, [], notes_work)
                for image in notes_work.glob('*.png'):
                    prefix, number = image.stem.split('-')
                    image.rename(work / f'{prefix}-notes-{number}.png')
            report['levels'].append({'level': 3, 'passed': checks['applicable'], 'applicable': checks['applicable'], 'details': checks, 'durationMs': round((time.monotonic()-start)*1000)})
            level, start = 4, time.monotonic()
            if pdf_mode:
                require(command(['pdftotext', '-layout', str(expected), '-']) == command(['pdftotext', '-layout', str(output), '-']),
                        'TEXT_DIFF_UNPLANNED', 'PDF text differs from the independently constructed expected output.')
                checks = {'exact': True, 'pdfOperations': len(plan['edits'])}
            else:
                checks = textual(before, after, operations)
            report['levels'].append({'level': 4, 'passed': True, 'applicable': True, 'details': checks, 'durationMs': round((time.monotonic()-start)*1000)})
            report['passed'] = True
            report['changes'] = plan['edits']
        except ValidationFailure as error:
            report['passed'] = False
            report['levels'].append({'level': level, 'passed': False, 'applicable': True, 'details': {'code': error.code, 'message': error.detail},
                                     'durationMs': round((time.monotonic()-start)*1000)})
        except Exception:
            report['passed'] = False
            # Do not leak parser exception text/document contents into worker logs.
            report['levels'].append({'level': level, 'passed': False, 'applicable': True, 'details': {'code': 'VALIDATOR_INTERNAL_ERROR',
                'message': 'Independent validation could not finish safely.'}, 'durationMs': round((time.monotonic()-start)*1000)})
        # Persist evidence for failures as well. These private artifacts include
        # the observed diff, not only the model's intended replacements.
        artifact_dir = request.get('artifactDir')
        if artifact_dir:
            try:
                target = Path(artifact_dir)
                target.mkdir(parents=True, exist_ok=True)
                old = {(u['part'], u['locator']): u['text'] for u in before['units']} if before else {}
                new = {(u['part'], u['locator']): u['text'] for u in after['units']} if after else {}
                differences = [{'part': key[0], 'locator': key[1], 'before': old.get(key), 'after': new.get(key)}
                               for key in sorted(old.keys() | new.keys()) if old.get(key) != new.get(key)]
                payload = json.dumps({'schemaVersion': 1, 'observedChanges': differences,
                                      'validatedChanges': report['changes']}, ensure_ascii=False).encode('utf-8')
                total_artifact_bytes = len(payload)
                (target / 'text-diff.json').write_bytes(payload)
                report['artifactFiles'].append('text-diff.json')
                for png in sorted(work.glob('*.png')):
                    total_artifact_bytes += png.stat().st_size
                    require(total_artifact_bytes <= 16 * 1024 * 1024, 'ARTIFACT_BYTE_LIMIT', 'Validation artifacts exceed their total budget.')
                    shutil.copyfile(png, target / png.name)
                    report['artifactFiles'].append(png.name)
                require(total_artifact_bytes <= 16 * 1024 * 1024, 'ARTIFACT_BYTE_LIMIT', 'Validation artifacts exceed their total budget.')
                if request.get('inlineArtifacts'):
                    report['artifactData'] = {name: base64.b64encode((target / name).read_bytes()).decode('ascii')
                                              for name in report['artifactFiles']}
            except Exception:
                report['passed'] = False
                report['artifactFiles'], report['artifactData'] = [], {}
                report['levels'].append({'level': 4, 'passed': False, 'applicable': True, 'details': {
                    'code': 'VALIDATION_EVIDENCE_FAILED', 'message': 'Validation evidence could not be retained within its budget.'}, 'durationMs': 0})
    return {'ok': True, 'report': report}


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_TEXT + 1)
        require(len(raw) <= MAX_TEXT, 'REQUEST_TOO_LARGE', 'Validator request exceeds limit.')
        value = run(json.loads(raw))
    except ValidationFailure as error:
        value = {'ok': False, 'error': {'code': error.code, 'message': error.detail}}
    except Exception:
        value = {'ok': False, 'error': {'code': 'VALIDATOR_INTERNAL_ERROR', 'message': 'Invalid request or validator failure.'}}
    sys.stdout.write(json.dumps(value, ensure_ascii=False))
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
