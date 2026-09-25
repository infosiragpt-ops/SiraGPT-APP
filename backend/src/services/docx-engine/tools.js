'use strict';

/**
 * Tool layer of the docx engine: OpenAI-style function definitions plus
 * executors bound to one editing session. Plain module ({name, description,
 * input_schema, run}) so any loop — the chat's doc-agent loop today, the
 * provider-agnostic harness tomorrow — can register the same tools.
 *
 * Every executor returns a string. Failures come back as "ERROR: …" with the
 * reason and the next best action, so the model self-corrects instead of the
 * loop crashing.
 */

const { DocxOpError } = require('./ops');

const ID_HINT = 'Ids de doc_outline: p12 (párrafo), t0 (tabla), t0.r2 (fila), t0.r2.c1 (celda), h1.p0 (encabezado), f1.p0 (pie), sdt3 (control), cb0 (casilla).';

const TOOL_SPECS = [
  {
    name: 'doc_outline',
    description: `Estructura completa del documento con ids: párrafos, tablas (celda por celda, * = negrita, ⟷N = celda combinada horizontalmente, ↑fusionada = continuación vertical, ∅ = vacía), encabezados, pies, cuadros de texto, controles y casillas. Úsala primero y cada vez que necesites ids actualizados. ${ID_HINT}`,
    input_schema: {
      type: 'object',
      properties: { offset: { type: 'integer', description: 'Línea desde la que continuar si el esquema anterior quedó truncado.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'doc_read',
    description: 'Detalle de un párrafo, celda, fila, tabla o control: texto exacto y formato de cada fragmento (fuente, tamaño, negrita…). Úsala antes de editar texto con formato mixto.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: ID_HINT },
        xml: { type: 'boolean', description: 'true para ver también el XML (solo si es imprescindible).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'doc_find',
    description: 'Busca texto en todo el documento (cuerpo, tablas, encabezados, pies) y devuelve dónde aparece con su id.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar (sin distinguir mayúsculas).' },
        regex: { type: 'boolean', description: 'true si query es una expresión regular.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'fill_field',
    description: 'Completa un campo de formulario identificado por su etiqueta ("Apellidos y nombres del experto:", "DNI:", "Fecha:"). Pone el valor en la celda vacía a la derecha de la etiqueta si existe; si no, reemplaza la línea punteada/guiones o el valor que ya hubiera; si no, lo escribe justo después de la etiqueta, en formato normal (sin la negrita de la etiqueta). Conserva la fuente y el tamaño del documento.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Etiqueta tal como aparece en el documento.' },
        value: { type: 'string', description: 'Valor a escribir (ya corregido y bien escrito).' },
        occurrence: { type: 'integer', description: 'Si la etiqueta aparece varias veces, cuál (1 = primera).' },
        target: { type: 'string', description: 'Limitar la búsqueda a un id (celda, fila, tabla o parte h1/f1).' },
        bold: { type: 'boolean', description: 'Forzar negrita en el valor (por defecto no).' },
      },
      required: ['label', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_cell',
    description: 'Escribe el texto de una celda de tabla conservando su alineación, bordes, sombreado y el formato de texto de esa celda (o de su columna si está vacía). mode="replace" (defecto) sustituye el contenido; mode="append" lo agrega al final. "\\n" crea párrafos nuevos en la celda.',
    input_schema: {
      type: 'object',
      properties: {
        cell: { type: 'string', description: 'Id de celda, p. ej. t1.r3.c2.' },
        text: { type: 'string' },
        mode: { type: 'string', enum: ['replace', 'append'] },
        bold: { type: 'boolean' },
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        format_from: { type: 'string', description: 'Id de otra celda/párrafo cuyo formato de texto copiar.' },
      },
      required: ['cell', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_cells',
    description: 'Varias celdas en una sola llamada (ideal para matrices: marcar "X" en SÍ/NO de varios ítems, llenar una columna, vaciar celdas con text="").',
    input_schema: {
      type: 'object',
      properties: {
        cells: {
          type: 'array',
          items: {
            type: 'object',
            properties: { cell: { type: 'string' }, text: { type: 'string' }, bold: { type: 'boolean' }, align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] } },
            required: ['cell', 'text'],
            additionalProperties: false,
          },
        },
      },
      required: ['cells'],
      additionalProperties: false,
    },
  },
  {
    name: 'replace_text',
    description: 'Reemplaza un texto existente por otro (aunque esté partido en varios fragmentos de formato), conservando cada letra no modificada en su formato original. Si aparece varias veces, indica occurrence, target o all=true.',
    input_schema: {
      type: 'object',
      properties: {
        find: { type: 'string', description: 'Texto exacto actual.' },
        replace: { type: 'string', description: 'Texto nuevo ("" para borrar el fragmento).' },
        target: { type: 'string', description: 'Limitar a un id de párrafo/celda/fila/tabla o parte (h1, f1).' },
        occurrence: { type: 'integer' },
        all: { type: 'boolean' },
        match_case: { type: 'boolean' },
      },
      required: ['find', 'replace'],
      additionalProperties: false,
    },
  },
  {
    name: 'insert_paragraph',
    description: 'Inserta uno o más párrafos después (after) o antes (before) de un párrafo, copiando su estilo, sangría, espaciado y fuente (o los de style_from). "\\n" separa párrafos.',
    input_schema: {
      type: 'object',
      properties: {
        after: { type: 'string' },
        before: { type: 'string' },
        text: { type: 'string' },
        style_from: { type: 'string', description: 'Id de párrafo cuyo formato copiar.' },
        bold: { type: 'boolean' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'insert_table_row',
    description: 'Agrega una fila a una tabla clonando el diseño de una fila existente (bordes, anchos, sombreado) y llena sus celdas en orden.',
    input_schema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Id de tabla, p. ej. t1.' },
        after_row: { type: 'string', description: 'Fila tras la que insertar (p. ej. t1.r12 o r12). Por defecto, la última.' },
        clone_row: { type: 'string', description: 'Fila cuyo diseño copiar. Por defecto, after_row.' },
        cells: { type: 'array', items: { type: 'string' }, description: 'Texto de cada celda de la fila nueva, en orden.' },
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete',
    description: 'Elimina un párrafo, una fila o una tabla por id; o solo un fragmento de texto con "text" (opcionalmente dentro de target).',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string' }, text: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'set_format',
    description: 'Cambia formato de un párrafo, celda, fila o tabla (o solo de los fragmentos que contienen "text"): negrita, cursiva, subrayado, tamaño, color, resaltado, fuente, alineación, estilo de párrafo.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        text: { type: 'string' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        size_pt: { type: 'number' },
        color: { type: 'string', description: 'Hex RRGGBB.' },
        highlight: { type: 'string', enum: ['yellow', 'green', 'cyan', 'magenta', 'blue', 'red', 'lightGray', 'none'] },
        font: { type: 'string' },
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        style: { type: 'string', description: 'Id de estilo de párrafo existente (p. ej. Heading1).' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_checkbox',
    description: 'Marca o desmarca una casilla (control de contenido, campo de formulario o símbolo ☐/☒) por su id cbN.',
    input_schema: {
      type: 'object',
      properties: { checkbox: { type: 'string' }, checked: { type: 'boolean' } },
      required: ['checkbox', 'checked'],
      additionalProperties: false,
    },
  },
  {
    name: 'fill_content_control',
    description: 'Escribe en un control de contenido de Word (por id sdtN, etiqueta o título).',
    input_schema: {
      type: 'object',
      properties: { control: { type: 'string' }, text: { type: 'string' } },
      required: ['control', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'undo',
    description: 'Deshace la última operación de edición (si te equivocaste de celda o de texto).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'finish',
    description: 'Termina: verifica el archivo (integridad, que solo cambió lo editado, render a PDF con número de páginas y que tus valores se ven). Si la verificación reporta problemas, corrígelos y vuelve a llamar finish. status="cannot" si la petición no se puede cumplir con este documento (explica por qué en summary).',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'cannot'] },
        summary: { type: 'string', description: 'Para el usuario, en español: lista concreta de lo que cambiaste (campo → valor) y cualquier dato que no pudiste ubicar.' },
        expected_values: { type: 'array', items: { type: 'string' }, description: 'Los valores que escribiste, para comprobar que se ven en el documento.' },
      },
      required: ['status', 'summary'],
      additionalProperties: false,
    },
  },
];

const EDIT_TOOLS = new Set(['fill_field', 'set_cell', 'set_cells', 'replace_text', 'insert_paragraph', 'insert_table_row', 'delete', 'set_format', 'set_checkbox', 'fill_content_control']);

function toOpenAiTools(specs = TOOL_SPECS) {
  return specs.map((spec) => ({ type: 'function', function: { name: spec.name, description: spec.description, parameters: spec.input_schema } }));
}

function formatChanges(changes) {
  return changes.map((c) => {
    if (c.op === 'warning') return `AVISO: ${c.after}`;
    const label = c.label ? ` [${c.label}]` : '';
    return `OK ${c.op} ${c.target}${label}: «${c.before}» → «${c.after}»`;
  }).join('\n');
}

/**
 * Executors bound to a session. `onFinish` receives the finish args and must
 * return the verification text; the loop stops once it reports success.
 */
function makeDocxToolExecutors(session, { onFinish, onEdit = () => {} } = {}) {
  const history = [];
  const snapshot = () => session.snapshot();
  const restore = (snap) => session.restore(snap);
  const wrap = (fn) => async (args) => {
    try {
      return await fn(args || {});
    } catch (err) {
      if (err instanceof DocxOpError || err?.code?.startsWith?.('DOCX_ENGINE')) return `ERROR: ${err.message}`;
      return `ERROR: ${err?.message || String(err)}`;
    }
  };
  const executors = {
    doc_outline: wrap(({ offset = 0 }) => {
      const o = session.outline({ offset: Number(offset) || 0 });
      return `${o.text}${o.remaining > 0 ? `\n… (${o.remaining} líneas más: llama doc_outline con offset=${o.shownFrom + o.shown})` : ''}`;
    }),
    doc_read: wrap(({ id, xml = false }) => session.read(String(id || ''), { xml: Boolean(xml) })),
    doc_find: wrap(({ query, regex = false }) => {
      const found = session.find(String(query || ''), { regex: Boolean(regex) });
      return found.length ? found.join('\n') : `Sin resultados para «${query}».`;
    }),
    undo: wrap(() => {
      const last = history.pop();
      if (!last) return 'No hay operaciones que deshacer.';
      restore(last.snap);
      session.changes.splice(last.changeIndex);
      return `Deshice ${last.op}.`;
    }),
    finish: wrap(async (args) => onFinish(args || {})),
  };
  for (const name of EDIT_TOOLS) {
    executors[name] = wrap((args) => {
      const snap = snapshot();
      const changeIndex = session.changes.length;
      const recorded = session.apply(name, args);
      history.push({ op: name, snap, changeIndex });
      if (history.length > 10) history.shift();
      try { onEdit({ tool: name, changes: recorded }); } catch { /* UI relay only */ }
      return formatChanges(recorded);
    });
  }
  return executors;
}

module.exports = { TOOL_SPECS, EDIT_TOOLS, toOpenAiTools, makeDocxToolExecutors, formatChanges };
