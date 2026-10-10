'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rb = require('../src/services/request-brief');

const prev = [
  { role: 'user', text: 'explícame la fotosíntesis' },
  { role: 'assistant', text: 'La fotosíntesis es el proceso por el cual las plantas convierten luz en energía química.' },
];
const deck = { id: 'a1b2c3d4e5f60718', filename: 'informe.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const docx = { id: 'a1b2c3d4e5f60719', filename: 'tesis.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

function brief(prompt, ctx = {}) {
  return rb.buildRequestBrief({ prompt, ...ctx });
}

test('style follow-up with a generated deck targets the generated Office file', () => {
  const b = brief('ahora en azul', { recentTurns: prev, priorArtifact: deck });
  assert.equal(b.action, 'edit');
  assert.equal(b.target.kind, 'generated_artifact');
  assert.equal(b.target.format, 'pptx');
  assert.equal(b.target.name, 'informe.pptx');
  assert.deepEqual(b.constraints.map((c) => c.kind), ['color']);
  assert.equal(b.ambiguity.ask, false);
  const hints = rb.routingHints(b);
  assert.equal(hints.editsGeneratedOfficeFile, true);
  assert.equal(hints.officeTargetFormat, 'pptx');
  assert.equal(hints.editsPreviousAnswer, false);
  assert.match(b.summary, /Editar el archivo generado «informe\.pptx» · azul/);
});

test('«ponlas todas rosadas» (plural colour, no noun) still aims at the generated deck', () => {
  const b = brief('ponlas todas rosadas', { recentTurns: prev, priorArtifact: deck });
  assert.equal(b.action, 'edit');
  assert.equal(b.target.kind, 'generated_artifact');
  assert.equal(rb.routingHints(b).editsGeneratedOfficeFile, true);
});

test('an edit of the previous answer is never a file edit, even with a generated artifact in the chat', () => {
  const b = brief('agrega 2 ejemplos más a tu explicación', { recentTurns: prev, priorArtifact: deck });
  assert.equal(b.action, 'edit');
  assert.equal(b.target.kind, 'previous_answer');
  assert.equal(b.target.source, 'explicit');
  assert.deepEqual(b.constraints, [{ kind: 'count', value: '2 ejemplos' }]);
  const hints = rb.routingHints(b);
  assert.equal(hints.editsPreviousAnswer, true);
  assert.equal(hints.editsGeneratedOfficeFile, false);
  assert.match(rb.buildRequestBriefPromptBlock(b), /TU RESPUESTA ANTERIOR/);
  assert.match(rb.buildRequestBriefPromptBlock(b), /NO edites ni generes archivos/);
});

test('an object-less edit beside a generated file assumes the answer and says so', () => {
  const b = brief('agrega una conclusión', { recentTurns: prev, priorArtifact: deck });
  assert.equal(b.target.kind, 'previous_answer');
  assert.equal(b.target.assumed, true);
  assert.equal(b.ambiguity.ask, false);
  assert.ok(b.ambiguity.reasons.includes('target_assumed_answer'));
  assert.match(b.ambiguity.note, /informe\.pptx/);
  assert.match(rb.describeRequestBrief(b).detail, /Asumo/);
});

test('a named Office noun in an edit resolves to the generated file of that format', () => {
  const b = brief('agrégale una conclusión al word', { recentTurns: prev, priorArtifact: docx });
  assert.equal(b.action, 'edit');
  assert.equal(b.target.kind, 'generated_artifact');
  assert.equal(b.target.format, 'docx');
  assert.equal(b.deliverable.ofTarget, true);
  assert.match(rb.buildRequestBriefPromptBlock(b), /archivo que YA generaste/);
});

test('«tradúcelo» with no attachment and no history asks one question with options', () => {
  const b = brief('tradúcelo al inglés');
  assert.equal(b.action, 'transform');
  assert.equal(b.deliverable.kind, 'translation');
  assert.equal(b.target.kind, 'none');
  assert.equal(b.ambiguity.ask, true);
  assert.ok(b.ambiguity.reasons.includes('missing_source'));
  assert.match(b.ambiguity.question, /traduzca/);
  assert.equal(b.ambiguity.options.length, 2);
  assert.ok(b.confidence < 0.3);
  assert.equal(rb.describeRequestBrief(b).detail, 'Te pregunto antes de seguir');
});

test('the same «tradúcelo» after an answer translates the previous answer, no question', () => {
  const b = brief('tradúcelo al inglés', { recentTurns: prev });
  assert.equal(b.target.kind, 'previous_answer');
  assert.equal(b.ambiguity.ask, false);
  assert.deepEqual(b.constraints, [{ kind: 'language', value: 'inglés' }]);
  assert.match(b.summary, /Traducir mi respuesta anterior · inglés/);
});

test('a bare «resume» with nothing to summarise asks; with an attachment it summarises it', () => {
  assert.equal(brief('resume').ambiguity.ask, true);
  assert.equal(brief('hazme un resumen').action, 'analyze');
  assert.equal(brief('hazme un resumen').ambiguity.ask, true);
  const b = brief('resume esto en 3 párrafos', { attachments: [{ originalName: 'a.pdf' }, { originalName: 'b.pdf' }] });
  assert.equal(b.action, 'analyze');
  assert.equal(b.deliverable.kind, 'summary');
  assert.equal(b.target.kind, 'attachment');
  assert.equal(b.target.count, 2);
  assert.deepEqual(b.constraints, [{ kind: 'count', value: '3 párrafos' }]);
  assert.equal(b.ambiguity.ask, false);
});

test('a format conflict («word o pdf») asks with the two formats as options', () => {
  const b = brief('quiero el informe en word o pdf');
  assert.equal(b.ambiguity.ask, true);
  assert.ok(b.ambiguity.reasons.includes('format_conflict'));
  assert.deepEqual(b.ambiguity.options.map((o) => o.value), ['docx', 'pdf']);
  assert.equal(rb.publicRequestBrief(b).ambiguity.options.length, 2);
});

test('create from a named attachment keeps the attachment as the source and the deck as deliverable', () => {
  const b = brief('hazme una presentación de 10 diapositivas sobre la tesis.pdf', { attachments: [{ originalName: 'tesis.pdf', mimeType: 'application/pdf' }] });
  assert.equal(b.action, 'create');
  assert.equal(b.deliverable.kind, 'presentation');
  assert.equal(b.deliverable.format, 'pptx');
  assert.equal(b.target.kind, 'attachment');
  assert.equal(b.target.source, 'named');
  assert.equal(b.target.name, 'tesis.pdf');
  assert.deepEqual(b.constraints, [{ kind: 'count', value: '10 diapositivas' }]);
  assert.match(b.summary, /Crear una presentación a partir de «tesis\.pdf» · 10 diapositivas/);
});

test('a question about an attached document answers in text, the document noun is the source', () => {
  const b = brief('¿qué dice el documento sobre el presupuesto?', { attachments: [{ originalName: 'plan.docx' }] });
  assert.equal(b.action, 'answer');
  assert.equal(b.deliverable.kind, 'text');
  assert.equal(b.target.kind, 'attachment');
  assert.match(rb.buildRequestBriefPromptBlock(b), /respuesta en texto en el chat/);
});

test('verbless corrections («hazlo más formal», «no, en español») edit the previous answer', () => {
  const formal = brief('hazlo más formal', { recentTurns: prev });
  assert.equal(formal.action, 'edit');
  assert.equal(formal.target.kind, 'previous_answer');
  assert.deepEqual(formal.constraints, [{ kind: 'tone', value: 'más formal' }]);
  const lang = brief('no, en español', { recentTurns: prev, repairDetection: { isRepair: true, repairType: 'language' } });
  assert.equal(lang.action, 'edit');
  assert.equal(lang.target.kind, 'previous_answer');
  assert.deepEqual(lang.repair, { type: 'language' });
  assert.match(rb.buildRequestBriefPromptBlock(lang), /CORRIGIENDO/);
});

test('«crea un word con esta información» uses the previous answer as the SOURCE of a new file', () => {
  const b = brief('crea un word con esta información e incorpora la gráfica anterior', { recentTurns: prev });
  assert.equal(b.action, 'create');
  assert.equal(b.deliverable.kind, 'document');
  assert.equal(b.target.kind, 'previous_answer');
  assert.equal(b.target.source, 'content');
  // Creating from the answer is runner work: never vetoed as an answer edit.
  assert.equal(rb.routingHints(b).editsPreviousAnswer, false);
  assert.match(rb.buildRequestBriefPromptBlock(b), /Fuente: el contenido de TU RESPUESTA ANTERIOR/);
});

test('follow-up questions about the answer target it; fresh questions target nothing', () => {
  assert.equal(brief('explica el punto 3 con más detalle', { recentTurns: prev }).target.kind, 'previous_answer');
  assert.equal(brief('qué opinas de esto', { recentTurns: prev }).target.kind, 'previous_answer');
  const fresh = brief('cuál es la capital de Francia');
  assert.equal(fresh.action, 'answer');
  assert.equal(fresh.target.kind, 'none');
  assert.equal(fresh.ambiguity.ask, false);
});

test('small talk and continuations are trivial: no block, neutral row label', () => {
  const hola = brief('hola');
  assert.equal(hola.action, 'converse');
  assert.equal(hola.trivial, true);
  assert.equal(rb.buildRequestBriefPromptBlock(hola), '');
  assert.equal(rb.describeRequestBrief(hola).label, 'Mensaje entendido');
  const sigue = brief('sigue', { recentTurns: prev });
  assert.equal(sigue.action, 'continue');
  assert.equal(sigue.target.kind, 'previous_answer');
  assert.equal(sigue.trivial, true);
});

test('media / chart / search / code / write intents classify without a question', () => {
  assert.equal(brief('genera una imagen de un gato astronauta').deliverable.kind, 'image');
  assert.equal(brief('grafica estos datos: 1,2,3,4').action, 'visualize');
  assert.equal(brief('busca las últimas noticias de la inflación en México').action, 'search');
  assert.equal(brief('mejora el código', { recentTurns: prev }).action, 'code');
  const mail = brief('escribe un correo formal para pedir una reunión');
  assert.equal(mail.action, 'create');
  assert.equal(mail.deliverable.kind, 'text');
  assert.match(mail.summary, /Redactar/);
  for (const p of ['genera una imagen de un gato astronauta', 'busca las últimas noticias de la inflación en México', 'escribe un correo formal para pedir una reunión']) {
    assert.equal(brief(p).ambiguity.ask, false, p);
  }
});

test('conversions of the generated file and of the answer are told apart', () => {
  const file = brief('pásalo a excel', { recentTurns: prev, priorArtifact: docx });
  assert.equal(file.action, 'transform');
  assert.equal(file.target.kind, 'generated_artifact');
  assert.equal(file.deliverable.format, 'xlsx');
  const answer = brief('exporta la tabla a csv', { recentTurns: prev });
  assert.equal(answer.target.kind, 'previous_answer');
  assert.equal(answer.deliverable.format, 'csv');
  // Converting the answer into a file is runner work, not an answer edit.
  assert.equal(rb.routingHints(answer).editsPreviousAnswer, true);
});

test('the row label is capped at 90 chars and the public payload is compact', () => {
  const b = brief('hazme una presentación de 20 diapositivas en inglés para inversionistas con tono formal sobre el archivo plan-estrategico-2026-version-final-revisada.docx', {
    attachments: [{ originalName: 'plan-estrategico-2026-version-final-revisada.docx' }],
  });
  const row = rb.describeRequestBrief(b);
  assert.ok(row.label.startsWith('Entendí: '));
  assert.ok(row.label.length <= 90, row.label);
  const pub = rb.publicRequestBrief(b);
  assert.deepEqual(Object.keys(pub).sort(), ['action', 'ambiguity', 'confidence', 'constraints', 'deliverable', 'source', 'summary', 'target', 'trivial', 'version']);
  assert.equal(pub.target.name, 'plan-estrategico-2026-version-final-revisada.docx');
  assert.ok(pub.constraints.length >= 3);
  assert.equal(JSON.stringify(pub).includes('"id"'), false);
});

test('needsPriorArtifactLookup gates the query to follow-up / edit phrasings', () => {
  assert.equal(rb.needsPriorArtifactLookup('ahora en azul'), true);
  assert.equal(rb.needsPriorArtifactLookup('agrégale una conclusión al word'), true);
  assert.equal(rb.needsPriorArtifactLookup('cuál es la capital de Francia'), false);
  assert.equal(rb.needsPriorArtifactLookup('hola'), false);
  assert.equal(rb.needsPriorArtifactLookup(''), false);
});

test('isEnabled honours the kill switch', () => {
  assert.equal(rb.isEnabled({}), true);
  assert.equal(rb.isEnabled({ SIRAGPT_REQUEST_BRIEF: '0' }), false);
  assert.equal(rb.isEnabled({ SIRAGPT_REQUEST_BRIEF: 'off' }), false);
  assert.equal(rb.isEnabled({ SIRAGPT_REQUEST_BRIEF: '1' }), true);
});

test('LLM refinement only runs for low-confidence turns with history and never when asking', () => {
  const env = { SIRAGPT_REQUEST_BRIEF_LLM: '1' };
  assert.equal(rb.shouldRefineWithLlm(brief('agrega una conclusión', { recentTurns: prev, priorArtifact: deck }), { hasHistory: true, env }), true);
  assert.equal(rb.shouldRefineWithLlm(brief('agrega una conclusión', { recentTurns: prev, priorArtifact: deck }), { hasHistory: false, env }), false);
  assert.equal(rb.shouldRefineWithLlm(brief('tradúcelo al inglés'), { hasHistory: true, env }), false);
  assert.equal(rb.shouldRefineWithLlm(brief('hola'), { hasHistory: true, env }), false);
  assert.equal(rb.shouldRefineWithLlm(brief('agrega una conclusión', { recentTurns: prev, priorArtifact: deck }), { hasHistory: true, env: { SIRAGPT_REQUEST_BRIEF_LLM: '0' } }), false);
});

test('LLM refinement merges a valid verdict and re-aims only at targets that exist', async () => {
  const base = brief('agrega una conclusión', { recentTurns: prev, priorArtifact: deck });
  const calls = [];
  const complete = async (args) => {
    calls.push(args);
    return '```json\n{"action":"edit","deliverable":{"kind":null,"format":null},"target":{"kind":"generated_artifact"},"constraints":[{"kind":"other","value":"una conclusión breve"}],"summary":"Añadir una conclusión a la presentación"}\n```';
  };
  const refined = await rb.refineRequestBriefWithLlm(base, { prompt: 'agrega una conclusión', recentTurns: prev, attachments: [], priorArtifact: deck }, { complete, timeoutMs: 500 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].user, /informe\.pptx/);
  assert.equal(refined.source, 'llm');
  assert.equal(refined.target.kind, 'generated_artifact');
  assert.equal(refined.target.name, 'informe.pptx');
  assert.equal(refined.summary, 'Añadir una conclusión a la presentación');
  assert.ok(refined.constraints.some((c) => c.value === 'una conclusión breve'));
  assert.equal('__priorArtifact' in refined, false);
  // No artifact in the chat: the model cannot invent one.
  const noFile = brief('agrega una conclusión', { recentTurns: prev });
  const kept = await rb.refineRequestBriefWithLlm(noFile, { prompt: 'agrega una conclusión', recentTurns: prev, attachments: [] }, { complete });
  assert.equal(kept.target.kind, 'previous_answer');
});

test('LLM refinement is fail-open: null, junk, throw and timeout keep the heuristic brief', async () => {
  const base = brief('agrega una conclusión', { recentTurns: prev, priorArtifact: deck });
  const ctx = { prompt: 'agrega una conclusión', recentTurns: prev, attachments: [], priorArtifact: deck };
  assert.equal(await rb.refineRequestBriefWithLlm(base, ctx, { complete: async () => null }), base);
  assert.equal(await rb.refineRequestBriefWithLlm(base, ctx, { complete: async () => 'no json here' }), base);
  assert.equal(await rb.refineRequestBriefWithLlm(base, ctx, { complete: async () => { throw new Error('boom'); } }), base);
  assert.equal(await rb.refineRequestBriefWithLlm(base, ctx, { complete: async () => '{"action":"fly","target":{"kind":"moon"}}' }), base);
});

test('an empty prompt yields a trivial brief and nothing throws on odd input', () => {
  assert.equal(brief('').trivial, true);
  assert.equal(brief(null).action, 'converse');
  assert.doesNotThrow(() => brief('x'.repeat(20000), { attachments: [null, {}], recentTurns: [null, { role: 'assistant' }] }));
  assert.equal(rb.publicRequestBrief(null), null);
  assert.equal(rb.buildRequestBriefPromptBlock(null), '');
  assert.deepEqual(rb.routingHints(null), { editsPreviousAnswer: false, editsGeneratedOfficeFile: false, officeTargetFormat: null, templateFile: null, templateFormat: null });
});

test('a pasted link is the object: «transcribe este video del minuto 1.5 al 10» → transcription of the URL with a time range', () => {
  const b = brief('https://upn.class.com/player/recording/1d178f25-49ba ) transcirbir del minuto 1.5 al minuto 10 del inicio');
  assert.equal(b.action, 'transform');
  assert.equal(b.deliverable.kind, 'transcription');
  assert.equal(b.target.kind, 'url');
  assert.equal(b.target.name, 'upn.class.com');
  assert.deepEqual(b.constraints, [{ kind: 'time_range', value: '01:30 → 10:00' }]);
  assert.equal(b.ambiguity.ask, false);
  assert.match(b.summary, /^Transcribir el enlace de upn\.class\.com · 01:30 → 10:00$/);
  const block = rb.buildRequestBriefPromptBlock(b);
  assert.match(block, /- Acción: Transcribir/);
  assert.match(block, /transcribe_url/);
  const pub = rb.publicRequestBrief(b);
  assert.equal(pub.target.kind, 'url');
  assert.equal(JSON.stringify(pub).includes('"url":'), false, 'the public payload carries the host, never the raw link');
});

test('links with other verbs keep their action; mm:ss ranges and seconds are normalised; an attached audio wins over no link', () => {
  const sum = brief('resume https://example.com/articulo');
  assert.equal(sum.action, 'analyze');
  assert.equal(sum.target.kind, 'url');
  const yt = brief('transcribe https://youtu.be/abc del 2:30 al 12:00');
  assert.deepEqual(yt.constraints, [{ kind: 'time_range', value: '02:30 → 12:00' }]);
  const secs = brief('transcribe https://youtu.be/abc del segundo 30 al 90');
  assert.deepEqual(secs.constraints, [{ kind: 'time_range', value: '00:30 → 01:30' }]);
  const attached = brief('transcribe el audio adjunto', { attachments: [{ originalName: 'clase.mp3' }] });
  assert.equal(attached.deliverable.kind, 'transcription');
  assert.equal(attached.target.kind, 'attachment');
  // A link means the source exists: no «¿qué quieres que transcriba?».
  assert.equal(brief('transcribe https://youtu.be/abc').ambiguity.ask, false);
});

// ─── 2026-10-10: a message that carries its own material is answered ─────
// Until then every first message of a new chat with an edit/transform/
// analyze verb and its own object («traduce al inglés: Hola», «resume la
// revolución francesa», «compara Python y JavaScript») got «¿Qué quieres que
// traduzca? No veo un archivo adjunto ni un texto en este chat.» instead of
// an answer: only a ≥ 45-word paste counted as material.

test('first message with its own text, topic, value or how-to question is answered, never asked', () => {
  const prompts = [
    'traduce al inglés: Hola, ¿cómo estás?',
    'Traduce "buenos días a todos" al francés',
    'corrige: yo a ido al colegio',
    'parafrasea: La educación es la base del desarrollo de un país.',
    'resume el libro Cien años de soledad',
    'resume la revolución francesa',
    'hazme un resumen de la segunda guerra mundial',
    'analiza el poema Masa de César Vallejo',
    'convierte 25 °C a fahrenheit',
    'convierte 100 dólares a soles',
    'compara Python y JavaScript',
    'ponme un ejemplo de metáfora',
    'agrega 5 ideas para mi negocio de café',
    'verifica si 17 es primo',
    'identifica el sujeto: María canta bonito',
    'translate to spanish: I love you',
    'evalúa las ventajas de la energía solar',
    'clasifica estos animales: perro, águila, tiburón',
    'revisa mi ortografía: ayer fuy al cine',
    'corrige este texto: yo a ido al colegio ayer',
    'resume el capítulo 3 de Don Quijote',
    'grafica la función seno',
    'dibuja un gato',
    'haz un diagrama de flujo del proceso de compra',
    '¿cómo eliminar mi cuenta de facebook?',
    '¿cómo se elimina una cuenta de gmail?',
    'consejos para mejorar mi productividad',
    'cómo convertir un pdf a word',
    'how to remove a virus from my pc',
  ];
  for (const p of prompts) {
    const b = brief(p);
    assert.equal(b.ambiguity.ask, false, p);
    assert.ok(!b.ambiguity.reasons.includes('missing_source'), p);
    assert.equal(rb._internal.carriesOwnMaterial(rb._internal.fold(p)), true, p);
  }
});

test('requests whose object is missing or lives in a file nobody attached still ask, with the two options', () => {
  const prompts = [
    'tradúcelo al inglés', 'resume', 'hazme un resumen', 'traduce al inglés', 'traduce:', 'traduce esto',
    'traduce lo siguiente', 'traduce este texto al inglés', 'resume mi tesis', 'resume el documento', 'resume el pdf',
    'resume el libro', 'resume el capítulo 3', 'resume el documento sobre la reforma', 'mejora mi CV', 'corrige el texto',
    'corrige mi ensayo de 500 palabras', 'reformula mi introducción', 'mejora la redacción', 'revisa la ortografía',
    'corrige los errores', 'agrega una conclusión', 'quita el último párrafo', 'extrae las ideas principales',
    'extrae las ideas principales del texto', 'extrae las fechas', 'verifica la fórmula', 'compara estos dos textos',
    'analiza el archivo adjunto', 'analiza esta imagen', 'convierte este pdf a word', 'grafica esto',
    'ponlas todas rosadas', 'ponlo en azul', 'agrega 2 ejemplos más a tu explicación', 'como experto, corrige mi ensayo',
  ];
  for (const p of prompts) {
    const b = brief(p);
    assert.equal(b.ambiguity.ask, true, p);
    assert.ok(b.ambiguity.reasons.includes('missing_source'), p);
    assert.equal(b.ambiguity.options.length, 2, p);
  }
  // A format conflict is a different question and is untouched.
  assert.deepEqual(brief('quiero el informe en word o pdf').ambiguity.reasons, ['format_conflict']);
});

test('after an answer, text pasted after «:» or between quotes is the object, not the previous answer', () => {
  for (const p of ['traduce al inglés: Hola, ¿cómo estás?', 'corrige: yo a ido al colegio', 'parafrasea: el sol sale por el este',
    'traduce "buenos días" al francés', 'traduce este texto: Hello world, how are you', 'ahora traduce al francés: me gusta el cine']) {
    const b = brief(p, { recentTurns: prev });
    assert.equal(b.target.kind, 'none', p);
    assert.equal(b.target.source, 'inline', p);
    assert.doesNotMatch(b.summary, /respuesta anterior/, p);
    assert.equal(rb.routingHints(b).editsPreviousAnswer, false, p);
    assert.doesNotMatch(rb.buildRequestBriefPromptBlock(b), /TU RESPUESTA ANTERIOR/, p);
  }
  // Pronouns, anchors, explicit references and instructions about the answer
  // keep targeting it.
  for (const p of ['hazlo más formal', 'tradúcelo al inglés', 'ahora en inglés', 'agrega 2 ejemplos más a tu explicación',
    'corrige eso: el año es 1990', 'cambia el título a: Fotosíntesis']) {
    const b = brief(p, { recentTurns: prev });
    assert.equal(b.target.kind, 'previous_answer', p);
    assert.equal(rb.routingHints(b).editsPreviousAnswer, true, p);
  }
});

test('a how-to question is answered, never read as an edit of the answer or of the generated file', () => {
  for (const p of ['¿cómo eliminar mi cuenta de facebook?', 'como mejorar mi cv', 'how to convert a pdf to word', 'consejos para mejorar mi productividad']) {
    for (const ctx of [{}, { recentTurns: prev }, { recentTurns: prev, priorArtifact: deck }]) {
      const b = brief(p, ctx);
      assert.equal(b.action, 'answer', p);
      assert.equal(b.target.kind, 'none', p);
      assert.equal(b.ambiguity.ask, false, p);
      assert.equal(rb.routingHints(b).editsGeneratedOfficeFile, false, p);
    }
  }
  // «como experto, …» is «as an expert», not a how-to question.
  assert.equal(brief('como experto, corrige mi ensayo').action, 'edit');
  // With an attachment the edit verb still acts on it.
  assert.equal(brief('¿cómo mejorar este documento?', { attachments: [{ originalName: 'tesis.docx' }] }).target.kind, 'attachment');
});

test('inline material helpers: delimiter after the verb, nothing but a material noun before it', () => {
  const { inlineObjectMaterial, carriesOwnMaterial, objectCore, fold } = rb._internal;
  assert.equal(inlineObjectMaterial(fold('traduce al inglés: Hola')), true);
  assert.equal(inlineObjectMaterial(fold('traduce al inglés:')), false);
  assert.equal(inlineObjectMaterial(fold('traduce esto :)')), false);
  assert.equal(inlineObjectMaterial(fold('Importante: resume el documento')), false);
  assert.equal(inlineObjectMaterial(fold('resume la reunión de las 10:30')), false);
  assert.equal(inlineObjectMaterial(fold('cambia el título a: Informe final')), false);
  assert.equal(inlineObjectMaterial(fold('corrige eso: el año es 1990')), false);
  assert.equal(inlineObjectMaterial(fold('revisa mi ortografía: ayer fuy al cine')), true);
  assert.equal(inlineObjectMaterial(fold('traduce la frase "carpe diem"')), true);
  assert.equal(carriesOwnMaterial(''), false);
  assert.equal(carriesOwnMaterial(fold('resume')), false);
  assert.equal(objectCore(fold(' al inglés de forma formal en 3 párrafos por favor')), '');
  assert.equal(objectCore(fold(' un resumen breve de la revolución francesa')), 'la revolucion francesa');
});
