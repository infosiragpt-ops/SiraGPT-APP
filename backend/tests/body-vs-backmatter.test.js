/**
 * body-vs-backmatter — pins the trailing back-matter separation that keeps
 * synthesis excerpts grounded in the document BODY instead of its trailing
 * references/annexes/systematization matrix.
 *
 * Regression source (real production bug): "dame un resumen en un solo
 * párrafo" over a review article echoed the document's internal
 * instructions ("similitud ≤29%", systematization matrix) because the
 * balanced excerpt spent 32% of its budget on the tail = bibliography +
 * matrix.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  detectBackmatterRegions,
  splitBodyVsBackmatter,
  stripTrailingBackmatter,
  buildBodyBalancedExcerpt,
} = require("../src/services/document/body-vs-backmatter");

const REVIEW_ARTICLE = [
  "Estrés académico en estudiantes universitarios: una revisión sistemática",
  "",
  "Resumen",
  "Esta revisión sistematiza 42 estudios empíricos publicados entre 2015 y 2025",
  "sobre estrés académico, ansiedad ante exámenes y rendimiento.",
  "",
  "Introducción",
  "El estrés académico se define como las demandas percibidas por el estudiante",
  "durante su formación. La literatura reciente lo asocia con burnout y deserción.",
  "",
  "Metodología",
  "Se realizó una búsqueda en Scopus, Web of Science y SciELO siguiendo PRISMA.",
  "Dos revisores independientes evaluaron la calidad metodológica de cada estudio.",
  "",
  "Resultados",
  "Los hallazgos muestran que la sobrecarga de tareas y los exámenes son los",
  "principales estresores. Las estrategias de afrontamiento centradas en el",
  "problema reducen significativamente los síntomas reportados.",
  "",
  "Conclusiones",
  "La evidencia respalda programas institucionales de manejo del estrés desde",
  "el primer ciclo académico, con seguimiento longitudinal del bienestar.",
  "",
  "Matriz de sistematización",
  "Autores | Año | Enfoque | Muestreo | Similitud ≤29%",
  "García et al. | 2019 | Cuantitativo | Probabilístico | 27%",
  "Rojas y Lima | 2021 | Cualitativo | Conveniencia | 25%",
  "",
  "Referencias bibliográficas",
  "García, M. (2019). Estrés y rendimiento. Revista de Psicología, 12(3), 45-60.",
  "Rojas, P., & Lima, S. (2021). Ansiedad ante exámenes. Educación Global, 8(1), 9-24.",
].join("\n");

const BODY_ONLY = [
  "Manual de procedimientos internos",
  "",
  "Capítulo I: Disposiciones generales",
  "Este manual regula el flujo de documentos entre áreas de la organización.",
  "Cada área designa un responsable de archivo que custodia los originales.",
  "",
  "Capítulo II: Flujo de trámite",
  "Todo documento ingresa por mesa de partes y se registra en el sistema.",
  "El plazo máximo de atención es de cinco días hábiles contados desde el registro.",
  "",
  "Capítulo III: Responsabilidades",
  "Los jefes de oficina verifican el cumplimiento de los plazos establecidos",
  "y reportan mensualmente los indicadores de gestión documentaria.",
].join("\n");

describe("detectBackmatterRegions", () => {
  test("flags trailing references heading in a review article", () => {
    const regions = detectBackmatterRegions(REVIEW_ARTICLE);
    assert.ok(regions.length >= 1);
    const cutText = REVIEW_ARTICLE.slice(regions[0].start);
    assert.match(cutText, /Matriz de sistematización|Referencias/i);
  });

  test("ignores an early prose mention of referencias", () => {
    const text = [
      "Metodología",
      "Para este trabajo se revisaron las referencias clásicas del campo y luego",
      "se contrastaron con estudios recientes hasta completar la muestra final.",
      ...Array.from({ length: 40 }, (_, i) => `Párrafo ${i}: el contenido sustantivo del documento continúa aquí con datos relevantes.`),
    ].join("\n");
    assert.equal(detectBackmatterRegions(text).length, 0);
  });

  test("returns empty for blank input", () => {
    assert.deepEqual(detectBackmatterRegions(""), []);
    assert.deepEqual(detectBackmatterRegions(null), []);
  });
});

describe("splitBodyVsBackmatter", () => {
  test("review article: body excludes matrix + references, backmatter holds them", () => {
    const { body, backmatter, boundary } = splitBodyVsBackmatter(REVIEW_ARTICLE);
    assert.ok(boundary > 0);
    assert.doesNotMatch(body, /Similitud ≤29%/);
    assert.doesNotMatch(body, /García, M\. \(2019\)/);
    assert.match(body, /Conclusiones/);
    assert.match(body, /reducen significativamente los síntomas/);
    assert.match(backmatter, /Similitud ≤29%/);
    assert.match(backmatter, /Revista de Psicología/);
  });

  test("document without back matter is returned intact", () => {
    const { body, backmatter, boundary } = splitBodyVsBackmatter(BODY_ONLY);
    assert.equal(boundary, -1);
    assert.equal(backmatter, "");
    assert.equal(body, BODY_ONLY);
  });

  test("false-positive guard: never guts a short annex-only document", () => {
    const short = [
      "Informe breve",
      "Anexos",
      "Anexo 1: encuesta aplicada.",
      "Anexo 2: tabla de frecuencias.",
    ].join("\n");
    const { body, backmatter, boundary } = splitBodyVsBackmatter(short);
    assert.equal(boundary, -1);
    assert.equal(backmatter, "");
    assert.equal(body, short);
  });
});

describe("stripTrailingBackmatter", () => {
  test("string→string contract: removes back matter, keeps body", () => {
    const out = stripTrailingBackmatter(REVIEW_ARTICLE);
    assert.ok(!out.includes("Similitud ≤29%"));
    assert.ok(out.includes("revisión sistemática") || out.includes("Revisión sistemática") || out.includes("Estrés académico"));
    assert.ok(out.length > 0 && out.length < REVIEW_ARTICLE.length);
  });

  test("passthrough on clean or empty input", () => {
    assert.equal(stripTrailingBackmatter(BODY_ONLY), BODY_ONLY);
    assert.equal(stripTrailingBackmatter(""), "");
    assert.equal(stripTrailingBackmatter(null), "");
  });
});

describe("buildBodyBalancedExcerpt", () => {
  test("excerpt over review article never contains matrix rows", () => {
    const excerpt = buildBodyBalancedExcerpt(REVIEW_ARTICLE, 900, "resumen del contenido");
    assert.ok(excerpt.length > 0);
    assert.ok(excerpt.length <= 1100);
    assert.doesNotMatch(excerpt, /Similitud ≤29%/);
    assert.doesNotMatch(excerpt, /Rojas y Lima \| 2021/);
    assert.match(excerpt, /\[Fragmento final del documento\]/);
  });

  test("short body fits without ellipsis markers", () => {
    const small = REVIEW_ARTICLE.slice(0, 500) + "\nConclusiones\nLa evidencia es consistente.";
    const excerpt = buildBodyBalancedExcerpt(small, 6000, "");
    assert.equal(excerpt, small.trim());
  });

  test("query terms steer the middle fragment within the body", () => {
    const excerpt = buildBodyBalancedExcerpt(REVIEW_ARTICLE, 800, "afrontamiento problema reduce");
    assert.match(excerpt, /afrontamiento/i);
  });
});
