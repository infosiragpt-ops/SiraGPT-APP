#!/bin/sh
# Download only into a new private directory in the SSH landing container.
set -eu
umask 077
runtime_available_kb=$(df -Pk /tmp | awk 'NR == 2 { print $4 }')
case "$runtime_available_kb" in ''|*[!0-9]*) exit 65 ;; esac
if [ "$runtime_available_kb" -lt 200000 ]; then
  printf '%s\n' 'Insufficient private staging space; download on the workstation and stream to the installer.' >&2
  exit 65
fi
runtime_stage=$(mktemp -d /tmp/siragpt-gvisor-20260817.0.XXXXXXXX)
curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  --connect-timeout 20 --max-time 300 --max-filesize 164966070 \
  --output "$runtime_stage/gvisor.tar.bz2" \
  https://storage.googleapis.com/gvisor/releases/release/20260817.0/x86_64/gvisor.tar.bz2
[ "$(wc -c < "$runtime_stage/gvisor.tar.bz2" | tr -d ' ')" = 164966070 ]
runtime_hash=$(sha512sum "$runtime_stage/gvisor.tar.bz2")
runtime_hash=${runtime_hash%% *}
[ "$runtime_hash" = bd8271a7742f90e53373b2a8613f37f3ae2c765ff5e2e611a75a47167a323cab7519b149c50273307743491713525a14ad1b3e398651c93b16f3e248dfeff3dd ]
printf 'verified_stage=%s\n' "$runtime_stage"
tar -tvjf "$runtime_stage/gvisor.tar.bz2"
