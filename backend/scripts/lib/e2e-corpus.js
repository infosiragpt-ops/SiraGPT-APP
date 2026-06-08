'use strict';

/**
 * e2e-corpus.js — ~100 live-chat test cases graded deterministically against
 * facts planted in e2e-fixtures.js. `doc` references a fixture key
 * (ventas/contrato/acta/informe/factura). `any`/`all` are expected
 * substrings (accent-insensitive). `turns` = a multi-turn thread sharing one
 * chat (only turn 1 attaches the doc → tests in-thread context retention).
 * `judge:true` marks open-ended answers also sent to the adversarial judges.
 */

const CORPUS = [
  // ── Excel (ventas_2025.xlsx) ──
  { id: 'e1', category: 'excel', doc: 'ventas', prompt: '¿Cuál es el total de ventas de la región Norte? Responde solo con el número.', any: ['600'] },
  { id: 'e2', category: 'excel', doc: 'ventas', prompt: '¿Qué región tuvo el mayor total de ventas? Responde solo con el nombre.', any: ['este'] },
  { id: 'e3', category: 'excel', doc: 'ventas', prompt: '¿Qué región tuvo el menor total de ventas? Solo el nombre.', any: ['oeste'] },
  { id: 'e4', category: 'excel', doc: 'ventas', prompt: '¿Cuál es el gran total de todas las regiones (fila TOTAL)? Solo el número.', any: ['2070', '2.070'] },
  { id: 'e5', category: 'excel', doc: 'ventas', prompt: '¿Cuántas regiones hay en la tabla, sin contar la fila TOTAL? Solo el número.', any: ['4', 'cuatro'] },
  { id: 'e6', category: 'excel', doc: 'ventas', prompt: '¿Cuál es la venta de Norte en Q4? Solo el número.', any: ['200'] },
  { id: 'e7', category: 'excel', doc: 'ventas', prompt: 'Suma el total de Norte y Sur. Solo el número.', any: ['975'] },
  { id: 'e8', category: 'excel', doc: 'ventas', prompt: '¿Cuál es el valor del marcador de la hoja?', any: ['xlsmark-5521'] },
  { id: 'e9', category: 'excel', doc: 'ventas', prompt: '¿Cuál es la diferencia entre el total del Este y el del Oeste? Solo el número.', any: ['545'] },
  { id: 'e10', category: 'excel', doc: 'ventas', prompt: 'Lista las cuatro regiones de la tabla.', all: ['norte', 'sur', 'este', 'oeste'] },
  { id: 'e11', category: 'excel', doc: 'ventas', prompt: '¿Qué porcentaje del gran total (2070) representa la región Este (820)? Aproxima al entero.', any: ['40', '39'], judge: true },
  { id: 'e12', category: 'excel', doc: 'ventas', prompt: '¿En qué trimestre tuvo Norte su mayor venta y cuánto fue?', any: ['q4', '200'] },
  { id: 'e13', category: 'excel', doc: 'ventas', prompt: 'Calcula el promedio trimestral de Sur (su total es 375). Da el número.', any: ['93.75', '93,75', '93.8', '94'], judge: true },

  // ── Word: contrato_servicios.docx ──
  { id: 'd1', category: 'docx', doc: 'contrato', prompt: '¿Quién es el Cliente en el contrato? Solo el nombre.', any: ['acme'] },
  { id: 'd2', category: 'docx', doc: 'contrato', prompt: '¿Quién es el Proveedor en el contrato? Solo el nombre.', any: ['techsolutions'] },
  { id: 'd3', category: 'docx', doc: 'contrato', prompt: '¿Cuál es el importe total del contrato?', any: ['45.000', '45000'] },
  { id: 'd4', category: 'docx', doc: 'contrato', prompt: '¿Cuál es la vigencia del contrato?', any: ['12 meses', '12'] },
  { id: 'd5', category: 'docx', doc: 'contrato', prompt: '¿Qué penalización se aplica por cada día de retraso?', any: ['2%', '2 %', '2 por'] },
  { id: 'd6', category: 'docx', doc: 'contrato', prompt: '¿En qué número de cláusula está la penalización? Solo el número.', any: ['7.3'] },
  { id: 'd7', category: 'docx', doc: 'contrato', prompt: '¿Cuántos años dura la obligación de confidencialidad? Solo el número.', any: ['5'] },
  { id: 'd8', category: 'docx', doc: 'contrato', prompt: '¿En qué ciudad se firmó el contrato?', any: ['madrid'] },
  { id: 'd9', category: 'docx', doc: 'contrato', prompt: '¿Cuál es el marcador del documento?', any: ['docmark-8842'] },

  // ── Word: acta_reunion.docx ──
  { id: 'd10', category: 'docx', doc: 'acta', prompt: 'Según el acta, ¿cuántos asistentes hubo? Solo el número.', any: ['3', 'tres'] },
  { id: 'd11', category: 'docx', doc: 'acta', prompt: '¿Cuál es el presupuesto de marketing aprobado en el acta?', any: ['30.000', '30000'] },
  { id: 'd12', category: 'docx', doc: 'acta', prompt: '¿A qué trimestre se pospuso el lanzamiento de la app móvil?', any: ['q3'] },
  { id: 'd13', category: 'docx', doc: 'acta', prompt: '¿Quién enviará el informe de ventas el viernes? Solo el nombre.', any: ['juan'] },
  { id: 'd14', category: 'docx', doc: 'acta', prompt: '¿Cuál es el marcador del acta?', any: ['actamark-3310'] },
  { id: 'd15', category: 'docx', doc: 'acta', prompt: '¿Cuándo es la próxima reunión según el acta?', any: ['17 de marzo', '17'] },

  // ── PDF: informe_seguridad.pdf ──
  { id: 'p1', category: 'pdf', doc: 'informe', prompt: '¿Cuál fue el uptime registrado en el informe? Solo el número con porcentaje.', any: ['99.95', '99,95'] },
  { id: 'p2', category: 'pdf', doc: 'informe', prompt: '¿Cuántas vulnerabilidades críticas se detectaron? Solo el número.', any: ['3', 'tres'] },
  { id: 'p3', category: 'pdf', doc: 'informe', prompt: '¿Cuántas vulnerabilidades de severidad media? Solo el número.', any: ['8', 'ocho'] },
  { id: 'p4', category: 'pdf', doc: 'informe', prompt: '¿Cada cuántos días se recomienda rotar las credenciales? Solo el número.', any: ['90'] },
  { id: 'p5', category: 'pdf', doc: 'informe', prompt: '¿Con qué algoritmo se recomienda cifrar las copias de seguridad?', any: ['aes-256', 'aes 256', 'aes256'] },
  { id: 'p6', category: 'pdf', doc: 'informe', prompt: '¿Cuál es el coste estimado de remediación?', any: ['12.500', '12500'] },
  { id: 'p7', category: 'pdf', doc: 'informe', prompt: '¿Cuál es el marcador del informe?', any: ['pdfmark-7731'] },
  { id: 'p8', category: 'pdf', doc: 'informe', prompt: 'Lista los tres controles evaluados.', all: ['firewall', 'backups', 'cifrado'] },
  { id: 'p9', category: 'pdf', doc: 'informe', prompt: '¿El informe recomienda autenticación de doble factor? Resume esa recomendación.', any: ['doble factor', '2fa', 'autenticacion'], judge: true },
  { id: 'p10', category: 'pdf', doc: 'informe', prompt: '¿Cuántas recomendaciones principales lista el informe? Solo el número.', any: ['3', 'tres'] },
  { id: 'p11', category: 'pdf', doc: 'informe', prompt: 'Resume el informe de seguridad en una sola frase.', any: ['uptime', 'vulnerab', '99.95', 'seguridad'], judge: true },
  { id: 'p12', category: 'pdf', doc: 'informe', prompt: '¿Qué severidades de vulnerabilidad menciona el informe?', any: ['critica', 'media'] },

  // ── Image OCR: factura_4485.png ──
  { id: 'i1', category: 'image', doc: 'factura', prompt: '¿Cuál es el número de factura de la imagen? Solo el número.', any: ['4485'] },
  { id: 'i2', category: 'image', doc: 'factura', prompt: '¿Quién es el cliente de la factura?', any: ['acme'] },
  { id: 'i3', category: 'image', doc: 'factura', prompt: '¿Cuál es el total de la factura? Solo el número.', any: ['1250', '1.250'] },
  { id: 'i4', category: 'image', doc: 'factura', prompt: '¿Qué fecha tiene la factura?', any: ['2025-03-15', '15'] },
  { id: 'i5', category: 'image', doc: 'factura', prompt: '¿Cuál es el concepto de la factura?', any: ['consultoria'] },
  { id: 'i6', category: 'image', doc: 'factura', prompt: '¿En qué moneda está expresado el total de la factura?', any: ['eur', 'euro'] },
  { id: 'i7', category: 'image', doc: 'factura', prompt: 'Resume la factura indicando número y total.', any: ['4485', '1250'], judge: true },
  { id: 'i8', category: 'image', doc: 'factura', prompt: '¿Cuánto es el total de la factura en cifras?', any: ['1250', '1.250'] },

  // ── Cross-document ──
  { id: 'x1', category: 'cross-doc', doc: ['contrato', 'informe'], prompt: 'Del contrato dime el proveedor, y del informe el uptime.', all: ['techsolutions', '99.95'] },
  { id: 'x2', category: 'cross-doc', doc: ['ventas', 'contrato'], prompt: '¿Cuál es mayor: el importe del contrato en EUR o el gran total de ventas? Da ambos números.', all: ['45', '2070'] },
  { id: 'x3', category: 'cross-doc', doc: ['acta', 'ventas'], prompt: 'Dame el presupuesto de marketing del acta y el total de la región Sur.', all: ['30', '375'] },
  { id: 'x4', category: 'cross-doc', doc: ['contrato', 'acta'], prompt: '¿Qué documento menciona a Acme Corp y cuál menciona a Juan?', all: ['contrato', 'acta'], judge: true },
  { id: 'x5', category: 'cross-doc', doc: ['informe', 'factura'], prompt: 'Del informe el coste de remediación y de la factura el total.', all: ['12.500', '1250'] },
  { id: 'x6', category: 'cross-doc', doc: ['ventas', 'informe'], prompt: '¿Cuántas regiones hay en la tabla de ventas y cuántas vulnerabilidades críticas en el informe?', all: ['4', '3'] },
  { id: 'x7', category: 'cross-doc', doc: ['contrato', 'ventas', 'informe'], prompt: 'Dame: proveedor del contrato, gran total de ventas y uptime del informe.', all: ['techsolutions', '2070', '99.95'] },
  { id: 'x8', category: 'cross-doc', doc: ['acta', 'contrato'], prompt: '¿Cuál es el importe del contrato y el presupuesto de marketing del acta?', all: ['45', '30'] },

  // ── Multi-turn context retention (turn 2+ does NOT re-attach the doc) ──
  {
    id: 'mt-contrato', category: 'multi-turn', turns: [
      { doc: 'contrato', prompt: '¿Cuál es el importe del contrato? Solo el número.', any: ['45.000', '45000'] },
      { prompt: '¿Y cuál es la vigencia del contrato?', any: ['12'] },
      { prompt: 'Multiplica ese importe por 2. Solo el número.', any: ['90.000', '90000'], judge: true },
    ],
  },
  {
    id: 'mt-ventas', category: 'multi-turn', turns: [
      { doc: 'ventas', prompt: '¿Qué región tuvo el mayor total? Solo el nombre.', any: ['este'] },
      { prompt: '¿Y cuál fue su total exacto? Solo el número.', any: ['820'] },
    ],
  },
  {
    id: 'mt-informe', category: 'multi-turn', turns: [
      { doc: 'informe', prompt: '¿Cuál fue el uptime del informe? Solo el número.', any: ['99.95'] },
      { prompt: '¿Y cuántas vulnerabilidades críticas?', any: ['3'] },
    ],
  },
  {
    id: 'mt-memoria', category: 'multi-turn', turns: [
      { prompt: 'Recuerda este código de proyecto: ZQ-7788. Confírmame que lo registraste mencionándolo.', any: ['zq-7788'] },
      { prompt: '¿Cuál era el código de proyecto que te di?', any: ['zq-7788'] },
    ],
  },
  {
    id: 'mt-acta', category: 'multi-turn', turns: [
      { doc: 'acta', prompt: '¿Quién enviará el informe el viernes? Solo el nombre.', any: ['juan'] },
      { prompt: '¿Y a qué trimestre se pospuso el lanzamiento?', any: ['q3'] },
    ],
  },

  // ── Reasoning (no doc) ──
  { id: 'r1', category: 'reasoning', prompt: 'Un tren recorre 90 km en 1.5 horas a velocidad constante. ¿Velocidad media en km/h? Solo el número.', any: ['60'] },
  { id: 'r2', category: 'reasoning', prompt: '¿Cuánto es 2 elevado a la 10? Solo el número.', any: ['1024'] },
  { id: 'r3', category: 'reasoning', prompt: 'Una camisa cuesta $40 tras un 20% de descuento. ¿Precio original? Solo el número.', any: ['50'] },
  { id: 'r4', category: 'reasoning', prompt: '¿Siguiente número en la serie 2, 6, 12, 20, 30, ...? Solo el número.', any: ['42'] },
  { id: 'r5', category: 'reasoning', prompt: 'Tengo 3 manzanas y compro 2 cajas con 6 manzanas cada una. ¿Total? Solo el número.', any: ['15'] },
  { id: 'r6', category: 'reasoning', prompt: '¿Cuántos minutos hay en 3.5 horas? Solo el número.', any: ['210'] },
  { id: 'r7', category: 'reasoning', prompt: 'Un número es 3 veces otro y juntos suman 48. ¿Cuál es el mayor? Solo el número.', any: ['36'] },
  { id: 'r8', category: 'reasoning', prompt: '¿Área de un rectángulo de 7 por 6? Solo el número.', any: ['42'] },
  { id: 'r9', category: 'reasoning', prompt: 'Reparto 17 caramelos entre 5 niños equitativamente. ¿Cuántos sobran? Solo el número.', any: ['2'] },
  { id: 'r10', category: 'reasoning', prompt: '¿Cuál es el 15% de 200? Solo el número.', any: ['30'] },
  { id: 'r11', category: 'reasoning', prompt: 'Si todos los A son B, y algunos B son C, ¿se sigue necesariamente que algunos A son C? Responde solo no o si y nada más.', any: ['no'] },
  { id: 'r12', category: 'reasoning', prompt: 'Ordena de mayor a menor estos números: 3, 11, 7.', any: ['11, 7, 3', '11,7,3', '11 7 3'] },

  // ── Multilingual ──
  { id: 'm1', category: 'multilingual', prompt: "Translate 'good morning' into French. Reply with ONLY the translation.", any: ['bonjour'] },
  { id: 'm2', category: 'multilingual', prompt: '日本の首都はどこですか？英語で一語で答えてください。', any: ['tokyo', 'tokio'] },
  { id: 'm3', category: 'multilingual', prompt: '¿Cuál es la capital de Alemania? Responde solo con una palabra.', any: ['berlin'] },
  { id: 'm4', category: 'multilingual', prompt: "Come si dice 'grazie' in spagnolo? Rispondi con UNA sola parola.", any: ['gracias'] },
  { id: 'm5', category: 'multilingual', prompt: "What language is the sentence 'Wie geht es dir?' written in? Reply with ONLY the language name in English.", any: ['german'] },
  { id: 'm6', category: 'multilingual', prompt: "Traduce al inglés: 'el gato negro'. Responde solo con la traducción.", any: ['black cat'] },
  { id: 'm7', category: 'multilingual', prompt: "Translate to Spanish: 'thank you very much'.", any: ['muchas gracias', 'gracias'] },
  { id: 'm8', category: 'multilingual', prompt: "¿Cómo se dice 'libro' en inglés? Una palabra.", any: ['book'] },
  { id: 'm9', category: 'multilingual', prompt: "Translate 'water' to German. One word.", any: ['wasser'] },
  { id: 'm10', category: 'multilingual', prompt: "¿En qué idioma está 'Bonjour le monde'? Responde el idioma en español.", any: ['frances'] },

  // ── Coding ──
  { id: 'c1', category: 'coding', prompt: "In Python, what does len('hello') return? Reply with ONLY the number.", any: ['5'] },
  { id: 'c2', category: 'coding', prompt: 'In JavaScript, what is the value of [10,2,1].sort()[0]? Reply with ONLY the value.', any: ['1'] },
  { id: 'c3', category: 'coding', prompt: 'Time complexity of binary search on a sorted array of n elements? Reply with ONLY the big-O notation.', any: ['o(log n)', 'o(logn)', 'log n', 'logarit'] },
  { id: 'c4', category: 'coding', prompt: 'In Python, what is 7 // 2 ? Reply with ONLY the number.', any: ['3'] },
  { id: 'c5', category: 'coding', prompt: 'In SQL, which keyword removes duplicate rows from a SELECT result? Reply with ONLY the keyword.', any: ['distinct'] },
  { id: 'c6', category: 'coding', prompt: 'What does JSON.stringify({a:1}) return in JavaScript? Reply with ONLY the exact string.', any: ['{"a":1}'] },
  { id: 'c7', category: 'coding', prompt: 'In Python, what does type([]) return? Reply with ONLY the type name.', any: ['list'] },
  { id: 'c8', category: 'coding', prompt: 'Which JavaScript array method adds an element to the end? Reply with ONLY the method name.', any: ['push'] },
  { id: 'c9', category: 'coding', prompt: 'Git: single command to create a new branch and switch to it.', any: ['checkout -b', 'switch -c'] },
  { id: 'c10', category: 'coding', prompt: 'In Python, what does print(2 ** 3) output? Reply with ONLY the number.', any: ['8'] },
  { id: 'c11', category: 'coding', prompt: "HTTP: which status code means 'Not Found'? Reply with ONLY the number.", any: ['404'] },
  { id: 'c12', category: 'coding', prompt: 'Write a Python function that returns the square of n.', any: ['def', 'return'], all: ['def', 'return'], judge: true },
];

module.exports = { CORPUS };
