'use strict';

const { toCents, fromCents, sumCents } = require('./money');

// PCGE elements (clases) 1..9.
const VALID_ELEMENTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Validate a set of journal lines for double-entry correctness.
 * Invariants enforced:
 *   - at least 2 lines,
 *   - every line is a pure debit OR a pure credit (never both), non-negative,
 *   - Σ debit (debe) === Σ credit (haber) to the cent.
 * @param {Array<{debit?:number, credit?:number}>} lines
 * @returns {{balanced:boolean,totalDebit:number,totalCredit:number,difference:number,lineCount:number,errors:string[]}}
 */
function validateBalanced(lines) {
  const ls = Array.isArray(lines) ? lines : [];
  const debitCents = sumCents(ls.map((l) => (l && l.debit) || 0));
  const creditCents = sumCents(ls.map((l) => (l && l.credit) || 0));
  const diffCents = debitCents - creditCents;

  const errors = [];
  if (ls.length < 2) errors.push('Un asiento requiere al menos 2 líneas (cargo y abono).');

  ls.forEach((l, i) => {
    const d = toCents((l && l.debit) || 0);
    const c = toCents((l && l.credit) || 0);
    if (d < 0 || c < 0) errors.push(`Línea ${i + 1}: los importes no pueden ser negativos.`);
    if (d > 0 && c > 0) errors.push(`Línea ${i + 1}: una línea no puede tener debe y haber a la vez.`);
    if (d === 0 && c === 0) errors.push(`Línea ${i + 1}: la línea no tiene importe.`);
  });

  if (diffCents !== 0) {
    errors.push(`El total del debe (${fromCents(debitCents).toFixed(2)}) no es igual al del haber (${fromCents(creditCents).toFixed(2)}).`);
  }

  return {
    balanced: errors.length === 0,
    totalDebit: fromCents(debitCents),
    totalCredit: fromCents(creditCents),
    difference: fromCents(diffCents),
    lineCount: ls.length,
    errors,
  };
}

/** Throw a typed error when the lines are not a balanced double-entry. */
function assertBalanced(lines) {
  const result = validateBalanced(lines);
  if (!result.balanced) {
    const err = new Error(result.errors.join(' ') || 'Asiento contable descuadrado.');
    err.code = 'UNBALANCED_ENTRY';
    err.details = result;
    throw err;
  }
  return result;
}

/** First digit of a PCGE code → element/clase (1..9). NaN when invalid. */
function accountElement(code) {
  const c = String(code == null ? '' : code).trim();
  return c ? Number(c[0]) : NaN;
}

/** Hierarchy depth of a PCGE code (digit count): "1"→1, "10"→2, "1011"→4. */
function accountLevel(code) {
  return String(code == null ? '' : code).trim().length;
}

/** Parent PCGE code (one digit shorter), or null for an element. */
function parentCode(code) {
  const c = String(code == null ? '' : code).trim();
  return c.length <= 1 ? null : c.slice(0, -1);
}

function isValidElement(element) {
  return VALID_ELEMENTS.includes(Number(element));
}

module.exports = {
  validateBalanced,
  assertBalanced,
  accountElement,
  accountLevel,
  parentCode,
  isValidElement,
  VALID_ELEMENTS,
};
