'use strict';

// A fake `python3` for the sandbox installer tests: `python3 -m pip install
// … --report X` writes an importable tree with real dist-info + a report (no
// network, no real pip). Inventory, validators and atomic activation scripts
// run in the REAL interpreter by absolute path without fake behavior.
// Env knobs: FAKE_PIP_DEP adds a resolved dependency to the report,
// FAKE_PIP_FAIL=notfound makes pip fail like a missing distribution,
// FAKE_PIP_FAIL=network like an unreachable index, FAKE_PIP_SLEEP sleeps,
// FAKE_PIP_PTH plants a marker-forging .pth, FAKE_PIP_ARGS_LOG records argv.
// `python3 -m pip list` prints a frozen image (constraints source).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function realPython3() {
  try { return execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim(); } catch (_) { return ''; }
}

function writeFakePython3(dir, { realPython = realPython3() } = {}) {
  if (!realPython) throw new Error('fake-pip-python: no real python3 on PATH');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'python3');
  fs.writeFileSync(file, `#!/usr/bin/env bash
REAL=${JSON.stringify(realPython)}
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "pip" ] && [ "\${3:-}" = "list" ]; then
  # The image's distributions, frozen as constraints by the install script
  # (one line has a non-PEP 440 version: the script must filter it out).
  printf 'numpy==2.1.0\nlxml==5.2.0\npython-apt==2.7.7ubuntu4\n'
  exit 0
fi
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "pip" ]; then
  [ -n "\${FAKE_PIP_ARGS_LOG:-}" ] && printf '%s\n' "$*" >> "$FAKE_PIP_ARGS_LOG"
  report=""; constraints=""; specs=(); dd=0; shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --report) report="$2"; shift 2; continue;;
      -c|--constraint) constraints="$2"; shift 2; continue;;
      --) dd=1; shift; continue;;
    esac
    if [ $dd -eq 1 ]; then specs+=("$1"); fi
    shift
  done
  echo "fake pip: \${specs[*]}" 1>&2
  [ -n "\${FAKE_PIP_SLEEP:-}" ] && sleep "$FAKE_PIP_SLEEP"
  if [ "\${FAKE_PIP_FAIL:-}" = "notfound" ]; then echo "ERROR: No matching distribution found for \${specs[0]}" 1>&2; exit 1; fi
  if [ "\${FAKE_PIP_FAIL:-}" = "network" ]; then echo "WARNING: Retrying after connection broken by NewConnectionError: Max retries exceeded" 1>&2; exit 1; fi
  "$REAL" -I -s - "$report" "$constraints" "\${specs[@]}" <<'PY_FAKE_PIP'
import json, os, pathlib, re, site, sys
report, constraint_file = sys.argv[1:3]
base = pathlib.Path(os.environ['PYTHONUSERBASE'])
# Use the interpreter's actual user-site scheme, including framework Python
# on macOS. This is also where a malicious .pth would really execute.
site_dir = pathlib.Path(site._get_path(str(base)))
site_dir.mkdir(parents=True, exist_ok=True)
(base / 'bin').mkdir(exist_ok=True)

def norm(value):
    return re.sub(r'[-_.]+', '-', value).lower()

versions = {}
if constraint_file:
    for line in pathlib.Path(constraint_file).read_text().splitlines():
        if '==' in line:
            key, version = line.split('=', 1)
            version = version.lstrip('=')
            versions[norm(key)] = version
packages = {}
for spec in sys.argv[3:]:
    name = norm(re.match(r'^[A-Za-z0-9._-]+', spec).group(0))
    exact = re.search(r'(?<![=!])={2,3}([^,]+)', spec)
    packages[name] = exact.group(1) if exact else versions.get(name, '1.2.3')
if os.environ.get('FAKE_PIP_DEP'):
    packages[norm(os.environ['FAKE_PIP_DEP'])] = '0.1'
for name, version in packages.items():
    module_dir = site_dir / name.replace('-', '_')
    module_dir.mkdir(exist_ok=True)
    (module_dir / '__init__.py').write_text('VERSION = ' + repr(version) + chr(10))
    with (module_dir / 'payload.bin').open('wb') as payload:
        remaining = int(os.environ.get('FAKE_PIP_BYTES', '64'))
        while remaining > 0:
            chunk = b'x' * min(remaining, 1024 * 1024)
            payload.write(chunk)
            remaining -= len(chunk)
    metadata_dir = site_dir / (name.replace('-', '_') + '-' + version + '.dist-info')
    metadata_dir.mkdir(exist_ok=True)
    (metadata_dir / 'METADATA').write_text(chr(10).join([
        'Metadata-Version: 2.1', 'Name: ' + name, 'Version: ' + version, '',
    ]))
if os.environ.get('FAKE_PIP_PTH'):
    (site_dir / 'evil.pth').write_text("import os, sys; sys.stderr.write('SIRA_PIP_OK []' + chr(10)); os._exit(0)" + chr(10))
pathlib.Path(report).write_text(json.dumps({'install': [
    {'metadata': {'name': name, 'version': version}} for name, version in packages.items()
]}))
PY_FAKE_PIP
  exit $?
fi
exec "$REAL" "$@"
`);
  fs.chmodSync(file, 0o755);
  return file;
}

module.exports = { writeFakePython3, realPython3 };
