'use strict';

// Closed diagnostics for critical UI gates. Never format a Playwright error,
// title, attachment or arbitrary path. The list reporter remains independent.
const SPEC_FILES = Object.freeze([
  'e2e/chat-github-connect.spec.ts',
  'e2e/chat-browser-live-progress.spec.ts',
  'e2e/chat-code-workspace.spec.ts',
  'e2e/codex-preview-cors.spec.ts',
  'e2e/chat-integrated-browser.spec.ts',
  'e2e/chat.spec.ts',
  'e2e/chat-upload.spec.ts',
  'e2e/document-task-error-recovery.spec.ts',
  'e2e/chat-composer-stable-size.spec.ts',
  'e2e/document-artifact-consistency.spec.ts',
  'e2e/voice-reference-layout.spec.ts',
  'e2e/chat-media-preview-players.spec.ts',
  'e2e/chat-computer-login-handoff.spec.ts',
]);
const RESULT_STATES = Object.freeze(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
const SAFE_PHASES = Object.freeze([
  'home_open', 'home_empty', 'home_create_tab', 'home_focus', 'home_focus_style',
  'home_focus_dark_border', 'home_focus_light_border', 'home_focus_outline',
  'home_focus_inactive', 'home_focus_token_missing', 'home_focus_rule_missing', 'home_focus_rule_unreadable',
  'home_focus_color_unparsed', 'home_focus_neutral', 'home_focus_color_notblue', 'home_focus_border_zero',
  'keyboard_tab_focus', 'keyboard_tab_focus_lost', 'keyboard_tab_indicator_missing',
  'keyboard_close_focus', 'keyboard_close_focus_lost', 'keyboard_close_indicator_missing', 'keyboard_focus_style',
  'home_navigate', 'home_viewport', 'home_no_chat', 'home_same_session',
  'home_url_owner', 'home_storage_owner', 'fixture_requests', 'frontend_exceptions',
]);

function ownValue(object, key) {
  if (object === null || typeof object !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function knownSpec(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.split('/').some((part) => part === '.' || part === '..')) return null;
  // Return the allowlisted constant, never the supplied string or its basename.
  return SPEC_FILES.find((file) => normalized === file || normalized.endsWith('/' + file)) || null;
}

function boundedInteger(value, minimum, maximum) {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function knownPhase(test) {
  const annotations = ownValue(test, 'annotations');
  try {
    if (!Array.isArray(annotations)) return null;
  } catch {
    return null;
  }
  const length = boundedInteger(ownValue(annotations, 'length'), 0, 64);
  if (length === null) return null;
  let phase = null;
  for (let index = 0; index < length; index += 1) {
    const annotation = ownValue(annotations, String(index));
    if (ownValue(annotation, 'type') !== 'sira_safe_ui_phase') continue;
    const description = ownValue(annotation, 'description');
    // Return only a constant from the closed catalog, never annotation content.
    const known = SAFE_PHASES.find((value) => value === description);
    if (known) phase = known;
  }
  return phase;
}

function failureAnnotation(test, result) {
  const rawStatus = ownValue(result, 'status');
  const status = RESULT_STATES.find((known) => known === rawStatus) || 'unknown';
  if (status === 'passed' || status === 'skipped') return null;
  const location = ownValue(test, 'location');
  const file = knownSpec(ownValue(location, 'file'));
  const line = boundedInteger(ownValue(location, 'line'), 1, 1_000_000);
  const retry = boundedInteger(ownValue(result, 'retry'), 0, 100);
  const properties = ['title=Critical UI case failed'];
  if (file) {
    properties.push('file=' + file);
    if (line !== null) properties.push('line=' + line);
  }
  const fields = ['spec=' + (file || 'unknown'), 'status=' + status];
  if (line !== null && file) fields.push('line=' + line);
  if (retry !== null) fields.push('retry=' + retry);
  const phase = knownPhase(test);
  if (phase) fields.push('phase=' + phase);
  return '::error ' + properties.join(',') + '::' + fields.join('; ') + '\n';
}

class CriticalUiSafeReporter {
  printsToStdio() { return true; }

  onTestEnd(test, result) {
    const annotation = failureAnnotation(test, result);
    if (annotation) process.stdout.write(annotation);
  }

  onError() {
    process.stdout.write('::error title=Critical UI runner failed::Critical UI runner failed; details omitted.\n');
  }
}

module.exports = CriticalUiSafeReporter;
module.exports.failureAnnotation = failureAnnotation;
