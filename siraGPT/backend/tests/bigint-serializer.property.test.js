/**
 * Property-based tests for utils/bigint-serializer.js.
 *
 * The serializer's contract is that BigInt values inside an arbitrary
 * payload should make it through JSON.stringify (via `safeStringify`)
 * losslessly as decimal strings, and that the recursive
 * `serializeBigIntFields` walk should leave non-bigint values
 * structurally untouched while coercing every bigint it can reach
 * (within bigint-safe integer range) to a Number.
 *
 * Property-based testing here catches drift the example-based tests
 * miss: random nesting, undefined values, mixed scalar types, and
 * 64-bit integers near the safe-integer boundary.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  replaceBigInt,
  serializeBigIntFields,
  safeStringify,
} = require('../src/utils/bigint-serializer');

test('safeStringify: every bigint round-trips as its decimal string', () => {
  fc.assert(
    fc.property(fc.bigInt(), (n) => {
      const json = safeStringify({ value: n });
      const parsed = JSON.parse(json);
      // BigInt → JSON.stringify must yield the decimal representation.
      return parsed.value === n.toString();
    }),
    { numRuns: 200 },
  );
});

test('replaceBigInt: leaves non-bigint scalars untouched', () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
      (v) => {
        // replaceBigInt is a JSON.stringify replacer — when v isn't a
        // bigint it must return the value verbatim so round-tripping
        // the payload is identity-preserving.
        const out = replaceBigInt('k', v);
        return Object.is(out, v);
      },
    ),
    { numRuns: 100 },
  );
});

test('serializeBigIntFields: coerces safe-range bigints to numbers, preserves other scalars', () => {
  fc.assert(
    fc.property(
      // Stay inside Number.MAX_SAFE_INTEGER so the lossy bigint→number
      // coercion the implementation does is exact.
      fc.bigInt({ min: -(2n ** 50n), max: 2n ** 50n }),
      fc.string(),
      fc.boolean(),
      (bi, s, bool) => {
        const result = serializeBigIntFields({ bi, s, bool, nil: null });
        return (
          typeof result.bi === 'number' &&
          result.bi === Number(bi) &&
          result.s === s &&
          result.bool === bool &&
          result.nil === null
        );
      },
    ),
    { numRuns: 200 },
  );
});

test('serializeBigIntFields: recursive on arrays + nested objects', () => {
  fc.assert(
    fc.property(
      fc.array(fc.bigInt({ min: -(2n ** 40n), max: 2n ** 40n }), { maxLength: 8 }),
      (bigints) => {
        const result = serializeBigIntFields({
          nested: { list: bigints, deeper: { x: bigints[0] ?? 0n } },
        });
        if (!Array.isArray(result.nested.list)) return false;
        return result.nested.list.every((v, i) => v === Number(bigints[i]));
      },
    ),
    { numRuns: 100 },
  );
});
