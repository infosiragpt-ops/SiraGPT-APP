'use strict';

/**
 * argv-parser — minimist-compatible argument parser. Pairs with the
 * env-loader (#58, env config) and graceful-shutdown (#59) to round
 * out the boot toolkit: scripts/* and the skill: CLI entry points
 * can use one stable shape without pulling commander/yargs.
 *
 * Public API:
 *   parseArgs(argv, opts)
 *     → { _: positionals, --: passthrough, ...flags }
 *
 *   opts: {
 *     boolean: ['debug', 'force'],
 *     string:  ['name'],
 *     alias:   { v: 'verbose', h: 'help' },
 *     default: { port: 3000 },
 *     stopEarly: false,            // stop parsing on first positional
 *     '--': false,                 // capture args after '--' in result['--']
 *   }
 *
 * Numbers and 'true'/'false' literals are auto-coerced unless the
 * key was explicitly declared as `string`. Repeated flags become
 * arrays. `--no-foo` sets `foo: false`. `-abc` expands to `-a -b -c`.
 */

function isNumberLike(s) {
  return typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s);
}

function coerce(v, key, opts) {
  if (opts.string && opts.string.includes(key)) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (isNumberLike(v)) return Number(v);
  return v;
}

function applyAlias(key, opts) {
  if (opts.alias && Object.prototype.hasOwnProperty.call(opts.alias, key)) return opts.alias[key];
  return key;
}

function setFlag(out, key, value) {
  if (Object.prototype.hasOwnProperty.call(out, key)) {
    const cur = out[key];
    out[key] = Array.isArray(cur) ? [...cur, value] : [cur, value];
  } else {
    out[key] = value;
  }
}

function parseArgs(argv, opts = {}) {
  if (!Array.isArray(argv)) throw new TypeError('argv-parser: argv must be array');
  const out = { _: [] };
  const passthrough = [];
  const captureDashDash = opts['--'] === true;
  if (captureDashDash) out['--'] = passthrough;
  const stopEarly = Boolean(opts.stopEarly);

  let i = 0;
  let afterDoubleDash = false;
  while (i < argv.length) {
    const a = argv[i];
    if (afterDoubleDash) { passthrough.push(a); i++; continue; }
    if (a === '--') { afterDoubleDash = true; i++; continue; }

    if (typeof a === 'string' && a.startsWith('--')) {
      // --key=value or --key value or --no-key
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        const key = applyAlias(body.slice(0, eq), opts);
        const v = coerce(body.slice(eq + 1), key, opts);
        setFlag(out, key, v);
      } else if (body.startsWith('no-')) {
        const key = applyAlias(body.slice(3), opts);
        setFlag(out, key, false);
      } else {
        const key = applyAlias(body, opts);
        const isBool = opts.boolean && opts.boolean.includes(key);
        const next = argv[i + 1];
        if (isBool || next === undefined || (typeof next === 'string' && next.startsWith('-') && !isNumberLike(next))) {
          setFlag(out, key, true);
        } else {
          setFlag(out, key, coerce(next, key, opts));
          i++;
        }
      }
      i++; continue;
    }

    if (typeof a === 'string' && a.startsWith('-') && a.length > 1 && !isNumberLike(a)) {
      // Short flag(s). '-abc' → -a -b -c (boolean), unless followed by '='.
      const body = a.slice(1);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        const key = applyAlias(body.slice(0, eq), opts);
        setFlag(out, key, coerce(body.slice(eq + 1), key, opts));
        i++; continue;
      }
      if (body.length === 1) {
        const key = applyAlias(body, opts);
        const isBool = opts.boolean && opts.boolean.includes(key);
        const next = argv[i + 1];
        if (isBool || next === undefined || (typeof next === 'string' && next.startsWith('-') && !isNumberLike(next))) {
          setFlag(out, key, true);
        } else {
          setFlag(out, key, coerce(next, key, opts));
          i++;
        }
      } else {
        for (const ch of body) setFlag(out, applyAlias(ch, opts), true);
      }
      i++; continue;
    }

    out._.push(a);
    if (stopEarly) {
      i++;
      while (i < argv.length) { out._.push(argv[i]); i++; }
      break;
    }
    i++;
  }

  // Defaults applied AFTER parsing — only fill keys the user didn't set.
  if (opts.default && typeof opts.default === 'object') {
    for (const [k, v] of Object.entries(opts.default)) {
      if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
    }
  }

  return out;
}

module.exports = {
  parseArgs,
};
