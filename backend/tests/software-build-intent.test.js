'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  isSoftwareBuildRequest,
  isExplicitDocumentRequest,
  isCopyOrDataAsk,
  shouldBlockOfficeCreateDocument,
  E_SOFTWARE_CODE,
} = require('../src/services/agents/software-build-intent');
const { buildDocumentDeliveryPolicy } = require('../src/services/agents/document-delivery-policy');

describe('software-build-intent', () => {
  test('website / app / software prompts classify as software, not Word', () => {
    const positives = [
      'créame una web de ventas',
      'crea una web de ventas',
      'creame un sitio web de ventas',
      'hazme una landing de ventas',
      'quiero una pagina web de ventas',
      'desarrolla una app de ventas',
      'necesito un software de ventas',
      'crea un ecommerce',
      'construye una tienda online',
      'crea una pagina de ventas',
    ];
    for (const prompt of positives) {
      assert.equal(isSoftwareBuildRequest(prompt), true, prompt);
      assert.equal(isExplicitDocumentRequest(prompt), false, prompt);
    }
  });

  test('true document asks stay documents', () => {
    const docs = [
      'rédactame un informe de ventas en Word',
      'redactame un informe de ventas en Word',
      'hazme un PDF de propuesta',
      'genera un Excel con las ventas',
      'crea un documento Word vacío',
    ];
    for (const prompt of docs) {
      assert.equal(isExplicitDocumentRequest(prompt), true, prompt);
      assert.equal(isSoftwareBuildRequest(prompt), false, prompt);
    }
  });

  test('a requested document remains a document when software is only its subject', () => {
    for (const prompt of [
      'crea un manual de usuario para mi software',
      'crea un informe sobre esta app',
      'genera un documento sobre una aplicacion web',
      'crea un informe Word sobre React',
    ]) {
      assert.equal(isExplicitDocumentRequest(prompt), true, prompt);
      assert.equal(isSoftwareBuildRequest(prompt), false, prompt);
      for (const filename of ['entregable.docx', 'entregable.pdf']) {
        assert.equal(shouldBlockOfficeCreateDocument(filename, prompt), false, `${prompt}: ${filename}`);
      }
    }
  });

  test('a requested app remains software when documents are only a feature', () => {
    for (const prompt of [
      'crea una app para gestionar documentos',
      'crea un sitio web con manual de ayuda',
    ]) {
      assert.equal(isExplicitDocumentRequest(prompt), false, prompt);
      assert.equal(isSoftwareBuildRequest(prompt), true, prompt);
      assert.equal(shouldBlockOfficeCreateDocument('entregable.docx', prompt), true, prompt);
    }
  });

  test('datos / copy de ventas do not force coding', () => {
    assert.equal(isCopyOrDataAsk('datos de ventas'), true);
    assert.equal(isSoftwareBuildRequest('datos de ventas'), false);
    assert.equal(isSoftwareBuildRequest('analiza datos de ventas de 2025'), false);
    assert.equal(isSoftwareBuildRequest('copy de ventas para el brochure'), false);
    assert.equal(isSoftwareBuildRequest('dame las cifras de ventas'), false);
    assert.equal(
      isSoftwareBuildRequest('crea un diagrama ER en Mermaid para un e-commerce con usuarios, pedidos y pagos'),
      false,
    );
  });

  test('blocks Office create_document on software builds', () => {
    assert.equal(shouldBlockOfficeCreateDocument('Web_de_ventas.docx', 'créame una web de ventas'), true);
    assert.equal(shouldBlockOfficeCreateDocument('index.html', 'créame una web de ventas'), false);
    assert.equal(shouldBlockOfficeCreateDocument('informe.docx', 'rédactame un informe de ventas en Word'), false);
    assert.equal(E_SOFTWARE_CODE, 'E_SOFTWARE_CODE');
  });
});

describe('document policy stay on the code plane', () => {
  test('document subjects mentioning an app preserve the pre-software-routing delivery policy', () => {
    // Exact a133aeba baseline: this manual already stayed chat_only in this
    // policy (although semantic routing recognized .docx). Do not expand
    // generation here; the report did require a document before #664.
    for (const [goal, mode, autoGenerate] of [
      ['crea un manual de usuario para mi software', 'chat_only', false],
      ['crea un informe sobre esta app', 'doc_required', true],
    ]) {
      const policy = buildDocumentDeliveryPolicy({ goal });
      assert.equal(policy.mode, mode, goal);
      assert.equal(policy.autoGenerate, autoGenerate, goal);
      assert.equal(policy.format, 'docx', goal);
    }
  });

  test('document policy does not auto-Word a website ask', () => {
    const policy = buildDocumentDeliveryPolicy({
      goal: 'créame una web de ventas',
    });
    assert.equal(policy.mode, 'chat_only');
    assert.equal(policy.autoGenerate, false);
  });

  test('Word / PDF sales documents still require Office files', () => {
    const pdfPolicy = buildDocumentDeliveryPolicy({
      goal: 'hazme un PDF de propuesta',
    });
    assert.equal(pdfPolicy.mode, 'doc_required');
    assert.equal(pdfPolicy.format, 'pdf');

    const wordPolicy = buildDocumentDeliveryPolicy({
      goal: 'rédactame un informe de ventas en Word',
    });
    assert.equal(wordPolicy.mode, 'doc_required');
    assert.equal(wordPolicy.format, 'docx');
  });
});
