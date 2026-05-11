'use strict';

/**
 * document-professional-analyzer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The "professional analyst" layer for attached documents. Sits between the
 * raw fileProcessor extractor + the chat prompt builder in `routes/ai.js`.
 *
 * Why this exists:
 *  - Before this module, every attached file reached the LLM as a plain
 *    `File: name\nContent: <extractedText>` block. The model had ZERO
 *    structural metadata (page count, sheets, OCR confidence, tables), no
 *    domain hint (legal vs financial vs CV vs scientific paper), and no
 *    profession-specific analysis recipe.
 *  - The default `ANALYZE_FILE` intent block in master-prompt.js was a
 *    9-line generic instruction ("structure as overview, schema, findings,
 *    next analyses"). Insufficient for professional output.
 *  - The high-quality `document-summarizer.js` (strict-JSON, gpt-4o-mini
 *    structured outputs) only ran when the user explicitly opened the
 *    `/api/files/:id/summary` view — never in the chat flow.
 *
 * What this module does, in one paragraph:
 *  Given the array of processedFiles the chat is about to inject, it
 *  (a) loads the DocumentAnalysis + DocumentTable rows persisted earlier
 *  by document-intelligence.js, (b) classifies each file into one of a
 *  dozen professional document types using deterministic keyword/structure
 *  heuristics, (c) builds a compact "## ATTACHED DOCUMENT PROFILE" block
 *  with file identity + structural metadata + table previews + cached LLM
 *  summary, (d) selects the strongest domain-specific analysis directive
 *  (e.g. legal-contract recipe vs financial-statement recipe vs academic-
 *  paper recipe) and emits it as a "## PROFESSIONAL ANALYSIS DIRECTIVE"
 *  block. The chat route concatenates these blocks AHEAD of the existing
 *  file context so the model sees structure + domain hint before reading
 *  raw text.
 *
 * Design constraints:
 *  - Synchronous & deterministic (no LLM call, no network). The module
 *    must add < 20 ms to the chat path on a warm DB.
 *  - Resilient: if Prisma is absent or DocumentAnalysis is missing, the
 *    module still returns useful blocks built purely from `processedFiles`.
 *  - Token-budget aware: every section has a hard cap; the entire
 *    enrichment never exceeds ~6000 chars even for 20 attached files.
 *
 * Public API:
 *   detectDocumentType(file, text)            → { type, confidence, signals }
 *   getProfessionalAnalysisDirective(type)    → markdown block
 *   buildDocumentProfileBlock(profiles)       → markdown block
 *   buildEnrichedFileContext({ prisma, processedFiles, language }) → {
 *     profileBlock, directiveBlock, tablesBlock, summariesBlock,
 *     primaryDocType, perFileProfile
 *   }
 */

const MAX_PROFILE_CHARS = Number.parseInt(process.env.SIRAGPT_DOC_PROFILE_MAX_CHARS || '6000', 10);
const MAX_TABLES_INJECTED = Number.parseInt(process.env.SIRAGPT_DOC_TABLES_INJECTED || '4', 10);
const MAX_TABLE_ROWS_PREVIEW = Number.parseInt(process.env.SIRAGPT_DOC_TABLE_ROWS_PREVIEW || '8', 10);
const MAX_SECTIONS_LISTED = Number.parseInt(process.env.SIRAGPT_DOC_SECTIONS_LISTED || '14', 10);

// ──────────────────────────────────────────────────────────────────────────
// Document type classification
// ──────────────────────────────────────────────────────────────────────────
//
// Each entry has:
//  - type:    canonical identifier used downstream
//  - weight:  how much to add to the score per signal hit
//  - name:    regex matched against the filename (lowercased, no ext)
//  - mime:    regex matched against the mime type
//  - body:    array of regex matched against the first 8 KB of text
//  - bodyMin: at least this many body regex must match to award the body
//             portion of the score (prevents single-keyword false positives)
//
// The classifier scans every entry, sums signals, and returns the highest
// score above MIN_CONFIDENCE_SCORE. Ties are broken by entry order (more
// specific types are listed first).

const TYPE_SIGNALS = [
  {
    type: 'invoice',
    weight: 3,
    name: /(invoice|factura|boleta|recibo|nota[- _]?de[- _]?venta)/i,
    body: [
      /\b(invoice|factura|boleta)\b/i,
      /\b(subtotal|total|tax|iva|igv|vat)\b/i,
      /\b(bill\s*to|invoice\s*to|cliente|customer)\b/i,
      /\b(invoice\s*number|n[uú]mero\s+de\s+factura|folio)\b/i,
      /\$\s?\d|€\s?\d|S\/\.?\s?\d|Bs\.?\s?\d|MX\$/,
    ],
    bodyMin: 2,
  },
  {
    type: 'legal_contract',
    weight: 3,
    name: /(contrato|contract|agreement|convenio|nda|t[eé]rminos|terms|tos|policy|pol[ií]tica)/i,
    body: [
      /\b(WHEREAS|POR\s+CUANTO|HEREBY|ENTRE\s+LAS\s+PARTES|BETWEEN\s+THE\s+PARTIES)\b/i,
      /\b(cl[aá]usula|clause|article|art[ií]culo|section|secci[oó]n)\s+\d+/i,
      /\b(party|parte|partes|parties|liability|responsabilidad|jurisdic|jurisdiction)\b/i,
      /\b(confidential|confidenciali?dad|disclos\w+|divulga\w+)\b/i,
      /\b(terminat\w+|rescind\w+|breach|incumplimiento|effective\s+date|fecha\s+efectiva)\b/i,
      /\b(signature|firma|signed\s+by|firmado\s+por)\b/i,
    ],
    bodyMin: 2,
  },
  {
    type: 'cv_resume',
    weight: 4,
    name: /(cv|curriculum|curr[ií]culum|resume|hoja[- _]?de[- _]?vida|resum[eé])/i,
    body: [
      /\b(experiencia\s+(laboral|profesional)|work\s+experience|professional\s+experience)\b/i,
      /\b(educaci[oó]n|education|estudios|academic\s+background)\b/i,
      /\b(habilidades|skills|competencias|competencies)\b/i,
      /\b(idiomas|languages)\b.{0,40}\b(ingl[eé]s|english|espa[nñ]ol|spanish|portugu[eé]s|portuguese|fluent|nativo|native)\b/i,
      /\b(linkedin|github|portfolio)\b/i,
      /\b(certificaciones?|certifications?)\b/i,
    ],
    bodyMin: 2,
  },
  {
    type: 'academic_paper',
    weight: 3,
    name: /(paper|article|art[ií]culo|tesis|thesis|disertaci[oó]n|disserta|preprint|manuscript)/i,
    body: [
      /\b(abstract|resumen)\b/i,
      /\b(introduction|introducci[oó]n|methods?|m[eé]todos?|methodology|metodolog[ií]a)\b/i,
      /\b(results?|resultados|discussion|discusi[oó]n|conclusi[oó]n|conclusions?)\b/i,
      /\b(references|referencias|bibliography|bibliograf[ií]a)\b/i,
      /\bdoi[:\s]/i,
      /\b(arxiv|p\.\s?\d+[-–]\d+|et\s+al\.?|cited\s+as)\b/i,
      /\b(et\s+al|figure\s+\d|figura\s+\d|table\s+\d|tabla\s+\d)\b/i,
    ],
    bodyMin: 3,
  },
  {
    type: 'financial_statement',
    weight: 3,
    name: /(balance|estado[- _]?financiero|estado[- _]?de[- _]?resultados|income[- _]?statement|cash[- _]?flow|p[- _]?l|presupuesto|budget)/i,
    body: [
      /\b(revenue|ingresos|sales|ventas)\b/i,
      /\b(expenses?|gastos|cost\s+of\s+goods|costo\s+de\s+ventas)\b/i,
      /\b(net\s+income|utilidad\s+neta|gross\s+profit|utilidad\s+bruta|operating\s+income)\b/i,
      /\b(EBITDA|EBIT|margin|margen|ROI|ROA|ROE)\b/i,
      /\b(assets|activos|liabilities|pasivos|equity|patrimonio|capital)\b/i,
      /\b(cash\s+flow|flujo\s+de\s+caja|flujo\s+de\s+efectivo)\b/i,
    ],
    bodyMin: 2,
  },
  {
    type: 'medical_clinical',
    weight: 3,
    name: /(historia[- _]?cl[ií]nica|informe[- _]?m[eé]dico|medical[- _]?record|patient|paciente|diagn[oó]stico|radiolog[ií]a)/i,
    body: [
      /\b(paciente|patient|history|historia)\b/i,
      /\b(diagn[oó]stico|diagnosis|diagnos[ie]d?)\b/i,
      /\b(tratamiento|treatment|therapy|terap[ií]a|medication|medicamento)\b/i,
      /\b(s[ií]ntomas?|symptoms?|sign[oa]s?\s+vital(es)?|vital\s+signs?)\b/i,
      /\b(allerg(ies|ias)|alerg(ias|ies))\b/i,
      /\b(dr\.|dra\.|m\.d\.|md|doctor|m[eé]dico)\b/i,
    ],
    bodyMin: 2,
  },
  {
    type: 'technical_spec',
    weight: 3,
    name: /(spec|specification|especificaci[oó]n|api|sdk|rfc|protocol|manual|documentation|docs|technical)/i,
    body: [
      /\b(endpoint|api\s+key|authentication|authorization|oauth|bearer)\b/i,
      /\b(request|response|payload|schema|json|xml|protobuf)\b/i,
      /\b(http|https|rest|graphql|websocket|grpc)\b/i,
      /\b(parameters?|par[aá]metros?|argument|argumento|return\s+value|valor\s+de\s+retorno)\b/i,
      /\b(version|versi[oó]n|deprecated|obsoleto|breaking\s+change)\b/i,
      /```|`[a-z_]+\(\)`/,
    ],
    bodyMin: 2,
  },
  {
    type: 'business_report',
    weight: 2,
    name: /(informe|report|memo|memorandum|reporte|brief|presentation|executive[- _]?summary)/i,
    body: [
      /\b(executive\s+summary|resumen\s+ejecutivo)\b/i,
      /\b(KPI|metrics?|m[eé]tricas?|dashboard)\b/i,
      /\b(strategy|estrategia|recomendaci[oó]n|recommendation|next\s+steps|pr[oó]ximos\s+pasos)\b/i,
      /\b(market\s+share|cuota\s+de\s+mercado|growth|crecimiento|forecast|pron[oó]stico)\b/i,
      /\b(stakeholder|interesado|client|cliente|customer)\b/i,
    ],
    bodyMin: 2,
  },
  {
    type: 'spreadsheet_data',
    weight: 4,
    mime: /(spreadsheet|excel|csv|tab[- _]?separated)/i,
    name: /\.(xlsx|xls|csv|tsv|ods)$/i,
    body: [
      /Sheet:\s*\S/i,
      /\t.+\t/,
      /^[A-Za-z][A-Za-z0-9_ ]+,[A-Za-z][A-Za-z0-9_ ]+,/m,
    ],
    bodyMin: 0,
  },
  {
    type: 'presentation_slides',
    weight: 4,
    mime: /(presentation|powerpoint)/i,
    name: /\.(pptx|ppt|odp|key)$/i,
    body: [/\bSlide\s+\d+\b/i, /\b(diapositiva|slide)\b/i],
    bodyMin: 0,
  },
  {
    type: 'email_message',
    weight: 3,
    mime: /(rfc822|outlook|email|message)/i,
    name: /\.(eml|msg|mbox)$/i,
    body: [
      /^(from|de):\s*\S/im,
      /^(to|para|cc):\s*\S/im,
      /^(subject|asunto):\s*\S/im,
      /^(date|fecha):\s*\S/im,
    ],
    bodyMin: 2,
  },
  {
    type: 'book_literature',
    weight: 2,
    name: /(novel|novela|libro|book|cuento|short[- _]?story|poema|poetry|verso)/i,
    body: [
      /\b(cap[ií]tulo|chapter|prologue|pr[oó]logo|epilogue|ep[ií]logo)\s+\d+/i,
      /^(?:[—–-]\s+|"|"|«|—)[A-Z][^.\n]{20,}/m,
    ],
    bodyMin: 1,
  },
  {
    type: 'image_document',
    weight: 4,
    mime: /^image\//i,
    body: [],
    bodyMin: 0,
  },
];

const MIN_CONFIDENCE_SCORE = 3;

/**
 * Detect the most probable professional document type for a file.
 *
 * The algorithm walks TYPE_SIGNALS in declared order, awarding `weight`
 * points for each of: mime-match, name-match, and body-match (only if
 * at least `bodyMin` body patterns hit). The highest scoring type above
 * MIN_CONFIDENCE_SCORE wins. If nothing crosses the threshold, returns
 * `general_document` with confidence 'low' and an empty signal list so
 * downstream callers can fall back to the generic professional recipe.
 *
 * @param {object} file - { originalName, filename, mimeType, type? }
 * @param {string} text - extracted text (only the first ~8 KB is scanned)
 * @returns {{ type: string, confidence: 'high'|'medium'|'low', score: number, signals: string[] }}
 */
function detectDocumentType(file, text) {
  const safeFile = (file && typeof file === 'object') ? file : {};
  const safeText = typeof text === 'string' ? text : '';
  const name = String(safeFile.originalName || safeFile.filename || safeFile.name || '').toLowerCase();
  const mime = String(safeFile.mimeType || safeFile.type || '').toLowerCase();
  const head = safeText.slice(0, 8000);

  let best = { type: 'general_document', score: 0, signals: [] };

  for (const entry of TYPE_SIGNALS) {
    let score = 0;
    const signals = [];

    if (entry.mime && mime && entry.mime.test(mime)) {
      score += entry.weight;
      signals.push(`mime:${mime}`);
    }
    if (entry.name && name && entry.name.test(name)) {
      score += entry.weight;
      signals.push(`name:${name}`);
    }
    if (Array.isArray(entry.body) && entry.body.length > 0 && head) {
      const hits = entry.body.filter((re) => re.test(head)).length;
      // Require BOTH conditions: hits ≥ bodyMin AND hits ≥ 1. Otherwise
      // an entry with bodyMin=0 would credit zero-hit files just for
      // having a body section declared — that was the original bug.
      const minHits = Math.max(entry.bodyMin ?? 1, 1);
      if (hits >= minHits) {
        score += entry.weight + hits;
        signals.push(`body:${hits}`);
      }
    }

    if (score > best.score) {
      best = { type: entry.type, score, signals };
    }
  }

  if (best.score < MIN_CONFIDENCE_SCORE) {
    return { type: 'general_document', confidence: 'low', score: best.score, signals: [] };
  }

  const confidence = best.score >= 7 ? 'high' : best.score >= 4 ? 'medium' : 'low';
  return { type: best.type, confidence, score: best.score, signals: best.signals };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-type professional analysis directives
// ──────────────────────────────────────────────────────────────────────────
//
// Each directive is a markdown block that gets appended to the system
// prompt when the corresponding type wins the classifier. The blocks
// are written in English for consistency with the rest of master-prompt
// but include explicit "respond in the user's language" reminders.

const DIRECTIVES = {
  legal_contract: `### LEGAL DOCUMENT ANALYSIS RECIPE
You are reading a contract, agreement, terms of service, or policy. Produce a deliverable a senior lawyer would sign off on. Cover:
1. **Parties & roles** — name every party, their role (provider/client/licensor/licensee/etc.), and registered address if present.
2. **Effective date, term, renewal & termination** — quote the verbatim dates and notice periods.
3. **Scope of obligations** — list each party's main commitments as a bulleted table (Party · Obligation · Trigger · Deadline).
4. **Consideration & payment terms** — amounts, currency, schedule, late-fee/interest, billing cadence.
5. **IP / data / confidentiality** — what is owned by whom, what stays confidential, for how long, with what carve-outs.
6. **Liability & indemnity** — caps, exclusions, mutual vs unilateral indemnity, insurance requirements.
7. **Governing law, venue, dispute resolution** — jurisdiction, arbitration vs courts, language of proceedings.
8. **Red flags (CRITICAL)** — any unilateral termination right, unlimited liability, auto-renewal trap, IP assignment of pre-existing material, broad non-compete, vague service levels. Flag each one with a 1-line risk explanation and the clause number.
9. **Missing or unusual clauses** — what a balanced contract of this type normally contains that is missing here (e.g. no force majeure, no audit right, no data-breach notice window).
10. **Negotiation suggestions** — 3–5 concrete edits the user could request, framed as "Replace X with Y because Z".
Cite every claim with the clause/article number ("Cl. 7.2", "Art. III §2"). Never paraphrase legal terms — quote them verbatim in italics. End with a 3-row summary table: Risk level (🔴/🟡/🟢) · Topic · Action.`,

  financial_statement: `### FINANCIAL DOCUMENT ANALYSIS RECIPE
You are reading a financial statement, budget, income/balance/cash-flow statement, or financial report. Produce a CFO-grade analysis. Cover:
1. **Document identification** — entity, fiscal period (start–end), reporting standard (IFRS/GAAP/local), currency, auditor (if shown).
2. **Headline numbers** — Revenue, Gross Profit, Operating Income, Net Income, Total Assets, Total Liabilities, Equity, Cash & Equivalents. One per row in a markdown table with absolute value + % YoY change if comparable period is present.
3. **Margin analysis** — Gross / Operating / Net margins, calculated explicitly (Margin = X/Y × 100), with one-line interpretation.
4. **Liquidity & solvency** — Current Ratio, Quick Ratio, Debt-to-Equity, Interest Coverage. Compute from the data, do not invent.
5. **Cash flow quality** — Operating CF vs Net Income (the "earnings quality" ratio), Free Cash Flow, capex intensity. Flag if OCF < NI.
6. **Working capital movements** — Days Sales Outstanding, Days Inventory, Days Payable Outstanding if balance-sheet detail allows.
7. **Notable line items** — anything > 10% of revenue or that moved > 20% YoY. List in order of materiality.
8. **Red flags** — going-concern language, qualified audit opinion, related-party transactions, sudden change in accounting policy, large goodwill write-down risk, off-balance items, deferred revenue spike.
9. **Trend & outlook** — if multi-period data is present, project the next period's revenue and margin trajectory in a 2-row table (linear extrapolation or YoY growth, state the method).
10. **Recommendations** — 3–5 actions for management/owner (cost discipline, refinance, working-capital release, etc.), each with the expected $ impact when computable.
Round monetary figures to the unit shown in the document (don't translate millions to units). Cite the page/sheet for every number ("p. 4", "Sheet: Balance, row 17"). End with an "Executive scorecard": Profitability · Liquidity · Solvency · Efficiency · Growth, each scored 1–5 with a one-line justification.`,

  academic_paper: `### ACADEMIC PAPER ANALYSIS RECIPE
You are reading a scientific paper, thesis, dissertation, or scholarly article. Produce a critical reading suitable for a PhD seminar. Cover:
1. **Citation** — full APA 7 reference (Author(s), Year, Title, Journal/Conf, vol(issue), pages, DOI).
2. **One-sentence claim** — what the authors argue the paper proves, in your own words but accurate.
3. **Research question & hypothesis** — verbatim if stated, otherwise reconstructed.
4. **Methodology** — design (experimental/observational/computational/theoretical), sample/dataset (n, source, inclusion criteria), instruments, statistical/analytic approach.
5. **Key results** — 3–7 bullets with the specific numbers (effect sizes, p-values, confidence intervals, accuracy/F1, etc.). Quote exact figures from tables.
6. **Strengths** — what the paper does well methodologically or conceptually (3 bullets).
7. **Limitations & threats to validity** — internal/external/construct/statistical validity issues, even if the authors don't mention them (3–5 bullets).
8. **Comparison to prior work** — does this confirm, contradict, or extend existing findings? Name 1–2 specific prior works.
9. **Practical / theoretical implications** — what changes if this paper is right? Who should care?
10. **Replication & future work** — what experiments would settle remaining doubts? What data/code is available?
Quote evidence with the section name ("§3.2 Methods", "Table 4", "Fig. 2"). Never invent results — if a number isn't in the document, say "not reported". End with a verdict line: "Recommend: cite / cite-with-caveats / skip" + 1 sentence why.`,

  medical_clinical: `### MEDICAL / CLINICAL DOCUMENT ANALYSIS RECIPE
**SAFETY FRAME (read before responding):** You are NOT a doctor and this output is NOT medical advice. Frame the analysis as an educational summary for a clinician/patient who will verify everything with a licensed professional. Cover:
1. **Document type** — discharge summary, lab report, imaging report, prescription, history, etc. Identify the issuing institution and date.
2. **Patient (de-identified)** — age range, sex, relevant demographics. **Do not reproduce full name, full DOB, ID numbers, or addresses** in the analysis — refer as "the patient".
3. **Presenting complaint & history** — what brought the patient in, relevant history, current medications, allergies.
4. **Findings** — vital signs, exam findings, lab values (highlight out-of-range with their reference interval), imaging findings, pathology.
5. **Diagnoses** — primary and secondary, with ICD codes if present. Distinguish confirmed vs differential.
6. **Treatment plan** — medications (name, dose, route, frequency), procedures, follow-up appointments.
7. **Red flags / urgent items** — abnormal labs needing acute follow-up, drug interactions, contraindications, allergies that conflict with prescribed meds.
8. **Patient-friendly explanation** — translate the clinical findings into 1 short paragraph a non-medical reader can understand.
9. **Questions for the clinician** — 3–5 practical questions the patient could ask their doctor (e.g. "What does the LDL of X mean for my cardiovascular risk?").
10. **Disclaimer** — close with one explicit line: *"Esta lectura no sustituye la consulta médica. Confirme cada dato y plan con un profesional de la salud."* (or English equivalent).
Cite findings with the exact section/row ("Lab panel, hemoglobina: 9.2 g/dL [13–17]"). Never speculate beyond what the document supports.`,

  cv_resume: `### CV / RESUME ANALYSIS RECIPE
You are reading a curriculum vitae / resume. Produce a recruiter-grade evaluation. Cover:
1. **Candidate snapshot** — name, current title, years of total experience (compute from earliest job), top 3 industries, location.
2. **Career arc** — chronological progression: did they grow in scope, change industries, take a leadership leap? Identify the inflection point.
3. **Hard skills** — technologies, languages, certifications, with the depth signal (years × number of roles using each).
4. **Soft skills & leadership** — team size led, budget owned, cross-functional initiatives.
5. **Quantified impact** — extract every number (% growth, $ saved, users acquired, latency reduced, etc.) into a markdown table: Achievement · Metric · Role/Period.
6. **Education & credentials** — degrees, institution prestige, additional certifications, languages.
7. **Gaps & inconsistencies** — unexplained employment gaps (> 4 months), title regressions, overlapping dates, suspiciously round metrics. Be specific, kind, factual.
8. **Fit assessment** — for each of: senior IC role, people-manager role, hands-on builder role, consulting role — score 1–5 with a one-line reason.
9. **CV quality** — formatting, clarity, length appropriateness for level, presence of LinkedIn/portfolio, use of action verbs, consistency.
10. **Concrete improvement suggestions** — 5 specific edits with before/after examples (e.g. *"'Worked on backend' → 'Owned billing service serving 12 M req/day, cut p99 latency from 480 ms to 95 ms over 6 months'"*).
End with a 2-sentence elevator pitch the candidate could use on LinkedIn or in a recruiter call.`,

  invoice: `### INVOICE / RECEIPT ANALYSIS RECIPE
You are reading an invoice, receipt, or bill. Produce a structured extract suitable for accounts-payable processing. Cover:
1. **Vendor** — legal name, tax ID (RUC/CIF/EIN/NIT), address, contact.
2. **Buyer** — legal name, tax ID, address.
3. **Invoice metadata** — invoice number, issue date, due date, payment terms (net 30 / net 60 / on receipt), purchase order / contract reference.
4. **Line items table** — markdown table with columns: # · Description · Qty · Unit price · Discount · Subtotal · Tax %. Include every line, do not summarise.
5. **Totals** — Subtotal, Discounts, Tax breakdown (per rate), Shipping, Grand Total, Amount due (if partial payment). Currency must match the source.
6. **Payment instructions** — bank account, SWIFT/IBAN, payment platform, QR/link, accepted methods.
7. **Tax compliance check** — is the tax rate consistent with the buyer/seller jurisdiction? Does the invoice carry the legally required fields (consecutive number, electronic signature, fiscal series)?
8. **Anomalies** — duplicate line items, math errors (Subtotal ≠ sum of lines), tax computed at unusual rates, missing fiscal data, dates inconsistent (invoice date after due date), unusually round numbers.
9. **Categorisation hint** — suggest a likely accounting category (OPEX / COGS / Capex / utilities / consulting / SaaS).
10. **Accounts payable workflow note** — 1–2 lines on how to process: "Match to PO #X, route to finance, schedule payment by DUE_DATE."
Quote numbers verbatim with their currency symbol. End with an "AP-ready summary" JSON block: \`{ "vendor": "...", "invoice_no": "...", "total": ..., "currency": "...", "due_date": "YYYY-MM-DD" }\`.`,

  business_report: `### BUSINESS REPORT ANALYSIS RECIPE
You are reading an executive memo, market analysis, strategy deck, project status, or business report. Produce a McKinsey-style synthesis. Cover:
1. **Executive summary** — 2 sentences max, answering "so what?".
2. **Context & purpose** — who commissioned it, what decision it supports, what time horizon.
3. **Headline KPIs** — 4–6 numbers that anchor the narrative, each with the comparison baseline (vs prior period / vs target / vs market).
4. **Key findings** — 5–7 bullets in MECE order (Market · Customer · Product · Operations · Finance · Risk), each with the supporting datum.
5. **Strategic implications** — what these findings change for the business (growth lever, cost lever, capability gap, defensive move).
6. **Risks & uncertainties** — 3–5 risks ranked by impact × likelihood, with the assumption that drives each.
7. **Options considered** — if the report compares paths/scenarios, lay them out in a markdown table: Option · Pros · Cons · Required investment · Expected outcome.
8. **Recommendations** — primary recommendation + 2 alternatives, each with the decision criterion that would tip the choice.
9. **Action plan** — 6-week / 6-month horizon, with owner and success metric per action.
10. **Open questions** — 3–5 things the report doesn't answer, framed as crisp questions the team should resolve.
Quote every datum with its source ("Slide 12", "p. 7", "Exhibit 3"). End with a 1-paragraph "what I would tell the CEO in the elevator" line.`,

  technical_spec: `### TECHNICAL SPECIFICATION / API DOC ANALYSIS RECIPE
You are reading a technical specification, API reference, RFC, SDK doc, or developer manual. Produce a senior-engineer-grade review. Cover:
1. **Identification** — product / service name, version, release date, maturity (alpha / beta / GA / deprecated).
2. **Scope & non-goals** — what this spec covers and (importantly) what it explicitly does NOT.
3. **Architecture overview** — components, request flow, persistence layer, sync vs async. One paragraph + a mermaid sequence/flow diagram if helpful.
4. **Authentication & authorization** — schemes supported, token lifetimes, scope/permission model, key rotation guidance.
5. **Endpoint / interface inventory** — markdown table: # · Method/Endpoint or Function · Purpose · Required scope · Idempotent? · Rate-limited? Cover every documented surface.
6. **Data models** — list every entity with its key fields, types, required vs optional, validation rules.
7. **Error contract** — error code map (HTTP/gRPC/domain), error envelope shape, retry semantics, idempotency keys.
8. **Quality attributes** — rate limits, SLA, latency targets, throughput limits, data residency, regional availability.
9. **Migration & versioning** — backwards-compat policy, deprecation timeline, breaking-change history.
10. **Developer experience gaps** — missing examples, ambiguous wording, undocumented edge cases, fields without enums, retry advice that contradicts idempotency. List them as actionable doc improvement issues.
Quote every claim with the section heading ("§ 4.2 Pagination", "Errors → 429"). End with an "Integration checklist" of 8–12 steps a new integrator should follow in order.`,

  spreadsheet_data: `### SPREADSHEET / DATA ANALYSIS RECIPE
You are reading a spreadsheet, CSV, or tabular dataset. Produce a data-analyst-grade report. Cover:
1. **Dataset identification** — file name, sheet name(s) you analysed, total rows × columns per sheet.
2. **Schema** — markdown table: Column · Type (text/integer/float/date/boolean) · Sample values · % non-null · cardinality (distinct values) · likely role (id / measure / dimension / date).
3. **Descriptive statistics for numeric columns** — count, mean, median, std-dev, min, max, IQR. One markdown table.
4. **Top categories for categorical columns** — top 5 values with frequencies and % of total. One section per categorical column (≤ 8 sections).
5. **Time analysis (if date column present)** — date range, gaps, granularity (daily / weekly / monthly), seasonality hint.
6. **Key relationships** — observed correlations (only state direction + strength qualitatively, since you can't compute precise r), suspected hierarchies (X rolls up into Y).
7. **Data quality issues** — duplicates, missing values, inconsistent formatting, outliers (> 3 σ or > 1.5 × IQR), suspicious patterns (all-zero rows, future dates, mixed currencies).
8. **Aggregated insights** — 5 concrete findings the data implies (e.g. "70 % of revenue concentrated in 3 customers", "Region X grew 28 % QoQ").
9. **Recommended next analyses** — 3–5 follow-up questions / charts / pivot tables a stakeholder should request next.
10. **Caveats** — what your read cannot reveal (e.g. you have only the first 5000 rows of a 200k-row file, or you can't compute true correlations without numeric processing).
Always reference cells/columns by their actual names ("Sheet: Sales, column 'Unit Price'"), never by Excel coordinates unless they're in the data. End with a "Top-3 charts to build" list.`,

  presentation_slides: `### PRESENTATION / SLIDES ANALYSIS RECIPE
You are reading slides exported from PowerPoint / Keynote / Slides. Produce a deck-review the author can act on. Cover:
1. **Deck metadata** — title, total slides, author / presenter if present, date.
2. **Storyline arc** — does the deck follow a clear narrative (Problem → Insight → Solution → Ask)? Map each slide to one arc stage.
3. **Slide-by-slide outline** — for every slide: # · Type (title / content / data / quote / call-to-action) · 1-line takeaway. Compact markdown table.
4. **Headline messages** — list the 5–8 most important assertions across the deck.
5. **Quantitative claims** — every number with its slide reference and the comparison context (is it growth? share? cost? per unit?).
6. **Visual & layout critique** — slides that overflow with text, missing chart titles, inconsistent fonts, hard-to-read color combinations. Cite specific slide numbers.
7. **Logical gaps** — claims without evidence, transitions that don't follow, double-counted numbers, mismatched timeframes.
8. **Audience fit** — is the level (executive / technical / client / internal) consistent with the depth? Suggest cuts if too detailed or expansion if too thin.
9. **The "ask" slide** — does the deck end with a clear ask/decision/next step? If not, draft one.
10. **Top 5 edits to ship** — concrete slide-level edits in priority order ("Slide 7: split the 12-bullet list into a 3-row table; Slide 11: replace the screenshot with a single KPI tile").
Cite every observation with the slide number ("Slide 4", "Slide 11"). End with a "Net-promoter line": would you sit through this deck again, and why.`,

  email_message: `### EMAIL / MESSAGE ANALYSIS RECIPE
You are reading an email, mailbox file (eml / msg / mbox), or message thread. Cover:
1. **Conversation map** — who wrote to whom, in what order. List with timestamps if visible.
2. **Subject & purpose** — the main subject + the implicit purpose ("informative", "decision-needed", "escalation", "social").
3. **Key points per message** — one bullet per message: From → To · Time · 1-sentence summary.
4. **Action items extracted** — markdown table: Owner · Action · Due date · Source message #.
5. **Decisions reached** — explicit decisions vs open threads still pending consensus.
6. **Tone analysis** — neutral / cordial / escalating / passive-aggressive / urgent. Note shifts between messages.
7. **Attachments & links** — list and describe (if attachment content is visible) or flag as unknown.
8. **Risks / sensitivities** — anything that looks like a confidentiality leak, a regulatory tripwire, or a future-dispute exhibit.
9. **Suggested reply** — draft a concise, professional reply that closes loops or asks the right clarifying questions, in the same language as the thread.
10. **Filing / categorisation hint** — suggest a label/folder ("Customer · Support · Refund Request").
Never invent message content. Quote subjects and from/to verbatim.`,

  book_literature: `### LITERARY WORK ANALYSIS RECIPE
You are reading a book, novel, short story, poem, or literary excerpt. Cover:
1. **Bibliographic identity** — title, author, genre, period, original language (if translated).
2. **Plot synopsis** — 3 paragraphs: setup, escalation, resolution (without major spoilers if obviously requested as a non-spoiler read; otherwise full).
3. **Characters** — list main characters with their role, motivation, and arc in 1 line each.
4. **Themes** — 3–5 central themes with one supporting passage each (quoted verbatim, < 40 words).
5. **Setting & atmosphere** — time, place, mood, and how the author builds it.
6. **Narrative technique** — POV, tense, structure (linear / fragmented / framed), notable stylistic choices (stream of consciousness, magical realism, epistolary…).
7. **Symbolism & motifs** — recurring images and what they likely represent.
8. **Quoted passages worth keeping** — 3–5 short quotes with their location, each annotated with why it matters.
9. **Critical reception cues** — internal evidence of where this book sits in the literary landscape (no fabricated reviews — only inferences from the text).
10. **Discussion questions** — 5 questions a book-club could use, each tied to a theme or character.
For poetry: also include meter / rhyme scheme / volta location if applicable.`,

  image_document: `### DOCUMENT IMAGE ANALYSIS RECIPE
The attached file is an image (photograph or scanned page). Treat the OCR output as the primary input — if OCR confidence is low, say so before analysis. Cover:
1. **Image identification** — is this a photograph of a real-world scene, a scan of a printed/handwritten document, a screenshot, a chart, a diagram, or a meme?
2. **Visible text (verbatim)** — transcribe every legible piece of text in reading order. Use [illegible] when OCR failed on a span. If text contains math, render with LaTeX delimiters.
3. **Structural elements** — headings, tables (transcribe as markdown), bullet lists, captions, signatures, stamps, page numbers.
4. **Visual elements** — diagrams, charts, photos, logos. Describe each in 1 line and quote any title/legend.
5. **Inferred document type** — invoice / receipt / ID / form / report page / slide / handwritten note / etc. — and the language(s) detected.
6. **Quality flags** — blur, skew, missing edges, glare, low contrast, mixed handwriting + print. Estimate if a higher-resolution scan is needed.
7. **Privacy red flags** — visible PII (full name, ID number, address, signature). Recommend redaction before sharing.
8. **Suggested action** — what the user most likely wants to do next: extract data, file it, redact and resend, run through an OCR-improvement step, etc.
For mathematical or scientific images, transcribe equations with $...$ inline / $$...$$ display LaTeX and explain the equation's meaning briefly.`,

  general_document: `### PROFESSIONAL DOCUMENT ANALYSIS RECIPE
You are reading a document whose specific category could not be classified with confidence. Apply this general professional-analyst recipe. Cover:
1. **Document identity** — title, apparent type (article / memo / instructions / notes / report / letter / etc.), language, length, structural anchors visible (headings, pages, sheets, slides).
2. **One-sentence overview** — what this document is and why it exists, in plain language.
3. **Detailed structure** — list the sections / chapters / pages in order with a 1-line summary each. Use a markdown table when there are > 5 sections.
4. **Key facts & numbers** — every concrete datum (date, amount, quantity, name, place, percentage) with its source location.
5. **Named entities** — people, organisations, places, products, dates — grouped in a compact table.
6. **Central claims & supporting evidence** — 4–8 most important statements, each with a verbatim quote (< 30 words) that backs it.
7. **Tone & audience** — formal / informal / technical / commercial, intended reader.
8. **Strengths & weaknesses** — what the document does well + what it omits, contradicts, or leaves ambiguous.
9. **What the reader should do with this** — 3–5 concrete next actions a professional would take after reading.
10. **Open questions** — what important questions remain unanswered by the text.
Cite locations consistently ("p. 4", "§2", "Sheet: X, row 17", "Slide 6"). Never invent content not in the document. Respond in the same language as the document unless the user explicitly asks otherwise.`,
};

/**
 * Return the markdown directive block for a given document type.
 * Falls back to general_document if the type is not recognised.
 *
 * @param {string} type
 * @returns {string}
 */
function getProfessionalAnalysisDirective(type) {
  return DIRECTIVES[type] || DIRECTIVES.general_document;
}

// ──────────────────────────────────────────────────────────────────────────
// DocumentAnalysis hydration
// ──────────────────────────────────────────────────────────────────────────

/**
 * Hydrate DocumentAnalysis + DocumentTable rows from Prisma for the given
 * file ids. Returns a Map keyed by fileId. Tolerates Prisma errors,
 * missing tables, and absent analyses.
 *
 * @param {object|null} prisma
 * @param {string[]} fileIds
 * @returns {Promise<Map<string, { analysis: object|null, tables: object[] }>>}
 */
async function loadAnalysesByFileId(prisma, fileIds = []) {
  const out = new Map();
  if (!prisma || !Array.isArray(fileIds) || fileIds.length === 0) return out;
  const ids = fileIds.filter((id) => typeof id === 'string' && id);
  if (ids.length === 0) return out;

  try {
    if (!prisma.documentAnalysis?.findMany) return out;
    const analyses = await prisma.documentAnalysis.findMany({
      where: { fileId: { in: ids } },
      select: {
        id: true,
        fileId: true,
        status: true,
        language: true,
        mimeType: true,
        pageCount: true,
        sheetCount: true,
        slideCount: true,
        charCount: true,
        chunkCount: true,
        tableCount: true,
        summary: true,
        textCoverage: true,
        ocr: true,
        warnings: true,
        metadata: true,
        updatedAt: true,
      },
    }).catch(() => []);

    const analysisIds = analyses.map((a) => a.id).filter(Boolean);
    let tablesByAnalysis = new Map();
    if (analysisIds.length > 0 && prisma.documentTable?.findMany) {
      const tables = await prisma.documentTable.findMany({
        where: { analysisId: { in: analysisIds } },
        orderBy: [{ analysisId: 'asc' }, { ordinal: 'asc' }],
        select: {
          id: true,
          analysisId: true,
          fileId: true,
          ordinal: true,
          sourceType: true,
          sourceLabel: true,
          pageNumber: true,
          sheetName: true,
          slideNumber: true,
          title: true,
          columns: true,
          rowCount: true,
          preview: true,
          markdown: true,
        },
      }).catch(() => []);
      for (const table of tables) {
        if (!table.analysisId) continue;
        if (!tablesByAnalysis.has(table.analysisId)) tablesByAnalysis.set(table.analysisId, []);
        tablesByAnalysis.get(table.analysisId).push(table);
      }
    }

    for (const analysis of analyses) {
      out.set(analysis.fileId, {
        analysis,
        tables: tablesByAnalysis.get(analysis.id) || [],
      });
    }
  } catch {
    // swallow — caller falls back to plain extractedText
  }

  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Block builders
// ──────────────────────────────────────────────────────────────────────────

function humanBytes(num) {
  const n = Number(num) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function describeLanguage(code) {
  if (!code) return null;
  const map = { es: 'Spanish', en: 'English', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian' };
  return map[code] || code.toUpperCase();
}

function describeOcr(ocr) {
  if (!ocr || typeof ocr !== 'object') return null;
  const status = ocr.status || null;
  if (!status || status === 'skipped' || status === 'not_required') return null;
  const conf = typeof ocr.confidence === 'number' ? ` (${Math.round(ocr.confidence * 100)}%)` : '';
  const provider = ocr.provider ? `, provider=${ocr.provider}` : '';
  return `OCR ${status}${conf}${provider}`;
}

function summariseStructure(analysis) {
  if (!analysis) return null;
  const parts = [];
  if (Number(analysis.pageCount) > 0) parts.push(`${analysis.pageCount} pages`);
  if (Number(analysis.sheetCount) > 0) parts.push(`${analysis.sheetCount} sheets`);
  if (Number(analysis.slideCount) > 0) parts.push(`${analysis.slideCount} slides`);
  if (Number(analysis.chunkCount) > 0) parts.push(`${analysis.chunkCount} chunks`);
  if (Number(analysis.tableCount) > 0) parts.push(`${analysis.tableCount} tables`);
  return parts.length ? parts.join(', ') : null;
}

function safeJsonValue(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function tableToMiniMarkdown(table) {
  if (!table) return '';
  const md = typeof table.markdown === 'string' ? table.markdown.trim() : '';
  if (md) {
    const lines = md.split('\n').slice(0, MAX_TABLE_ROWS_PREVIEW + 2); // header + sep + N rows
    return lines.join('\n');
  }
  // Reconstruct from columns + preview rows if markdown wasn't stored.
  const cols = Array.isArray(table.columns) ? table.columns : [];
  const preview = Array.isArray(table.preview) ? table.preview : (safeJsonValue(table.preview) || []);
  if (cols.length === 0 || preview.length === 0) return '';
  const headers = `| ${cols.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const rows = preview.slice(0, MAX_TABLE_ROWS_PREVIEW).map((row) => {
    const cells = Array.isArray(row)
      ? row
      : cols.map((c) => row?.[c] ?? '');
    return `| ${cells.map((cell) => String(cell ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;
  });
  return [headers, sep, ...rows].join('\n');
}

function buildPerFileProfile({ file, classification, hydrated }) {
  const lines = [];
  const analysis = hydrated?.analysis || null;
  const tables = hydrated?.tables || [];

  const title = file.originalName || file.name || file.filename || file.id || 'Document';
  lines.push(`### ${title}`);
  const ident = [];
  if (file.mimeType) ident.push(`type=${file.mimeType}`);
  if (file.size) ident.push(`size=${humanBytes(file.size)}`);
  ident.push(`detected=${classification.type} (confidence: ${classification.confidence})`);
  lines.push(`- Identity: ${ident.join(' · ')}`);

  const structure = summariseStructure(analysis);
  if (structure) lines.push(`- Structure: ${structure}`);

  const language = describeLanguage(analysis?.language) || (file.extractedText ? null : null);
  if (language) lines.push(`- Language: ${language}`);

  const coverage = safeJsonValue(analysis?.textCoverage);
  if (coverage) {
    const charCount = coverage.charCount ?? analysis?.charCount ?? null;
    const coverageRatio = typeof coverage.extractionCoverage === 'number'
      ? `${Math.round(coverage.extractionCoverage * 100)}% useful chars`
      : null;
    const parts = [];
    if (charCount != null) parts.push(`${charCount.toLocaleString('en-US')} chars`);
    if (coverageRatio) parts.push(coverageRatio);
    if (parts.length > 0) lines.push(`- Extraction: ${parts.join(' · ')}`);
  } else if (typeof file.extractedText === 'string') {
    lines.push(`- Extraction: ${file.extractedText.length.toLocaleString('en-US')} chars`);
  }

  const ocrLine = describeOcr(safeJsonValue(analysis?.ocr));
  if (ocrLine) lines.push(`- ${ocrLine}`);

  const warnings = safeJsonValue(analysis?.warnings);
  if (Array.isArray(warnings) && warnings.length > 0) {
    const msgs = warnings.slice(0, 3).map((w) => (w && (w.message || w.code)) || null).filter(Boolean);
    if (msgs.length > 0) lines.push(`- Warnings: ${msgs.join(' · ')}`);
  }

  // Cached LLM summary if document-summarizer ran on this file at some point.
  const metadata = safeJsonValue(analysis?.metadata);
  const llmSummary = metadata?.llmSummary || null;
  if (llmSummary && typeof llmSummary === 'object') {
    if (llmSummary.tldr) lines.push(`- TL;DR (cached): ${String(llmSummary.tldr).slice(0, 320)}`);
    if (Array.isArray(llmSummary.keyPoints) && llmSummary.keyPoints.length > 0) {
      const top = llmSummary.keyPoints.slice(0, 5).map((kp) => `  - ${String(kp).slice(0, 200)}`).join('\n');
      lines.push(`- Cached key points:\n${top}`);
    }
  } else if (analysis?.summary) {
    lines.push(`- Heuristic summary: ${String(analysis.summary).slice(0, 320)}`);
  }

  // Inject up to MAX_TABLES_INJECTED tables (small ones) as markdown so the
  // model sees actual numbers, not just "12 tables present".
  if (tables.length > 0) {
    const injected = tables.slice(0, MAX_TABLES_INJECTED);
    lines.push(`- Tables (showing ${injected.length} of ${tables.length}):`);
    for (const t of injected) {
      const label = t.title || t.sourceLabel || `Table ${t.ordinal}`;
      const location = [
        t.sheetName ? `sheet=${t.sheetName}` : null,
        t.pageNumber != null ? `page=${t.pageNumber}` : null,
        t.slideNumber != null ? `slide=${t.slideNumber}` : null,
      ].filter(Boolean).join(' · ');
      lines.push(`  - **${label}** ${location ? `(${location})` : ''} — ${Number(t.rowCount) || 0} rows × ${Array.isArray(t.columns) ? t.columns.length : 0} cols`);
      const md = tableToMiniMarkdown(t);
      if (md) {
        // Indent the markdown table 4 spaces so it stays inside the bullet.
        lines.push(md.split('\n').map((l) => `    ${l}`).join('\n'));
      }
    }
  }

  return lines.join('\n');
}

/**
 * Pick the dominant classification across all attached files. Used to
 * choose the single PROFESSIONAL ANALYSIS DIRECTIVE block. Returns
 * `general_document` if files disagree without a clear winner.
 */
function pickPrimaryType(classifications) {
  if (!Array.isArray(classifications) || classifications.length === 0) {
    return 'general_document';
  }
  const score = new Map();
  for (const c of classifications) {
    const weight = c.confidence === 'high' ? 3 : c.confidence === 'medium' ? 2 : 1;
    score.set(c.type, (score.get(c.type) || 0) + weight);
  }
  let bestType = 'general_document';
  let bestScore = 0;
  for (const [type, value] of score.entries()) {
    if (value > bestScore && type !== 'general_document') {
      bestType = type;
      bestScore = value;
    }
  }
  // If only general_document found, return general.
  if (bestScore === 0) {
    return classifications[0]?.type || 'general_document';
  }
  return bestType;
}

/**
 * Main entry point. Inspect the processedFiles, hydrate Prisma metadata
 * where possible, classify each, and emit the markdown blocks the chat
 * route will splice into the prompt.
 *
 * @param {object} opts
 * @param {object|null} opts.prisma - prisma client or null
 * @param {Array<object>} opts.processedFiles - [{ id, name, originalName, extractedText, mimeType, type, ... }]
 * @returns {Promise<{
 *   profileBlock: string,         // "## ATTACHED DOCUMENT PROFILE\n..."
 *   directiveBlock: string,       // "## PROFESSIONAL ANALYSIS DIRECTIVE\n..."
 *   primaryDocType: string,
 *   perFileProfile: Array<{ fileId: string, type: string, confidence: string }>
 * }>}
 */
async function buildEnrichedFileContext({ prisma = null, processedFiles = [] } = {}) {
  const files = Array.isArray(processedFiles) ? processedFiles : [];
  if (files.length === 0) {
    return {
      profileBlock: '',
      directiveBlock: '',
      primaryDocType: 'general_document',
      perFileProfile: [],
    };
  }

  const fileIds = files.map((f) => f && f.id).filter((id) => typeof id === 'string' && id);
  const hydratedById = await loadAnalysesByFileId(prisma, fileIds);

  const classifications = [];
  const profiles = [];

  for (const file of files) {
    if (!file) continue;
    const hydrated = (file.id && hydratedById.get(file.id)) || null;
    const text = String(file.extractedText || '');
    const classification = detectDocumentType(file, text);
    classifications.push(classification);
    profiles.push({
      fileId: file.id || null,
      classification,
      profile: buildPerFileProfile({ file, classification, hydrated }),
    });
  }

  const primaryDocType = pickPrimaryType(classifications);
  const profileBlock = renderProfileBlock(profiles);
  const directiveBlock = renderDirectiveBlock(primaryDocType, classifications.length);

  return {
    profileBlock,
    directiveBlock,
    primaryDocType,
    perFileProfile: profiles.map((p) => ({
      fileId: p.fileId,
      type: p.classification.type,
      confidence: p.classification.confidence,
    })),
  };
}

function renderProfileBlock(profiles) {
  if (!profiles || profiles.length === 0) return '';
  const heading = `## ATTACHED DOCUMENT PROFILE
The following blocks describe each attached file BEFORE the raw extracted text. Use this metadata to ground your analysis: cite the page/sheet/slide for every quoted claim, treat the detected document type as a hint (not a verdict), and prefer evidence from the SIRA EVIDENCE RUNTIME block over assumptions.`;
  const body = profiles.map((p) => p.profile).join('\n\n');
  const combined = `${heading}\n\n${body}`;
  if (combined.length <= MAX_PROFILE_CHARS) return combined;
  // Truncate trailing files if we exceeded the budget, preserving headings.
  const truncated = combined.slice(0, MAX_PROFILE_CHARS - 80);
  return `${truncated}\n\n[...profile block truncated to stay within token budget]`;
}

function renderDirectiveBlock(primaryDocType, fileCount) {
  const directive = getProfessionalAnalysisDirective(primaryDocType);
  const multiNote = fileCount > 1
    ? `\n\n**Multi-file note:** ${fileCount} files attached. Apply this recipe to the dominant one and provide a compact cross-file synthesis at the end (commonalities, differences, contradictions).`
    : '';
  return `## PROFESSIONAL ANALYSIS DIRECTIVE
Document type detected: \`${primaryDocType}\`. Use the recipe below as the BACKBONE of your analytical answer when the user asks anything analytical about the attachment(s). For non-analytical follow-up questions (e.g. "translate this paragraph", "rewrite this section"), keep the user's literal request as the primary goal and only borrow from this recipe where it genuinely helps.

${directive}${multiNote}`;
}

module.exports = {
  detectDocumentType,
  getProfessionalAnalysisDirective,
  buildEnrichedFileContext,
  loadAnalysesByFileId,
  pickPrimaryType,
  // Exposed for unit tests
  _internal: {
    TYPE_SIGNALS,
    DIRECTIVES,
    MIN_CONFIDENCE_SCORE,
    tableToMiniMarkdown,
    buildPerFileProfile,
    renderProfileBlock,
    renderDirectiveBlock,
  },
};
