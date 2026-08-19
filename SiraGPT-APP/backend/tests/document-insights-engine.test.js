'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-insights-engine');
const {
  extractDocumentInsights,
  renderInsightsBlock,
  buildInsightsForFiles,
} = engine;

test('extractDocumentInsights: returns empty report for empty input', () => {
  const r = extractDocumentInsights('');
  assert.deepEqual(r.entities.persons, []);
  assert.deepEqual(r.entities.organizations, []);
  assert.deepEqual(r.numbers.money, []);
  assert.equal(r.metrics.words, 0);
});

test('extractDocumentInsights: tolerates non-string input', () => {
  const r = extractDocumentInsights(null);
  assert.equal(r.metrics.words, 0);
  assert.deepEqual(r.actionItems, []);
});

test('extractEntities: detects titled persons', () => {
  const text = 'En la reunión asistieron Dr. Carlos Pérez y Sra. Laura Quispe del comité.';
  const r = extractDocumentInsights(text);
  assert.ok(r.entities.persons.some(p => p.includes('Carlos Pérez')), `expected Carlos Pérez in ${JSON.stringify(r.entities.persons)}`);
  assert.ok(r.entities.persons.some(p => p.includes('Laura Quispe')));
});

test('extractEntities: detects organizations with corporate suffix', () => {
  const text = 'El contrato es entre Acme Corp. y Globex Inc. El proveedor es ServiHub LLC, basado en Lima.';
  const r = extractDocumentInsights(text);
  assert.ok(r.entities.organizations.some(o => /Acme Corp/.test(o)));
  assert.ok(r.entities.organizations.some(o => /Globex Inc/.test(o)));
});

test('extractContacts: extracts urls, emails, phones', () => {
  const text = 'Para más info visita https://example.com/api o escribe a soporte@example.com. Llama al +51 999 888 777.';
  const r = extractDocumentInsights(text);
  assert.ok(r.contacts.urls.some(u => u.includes('example.com')));
  assert.ok(r.contacts.emails.includes('soporte@example.com'));
  assert.ok(r.contacts.phones.length >= 1);
});

test('extractDates: detects ISO and named dates', () => {
  const text = 'La fecha límite es 2026-05-30. La sesión inicia el 15 de junio de 2026 a las 10:00.';
  const r = extractDocumentInsights(text);
  assert.ok(r.dates.absolute.includes('2026-05-30'));
  assert.ok(r.dates.absolute.some(d => /15\s+de\s+junio\s+de\s+2026/i.test(d)));
});

test('extractDates: detects relative time markers', () => {
  const text = 'Vamos a entregarlo esta semana y la siguiente tarea es el próximo mes.';
  const r = extractDocumentInsights(text);
  assert.ok(r.dates.relative.length >= 1);
});

test('extractKeyNumbers: detects monetary amounts and percentages', () => {
  const text = 'El presupuesto es de $1,200,000 USD y el margen objetivo es 18.5% YoY. Total: 12,000 EUR.';
  const r = extractDocumentInsights(text);
  assert.ok(r.numbers.money.length >= 2, `expected money entries, got ${JSON.stringify(r.numbers.money)}`);
  assert.ok(r.numbers.percentages.some(p => p.includes('18.5')));
});

test('extractActionItems: picks up TODO bullets', () => {
  const text = `
- TODO: Revisar el contrato con legal
- ACCIÓN: Enviar la propuesta al cliente
- FIXME: corregir validación en submitForm()`.trim();
  const r = extractDocumentInsights(text);
  assert.ok(r.actionItems.length >= 2, `got ${JSON.stringify(r.actionItems)}`);
});

test('extractActionItems: picks up "we will/we must" phrasing', () => {
  const text = 'We will deliver the dashboard by Friday. The team must validate the SLA before launch.';
  const r = extractDocumentInsights(text);
  assert.ok(r.actionItems.length >= 1, `got ${JSON.stringify(r.actionItems)}`);
});

test('extractQuestions: collects in-document questions', () => {
  const text = '¿Qué pasaría si triplicamos los nodos? ¿Cuál es el costo proyectado del clúster?';
  const r = extractDocumentInsights(text);
  assert.ok(r.questions.length >= 2, `got ${JSON.stringify(r.questions)}`);
});

test('extractRisks: detects risk-language sentences', () => {
  const text = 'Existe un riesgo crítico de exposición de datos si no aplicamos el patch antes del 30 de mayo. Risk: vendor lock-in puede causar fragilidad.';
  const r = extractDocumentInsights(text);
  assert.ok(r.risks.length >= 1, `got ${JSON.stringify(r.risks)}`);
});

test('extractClaims: detects conclusion-style sentences', () => {
  const text = 'Nuestros resultados muestran una mejora del 23% en latencia. Therefore, the new architecture should be adopted.';
  const r = extractDocumentInsights(text);
  assert.ok(r.claims.length >= 1, `got ${JSON.stringify(r.claims)}`);
});

test('computeContentMetrics: returns sane stats for prose', () => {
  const text = 'Lorem ipsum dolor sit amet. Consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
  const r = extractDocumentInsights(text);
  assert.ok(r.metrics.words >= 15);
  assert.ok(r.metrics.sentences >= 2);
  assert.ok(r.metrics.readingMinutes >= 1);
});

test('renderInsightsBlock: includes section headers when data exists', () => {
  const text = 'Dr. Ana López revisará el contrato con Acme Corp. La fecha límite es 2026-05-30 y el presupuesto es $50,000 USD. ¿Qué pasa si no se firma a tiempo?';
  const report = extractDocumentInsights(text);
  const block = renderInsightsBlock(report);
  assert.match(block, /## EXTRACTED INSIGHTS/);
  assert.match(block, /Named entities/);
  assert.match(block, /Key numbers/);
  assert.match(block, /Dates/);
  assert.match(block, /Open questions/);
});

test('renderInsightsBlock: handles empty report gracefully', () => {
  const report = extractDocumentInsights('');
  const block = renderInsightsBlock(report);
  assert.match(block, /## EXTRACTED INSIGHTS/);
  // No section headers when nothing found
  assert.doesNotMatch(block, /Named entities/);
  assert.doesNotMatch(block, /Key numbers/);
});

test('renderInsightsBlock: includes file label when provided', () => {
  const report = extractDocumentInsights('Hola mundo');
  const block = renderInsightsBlock(report, { fileLabel: 'demo.txt' });
  assert.match(block, /demo\.txt/);
});

test('buildInsightsForFiles: produces per-file and aggregate reports', () => {
  const files = [
    { originalName: 'memo.txt', extractedText: 'Carlos Pérez revisará la propuesta. Presupuesto: $25,000 USD. Fecha: 2026-06-01.' },
    { originalName: 'plan.md', extractedText: 'Acme Corp y Globex Inc colaboran. Fecha límite: 2026-06-15. Riesgo: dependencia del proveedor.' },
  ];
  const out = buildInsightsForFiles(files);
  assert.equal(out.perFile.length, 2);
  assert.equal(out.perFile[0].file, 'memo.txt');
  assert.equal(out.perFile[1].file, 'plan.md');
  // Aggregate should contain entities from both
  assert.ok(out.aggregate.entities.organizations.some(o => /Acme/.test(o)));
  assert.ok(out.aggregate.entities.persons.some(p => /Carlos/.test(p)));
});

test('buildInsightsForFiles: skips files without extractable text', () => {
  const files = [
    { originalName: 'a.txt', extractedText: '' },
    { originalName: 'b.txt', extractedText: 'Algún contenido con $1,000 USD.' },
    { originalName: 'c.txt' },
  ];
  const out = buildInsightsForFiles(files);
  assert.equal(out.perFile.length, 1);
  assert.equal(out.perFile[0].file, 'b.txt');
});

test('buildInsightsForFiles: returns empty result for non-array input', () => {
  const out = buildInsightsForFiles(null);
  assert.deepEqual(out.perFile, []);
});

test('extractor caps results to per-type maximums', () => {
  // Many distinct money mentions to verify capping
  const lines = Array.from({ length: 30 }, (_, i) => `Item ${i + 1}: $${1000 + i * 13}`);
  const text = lines.join('\n');
  const r = extractDocumentInsights(text);
  assert.ok(r.numbers.money.length <= 16, `expected ≤16 money entries (cap), got ${r.numbers.money.length}`);
});

// ─── Technical identifiers ──────────────────────────────────────────────

test('extractIdentifiers: detects IPv4 addresses', () => {
  const text = 'The router at 192.168.1.1 forwards to 10.0.0.42. Avoid pinging 8.8.8.8 from production.';
  const r = extractDocumentInsights(text);
  assert.ok(r.identifiers.ipv4.includes('192.168.1.1'));
  assert.ok(r.identifiers.ipv4.includes('10.0.0.42'));
  assert.ok(r.identifiers.ipv4.includes('8.8.8.8'));
});

test('extractIdentifiers: rejects invalid IPv4 octets', () => {
  const text = 'Version 1.2.3.4-rc.5 was released. 999.999.999.999 is not a valid IP.';
  const r = extractDocumentInsights(text);
  // 1.2.3.4 is technically a valid IP and will be detected — that's expected.
  // The strict check is that 999.999.999.999 should NOT be detected.
  assert.ok(!r.identifiers.ipv4.includes('999.999.999.999'));
});

test('extractIdentifiers: detects MAC addresses', () => {
  const text = 'Device MAC: 00:1A:2B:3C:4D:5E reported online. Backup: aa-bb-cc-dd-ee-ff.';
  const r = extractDocumentInsights(text);
  assert.equal(r.identifiers.macAddresses.length, 2);
  assert.ok(r.identifiers.macAddresses.some(m => /00:1A:2B:3C:4D:5E/i.test(m)));
});

test('extractIdentifiers: detects UUIDs', () => {
  const text = 'Order id 550e8400-e29b-41d4-a716-446655440000 created. Trace 6BA7B810-9DAD-11D1-80B4-00C04FD430C8.';
  const r = extractDocumentInsights(text);
  assert.equal(r.identifiers.uuids.length, 2);
});

test('extractIdentifiers: detects MD5/SHA-1/SHA-256 hashes by length', () => {
  const md5 = 'd41d8cd98f00b204e9800998ecf8427e';
  const sha1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
  const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const text = `Files matched: MD5=${md5}, SHA-1=${sha1}, SHA-256=${sha256}.`;
  const r = extractDocumentInsights(text);
  assert.ok(r.identifiers.hashes.md5.includes(md5));
  assert.ok(r.identifiers.hashes.sha1.includes(sha1));
  assert.ok(r.identifiers.hashes.sha256.includes(sha256));
});

test('extractIdentifiers: detects JWT tokens', () => {
  const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const r = extractDocumentInsights(text);
  assert.equal(r.identifiers.jwts.length, 1);
});

test('extractIdentifiers: detects IBAN codes', () => {
  const text = 'Transfer to DE89 3704 0044 0532 0130 00 with reference 42. Backup IBAN: GB82WEST12345698765432.';
  const r = extractDocumentInsights(text);
  assert.ok(r.identifiers.ibans.length >= 2, `got ${JSON.stringify(r.identifiers.ibans)}`);
});

test('extractIdentifiers: detects AWS ARNs', () => {
  const text = 'Lambda arn:aws:lambda:us-east-1:123456789012:function:my-fn invoked S3 bucket arn:aws:s3:::my-bucket.';
  const r = extractDocumentInsights(text);
  assert.ok(r.identifiers.awsArns.length >= 1, `got ${JSON.stringify(r.identifiers.awsArns)}`);
});

// ─── Bibliographic references ───────────────────────────────────────────

test('extractBibliographic: detects DOIs', () => {
  const text = 'See Smith et al. 10.1038/nature12373 and Jones 2024 (10.1109/TCS.2024.1234567).';
  const r = extractDocumentInsights(text);
  assert.ok(r.bibliographic.dois.some(d => /nature12373/.test(d)), `got ${JSON.stringify(r.bibliographic.dois)}`);
  assert.ok(r.bibliographic.dois.some(d => /1234567/.test(d)));
});

test('extractBibliographic: detects ISBNs', () => {
  const text = 'The book (ISBN: 978-3-16-148410-0) is foundational. Cf. ISBN 0-306-40615-2.';
  const r = extractDocumentInsights(text);
  assert.ok(r.bibliographic.isbns.length >= 2, `got ${JSON.stringify(r.bibliographic.isbns)}`);
});

test('extractBibliographic: detects arXiv identifiers', () => {
  const text = 'Recent work arXiv:2401.12345 and earlier results arXiv:1706.03762v5.';
  const r = extractDocumentInsights(text);
  assert.ok(r.bibliographic.arxivIds.includes('2401.12345'));
  assert.ok(r.bibliographic.arxivIds.some(a => /1706\.03762/.test(a)));
});

test('extractBibliographic: detects RFC numbers and PubMed IDs', () => {
  const text = 'See RFC 7231 for the spec and PMID: 12345678 for the trial.';
  const r = extractDocumentInsights(text);
  assert.ok(r.bibliographic.rfcs.includes('RFC 7231'));
  assert.ok(r.bibliographic.pubmedIds.some(p => /12345678/.test(p)));
});

// ─── Geographic ──────────────────────────────────────────────────────────

test('extractGeographic: detects decimal-degree GPS coordinates', () => {
  const text = 'The site is located at -12.046374, -77.042793 near the coast.';
  const r = extractDocumentInsights(text);
  assert.ok(r.geographic.coordinatesDecimal.length >= 1, `got ${JSON.stringify(r.geographic.coordinatesDecimal)}`);
});

test('extractGeographic: detects postal codes (US/CA/UK formats)', () => {
  const text = 'Ship to 10001 (NYC), backup to SW1A 1AA (London) or K1A 0B1 (Ottawa).';
  const r = extractDocumentInsights(text);
  assert.ok(r.geographic.postalCodes.length >= 2);
});

// ─── Statistical claims ──────────────────────────────────────────────────

test('extractStatisticalClaims: detects sample sizes', () => {
  const text = 'The cohort study (n=1,247) found significant differences. A pilot with n=42 confirmed feasibility.';
  const r = extractDocumentInsights(text);
  assert.ok(r.statistical.sampleSizes.length >= 2, `got ${JSON.stringify(r.statistical.sampleSizes)}`);
});

test('extractStatisticalClaims: detects p-values', () => {
  const text = 'The effect was significant (p < 0.001) and replicated (p-value = 0.03).';
  const r = extractDocumentInsights(text);
  assert.ok(r.statistical.pValues.length >= 2);
});

test('extractStatisticalClaims: detects correlation coefficients', () => {
  const text = 'A strong positive correlation r = 0.82 was observed. The R² = 0.67 indicates good fit.';
  const r = extractDocumentInsights(text);
  assert.ok(r.statistical.correlations.length >= 2, `got ${JSON.stringify(r.statistical.correlations)}`);
});

test('extractStatisticalClaims: detects mean ± SD pairs', () => {
  const text = 'Group A averaged 12.5 ± 3.2 mg/dL; Group B 8.1 ± 1.7.';
  const r = extractDocumentInsights(text);
  assert.ok(r.statistical.meansAndSd.length >= 2);
});

// ─── Acronyms ────────────────────────────────────────────────────────────

test('extractAcronyms: detects "Term (TLA)" patterns and verifies initials', () => {
  const text = 'The Health Insurance Portability and Accountability Act (HIPAA) governs PHI. The General Data Protection Regulation (GDPR) applies in the EU.';
  const r = extractDocumentInsights(text);
  assert.ok(r.acronyms.some(a => a.acronym === 'HIPAA'));
  assert.ok(r.acronyms.some(a => a.acronym === 'GDPR'));
});

test('extractAcronyms: detects "TLA (Term)" patterns', () => {
  const text = 'HTTP (Hypertext Transfer Protocol) is stateless. TCP (Transmission Control Protocol) provides reliability.';
  const r = extractDocumentInsights(text);
  assert.ok(r.acronyms.some(a => a.acronym === 'HTTP'));
  assert.ok(r.acronyms.some(a => a.acronym === 'TCP'));
});

test('extractAcronyms: rejects mismatched acronym/definition', () => {
  const text = 'The cat sat on the mat (XYZ). Should not match.';
  const r = extractDocumentInsights(text);
  assert.equal(r.acronyms.length, 0);
});

// ─── Trends ──────────────────────────────────────────────────────────────

test('extractTrends: detects "increased by X%" phrasing', () => {
  const text = 'Revenue increased 12.5% YoY. Costs grew by 4 percentage points.';
  const r = extractDocumentInsights(text);
  assert.ok(r.trends.length >= 2, `got ${JSON.stringify(r.trends)}`);
});

test('extractTrends: detects "decreased" phrasing', () => {
  const text = 'Customer churn dropped 30% after the redesign. Latency fell by 8 ms.';
  const r = extractDocumentInsights(text);
  assert.ok(r.trends.length >= 1, `got ${JSON.stringify(r.trends)}`);
});

test('extractTrends: detects "from X to Y" range', () => {
  const text = 'Conversion rose from 2.3% to 4.1% over the quarter.';
  const r = extractDocumentInsights(text);
  assert.ok(r.trends.length >= 1);
});

// ─── Cross-references ────────────────────────────────────────────────────

test('extractCrossReferences: detects "see section X.Y" patterns', () => {
  const text = 'Refer to Section 3.2 for the proof. As shown in Figure 4, the trend reverses.';
  const r = extractDocumentInsights(text);
  assert.ok(r.crossReferences.length >= 2, `got ${JSON.stringify(r.crossReferences)}`);
});

// ─── Sentiment ───────────────────────────────────────────────────────────

test('extractSentimentSignals: detects strong positive/negative phrases', () => {
  const text = 'The launch was an outstanding success. The data leak was a catastrophic failure.';
  const r = extractDocumentInsights(text);
  assert.ok(r.sentiment.positive.length >= 1, `positive: ${JSON.stringify(r.sentiment.positive)}`);
  assert.ok(r.sentiment.negative.length >= 1, `negative: ${JSON.stringify(r.sentiment.negative)}`);
});

// ─── Render integration ──────────────────────────────────────────────────

test('renderInsightsBlock: surfaces new sections when data is present', () => {
  const text = `
The system at 10.0.0.42 logs to SHA-256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.
See Smith 10.1038/nature12373 (n=1,247, p < 0.001, r = 0.82).
The Health Insurance Portability and Accountability Act (HIPAA) is referenced in Section 3.2.
Revenue increased 12.5% YoY after the launch — an outstanding success.
`.trim();
  const report = extractDocumentInsights(text);
  const block = renderInsightsBlock(report);
  assert.match(block, /Technical identifiers/);
  assert.match(block, /Bibliographic references/);
  assert.match(block, /Statistical claims/);
  assert.match(block, /Acronyms/);
  assert.match(block, /Quantified trends/);
  assert.match(block, /Internal cross-references/);
  assert.match(block, /Sentiment signals/);
});

test('renderInsightsBlock: empty report still has no new sections', () => {
  const report = extractDocumentInsights('');
  const block = renderInsightsBlock(report);
  assert.doesNotMatch(block, /Technical identifiers/);
  assert.doesNotMatch(block, /Bibliographic references/);
  assert.doesNotMatch(block, /Statistical claims/);
});

test('extractor caps: identifiers respect MAX_IDENTIFIERS_PER_TYPE', () => {
  // 30 distinct UUIDs
  const uuids = Array.from({ length: 30 }, (_, i) =>
    `550e8400-e29b-41d4-a716-44665544${String(i).padStart(4, '0')}`.toLowerCase()
  );
  const text = uuids.map(u => `id=${u}`).join(' ');
  const r = extractDocumentInsights(text);
  assert.ok(r.identifiers.uuids.length <= 10, `got ${r.identifiers.uuids.length}`);
});
