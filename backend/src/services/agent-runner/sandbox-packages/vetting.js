'use strict';

/**
 * Vetting for PyPI distributions OUTSIDE the curated allowlist (policy.js).
 *
 * The curated list covers document and data work, but users ask for any
 * library in the world. A name that is not on the list is no longer refused
 * outright: before it can reach the installer it must look like an
 * established, non-malicious project.
 *
 *   - it exists on PyPI and ships at least one live (non-yanked) wheel: the
 *     installer is wheels-only, so no setup.py ever runs;
 *   - PyPI has not quarantined it (PEP 792 project status);
 *   - OSV has no malicious-code advisory for the version pip would install
 *     (OpenSSF MAL-* entries, or a PYSEC/GHSA describing a hijacked release);
 *   - the project is at least MIN_PROJECT_AGE_DAYS old: almost every
 *     malicious upload is removed within days of publication;
 *   - it has real adoption (pypistats last-month downloads). When the stats
 *     are unavailable, a longer track record is demanded instead;
 *   - its name is not one edit away from a popular distribution
 *     («reqeusts», «python-requests», «scikitlearn») unless it is itself
 *     widely used.
 *
 * Fail closed: when PyPI or OSV cannot be reached the package is refused
 * («could not be verified»), never waved through. Installed code still runs
 * only inside the network-less sandbox; vetting decides what may get there.
 *
 * Pure apart from the injected fetch; results are cached per name.
 */

const policy = require('./policy');

const MIN_PROJECT_AGE_DAYS = 90;
const MIN_MONTHLY_DOWNLOADS = 2000;
// Download stats unavailable (pypistats down / rate limited): demand a year
// of history and several releases instead.
const FALLBACK_MIN_PROJECT_AGE_DAYS = 365;
const FALLBACK_MIN_RELEASES = 5;
// A name near a popular one passes only with this much adoption of its own
// («scapy» is not a typo of «scipy»).
const TYPOSQUAT_EXEMPT_DOWNLOADS = 50_000;
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 2000;
const CONCURRENCY = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

const PYPI_SIMPLE = 'https://pypi.org/simple';
const OSV_QUERY = 'https://api.osv.dev/v1/query';
const PYPISTATS = 'https://pypistats.org/api/packages';

// Widely used distributions a typosquat would imitate, on top of the curated
// allowlist and the image catalog. PEP 503 names.
const POPULAR = Object.freeze([
  'aiohttp', 'alembic', 'amqp', 'anyio', 'arrow', 'asttokens', 'async-timeout', 'attrs', 'awscli',
  'babel', 'bcrypt', 'beautifulsoup4', 'billiard', 'black', 'bleach', 'boto3', 'botocore',
  'cachetools', 'celery', 'certifi', 'cffi', 'chardet', 'charset-normalizer', 'click', 'colorama',
  'contourpy', 'coverage', 'cryptography', 'cycler', 'cython', 'dask', 'decorator', 'distlib',
  'django', 'docker', 'docutils', 'duckdb', 'et-xmlfile', 'exceptiongroup', 'executing', 'faker',
  'fastapi', 'filelock', 'flake8', 'flask', 'folium', 'fonttools', 'freezegun', 'frozenlist',
  'fsspec', 'gensim', 'geopandas', 'google-api-core', 'google-auth', 'greenlet', 'grpcio',
  'gunicorn', 'h11', 'html5lib', 'httpcore', 'httpx', 'huggingface-hub', 'idna', 'imageio',
  'importlib-metadata', 'iniconfig', 'ipykernel', 'ipython', 'isodate', 'isort', 'itsdangerous',
  'jedi', 'jinja2', 'jmespath', 'joblib', 'jsonschema', 'jupyter', 'keras', 'kiwisolver', 'kombu',
  'kubernetes', 'langchain', 'lightgbm', 'llvmlite', 'lxml', 'markdown', 'markdown-it-py',
  'markupsafe', 'matplotlib', 'mdurl', 'mistune', 'mock', 'more-itertools', 'mpmath', 'msgpack',
  'multidict', 'mypy', 'nbformat', 'networkx', 'nltk', 'nose', 'notebook', 'numba', 'numpy',
  'oauthlib', 'openai', 'opencv-python', 'opencv-python-headless', 'openpyxl', 'orjson',
  'packaging', 'pandas', 'paramiko', 'parso', 'pendulum', 'pillow', 'pip', 'platformdirs',
  'playwright', 'plotly', 'pluggy', 'polars', 'prompt-toolkit', 'protobuf', 'psutil',
  'psycopg2-binary', 'pure-eval', 'pyarrow', 'pyasn1', 'pyasn1-modules', 'pybind11', 'pycparser',
  'pydantic', 'pydantic-core', 'pygments', 'pyjwt', 'pylint', 'pymupdf', 'pymysql', 'pynacl',
  'pyopenssl', 'pyparsing', 'pypdf', 'pyproj', 'pyspark', 'pytest', 'pytesseract',
  'python-dateutil', 'python-docx', 'python-pptx', 'pytz', 'pyyaml', 'pyzmq', 'qrcode', 'redis',
  'regex', 'reportlab', 'requests', 'requests-oauthlib', 'rich', 'rsa', 's3fs', 's3transfer',
  'safetensors', 'scapy', 'scikit-image', 'scikit-learn', 'scipy', 'seaborn', 'selenium',
  'setuptools', 'shapely', 'simplejson', 'six', 'sniffio', 'soupsieve', 'spacy', 'sphinx',
  'sqlalchemy', 'sqlparse', 'stack-data', 'starlette', 'statsmodels', 'sympy', 'tabulate',
  'tensorflow', 'termcolor', 'threadpoolctl', 'tiktoken', 'tokenizers', 'toml', 'tomli', 'tomlkit',
  'torch', 'tornado', 'tox', 'tqdm', 'traitlets', 'transformers', 'typing-extensions', 'tzdata',
  'ujson', 'urllib3', 'uvicorn', 'vine', 'virtualenv', 'wcwidth', 'webencodings', 'werkzeug',
  'wheel', 'wrapt', 'xgboost', 'xlrd', 'xlsxwriter', 'yarl', 'zipp',
]);

let catalogNames = null;
function popularNames() {
  if (!catalogNames) {
    const names = new Set([...POPULAR, ...policy.DEFAULT_ALLOWLIST, ...Object.values(policy.MODULE_TO_PACKAGE)]);
    try {
      const catalog = require('../sandbox-capabilities.json');
      for (const entry of Array.isArray(catalog.python) ? catalog.python : []) {
        const parsed = policy.parseRequirement(String(entry && entry.pip || '').split(/[<>=!~;\s]/)[0]);
        if (parsed) names.add(parsed.name);
      }
    } catch (_) { /* the curated list and POPULAR still apply */ }
    catalogNames = names;
  }
  return catalogNames;
}

/** Optimal-string-alignment distance, stopping early once it exceeds `max`. */
function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i += 1) {
    rows[i] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2][j - 2] + 1);
      rows[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
  }
  return rows[a.length][b.length];
}

/** The popular distribution `name` seems to imitate, or null. */
function typosquatTarget(name, popular = popularNames()) {
  const key = policy.normalizePackageName(name);
  if (!key || popular.has(key)) return null;
  const limit = key.length >= 10 ? 2 : (key.length >= 4 ? 1 : 0);
  const compact = key.replace(/-/g, '');
  for (const known of popular) {
    if (limit && editDistance(key, known, limit) <= limit) return known;
    if (known.replace(/-/g, '') === compact) return known;
  }
  // «python-requests», «requests-python», «pyrequests»
  const stripped = key.replace(/^python-|-python$/, '').replace(/^py-?(?=[a-z]{4,})/, '');
  if (stripped !== key && popular.has(stripped)) return stripped;
  return null;
}

// PEP 440 subset: N(.N)*[{a|b|rc}N][.postN][.devN]. Epochs and local
// versions are left out (null) and fall back to upload order.
function parseVersion(version) {
  const m = /^(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?(?:\.dev(\d+))?$/.exec(String(version || '').toLowerCase());
  if (!m) return null;
  return {
    release: m[1].split('.').map(Number),
    pre: m[2] ? [{ a: 0, b: 1, rc: 2 }[m[2]], Number(m[3])] : null,
    post: m[4] != null ? Number(m[4]) : null,
    dev: m[5] != null ? Number(m[5]) : null,
  };
}

function compareParsedVersions(a, b) {
  const len = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < len; i += 1) {
    const d = (a.release[i] || 0) - (b.release[i] || 0);
    if (d) return d;
  }
  if (a.pre && !b.pre) return -1;
  if (!a.pre && b.pre) return 1;
  if (a.pre && b.pre) {
    const d = a.pre[0] - b.pre[0] || a.pre[1] - b.pre[1];
    if (d) return d;
  }
  const post = (a.post == null ? -1 : a.post) - (b.post == null ? -1 : b.post);
  if (post) return post;
  const ad = a.dev == null ? Infinity : a.dev;
  const bd = b.dev == null ? Infinity : b.dev;
  return ad === bd ? 0 : (ad < bd ? -1 : 1);
}

/**
 * The version pip installs for an unpinned name: the highest stable one
 * (pre/dev releases only when nothing else exists). NOT the newest upload:
 * a backport such as pydicom 2.4.5 is uploaded after 3.0.
 */
function highestVersion(versions) {
  const parsed = [...versions].map((v) => ({ v, p: parseVersion(v) })).filter((x) => x.p);
  const stable = parsed.filter((x) => !x.p.pre && x.p.dev == null);
  const pool = stable.length ? stable : parsed;
  if (!pool.length) return null;
  return pool.reduce((best, x) => (compareParsedVersions(x.p, best.p) > 0 ? x : best)).v;
}

// Malicious-code advisories. OpenSSF's feed uses MAL-* ids, but a hijacked
// popular project can land as an ordinary PYSEC/GHSA entry (ultralytics
// 8.3.41-46: PYSEC-2024-154 «contained malicious crypto miner software»).
// Ordinary CVE wording («a malicious user», «execute malicious code») must
// NOT match, or every package with an open CVE would be refused.
const MALICIOUS_ADVISORY_RE = /\b(?:malware|backdoor(?:ed|s)?|supply[- ]chain (?:attack|compromise)|crypto ?(?:currency )?miners?|cryptominers?|malicious (?:software|packages?|releases?|versions?|dependenc(?:y|ies)|updates?)|(?:contained|contains|containing|shipped|injected|included) (?:a |an )?malicious|compromised (?:releases?|versions?|packages?|accounts?|maintainers?))\b/i;

function isMaliciousAdvisory(vuln) {
  if (!vuln) return false;
  if (String(vuln.id || '').startsWith('MAL-')) return true;
  if ((Array.isArray(vuln.aliases) ? vuln.aliases : []).some((id) => String(id).startsWith('MAL-'))) return true;
  return MALICIOUS_ADVISORY_RE.test(`${vuln.summary || ''}\n${String(vuln.details || '').slice(0, 2000)}`);
}

/** Version of a wheel file name: {dist}-{version}(-{build})?-{py}-{abi}-{plat}.whl */
function wheelVersion(filename) {
  const parts = String(filename || '').replace(/\.whl$/i, '').split('-');
  return parts.length >= 5 ? parts[1] : null;
}

function pinnedVersion(specifier) {
  const m = /^===?([A-Za-z0-9.+!_-]+)$/.exec(String(specifier || ''));
  return m ? m[1] : null;
}

async function fetchWithTimeout(fetchImpl, url, init = {}, { timeoutMs = REQUEST_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function readProject(fetchImpl, name, opts) {
  const res = await fetchWithTimeout(fetchImpl, `${PYPI_SIMPLE}/${encodeURIComponent(name)}/`, {
    headers: { Accept: 'application/vnd.pypi.simple.v1+json', 'User-Agent': 'SiraGPT-sandbox-vetting' },
  }, opts);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`pypi_http_${res.status}`);
  const body = await res.json();
  const files = Array.isArray(body && body.files) ? body.files : [];
  const uploads = files.map((f) => Date.parse(f && f['upload-time'])).filter(Number.isFinite);
  const liveWheels = files
    .filter((f) => f && !f.yanked && /\.whl$/i.test(String(f.filename || '')))
    .map((f) => ({ version: wheelVersion(f.filename), at: Date.parse(f['upload-time']) || 0 }))
    .filter((w) => w.version);
  liveWheels.sort((a, b) => b.at - a.at);
  const status = body && body['project-status'] && body['project-status'].status;
  return {
    files: files.length,
    versions: Array.isArray(body && body.versions) ? body.versions.length : new Set(liveWheels.map((w) => w.version)).size,
    firstUploadAt: uploads.length ? Math.min(...uploads) : null,
    newestWheelVersion: liveWheels.length ? (highestVersion(new Set(liveWheels.map((w) => w.version))) || liveWheels[0].version) : null,
    wheelVersions: new Set(liveWheels.map((w) => w.version)),
    allYanked: files.length > 0 && files.every((f) => f && f.yanked),
    status: typeof status === 'string' ? status.toLowerCase() : null,
  };
}

async function readMaliciousAdvisories(fetchImpl, name, version, opts) {
  const body = { package: { name, ecosystem: 'PyPI' } };
  if (version) body.version = version;
  const res = await fetchWithTimeout(fetchImpl, OSV_QUERY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'SiraGPT-sandbox-vetting' },
    body: JSON.stringify(body),
  }, opts);
  if (!res.ok) throw new Error(`osv_http_${res.status}`);
  const data = await res.json();
  return (Array.isArray(data && data.vulns) ? data.vulns : [])
    .filter(isMaliciousAdvisory)
    .map((v) => String(v.id || 'unnamed advisory'));
}

/** Last-month downloads; 0 when pypistats has never seen the project; null when unknown. */
async function readMonthlyDownloads(fetchImpl, name, opts) {
  try {
    const res = await fetchWithTimeout(fetchImpl, `${PYPISTATS}/${encodeURIComponent(name)}/recent?period=month`, {
      headers: { Accept: 'application/json', 'User-Agent': 'SiraGPT-sandbox-vetting' },
    }, opts);
    if (res.status === 404) return 0;
    if (!res.ok) return null;
    const data = await res.json();
    const n = Number(data && data.data && data.data.last_month);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (_) {
    return null;
  }
}

function refuse(name, reason, detail, evidence = {}) {
  return { ok: false, name, reason, detail, evidence };
}

/**
 * Vet one distribution. Never throws: an unreachable PyPI / OSV is the
 * verdict `vet_unavailable` (refused).
 *
 * @param {string} rawName  distribution name (normalised here)
 * @param {object} [opts]
 * @param {string|null} [opts.version]  pinned version (`name==1.2`), if any
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.now]
 * @param {AbortSignal} [opts.signal]
 */
async function vetPackage(rawName, { version = null, fetchImpl = globalThis.fetch, now = Date.now(), signal, popular = popularNames() } = {}) {
  const name = policy.normalizePackageName(rawName);
  if (!name) return refuse(String(rawName || ''), 'invalid_name', 'not a valid distribution name');
  if (typeof fetchImpl !== 'function') return refuse(name, 'vet_unavailable', 'no network client to verify it');
  const opts = { signal };
  let project;
  try {
    project = await readProject(fetchImpl, name, opts);
  } catch (err) {
    return refuse(name, 'vet_unavailable', `PyPI could not be reached (${String(err && err.message || err).slice(0, 80)})`);
  }
  if (!project) return refuse(name, 'not_found', 'it does not exist on PyPI; check the exact distribution name (it can differ from the import name)');
  if (project.status === 'quarantined' || project.allYanked) {
    return refuse(name, 'withdrawn', project.status === 'quarantined' ? 'PyPI has quarantined it' : 'every release was withdrawn (yanked)');
  }
  if (!project.newestWheelVersion) return refuse(name, 'no_wheels', 'it publishes no installable wheel (source-only packages are not installed)');
  const targetVersion = version && project.wheelVersions.has(version) ? version : project.newestWheelVersion;
  const ageDays = project.firstUploadAt ? Math.floor((now - project.firstUploadAt) / DAY_MS) : 0;
  const evidence = { version: targetVersion, ageDays, releases: project.versions };

  let malicious;
  try {
    malicious = await readMaliciousAdvisories(fetchImpl, name, targetVersion, opts);
  } catch (err) {
    return refuse(name, 'vet_unavailable', `the malware advisory database could not be reached (${String(err && err.message || err).slice(0, 80)})`, evidence);
  }
  if (malicious.length) return refuse(name, 'malicious', `reported as a malicious package (${malicious.slice(0, 3).join(', ')})`, { ...evidence, advisories: malicious });

  if (ageDays < MIN_PROJECT_AGE_DAYS) {
    return refuse(name, 'too_new', `first published ${ageDays} day(s) ago; new projects need ${MIN_PROJECT_AGE_DAYS} days of history`, evidence);
  }
  const downloads = await readMonthlyDownloads(fetchImpl, name, opts);
  evidence.monthlyDownloads = downloads;
  if (downloads != null && downloads < MIN_MONTHLY_DOWNLOADS) {
    return refuse(name, 'low_adoption', `only ${downloads} download(s) last month (minimum ${MIN_MONTHLY_DOWNLOADS})`, evidence);
  }
  if (downloads == null && (ageDays < FALLBACK_MIN_PROJECT_AGE_DAYS || project.versions < FALLBACK_MIN_RELEASES)) {
    return refuse(name, 'vet_unavailable', 'download statistics are unavailable and the project lacks a long track record', evidence);
  }
  const squat = typosquatTarget(name, popular);
  if (squat && (downloads == null || downloads < TYPOSQUAT_EXEMPT_DOWNLOADS)) {
    return refuse(name, 'possible_typosquat', `its name imitates «${squat}»; if that is the library you meant, install «${squat}»`, { ...evidence, imitates: squat });
  }
  return { ok: true, name, reason: 'vetted', detail: '', evidence };
}

function describeEvidence(evidence = {}) {
  const parts = [];
  if (Number.isFinite(evidence.ageDays)) {
    parts.push(evidence.ageDays >= 365 ? `on PyPI for ${Math.floor(evidence.ageDays / 365)}+ year(s)` : `on PyPI for ${evidence.ageDays} days`);
  }
  if (Number.isFinite(evidence.monthlyDownloads)) parts.push(`${evidence.monthlyDownloads.toLocaleString('en-US')} downloads last month`);
  parts.push('no malware advisory');
  return parts.join(', ');
}

/**
 * A vetter with a per-name verdict cache (transient failures are not cached)
 * and bounded parallelism. One shared instance serves every turn.
 */
function createVetter({ fetchImpl = globalThis.fetch, now = () => Date.now(), ttlMs = CACHE_TTL_MS, concurrency = CONCURRENCY } = {}) {
  const cache = new Map();
  const vetOne = async (entry, signal) => {
    const name = policy.normalizePackageName(entry && entry.name);
    const version = entry && entry.version ? String(entry.version) : null;
    const key = `${name}@${version || ''}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.result;
    const result = await vetPackage(name, { version, fetchImpl, now: now(), signal });
    if (result.reason !== 'vet_unavailable') {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), result });
    }
    return result;
  };
  return {
    /** @param {Array<{name: string, version?: string|null}>} entries */
    async vet(entries, { signal } = {}) {
      const list = Array.isArray(entries) ? entries : [];
      const out = new Array(list.length);
      let next = 0;
      const worker = async () => {
        while (next < list.length) {
          const index = next;
          next += 1;
          out[index] = await vetOne(list[index], signal);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
      return out;
    },
    clear() { cache.clear(); },
  };
}

let shared = null;
/** The process-wide vetter (shared cache across turns). */
function sharedVetter() {
  if (!shared) shared = createVetter();
  return shared;
}

module.exports = {
  MIN_PROJECT_AGE_DAYS,
  MIN_MONTHLY_DOWNLOADS,
  FALLBACK_MIN_PROJECT_AGE_DAYS,
  FALLBACK_MIN_RELEASES,
  TYPOSQUAT_EXEMPT_DOWNLOADS,
  POPULAR,
  popularNames,
  editDistance,
  typosquatTarget,
  wheelVersion,
  pinnedVersion,
  parseVersion,
  highestVersion,
  isMaliciousAdvisory,
  vetPackage,
  describeEvidence,
  createVetter,
  sharedVetter,
};
