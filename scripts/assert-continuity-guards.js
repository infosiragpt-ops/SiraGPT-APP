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
const { OPENSPEC_SKILLS } = require('../backend/src/skills/openspec-catalog');

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

// 1. Activos header quick-off + visible-model-catalog passthrough
check(() => {
  mustMatch('backend/src/services/visible-model-catalog.js', /activar = visible/, 'passthrough comment');
  mustMatch('backend/src/services/visible-model-catalog.js', /function curateVisibleTextModels/, 'curateVisibleTextModels');
  mustMatch('backend/src/services/visible-model-catalog.js', /const passthrough = \[\]/, 'passthrough array');
  mustMatch('backend/src/services/visible-model-catalog.js', /isActive === false/, 'isActive gate');
  mustMatch('backend/src/routes/ai.js', /curateVisibleTextModels/, 'catalog wired into /api/ai');
  mustExist('lib/admin-activos-lock.ts');
  mustMatch('lib/admin-activos-lock.ts', /ACTIVOS_HEADER_TITLE = "Activos"/, 'Activos title SSOT');
  mustMatch('lib/admin-activos-lock.ts', /ACTIVOS_QUICK_OFF_ARIA = "Ver activos"/, 'quick-off aria SSOT');
  mustMatch('app/admin/models/page.tsx', /activosOpen/, 'Activos dialog state');
  mustMatch('app/admin/models/page.tsx', /title="Activos"/, 'Activos header card');
  mustMatch('app/admin/models/page.tsx', /aria-label="Ver activos"/, 'Activos header quick-off');
  mustMatch('app/admin/models/page.tsx', /Modelos activos/, 'Activos dialog title');
  mustMatch('app/admin/models/page.tsx', /Desactiva modelos sin recorrer la tabla completa/, 'quick-off copy');
  mustMatch('app/admin/models/page.tsx', /ariaLabel="Desactivar modelo"/, 'per-row quick-off switch');
});

// 2. /code desktop UI lock
check(() => {
  mustExist('docs/code-ui-lock.md');
  mustExist('lib/code-chrome-lock.ts');
  mustExist('scripts/reapply-code-ui-lock.sh');
  mustMatch('lib/code-chrome-lock.ts', /showForbiddenCompanyNav: false/, 'nav lock');
  mustMatch('lib/code-chrome-lock.ts', /showRunPublishButtons: false/, 'run/publish lock');
  mustMatch('lib/code-chrome-lock.ts', /hideDesktopTopBarOnPhone: true/, 'phone hides desktop top bar');
  mustMatch('components/code/workspace-top-bar.tsx', /CODE_CHROME_LOCK/, 'top bar uses lock');
  mustMatch('components/code/agent-company-panel.tsx', /CODE_CHROME_LOCK/, 'company panel uses lock');
  mustMatch('components/code/agent-company-panel.tsx', /data-testid="code-routines-slot"/, 'Routines slot');
});

// 3. /code mobile Grok chrome + blank-chat fix selectors
check(() => {
  mustExist('lib/code-mobile-grok.ts');
  mustExist('components/code/code-mobile-grok-chrome.tsx');
  mustMatch('hooks/use-mobile.tsx', /export function useResolvedMobile/, 'useResolvedMobile');
  mustMatch('components/code/ai-code-chat-panel.tsx', /useResolvedMobile/, 'chat uses useResolvedMobile');
  mustMatch('components/code/ai-code-chat-panel.tsx', /isMobileGrok \? null/, 'EmptyChat null on mobile');
  mustMatch('components/code/ai-code-chat-panel.tsx', /data-code-mobile-grok/, 'mobile grok data attr');
  mustMatch('components/code/ai-code-chat-panel.tsx', /<CodeMobileGrokHeader/, 'Grok header mounted');
  mustMatch('app/globals.css', /\.code-composer\s*\{[\s\S]{0,220}width:\s*100%/, 'composer width 100%');
});

// 4. Responsive phone overlays
check(() => {
  mustMatch('hooks/use-mobile.tsx', /DOCUMENT_PREVIEW_OVERLAY_MAX_PX/, 'doc overlay breakpoint');
  mustMatch('hooks/use-mobile.tsx', /export function useDocumentPreviewOverlay/, 'doc overlay hook');
  mustExist('docs/responsive-phone-web.md');
  mustMatch('components/code/code-workspace.tsx', /hideDesktopTopBarOnPhone/, 'phone hides desktop top bar');
  mustMatch('components/code/code-workspace.tsx', /CodeMobileComputerOverlay/, 'phone computer overlay');
});

// 5. Doc engine FEATURE_DOC_ENGINE end-to-end
check(() => {
  mustMatch('backend/src/services/doc-engine/flags.js', /FEATURE_DOC_ENGINE/, 'FEATURE_DOC_ENGINE');
  mustMatch('backend/src/services/doc-engine/flags.js', /function isTemplateTransformRequest/, 'UPN classifier');
  mustMatch('backend/src/services/doc-engine/chat-bridge.js', /tryDocEngineAfterSelection/, 'tryDocEngineAfterSelection');
  mustMatch('backend/src/services/doc-engine/chat-bridge.js', /OpenRouter está prohibido/, 'doc-engine forbids OpenRouter');
  mustMatch('backend/src/services/source-preserving-document-edit.js', /tryDocEngineAfterSelection/, 'hook in source-preserving edit');
  mustMatch('backend/src/services/source-preserving-document-edit.js', /isTemplateTransformRequest/, 'UPN / template cue');
  mustMatch('backend/src/services/source-preserving-document-edit.js', /selectDocxPreviewPath/, 'preview hydrate in persist');
  mustExist('backend/src/services/doc-engine/preview-path.js');
  mustMatch('backend/src/services/doc-engine/preview-path.js', /soffice_pdf/, 'LibreOffice PDF preview');
  mustMatch('backend/src/services/doc-engine/transform-to-template.js', /sectPr/, 'sectPr preservation');
  mustMatch('backend/src/services/agentic-chat-stream.js', /previewPdfUrl/, 'chat stream PDF preview');
  mustExist('backend/src/routes/documents.js');
  mustMatch('backend/index.js', /\/api\/documents/, 'documents route mounted');
  mustMatch('backend/src/middleware/csrf-route-policy.js', /\/api\/documents/, 'documents CSRF exception');
});

// 6. Pensando Claude-style stepper
check(() => {
  mustExist('components/claude-thinking-timeline.tsx');
  mustMatch('components/claude-thinking-timeline.tsx', /export function ClaudeThinkingTimeline/, 'timeline export');
  mustMatch('components/thinking-trace.tsx', /ClaudeThinkingTimeline/, 'thinking trace uses timeline');
  mustMatch('components/thinking-placeholder.tsx', /Pensando/, 'Pensando placeholder');
  mustMatch('components/thinking-placeholder.tsx', /ClaudeThinkingTimeline/, 'placeholder uses timeline');
  mustMatch('components/agent-trace.tsx', /ClaudeThinkingTimeline/, 'agent trace uses timeline');
  mustMatch('components/message-component.tsx', /ThinkingPlaceholder/, 'chat message mounts placeholder');
  mustMatch('components/message-component.tsx', /ThinkingTrace/, 'chat message mounts trace');
});

// 7. SDIE v2 Phase 1 generate path
check(() => {
  mustExist('backend/src/services/sdie/index.js');
  mustMatch('backend/src/services/sdie/flags.js', /FEATURE_SDIE_V2/, 'FEATURE_SDIE_V2');
  mustMatch('backend/src/routes/ai.js', /runSdieTurn/, 'SDIE hooked in generate');
  mustMatch('backend/src/services/sdie/generate.js', /createNativeDeepSeekClient/, 'SDIE DeepSeek client');
  mustMatch('backend/src/services/sdie/generate.js', /assertDeepSeekOnly/, 'SDIE DeepSeek lock');
  mustMatch('backend/src/services/message-attachments.js', /shouldSkipRetrieveEvidenceForQuery/, 'SDIE retrieve bypass');
  mustMatch('backend/src/services/message-attachments.js', /skipTopKEvidence/, 'SDIE skip top-k');
  mustExist('docs/sdie-v2.md');
});

// 8. /code ChunkLoad hard-reload
check(() => {
  mustExist('lib/client-bundle-recovery.ts');
  mustMatch('app/code/error.tsx', /maybeReloadStaleClientBundle/, '/code ChunkLoad helper');
  mustMatch('app/error.tsx', /maybeReloadStaleClientBundle/, 'root ChunkLoad helper');
  mustMatch('app/code/error.tsx', /window\.location\.reload/, 'hard reload, not reset-only');
  mustExist('lib/code-workspace-bootstrap.ts');
  mustMatch('app/code/page.tsx', /CodeWorkspaceBootstrap/, 'workspace bootstrap wrapper');
});

// 9. Persistent agent computer / noVNC
check(() => {
  mustMatch('backend/index.js', /\/api\/agent-computer/, 'agent-computer mounted');
  mustMatch('backend/index.js', /\/api\/departments/, 'dept-computer mounted');
  mustMatch('backend/src/middleware/csrf-route-policy.js', /\/api\/agent-computer/, 'ACS CSRF exception');
  mustMatch('deploy/Caddyfile', /\/agent-computer/, 'Caddy noVNC path');
  mustMatch('deploy/Caddyfile', /embed-auth/, 'Caddy forward_auth');
  mustMatch('deploy/Caddyfile', /computer\.siragpt\.com/, 'ACS host');
  mustMatch('components/code/code-workspace.tsx', /DepartmentComputerPane/, 'Computadora pane');
  mustMatch('components/code/code-workspace.tsx', /CODE_OPEN_DEPARTMENT_COMPUTER_EVENT|onOpenDepartmentComputer/, 'Computadora event');
});

// 10. DeepSeek-only generate — never reintroduce OpenRouter on generate
check(() => {
  mustExist('lib/generation-model-lock.ts');
  mustMatch('lib/generation-model-lock.ts', /FORBIDDEN_GENERATE_PROVIDER_RE/, 'provider deny-list');
  mustMatch('lib/generation-model-lock.ts', /openrouter/, 'lock names OpenRouter');
  mustMatch('lib/chat/catalog-model.ts', /generation-model-lock/, 'chat picker uses SSOT');
  mustMatch('lib/code-agent/model-policy.ts', /generation-model-lock/, 'code picker uses SSOT');
  mustMatch('lib/chat-context-integrated.tsx', /resolveCatalogModel/, 'chat generate uses lock');
  mustMatch('components/code/ai-code-chat-panel.tsx', /listDeepSeekGenerationModels/, 'code picker DeepSeek-only');
  mustMatch('backend/src/services/agent-gateway/index.js', /assertNativeGatewayGenerate/, 'gateway DeepSeek lock');
  mustNotMatch(
    'backend/src/services/sdie/generate.js',
    /createOpenRouter|OPENROUTER_API_KEY|provider:\s*['"]OpenRouter/,
    'SDIE OpenRouter generate client',
  );
  mustNotMatch(
    'backend/src/services/doc-engine/chat-bridge.js',
    /createOpenRouter|OPENROUTER_API_KEY/,
    'doc-engine OpenRouter generate client',
  );
  mustNotMatch(
    'backend/src/services/agent-gateway/index.js',
    /createOpenRouter|OPENROUTER_API_KEY/,
    'gateway OpenRouter generate client',
  );
});

// 11. OpenSpec in /code (instruction skills, not handler-style)
check(() => {
  mustExist('backend/src/skills/openspec-catalog.js');
  mustMatch('backend/src/services/agent-runner/skills/index.js', /openspecSkillsRoot/, 'agent-runner loads OpenSpec root');
  for (const name of OPENSPEC_SKILLS) {
    mustExist(`backend/src/skills/${name}/SKILL.md`);
    mustMatch(`backend/src/skills/${name}/SKILL.md`, /^description:\s+\S+/m, `${name} description`);
  }
});

// Meta + hard FE recreate ban
check(() => {
  mustExist('docs/continuity-guards.md');
  mustExist('docs/CODE_CONTINUITY.md');
  mustMatch('docs/continuity-guards.md', /HARD BAN/, 'FE recreate hard ban');
  mustMatch('docs/CODE_CONTINUITY.md', /HARD BAN/, 'CODE_CONTINUITY hard ban');
  mustNotMatch(
    'docs/continuity-guards.md',
    /may\s+`--force-recreate` the \*\*frontend\*\*/,
    'optional FE recreate wording',
  );
});

if (failures.length) {
  console.error('continuity-guards FAILED:');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(`continuity-guards: OK (${11} feature anchors + docs)`);
