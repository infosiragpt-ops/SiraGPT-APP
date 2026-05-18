'use strict';

const autoFileBridge = require('./auto-file-bridge');
const deepDocumentAnalyzer = require('./deep-document-analyzer');
const activeMemory = require('./active-memory');
const sessionManager = require('./session-manager');
const skillsRegistry = require('./skills-registry');

function buildCoworkSystemPrompt(userId, opts = {}) {
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

  if (userId) {
    const memoryContext = activeMemory.getMemoryContext(userId, { limit: 15 });
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

  return parts.join('\n');
}

function processIncomingMessage(userId, content, opts = {}) {
  const enrichedContent = { original: content, autoFiled: null, memoryOps: null };

  const autoFileResult = autoFileBridge.shouldAutoFile(content)
    ? { shouldAutoFile: true, detectedFormat: autoFileBridge.detectContentType(content), isStructured: autoFileBridge.isStructuredContent(content) }
    : { shouldAutoFile: false };

  enrichedContent.autoFile = autoFileResult;

  if (userId && content) {
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

  let autoFileResult = null;
  if (enriched.autoFile.shouldAutoFile && userId) {
    autoFileResult = await autoFileBridge.ingestPastedContent(userId, content);
    enriched.autoFileResult = autoFileResult;
  }

  const memoryPrompt = userId ? activeMemory.buildMemoryPrompt(userId, { limit: 12 }) : '';

  const coworkPrompt = buildCoworkSystemPrompt(userId, {
    chatId: opts.chatId,
    model: opts.model,
  });

  const deepAnalysisPrompt = '';
  if (autoFileResult?.autoFiled) {
    try {
      const analysis = await deepDocumentAnalyzer.analyzeDeep(content, {
        userId,
        fileName: autoFileResult.fileName,
        mimeType: autoFileResult.mime,
      });
      enriched.deepAnalysis = analysis;
    } catch (_e) {
      enriched.deepAnalysis = null;
    }
  }

  return {
    enriched,
    systemPromptAdditions: [coworkPrompt, memoryPrompt, deepAnalysisPrompt].filter(Boolean).join('\n\n'),
    autoFileResult: enriched.autoFileResult,
    deepAnalysis: enriched.deepAnalysis,
  };
}

module.exports = {
  buildCoworkSystemPrompt,
  processIncomingMessage,
  enrichAIRequest,
  extractMemoryFacts,
};
