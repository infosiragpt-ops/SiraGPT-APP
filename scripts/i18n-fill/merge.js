// Rellena las 125 claves faltantes (auth/profile/sidebar/composer/messageActions/common)
// en las ~51 locales usando los datos de data-batch*.js. Preserva estructura anidada.
const fs = require("fs");
const path = require("path");

const MESSAGES_DIR = path.join(__dirname, "..", "..", "messages");
const DATA_DIR = __dirname;

function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function main() {
  const dataFiles = fs.readdirSync(DATA_DIR).filter((f) => /^data-batch.*\.js$/.test(f));
  const byLocale = {};
  for (const f of dataFiles) {
    const batch = require(path.join(DATA_DIR, f));
    for (const locale of Object.keys(batch)) {
      byLocale[locale] = Object.assign(byLocale[locale] || {}, batch[locale]);
    }
  }

  const locales = Object.keys(byLocale);
  let updated = 0;
  let totalKeys = 0;
  for (const locale of locales) {
    const filePath = path.join(MESSAGES_DIR, `${locale}.json`);
    if (!fs.existsSync(filePath)) continue;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const dict = byLocale[locale];
    for (const key of Object.keys(dict)) {
      setPath(data, key, dict[key]);
      totalKeys++;
    }
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    updated++;
  }
  console.log(`[i18n-fill] ${totalKeys} claves escritas en ${updated} locales`);
}

if (require.main === module) main();

module.exports = { setPath };
