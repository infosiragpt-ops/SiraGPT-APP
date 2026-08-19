'use strict';

const autoFileBridge = require('./auto-file-bridge');
const deepDocumentAnalyzer = require('./deep-document-analyzer');
const activeMemory = require('./active-memory');
const sessionManager = require('./session-manager');
const skillsRegistry = require('./skills-registry');
const skillsExecutor = require('./skills-executor');
const contextIntelligence = require('./context-intelligence-engine');

const MAX_COWORK_BLOCK_CHARS = Number.parseInt(process.env.SIRAGPT_COWORK_BLOCK_MAX_CHARS || '4000', 10);

// Static preamble: identical on every turn, never depends on userId/opts.
// Built once at module load instead of re-pushing ~45 string literals and
// re-joining on every chat turn. The exact push calls are preserved (cut from
// the function body, not retyped) — including the trailing '' — so the joined
// output, and the blank-line boundary before the first dynamic block, are
// byte-identical to the previous per-turn assembly.
const COWORK_STATIC_PREAMBLE = (() => {
  const parts = [];

  parts.push('## SiraGPT Cowork System');
  parts.push('You are an advanced AI assistant with professional document analysis, persistent memory, multi-session orchestration, and intelligent auto-filing capabilities.');
  parts.push('');

  parts.push('### Auto-File Behavior');
  parts.push('When the user pastes or drops content (code, data, text, logs, JSON, CSV, etc.), it is AUTOMATICALLY converted into a analyzable document:');
  parts.push('- Content ≥200 chars is auto-filed as a virtual document');
  parts.push('- Structured content (JSON, CSV, XML, code, etc.) gets format-specific analysis');
  parts.push('- All auto-filed content is indexed for RAG retrieval');
  parts.push('- The user sees their pasted content as an attached file, not raw text');
  parts.push('- You should ANALYZE the auto-filed document professionally, not just respond to it as text');
  parts.push('');

  parts.push('### Deep Document Analysis');
  parts.push('When analyzing documents, apply domain-specific professional analysis:');
  parts.push('- **Legal**: Obligations, parties, penalties, termination, IP, confidentiality');
  parts.push('- **Financial**: Amounts, ratios, trends, anomalies, liquidity, solvency');
  parts.push('- **Academic**: Claims, evidence, methodology, citations, statistical validity');
  parts.push('- **Medical**: Dosages, diagnoses, contraindications, drug interactions');
  parts.push('- **Technical**: Components, interfaces, dependencies, security, scalability');
  parts.push('- **Business**: KPIs, milestones, stakeholders, risks, strategic alignment');
  parts.push('Always provide: domain detection, entity extraction, risk assessment, quality scoring, and actionable recommendations.');
  parts.push('');

  parts.push('### Active Memory');
  parts.push('You have a persistent memory system:');
  parts.push('- **Short-term**: Recent context and conversation facts');
  parts.push('- **Long-term**: Frequently recalled facts (auto-promoted after 3+ accesses)');
  parts.push('- Use memory to recall user preferences, past analyses, and context across sessions');
  parts.push('- Memory facts are included in your context automatically');
  parts.push('');

  parts.push('### Session Management');
  parts.push('You can manage multiple concurrent sessions:');
  parts.push('- Spawn sub-sessions for parallel analysis tasks');
  parts.push('- Forward context between sessions');
  parts.push('- Compact session history when context grows too long');
  parts.push('');

  parts.push('### Response Fidelity');
  parts.push('When responding about attached or auto-filed documents:');
  parts.push('- Every number, date, and named entity in your response MUST be traceable to the source document');
  parts.push('- Do NOT fabricate amounts, dates, or entity names that are not in the source');
  parts.push('- If you are uncertain whether a fact appears in the source, hedge explicitly ("according to the document...", "the data suggests...")');
  parts.push('- Contradictions between documents should be flagged, not silently resolved');
  parts.push('');

  return parts.join('\n');
})();

function buildCoworkSystemPrompt(userId, opts = {}) {
  const parts = [COWORK_STATIC_PREAMBLE];

  if (userId) {
    // Reuse a caller-supplied {limit:15} context when present (enrichAIRequest
    // computes it once per turn) to avoid a redundant full store scan + sort.
    const memoryContext = opts.memoryContext || activeMemory.getMemoryContext(userId, { limit: 15 });
    if (memoryContext.longTermFacts.length > 0 || memoryContext.shortTermFacts.length > 0) {
      parts.push('### Your Active Memory');
      if (memoryContext.longTermFacts.length > 0) {
        parts.push('**Persistent facts:**');
        for (const fact of memoryContext.longTermFacts) {
          parts.push(`- ${fact}`);
        }
      }
      if (memoryContext.shortTermFacts.length > 0) {
        parts.push('**Recent context:**');
        for (const fact of memoryContext.shortTermFacts.slice(0, 8)) {
          parts.push(`- ${fact}`);
        }
      }
      parts.push('');
    }
  }

  const skills = skillsRegistry.listSkills({ limit: 10 });
  if (skills.length > 0) {
    parts.push('### Available Skills');
    for (const skill of skills) {
      parts.push(`- **${skill.label}** (${skill.category}): ${skill.description}`);
    }
    parts.push('');
  }

  const result = parts.join('\n');
  if (result.length > MAX_COWORK_BLOCK_CHARS) {
    return result.slice(0, MAX_COWORK_BLOCK_CHARS - 3) + '...';
  }
  return result;
}

function processIncomingMessage(userId, content, opts = {}) {
  const enrichedContent = { original: content, autoFiled: null, memoryOps: null };

  const autoFileResult = autoFileBridge.shouldAutoFile(content)
    ? { shouldAutoFile: true, detectedFormat: autoFileBridge.detectContentType(content), isStructured: autoFileBridge.isStructuredContent(content) }
    : { shouldAutoFile: false };

  enrichedContent.autoFile = autoFileResult;

  if (userId && content) {
    try {
      const memoryFacts = extractMemoryFacts(content);
      for (const fact of memoryFacts) {
        activeMemory.createMemoryEntry(userId, fact, {
          source: 'user_message',
          category: 'conversation',
          confidence: 0.6,
          strength: 0.2,
        });
      }
      enrichedContent.memoryOps = { factsExtracted: memoryFacts.length };
      activeMemory.autoPromote(userId);
      activeMemory.expireStale();
    } catch (_memErr) {
      enrichedContent.memoryOps = { factsExtracted: 0 };
    }
  }

  return enrichedContent;
}

function extractMemoryFacts(text) {
  if (!text || typeof text !== 'string') return [];

  const facts = [];

  const preferencePatterns = [
    /(?:prefiero|prefiero que|me gusta|me gusta más|quiero que|siempre uso|normalmente uso|mejor para mí|I prefer|I like|I always use|I typically)/i,
    /(?:mi nombre es|me llamo|soy |trabajo en|estudio en|my name is|I work at|I study at)/i,
    /(?:mi proyecto|mi empresa|mi equipo|mi rol|my project|my company|my team|my role)/i,
    /(?:importante para mí|necesito que|es critical|es esencial|it's important|I need|is critical|is essential)/i,
  ];

  const sentences = text.split(/[.!?\n]+/).filter(s => s.trim().length > 15);
  for (const sentence of sentences) {
    for (const pattern of preferencePatterns) {
      if (pattern.test(sentence)) {
        facts.push(sentence.trim());
        break;
      }
    }
  }

  return facts.slice(0, 5);
}

async function enrichAIRequest(userId, content, opts = {}) {
  const enriched = processIncomingMessage(userId, content, opts);

  // Materialize the user's active-memory context ONCE per turn. This used to be
  // computed 3× (buildCoworkSystemPrompt {limit:15}, buildMemoryPrompt {limit:12},
  // context-intelligence {limit:15}), each a full O(N) global-store scan + sort.
  // processIncomingMessage above is the only writer and ran first, and every
  // read uses bump:false (no mutation), so all reads observe identical state —
  // sharing the {limit:15} result between the two {limit:15} callers is
  // byte-identical. (buildMemoryPrompt keeps its own {limit:12} read.)
  const memCtx15 = userId
    ? activeMemory.getMemoryContext(userId, { limit: 15 })
    : { longTermFacts: [], shortTermFacts: [] };

  let autoFileResult = null;
  if (enriched.autoFile.shouldAutoFile && userId) {
    try {
      autoFileResult = await autoFileBridge.ingestPastedContent(userId, content);
      enriched.autoFileResult = autoFileResult;
    } catch (_fileErr) {
      // Degrade to null (unchanged), but surface so a prod regression in
      // auto-file ingest isn't invisible on every cowork turn.
      console.warn('[cowork] auto-file ingest failed:', _fileErr?.message || _fileErr);
      enriched.autoFileResult = null;
    }
  }

  const memoryPrompt = userId ? activeMemory.buildMemoryPrompt(userId, { limit: 12 }) : '';

  let skillRuns = [];
  if (userId && content) {
    try {
      skillRuns = await skillsExecutor.executeRecommendedSkills(
        { query: String(content).slice(0, 500), tags: ['cowork', 'document'] },
        { userId, content, prisma: opts.prisma, chatId: opts.chatId },
        { limit: 2 }
      );
    } catch (_skillErr) {
      console.warn('[cowork] recommended-skills execution failed:', _skillErr?.message || _skillErr);
      skillRuns = [];
    }
  }

  const coworkPrompt = buildCoworkSystemPrompt(userId, {
    chatId: opts.chatId,
    model: opts.model,
    memoryContext: memCtx15,
  });

  let deepAnalysisPrompt = '';
  if (autoFileResult?.autoFiled) {
    try {
      const analysisPipeline = require('./analysis-pipeline');
      const proResult = analysisPipeline.runAnalysisPipeline(content, {
        fileName: autoFileResult.fileName,
        mimeType: autoFileResult.mime,
      });
      enriched.deepAnalysis = proResult;
      if (proResult && proResult.ok) {
        deepAnalysisPrompt = analysisPipeline.buildAnalysisSystemPrompt(proResult);
      }
    } catch (_e) {
      try {
        const analysis = await deepDocumentAnalyzer.analyzeDeep(content, {
          userId,
          fileName: autoFileResult.fileName,
          mimeType: autoFileResult.mime,
        });
        enriched.deepAnalysis = analysis;
        if (analysis) {
          const parts = [];
          parts.push('### Deep Analysis');
          parts.push(`Domain: ${analysis.domain.primary} (confidence: ${Math.round(analysis.domain.confidence * 100)}%)`);
          parts.push(`Quality: ${analysis.quality.grade} (${analysis.quality.overall}/100)`);
          parts.push(`Risk: ${analysis.risks.severity} (${analysis.risks.items.length} factors)`);
          parts.push(`PII: ${analysis.piiSummary.total} entities (${analysis.piiSummary.critical} critical)`);
          parts.push(`Structure: ${analysis.structure.headingCount} sections`);
          if (analysis.autoTags.length > 0) {
            parts.push(`Tags: ${analysis.autoTags.slice(0, 8).join(', ')}`);
          }
          deepAnalysisPrompt = parts.join('\n');
        }
      } catch (_e2) {
        console.warn('[cowork] deep-document analysis failed:', _e2?.message || _e2);
        enriched.deepAnalysis = null;
      }
    }
  }

  const skillPrompt = skillRuns.length
    ? `### Skill execution\n${skillRuns.map((r) => `- ${r.skillId || 'skill'}: ${r.ok ? 'ok' : r.error}`).join('\n')}`
    : '';

  let contextIntelligencePrompt = '';
  let contextIntelligenceReport = null;
  if (content) {
    try {
      // Reuse the once-per-turn {limit:15} context computed above (identical
      // params, same un-mutated store) instead of a third full scan + sort.
      const memoryContext = memCtx15;
      const memoryFacts = [
        ...(memoryContext.longTermFacts || []),
        ...(memoryContext.shortTermFacts || []),
      ];
      contextIntelligenceReport = contextIntelligence.analyzeContext(userId, content, {
        documents: opts.documents || (autoFileResult?.autoFiled ? [{ name: autoFileResult.fileName, text: content, mime: autoFileResult.mime }] : []),
        history: Array.isArray(opts.history) ? opts.history : [],
        memoryFacts,
        toolResults: Array.isArray(opts.toolResults) ? opts.toolResults : [],
        webResults: Array.isArray(opts.webResults) ? opts.webResults : [],
        reasoningTrace: Array.isArray(opts.reasoningTrace) ? opts.reasoningTrace : [],
        draftAnswer: typeof opts.draftAnswer === 'string' ? opts.draftAnswer : '',
      });
      contextIntelligencePrompt = contextIntelligence.buildSystemPromptBlock(
        contextIntelligenceReport,
        opts.contextIntelligenceOpts || {},
      );
      enriched.contextIntelligence = contextIntelligence.summariseForLog(contextIntelligenceReport);
    } catch (_ciErr) {
      console.warn('[cowork] context-intelligence analysis failed:', _ciErr?.message || _ciErr);
      enriched.contextIntelligence = null;
    }
  }

  return {
    enriched,
    systemPromptAdditions: [coworkPrompt, memoryPrompt, deepAnalysisPrompt, skillPrompt, contextIntelligencePrompt]
      .filter(Boolean)
      .join('\n\n'),
    autoFileResult: enriched.autoFileResult,
    deepAnalysis: enriched.deepAnalysis,
    skillRuns,
    contextIntelligence: contextIntelligenceReport,
  };
}

module.exports = {
  buildCoworkSystemPrompt,
  processIncomingMessage,
  enrichAIRequest,
  extractMemoryFacts,
};
