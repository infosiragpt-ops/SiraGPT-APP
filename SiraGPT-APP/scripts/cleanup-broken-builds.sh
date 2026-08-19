#!/usr/bin/env bash
#
# cleanup-broken-builds.sh — move stale `.next.broken-*` directories to /tmp
# so disk space can be reclaimed without an immediate destructive `rm -rf`.
#
# Cycle 30 audit flagged two stale Next.js build directories totalling ~3.7 GB:
#   - .next.broken-webpack-20260505013152/   (~1.5 GB)
#   - .next.broken-20260513-215724/          (~2.2 GB)
#
# Following cycle 30's safety guidance, this script DOES NOT delete the
# directories. It moves them to /tmp/siragpt-broken-builds-<timestamp>/ so the
# operating system can reclaim the space on the next /tmp purge (or you can
# `rm -rf` them yourself once you have verified you don't need them).
#
# Usage:
#     bash scripts/cleanup-broken-builds.sh             # interactive (prompt y/N)
#     bash scripts/cleanup-broken-builds.sh --yes       # non-interactive
#     bash scripts/cleanup-broken-builds.sh --dry-run   # show what would happen
#
# Exit codes:
#     0  success / nothing to do
#     1  user declined or an error occurred
#
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &>/dev/null && pwd)"
cd "$REPO_ROOT"

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    -h|--help)
      sed -n '1,30p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

shopt -s nullglob
TARGETS=( .next.broken-* )

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "No .next.broken-* directories found in $REPO_ROOT — nothing to do."
  exit 0
fi

echo "Found ${#TARGETS[@]} stale build directory/directories:"
TOTAL_BYTES=0
for d in "${TARGETS[@]}"; do
  if [[ -d "$d" ]]; then
    SIZE=$(du -sk "$d" 2>/dev/null | awk '{print $1}')
    SIZE_MB=$(( SIZE / 1024 ))
    TOTAL_BYTES=$(( TOTAL_BYTES + SIZE ))
    printf '  - %-50s %6d MB\n' "$d" "$SIZE_MB"
  fi
done
printf 'Total: %d MB (%.2f GB)\n' "$(( TOTAL_BYTES / 1024 ))" "$(echo "scale=2; $TOTAL_BYTES / 1024 / 1024" | bc)"

TS=$(date +%Y%m%d-%H%M%S)
DEST="/tmp/siragpt-broken-builds-${TS}"

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "[dry-run] Would create $DEST"
  for d in "${TARGETS[@]}"; do
    echo "[dry-run] Would mv $REPO_ROOT/$d -> $DEST/"
  done
  exit 0
fi

if [[ $ASSUME_YES -ne 1 ]]; then
  echo
  read -r -p "Move these directories to $DEST ? [y/N] " ans
  case "${ans:-N}" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

mkdir -p "$DEST"
for d in "${TARGETS[@]}"; do
  if [[ -d "$d" ]]; then
    echo "Moving $d -> $DEST/"
    mv -- "$d" "$DEST/"
  fi
done

echo
echo "Done. The directories now live at:"
echo "  $DEST"
echo
echo "Disk space will be reclaimed on the next /tmp purge."
echo "If you are sure you don't need them, run:"
echo "  rm -rf '$DEST'"
