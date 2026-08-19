#!/usr/bin/env node
/**
 * Codemod: replace `<Loader2 ... animate-spin ... />` spinner patterns
 * with `<ThinkingIndicator />` from components/ui/thinking-indicator.
 * Conservative — only touches *single-line* matches so multi-line or
 * dynamic className compositions are left alone for manual review.
 *
 * Usage: node scripts/codemod-thinking-indicator.cjs
 *   --dry-run   show planned changes, don't write files
 *   --verbose   list each replacement
 *
 * Idempotent: rerunning on a clean tree is a no-op.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROOTS = ['app', 'components', 'hooks', 'lib'];
const EXTS = new Set(['.tsx', '.ts']);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', '.test-dist', 'artifacts']);

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const VERBOSE = args.has('--verbose');

const SIZE_FOR_PX = (n) => {
  if (n <= 12) return 'xs';
  if (n <= 16) return 'sm';
  if (n <= 24) return 'md';
  if (n <= 36) return 'lg';
  return 'xl';
};

const PX_FOR_TW = (cls) => {
  // h-3 → 12, h-4 → 16, h-5 → 20, h-6 → 24, h-8 → 32, h-9 → 36, h-10 → 40
  const match = cls.match(/(?:^|\s)h-(\d+)(?:\s|$)/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return n * 4;
};

function pickSize(className) {
  // Look for h-N inside the class string. Falls back to "sm".
  const px = PX_FOR_TW(className);
  if (px == null) return 'sm';
  return SIZE_FOR_PX(px);
}

function stripSpinnerClasses(className) {
  return className
    .replace(/(?:^|\s)animate-spin(?=\s|$)/, ' ')
    .replace(/(?:^|\s)h-\d+(?=\s|$)/g, ' ')
    .replace(/(?:^|\s)w-\d+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SIMPLE_LOADER_RE = /<Loader2(\s+[^/>]*?)?\s*\/>/g;

function transformLine(line) {
  return line.replace(SIMPLE_LOADER_RE, (match, attrsRaw = '') => {
    const attrs = attrsRaw || '';
    if (!/animate-spin/.test(attrs)) return match; // not a spinner, keep
    // Extract className value from a static double-quoted string only.
    const cnMatch = attrs.match(/className="([^"]*)"/);
    if (!cnMatch) return match; // dynamic className, leave for manual review
    const original = cnMatch[1];
    const size = pickSize(original);
    const remaining = stripSpinnerClasses(original);
    const sizeAttr = `size="${size}"`;
    const classAttr = remaining ? ` className="${remaining}"` : '';
    return `<ThinkingIndicator ${sizeAttr}${classAttr} />`;
  });
}

function ensureImport(source) {
  if (source.includes('@/components/ui/thinking-indicator')) return source;
  if (!source.includes('<ThinkingIndicator ')) return source;
  // Insert after the last existing import line.
  const importRe = /^import .+? from .+?;?\s*$/gm;
  let lastEnd = 0;
  let match;
  while ((match = importRe.exec(source)) !== null) lastEnd = match.index + match[0].length;
  if (lastEnd === 0) return source;
  return (
    source.slice(0, lastEnd)
    + '\nimport { ThinkingIndicator } from "@/components/ui/thinking-indicator"'
    + source.slice(lastEnd)
  );
}

function dropUnusedLoader2Import(source) {
  if (!/from\s+["']lucide-react["']/.test(source)) return source;
  // If Loader2 still appears in JSX (other than imports), keep it.
  const usageRe = /(?<!import\s\{[^}]*?)\bLoader2\b/;
  if (usageRe.test(source.replace(/import\s\{[^}]*\}\s*from\s*["']lucide-react["']/g, ''))) return source;
  return source.replace(/(import\s*\{[^}]*?)\bLoader2\b\s*,?\s*([^}]*\}\s*from\s*["']lucide-react["'])/g, (_m, pre, post) => {
    const cleaned = (pre + post)
      .replace(/,\s*,/g, ',')
      .replace(/\{\s*,/g, '{')
      .replace(/,\s*\}/g, '}')
      .replace(/\{\s*\}/g, '{}');
    return cleaned;
  })
  .replace(/^import\s*\{\s*\}\s*from\s*["']lucide-react["'];?\n?/gm, '');
}

function processFile(file) {
  const original = fs.readFileSync(file, 'utf8');
  let next = original;

  // Line-by-line transform (limits accidental cross-line matches).
  const lines = next.split('\n');
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    const before = lines[i];
    const after = transformLine(before);
    if (after !== before) {
      lines[i] = after;
      touched = true;
      if (VERBOSE) {
        console.log(`  ${path.relative(ROOT, file)}:${i + 1}`);
        console.log(`    -  ${before.trim()}`);
        console.log(`    +  ${after.trim()}`);
      }
    }
  }
  if (!touched) return false;

  next = lines.join('\n');
  next = ensureImport(next);
  next = dropUnusedLoader2Import(next);

  if (DRY_RUN) {
    console.log(`would update: ${path.relative(ROOT, file)}`);
  } else {
    fs.writeFileSync(file, next, 'utf8');
  }
  return true;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (EXTS.has(path.extname(entry.name))) yield full;
  }
}

let count = 0;
for (const sub of ROOTS) {
  const root = path.join(ROOT, sub);
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    if (file.endsWith('thinking-indicator.tsx')) continue;
    if (file.endsWith('thinking-bars-icon.tsx')) continue;
    if (processFile(file)) count++;
  }
}

console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}touched ${count} file(s).`);
