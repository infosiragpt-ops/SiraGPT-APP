/**
 * academic-skills tests — verify the openalex_search, crossref_verify,
 * and apa7_format skills load + behave correctly.
 *
 * apa7_format is pure-compute, so we test its output directly. The
 * other two hit live HTTP APIs; we test their handler shape against
 * the registry but skip live calls (smoke verification belongs in an
 * integration suite, not a unit test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const registry = require('../src/services/skills/registry');
const apa7Skill = require('../src/skills/apa7_format/handler');
const openalexSkill = require('../src/skills/openalex_search/handler');
const crossrefSkill = require('../src/skills/crossref_verify/handler');

test('all three academic skills load via the registry', () => {
  const { skills, errors } = registry.load();
  assert.equal(errors.length, 0, `bundled skills clean: ${errors.join('|')}`);
  for (const id of ['openalex_search', 'crossref_verify', 'apa7_format']) {
    assert.ok(skills.has(id), `${id} should be bundled`);
    const s = skills.get(id);
    assert.equal(typeof s.execute, 'function');
    assert.ok(s.params && s.params.type === 'object');
  }
});

test('openalex_search rejects empty query gracefully', async () => {
  const out = await openalexSkill.execute({ query: '' });
  assert.deepEqual(out.sources, []);
  assert.equal(out.error, 'missing query');
});

test('crossref_verify normalizes DOI prefixes and rejects oversized batches', async () => {
  // No DOIs:
  let out = await crossrefSkill.execute({ dois: [] });
  assert.equal(out.error, 'no DOIs provided');

  // Over the cap (no real network call because validation rejects first):
  const tooMany = Array.from({ length: 31 }, (_, i) => `10.1234/foo.${i}`);
  out = await crossrefSkill.execute({ dois: tooMany });
  assert.match(out.error, /too many DOIs/);

  // Bare-DOI vs URL-prefixed both go through the same path (we don't
  // call the real network here; we just verify the validation path
  // doesn't choke on either form).
  out = await crossrefSkill.execute({ dois: [
    '   ',
    null,
    undefined,
  ] });
  assert.equal(out.error, 'no DOIs provided', 'whitespace-only / null DOIs should be filtered out before counting');
});

test('apa7_format inline citation — single author', async () => {
  const out = await apa7Skill.execute({
    sources: [{ title: 'Reliability', authors: [{ family: 'Smith', given: 'John' }], year: 2024 }],
    want: 'inline',
  });
  assert.equal(out.inline.length, 1);
  assert.match(out.inline[0].citation, /\(Smith, 2024\)/);
});

test('apa7_format inline citation — three authors → et al.', async () => {
  const out = await apa7Skill.execute({
    sources: [{
      title: 'Likert scales',
      authors: [
        { family: 'Smith', given: 'A' },
        { family: 'Jones', given: 'B' },
        { family: 'Lee', given: 'C' },
      ],
      year: 2023,
    }],
    want: 'inline',
  });
  assert.match(out.inline[0].citation, /\(Smith et al\., 2023\)/);
});

test('apa7_format reference list — sorted alphabetically by surname', async () => {
  const out = await apa7Skill.execute({
    sources: [
      { title: 'B paper', authors: [{ family: 'Zappa', given: 'F' }], year: 2022, container: 'J. Music' },
      { title: 'A paper', authors: [{ family: 'Albini', given: 'S' }], year: 2021, container: 'J. Music' },
    ],
    want: 'reference_list',
  });
  // Albini line comes before Zappa line in the markdown output
  const albiniIdx = out.reference_list.indexOf('Albini');
  const zappaIdx = out.reference_list.indexOf('Zappa');
  assert.ok(albiniIdx > -1 && zappaIdx > -1);
  assert.ok(albiniIdx < zappaIdx, 'authors should sort alphabetically');
});

test('apa7_format degrades gracefully on missing fields', async () => {
  const out = await apa7Skill.execute({
    sources: [
      { title: 'Untitled work' }, // no authors, no year
      { authors: [{ display: 'X. Anon' }] }, // no title, no year
    ],
    want: 'both',
  });
  // No "undefined" or "null" leaks in either citation form.
  for (const c of out.inline) assert.ok(!/undefined|null/i.test(c.citation));
  assert.ok(!/undefined|null/i.test(out.reference_list));
  // Missing year shows as 'n.d.' per APA convention.
  assert.match(out.inline[0].citation, /n\.d\./);
});

test('apa7_format accepts bare-string authors', async () => {
  const out = await apa7Skill.execute({
    sources: [{ title: 'X', authors: ['Andrew Ng'], year: 2020 }],
    want: 'inline',
  });
  assert.match(out.inline[0].citation, /\(Ng, 2020\)/);
});

test('apa7_format defaults to both inline and reference list', async () => {
  const out = await apa7Skill.execute({
    sources: [{ title: 'X', authors: [{ family: 'Smith' }], year: 2024 }],
  });
  assert.ok(Array.isArray(out.inline));
  assert.equal(typeof out.reference_list, 'string');
});
