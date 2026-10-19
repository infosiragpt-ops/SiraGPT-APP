'use strict';

/**
 * The document sandbox as a complete workstation: one catalog
 * (services/sandbox/runner/capabilities.json) drives what the image installs
 * and verifies, what the agent prompt advertises, which requests reach the
 * sandbox and how the files it makes are typed on download.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPO = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(REPO, 'services/sandbox/runner');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const catalog = JSON.parse(read(RUNNER, 'capabilities.json'));
const environment = require('../src/services/agent-runner/sandbox-environment');

// Which apt package provides each advertised command-line tool.
const CLI_PACKAGE = {
  soffice: 'libreoffice',
  pandoc: 'pandoc',
  dot: 'graphviz',
  'rsvg-convert': 'librsvg2-bin',
  gs: 'ghostscript',
  qpdf: 'qpdf',
  pdftoppm: 'poppler-utils',
  pdftotext: 'poppler-utils',
  tesseract: 'tesseract-ocr',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffmpeg',
  sqlite3: 'sqlite3',
  jq: 'jq',
  zip: 'zip',
  '7z': 'p7zip-full',
  node: 'nodejs',
};

test('the backend prompt reads a byte-identical copy of the image catalog', () => {
  assert.equal(
    read(REPO, 'backend/src/services/agent-runner/sandbox-capabilities.json'),
    read(RUNNER, 'capabilities.json'),
    'backend/src/services/agent-runner/sandbox-capabilities.json must mirror services/sandbox/runner/capabilities.json',
  );
});

test('the catalog is well formed and covers the professional formats', () => {
  const imports = new Set();
  for (const entry of catalog.python) {
    assert.ok(entry.pip && entry.import && entry.area && entry.use, JSON.stringify(entry));
    assert.ok(!imports.has(entry.import), `duplicate import ${entry.import}`);
    imports.add(entry.import);
    assert.match(entry.pip, /^[A-Za-z0-9._-]+(?:(?:==|>=|<=|~=|<|>)[0-9A-Za-z.*]+(?:,(?:==|>=|<=|~=|<|>)[0-9A-Za-z.*]+)*)?$/, `pip spec ${entry.pip}`);
  }
  for (const needed of ['ezdxf', 'matplotlib', 'reportlab', 'weasyprint', 'docx', 'pptx', 'openpyxl', 'pandas', 'trimesh', 'ebooklib', 'scipy']) {
    assert.ok(imports.has(needed), `${needed} missing from the catalog`);
  }
  const bins = catalog.cli.map((entry) => entry.bin);
  for (const needed of ['soffice', 'pandoc', 'dot', 'ffmpeg', 'gs']) assert.ok(bins.includes(needed), `${needed} missing`);
  assert.deepEqual(catalog.node, ['docx', 'exceljs', 'pptxgenjs']);
  assert.ok(catalog.recipes.some((recipe) => /dxf/.test(recipe.ext) && /ezdxf/.test(recipe.how)));
});

test('the Dockerfile installs from the catalog and refuses an image that breaks it', () => {
  const dockerfile = read(RUNNER, 'Dockerfile');
  assert.match(dockerfile, /COPY capabilities\.json verify_env\.py smoke_formats\.py \/opt\/sira\//);
  assert.match(dockerfile, /pip3 install --no-cache-dir --only-binary=:all: --no-binary=odfpy -r \/tmp\/requirements\.txt/);
  assert.match(dockerfile, /npm install -g docx exceljs pptxgenjs/);
  assert.match(dockerfile, /NODE_PATH=\/usr\/local\/lib\/node_modules/, 'global Node modules must resolve from scripts');
  // Both checks run as the unprivileged runtime user, after USER sandbox.
  const userAt = dockerfile.indexOf('USER sandbox');
  assert.ok(userAt > 0);
  assert.ok(dockerfile.indexOf('python3 /opt/sira/verify_env.py') > userAt);
  assert.ok(dockerfile.indexOf('python3 /opt/sira/smoke_formats.py') > userAt);
  for (const entry of catalog.cli) {
    const pkg = CLI_PACKAGE[entry.bin];
    assert.ok(pkg, `no apt package mapped for ${entry.bin}`);
    assert.match(dockerfile, new RegExp(`\\s${pkg.replace(/[-]/g, '\\-')}\\s`), `${pkg} (for ${entry.bin}) not installed`);
  }
  for (const lib of ['libpango-1.0-0', 'libpangoft2-1.0-0', 'libcairo2']) {
    assert.match(dockerfile, new RegExp(lib.replace(/[.-]/g, '\\$&')), `${lib} (WeasyPrint/CairoSVG) not installed`);
  }
});

test('verify_env.py checks every python import, binary and node module of the catalog', () => {
  const source = read(RUNNER, 'verify_env.py');
  assert.match(source, /importlib\.import_module\(entry\["import"\]\)/);
  assert.match(source, /shutil\.which\(entry\["bin"\]\)/);
  assert.match(source, /require\.resolve/);
  assert.match(source, /SIRA_ENV_OK/);
});

test('smoke_formats.py produces and reopens a real file for the headline formats', () => {
  const source = read(RUNNER, 'smoke_formats.py');
  for (const marker of ['plano.dxf', 'ezdxf.readfile', 'grafico.png', 'write_pdf', 'canvas.Canvas', 'pieza.stl', 'libro.epub', 'texto.odt', '--convert-to', 'pandoc', '"dot"', 'datos.parquet', 'nota.mid', 'SIRA_FORMATS_OK']) {
    assert.ok(source.includes(marker), `smoke_formats.py lost ${marker}`);
  }
});

test('the agent prompt advertises exactly the catalog and tells the model to build the real file', () => {
  const { buildAgentRunnerPrompt } = require('../src/services/agent-runner/prompt');
  const prompt = buildAgentRunnerPrompt({});
  assert.match(prompt, /SANDBOX ENVIRONMENT/);
  for (const entry of catalog.python) {
    const name = environment.distributionName(entry.pip);
    assert.ok(prompt.includes(name), `prompt does not list ${name}`);
  }
  for (const entry of catalog.cli) assert.ok(prompt.includes(entry.bin), `prompt does not list ${entry.bin}`);
  assert.match(prompt, /BUILD the real file/);
  assert.match(prompt, /never pip-install them/);
  assert.match(prompt, /ezdxf\.new\('R2018'/);
  assert.doesNotMatch(prompt, /run Python 3 \(python-pptx, python-docx, openpyxl, lxml, Pillow, zipfile\)/, 'stale six-library tool line');
});

test('execute_python / execute_bash describe the full environment', () => {
  const { BASE_TOOL_DEFINITIONS } = require('../src/services/agent-runner/tools');
  const byName = Object.fromEntries((BASE_TOOL_DEFINITIONS || []).map((def) => [def.function.name, def.function.description]));
  assert.ok(byName.execute_python, 'execute_python definition');
  for (const name of ['ezdxf', 'matplotlib', 'reportlab', 'weasyprint', 'trimesh']) assert.ok(byName.execute_python.includes(name), name);
  assert.match(byName.execute_python, /any file type/);
  for (const bin of ['soffice', 'pandoc', 'dot', 'ffmpeg']) assert.ok(byName.execute_bash.includes(bin), bin);
});

test('a request for a sandbox-only format reaches the sandbox agent', () => {
  const runner = require('../src/services/agent-runner');
  for (const text of [
    'hazme un plano en DXF de una casa de 8x6',
    'genera un STL de una pieza de 10x20x5 mm',
    'crea un epub con estos capítulos',
    'dame el archivo kml de la ruta',
    'créame un código QR con el enlace de mi tienda',
    'exporta la tabla a parquet',
    'dibújame en autocad la planta del local',
    'hazme un modelo 3d de una caja',
    'genera un calendario .ics con las fechas del curso',
    'hazme un archivo midi con la melodía',
  ]) {
    assert.equal(runner.isSandboxFileRequest(text), true, text);
    assert.equal(runner.shouldRunAgentRunner({ text }), true, text);
  }
  for (const text of [
    '¿qué es un archivo dxf?',
    'explícame cómo funciona AutoCAD',
    'el plano está mal',
    'hazme un gráfico de ventas',
    'dibuja un gato',
    'resume este epub',
    'mid-year report summary',
  ]) {
    assert.equal(runner.isSandboxFileRequest(text), false, text);
  }
  // Software that writes the format is a coding task, not a file to deliver.
  assert.equal(runner.shouldRunAgentRunner({ text: 'hazme una app en react que exporte a dxf' }), false);
});

test('files the sandbox makes download with their real media type', () => {
  const { EXTENSION_TO_MIME } = require('../src/services/agents/task-tools');
  const expected = {
    dxf: 'image/vnd.dxf',
    stl: 'model/stl',
    epub: 'application/epub+zip',
    odt: 'application/vnd.oasis.opendocument.text',
    kml: 'application/vnd.google-earth.kml+xml',
    gpx: 'application/gpx+xml',
    ics: 'text/calendar',
    mid: 'audio/midi',
    parquet: 'application/vnd.apache.parquet',
    rtf: 'application/rtf',
  };
  for (const [ext, mime] of Object.entries(expected)) assert.equal(EXTENSION_TO_MIME[ext], mime, ext);
});

test('CI and production rebuild the image when anything in its directory changes', () => {
  const build = read(REPO, '.github/workflows/docker-build.yml');
  assert.equal((build.match(/- services\/sandbox\/runner\/\*\*/g) || []).length, 2, 'push and pull_request path filters');
  assert.match(build, /\/opt\/sira\/verify_env\.py/);
  assert.match(build, /\/opt\/sira\/smoke_formats\.py/);
  assert.match(build, /--network none --cap-drop ALL/);
  const publish = read(REPO, '.github/workflows/publish-production.yml');
  assert.match(publish, /diff --name-only "\$LIVE" "\$TARGET" -- services\/sandbox\/runner\/\)/);
  assert.match(publish, /"\$candidate" \/opt\/sira\/verify_env\.py/);
  assert.match(read(REPO, 'backend/scripts/verify-agent-sandbox-runtime.cjs'), /python3 \/opt\/sira\/verify_env\.py/);
});
