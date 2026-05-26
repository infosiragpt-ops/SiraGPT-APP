#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# siraGPT — Flaky Test Detector
# ──────────────────────────────────────────────────────────────
# Runs the backend test suite N times and reports any individual
# test name whose pass/fail outcome varies between runs.
#
# Why:
#   - CI hygiene. A test that fails 1-in-20 will silently rot the
#     signal of every PR run. This script lets you (or a nightly
#     workflow) prove a suite is stable before relying on it.
#
# Output:
#   - Per-run summary (run N: <passed>/<total> passed in <ms>)
#   - A list of tests that were inconsistent (failed in some runs
#     but passed in others) — these are the flaky ones.
#   - Exit 0 if no flakes detected, exit 1 otherwise.
#
# Usage:
#   ./scripts/find-flaky-tests.sh              # 5 runs (default)
#   ./scripts/find-flaky-tests.sh 10           # 10 runs
#   RUNS=20 ./scripts/find-flaky-tests.sh      # env var form
#   TEST_CMD="npm test" ./scripts/find-flaky-tests.sh   # override
#
# Notes:
#   - Uses Node's `--test` TAP-ish output. Each `# fail <n>` /
#     `not ok <n>` line is parsed; passing names are tracked too.
#   - Per-run logs live in tmp/flaky-runs/run-<i>.log so you can
#     re-inspect after a hit.
# ──────────────────────────────────────────────────────────────

set -uo pipefail

RUNS="${1:-${RUNS:-5}}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${PROJECT_ROOT}/tmp/flaky-runs"

# Default: backend test suite. The backend `npm test` is a long
# list of `node --test ...` so we run it directly via the script
# entry to capture per-test TAP-ish output cleanly.
TEST_CMD="${TEST_CMD:-cd backend && npm test --silent 2>&1}"

mkdir -p "${LOG_DIR}"
rm -f "${LOG_DIR}"/run-*.log "${LOG_DIR}"/seen-*.txt "${LOG_DIR}"/failed-*.txt

echo "[flaky] Running test suite ${RUNS}x — logs in ${LOG_DIR}"

ANY_RUN_FAILED=0

run_once() {
    local i="$1"
    local log="${LOG_DIR}/run-${i}.log"
    local seen="${LOG_DIR}/seen-${i}.txt"
    local failed="${LOG_DIR}/failed-${i}.txt"

    local start end dur_ms
    start=$(date +%s%N 2>/dev/null || python -c 'import time;print(int(time.time()*1e9))')

    # Run; do not abort on non-zero — we need the log either way.
    bash -c "${TEST_CMD}" > "${log}" 2>&1 || true

    end=$(date +%s%N 2>/dev/null || python -c 'import time;print(int(time.time()*1e9))')
    dur_ms=$(( (end - start) / 1000000 ))

    # Parse Node --test TAP output:
    #   ok 17 - test name           -> pass
    #   not ok 18 - test name       -> fail
    # Also accept subtest names ("    ok 1 - x").
    grep -E '^[[:space:]]*ok [0-9]+ - '     "${log}" | sed -E 's/^[[:space:]]*ok [0-9]+ - //'     | sort -u > "${seen}"
    grep -E '^[[:space:]]*not ok [0-9]+ - ' "${log}" | sed -E 's/^[[:space:]]*not ok [0-9]+ - //' | sort -u > "${failed}"

    # Union (passed + failed = all seen this run).
    sort -u "${seen}" "${failed}" -o "${seen}"

    local pass_n total_n
    pass_n=$(comm -23 "${seen}" "${failed}" | wc -l | tr -d ' ')
    total_n=$(wc -l < "${seen}" | tr -d ' ')

    if [[ -s "${failed}" ]]; then
        ANY_RUN_FAILED=1
        echo "[flaky] run ${i}: ${pass_n}/${total_n} passed in ${dur_ms}ms ($(wc -l < "${failed}" | tr -d ' ') failed)"
    else
        echo "[flaky] run ${i}: ${pass_n}/${total_n} passed in ${dur_ms}ms"
    fi
}

for i in $(seq 1 "${RUNS}"); do
    run_once "${i}"
done

# Aggregate: a test is flaky iff it appears in at least one failed-*.txt
# AND is missing from at least one failed-*.txt while appearing in seen-*.txt
# (i.e. it passed in some runs and failed in others).
all_failed=$(mktemp)
cat "${LOG_DIR}"/failed-*.txt 2>/dev/null | sort -u > "${all_failed}"

if [[ ! -s "${all_failed}" ]]; then
    echo "[flaky] ✅ No failures across ${RUNS} runs — suite is stable."
    rm -f "${all_failed}"
    exit 0
fi

flaky=$(mktemp)
> "${flaky}"
while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    failed_in=0
    passed_in=0
    for i in $(seq 1 "${RUNS}"); do
        if grep -Fxq "${name}" "${LOG_DIR}/failed-${i}.txt" 2>/dev/null; then
            failed_in=$((failed_in + 1))
        elif grep -Fxq "${name}" "${LOG_DIR}/seen-${i}.txt" 2>/dev/null; then
            passed_in=$((passed_in + 1))
        fi
    done
    if [[ ${failed_in} -gt 0 && ${passed_in} -gt 0 ]]; then
        printf '%s\tfailed=%d/%d  passed=%d/%d\n' "${name}" "${failed_in}" "${RUNS}" "${passed_in}" "${RUNS}" >> "${flaky}"
    fi
done < "${all_failed}"

if [[ -s "${flaky}" ]]; then
    echo ""
    echo "[flaky] ⚠️  Detected inconsistent tests:"
    echo "---------------------------------------------"
    cat "${flaky}"
    echo "---------------------------------------------"
    rm -f "${all_failed}" "${flaky}"
    exit 1
fi

# All failures were consistent — that's a real failure, not flake.
echo ""
echo "[flaky] No flakes detected, but ${ANY_RUN_FAILED} run(s) had consistent failures:"
cat "${all_failed}"
rm -f "${all_failed}" "${flaky}"
exit 1
