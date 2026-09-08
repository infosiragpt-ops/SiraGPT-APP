"""Measure real validator execution with Python's standard-library trace.

Usage: python trace-python-coverage.py PRIVATE_OUTPUT_DIR SCRIPT [ARGS...]
       python trace-python-coverage.py PRIVATE_OUTPUT_DIR -c CODE [ARGS...]

Each subprocess writes its own result so concurrent corpus tests can be combined
without replacing one another's counts. This launcher never changes validator
code, assertions, exit status or stdout. It measures lines, not branches.
"""
import json
import os
from pathlib import Path
import runpy
import sys
import trace
import uuid

target = Path(__file__).resolve().parents[2] / 'backend/src/modules/doc-sandbox/validation/validator.py'
if len(sys.argv) < 3:
    raise SystemExit('Private output directory and Python target required')
output = Path(sys.argv[1])
metadata = output.stat()
if not output.is_absolute() or output.resolve() != output or not output.is_dir() or metadata.st_mode & 0o077 or metadata.st_uid != os.getuid():
    raise SystemExit('Coverage output must be a private directory owned by the test runner')
arguments = sys.argv[2:]
tracer = trace.Trace(count=True, trace=False, ignoredirs=['/usr/lib', '/opt/validator-venv'])
sys.argv = arguments
try:
    if arguments[0] == '-c':
        if len(arguments) < 2:
            raise SystemExit('Python code required')
        sys.argv = ['-c', *arguments[2:]]
        tracer.runctx(compile(arguments[1], '<string>', 'exec'), {'__name__': '__main__'}, None)
    else:
        tracer.runfunc(runpy.run_path, arguments[0], run_name='__main__')
finally:
    # Use the same executable-line denominator as stdlib trace --missing.
    # No validator function or unexecuted branch is removed from this set.
    executable = sorted(trace._find_executable_linenos(str(target)))
    counts = tracer.results().counts
    hit = sorted(line for line in executable if counts.get((str(target), line), 0) > 0)
    payload = {'file': str(target), 'executable': executable, 'covered': hit}
    (output / f'{os.getpid()}-{uuid.uuid4()}.json').write_text(json.dumps(payload))
