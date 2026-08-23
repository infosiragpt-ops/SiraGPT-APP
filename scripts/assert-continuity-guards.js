#!/usr/bin/env node
'use strict';

/**
 * Lightweight CI assert: fail if recurring production features are absent.
 * This is the git-anchored replacement for VPS-only patches that FE rebuilds
 * and engine-only waves used to wipe.
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

// 1. Activos header + visible-model-catalog passthrough (allowlist ∪ isActive)
check(() => {
  mustMatch('backend/src/services/visible-model-catalog.js', /activar = visible/, 'passthrough comment');
  mustMatch('backend/src/services/visible-model-catalog.js', /function curateVisibleTextModels/, 'curateVisibleTextModels');
  mustMatch('backend/src/services/visible-model-catalog.js', /const passthrough = \[\]/, 'passthrough array');
  mustMatch('backend/src/services/visible-model-catalog.js', /isActive === false/, 'isActive gate');
  mustMatch('app/admin/models/page.tsx', /activosOpen/, 'Activos dialog state');
  mustMatch('app/admin/models/page.tsx', /Modelos activos/, 'Activos dialog title');
  mustMatch('backend/src/routes/ai.js', /curateVisibleTextModels/, 'catalog wired into /api/ai');
});

// 2. /code desktop UI lock
check(() => {
  mustExist('docs/code-ui-lock.md');
  mustExist('lib/code-chrome-lock.ts');
  mustExist('scripts/reapply-code-ui-lock.sh');
  mustMatch('lib/code-chrome-lock.ts', /showForbiddenCompanyNav: false/, 'nav lock');
  mustMatch('lib/code-chrome-lock.ts', /showRunPublishButtons: false/, 'run/publish lock');
  mustMatch('components/code/workspace-top-bar.tsx', /CODE_CHROME_LOCK/, 'top bar uses lock');
  mustMatch('components/code/agent-company-panel.tsx', /CODE_CHROME_LOCK/, 'company panel uses lock');
});

// 3. /code mobile Grok chrome + blank-chat fix
check(() => {
  mustExist('lib/code-mobile-grok.ts');
  mustExist('components/code/code-mobile-grok-chrome.tsx');
  mustMatch('hooks/use-mobile.tsx', /export function useResolvedMobile/, 'useResolvedMobile');
  mustMatch('components/code/ai-code-chat-panel.tsx', /useResolvedMobile/, 'chat uses useResolvedMobile');
  mustMatch('components/code/ai-code-chat-panel.tsx', /isMobileGrok \? null/, 'EmptyChat null on mobile');
  mustMatch('app/globals.css', /\.code-composer\s*\{[\s\S]{0,220}width:\s*100%/, 'composer width 100%');
});

// 4. Responsive phone overlays
check(() => {
  mustMatch('hooks/use-mobile.tsx', /DOCUMENT_PREVIEW_OVERLAY_MAX_PX/, 'doc overlay breakpoint');
  mustExist('docs/responsive-phone-web.md');
  mustMatch('components/code/code-workspace.tsx', /hideDesktopTopBarOnPhone|isMobile === false \?/, 'phone hides desktop top bar');
});

// 5. Doc engine hook + UPN + preview
check(() => {
  mustMatch('backend/src/services/doc-engine/flags.js', /FEATURE_DOC_ENGINE/, 'FEATURE_DOC_ENGINE');
  mustMatch('backend/src/services/doc-engine/chat-bridge.js', /tryDocEngineAfterSelection/, 'tryDocEngineAfterSelection');
  mustMatch('backend/src/services/source-preserving-document-edit.js', /tryDocEngineAfterSelection/, 'hook in source-preserving edit');
  mustMatch('backend/src/services/source-preserving-document-edit.js', /isTemplateTransformRequest/, 'UPN / template cue');
  mustExist('backend/src/services/doc-engine/preview-path.js');
  mustMatch('backend/index.js', /\/api\/documents/, 'documents route mounted');
});

// 6. Pensando Claude-style stepper
check(() => {
  mustExist('components/claude-thinking-timeline.tsx');
  mustMatch('components/thinking-trace.tsx', /ClaudeThinkingTimeline/, 'thinking trace uses timeline');
  mustMatch('components/thinking-placeholder.tsx', /Pensando|thinking/, 'Pensando placeholder');
});

// 7. SDIE v2 Phase 1
check(() => {
  mustExist('backend/src/services/sdie/index.js');
  mustMatch('backend/src/services/sdie/flags.js', /FEATURE_SDIE_V2/, 'FEATURE_SDIE_V2');
  mustMatch('backend/src/routes/ai.js', /runSdieTurn/, 'SDIE hooked in generate');
  mustExist('docs/sdie-v2.md');
});

// 8. /code ChunkLoad hard-reload
check(() => {
  mustExist('lib/client-bundle-recovery.ts');
  mustMatch('app/code/error.tsx', /maybeReloadStaleClientBundle/, '/code ChunkLoad helper');
  mustMatch('app/error.tsx', /maybeReloadStaleClientBundle/, 'root ChunkLoad helper');
  mustMatch('app/code/error.tsx', /window\.location\.reload/, 'hard reload, not reset-only');
});

// 9. Persistent agent computer / noVNC
check(() => {
  mustMatch('backend/index.js', /\/api\/agent-computer/, 'agent-computer mounted');
  mustMatch('backend/index.js', /\/api\/departments/, 'dept-computer mounted');
  mustMatch('deploy/Caddyfile', /\/agent-computer/, 'Caddy noVNC path');
  mustMatch('components/code/code-workspace.tsx', /DepartmentComputerPane|CodeMobileComputerOverlay|onOpenDepartmentComputer/, 'Computadora wired');
});

// 10. DeepSeek-only generate — never reintroduce OpenRouter on generate
check(() => {
  mustMatch('backend/src/services/agent-gateway/index.js', /assertNativeGatewayGenerate/, 'gateway DeepSeek lock');
  mustMatch('lib/chat/catalog-model.ts', /openrouter/, 'chat picker rejects OpenRouter');
  mustMatch('lib/code-agent/model-policy.ts', /openrouter/, 'code picker rejects OpenRouter');
  mustNotMatch(
    'backend/src/services/sdie/generate.js',
    /createOpenRouter|OPENROUTER_API_KEY|provider:\s*['"]OpenRouter/,
    'SDIE OpenRouter generate client',
  );
});

// Meta
check(() => {
  mustExist('docs/continuity-guards.md');
  mustExist('docs/CODE_CONTINUITY.md');
});

if (failures.length) {
  console.error('continuity-guards FAILED:');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(`continuity-guards: OK (${10} feature anchors + docs)`);
