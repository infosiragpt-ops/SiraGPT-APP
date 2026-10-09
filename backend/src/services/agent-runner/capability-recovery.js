'use strict';

// A failed dependency import is evidence, not permission to install arbitrary
// code on the application host. Guide the next existing tool call toward the
// installed sandbox capabilities, preserving the original error and budgets.
function capabilityRecoveryGuidance(stderr, { language = 'python', exitCode } = {}) {
  const error = String(stderr || '').slice(-8000);
  const missing = language === 'python'
    ? /(?:ModuleNotFoundError|ImportError): No module named ['"]([A-Za-z_][\w.]*)['"]/.exec(error)
    : Number(exitCode) === 127 && /(?:command not found|not found)/i.test(error);
  if (!missing) return '';
  const moduleName = Array.isArray(missing) ? missing[1].split('.')[0] : '';
  let alternative = 'Inspect available tools with importlib.util.find_spec and shutil.which before choosing an installed equivalent.';
  if (/^(docx2pdf|pdf2docx)$/.test(moduleName)) {
    alternative = 'For DOCX↔PDF load_skill("media-conversion") and use from sira_convert import convert; it uses the installed document engines and reports fidelity limits.';
  } else if (/^(moviepy|pydub|ffmpeg)$/.test(moduleName)) {
    alternative = 'For MP3↔MP4 load_skill("media-conversion") and use from sira_convert import convert; inspect shutil.which("ffmpeg") for other media operations.';
  } else if (moduleName === 'python_docx') {
    alternative = 'The installed python-docx distribution is imported as docx; inspect importlib.util.find_spec("docx") and use from docx import Document.';
  }
  return [
    '[Capability recovery: missing_dependency]',
    alternative,
    'Do not repeat the same failed import/command. Use web_search/web_fetch, if available, for official API documentation; keep the source and error in the task context.',
    'The sandbox is offline: pip/npm/apt cannot download packages. Do not disable isolation or install on the host. If no installed equivalent satisfies the request, retain completed outputs and name the missing capability and next step; never claim the unavailable result was created.',
  ].join('\n');
}

module.exports = { capabilityRecoveryGuidance };
