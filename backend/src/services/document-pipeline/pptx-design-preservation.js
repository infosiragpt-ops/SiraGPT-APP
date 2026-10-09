'use strict';

// Only an independently verified title-only edit can inherit a defect.
// verifySlideTitleEdit proves that every other ZIP part (including slide size,
// relationships, themes, masters, layouts and media) is byte-identical. This is
// intentionally stricter than trying to infer a partial style dependency graph.
const { verifySlideTitleEdit } = require('../document-editing/edit-output-proof');
const { auditPptxDesign } = require('./pptx-design-audit');

function preserveUnchangedPptxSourceIssues({ sourceBuffer, outputBuffer, audit, edit } = {}) {
  if (!audit || audit.passed || edit?.kind !== 'set_slide_title'
    || !Number.isSafeInteger(edit.slideNumber) || edit.slideNumber < 1) return audit;
  const proof = verifySlideTitleEdit(sourceBuffer, outputBuffer, edit);
  if (!proof.passed || proof.scope !== 'requested_slide_title_and_unchanged_other_parts') return audit;
  const before = auditPptxDesign(sourceBuffer);
  if (!before.coverage.complete || before.issues.some((issue) => issue.severity === 'error' && !issue.slide)) return audit;
  const identity = (issue) => JSON.stringify([issue.code, issue.slide, issue.shapeId, issue.fontSizePt ?? null]);
  const existing = new Set(before.issues.filter((issue) => issue.severity === 'error').map(identity));
  const preservedSlides = new Set();
  const issues = audit.issues.map((issue) => {
    if (issue.severity !== 'error' || !Number.isSafeInteger(issue.slide)
      || issue.slide === edit.slideNumber || !existing.has(identity(issue))) return issue;
    preservedSlides.add(issue.slide);
    return { ...issue, severity: 'warning', inherited: true, originalSeverity: 'error' };
  });
  if (!preservedSlides.size) return audit;
  return {
    ...audit,
    issues,
    passed: !issues.some((issue) => issue.severity === 'error'),
    preservation: {
      rule: 'verified_title_edit_unchanged_other_package_parts',
      editedSlide: edit.slideNumber,
      unchangedSlides: [...preservedSlides].sort((a, b) => a - b),
      inheritedIssueCount: issues.filter((issue) => issue.inherited).length,
    },
  };
}

module.exports = { preserveUnchangedPptxSourceIssues };
