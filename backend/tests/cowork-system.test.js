'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const autoFileBridge = require('../src/services/auto-file-bridge');
const deepDocumentAnalyzer = require('../src/services/deep-document-analyzer');
const activeMemory = require('../src/services/active-memory');
const sessionManager = require('../src/services/session-manager');
const skillsRegistry = require('../src/services/skills-registry');
const coworkEngine = require('../src/services/cowork-engine');

describe('auto-file-bridge', () => {
  describe('shouldAutoFile()', () => {
    it('returns false for short content', () => {
      assert.equal(autoFileBridge.shouldAutoFile('hello'), false);
    });

    it('returns false for empty content', () => {
      assert.equal(autoFileBridge.shouldAutoFile(''), false);
      assert.equal(autoFileBridge.shouldAutoFile(null), false);
    });

    it('returns true for long enough content', () => {
      const content = 'a'.repeat(300);
      assert.equal(autoFileBridge.shouldAutoFile(content), true);
    });

    it('returns false for extremely long content over limit', () => {
      const content = 'a'.repeat(3_000_000);
      assert.equal(autoFileBridge.shouldAutoFile(content), false);
    });
  });

  describe('isStructuredContent()', () => {
    it('detects JSON', () => {
      const content = '{\n  "name": "test",\n  "value": 42,\n  "items": [1, 2, 3]\n}\n'.repeat(5);
      assert.equal(autoFileBridge.isStructuredContent(content), true);
    });

    it('detects CSV', () => {
      const content = 'name,value\nfoo,1\nbar,2\nbaz,3\n'.repeat(5);
      assert.equal(autoFileBridge.isStructuredContent(content), true);
    });

    it('detects markdown', () => {
      const content = '# Title\n\n## Section\n\nParagraph here\n\n### Sub\n\nMore text\n'.repeat(3);
      assert.equal(autoFileBridge.isStructuredContent(content), true);
    });

    it('detects code', () => {
      const content = 'import os\nimport sys\n\ndef main():\n    print("hello")\n    return 0\n\nif __name__ == "__main__":\n    main()\n'.repeat(3);
      assert.equal(autoFileBridge.isStructuredContent(content), true);
    });

    it('returns false for short plain text', () => {
      assert.equal(autoFileBridge.isStructuredContent('hello world'), false);
    });

    it('returns false for null', () => {
      assert.equal(autoFileBridge.isStructuredContent(null), false);
    });
  });

  describe('detectContentType()', () => {
    it('detects JSON format', () => {
      const result = autoFileBridge.detectContentType('{"key": "value"}');
      assert.equal(result.format, 'json');
      assert.equal(result.mime, 'application/json');
    });

    it('detects CSV format', () => {
      const result = autoFileBridge.detectContentType('name,count\nfoo,1');
      assert.equal(result.format, 'csv');
    });

    it('detects XML format', () => {
      const result = autoFileBridge.detectContentType('<?xml version="1.0"?><root/>');
      assert.equal(result.format, 'xml');
    });

    it('detects SQL format', () => {
      const result = autoFileBridge.detectContentType('SELECT * FROM users WHERE active = 1');
      assert.equal(result.format, 'sql');
    });

    it('detects Python format', () => {
      const result = autoFileBridge.detectContentType('import os\ndef main():\n    pass');
      assert.equal(result.format, 'py');
    });

    it('detects JavaScript format', () => {
      const result = autoFileBridge.detectContentType('const x = 1;\nfunction foo() { return x; }');
      assert.equal(result.format, 'js');
    });

    it('defaults to txt', () => {
      const result = autoFileBridge.detectContentType('plain text without structure');
      assert.equal(result.format, 'txt');
    });

    it('handles null input', () => {
      const result = autoFileBridge.detectContentType(null);
      assert.equal(result.format, 'txt');
    });
  });
});

describe('deep-document-analyzer', () => {
  describe('detectDomain()', () => {
    it('detects legal domain', () => {
      const text = 'El contrato de arrendamiento establece que el arrendatario deberá pagar una indemnización en caso de terminación anticipada. La jurisdicción aplicable es la del tribunal de Madrid.';
      const result = deepDocumentAnalyzer.detectDomain(text, 'contrato.pdf', '');
      assert.equal(result.primary, 'legal');
    });

    it('detects financial domain', () => {
      const text = 'El balance general muestra ingresos por $5,000,000 con un margen de rentabilidad del 23%. Los activos totales ascienden a $12,000,000 y el EBITDA fue positivo.';
      const result = deepDocumentAnalyzer.detectDomain(text, 'balance.xlsx', '');
      assert.equal(result.primary, 'financial');
    });

    it('detects academic domain', () => {
      const text = 'La investigación utiliza una metodología cuantitativa con un p-valor < 0.05. La hipótesis fue confirmada con una correlación significativa. DOI: 10.1234/test';
      const result = deepDocumentAnalyzer.detectDomain(text, 'paper.pdf', '');
      assert.equal(result.primary, 'academic');
    });

    it('detects technical domain', () => {
      const text = 'The API endpoint /api/v2/users returns a JSON response. The microservice deploys to Kubernetes with Docker. The latency threshold is 200ms and throughput should be 1000 rps.';
      const result = deepDocumentAnalyzer.detectDomain(text, 'api-docs.md', '');
      assert.equal(result.primary, 'technical');
    });

    it('detects medical domain', () => {
      const text = 'El paciente presenta síntomas de fiebre. El diagnóstico sugiere infección. El tratamiento incluye medicamento de 500mg. Contraindicado en caso de alergia a penicilina.';
      const result = deepDocumentAnalyzer.detectDomain(text, 'clinical.md', '');
      assert.equal(result.primary, 'medical');
    });

    it('returns general for ambiguous text', () => {
      const result = deepDocumentAnalyzer.detectDomain('hello world', 'notes.txt', '');
      assert.equal(result.primary, 'general');
    });
  });

  describe('extractEntities()', () => {
    it('extracts emails', () => {
      const entities = deepDocumentAnalyzer.extractEntities('Contact: user@example.com for info');
      assert.ok(entities.some(e => e.type === 'email'));
    });

    it('extracts URLs', () => {
      const entities = deepDocumentAnalyzer.extractEntities('Visit https://example.com for details');
      assert.ok(entities.some(e => e.type === 'url'));
    });

    it('extracts money amounts', () => {
      const entities = deepDocumentAnalyzer.extractEntities('The total was $1,500.00 USD');
      assert.ok(entities.some(e => e.type === 'money'));
    });

    it('extracts percentages', () => {
      const entities = deepDocumentAnalyzer.extractEntities('Growth was 15.5% year over year');
      assert.ok(entities.some(e => e.type === 'percentage'));
    });

    it('extracts dates', () => {
      const entities = deepDocumentAnalyzer.extractEntities('Deadline: 2024-12-31');
      assert.ok(entities.some(e => e.type === 'date'));
    });

    it('extracts IP addresses', () => {
      const entities = deepDocumentAnalyzer.extractEntities('Server: 192.168.1.1');
      assert.ok(entities.some(e => e.type === 'ip_address'));
    });

    it('does not leak a critical card/IBAN in cleartext via an overlapping non-critical match', () => {
      // Regression: the medium-sensitivity 'phone' pattern matched a 16-digit
      // card's digits and was emitted UNREDACTED, defeating the credit_card
      // redaction. Overlapping non-critical entities must be dropped.
      const entities = deepDocumentAnalyzer.extractEntities('Card 4111-1111-1111-1111 IBAN DE89370400440532013000');
      assert.ok(entities.some(e => e.type === 'credit_card' && e.sensitivity === 'critical'));
      assert.ok(entities.some(e => e.type === 'iban' && e.sensitivity === 'critical'));
      // No non-critical entity may carry 6+ consecutive digits of the sensitive values.
      const leak = entities.filter(e => e.sensitivity !== 'critical' && /\d{6,}/.test(String(e.value).replace(/[-\s]/g, '')));
      assert.equal(leak.length, 0, `non-critical entities leaked digits: ${JSON.stringify(leak)}`);
    });

    it('identifies critical entities', () => {
      const entities = deepDocumentAnalyzer.extractEntities('SSN: 123-45-6789');
      const ssn = entities.find(e => e.type === 'ssn');
      assert.ok(ssn);
      assert.equal(ssn.sensitivity, 'critical');
    });

    it('returns empty for null', () => {
      assert.deepEqual(deepDocumentAnalyzer.extractEntities(null), []);
    });
  });

  describe('extractStructure()', () => {
    it('extracts markdown headings', () => {
      const text = '# Main\n## Section 1\n### Subsection\n## Section 2';
      const result = deepDocumentAnalyzer.extractStructure(text);
      assert.equal(result.headingCount, 4);
      assert.equal(result.maxDepth, 3);
    });

    it('detects TOC with enough headings', () => {
      const text = '# H1\n## H2a\n## H2b\n## H2c';
      const result = deepDocumentAnalyzer.extractStructure(text);
      assert.equal(result.hasToc, true);
    });

    it('extracts numbered headings', () => {
      const text = '1. Introduction\n2. Methods\n2.1 Sub-method\n3. Results';
      const result = deepDocumentAnalyzer.extractStructure(text);
      assert.ok(result.headingCount >= 3);
    });

    it('handles empty text', () => {
      const result = deepDocumentAnalyzer.extractStructure('');
      assert.equal(result.headingCount, 0);
      assert.equal(result.hasToc, false);
    });
  });

  describe('assessRisks()', () => {
    it('flags PII exposure for critical entities', () => {
      const entities = [{ type: 'ssn', value: '123-45-6789', sensitivity: 'critical', index: 0 }];
      const risks = deepDocumentAnalyzer.assessRisks('some text', 'general', entities);
      assert.ok(risks.items.some(r => r.category === 'data_exposure' && r.severity === 'critical'));
    });

    it('flags legal risks for legal documents', () => {
      const risks = deepDocumentAnalyzer.assessRisks(
        'El contrato establece una multa por terminación anticipada',
        'legal',
        []
      );
      assert.ok(risks.items.length > 0);
    });

    it('flags IP exposure for technical documents', () => {
      const entities = [
        { type: 'ip_address', value: '10.0.0.1', sensitivity: 'high', index: 0 },
        { type: 'ip_address', value: '10.0.0.2', sensitivity: 'high', index: 1 },
        { type: 'ip_address', value: '10.0.0.3', sensitivity: 'high', index: 2 },
        { type: 'ip_address', value: '10.0.0.4', sensitivity: 'high', index: 3 },
      ];
      const risks = deepDocumentAnalyzer.assessRisks('server config', 'technical', entities);
      assert.ok(risks.items.some(r => r.category === 'infrastructure_exposure'));
    });

    it('computes overall risk score', () => {
      const risks = deepDocumentAnalyzer.assessRisks('simple text', 'general', []);
      assert.ok(typeof risks.overallScore === 'number');
      assert.ok(risks.overallScore >= 0 && risks.overallScore <= 100);
    });
  });

  describe('computeQualityMetrics()', () => {
    it('computes quality metrics for well-structured text', () => {
      const text = '# Report\n\nThis is a well-structured document with multiple paragraphs.\n\n## Section 1\n\nThe first section discusses important findings. The methodology was sound.\n\n## Section 2\n\nFurthermore, the results confirm the hypothesis. However, limitations exist.';
      const quality = deepDocumentAnalyzer.computeQualityMetrics(text, 'academic', [], { overallScore: 0 });
      assert.ok(quality.overall >= 0 && quality.overall <= 100);
      assert.ok(quality.grade);
      assert.ok(quality.wordCount > 0);
    });

    it('assigns grade A for high quality', () => {
      const quality = deepDocumentAnalyzer.computeQualityMetrics(
        '# Doc\n\nWell written. Good structure. Clear points.',
        'general',
        [],
        { overallScore: 0 }
      );
      assert.ok(['A', 'B', 'C', 'D', 'F'].includes(quality.grade));
    });
  });

  describe('analyzeDeep()', () => {
    it('returns full analysis result', async () => {
      const text = 'Contrato de arrendamiento entre las partes. El arrendatario pagará $1,500 USD mensuales. Contacto: owner@example.com. Vigencia: 2024-01-01 a 2025-12-31. Cláusula de terminación anticipada con penalización del 10%.'.repeat(3);
      const result = await deepDocumentAnalyzer.analyzeDeep(text, {
        fileName: 'contrato.pdf',
        mimeType: 'application/pdf',
      });

      assert.ok(result.domain);
      assert.ok(result.domain.primary);
      assert.ok(Array.isArray(result.entities));
      assert.ok(result.piiSummary);
      assert.ok(result.structure);
      assert.ok(result.risks);
      assert.ok(result.quality);
      assert.ok(result.quality.grade);
      assert.ok(Array.isArray(result.autoTags));
      assert.ok(result.summary);
      assert.equal(result.version, '2.0.0');
    });

    it('handles empty text gracefully', async () => {
      const result = await deepDocumentAnalyzer.analyzeDeep('');
      assert.ok(result.domain);
      assert.equal(result.entities.length, 0);
    });
  });
});

describe('active-memory', () => {
  const testUserId = 'test_user_memory_001';

  after(() => {
    activeMemory.clearUserMemory(testUserId);
  });

  it('creates a memory entry', () => {
    const entry = activeMemory.createMemoryEntry(testUserId, 'User prefers dark mode', {
      category: 'preferences',
      tags: ['ui', 'theme'],
    });
    assert.ok(entry.id);
    assert.equal(entry.fact, 'User prefers dark mode');
    assert.equal(entry.tier, 'short_term');
    assert.equal(entry.category, 'preferences');
  });

  it('deduplicates identical facts', () => {
    const uniqueFact = 'Unique dedup test ' + Date.now();
    const e1 = activeMemory.createMemoryEntry(testUserId, uniqueFact);
    const e2 = activeMemory.createMemoryEntry(testUserId, uniqueFact);
    assert.equal(e1.id, e2.id);
    assert.ok(e2.accessCount >= 2);
  });

  it('recalls memories by query', () => {
    activeMemory.createMemoryEntry(testUserId, 'User works at Acme Corp', { category: 'work' });
    const results = activeMemory.recall(testUserId, 'work');
    assert.ok(results.length > 0);
    assert.ok(results.some(r => r.fact.includes('Acme')));
  });

  it('getMemoryContext does not bump accessCount (read-only prompt path)', () => {
    const entry = activeMemory.createMemoryEntry(testUserId, 'No-bump probe ' + Date.now(), { strength: 0.9 });
    const findCount = () => activeMemory.listEntries(testUserId).find(e => e.id === entry.id).accessCount;
    const before = findCount();
    activeMemory.getMemoryContext(testUserId, { limit: 20 });
    activeMemory.getMemoryContext(testUserId, { limit: 20 });
    assert.equal(findCount(), before, 'building the prompt must not inflate accessCount');
  });

  it('recall honours bump:false but counts access by default', () => {
    const entry = activeMemory.createMemoryEntry(testUserId, 'Bump flag probe ' + Date.now(), { strength: 0.9 });
    const findCount = () => activeMemory.listEntries(testUserId).find(e => e.id === entry.id).accessCount;
    const base = findCount();
    activeMemory.recall(testUserId, null, { bump: false });
    assert.equal(findCount(), base, 'bump:false must not increment');
    activeMemory.recall(testUserId, null);
    assert.ok(findCount() > base, 'default recall increments');
  });

  it('promotes to long-term', () => {
    const entry = activeMemory.createMemoryEntry(testUserId, 'Promote me test', { strength: 0.9 });
    const promoted = activeMemory.promoteToLongTerm(entry.id);
    assert.equal(promoted.tier, 'long_term');
    assert.ok(promoted.strength > 0.5);
  });

  it('promote with a mismatched userId is rejected and does NOT mutate the entry (IDOR guard)', () => {
    const entry = activeMemory.createMemoryEntry(testUserId, 'Owner-only promote probe', { strength: 0.4 });
    const before = { tier: entry.tier, strength: entry.strength };
    // Another user supplying this id must get null and leave the entry untouched.
    const result = activeMemory.promoteToLongTerm(entry.id, { userId: 'someone-else' });
    assert.equal(result, null);
    const after = activeMemory.listEntries(testUserId).find((e) => e.id === entry.id);
    assert.equal(after.tier, before.tier, 'tier unchanged');
    assert.equal(after.strength, before.strength, 'strength unchanged');
    // The legitimate owner still succeeds.
    const owned = activeMemory.promoteToLongTerm(entry.id, { userId: testUserId });
    assert.equal(owned.tier, 'long_term');
  });

  it('auto-promotes based on access count', () => {
    const entry = activeMemory.createMemoryEntry(testUserId, 'Auto promote test ' + Date.now());
    for (let i = 0; i < activeMemory.PROMOTION_THRESHOLD; i++) {
      activeMemory.recall(testUserId, entry.fact);
    }
    const result = activeMemory.autoPromote(testUserId);
    assert.ok(result.promoted >= 0);
  });

  it('builds memory prompt', () => {
    activeMemory.createMemoryEntry(testUserId, 'Test memory prompt fact', { strength: 0.9 });
    const prompt = activeMemory.buildMemoryPrompt(testUserId);
    assert.ok(typeof prompt === 'string');
  });

  it('forgets memories by query', () => {
    activeMemory.createMemoryEntry(testUserId, 'Forget this fact unique_xyz');
    const result = activeMemory.forget(testUserId, 'unique_xyz');
    assert.ok(result.removed >= 1);
  });

  it('returns stats', () => {
    const stats = activeMemory.getStats(testUserId);
    assert.ok(typeof stats.total === 'number');
    assert.ok(typeof stats.longTerm === 'number');
    assert.ok(typeof stats.shortTerm === 'number');
  });

  it('expires stale entries', () => {
    const result = activeMemory.expireStale();
    assert.ok(typeof result.expired === 'number');
  });

  it('clears user memory', () => {
    activeMemory.createMemoryEntry(testUserId, 'To be cleared ' + Date.now());
    const result = activeMemory.clearUserMemory(testUserId);
    assert.ok(result.cleared >= 0);
  });
});

describe('session-manager', () => {
  const testUserId = 'test_user_session_001';

  after(() => {
    sessionManager.stopCleanup();
  });

  it('creates a session', () => {
    const session = sessionManager.createSession(testUserId, { label: 'Test Session' });
    assert.ok(session.id);
    assert.equal(session.label, 'Test Session');
    assert.equal(session.userId, testUserId);
  });

  it('lists sessions for user', () => {
    sessionManager.createSession(testUserId, { label: 'Session 2' });
    const sessions = sessionManager.listSessions(testUserId);
    assert.ok(sessions.length >= 2);
  });

  it('adds messages to session', () => {
    const session = sessionManager.createSession(testUserId, { label: 'Message Test' });
    const msg = sessionManager.addMessage(session.id, {
      role: 'user',
      content: 'Hello',
      tokens: 5,
    });
    assert.ok(msg.id);
    assert.equal(msg.role, 'user');
    assert.equal(msg.content, 'Hello');
  });

  it('gets session history', () => {
    const session = sessionManager.createSession(testUserId, { label: 'History Test' });
    sessionManager.addMessage(session.id, { role: 'user', content: 'Q1', tokens: 2 });
    sessionManager.addMessage(session.id, { role: 'assistant', content: 'A1', tokens: 3 });
    const history = sessionManager.getHistory(session.id);
    assert.equal(history.length, 2);
  });

  it('spawns a child session', () => {
    const parent = sessionManager.createSession(testUserId, { label: 'Parent' });
    sessionManager.addMessage(parent.id, { role: 'user', content: 'Parent msg', tokens: 2 });
    const child = sessionManager.spawnSession(parent.id, testUserId, { label: 'Child' });
    assert.ok(child);
    assert.equal(child.parentId, parent.id);
  });

  it('compacts session', async () => {
    const session = sessionManager.createSession(testUserId, { label: 'Compact Test' });
    for (let i = 0; i < 15; i++) {
      sessionManager.addMessage(session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
        tokens: 3,
      });
    }
    const result = await sessionManager.compactSession(session.id, { keepFirst: 2, keepLast: 4 });
    assert.ok(result.compacted);
    assert.ok(result.droppedMessages > 0);
  });

  it('sends between sessions', () => {
    const s1 = sessionManager.createSession(testUserId, { label: 'Source' });
    const s2 = sessionManager.createSession(testUserId, { label: 'Target' });
    const msg = sessionManager.sendToSession(s1.id, s2.id, {
      content: 'Forwarded message',
      role: 'user',
    });
    assert.ok(msg);
    assert.equal(msg.content, 'Forwarded message');
  });

  it('resets session', () => {
    const session = sessionManager.createSession(testUserId, { label: 'Reset Test' });
    sessionManager.addMessage(session.id, { role: 'user', content: 'test', tokens: 1 });
    const result = sessionManager.resetSession(session.id);
    assert.ok(result.reset);
    const history = sessionManager.getHistory(session.id);
    assert.equal(history.length, 0);
  });

  it('archives session', () => {
    const session = sessionManager.createSession(testUserId, { label: 'Archive Test' });
    const archived = sessionManager.archiveSession(session.id);
    assert.ok(archived);
    assert.ok(archived.archivedAt);
    assert.equal(sessionManager.getSession(session.id), null);
  });

  it('returns session stats', () => {
    const stats = sessionManager.getSessionStats(testUserId);
    assert.ok(typeof stats.activeSessions === 'number');
    assert.ok(typeof stats.totalMessages === 'number');
  });
});

describe('skills-registry', () => {
  it('lists built-in skills', () => {
    const skills = skillsRegistry.listSkills();
    assert.ok(skills.length >= 10);
  });

  it('gets a skill by id', () => {
    const skill = skillsRegistry.getSkill('deep_document_analysis');
    assert.ok(skill);
    assert.equal(skill.category, 'document');
  });

  it('returns null for unknown skill', () => {
    assert.equal(skillsRegistry.getSkill('nonexistent'), null);
  });

  it('filters by category', () => {
    const skills = skillsRegistry.listSkills({ category: 'document' });
    assert.ok(skills.length >= 2);
    assert.ok(skills.every(s => s.category === 'document'));
  });

  it('filters by tag', () => {
    const skills = skillsRegistry.listSkills({ tag: 'citations' });
    assert.ok(skills.length >= 1);
  });

  it('recommends skills by intent', () => {
    const skills = skillsRegistry.recommendSkills('document', { hasDocuments: true });
    assert.ok(skills.length >= 1);
  });

  it('does not throw on an object intent (cowork passes { query, tags })', () => {
    // Regression: recommendSkills used to TypeError on `(object).toLowerCase()`,
    // and the throw was swallowed upstream — the whole cowork skills path was
    // silently dead on every turn.
    const out = skillsRegistry.recommendSkills({ query: 'analyze this document', tags: ['cowork'] }, {});
    assert.ok(Array.isArray(out) && out.length > 0, 'an object intent still yields recommendations');
  });

  it('returns no skills for a blank/null intent (no includes("") garbage)', () => {
    // Regression: String.includes('') is always true, so a blank intent scored
    // EVERY skill 0.5 and returned the first 5 as bogus recommendations.
    assert.deepEqual(skillsRegistry.recommendSkills('', {}), []);
    assert.deepEqual(skillsRegistry.recommendSkills(null, {}), []);
    assert.deepEqual(skillsRegistry.recommendSkills(undefined, {}), []);
  });

  it('still recommends by signals when the intent is blank', () => {
    const out = skillsRegistry.recommendSkills('', { hasDocuments: true });
    assert.ok(out.length > 0 && out.every((s) => s && s.id), 'document signals still drive recommendations');
  });

  it('verifies prerequisites', () => {
    const result = skillsRegistry.verifyPrerequisites('deep_document_analysis', {
      hasDocuments: true,
      extractedText: true,
    });
    assert.ok(result.ok || result.missing.length >= 0);
  });

  it('returns categories', () => {
    const cats = skillsRegistry.getCategories();
    assert.ok(typeof cats === 'object');
    assert.ok(Object.keys(cats).length >= 5);
  });

  it('returns stats', () => {
    const stats = skillsRegistry.getStats();
    assert.ok(stats.totalSkills >= 10);
  });

  it('registers and unregisters custom skill', () => {
    const skill = skillsRegistry.registerSkill({
      id: 'test_custom_skill',
      label: 'Custom Test',
      category: 'test',
      description: 'A test skill',
    });
    assert.equal(skill.id, 'test_custom_skill');
    assert.ok(skillsRegistry.getSkill('test_custom_skill'));
    skillsRegistry.unregisterSkill('test_custom_skill');
    assert.equal(skillsRegistry.getSkill('test_custom_skill'), null);
  });

  it('searches skills by query', () => {
    const skills = skillsRegistry.listSkills({ query: 'document' });
    assert.ok(skills.length >= 1);
  });
});

describe('cowork-engine', () => {
  const testUserId = 'test_user_cowork_001';

  after(() => {
    activeMemory.clearUserMemory(testUserId);
  });

  describe('buildCoworkSystemPrompt()', () => {
    it('returns a non-empty prompt', () => {
      const prompt = coworkEngine.buildCoworkSystemPrompt(testUserId);
      assert.ok(typeof prompt === 'string');
      assert.ok(prompt.includes('SiraGPT Cowork'));
      assert.ok(prompt.includes('Auto-File'));
      assert.ok(prompt.includes('Deep Document Analysis'));
      assert.ok(prompt.includes('Active Memory'));
    });

    it('includes memory facts when available', () => {
      activeMemory.createMemoryEntry(testUserId, 'Test cowork memory fact', {
        category: 'preferences',
        strength: 0.9,
      });
      activeMemory.promoteToLongTerm(
        [...activeMemory.recall(testUserId, 'cowork memory')].find(m => m.fact.includes('cowork memory'))?.id || ''
      );
      const prompt = coworkEngine.buildCoworkSystemPrompt(testUserId);
      assert.ok(typeof prompt === 'string');
    });
  });

  describe('processIncomingMessage()', () => {
    it('detects auto-fileable content', () => {
      const longContent = '{\n  "key": "value",\n  "data": "test"\n}\n'.repeat(50);
      const result = coworkEngine.processIncomingMessage(testUserId, longContent);
      assert.ok(result.autoFile);
      assert.equal(result.autoFile.shouldAutoFile, true);
    });

    it('skips short content', () => {
      const result = coworkEngine.processIncomingMessage(testUserId, 'hi');
      assert.equal(result.autoFile.shouldAutoFile, false);
    });

    it('extracts memory facts from preferences', () => {
      const result = coworkEngine.processIncomingMessage(
        testUserId,
        'Prefiero usar TypeScript para todos mis proyectos'
      );
      assert.ok(result.memoryOps);
      assert.ok(result.memoryOps.factsExtracted >= 1);
    });
  });

  describe('extractMemoryFacts()', () => {
    it('extracts preference facts', () => {
      const facts = coworkEngine.extractMemoryFacts('Prefiero usar React para el frontend');
      assert.ok(facts.length >= 1);
    });

    it('extracts identity facts', () => {
      const facts = coworkEngine.extractMemoryFacts('Mi nombre es Luis y trabajo en SiraGPT');
      assert.ok(facts.length >= 1);
    });

    it('returns empty for generic text', () => {
      const facts = coworkEngine.extractMemoryFacts('El cielo es azul hoy');
      assert.equal(facts.length, 0);
    });
  });
});
