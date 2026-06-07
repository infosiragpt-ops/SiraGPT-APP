import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  createDefaultOutputValidator,
  extractJsonCandidate,
} from '../../server/intelligence/core/output-validator';

const schema = z.object({ name: z.string(), age: z.number() });

describe('intelligence/output-validator', () => {
  const v = createDefaultOutputValidator();

  it('extracts JSON from a fenced code block', () => {
    const r = v.validate('```json\n{"name":"Ana","age":30}\n```', schema);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, { name: 'Ana', age: 30 });
  });

  it('extracts JSON embedded in prose via balanced-brace walk', () => {
    const r = v.validate('Sure, here you go: {"name":"Bob","age":40} — done.', schema);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.name, 'Bob');
  });

  it('reports no_json when nothing parseable is present', () => {
    const r = v.validate('there is no json here', schema);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.kind, 'no_json');
  });

  it('reports parse_error for malformed JSON', () => {
    const r = v.validate('{"name": }', schema);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.kind, 'parse_error');
  });

  it('reports schema_error with specific issues', () => {
    const r = v.validate('{"name":"x","age":"not-a-number"}', schema);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.kind, 'schema_error');
      assert.ok((r.error.issues ?? []).some((i) => i.includes('age')));
    }
  });

  it('builds a repair prompt listing the issues', () => {
    const r = v.validate('{"name":"x"}', schema);
    if (!r.ok) {
      const prompt = v.repairPrompt('Return a person JSON', r.error);
      assert.ok(prompt.includes('Original request'));
      assert.ok(prompt.toLowerCase().includes('json'));
    }
  });

  it('extractJsonCandidate handles arrays', () => {
    assert.equal(extractJsonCandidate('[1,2,3]'), '[1,2,3]');
  });
});
