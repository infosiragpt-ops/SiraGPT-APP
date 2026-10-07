'use strict';

// The structural gate and an optional rendered review answer different
// questions. Keep their evidence separate; never label a sample as full QA.
function applyPptxVisualReview(validation, critique) {
  const totalPages = Number(validation.details?.slides || critique?.totalPages) || 0;
  const pagesRendered = Number(critique?.pagesRendered) || 0;
  const report = critique?.report;
  const defects = Array.isArray(report?.defects) ? report.defects : [];
  const available = !critique?.skipped && ['pass', 'needs_work'].includes(report?.overall)
    && Array.isArray(report.defects) && Number.isInteger(pagesRendered) && pagesRendered > 0;
  const needsWork = available && (report.overall !== 'pass' || defects.length > 0);
  const status = !available ? 'not_checked' : needsWork ? 'needs_work'
    : totalPages > 0 && pagesRendered === totalPages ? 'passed' : 'partial';
  return {
    ...validation,
    passed: validation.passed && !needsWork,
    checks: { ...validation.checks, ...(needsWork ? { visualReview: false } : {}) },
    details: {
      ...validation.details,
      visualCritique: {
        status, pagesRendered: available ? pagesRendered : 0, totalPages,
        defects: available ? defects : [],
        ...(available ? { summary: String(report.summary || '') } : {}),
      },
    },
  };
}

module.exports = { applyPptxVisualReview };
