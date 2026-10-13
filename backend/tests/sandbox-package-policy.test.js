'use strict';

// Which Python packages the document agent may install into its own sandbox:
// a reviewed allowlist, strict requirement parsing (names, never locations),
// the import-name → distribution map and the operator env knobs.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../src/services/agent-runner/sandbox-packages/policy');

test('requirements are names, never locations: URLs, paths, VCS, options and markers are rejected', () => {
  assert.deepEqual(policy.parseRequirement('Seaborn[stats] >= 0.13, <1'), {
    raw: 'Seaborn[stats] >= 0.13, <1', name: 'seaborn', display: 'Seaborn', extras: '[stats]', specifier: '>=0.13,<1', spec: 'seaborn[stats]>=0.13,<1',
  });
  assert.equal(policy.parseRequirement('opencv-python-headless==4.12.0.88').spec, 'opencv-python-headless==4.12.0.88');
  assert.equal(policy.parseRequirement('Python_Docx').name, 'python-docx');
  for (const bad of [
    'git+https://github.com/x/y', 'https://evil/x.whl', './wheel.whl', '/abs/path', '-r requirements.txt', '--index-url x',
    'pkg; python_version<"3"', 'pkg @ https://x', 'a|b', 'a&b', 'a>/tmp/x', '$(id)', '`id`', 'a b', '', null, 'x'.repeat(101),
    // archive-looking specs are LOCAL files to pip (an sdist runs setup.py)
    'numpy==1.0.tar.gz', 'numpy==1.0.zip', 'evil-1.0-py3-none-any.whl', 'pkg.tgz', 'pkg==2.tar.bz2',
  ]) assert.equal(policy.parseRequirement(bad), null, String(bad));
  assert.equal(policy.normalizePackageName('Scikit_Learn.Extra'), 'scikit-learn-extra');
});

test('import names map to distributions, including packages that are NOT approved (so the gap names the right thing)', () => {
  assert.equal(policy.packageForModule('cv2'), 'opencv-python-headless');
  assert.equal(policy.packageForModule('PIL.Image'), 'pillow');
  assert.equal(policy.packageForModule('sklearn.linear_model'), 'scikit-learn');
  assert.equal(policy.packageForModule('yaml'), 'pyyaml');
  assert.equal(policy.packageForModule('bs4'), 'beautifulsoup4');
  assert.equal(policy.packageForModule('fitz'), 'pymupdf');
  assert.equal(policy.packageForModule('lazy_loader'), 'lazy-loader');
  assert.equal(policy.packageForModule('dotenv'), 'python-dotenv');
  assert.equal(policy.packageForModule('sqlalchemy'), 'sqlalchemy');
  assert.equal(policy.packageForModule(''), '');
  // Namespace roots: the second component names the distribution.
  assert.equal(policy.packageForModule('google.protobuf'), 'protobuf');
  assert.equal(policy.packageForModule('google.protobuf.json_format'), 'protobuf');
  assert.equal(policy.packageForModule('google.genai'), 'google-genai');
  assert.equal(policy.packageForModule('azure.storage'), 'azure-storage');
  assert.equal(policy.packageForModule('google'), 'google-api-python-client');
  assert.equal(policy.isNamespaceRoot('google.protobuf'), true);
  assert.equal(policy.isNamespaceRoot('pptx.util'), false);
});

test('the policy reads the env at call time: default on (off under test), extend, deny, index, network, limits', () => {
  const off = policy.resolvePolicy({ NODE_ENV: 'test' });
  assert.equal(off.enabled, false, 'tests never install by default');
  assert.equal(policy.resolvePolicy({ NODE_ENV: 'test', SIRAGPT_SANDBOX_PIP: '1' }).enabled, true);
  assert.equal(policy.resolvePolicy({ NODE_ENV: 'production' }).enabled, true);
  assert.equal(policy.resolvePolicy({ NODE_ENV: 'production', SIRAGPT_SANDBOX_PIP: '0' }).enabled, false);
  const custom = policy.resolvePolicy({
    SIRAGPT_SANDBOX_PIP_EXTRA_ALLOW: 'My_Pkg, Other.Thing',
    SIRAGPT_SANDBOX_PIP_DENY: 'requests',
    SIRAGPT_SANDBOX_PIP_INDEX_URL: 'https://devpi.local/root/pypi/+simple/',
    SIRAGPT_SANDBOX_PIP_NETWORK: 'iliagpt-app',
    SIRAGPT_SANDBOX_PIP_TIMEOUT_MS: '5000',
    SIRAGPT_SANDBOX_PIP_MAX_PER_TURN: '99',
    SIRAGPT_SANDBOX_PIP_MAX_PACKAGES: '2',
    SIRAGPT_SANDBOX_PIP_MAX_BYTES: '1',
    SIRAGPT_SANDBOX_PIP_TMP_SIZE: '2g',
  });
  assert.equal(custom.allow.has('my-pkg'), true);
  assert.equal(custom.allow.has('other-thing'), true);
  assert.equal(custom.allow.has('requests'), false, 'deny removes a default entry');
  assert.equal(custom.allow.has('numpy'), true);
  assert.equal(custom.indexUrl, 'https://devpi.local/root/pypi/+simple/');
  assert.equal(custom.network, 'iliagpt-app');
  assert.equal(policy.resolvePolicy({}).network, null, 'default: the driver decides (bridge locally, the sandbox host remotely)');
  assert.equal(policy.resolvePolicy({ SIRAGPT_SANDBOX_PIP_NETWORK: 'host' }).network, null, 'never the host namespace');
  assert.equal(custom.timeoutMs, 30_000, 'clamped to the minimum');
  assert.equal(custom.maxPerTurn, 10, 'clamped to the maximum');
  assert.equal(custom.maxPackages, 2);
  assert.equal(custom.maxBytes, 10 * 1024 * 1024, 'clamped to the minimum');
  assert.equal(custom.tmpSize, '2g');
  // Unsafe values fall back instead of reaching docker / pip.
  const unsafe = policy.resolvePolicy({ SIRAGPT_SANDBOX_PIP_INDEX_URL: 'ftp://x; rm -rf /', SIRAGPT_SANDBOX_PIP_NETWORK: 'bad net', SIRAGPT_SANDBOX_PIP_TMP_SIZE: '1g; echo' });
  assert.equal(unsafe.indexUrl, null);
  assert.equal(unsafe.network, null);
  assert.equal(unsafe.tmpSize, '1g');
});

test('the default allowlist covers the document / data stack with its transitive dependencies and nothing executable-heavy', () => {
  const allow = policy.resolvePolicy({ NODE_ENV: 'production' }).allow;
  for (const name of [
    'numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn', 'plotly', 'scikit-learn', 'statsmodels', 'openpyxl', 'xlsxwriter',
    'python-docx', 'python-pptx', 'docxtpl', 'pypdf', 'pdfplumber', 'pymupdf', 'reportlab', 'fpdf2', 'pdf2image', 'pytesseract',
    'beautifulsoup4', 'lxml', 'pyyaml', 'opencv-python-headless', 'scikit-image', 'qrcode', 'pydantic', 'jsonschema',
    // transitive deps the installer would otherwise refuse
    'python-dateutil', 'pytz', 'tzdata', 'six', 'contourpy', 'cycler', 'fonttools', 'kiwisolver', 'pyparsing', 'pillow',
    'joblib', 'threadpoolctl', 'patsy', 'tenacity', 'narwhals', 'soupsieve', 'et-xmlfile', 'pdfminer-six', 'pypdfium2',
    'tifffile', 'lazy-loader', 'networkx', 'imageio', 'pydantic-core', 'typing-extensions', 'annotated-types', 'referencing', 'rpds-py',
  ]) assert.equal(allow.has(name), true, name);
  for (const name of ['torch', 'tensorflow', 'transformers', 'sqlalchemy', 'psycopg2-binary', 'paramiko', 'fabric', 'docker', 'pyinstaller', 'cryptography']) {
    assert.equal(allow.has(name), false, `${name} must not be installable by default`);
  }
  for (const name of allow) assert.equal(name, policy.normalizePackageName(name), `allowlist entries are normalised: ${name}`);
});

test('validateRequest refuses the whole call on any invalid or unapproved entry and dedupes by name', () => {
  const pol = policy.resolvePolicy({ NODE_ENV: 'production', SIRAGPT_SANDBOX_PIP_MAX_PACKAGES: '3' });
  const ok = policy.validateRequest(['NumPy', 'numpy==2.1', 'seaborn'], pol);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.requirements.map((r) => r.spec), ['numpy', 'seaborn']);
  const mixed = policy.validateRequest(['numpy', 'git+https://x', 'torch'], pol);
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.rejected, [{ raw: 'git+https://x', reason: 'invalid_spec' }, { raw: 'torch', name: 'torch', reason: 'not_allowed' }]);
  assert.deepEqual(mixed.requirements.map((r) => r.name), ['numpy'], 'the approved part is still reported');
  const many = policy.validateRequest(['numpy', 'pandas', 'scipy', 'seaborn'], pol);
  assert.equal(many.ok, false);
  assert.equal(many.rejected.at(-1).reason, 'too_many');
  assert.equal(many.rejected.at(-1).limit, 3);
  assert.equal(policy.validateRequest([], pol).ok, false);
  assert.equal(policy.validateRequest('seaborn', pol).ok, true, 'a single string is accepted');
  assert.equal(policy.isAllowed('Sci_Kit-Learn', pol), false);
  assert.equal(policy.isAllowed('Scikit_Learn', pol), true);
  const json = JSON.parse(policy.allowlistJson(pol));
  assert.ok(Array.isArray(json) && json.includes('numpy') && json.every((n) => /^[a-z0-9][a-z0-9-]*$/.test(n)));
});
