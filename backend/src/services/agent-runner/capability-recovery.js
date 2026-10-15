'use strict';

// A failed dependency import is evidence, not permission to install arbitrary
// code on the application host. Guide the next existing tool call toward the
// installed sandbox capabilities, preserving the original error and budgets.
// With a package policy (sandbox-packages/policy.js) the guidance also says
// whether the missing distribution is APPROVED — then the agent may install
// it into its own sandbox with install_sandbox_package — or not, in which
// case the gap is reported to the administrator and the agent stays honest.

const PYTHON_MISSING_RE = /(?:ModuleNotFoundError|ImportError): No module named ['"]([A-Za-z_][\w.]*)['"]/;

/** Parse the missing import / command out of a tool's stderr. */
function detectMissingDependency(stderr, { language = 'python', exitCode } = {}) {
  const error = String(stderr || '').slice(-8000);
  if (language === 'python') {
    const m = PYTHON_MISSING_RE.exec(error);
    if (!m) return null;
    return { kind: 'python_module', name: m[1].split('.')[0], raw: m[1] };
  }
  if (Number(exitCode) === 127 && /(?:command not found|not found)/i.test(error)) {
    const cmd = /(?:bash: )?(?:line \d+: )?([A-Za-z0-9_.-]+): (?:command )?not found/.exec(error);
    return { kind: 'binary', name: cmd ? cmd[1] : '', raw: cmd ? cmd[1] : '' };
  }
  return null;
}

/**
 * @param {string} stderr
 * @param {object} [opts]
 * @param {'python'|'bash'} [opts.language]
 * @param {number} [opts.exitCode]
 * @param {object} [opts.policy]  resolvePolicy() result; omitted → no installer
 * @param {string} [opts.package] distribution name for the module (policy.packageForModule)
 * @param {boolean} [opts.allowed]
 */
function capabilityRecoveryGuidance(stderr, { language = 'python', exitCode, policy = null, package: pkg = null, allowed = null, notADistribution = null } = {}) {
  const missing = detectMissingDependency(stderr, { language, exitCode });
  if (!missing) return '';
  const moduleName = missing.kind === 'python_module' ? missing.name : '';
  let alternative = '';
  if (/^(docx2pdf|pdf2docx)$/.test(moduleName)) {
    alternative = 'For DOCX↔PDF load_skill("media-conversion") and use from sira_convert import convert; it uses the installed document engines and reports fidelity limits.';
  } else if (/^(moviepy|pydub|ffmpeg)$/.test(moduleName)) {
    alternative = 'For MP3↔MP4 load_skill("media-conversion") and use from sira_convert import convert; inspect shutil.which("ffmpeg") for other media operations.';
  } else if (moduleName === 'python_docx') {
    alternative = 'The installed python-docx distribution is imported as docx; inspect importlib.util.find_spec("docx") and use from docx import Document.';
  }
  // A converter request always points at the native converter; otherwise a
  // wrong submodule or a missing staged helper is not a library to install.
  if (!alternative && notADistribution === 'submodule') {
    return [
      '[Capability recovery: missing_submodule]',
      `The package «${missing.name}» IS installed; the submodule in the failed import does not exist in it. This is an API mistake, not a missing library: inspect the real API (help(), dir(), importlib.util.find_spec) and fix the import. Do not install anything.`,
    ].join('\n');
  }
  if (!alternative && notADistribution === 'internal') {
    return [
      '[Capability recovery: missing_helper]',
      `«${missing.name}» is a SiraGPT helper staged in /workspace/tmp, not a library. Check it exists (ls /workspace/tmp) and import it from a script whose sys.path includes /workspace/tmp. Do not install anything.`,
    ].join('\n');
  }
  if (!alternative) alternative = 'Inspect available tools with importlib.util.find_spec and shutil.which before choosing an installed equivalent.';
  const installerOn = Boolean(policy && policy.enabled) && missing.kind === 'python_module';
  let installLine;
  if (installerOn && allowed && pkg) {
    installLine = `The distribution «${pkg}» is on the APPROVED list: call install_sandbox_package({"packages":["${pkg}"]}) once, then retry the import. Do not try pip yourself.`;
  } else if (installerOn && pkg) {
    installLine = `The distribution «${pkg}» is NOT on the approved package list: it was reported to the administrator. Do not try to install it; use an installed equivalent or state the missing capability.`;
  } else {
    installLine = 'The sandbox is offline: pip/npm/apt cannot download packages. Do not disable isolation or install on the host.';
  }
  return [
    '[Capability recovery: missing_dependency]',
    alternative,
    'Do not repeat the same failed import/command. Use web_search/web_fetch, if available, for official API documentation; keep the source and error in the task context.',
    `${installLine} If no installed equivalent satisfies the request, retain completed outputs and name the missing capability and next step; never claim the unavailable result was created.`,
  ].join('\n');
}

module.exports = { capabilityRecoveryGuidance, detectMissingDependency };
