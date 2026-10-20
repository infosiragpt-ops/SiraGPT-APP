"""Real OOXML regression tests; no renderer, network, or Office installation required."""
import hashlib
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

from lxml import etree

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / 'src/services/agent-runner'))
import sira_office as office
import sira_preserve as guard

FIXTURES = HERE.parent / 'fixtures/office'
NS = office.NS


def package(path):
    with zipfile.ZipFile(path) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def save_package(path, parts):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, value in parts.items():
            archive.writestr(name, value)
    return str(path)


def contract(part='word/document.xml', xpath='/w:document/w:body/w:p[9]/w:r[2]/w:t', **permission):
    return {'version': 1, 'namespaces': NS.copy(), 'allow': [{'part': part, 'xpath': xpath, **(permission or {'text': True})}]}


class PreservationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='sira-preserve-test-')
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.docx = str(FIXTURES / 'tesis_demo.docx')
        self.xlsx = str(FIXTURES / 'presupuesto_demo.xlsx')
        self.pptx = str(FIXTURES / 'defensa_demo.pptx')

    def mutate(self, path, part, change, name='changed.docx'):
        parts = package(path)
        root = etree.fromstring(parts[part])
        change(root)
        parts[part] = etree.tostring(root, encoding='UTF-8', xml_declaration=True, standalone=True)
        return save_package(self.dir / name, parts)

    def edited_word(self):
        dest = str(self.dir / 'word.docx')
        result = office.edit(self.docx, dest, [{'op': 'replace_text', 'paragraph': 8, 'find': '2024', 'replace': '2025'}])
        self.assertTrue(result['ok'], result)
        return dest

    def assert_preserved(self, before, after, spec):
        result = guard.verify_preservation(before, after, spec)
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['complete'], result)
        self.assertEqual(result['violation_count'], 0)
        return result

    def assert_rejected(self, before, after, spec, complete=True, code=None):
        result = guard.verify_preservation(before, after, spec)
        self.assertFalse(result['ok'], result)
        self.assertEqual(result['complete'], complete, result)
        self.assertGreater(result['violation_count'], 0)
        if code:
            self.assertEqual(result['code'], code, result)
        return result

    def test_actual_word_edit_preserves_unrequested_runs_and_original(self):
        original = hashlib.sha256(Path(self.docx).read_bytes()).hexdigest()
        output = self.edited_word()
        self.assert_preserved(self.docx, output, contract())
        self.assertEqual(hashlib.sha256(Path(self.docx).read_bytes()).hexdigest(), original)

    def test_word_same_part_one_twip_margin_change_is_rejected(self):
        output = self.mutate(self.edited_word(), 'word/document.xml',
                             lambda root: root.find('.//' + office.W('pgMar')).set(office.W('left'), '1702'))
        # allowed_parts alone cannot detect this collateral mutation.
        self.assertEqual(office.part_diff(self.docx, output)['changed'], ['word/document.xml'])
        self.assert_rejected(self.docx, output, contract())

    def test_word_same_run_bold_change_and_tail_are_protected(self):
        def bold(root):
            run = root.xpath('/w:document/w:body/w:p[9]/w:r[2]', namespaces=NS)[0]
            run.find(office.W('rPr')).remove(run.find('.//' + office.W('b')))
        output = self.mutate(self.edited_word(), 'word/document.xml', bold)
        self.assert_rejected(self.docx, output, contract())
        output = self.mutate(self.edited_word(), 'word/document.xml',
                             lambda root: setattr(root.xpath('/w:document/w:body/w:p[9]/w:r[2]/w:t', namespaces=NS)[0], 'tail', 'not authorized'))
        self.assert_rejected(self.docx, output, contract())

    def test_text_permission_never_masks_descendants_or_structure(self):
        spec = contract(xpath='/w:document/w:body/w:p[9]', text=True)
        self.assert_rejected(self.docx, self.edited_word(), spec)
        def insert(root):
            target = root.xpath('/w:document/w:body/w:p[9]/w:r[2]/w:t', namespaces=NS)[0]
            target.append(etree.Element(office.W('t')))
        output = self.mutate(self.edited_word(), 'word/document.xml', insert)
        self.assert_rejected(self.docx, output, contract())

    def test_worksheet_exact_cell_value_and_other_cell_guard(self):
        spec = contract('xl/worksheets/sheet1.xml', "/s:worksheet/s:sheetData/s:row[@r='3']/s:c[@r='C3']/s:v")
        output = self.mutate(self.xlsx, 'xl/worksheets/sheet1.xml',
                             lambda root: setattr(root.xpath("//s:c[@r='C3']/s:v", namespaces=NS)[0], 'text', '99.5'), name='value.xlsx')
        self.assert_preserved(self.xlsx, output, spec)
        output = self.mutate(output, 'xl/worksheets/sheet1.xml',
                             lambda root: setattr(root.xpath("//s:c[@r='B2']/s:v", namespaces=NS)[0], 'text', '100'), name='collateral.xlsx')
        self.assert_rejected(self.xlsx, output, spec)

    def test_excel_global_style_change_is_not_hidden_by_same_style_index(self):
        spec = contract('xl/worksheets/sheet1.xml', "/s:worksheet/s:sheetData/s:row[@r='3']/s:c[@r='C3']/s:v")
        output = self.mutate(self.xlsx, 'xl/styles.xml',
                             lambda root: root.find('.//' + office.S('sz')).set('val', '30'), name='style.xlsx')
        result = self.assert_rejected(self.xlsx, output, spec)
        self.assertEqual(result['violations'][0]['part'], 'xl/styles.xml')

    def test_actual_ppt_move_keeps_integer_emu_precision(self):
        part = 'ppt/slides/slide2.xml'
        pkg = office.OfficePackage(self.pptx)
        shape, _, _ = office._pp_find_shape(pkg, part, 'Nota')
        off = office._pp_xfrm(shape).find(office.A('off'))
        xpath = off.getroottree().getpath(off)
        spec = contract(part, xpath, attributes=['x'])
        dest = str(self.dir / 'move.pptx')
        edited = office.edit(self.pptx, dest, [{'op': 'set_geometry', 'slide': 2, 'shape': 'Nota', 'dx_mm': 2}])
        self.assertTrue(edited['ok'], edited)
        self.assert_preserved(self.pptx, dest, spec)
        changed = self.mutate(dest, part, lambda root: root.xpath(xpath, namespaces=NS)[0].set('y', str(int(off.get('y')) + 1)), name='one-emu.pptx')
        self.assert_rejected(self.pptx, changed, spec)

    def test_ppt_rotation_is_protected_even_with_geometry_permission(self):
        part = 'ppt/slides/slide2.xml'
        pkg = office.OfficePackage(self.pptx)
        shape, _, _ = office._pp_find_shape(pkg, part, 'Nota')
        off = office._pp_xfrm(shape).find(office.A('off'))
        xpath = off.getroottree().getpath(off)
        output = self.mutate(self.pptx, part, lambda root: root.xpath(xpath, namespaces=NS)[0].getparent().set('rot', '1'), name='rotate.pptx')
        self.assert_rejected(self.pptx, output, contract(part, xpath, attributes=['x']))

    def test_namespaced_attribute_permission_does_not_mask_neighbor_attributes(self):
        xpath = '/w:document/w:body/w:sectPr/w:pgMar'
        output = self.mutate(self.docx, 'word/document.xml',
                             lambda root: root.xpath(xpath, namespaces=NS)[0].set(office.W('left'), '1702'))
        spec = contract(xpath=xpath, attributes=['w:left'])
        self.assert_preserved(self.docx, output, spec)
        output = self.mutate(output, 'word/document.xml',
                             lambda root: root.xpath(xpath, namespaces=NS)[0].set(office.W('right'), '1703'))
        self.assert_rejected(self.docx, output, spec)

    def test_missing_attribute_cannot_be_created_with_value_permission(self):
        spec = contract(xpath='/w:document/w:body/w:p[9]/w:r[2]/w:t', attributes=['extra'])
        self.assert_rejected(self.docx, self.docx, spec, complete=False, code='preserve_selector_mismatch')

    def test_ambiguous_missing_moved_and_unsupported_selectors_fail_closed(self):
        for xpath in ('/w:document/w:body/w:p', '/w:document/w:body/w:p[999]', '//w:t', '/w:document/*',
                      '/w:document/w:body/w:p[position()=1]', '/w:document/w:body/w:p[1]|/w:document', '/unknown:document'):
            with self.subTest(xpath=xpath):
                self.assert_rejected(self.docx, self.docx, contract(xpath=xpath), complete=False)
        parts = package(self.docx)
        root = etree.fromstring(parts['word/document.xml'])
        node = root.xpath('/w:document/w:body/w:p[9]/w:r[2]', namespaces=NS)[0]
        node.addprevious(etree.Comment('inserted'))
        parts['word/document.xml'] = etree.tostring(root)
        dest = save_package(self.dir / 'moved.docx', parts)
        self.assert_rejected(self.docx, dest, contract(), complete=False, code='preserve_selector_mismatch')

    def test_empty_unknown_overlapping_contracts_are_not_success(self):
        bad = [None, {}, {'version': 1, 'namespaces': {}}, {'version': True, 'namespaces': NS, 'allow': []},
               {**contract(), 'subtree': True}, {**contract(), 'allow': [contract()['allow'][0]] * 2},
               contract(text=False), contract(attributes=[]), {**contract(), 'allow': 'all'}]
        for spec in bad:
            with self.subTest(contract=spec):
                self.assert_rejected(self.docx, self.docx, spec, complete=False, code='preserve_invalid_contract')

    def test_full_protected_xml_and_diagnostics_remain_exhaustive(self):
        parts = package(self.docx)
        # More changes than the display budget: the last violation is still counted.
        for i in range(guard.MAX_DIAGNOSTICS + 5):
            parts[f'customXml/unexpected{i}.xml'] = b'<unexpected />'
        output = save_package(self.dir / 'many.docx', parts)
        result = self.assert_rejected(self.docx, output, contract())
        self.assertEqual(result['violation_count'], guard.MAX_DIAGNOSTICS + 5)
        self.assertEqual(len(result['violations']), guard.MAX_DIAGNOSTICS)
        self.assertTrue(result['diagnostics_truncated'])
        self.assertEqual(result['parts_compared'], len(parts))

    def test_added_removed_parts_require_exact_explicit_permission(self):
        parts = package(self.docx)
        parts['customXml/authorized.xml'] = b'<data>requested</data>'
        output = save_package(self.dir / 'addition.docx', parts)
        self.assert_rejected(self.docx, output, contract())
        self.assert_preserved(self.docx, output, {**contract(), 'added_parts': ['customXml/authorized.xml']})
        self.assert_preserved(output, self.docx, {**contract(), 'removed_parts': ['customXml/authorized.xml']})
        self.assert_rejected(self.docx, output, {**contract(), 'added_parts': ['customXml/wrong.xml']}, complete=False)

    def test_duplicate_traversal_symlink_encrypted_zip_are_rejected(self):
        for bad_name in ('../escape', '/absolute', 'path\\escape', './relative', 'a//b', 'C:drive'):
            parts = package(self.docx)
            parts[bad_name] = b'bad'
            dest = save_package(self.dir / 'unsafe.docx', parts)
            with self.subTest(name=bad_name):
                self.assert_rejected(self.docx, dest, contract(), complete=False, code='preserve_invalid_package')
        dest = self.dir / 'duplicate.docx'
        save_package(dest, package(self.docx))
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            with zipfile.ZipFile(dest, 'a') as archive:
                archive.writestr('word/document.xml', b'<duplicate/>')
        self.assert_rejected(self.docx, dest, contract(), complete=False, code='preserve_invalid_package')
        dest = self.dir / 'symlink.docx'
        save_package(dest, package(self.docx))
        with zipfile.ZipFile(dest, 'a') as archive:
            info = zipfile.ZipInfo('link')
            info.create_system = 3
            info.external_attr = (0o120777 << 16)
            archive.writestr(info, '/etc/passwd')
        self.assert_rejected(self.docx, dest, contract(), complete=False, code='preserve_invalid_package')
        dest = self.dir / 'encrypted.docx'
        save_package(dest, package(self.docx))
        data = bytearray(dest.read_bytes())
        start = data.index(b'PK\x01\x02')
        flags = struct.unpack_from('<H', data, start + 8)[0]
        struct.pack_into('<H', data, start + 8, flags | 1)
        dest.write_bytes(data)
        self.assert_rejected(self.docx, dest, contract(), complete=False, code='preserve_invalid_package')

    def test_dtd_external_entities_fail_without_reading_target(self):
        parts = package(self.docx)
        root = etree.fromstring(parts['word/document.xml'])
        xml = etree.tostring(root)
        parts['word/document.xml'] = b'<!DOCTYPE w:document [<!ENTITY ex SYSTEM "file:///etc/passwd">]>' + xml
        output = save_package(self.dir / 'entity.docx', parts)
        result = self.assert_rejected(self.docx, output, contract(), complete=False, code='preserve_invalid_package')
        self.assertNotIn('root:', str(result))

    def test_limits_never_return_partial_success(self):
        for name, value in (('MAX_ARCHIVE_BYTES', 10), ('MAX_PARTS', 2), ('MAX_PART_BYTES', 20), ('MAX_TOTAL_BYTES', 100), ('MAX_XML_BYTES', 10), ('MAX_NODES', 2)):
            with self.subTest(limit=name), patch.object(guard, name, value):
                self.assert_rejected(self.docx, self.docx, contract(), complete=False, code='preserve_limit')

    def test_xml_attribute_order_is_canonical_but_root_siblings_protected(self):
        # Serialization differences are accepted only in explicitly scoped XML parts.
        parts = package(self.docx)
        root = etree.fromstring(parts['word/document.xml'])
        for node in root.iter():
            attrs = list(node.attrib.items())
            node.attrib.clear()
            node.attrib.update(reversed(attrs))
        parts['word/document.xml'] = etree.tostring(root)
        output = save_package(self.dir / 'serialize.docx', parts)
        self.assert_preserved(self.docx, output, contract())
        parts['word/document.xml'] = b'<?unauthorized yes?>' + parts['word/document.xml']
        output = save_package(self.dir / 'pi.docx', parts)
        self.assert_rejected(self.docx, output, contract())

    def test_engine_rejects_collateral_before_rendering(self):
        output = self.mutate(self.edited_word(), 'word/document.xml',
                             lambda root: root.find('.//' + office.W('pgMar')).set(office.W('left'), '1'))
        with patch.object(office, 'soffice_convert', side_effect=AssertionError('Unsafe output must not render')):
            result = office.verify(self.docx, output, str(self.dir / 'preview'), expect={'preserve': contract()})
        self.assertFalse(result['ok'], result)
        self.assertTrue(result['preserve']['complete'])
        self.assertFalse(result['composites'])
        self.assertIn('No se ejecutó la revisión visual', result['summary'])


if __name__ == '__main__':
    unittest.main()
