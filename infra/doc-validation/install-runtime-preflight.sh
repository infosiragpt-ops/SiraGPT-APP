#!/bin/sh
# Read-only host inspection from the constrained deploy SSH landing container.
# This creates one short-lived, non-privileged helper; it changes no host files.
set -eu

runtime_helper_image=${1:?Pass an existing, reviewed sha256 image ID with Node.js}
case "$runtime_helper_image" in sha256:*) ;; *) exit 64 ;; esac
[ "${#runtime_helper_image}" -eq 71 ] || exit 64
case "${runtime_helper_image#sha256:}" in *[!0-9a-f]*) exit 64 ;; esac

docker info --format 'engine={{.ServerVersion}} cpus={{.NCPU}} memory={{.MemTotal}} default={{.DefaultRuntime}}'
docker info --format '{{range $name, $runtime := .Runtimes}}runtime={{$name}}{{println}}{{end}}'
# Inspect state, never Config.Env, mounts, labels or other secret-bearing fields.
docker ps -q | while IFS= read -r runtime_container_id; do
  docker inspect --format '{{.Id}} {{.Name}} pid={{.State.Pid}} started={{.State.StartedAt}} status={{.State.Status}}' "$runtime_container_id"
done

docker run --rm -i --pull never --network none --cap-drop ALL \
  --security-opt no-new-privileges --read-only --user 0:0 \
  --memory 128m --cpus 0.25 --pids-limit 32 \
  --label siragpt.role=doc-validation-runtime-preflight \
  --mount type=bind,src=/etc/docker,dst=/host-docker,readonly \
  --mount type=bind,src=/usr/local/bin,dst=/host-local-bin,readonly \
  --mount type=bind,src=/run/docker.pid,dst=/host-docker.pid,readonly \
  --mount type=bind,src=/proc,dst=/host-proc,readonly \
  --entrypoint node "$runtime_helper_image" - <<'NODE'
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const configuration = '/host-docker/daemon.json';
let config = { exists: false };
if (fs.existsSync(configuration)) {
  const stat = fs.lstatSync(configuration);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error('unsafe_config_file');
  const bytes = fs.readFileSync(configuration);
  const data = JSON.parse(bytes.toString('utf8'));
  if (!data || Array.isArray(data) || typeof data !== 'object') throw Error('invalid_config_object');
  config = { exists: true, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    uid: stat.uid, gid: stat.gid, mode: (stat.mode & 0o777).toString(8),
    keys: Object.keys(data).sort(), runtimeNames: Object.keys(data.runtimes || {}).sort(),
    defaultRuntime: data['default-runtime'] ?? null };
}
const pidText = fs.readFileSync('/host-docker.pid', 'utf8').trim();
if (!/^[1-9][0-9]{0,8}$/.test(pidText)) throw Error('invalid_daemon_pid');
const comm = fs.readFileSync(`/host-proc/${pidText}/comm`, 'utf8').trim();
if (comm !== 'dockerd') throw Error('unexpected_daemon_process');
const stat = fs.readFileSync(`/host-proc/${pidText}/stat`, 'utf8');
const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
const args = fs.readFileSync(`/host-proc/${pidText}/cmdline`).toString('utf8').split('\0');
const explicitConfig = args.find(x => x.startsWith('--config-file='));
const configAt = args.indexOf('--config-file');
const configPath = explicitConfig ? explicitConfig.slice('--config-file='.length) :
  configAt >= 0 ? args[configAt + 1] : '/etc/docker/daemon.json';
const localBinaries = ['runsc', 'containerd-shim-runsc-v1', 'gvisor-bin'].map(name => {
  const target = '/host-local-bin/' + name;
  if (!fs.existsSync(target)) return { name, exists: false };
  const st = fs.lstatSync(target);
  return { name, exists: true, symlink: st.isSymbolicLink(), uid: st.uid, gid: st.gid,
    mode: (st.mode & 0o777).toString(8) };
});
console.log(JSON.stringify({ config, daemon: { pid: Number(pidText), comm,
  startTicks: afterComm[19], configPath, runtimeFlagPresent: args.some(x => x === '--add-runtime' || x.startsWith('--add-runtime=')) }, localBinaries }));
NODE
