"""Real startup-tool checks; direct execution does not attest gVisor isolation."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / 'src/modules/doc-sandbox/validation/validator.py'
spec = importlib.util.spec_from_file_location('readiness_validator', SCRIPT)
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class ReadinessTest(unittest.TestCase):
    def test_writer_calc_impress_export_open_extract_and_render(self):
        result = validator.preflight_tools()
        self.assertEqual(result['schemaVersion'], 1)
        self.assertEqual(set(result['applications']), {'writer', 'calc', 'impress'})
        for value in result['applications'].values():
            self.assertRegex(value, r'^[a-f0-9]{64}$')

    def test_direct_developer_execution_cannot_claim_isolated_readiness(self):
        import os
        self.assertNotEqual(os.getuid(), 65532, 'Run the direct-host test as the developer, not as the container UID.')
        with tempfile.TemporaryDirectory(prefix='doc-preflight-negative-') as temporary:
            source = Path(temporary) / 'readiness.txt'
            source.write_text('SiraGPT startup probe', encoding='utf-8')
            with self.assertRaises(validator.ValidationFailure) as error:
                validator.run({'command': 'preflight', 'inputs': [{'id': 'startup', 'path': str(source), 'name': source.name}]})
            self.assertEqual(error.exception.code, 'PREFLIGHT_IDENTITY')


if __name__ == '__main__':
    unittest.main()
