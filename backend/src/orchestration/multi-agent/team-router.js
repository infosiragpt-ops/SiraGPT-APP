'use strict';

function selectTeam(intent = '') {
  const text = String(intent).toLowerCase();
  if (/\btesis|apa|paper|investigaci[oó]n|bibliograf/i.test(text)) {
    return ['thesis-writer', 'apa-reviewer', 'citation-verifier'];
  }
  if (/\bcode|debug|refactor|repo/i.test(text)) {
    return ['planner', 'coder', 'reviewer'];
  }
  return ['planner', 'critic', 'finalizer'];
}

module.exports = { selectTeam };
