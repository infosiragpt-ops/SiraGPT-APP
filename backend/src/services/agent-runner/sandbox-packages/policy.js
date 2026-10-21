'use strict';

/**
 * Sandbox Python package policy — WHICH PyPI packages the document agent may
 * install into its own sandbox, and HOW.
 *
 * The execution sandbox (doc-agent/sandbox.js) stays `--network none`. When a
 * script fails with `ModuleNotFoundError`, the agent may call
 * `install_sandbox_package`; the install runs in a SEPARATE, throw-away
 * installer container (same image, same limits, egress only for pip) and the
 * resulting wheels are streamed into the conversation workspace
 * (`/workspace/.sira-packages`, a user-site tree honoured through
 * PYTHONUSERBASE). The human decision moves from "approve every install" to
 * "approve the list": only packages on this allowlist (operator-extensible
 * through env) ever reach the sandbox; everything else becomes a
 * `capability_gap` for the administrator and an honest answer for the user.
 *
 * Pure module: no I/O, no env reads outside resolvePolicy().
 */

/** PEP 503 normalisation: case-insensitive, runs of `-_.` collapse to `-`. */
function normalizePackageName(name) {
  return String(name || '').trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Curated allowlist for document / data work. Names are PEP 503-normalised.
 * Transitive dependencies of the main entries are listed too: the installer
 * validates EVERY wheel pip resolves, so a missing dependency would otherwise
 * refuse the install of its parent.
 */
const DEFAULT_ALLOWLIST = Object.freeze([
  // ── numeric / data ──
  'numpy', 'pandas', 'scipy', 'python-dateutil', 'pytz', 'tzdata', 'six', 'packaging',
  'pyarrow', 'polars', 'openpyxl', 'et-xmlfile', 'xlsxwriter', 'xlrd', 'odfpy', 'pyreadstat',
  'tabulate', 'scikit-learn', 'joblib', 'threadpoolctl', 'statsmodels', 'patsy',
  'sortedcontainers', 'more-itertools', 'cachetools', 'sympy', 'mpmath', 'networkx',
  // ── plotting ──
  'matplotlib', 'contourpy', 'cycler', 'fonttools', 'kiwisolver', 'pyparsing', 'pillow',
  'seaborn', 'plotly', 'tenacity', 'narwhals', 'squarify', 'wordcloud', 'adjusttext',
  // ── documents ──
  'python-docx', 'python-pptx', 'docxtpl', 'docxcompose', 'docx2txt', 'docx2python', 'mammoth',
  'cobble', 'pypdf', 'pypdf2', 'pdfplumber', 'pdfminer-six', 'pypdfium2', 'pymupdf', 'pikepdf',
  'deprecated', 'wrapt', 'pdfrw', 'reportlab', 'fpdf2', 'pdf2image', 'pytesseract', 'img2pdf',
  'markdown', 'markdown2', 'mistune', 'beautifulsoup4', 'soupsieve', 'lxml', 'html5lib',
  'webencodings', 'jinja2', 'markupsafe', 'pyyaml', 'toml', 'tomli', 'xmltodict', 'defusedxml',
  'chardet', 'charset-normalizer', 'idna', 'certifi', 'urllib3', 'requests', 'olefile',
  // ── text ──
  'regex', 'unidecode', 'text-unidecode', 'python-slugify', 'emoji', 'ftfy', 'wcwidth',
  'num2words', 'docopt', 'babel', 'langdetect', 'pycountry', 'phonenumbers', 'email-validator',
  'dnspython', 'rapidfuzz', 'thefuzz', 'jellyfish', 'textdistance', 'levenshtein', 'dateparser',
  'tzlocal', 'arrow', 'types-python-dateutil', 'holidays',
  // ── images ──
  'opencv-python-headless', 'imageio', 'scikit-image', 'tifffile', 'lazy-loader', 'qrcode',
  'python-barcode', 'svgwrite',
  // ── structure / validation / misc ──
  'pydantic', 'pydantic-core', 'typing-extensions', 'annotated-types', 'attrs', 'orjson', 'ujson',
  'msgpack', 'simplejson', 'jsonschema', 'referencing', 'rpds-py', 'jsonschema-specifications',
  'deepdiff', 'orderly-set', 'faker', 'tqdm', 'rich', 'markdown-it-py', 'mdurl', 'pygments',
  'click', 'colorama', 'filetype', 'typing-inspection',
]);

/**
 * Import name → distribution name where they differ. Keys are lower-case
 * import names; values are normalised distribution names. Packages that are
 * NOT on the allowlist are still mapped so the gap report names the right
 * distribution («python-dotenv», not «dotenv»).
 */
const MODULE_TO_PACKAGE = Object.freeze({
  cv2: 'opencv-python-headless',
  pil: 'pillow',
  sklearn: 'scikit-learn',
  skimage: 'scikit-image',
  yaml: 'pyyaml',
  bs4: 'beautifulsoup4',
  docx: 'python-docx',
  pptx: 'python-pptx',
  fitz: 'pymupdf',
  dateutil: 'python-dateutil',
  slugify: 'python-slugify',
  fpdf: 'fpdf2',
  barcode: 'python-barcode',
  pdfminer: 'pdfminer-six',
  attr: 'attrs',
  dotenv: 'python-dotenv',
  magic: 'python-magic',
  crypto: 'pycryptodome',
  jwt: 'pyjwt',
  nacl: 'pynacl',
  openssl: 'pyopenssl',
  serial: 'pyserial',
  dns: 'dnspython',
  lazy_loader: 'lazy-loader',
  markdown_it: 'markdown-it-py',
  email_validator: 'email-validator',
  typing_extensions: 'typing-extensions',
  charset_normalizer: 'charset-normalizer',
  more_itertools: 'more-itertools',
  pypdf2: 'pypdf2',
  psycopg2: 'psycopg2-binary',
  google: 'google-api-python-client',
  // Namespace packages: the distribution is named by the SECOND component.
  'google.protobuf': 'protobuf',
  'google.auth': 'google-auth',
  'google.genai': 'google-genai',
  'google.generativeai': 'google-generativeai',
  'google.cloud': 'google-cloud-core',
  'mpl_toolkits.basemap': 'basemap',
  'ruamel.yaml': 'ruamel-yaml',
  'backports.zoneinfo': 'backports-zoneinfo',
  win32com: 'pywin32',
  docx2pdf: 'docx2pdf',
  pydub: 'pydub',
  moviepy: 'moviepy',
});

/** Distribution name the sandbox would need for an import name. */
function packageForModule(moduleName) {
  const parts = String(moduleName || '').trim().split('.');
  const top = parts[0].trim();
  if (!top) return '';
  const key = top.toLowerCase();
  if (parts.length > 1 && NAMESPACE_ROOTS.has(key)) {
    const pair = `${key}.${parts[1].toLowerCase()}`;
    return MODULE_TO_PACKAGE[pair] || normalizePackageName(`${top}-${parts[1]}`);
  }
  return MODULE_TO_PACKAGE[key] || normalizePackageName(top);
}

/**
 * Import roots shared by several distributions (PEP 420 / pkgutil
 * namespaces): «No module named 'google.protobuf'» means the protobuf
 * distribution is missing, not that google is installed with a wrong API.
 */
const NAMESPACE_ROOTS = new Set(['google', 'azure', 'zope', 'jaraco', 'mpl_toolkits', 'backports', 'sphinxcontrib', 'ruamel']);
function isNamespaceRoot(moduleName) {
  return NAMESPACE_ROOTS.has(String(moduleName || '').split('.')[0].trim().toLowerCase());
}

const NAME_RE = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?';
const OP_RE = '(?:===|==|~=|!=|<=|>=|<|>)';
const VERSION_RE = '[A-Za-z0-9.*+!_-]+';
const REQUIREMENT_RE = new RegExp(
  `^(${NAME_RE})(\\[[A-Za-z0-9_.,-]+\\])?\\s*(${OP_RE}\\s*${VERSION_RE}(?:\\s*,\\s*${OP_RE}\\s*${VERSION_RE})*)?$`,
);
const MAX_REQUIREMENT_CHARS = 100;

/**
 * Strict PEP 508 subset: `name`, `name[extra]`, `name==1.2`, `name>=1,<2`.
 * URLs, paths, VCS specs, options and environment markers are rejected
 * BEFORE anything reaches pip — a requirement is a name, never a location.
 */
function parseRequirement(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text || text.length > MAX_REQUIREMENT_CHARS) return null;
  if (text.startsWith('-')) return null;
  // Locations and shell syntax are never a requirement (`<`/`>` stay: they
  // are version operators and every spec is single-quoted before bash).
  if (/[/\\:@;#$`'"|&()]/.test(text)) return null;
  // A spec ending like an archive is a LOCAL file to pip (an sdist builds
  // and runs setup.py): «numpy==1.0.tar.gz», «evil-1.0-py3-none-any.whl».
  if (/\.(?:whl|zip|tar|tgz|tbz2?|txz|gz|bz2|xz)$/i.test(text)) return null;
  const m = REQUIREMENT_RE.exec(text);
  if (!m) return null;
  const name = normalizePackageName(m[1]);
  const extras = m[2] ? m[2].toLowerCase() : '';
  const specifier = m[3] ? m[3].replace(/\s+/g, '') : '';
  return { raw: text, name, display: m[1], extras, specifier, spec: `${name}${extras}${specifier}` };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function splitList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((s) => normalizePackageName(s))
    .filter(Boolean);
}

/** Accept only docker/tmpfs size literals ("512m", "1g"). */
function safeSize(value, fallback) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return /^\d+(\.\d+)?[bkmg]?$/.test(s) ? s : fallback;
}

function safeDockerNetwork(value, fallback) {
  const s = String(value == null ? '' : value).trim();
  // Never the host namespace: the installer has egress and runs untrusted wheels.
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(s) && s !== 'host' ? s : fallback;
}

function safeIndexUrl(value) {
  const s = String(value == null ? '' : value).trim();
  if (!/^https?:\/\/[^\s'"`$;|&<>]+$/i.test(s)) return null;
  return s;
}

/**
 * Operator policy, read at call time (no restart needed).
 *
 *  SIRAGPT_SANDBOX_PIP             '0' disables the installer (default ON; OFF under NODE_ENV=test unless '1').
 *                                  'allowlist' installs ONLY the curated list; otherwise a name outside it
 *                                  may be installed after vetting (sandbox-packages/vetting.js)
 *  SIRAGPT_SANDBOX_PIP_EXTRA_ALLOW comma/space list added to the allowlist
 *  SIRAGPT_SANDBOX_PIP_DENY        comma/space list removed from the allowlist
 *  SIRAGPT_SANDBOX_PIP_INDEX_URL   package index (a local devpi/proxy), default PyPI
 *  SIRAGPT_SANDBOX_PIP_NETWORK     docker network of the installer container (default: the driver's — bridge locally, the sandbox host's SANDBOX_PIP_NETWORK remotely; never host)
 *  SIRAGPT_SANDBOX_PIP_TIMEOUT_MS  per install call (30 s – 10 min, default 180 s)
 *  SIRAGPT_SANDBOX_PIP_MAX_PER_TURN install calls per document turn (1–10, default 3)
 *  SIRAGPT_SANDBOX_PIP_MAX_PACKAGES requirements per call (1–20, default 8)
 *  SIRAGPT_SANDBOX_PIP_MAX_BYTES   payload cap streamed into the sandbox (10 MB – 2 GB, default 300 MB)
 *  SIRAGPT_SANDBOX_PIP_TMP_SIZE    tmpfs of the installer container (default 1g)
 */
function resolvePolicy(env = process.env) {
  const e = env || {};
  const flag = String(e.SIRAGPT_SANDBOX_PIP ?? '').trim().toLowerCase();
  const isTest = String(e.NODE_ENV || '') === 'test';
  const enabled = flag === '0' ? false : (flag === '1' || flag === 'allowlist' ? true : !isTest);
  const indexUrl = safeIndexUrl(e.SIRAGPT_SANDBOX_PIP_INDEX_URL);
  const allow = new Set(DEFAULT_ALLOWLIST);
  // Denied names also never reach the vetting: the operator's word is final.
  const deny = new Set(splitList(e.SIRAGPT_SANDBOX_PIP_DENY));
  for (const name of splitList(e.SIRAGPT_SANDBOX_PIP_EXTRA_ALLOW)) allow.add(name);
  for (const name of deny) allow.delete(name);
  return {
    enabled,
    allow,
    deny,
    // Names outside the curated list may be installed once vetted against
    // public PyPI / OSV data. Not with a private index: its packages are not
    // the ones that data describes.
    vetting: enabled && flag !== 'allowlist' && !indexUrl,
    indexUrl,
    // null = the driver's default (bridge for the local docker daemon; the
    // sandbox host's own SANDBOX_PIP_NETWORK for the remote service).
    network: safeDockerNetwork(e.SIRAGPT_SANDBOX_PIP_NETWORK, null),
    timeoutMs: clampInt(e.SIRAGPT_SANDBOX_PIP_TIMEOUT_MS, 180_000, 30_000, 600_000),
    maxPerTurn: clampInt(e.SIRAGPT_SANDBOX_PIP_MAX_PER_TURN, 3, 1, 10),
    maxPackages: clampInt(e.SIRAGPT_SANDBOX_PIP_MAX_PACKAGES, 8, 1, 20),
    maxBytes: clampInt(e.SIRAGPT_SANDBOX_PIP_MAX_BYTES, 300 * 1024 * 1024, 10 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
    tmpSize: safeSize(e.SIRAGPT_SANDBOX_PIP_TMP_SIZE, '1g'),
  };
}

function isAllowed(name, policy) {
  const key = normalizePackageName(name);
  return Boolean(key && policy && policy.allow && policy.allow.has(key));
}

/**
 * Validate a tool request. The whole call is refused when ANY entry is
 * invalid or not allowed, so the model always sees exactly which names to
 * drop; nothing is half-installed.
 */
function validateRequest(rawList, policy) {
  const list = Array.isArray(rawList) ? rawList : [rawList];
  const requirements = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of list) {
    const parsed = parseRequirement(raw);
    if (!parsed) {
      rejected.push({ raw: String(raw == null ? '' : raw).slice(0, 120), reason: 'invalid_spec' });
      continue;
    }
    if (seen.has(parsed.name)) continue;
    seen.add(parsed.name);
    if (!isAllowed(parsed.name, policy)) {
      rejected.push({ raw: parsed.raw, name: parsed.name, reason: 'not_allowed' });
      continue;
    }
    requirements.push(parsed);
  }
  if (policy && requirements.length > policy.maxPackages) {
    return {
      ok: false,
      requirements,
      rejected: [...rejected, { raw: '', reason: 'too_many', limit: policy.maxPackages }],
    };
  }
  return { ok: requirements.length > 0 && rejected.length === 0, requirements, rejected };
}

/** The allowlist as the JSON the installer validates pip's report against. */
function allowlistJson(policy) {
  return JSON.stringify([...(policy && policy.allow ? policy.allow : [])].sort());
}

module.exports = {
  DEFAULT_ALLOWLIST,
  MODULE_TO_PACKAGE,
  isNamespaceRoot,
  MAX_REQUIREMENT_CHARS,
  normalizePackageName,
  packageForModule,
  parseRequirement,
  resolvePolicy,
  isAllowed,
  validateRequest,
  allowlistJson,
};
