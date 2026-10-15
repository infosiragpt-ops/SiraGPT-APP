'use strict';

// A fake `python3` for the sandbox installer tests: `python3 -m pip install
// … --report X` writes a wheel-less "site" tree + a pip-style report (no
// network, no real pip), and `python3 - <base>` (the validation step of the
// install script) is forwarded to the REAL interpreter by absolute path.
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
  report=""; specs=(); dd=0; shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --report) report="$2"; shift 2; continue;;
      --) dd=1; shift; continue;;
    esac
    if [ $dd -eq 1 ]; then specs+=("$1"); fi
    shift
  done
  echo "fake pip: \${specs[*]}" 1>&2
  [ -n "\${FAKE_PIP_SLEEP:-}" ] && sleep "$FAKE_PIP_SLEEP"
  if [ "\${FAKE_PIP_FAIL:-}" = "notfound" ]; then echo "ERROR: No matching distribution found for \${specs[0]}" 1>&2; exit 1; fi
  if [ "\${FAKE_PIP_FAIL:-}" = "network" ]; then echo "WARNING: Retrying after connection broken by NewConnectionError: Max retries exceeded" 1>&2; exit 1; fi
  name="\${specs[0]%%[=<>~!\\[]*}"
  site="$PYTHONUSERBASE/lib/python3.12/site-packages"
  mkdir -p "$site/$name" "$PYTHONUSERBASE/bin"
  echo "VERSION = '1.2.3'" > "$site/$name/__init__.py"
  head -c "\${FAKE_PIP_BYTES:-64}" /dev/zero > "$site/$name/payload.bin"
  if [ -n "\${FAKE_PIP_PTH:-}" ]; then
    # A hostile wheel: a .pth in the REAL interpreter's user site that forges
    # the validator's success marker if site.py ever processes it.
    ver=$("$REAL" -c 'import sys;print("%d.%d"%sys.version_info[:2])')
    realsite="$PYTHONUSERBASE/lib/python$ver/site-packages"
    mkdir -p "$realsite"
    echo "import os, sys; sys.stderr.write('SIRA_PIP_OK []\\n'); os._exit(0)" > "$realsite/evil.pth"
  fi
  extra=""
  if [ -n "\${FAKE_PIP_DEP:-}" ]; then extra=",{\\"metadata\\":{\\"name\\":\\"$FAKE_PIP_DEP\\",\\"version\\":\\"0.1\\"}}"; fi
  printf '{"install":[{"metadata":{"name":"%s","version":"1.2.3"}}%s]}\\n' "$name" "$extra" > "$report"
  exit 0
fi
exec "$REAL" "$@"
`);
  fs.chmodSync(file, 0o755);
  return file;
}

module.exports = { writeFakePython3, realPython3 };
