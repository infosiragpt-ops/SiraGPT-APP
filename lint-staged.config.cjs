/** @type {import('lint-staged').Config} */
module.exports = {
  '*.{js,jsx,ts,tsx}': (files) => {
    const filtered = files.filter((f) => !f.includes('/upstream/'));
    if (filtered.length === 0) return [];
    return [
      `bash scripts/check-secrets.sh ${filtered.map((f) => `"${f}"`).join(' ')}`,
      ...filtered.map((f) => `next lint --fix --max-warnings 97 --file ${f}`),
    ];
  },
  '*.{json,md,yml,yaml,env,sh,toml}': (files) => {
    const filtered = files.filter((f) => !f.includes('/upstream/'));
    if (filtered.length === 0) return [];
    return [`bash scripts/check-secrets.sh ${filtered.map((f) => `"${f}"`).join(' ')}`];
  },
  '*.{ts,tsx}': (files) => {
    const filtered = files.filter((f) => !f.includes('/upstream/'));
    if (filtered.length === 0) return [];
    return ["bash -c 'npx tsc --noEmit --skipLibCheck --ignoreDeprecations 5.0'"];
  },
};
