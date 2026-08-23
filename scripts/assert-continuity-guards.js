#!/usr/bin/env node
'use strict';

/**
 * Lightweight CI assert for the /code golden chrome lock.
 *
 * Fail if Arrancando / the emerald run-stop control / the four company-home
 * nav labels return, or if Publicar / Routines / Computadora / EmptyChat-null
 * disappear. Broader product restorations belong in other PRs — this file
 * stays scoped to the chrome contract.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

function mustExist(rel) {
  const body = read(rel);
  if (body == null) throw new Error(`missing file: ${rel}`);
  return body;
}

function mustMatch(rel, re, label) {
  const body = mustExist(rel);
  if (!re.test(body)) throw new Error(`${rel}: missing ${label}`);
}

function mustNotMatch(rel, re, label) {
  const body = mustExist(rel);
  if (re.test(body)) throw new Error(`${rel}: forbidden ${label}`);
}

const failures = [];
function check(fn) {
  try { fn(); } catch (err) { failures.push(err.message || String(err)); }
}

check(() => {
  mustExist('docs/code-ui-lock.md');
  mustExist('lib/code-chrome-lock.ts');
  mustExist('scripts/reapply-code-ui-lock.sh');
  mustMatch('docs/code-ui-lock.md', /Arrancando/, 'doc names Arrancando ban');
  mustMatch('docs/code-ui-lock.md', /Publicar/, 'doc keeps Publicar');
  mustMatch('lib/code-chrome-lock.ts', /showForbiddenCompanyNav: false/, 'nav lock');
  mustMatch('lib/code-chrome-lock.ts', /showHeaderRunStopButton: false/, 'run-stop lock');
  mustMatch('lib/code-chrome-lock.ts', /keepPublishButton: true/, 'Publicar keep');
  mustMatch('lib/code-chrome-lock.ts', /"Arrancando"/, 'Arrancando in forbidden actions');
  mustMatch('lib/code-chrome-lock.ts', /"Ejecutar"/, 'Ejecutar in forbidden actions');
  mustMatch('lib/code-chrome-lock.ts', /"Detener"/, 'Detener in forbidden actions');
  mustNotMatch('lib/code-chrome-lock.ts', /forbiddenTopBarActions[\s\S]*"Publicar"/, 'Publicar must not be forbidden');
  for (const label of ['Panel', 'Controlar', 'Archivos', 'Recursos']) {
    mustMatch('lib/code-chrome-lock.ts', new RegExp(`"${label}"`), `forbidden nav ${label}`);
  }
});

check(() => {
  mustMatch('components/code/workspace-top-bar.tsx', /CODE_CHROME_LOCK/, 'top bar uses lock');
  mustMatch('components/code/workspace-top-bar.tsx', /CODE_CHROME_LOCK\.keepPublishButton/, 'Publicar gated by lock');
  mustMatch('components/code/workspace-top-bar.tsx', /workspace-header-department-computer/, 'Computadora button');
  mustMatch('components/code/workspace-top-bar.tsx', /bg-zinc-900/, 'Publicar zinc-900');
  mustMatch('components/code/workspace-top-bar.tsx', /Publicar/, 'Publicar label');
  mustNotMatch('components/code/workspace-top-bar.tsx', /workspace-header-run-stop/, 'emerald run/stop testid');
  mustNotMatch('components/code/workspace-top-bar.tsx', /Arrancando/, 'Arrancando header copy');
  mustNotMatch('components/code/workspace-top-bar.tsx', /showHeaderRunStopButton\s*\?/, 'gated run-stop remount');
});

check(() => {
  mustMatch('components/code/agent-company-panel.tsx', /CODE_CHROME_LOCK/, 'company panel uses lock');
  mustMatch('components/code/agent-company-panel.tsx', /CODE_CHROME_LOCK\.showForbiddenCompanyNav/, 'nav gated by lock');
  mustMatch('components/code/agent-company-panel.tsx', /data-testid="code-routines-slot"/, 'Routines slot');
  mustMatch('components/code/agent-company-panel.tsx', />Routines</, 'Routines label');
  for (const label of ['Panel', 'Controlar', 'Archivos', 'Recursos']) {
    mustNotMatch(
      'components/code/agent-company-panel.tsx',
      new RegExp(`label="${label}"`),
      `CompanyNavRow ${label}`,
    );
  }
});

check(() => {
  mustMatch('components/code/ai-code-chat-panel.tsx', /function EmptyChat/, 'EmptyChat helper');
  mustMatch(
    'components/code/ai-code-chat-panel.tsx',
    /function EmptyChat[\s\S]{0,400}return null/,
    'EmptyChat null',
  );
  mustMatch('components/code/code-workspace.tsx', /DepartmentComputerPane|CodeMobileComputerOverlay|onOpenDepartmentComputer/, 'Computadora wiring');
});

check(() => {
  const script = mustExist('scripts/reapply-code-ui-lock.sh');
  if (!script.includes('for arg in "$@"') && !script.includes('for arg in "$@"; do')) {
    throw new Error('scripts/reapply-code-ui-lock.sh: must parse --check without cd --');
  }
  if (/cd\s+--/.test(script)) {
    throw new Error('scripts/reapply-code-ui-lock.sh: forbidden cd -- (breaks on --check)');
  }
  mustMatch('scripts/reapply-code-ui-lock.sh', /workspace-header-run-stop/, 'script bans run-stop testid');
  mustMatch('scripts/reapply-code-ui-lock.sh', /Arrancando/, 'script bans Arrancando');
});

if (failures.length) {
  console.error('continuity-guards FAILED:');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log('continuity-guards: OK (code chrome lock + EmptyChat null)');
