/**
 * Conventional Commits — keeps history readable for `git log` skimmers,
 * release-note tools, and the THIRD_PARTY_LICENSES diff guard. Mirrors the
 * vocabulary the repo already uses (feat/fix/chore/refactor/test/docs/perf/ci).
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [1, 'always', 200],
    'subject-case': [0],
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
        'security',
      ],
    ],
  },
};
