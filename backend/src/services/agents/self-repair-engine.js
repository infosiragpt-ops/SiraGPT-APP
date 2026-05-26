/**
 * self-repair-engine — phase 9 of the DocumentRenderingEngine.
 *
 * Closes the loop. The validation fabric (phases 2/4/5/6/7) tells us
 * *what* is wrong with a generated artifact; this engine drives the
 * retry: it asks the doc-generator to regenerate with the failure
 * reason injected into the prompt, then re-validates. Bounded retries
 * (default 1) so we don't spin on hopeless cases.
 *
 * The engine is intentionally agnostic about *how* validation and
 * regeneration happen — the caller wires those in via two callbacks:
 *
 *   validate(artifact)   -> { passed, failures: [{validator, reason}] }
 *   regenerate({failures, repairInstruction, attempt}) -> artifact
 *
 * For convenience this module also ships `runStandardValidators(...)`,
 * which dispatches mime + format-specific + (optional) preview checks
 * using the validators built in earlier phases. Callers that want
 * something more bespoke can wire their own `validate`.
 *
 * Public API:
 *   selfRepair({artifact, validate, regenerate, maxAttempts, logger})
 *     -> Promise<{artifact, repaired, history, finalReport, attempts}>
 *   runStandardValidators({buffer, format, declaredMime, prompt, ...})
 *     -> Promise<{passed, failures, checks}>
 *   buildRepairInstruction(failures) -> string|null
 *   REPAIR_HINTS  — Spanish copy keyed by validator reason code
 *   DEFAULT_MAX_ATTEMPTS = 1
 */

const { validateMathRender } = require('./math-render-validator');
const { validatePdfRender } = require('./pdf-render-validator');
const { validatePptxPackage } = require('./pptx-package-validator');
const { validateXlsxWorkbook } = require('./xlsx-workbook-validator');
const { validateMimeType } = require('./mime-type-validator');
const { validatePreviewScreenshot } = require('./preview-screenshot-validator');

const DEFAULT_MAX_ATTEMPTS = 1;

// Spanish-language repair hints keyed by the `reason` strings the
// validators emit. siraGPT's user prompts are 95%+ Spanish; the LLM
// follows the language of whatever instruction we inject.
const REPAIR_HINTS = Object.freeze({
  no_equations_rendered:
    'El documento debe incluir las ecuaciones renderizadas: usa $...$ para inline y $$...$$ para bloque. No las describas solo en prosa.',
  no_text_content:
    'El PDF debe contener texto extraíble — no devuelvas un documento vacío ni únicamente imágenes.',
  no_slides_rendered:
    'La presentación PPTX debe tener al menos una slide con contenido visible.',
  slide_manifest_mismatch:
    'La presentación PPTX está mal empaquetada — todas las slides referenciadas en el manifiesto deben existir en el zip.',
  missing_presentation_xml:
    'La presentación PPTX no tiene presentation.xml — regenera asegurando un paquete OOXML completo.',
  no_sheets:
    'El libro XLSX debe tener al menos una hoja.',
  no_cell_content:
    'El libro XLSX debe contener celdas pobladas, no una plantilla vacía.',
  sheet_manifest_mismatch:
    'El libro XLSX está mal empaquetado — todas las hojas referenciadas en el manifiesto deben existir en el zip.',
  mime_mismatch:
    'Los bytes del documento no coinciden con el formato declarado: regenera asegurando que el mime real corresponda al formato pedido.',
  declared_extension_unknown:
    'La extensión del archivo no es reconocida — usa una de las extensiones soportadas (docx/xlsx/pptx/pdf/csv/md/html/svg).',
  magic_bytes_missing:
    'Los bytes del archivo no tienen una firma reconocible — regenera asegurando un paquete bien formado.',
  blank_render:
    'La vista previa salió en blanco — asegúrate de que el contenido se renderice visualmente y no quede recortado fuera del viewport.',
});

/**
 * Build the repair instruction the regenerate callback gets. Returns
 * `null` if nothing is wrong (so callers can short-circuit).
 */
function buildRepairInstruction(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return null;
  const lines = failures.map((f) => {
    const hint = REPAIR_HINTS[f.reason] || `Falló la validación "${f.validator}" con motivo: ${f.reason}`;
    return `- (${f.validator}) ${hint}`;
  });
  return [
    'La generación anterior falló estas validaciones. Corrígelas antes de devolver el documento:',
    ...lines,
  ].join('\n');
}

/**
 * Convenience dispatcher that runs all applicable validators for an
 * artifact and returns a unified `{passed, failures, checks}` report.
 *
 * - Always runs mime-type validation when `declaredMime` is supplied.
 * - Runs the format-specific validator (math/pdf/pptx/xlsx) by `format`.
 * - Runs preview-screenshot validation when `screenshotInput` is supplied
 *   (its result feeds `failures` only if Chromium is present —
 *   `validator_unavailable` is treated as a non-failure to keep the
 *   gate non-blocking on dev/CI without Playwright).
 */
async function runStandardValidators({
  buffer,
  format,
  declaredMime,
  declaredExtension,
  prompt,
  sourceText,
  screenshotInput,
} = {}) {
  const checks = [];
  const failures = [];

  function record(validator, result) {
    checks.push({ validator, ...result });
    if (!result.ok && result.reason !== 'validator_unavailable') {
      failures.push({ validator, reason: result.reason });
    }
  }

  if (buffer && declaredMime) {
    record('mime', await validateMimeType({ buffer, declaredMime, declaredExtension }));
  }

  if (buffer) {
    if (format === 'docx') {
      record('math', await validateMathRender({ buffer, prompt, sourceText }));
    } else if (format === 'pdf') {
      record('pdf', await validatePdfRender({ buffer, prompt, sourceText }));
    } else if (format === 'pptx') {
      record('pptx', await validatePptxPackage({ buffer, prompt, sourceText }));
    } else if (format === 'xlsx') {
      record('xlsx', await validateXlsxWorkbook({ buffer, prompt, sourceText }));
    }
  }

  if (screenshotInput) {
    record('preview', await validatePreviewScreenshot(screenshotInput));
  }

  return { passed: failures.length === 0, failures, checks };
}

/**
 * Drive the validate -> regenerate -> validate loop.
 *
 * @param {object} opts
 * @param {*} opts.artifact      Initial artifact (any shape; only the
 *                               caller's `validate`/`regenerate` need to
 *                               understand it).
 * @param {function} opts.validate    async (artifact) => {passed, failures}
 * @param {function} opts.regenerate  async ({failures, repairInstruction,
 *                                            attempt}) => artifact
 * @param {number} [opts.maxAttempts=1]  Repair attempts (not counting
 *                                       the initial validation).
 * @param {function} [opts.logger]   Optional sink for repair telemetry
 *                                   events: `{event, attempt, failures,
 *                                   repairInstruction}`.
 * @returns {Promise<{artifact, repaired, history, finalReport, attempts}>}
 */
async function selfRepair({
  artifact,
  validate,
  regenerate,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  logger = () => {},
} = {}) {
  if (artifact === undefined || artifact === null) {
    throw new Error('selfRepair: artifact is required');
  }
  if (typeof validate !== 'function') {
    throw new Error('selfRepair: validate function is required');
  }
  if (typeof regenerate !== 'function') {
    throw new Error('selfRepair: regenerate function is required');
  }

  let current = artifact;
  let report = await validate(current);
  const history = [
    { attempt: 0, passed: !!report.passed, failures: report.failures || [] },
  ];
  let attempt = 0;

  while (!report.passed && attempt < maxAttempts) {
    attempt += 1;
    const repairInstruction = buildRepairInstruction(report.failures);
    logger({
      event: 'repair_attempt',
      attempt,
      failures: report.failures,
      repairInstruction,
    });

    let next;
    try {
      next = await regenerate({
        failures: report.failures,
        repairInstruction,
        attempt,
      });
    } catch (err) {
      history.push({
        attempt,
        passed: false,
        failures: report.failures || [],
        regenerateError: err && err.message ? err.message : String(err),
      });
      break;
    }

    if (!next) {
      history.push({
        attempt,
        passed: false,
        failures: report.failures || [],
        regenerateError: 'regenerate returned no artifact',
      });
      break;
    }

    current = next;
    report = await validate(current);
    history.push({
      attempt,
      passed: !!report.passed,
      failures: report.failures || [],
    });
  }

  return {
    artifact: current,
    repaired: attempt > 0 && report.passed === true,
    history,
    finalReport: report,
    attempts: attempt,
  };
}

module.exports = {
  selfRepair,
  runStandardValidators,
  buildRepairInstruction,
  REPAIR_HINTS,
  DEFAULT_MAX_ATTEMPTS,
};
