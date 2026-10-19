'use strict';

/**
 * What the document sandbox image can do, told to the model.
 *
 * sandbox-capabilities.json is a byte-identical copy of
 * services/sandbox/runner/capabilities.json, the file the image installs
 * from and verifies at build time (a test keeps the copies equal). The prompt
 * therefore lists exactly what the image ships — never a library it lacks.
 */

const CAPABILITIES = require('./sandbox-capabilities.json');

const AREA_LABELS = {
  office: 'Office',
  pdf: 'PDF',
  charts: 'Charts/diagrams',
  cad: 'CAD/plans',
  '3d': '3D',
  geo: 'Maps/GIS',
  data: 'Data/databases',
  science: 'Science/statistics',
  ml: 'Machine learning',
  optimization: 'Optimization',
  finance: 'Finance',
  image: 'Images/vision',
  text: 'Text/web/e-books/LaTeX',
  nlp: 'NLP',
  media: 'Audio/video/music',
  security: 'Cryptography/signatures',
  dates: 'Dates/calendars/locales',
  validation: 'Validation/fake data',
  dev: 'Dev/notebooks/web apps',
  files: 'Files/archives',
};

function distributionName(spec) {
  return String(spec).split(/[<>=!~;\s[]/)[0];
}

/** "Office: python-docx (import docx), openpyxl, …" — one line per area. */
function pythonLibraryLines(capabilities = CAPABILITIES) {
  const byArea = new Map();
  for (const entry of capabilities.python) {
    const name = distributionName(entry.pip);
    const label = name === entry.import || name.replace(/-/g, '_') === entry.import
      ? name
      : `${name} (import ${entry.import})`;
    if (!byArea.has(entry.area)) byArea.set(entry.area, []);
    byArea.get(entry.area).push(label);
  }
  return [...byArea].map(([area, names]) => `  ${AREA_LABELS[area] || area}: ${names.join(', ')}`);
}

/** Bundled data sets (NLTK corpora, spaCy models), so the model never tries to download them. */
function dataLines(capabilities = CAPABILITIES) {
  const data = capabilities.python_data || {};
  const lines = [];
  if (Array.isArray(data.nltk) && data.nltk.length) lines.push(`- NLTK data already installed (NLTK_DATA): ${data.nltk.join(', ')}.`);
  if (Array.isArray(data.spacy_models) && data.spacy_models.length) lines.push(`- spaCy models already installed: ${data.spacy_models.join(', ')} (spacy.load('<name>')).`);
  return lines;
}

function cliLine(capabilities = CAPABILITIES) {
  return capabilities.cli.map((entry) => entry.bin).join(', ');
}

/** Prompt block: the environment, what it can produce and how. */
function buildSandboxEnvironmentBlock(capabilities = CAPABILITIES) {
  return [
    'SANDBOX ENVIRONMENT (a complete offline workstation — you can generate ANY file the user asks for)',
    '- Python 3 with these libraries already installed (never pip-install them):',
    ...pythonLibraryLines(capabilities),
    `- Command-line tools: ${cliLine(capabilities)}. LibreOffice converts between office formats and PDF: soffice --headless --convert-to <ext> --outdir outputs <file>.`,
    `- Node.js modules: ${capabilities.node.join(', ')}.`,
    ...dataLines(capabilities),
    '- If the user asks for a format this list covers (plans, CAD, charts, PDFs, LaTeX, e-books, 3D models, maps/GIS, audio/video/speech, QR codes, calendars, databases, notebooks, statistics/ML reports, optimization models, signed/encrypted files…), BUILD the real file. Never answer that you cannot produce a format listed here, and never substitute a description or a different format for the file requested. The sandbox has NO internet: never download data, models or packages; everything above is already local.',
    '- Recipes:',
    ...capabilities.recipes.map((recipe) => `  ${recipe.ext}: ${recipe.how}`),
    '- Deliverables go to outputs/ (one file per requested deliverable, with a clear name and the right extension); scratch files and previews go to previews/ or tmp/.',
    '- Verify every deliverable before announcing it: reopen it with its own library (or ffprobe/pdfinfo), and for anything visual render a PNG preview (render_preview, matplotlib, ezdxf drawing, pdftoppm) and look at it.',
  ].join('\n');
}

function executePythonDescription(capabilities = CAPABILITIES) {
  const names = capabilities.python.map((entry) => distributionName(entry.pip));
  return 'Run Python 3 inside the isolated /workspace sandbox. Preinstalled: '
    + `${names.join(', ')}. `
    + 'Uploaded files are in /workspace/uploads; write deliverables to /workspace/outputs (any file type). '
    + '120s timeout, no network. If an import fails and the recovery note names an APPROVED distribution, install it with install_sandbox_package and retry.';
}

function executeBashDescription(capabilities = CAPABILITIES) {
  return `Run a bash command inside /workspace. Tools: ${cliLine(capabilities)}, grep/sed/awk. `
    + 'soffice --headless --convert-to <ext> --outdir outputs <file> converts office formats and PDF. '
    + '120s timeout, no network. Prefer execute_python for document edits.';
}

module.exports = {
  CAPABILITIES,
  buildSandboxEnvironmentBlock,
  executePythonDescription,
  executeBashDescription,
  pythonLibraryLines,
  dataLines,
  distributionName,
};
