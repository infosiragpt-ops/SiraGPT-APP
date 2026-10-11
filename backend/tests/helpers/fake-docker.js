'use strict';

// A fake `docker` CLI for the sandbox installer tests. It understands exactly
// the three shapes sandbox-pip.js emits — `docker run … IMAGE bash -c SCRIPT`
// (runs the installer script locally with the fake pip on PATH), `docker exec
// [-i] NAME sh -c SCRIPT` (runs the extract/commit/rollback script with
// /workspace mapped to FAKE_DOCKER_ROOT) and `docker rm -f NAME` — and logs
// every invocation to FAKE_DOCKER_LOG so a test can assert the exact flags.

const fs = require('node:fs');
const path = require('node:path');

function writeFakeDocker(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'docker');
  fs.writeFileSync(file, `#!/usr/bin/env bash
ROOT="\${FAKE_DOCKER_ROOT:?}"
TMPBASE="\${FAKE_DOCKER_TMP:?}"
argline="$*"; printf '%s\\n' "docker \${argline//$'\\n'/ ⏎ }" >> "\${FAKE_DOCKER_LOG:?}"
cmd="$1"; shift
case "$cmd" in
  run)
    allow=""; script=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -e) case "$2" in SIRA_PIP_ALLOW=*) allow="\${2#SIRA_PIP_ALLOW=}";; esac; shift 2; continue;;
        bash) shift; [ "\${1:-}" = "-c" ] && shift; script="$1"; break;;
      esac
      shift
    done
    [ -n "$script" ] || { echo "fake docker: no script" >&2; exit 2; }
    script="\${script//\\/tmp\\/sira-pkgs/$TMPBASE/sira-pkgs}"
    [ -n "\${FAKE_DOCKER_RUN_FAIL:-}" ] && { echo "docker: Error response from daemon: $FAKE_DOCKER_RUN_FAIL" >&2; exit 125; }
    SIRA_PIP_ALLOW="$allow" HOME="$TMPBASE" exec bash -c "$script"
    ;;
  exec)
    [ "$1" = "-i" ] && shift
    shift # container name
    [ "$1" = "-w" ] && shift 2
    { [ "$1" = "sh" ] || [ "$1" = "bash" ]; } && shift
    [ "$1" = "-c" ] && shift
    script="\${1//\\/workspace/$ROOT}"
    exec sh -c "$script"
    ;;
  rm) exit 0;;
  *) echo "fake docker: unsupported $cmd" >&2; exit 2;;
esac
`);
  fs.chmodSync(file, 0o755);
  return file;
}

module.exports = { writeFakeDocker };
