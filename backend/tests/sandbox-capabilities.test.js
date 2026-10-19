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

// Which apt (or pip/npm) package provides each advertised command-line tool.
const CLI_PACKAGE = {
  soffice: 'libreoffice',
  pandoc: 'pandoc',
  pdflatex: 'texlive-latex-base',
  xelatex: 'texlive-xetex',
  latexmk: 'latexmk',
  bibtex: 'texlive-latex-base',
  dot: 'graphviz',
  'rsvg-convert': 'librsvg2-bin',
  convert: 'imagemagick',
  potrace: 'potrace',
  qrencode: 'qrencode',
  exiftool: 'libimage-exiftool-perl',
  gs: 'ghostscript',
  qpdf: 'qpdf',
  mutool: 'mupdf-tools',
  pdftoppm: 'poppler-utils',
  pdftotext: 'poppler-utils',
  pdfinfo: 'poppler-utils',
  tesseract: 'tesseract-ocr',
  ocrmypdf: 'pip:ocrmypdf',
  img2pdf: 'pip:img2pdf',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffmpeg',
  sox: 'sox',
  mediainfo: 'mediainfo',
  'espeak-ng': 'espeak-ng',
  sqlite3: 'sqlite3',
  csvlook: 'pip:csvkit',
  jq: 'jq',
  yq: 'pip:yq',
  rg: 'ripgrep',
  tree: 'tree',
  bc: 'bc',
  file: 'file',
  gpg: 'gnupg',
  zip: 'zip',
  '7z': 'p7zip-full',
  ruff: 'pip:ruff',
  jupyter: 'pip:nbconvert',
  node: 'nodejs',
};
const pipNames = new Set(catalog.python.map((entry) => environment.distributionName(entry.pip).toLowerCase()));

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
  for (const needed of [
    'ezdxf', 'matplotlib', 'reportlab', 'weasyprint', 'docx', 'pptx', 'openpyxl', 'pandas', 'trimesh', 'ebooklib', 'scipy',
    // the professional fields the workstation now covers
    'geopandas', 'rasterio', 'sklearn', 'lightgbm', 'xgboost', 'ortools', 'pulp', 'cvxpy', 'QuantLib', 'rdkit', 'Bio', 'astropy',
    'spacy', 'nltk', 'cv2', 'skimage', 'librosa', 'music21', 'cryptography', 'pyhanko', 'nbformat', 'nbclient', 'duckdb', 'polars', 'pyarrow',
    'pingouin', 'lifelines', 'statsmodels', 'pylatex', 'phonenumbers', 'stdnum', 'faker',
  ]) {
    assert.ok(imports.has(needed), `${needed} missing from the catalog`);
  }
  assert.ok(catalog.python.length >= 220, `catalog shrank to ${catalog.python.length} libraries`);
  const areas = new Set(catalog.python.map((entry) => entry.area));
  for (const area of ['office', 'pdf', 'charts', 'cad', '3d', 'geo', 'data', 'science', 'ml', 'optimization', 'finance', 'image', 'text', 'nlp', 'media', 'security', 'dates', 'validation', 'dev', 'files']) {
    assert.ok(areas.has(area), `no library in area ${area}`);
  }
  const bins = catalog.cli.map((entry) => entry.bin);
  for (const needed of ['soffice', 'pandoc', 'pdflatex', 'xelatex', 'latexmk', 'dot', 'convert', 'ffmpeg', 'gs', 'espeak-ng', 'sox', 'exiftool', 'jupyter', 'ruff']) assert.ok(bins.includes(needed), `${needed} missing`);
  assert.deepEqual(catalog.node, ['docx', 'exceljs', 'pptxgenjs', 'pdf-lib', 'jszip', 'markdown-it']);
  // Source-only installs are the exception, listed explicitly, and every one is a catalog entry.
  for (const name of catalog.python_sdist_ok) assert.ok(pipNames.has(name.toLowerCase()), `python_sdist_ok names ${name}, not a catalog entry`);
  assert.ok(catalog.python_sdist_ok.length <= 10, 'too many source-only installs');
  for (const [name, reason] of Object.entries(catalog.python_sdist_ok_deps)) {
    assert.ok(!pipNames.has(name.toLowerCase()), `${name} is a catalog entry; list it in python_sdist_ok`);
    assert.match(reason, /dependency of \w/, `python_sdist_ok_deps.${name} must say which catalog entry needs it`);
  }
  assert.deepEqual(catalog.python_data.spacy_models, ['es_core_news_sm', 'en_core_web_sm']);
  assert.ok(catalog.python_data.nltk.includes('punkt_tab') && catalog.python_data.nltk.includes('stopwords'));
  assert.ok(catalog.recipes.some((recipe) => /dxf/.test(recipe.ext) && /ezdxf/.test(recipe.how)));
  assert.ok(catalog.recipes.some((recipe) => /ipynb/.test(recipe.ext)));
  assert.ok(catalog.recipes.some((recipe) => /pdflatex/.test(recipe.how)));
});

test('the Dockerfile installs from the catalog and refuses an image that breaks it', () => {
  const dockerfile = read(RUNNER, 'Dockerfile');
  assert.match(dockerfile, /COPY capabilities\.json verify_env\.py build_manifests\.py \/opt\/sira\//);
  assert.match(dockerfile, /COPY tests \/opt\/sira\/tests/);
  // Wheels only; the source-only exceptions come from the catalog, never from a hand-written list.
  assert.match(dockerfile, /pip3 install --no-cache-dir --only-binary=:all: \\\n\s+--no-binary="\$\(cat \/tmp\/sira-build\/sdist-ok\.txt\)" \\\n\s+-r \/tmp\/sira-build\/requirements\.txt/);
  assert.match(dockerfile, /pip3 install --no-cache-dir -r \/tmp\/sira-build\/spacy-models\.txt/);
  assert.match(dockerfile, /nltk\.downloader -q -d \/usr\/share\/nltk_data \$\(cat \/tmp\/sira-build\/nltk-data\.txt\)/);
  assert.match(dockerfile, /ipykernel install --name python3 --prefix \/usr\/local/);
  assert.match(dockerfile, /npm install -g \$\(cat \/tmp\/node-modules\.txt\)/, 'node modules come from the catalog');
  assert.match(dockerfile, /NODE_PATH=\/usr\/local\/lib\/node_modules/, 'global Node modules must resolve from scripts');
  assert.match(dockerfile, /NLTK_DATA=\/usr\/share\/nltk_data/);
  assert.match(dockerfile, /policy\.xml/, 'ImageMagick must be allowed to read PDFs');
  // Both checks run as the unprivileged runtime user, after USER sandbox.
  const userAt = dockerfile.indexOf('USER sandbox');
  assert.ok(userAt > 0);
  assert.ok(dockerfile.indexOf('python3 /opt/sira/verify_env.py') > userAt);
  assert.ok(dockerfile.indexOf('python3 -m pytest -q -p no:cacheprovider') > userAt);
  assert.match(dockerfile, /\/opt\/sira\/tests\s*\\?\n/, 'the whole suite runs in the build');
  for (const entry of catalog.cli) {
    const pkg = CLI_PACKAGE[entry.bin];
    assert.ok(pkg, `no package mapped for ${entry.bin}`);
    if (pkg.startsWith('pip:')) {
      assert.ok(pipNames.has(pkg.slice(4).toLowerCase()), `${pkg} (for ${entry.bin}) not in the python catalog`);
    } else {
      assert.match(dockerfile, new RegExp(`\\s${pkg.replace(/[-]/g, '\\-')}\\s`), `${pkg} (for ${entry.bin}) not installed`);
    }
  }
  for (const lib of ['libpango-1.0-0', 'libpangoft2-1.0-0', 'libcairo2', 'libmagic1', 'libgomp1', 'texlive-lang-spanish', 'tesseract-ocr-spa', 'fonts-noto-color-emoji']) {
    assert.match(dockerfile, new RegExp(lib.replace(/[.-]/g, '\\$&')), `${lib} not installed`);
  }
  assert.doesNotMatch(dockerfile, /smoke_formats/, 'the smoke script was replaced by the pytest suite');
});

test('build_manifests.py derives every install list from the catalog', () => {
  const source = read(RUNNER, 'build_manifests.py');
  for (const marker of ['requirements.txt', 'sdist-ok.txt', 'nltk-data.txt', 'spacy-models.txt', 'spacy-models/releases/download', 'catalog["python"]', 'python_sdist_ok', 'python_sdist_ok_deps', 'python_data']) {
    assert.ok(source.includes(marker), `build_manifests.py lost ${marker}`);
  }
});

test('verify_env.py checks every python import, binary and node module of the catalog', () => {
  const source = read(RUNNER, 'verify_env.py');
  assert.match(source, /importlib\.import_module\(entry\["import"\]\)/);
  assert.match(source, /shutil\.which\(entry\["bin"\]\)/);
  assert.match(source, /require\.resolve/);
  assert.match(source, /nltk\.data\.find\(resource\)/);
  assert.match(source, /spacy\.load\(model\)/);
  assert.match(source, /SIRA_ENV_OK/);
  // Every NLTK package the catalog downloads has a resource path verify_env.py can check.
  for (const pkg of catalog.python_data.nltk) assert.ok(source.includes(`"${pkg}"`), `verify_env.py cannot verify nltk ${pkg}`);
});

test('the pytest suite proves every catalog entry, one functional test per library', () => {
  const testsDir = path.join(RUNNER, 'tests');
  const files = fs.readdirSync(testsDir).filter((name) => name.endsWith('.py'));
  assert.ok(files.includes('conftest.py') && files.includes('test_zz_catalog_coverage.py'));
  const modules = files.filter((name) => /^test_/.test(name) && name !== 'test_zz_catalog_coverage.py');
  assert.ok(modules.length >= 12, `only ${modules.length} test modules`);
  // Collect every covers() name across the suite, the same way the coverage test does at run time.
  const covered = new Set();
  for (const name of files) {
    const source = read(testsDir, name);
    for (const match of source.matchAll(/pytest\.mark\.covers\(([^)]*)\)/g)) {
      for (const literal of match[1].matchAll(/["']([^"']+)["']/g)) covered.add(literal[1]);
    }
  }
  const known = new Set([...catalog.python.map((e) => e.import), ...catalog.cli.map((e) => e.bin), ...catalog.node]);
  const missing = [...known].filter((name) => !covered.has(name));
  assert.deepEqual(missing, [], 'catalog entries without a functional test');
  const unknown = [...covered].filter((name) => !known.has(name));
  assert.deepEqual(unknown, [], 'covers() names that are not catalog entries');
  const coverage = read(testsDir, 'test_zz_catalog_coverage.py');
  assert.match(coverage, /python libraries without a functional test/);
  assert.match(coverage, /command-line tools without a functional test/);
  assert.match(coverage, /node modules without a functional test/);
  const conftest = read(testsDir, 'conftest.py');
  assert.match(conftest, /SIRA_TESTS_OK/);
  assert.match(conftest, /SIRA_TESTS_SKIP_MISSING/, 'workstation runs skip missing dependencies; the image build never sets it');
  // Catalog libraries are imported inside test functions so collection works anywhere.
  const catalogImports = new Set(catalog.python.map((entry) => entry.import.split('.')[0]).filter((name) => name !== 'pytest'));
  for (const name of modules) {
    // Scripts the tests run in subprocesses live inside triple-quoted strings; only real module code counts.
    const source = read(testsDir, name).replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '');
    const top = source.split('\n').filter((line) => /^(import|from)\s/.test(line)).flatMap((line) => (
      line.startsWith('from ') ? [line.split(/\s+/)[1]] : line.replace(/^import\s+/, '').split(',').map((part) => part.trim().split(/\s+/)[0])
    )).map((mod) => mod.split('.')[0]);
    for (const mod of top) assert.ok(!catalogImports.has(mod), `${name} imports ${mod} at module level`);
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
  assert.match(prompt, /NLTK data already installed/);
  assert.match(prompt, /spaCy models already installed: es_core_news_sm, en_core_web_sm/);
  assert.match(prompt, /NO internet: never download/);
  assert.doesNotMatch(prompt, /run Python 3 \(python-pptx, python-docx, openpyxl, lxml, Pillow, zipfile\)/, 'stale six-library tool line');
});

test('execute_python / execute_bash describe the full environment', () => {
  const { BASE_TOOL_DEFINITIONS } = require('../src/services/agent-runner/tools');
  const byName = Object.fromEntries((BASE_TOOL_DEFINITIONS || []).map((def) => [def.function.name, def.function.description]));
  assert.ok(byName.execute_python, 'execute_python definition');
  for (const name of ['ezdxf', 'matplotlib', 'reportlab', 'weasyprint', 'trimesh', 'geopandas', 'scikit-learn', 'spacy', 'QuantLib', 'rdkit']) assert.ok(byName.execute_python.includes(name), name);
  assert.match(byName.execute_python, /any file type/);
  for (const bin of ['soffice', 'pandoc', 'pdflatex', 'dot', 'ffmpeg', 'espeak-ng']) assert.ok(byName.execute_bash.includes(bin), bin);
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
    'compila este latex a pdf',
    'hazme un notebook de jupyter con el análisis',
    'genera un geojson con los distritos',
    'firma digitalmente el pdf',
    'hazme un gif animado de la gráfica',
    'dame la partitura en musicxml',
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
    '¿qué es latex?',
    'resume este notebook',
    'el tex está mal',
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
    ipynb: 'application/x-ipynb+json',
    gpkg: 'application/geopackage+sqlite3',
    nc: 'application/netcdf',
    h5: 'application/x-hdf5',
    avro: 'application/avro',
    feather: 'application/vnd.apache.arrow.file',
    musicxml: 'application/vnd.recordare.musicxml+xml',
    gltf: 'model/gltf+json',
    bib: 'application/x-bibtex',
    ttf: 'font/ttf',
  };
  for (const [ext, mime] of Object.entries(expected)) assert.equal(EXTENSION_TO_MIME[ext], mime, ext);
});

test('CI and production rebuild the image when anything in its directory changes', () => {
  const build = read(REPO, '.github/workflows/docker-build.yml');
  assert.equal((build.match(/- services\/sandbox\/runner\/\*\*/g) || []).length, 2, 'push and pull_request path filters');
  assert.match(build, /\/opt\/sira\/verify_env\.py/);
  assert.match(build, /-m pytest -q -p no:cacheprovider --basetemp=\/tmp\/sira-tests --durations=25 \/opt\/sira\/tests/);
  assert.match(build, /--network none --cap-drop ALL/);
  assert.match(build, /--read-only --tmpfs \/tmp --tmpfs \/workspace:uid=10001,gid=10001/);
  assert.doesNotMatch(build, /smoke_formats/);
  const publish = read(REPO, '.github/workflows/publish-production.yml');
  assert.match(publish, /diff --name-only "\$LIVE" "\$TARGET" -- services\/sandbox\/runner\/\)/);
  assert.match(publish, /"\$candidate" \/opt\/sira\/verify_env\.py/);
  assert.match(publish, /\/opt\/sira\/tests\/test_zz_catalog_coverage\.py/);
  assert.match(read(REPO, 'backend/scripts/verify-agent-sandbox-runtime.cjs'), /python3 \/opt\/sira\/verify_env\.py/);
});
