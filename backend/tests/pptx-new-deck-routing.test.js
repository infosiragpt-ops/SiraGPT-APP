'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  wantsNewPresentationDeliverable,
  detectFormat,
} = require('../src/services/agents/document-delivery-policy');
const {
  isArtifactDeliverableRequest,
  isAgenticActionRequest,
} = require('../src/services/agents/agentic-trigger');

// Avoid loading source-preserving-document-edit here (heavy OOXML deps).
// Full isSourcePreservingEditRequest coverage lives in source-preserving-document-edit.test.js.

const LIVE_PROMPT = 'realiza una ppt profesional en 30 ppts de forma profesional de la tesis 20 julio Tesis de maestria para revision de observaciones 19-7-26.pdf en base a la imagenes de forma profesional';

describe('new PPTX deck routing (thesis + images → .pptx)', () => {
  it('detects new presentation deliverable from the live production prompt', () => {
    assert.equal(wantsNewPresentationDeliverable(LIVE_PROMPT), true);
    assert.equal(detectFormat(LIVE_PROMPT), 'pptx');
  });

  it('routes creation verbs + ppt into agentic artifact delivery', () => {
    assert.equal(isAgenticActionRequest(LIVE_PROMPT), true);
    assert.equal(isArtifactDeliverableRequest(LIVE_PROMPT), true);
  });

  it('still allows true PPTX surgical-edit intent classification', () => {
    assert.equal(
      wantsNewPresentationDeliverable('cambia el titulo de la diapositiva 2 de mi presentacion'),
      false,
    );
  });

  it('does not treat "agrega N ppts más en estas mismas diapositivas" as a new deck', () => {
    const live = 'agrega 5 ppts mas en estas mimas diapositivas ## Gestion_amdinistrativa.pptx que hablen sobre ejemplos de casos de exito y la ultima d elas 5 que sean sobre bibliografia en apa 7ma edicion';
    assert.equal(wantsNewPresentationDeliverable(live), false);
    assert.equal(wantsNewPresentationDeliverable('agrega 5 slides mas en esta misma ppt'), false);
  });

  it('does not mis-route plain thesis Q&A as a new deck', () => {
    assert.equal(wantsNewPresentationDeliverable('resume la tesis adjunta en 5 puntos'), false);
  });

  it('detects slide-count deck asks without a create verb', () => {
    assert.equal(
      wantsNewPresentationDeliverable('presentacion profesional de 30 diapositivas sobre este PDF'),
      true,
    );
    assert.equal(detectFormat('presentacion profesional de 30 diapositivas sobre este PDF'), 'pptx');
  });
});
