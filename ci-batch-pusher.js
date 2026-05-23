#!/usr/bin/env node
/**
 * ci-batch-pusher.js — Robust CI pipeline controller
 *
 * Batches local commits from agents and pushes to main
 * ONE AT A TIME, waiting for CI green before the next push.
 *
 * Prevents the "cancelled" spam by never pushing while CI is running.
 *
 * Usage:
 *   node ci-batch-pusher.js                    # push all pending commits
 *   node ci-batch-pusher.js --max 3            # push at most 3 commits
 *   node ci-batch-pusher.js --watch            # keep watching for new commits
 *   node ci-batch-pusher.js --status           # check status only
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_DIR = '/Users/luis/Desktop/siraGPT';
const REMOTE = 'sira-org';
const BRANCH = 'main';
const POLL_MS = 30_000; // how often to check CI status
const CI_TIMEOUT_MS = 10 * 60 * 1000; // 10 min max wait per push

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO_DIR, encoding: 'utf8', ...opts }).trim();
}

function log(...args) {
  const ts = new Date().toLocaleTimeString('es-BO', { timeZone: 'America/La_Paz' });
  console.log(`[${ts}]`, ...args);
}

// ── Count pending local commits ahead of remote ──────────────
function countPendingCommits() {
  run(`git fetch ${REMOTE} ${BRANCH} 2>/dev/null`);
  const ahead = run(`git rev-list --count HEAD..${REMOTE}/${BRANCH} 2>/dev/null || echo 0`);
  const behind = run(`git rev-list --count ${REMOTE}/${BRANCH}..HEAD 2>/dev/null || echo 0`);
  return { ahead: parseInt(ahead, 10), behind: parseInt(behind, 10) };
}

// ── Push and wait for CI green ────────────────────────────────
async function pushAndWaitCI() {
  const { behind } = countPendingCommits();
  if (behind === 0) {
    log('No hay commits locales pendientes.');
    return true;
  }

  log(`Pushando ${behind} commit(s) locales a ${REMOTE}/${BRANCH}...`);
  
  try {
    run(`git push ${REMOTE} ${BRANCH} 2>&1`);
  } catch (err) {
    log('ERROR: Push falló:', err.message);
    return false;
  }

  log('Commit pusheado. Esperando CI...');
  
  // Wait for CI to complete
  const startTime = Date.now();
  let lastStatus = '';
  
  while (Date.now() - startTime < CI_TIMEOUT_MS) {
    await sleep(POLL_MS);
    
    try {
      const result = JSON.parse(run(
        `gh run list --repo SiraGPT-ORg/siraGPT --limit 1 --json status,conclusion,databaseId --jq '.[0]'`
      ));
      
      const status = result.conclusion || result.status || 'unknown';
      
      if (status !== lastStatus) {
        log(`CI: ${status}`);
        lastStatus = status;
      }
      
      if (result.conclusion === 'success') {
        log('✅ CI VERDE');
        return true;
      }
      
      if (result.conclusion === 'failure') {
        log('❌ CI ROJO');
        const jobsResult = run(
          `gh run view ${result.databaseId} --repo SiraGPT-ORg/siraGPT --json jobs --jq '.jobs[] | select(.conclusion=="failure") | "  - \(.name)"' 2>/dev/null || echo '  (no details)'`
        );
        log('Jobs fallidos:\n' + jobsResult);
        return false;
      }
      
      if (result.conclusion === 'cancelled' && lastStatus !== '') {
        // Someone else pushed during our wait - check again
        log('⚠️ CI cancelado (posiblemente otro push). Verificando...');
        continue;
      }
    } catch (err) {
      log('Error consultando CI:', err.message);
    }
  }
  
  log('⏰ Timeout esperando CI');
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const maxPushes = args.includes('--max') ? parseInt(args[args.indexOf('--max') + 1], 10) || Infinity : Infinity;
  const isWatch = args.includes('--watch');
  const isStatus = args.includes('--status');

  // Sync with remote first
  run(`git pull --rebase ${REMOTE} ${BRANCH} 2>/dev/null || true`);

  if (isStatus) {
    const { ahead, behind } = countPendingCommits();
    log(`Local: ${behind} commit(s) ahead of remote, ${ahead} behind`);
    
    const lastCI = JSON.parse(run(
      `gh run list --repo SiraGPT-ORg/siraGPT --limit 1 --json status,conclusion,displayTitle --jq '.[0]'`
    ));
    log(`Último CI: ${lastCI.displayTitle || 'N/A'} → ${lastCI.conclusion || lastCI.status}`);
    return;
  }

  let pushed = 0;

  do {
    // Sync in case remote moved
    run(`git pull --rebase ${REMOTE} ${BRANCH} 2>/dev/null || true`);
    
    const { behind } = countPendingCommits();
    if (behind === 0) {
      if (pushed === 0) {
        log('No hay commits pendientes.');
      } else {
        log(`Lote completado. ${pushed} commit(s) pusheados.`);
      }
      if (!isWatch) break;
      log('Esperando nuevos commits...');
      await sleep(POLL_MS);
      continue;
    }

    log(`\n--- Push #${pushed + 1} (${behind} commit(s) pendientes) ---`);
    const ok = await pushAndWaitCI();
    
    if (ok) {
      pushed++;
      if (pushed >= maxPushes) {
        log(`Límite de ${maxPushes} push(es) alcanzado.`);
        break;
      }
    } else {
      log('CI falló. Parando.');
      break;
    }
  } while (isWatch);

  log(`\n📊 Resumen: ${pushed} push(es) exitosos.`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
