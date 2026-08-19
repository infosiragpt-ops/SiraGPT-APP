/**
 * Tests for the OTel sampler resolver in services/observability/otel.js.
 *
 * The sampler instances themselves come from @opentelemetry/sdk-trace-base
 * and have well-defined `shouldSample` semantics, so we verify wiring +
 * env parsing rather than re-testing the sampler implementations.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveSampler } = require('../src/services/observability/otel');

describe('resolveSampler', () => {
  it('defaults to parent_based always_on with ratio 1', () => {
    const out = resolveSampler({});
    assert.equal(out.kind, 'parentbased_always_on');
    assert.equal(out.ratio, 1);
    assert.ok(out.sampler && typeof out.sampler.shouldSample === 'function');
  });

  it('honours always_off', () => {
    const out = resolveSampler({ OTEL_TRACES_SAMPLER: 'always_off' });
    assert.equal(out.kind, 'always_off');
    assert.equal(out.ratio, 0);
    assert.ok(out.sampler);
  });

  it('clamps ratio for traceidratio', () => {
    const high = resolveSampler({
      OTEL_TRACES_SAMPLER: 'traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '7',
    });
    assert.equal(high.ratio, 1);

    const low = resolveSampler({
      OTEL_TRACES_SAMPLER: 'traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '-3',
    });
    assert.equal(low.ratio, 0);

    const mid = resolveSampler({
      OTEL_TRACES_SAMPLER: 'traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0.25',
    });
    assert.equal(mid.kind, 'traceidratio');
    assert.equal(mid.ratio, 0.25);
  });

  it('parentbased_traceidratio inherits ratio', () => {
    const out = resolveSampler({
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0.1',
    });
    assert.equal(out.kind, 'parentbased_traceidratio');
    assert.equal(out.ratio, 0.1);
    assert.ok(out.sampler);
  });

  it('falls back to default for unknown sampler names', () => {
    const out = resolveSampler({ OTEL_TRACES_SAMPLER: 'nonsense' });
    assert.equal(out.kind, 'parentbased_always_on');
  });
});
