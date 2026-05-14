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
const MAX_INSIGHTS_BLOCK_CHARS = Number.parseInt(process.env.SIRAGPT_DOC_INSIGHTS_MAX_CHARS || '4500', 10);

// Sibling pure modules — lazy-require pattern keeps startup cost off the
// hot path of routes that don't enrich attachments. Each module is optional
// at runtime: if missing, callers receive an empty block instead of an
// exception. Direct unit tests import the modules without going through here.
let insightsEngineCache = null;
function getInsightsEngine() {
  if (insightsEngineCache) return insightsEngineCache;
  try { insightsEngineCache = require('./document-insights-engine'); } catch { insightsEngineCache = null; }
  return insightsEngineCache;
}
let comparisonEngineCache = null;
function getComparisonEngine() {
  if (comparisonEngineCache) return comparisonEngineCache;
  try { comparisonEngineCache = require('./document-comparison-engine'); } catch { comparisonEngineCache = null; }
  return comparisonEngineCache;
}
let glossaryEngineCache = null;
function getGlossaryEngine() {
  if (glossaryEngineCache) return glossaryEngineCache;
  try { glossaryEngineCache = require('./document-glossary-extractor'); } catch { glossaryEngineCache = null; }
  return glossaryEngineCache;
}
let piiEngineCache = null;
function getPiiEngine() {
  if (piiEngineCache) return piiEngineCache;
  try { piiEngineCache = require('./document-pii-detector'); } catch { piiEngineCache = null; }
  return piiEngineCache;
}
let consistencyCheckerCache = null;
function getConsistencyChecker() {
  if (consistencyCheckerCache) return consistencyCheckerCache;
  try { consistencyCheckerCache = require('./document-consistency-checker'); } catch { consistencyCheckerCache = null; }
  return consistencyCheckerCache;
}
let outlineGeneratorCache = null;
function getOutlineGenerator() {
  if (outlineGeneratorCache) return outlineGeneratorCache;
  try { outlineGeneratorCache = require('./document-outline-generator'); } catch { outlineGeneratorCache = null; }
  return outlineGeneratorCache;
}
let readabilityAnalyzerCache = null;
function getReadabilityAnalyzer() {
  if (readabilityAnalyzerCache) return readabilityAnalyzerCache;
  try { readabilityAnalyzerCache = require('./document-readability-analyzer'); } catch { readabilityAnalyzerCache = null; }
  return readabilityAnalyzerCache;
}
let qualityScorerCache = null;
function getQualityScorer() {
  if (qualityScorerCache) return qualityScorerCache;
  try { qualityScorerCache = require('./document-analysis-quality-scorer'); } catch { qualityScorerCache = null; }
  return qualityScorerCache;
}
let deepAnalyzerCache = null;
function getDeepAnalyzer() {
  if (deepAnalyzerCache) return deepAnalyzerCache;
  try { deepAnalyzerCache = require('./document-deep-analyzer'); } catch { deepAnalyzerCache = null; }
  return deepAnalyzerCache;
}
let quoteExtractorCache = null;
function getQuoteExtractor() {
  if (quoteExtractorCache) return quoteExtractorCache;
  try { quoteExtractorCache = require('./document-quote-extractor'); } catch { quoteExtractorCache = null; }
  return quoteExtractorCache;
}
let discourseMapperCache = null;
function getDiscourseMapper() {
  if (discourseMapperCache) return discourseMapperCache;
  try { discourseMapperCache = require('./document-discourse-mapper'); } catch { discourseMapperCache = null; }
  return discourseMapperCache;
}
let sectionClassifierCache = null;
function getSectionClassifier() {
  if (sectionClassifierCache) return sectionClassifierCache;
  try { sectionClassifierCache = require('./document-section-classifier'); } catch { sectionClassifierCache = null; }
  return sectionClassifierCache;
}
let evidenceMapCache = null;
function getEvidenceMap() {
  if (evidenceMapCache) return evidenceMapCache;
  try { evidenceMapCache = require('./document-evidence-map'); } catch { evidenceMapCache = null; }
  return evidenceMapCache;
}
let numericCoherenceCache = null;
function getNumericCoherence() {
  if (numericCoherenceCache) return numericCoherenceCache;
  try { numericCoherenceCache = require('./document-numeric-coherence'); } catch { numericCoherenceCache = null; }
  return numericCoherenceCache;
}
let temporalTimelineCache = null;
function getTemporalTimeline() {
  if (temporalTimelineCache) return temporalTimelineCache;
  try { temporalTimelineCache = require('./document-temporal-timeline'); } catch { temporalTimelineCache = null; }
  return temporalTimelineCache;
}
let actionDashboardCache = null;
function getActionDashboard() {
  if (actionDashboardCache) return actionDashboardCache;
  try { actionDashboardCache = require('./document-action-dashboard'); } catch { actionDashboardCache = null; }
  return actionDashboardCache;
}
let audienceToneCache = null;
function getAudienceTone() {
  if (audienceToneCache) return audienceToneCache;
  try { audienceToneCache = require('./document-audience-tone'); } catch { audienceToneCache = null; }
  return audienceToneCache;
}
let semanticGraphCache = null;
function getSemanticGraph() {
  if (semanticGraphCache) return semanticGraphCache;
  try { semanticGraphCache = require('./document-semantic-graph'); } catch { semanticGraphCache = null; }
  return semanticGraphCache;
}
let kpiExtractorCache = null;
function getKpiExtractor() {
  if (kpiExtractorCache) return kpiExtractorCache;
  try { kpiExtractorCache = require('./document-kpi-extractor'); } catch { kpiExtractorCache = null; }
  return kpiExtractorCache;
}
let riskRegisterCache = null;
function getRiskRegister() {
  if (riskRegisterCache) return riskRegisterCache;
  try { riskRegisterCache = require('./document-risk-register'); } catch { riskRegisterCache = null; }
  return riskRegisterCache;
}
let factDensityCache = null;
function getFactDensity() {
  if (factDensityCache) return factDensityCache;
  try { factDensityCache = require('./document-fact-density'); } catch { factDensityCache = null; }
  return factDensityCache;
}
let relationshipClassifierCache = null;
function getRelationshipClassifier() {
  if (relationshipClassifierCache) return relationshipClassifierCache;
  try { relationshipClassifierCache = require('./document-relationship-classifier'); } catch { relationshipClassifierCache = null; }
  return relationshipClassifierCache;
}
let sectionSimilarityCache = null;
function getSectionSimilarity() {
  if (sectionSimilarityCache) return sectionSimilarityCache;
  try { sectionSimilarityCache = require('./document-section-similarity'); } catch { sectionSimilarityCache = null; }
  return sectionSimilarityCache;
}
let numericStatisticsCache = null;
function getNumericStatistics() {
  if (numericStatisticsCache) return numericStatisticsCache;
  try { numericStatisticsCache = require('./document-numeric-statistics'); } catch { numericStatisticsCache = null; }
  return numericStatisticsCache;
}
let qualityGradeCache = null;
function getQualityGrade() {
  if (qualityGradeCache) return qualityGradeCache;
  try { qualityGradeCache = require('./document-quality-grade'); } catch { qualityGradeCache = null; }
  return qualityGradeCache;
}
let titleExtractorCache = null;
function getTitleExtractor() {
  if (titleExtractorCache) return titleExtractorCache;
  try { titleExtractorCache = require('./document-title-extractor'); } catch { titleExtractorCache = null; }
  return titleExtractorCache;
}
let tldrCache = null;
function getTldr() {
  if (tldrCache) return tldrCache;
  try { tldrCache = require('./document-tldr'); } catch { tldrCache = null; }
  return tldrCache;
}
let sentimentCache = null;
function getSentiment() {
  if (sentimentCache) return sentimentCache;
  try { sentimentCache = require('./document-sentiment'); } catch { sentimentCache = null; }
  return sentimentCache;
}
let keyPhrasesCache = null;
function getKeyPhrases() {
  if (keyPhrasesCache) return keyPhrasesCache;
  try { keyPhrasesCache = require('./document-key-phrases'); } catch { keyPhrasesCache = null; }
  return keyPhrasesCache;
}
let obligationsCache = null;
function getObligations() {
  if (obligationsCache) return obligationsCache;
  try { obligationsCache = require('./document-obligations-extractor'); } catch { obligationsCache = null; }
  return obligationsCache;
}
let scopeExclusionsCache = null;
function getScopeExclusions() {
  if (scopeExclusionsCache) return scopeExclusionsCache;
  try { scopeExclusionsCache = require('./document-scope-exclusions'); } catch { scopeExclusionsCache = null; }
  return scopeExclusionsCache;
}
let stakeholderMapCache = null;
function getStakeholderMap() {
  if (stakeholderMapCache) return stakeholderMapCache;
  try { stakeholderMapCache = require('./document-stakeholder-map'); } catch { stakeholderMapCache = null; }
  return stakeholderMapCache;
}
let jurisdictionDetectorCache = null;
function getJurisdictionDetector() {
  if (jurisdictionDetectorCache) return jurisdictionDetectorCache;
  try { jurisdictionDetectorCache = require('./document-jurisdiction-detector'); } catch { jurisdictionDetectorCache = null; }
  return jurisdictionDetectorCache;
}
let definitionsExtractorCache = null;
function getDefinitionsExtractor() {
  if (definitionsExtractorCache) return definitionsExtractorCache;
  try { definitionsExtractorCache = require('./document-definitions-extractor'); } catch { definitionsExtractorCache = null; }
  return definitionsExtractorCache;
}
let crossReferenceCache = null;
function getCrossReference() {
  if (crossReferenceCache) return crossReferenceCache;
  try { crossReferenceCache = require('./document-cross-reference'); } catch { crossReferenceCache = null; }
  return crossReferenceCache;
}
let pricingExtractorCache = null;
function getPricingExtractor() {
  if (pricingExtractorCache) return pricingExtractorCache;
  try { pricingExtractorCache = require('./document-pricing-extractor'); } catch { pricingExtractorCache = null; }
  return pricingExtractorCache;
}
let metadataExtractorCache = null;
function getMetadataExtractor() {
  if (metadataExtractorCache) return metadataExtractorCache;
  try { metadataExtractorCache = require('./document-metadata-extractor'); } catch { metadataExtractorCache = null; }
  return metadataExtractorCache;
}
let complianceMatcherCache = null;
function getComplianceMatcher() {
  if (complianceMatcherCache) return complianceMatcherCache;
  try { complianceMatcherCache = require('./document-compliance-matcher'); } catch { complianceMatcherCache = null; }
  return complianceMatcherCache;
}
let warrantiesExtractorCache = null;
function getWarrantiesExtractor() {
  if (warrantiesExtractorCache) return warrantiesExtractorCache;
  try { warrantiesExtractorCache = require('./document-warranties-extractor'); } catch { warrantiesExtractorCache = null; }
  return warrantiesExtractorCache;
}
let disputeResolutionCache = null;
function getDisputeResolution() {
  if (disputeResolutionCache) return disputeResolutionCache;
  try { disputeResolutionCache = require('./document-dispute-resolution'); } catch { disputeResolutionCache = null; }
  return disputeResolutionCache;
}
let indemnificationCache = null;
function getIndemnification() {
  if (indemnificationCache) return indemnificationCache;
  try { indemnificationCache = require('./document-indemnification'); } catch { indemnificationCache = null; }
  return indemnificationCache;
}
let acronymExpansionCache = null;
function getAcronymExpansion() {
  if (acronymExpansionCache) return acronymExpansionCache;
  try { acronymExpansionCache = require('./document-acronym-expansion'); } catch { acronymExpansionCache = null; }
  return acronymExpansionCache;
}
let temporalExpressionsCache = null;
function getTemporalExpressions() {
  if (temporalExpressionsCache) return temporalExpressionsCache;
  try { temporalExpressionsCache = require('./document-temporal-expressions'); } catch { temporalExpressionsCache = null; }
  return temporalExpressionsCache;
}
let crossNumericCache = null;
function getCrossNumeric() {
  if (crossNumericCache) return crossNumericCache;
  try { crossNumericCache = require('./document-cross-numeric'); } catch { crossNumericCache = null; }
  return crossNumericCache;
}
let signatureBlockCache = null;
function getSignatureBlock() {
  if (signatureBlockCache) return signatureBlockCache;
  try { signatureBlockCache = require('./document-signature-block'); } catch { signatureBlockCache = null; }
  return signatureBlockCache;
}
let qaPairsCache = null;
function getQaPairs() {
  if (qaPairsCache) return qaPairsCache;
  try { qaPairsCache = require('./document-qa-pairs'); } catch { qaPairsCache = null; }
  return qaPairsCache;
}
let hypothesesCache = null;
function getHypotheses() {
  if (hypothesesCache) return hypothesesCache;
  try { hypothesesCache = require('./document-hypotheses'); } catch { hypothesesCache = null; }
  return hypothesesCache;
}
let recommendationsCache = null;
function getRecommendations() {
  if (recommendationsCache) return recommendationsCache;
  try { recommendationsCache = require('./document-recommendations'); } catch { recommendationsCache = null; }
  return recommendationsCache;
}
let assumptionsCache = null;
function getAssumptions() {
  if (assumptionsCache) return assumptionsCache;
  try { assumptionsCache = require('./document-assumptions'); } catch { assumptionsCache = null; }
  return assumptionsCache;
}
let conditionalClausesCache = null;
function getConditionalClauses() {
  if (conditionalClausesCache) return conditionalClausesCache;
  try { conditionalClausesCache = require('./document-conditional-clauses'); } catch { conditionalClausesCache = null; }
  return conditionalClausesCache;
}
let counterArgumentsCache = null;
function getCounterArguments() {
  if (counterArgumentsCache) return counterArgumentsCache;
  try { counterArgumentsCache = require('./document-counter-arguments'); } catch { counterArgumentsCache = null; }
  return counterArgumentsCache;
}
let callToActionCache = null;
function getCallToAction() {
  if (callToActionCache) return callToActionCache;
  try { callToActionCache = require('./document-call-to-action'); } catch { callToActionCache = null; }
  return callToActionCache;
}
let disclosuresCache = null;
function getDisclosures() {
  if (disclosuresCache) return disclosuresCache;
  try { disclosuresCache = require('./document-disclosures'); } catch { disclosuresCache = null; }
  return disclosuresCache;
}
let factVsOpinionCache = null;
function getFactVsOpinion() {
  if (factVsOpinionCache) return factVsOpinionCache;
  try { factVsOpinionCache = require('./document-fact-vs-opinion'); } catch { factVsOpinionCache = null; }
  return factVsOpinionCache;
}
let scenariosCache = null;
function getScenarios() {
  if (scenariosCache) return scenariosCache;
  try { scenariosCache = require('./document-scenarios'); } catch { scenariosCache = null; }
  return scenariosCache;
}
let benchmarksCache = null;
function getBenchmarks() {
  if (benchmarksCache) return benchmarksCache;
  try { benchmarksCache = require('./document-benchmarks'); } catch { benchmarksCache = null; }
  return benchmarksCache;
}
let goalsTargetsCache = null;
function getGoalsTargets() {
  if (goalsTargetsCache) return goalsTargetsCache;
  try { goalsTargetsCache = require('./document-goals-targets'); } catch { goalsTargetsCache = null; }
  return goalsTargetsCache;
}
let slaTermsCache = null;
function getSLATerms() {
  if (slaTermsCache) return slaTermsCache;
  try { slaTermsCache = require('./document-sla-terms'); } catch { slaTermsCache = null; }
  return slaTermsCache;
}
let dataClassificationCache = null;
function getDataClassification() {
  if (dataClassificationCache) return dataClassificationCache;
  try { dataClassificationCache = require('./document-data-classification'); } catch { dataClassificationCache = null; }
  return dataClassificationCache;
}
let approvalWorkflowCache = null;
function getApprovalWorkflow() {
  if (approvalWorkflowCache) return approvalWorkflowCache;
  try { approvalWorkflowCache = require('./document-approval-workflow'); } catch { approvalWorkflowCache = null; }
  return approvalWorkflowCache;
}
let executiveSummaryCache = null;
function getExecutiveSummary() {
  if (executiveSummaryCache) return executiveSummaryCache;
  try { executiveSummaryCache = require('./document-executive-summary'); } catch { executiveSummaryCache = null; }
  return executiveSummaryCache;
}
let urlExtractorCache = null;
function getUrlExtractor() {
  if (urlExtractorCache) return urlExtractorCache;
  try { urlExtractorCache = require('./document-url-extractor'); } catch { urlExtractorCache = null; }
  return urlExtractorCache;
}
let contactInfoCache = null;
function getContactInfo() {
  if (contactInfoCache) return contactInfoCache;
  try { contactInfoCache = require('./document-contact-info'); } catch { contactInfoCache = null; }
  return contactInfoCache;
}
let footnotesCache = null;
function getFootnotes() {
  if (footnotesCache) return footnotesCache;
  try { footnotesCache = require('./document-footnotes'); } catch { footnotesCache = null; }
  return footnotesCache;
}
let tablesCache = null;
function getTables() {
  if (tablesCache) return tablesCache;
  try { tablesCache = require('./document-tables'); } catch { tablesCache = null; }
  return tablesCache;
}
let codeBlocksCache = null;
function getCodeBlocks() {
  if (codeBlocksCache) return codeBlocksCache;
  try { codeBlocksCache = require('./document-code-blocks'); } catch { codeBlocksCache = null; }
  return codeBlocksCache;
}
let figureRefsCache = null;
function getFigureRefs() {
  if (figureRefsCache) return figureRefsCache;
  try { figureRefsCache = require('./document-figure-refs'); } catch { figureRefsCache = null; }
  return figureRefsCache;
}
let checklistsCache = null;
function getChecklists() {
  if (checklistsCache) return checklistsCache;
  try { checklistsCache = require('./document-checklists'); } catch { checklistsCache = null; }
  return checklistsCache;
}
let identifiersCache = null;
function getIdentifiers() {
  if (identifiersCache) return identifiersCache;
  try { identifiersCache = require('./document-identifiers'); } catch { identifiersCache = null; }
  return identifiersCache;
}
let bulletListsCache = null;
function getBulletLists() {
  if (bulletListsCache) return bulletListsCache;
  try { bulletListsCache = require('./document-bullet-lists'); } catch { bulletListsCache = null; }
  return bulletListsCache;
}
let mermaidCache = null;
function getMermaid() {
  if (mermaidCache) return mermaidCache;
  try { mermaidCache = require('./document-mermaid'); } catch { mermaidCache = null; }
  return mermaidCache;
}
let priorityCache = null;
function getPriority() {
  if (priorityCache) return priorityCache;
  try { priorityCache = require('./document-priority'); } catch { priorityCache = null; }
  return priorityCache;
}
let ownershipCache = null;
function getOwnership() {
  if (ownershipCache) return ownershipCache;
  try { ownershipCache = require('./document-ownership'); } catch { ownershipCache = null; }
  return ownershipCache;
}
let timestampsCache = null;
function getTimestamps() {
  if (timestampsCache) return timestampsCache;
  try { timestampsCache = require('./document-timestamps'); } catch { timestampsCache = null; }
  return timestampsCache;
}
let statusCache = null;
function getStatus() {
  if (statusCache) return statusCache;
  try { statusCache = require('./document-status'); } catch { statusCache = null; }
  return statusCache;
}
let acceptanceCriteriaCache = null;
function getAcceptanceCriteria() {
  if (acceptanceCriteriaCache) return acceptanceCriteriaCache;
  try { acceptanceCriteriaCache = require('./document-acceptance-criteria'); } catch { acceptanceCriteriaCache = null; }
  return acceptanceCriteriaCache;
}
let apiEndpointsCache = null;
function getApiEndpoints() {
  if (apiEndpointsCache) return apiEndpointsCache;
  try { apiEndpointsCache = require('./document-api-endpoints'); } catch { apiEndpointsCache = null; }
  return apiEndpointsCache;
}
let envVarsCache = null;
function getEnvVars() {
  if (envVarsCache) return envVarsCache;
  try { envVarsCache = require('./document-env-vars'); } catch { envVarsCache = null; }
  return envVarsCache;
}
let sqlCache = null;
function getSql() {
  if (sqlCache) return sqlCache;
  try { sqlCache = require('./document-sql'); } catch { sqlCache = null; }
  return sqlCache;
}
let filePathsCache = null;
function getFilePaths() {
  if (filePathsCache) return filePathsCache;
  try { filePathsCache = require('./document-file-paths'); } catch { filePathsCache = null; }
  return filePathsCache;
}
let cronCache = null;
function getCron() {
  if (cronCache) return cronCache;
  try { cronCache = require('./document-cron'); } catch { cronCache = null; }
  return cronCache;
}
let licensesCache = null;
function getLicenses() {
  if (licensesCache) return licensesCache;
  try { licensesCache = require('./document-licenses'); } catch { licensesCache = null; }
  return licensesCache;
}
let dependenciesCache = null;
function getDependencies() {
  if (dependenciesCache) return dependenciesCache;
  try { dependenciesCache = require('./document-dependencies'); } catch { dependenciesCache = null; }
  return dependenciesCache;
}
let riskMatrixCache = null;
function getRiskMatrix() {
  if (riskMatrixCache) return riskMatrixCache;
  try { riskMatrixCache = require('./document-risk-matrix'); } catch { riskMatrixCache = null; }
  return riskMatrixCache;
}
let versionsCache = null;
function getVersions() {
  if (versionsCache) return versionsCache;
  try { versionsCache = require('./document-versions'); } catch { versionsCache = null; }
  return versionsCache;
}
let decisionRecordsCache = null;
function getDecisionRecords() {
  if (decisionRecordsCache) return decisionRecordsCache;
  try { decisionRecordsCache = require('./document-decision-records'); } catch { decisionRecordsCache = null; }
  return decisionRecordsCache;
}
let domainsCache = null;
function getDomains() {
  if (domainsCache) return domainsCache;
  try { domainsCache = require('./document-domains'); } catch { domainsCache = null; }
  return domainsCache;
}
let currencyCache = null;
function getCurrency() {
  if (currencyCache) return currencyCache;
  try { currencyCache = require('./document-currency'); } catch { currencyCache = null; }
  return currencyCache;
}
let percentagesCache = null;
function getPercentages() {
  if (percentagesCache) return percentagesCache;
  try { percentagesCache = require('./document-percentages'); } catch { percentagesCache = null; }
  return percentagesCache;
}
let citationsCache = null;
function getCitations() {
  if (citationsCache) return citationsCache;
  try { citationsCache = require('./document-citations'); } catch { citationsCache = null; }
  return citationsCache;
}
let colorsCache = null;
function getColors() {
  if (colorsCache) return colorsCache;
  try { colorsCache = require('./document-colors'); } catch { colorsCache = null; }
  return colorsCache;
}
let coordinatesCache = null;
function getCoordinates() {
  if (coordinatesCache) return coordinatesCache;
  try { coordinatesCache = require('./document-coordinates'); } catch { coordinatesCache = null; }
  return coordinatesCache;
}
let trademarkCache = null;
function getTrademark() {
  if (trademarkCache) return trademarkCache;
  try { trademarkCache = require('./document-trademark'); } catch { trademarkCache = null; }
  return trademarkCache;
}
let hashtagsCache = null;
function getHashtags() {
  if (hashtagsCache) return hashtagsCache;
  try { hashtagsCache = require('./document-hashtags'); } catch { hashtagsCache = null; }
  return hashtagsCache;
}
let sectionLabelsCache = null;
function getSectionLabels() {
  if (sectionLabelsCache) return sectionLabelsCache;
  try { sectionLabelsCache = require('./document-section-labels'); } catch { sectionLabelsCache = null; }
  return sectionLabelsCache;
}
let signoffsCache = null;
function getSignoffs() {
  if (signoffsCache) return signoffsCache;
  try { signoffsCache = require('./document-signoffs'); } catch { signoffsCache = null; }
  return signoffsCache;
}
let hashesCache = null;
function getHashes() {
  if (hashesCache) return hashesCache;
  try { hashesCache = require('./document-hashes'); } catch { hashesCache = null; }
  return hashesCache;
}
let couponsCache = null;
function getCoupons() {
  if (couponsCache) return couponsCache;
  try { couponsCache = require('./document-coupons'); } catch { couponsCache = null; }
  return couponsCache;
}
let fileSizesCache = null;
function getFileSizes() {
  if (fileSizesCache) return fileSizesCache;
  try { fileSizesCache = require('./document-file-sizes'); } catch { fileSizesCache = null; }
  return fileSizesCache;
}
let vcsRefsCache = null;
function getVcsRefs() {
  if (vcsRefsCache) return vcsRefsCache;
  try { vcsRefsCache = require('./document-vcs-refs'); } catch { vcsRefsCache = null; }
  return vcsRefsCache;
}
let standardsCache = null;
function getStandards() {
  if (standardsCache) return standardsCache;
  try { standardsCache = require('./document-standards'); } catch { standardsCache = null; }
  return standardsCache;
}
let networkCache = null;
function getNetwork() {
  if (networkCache) return networkCache;
  try { networkCache = require('./document-network'); } catch { networkCache = null; }
  return networkCache;
}
let httpStatusCache = null;
function getHttpStatus() {
  if (httpStatusCache) return httpStatusCache;
  try { httpStatusCache = require('./document-http-status'); } catch { httpStatusCache = null; }
  return httpStatusCache;
}
let timezonesCache = null;
function getTimezones() {
  if (timezonesCache) return timezonesCache;
  try { timezonesCache = require('./document-timezones'); } catch { timezonesCache = null; }
  return timezonesCache;
}
let mathCache = null;
function getMath() {
  if (mathCache) return mathCache;
  try { mathCache = require('./document-math'); } catch { mathCache = null; }
  return mathCache;
}
let booleanCache = null;
function getBoolean() {
  if (booleanCache) return booleanCache;
  try { booleanCache = require('./document-boolean'); } catch { booleanCache = null; }
  return booleanCache;
}
let tocCache = null;
function getToc() {
  if (tocCache) return tocCache;
  try { tocCache = require('./document-toc'); } catch { tocCache = null; }
  return tocCache;
}
let htmlAttrsCache = null;
function getHtmlAttrs() {
  if (htmlAttrsCache) return htmlAttrsCache;
  try { htmlAttrsCache = require('./document-html-attrs'); } catch { htmlAttrsCache = null; }
  return htmlAttrsCache;
}
let blockquotesCache = null;
function getBlockquotes() {
  if (blockquotesCache) return blockquotesCache;
  try { blockquotesCache = require('./document-blockquotes'); } catch { blockquotesCache = null; }
  return blockquotesCache;
}
let definitionListsCache = null;
function getDefinitionLists() {
  if (definitionListsCache) return definitionListsCache;
  try { definitionListsCache = require('./document-definition-lists'); } catch { definitionListsCache = null; }
  return definitionListsCache;
}
let todosCache = null;
function getTodos() {
  if (todosCache) return todosCache;
  try { todosCache = require('./document-todos'); } catch { todosCache = null; }
  return todosCache;
}
let imagesCache = null;
function getImages() {
  if (imagesCache) return imagesCache;
  try { imagesCache = require('./document-images'); } catch { imagesCache = null; }
  return imagesCache;
}
let mediaCache = null;
function getMedia() {
  if (mediaCache) return mediaCache;
  try { mediaCache = require('./document-media'); } catch { mediaCache = null; }
  return mediaCache;
}
let languageRatioCache = null;
function getLanguageRatio() {
  if (languageRatioCache) return languageRatioCache;
  try { languageRatioCache = require('./document-language-ratio'); } catch { languageRatioCache = null; }
  return languageRatioCache;
}
let regexPatternsCache = null;
function getRegexPatterns() {
  if (regexPatternsCache) return regexPatternsCache;
  try { regexPatternsCache = require('./document-regex-patterns'); } catch { regexPatternsCache = null; }
  return regexPatternsCache;
}
let fileExtensionsCache = null;
function getFileExtensions() {
  if (fileExtensionsCache) return fileExtensionsCache;
  try { fileExtensionsCache = require('./document-file-extensions'); } catch { fileExtensionsCache = null; }
  return fileExtensionsCache;
}
let codeDefsCache = null;
function getCodeDefs() {
  if (codeDefsCache) return codeDefsCache;
  try { codeDefsCache = require('./document-code-defs'); } catch { codeDefsCache = null; }
  return codeDefsCache;
}
let tonePolarityCache = null;
function getTonePolarity() {
  if (tonePolarityCache) return tonePolarityCache;
  try { tonePolarityCache = require('./document-tone-polarity'); } catch { tonePolarityCache = null; }
  return tonePolarityCache;
}
let quantifiersCache = null;
function getQuantifiers() {
  if (quantifiersCache) return quantifiersCache;
  try { quantifiersCache = require('./document-quantifiers'); } catch { quantifiersCache = null; }
  return quantifiersCache;
}
let modalsCache = null;
function getModals() {
  if (modalsCache) return modalsCache;
  try { modalsCache = require('./document-modals'); } catch { modalsCache = null; }
  return modalsCache;
}
let negationCache = null;
function getNegation() {
  if (negationCache) return negationCache;
  try { negationCache = require('./document-negation'); } catch { negationCache = null; }
  return negationCache;
}
let readingTimeCache = null;
function getReadingTime() {
  if (readingTimeCache) return readingTimeCache;
  try { readingTimeCache = require('./document-reading-time'); } catch { readingTimeCache = null; }
  return readingTimeCache;
}
let attributionsCache = null;
function getAttributions() {
  if (attributionsCache) return attributionsCache;
  try { attributionsCache = require('./document-attributions'); } catch { attributionsCache = null; }
  return attributionsCache;
}
let comparativesCache = null;
function getComparatives() {
  if (comparativesCache) return comparativesCache;
  try { comparativesCache = require('./document-comparatives'); } catch { comparativesCache = null; }
  return comparativesCache;
}
let causalCache = null;
function getCausal() {
  if (causalCache) return causalCache;
  try { causalCache = require('./document-causal'); } catch { causalCache = null; }
  return causalCache;
}
let concessionCache = null;
function getConcession() {
  if (concessionCache) return concessionCache;
  try { concessionCache = require('./document-concession'); } catch { concessionCache = null; }
  return concessionCache;
}
let hedgingCache = null;
function getHedging() {
  if (hedgingCache) return hedgingCache;
  try { hedgingCache = require('./document-hedging'); } catch { hedgingCache = null; }
  return hedgingCache;
}
let intensifiersCache = null;
function getIntensifiers() {
  if (intensifiersCache) return intensifiersCache;
  try { intensifiersCache = require('./document-intensifiers'); } catch { intensifiersCache = null; }
  return intensifiersCache;
}
let reportingCache = null;
function getReporting() {
  if (reportingCache) return reportingCache;
  try { reportingCache = require('./document-reporting'); } catch { reportingCache = null; }
  return reportingCache;
}
let examplesCache = null;
function getExamples() {
  if (examplesCache) return examplesCache;
  try { examplesCache = require('./document-examples'); } catch { examplesCache = null; }
  return examplesCache;
}
let approximationsCache = null;
function getApproximations() {
  if (approximationsCache) return approximationsCache;
  try { approximationsCache = require('./document-approximations'); } catch { approximationsCache = null; }
  return approximationsCache;
}
let questionsCache = null;
function getQuestions() {
  if (questionsCache) return questionsCache;
  try { questionsCache = require('./document-questions'); } catch { questionsCache = null; }
  return questionsCache;
}
let imperativesCache = null;
function getImperatives() {
  if (imperativesCache) return imperativesCache;
  try { imperativesCache = require('./document-imperatives'); } catch { imperativesCache = null; }
  return imperativesCache;
}
let definitionsCache = null;
function getDefinitions() {
  if (definitionsCache) return definitionsCache;
  try { definitionsCache = require('./document-definitions'); } catch { definitionsCache = null; }
  return definitionsCache;
}
let fiscalYearCache = null;
function getFiscalYear() {
  if (fiscalYearCache) return fiscalYearCache;
  try { fiscalYearCache = require('./document-fiscal-year'); } catch { fiscalYearCache = null; }
  return fiscalYearCache;
}
let ratiosCache = null;
function getRatios() {
  if (ratiosCache) return ratiosCache;
  try { ratiosCache = require('./document-ratios'); } catch { ratiosCache = null; }
  return ratiosCache;
}
let ordinalsCache = null;
function getOrdinals() {
  if (ordinalsCache) return ordinalsCache;
  try { ordinalsCache = require('./document-ordinals'); } catch { ordinalsCache = null; }
  return ordinalsCache;
}
let geoRegionsCache = null;
function getGeoRegions() {
  if (geoRegionsCache) return geoRegionsCache;
  try { geoRegionsCache = require('./document-geo-regions'); } catch { geoRegionsCache = null; }
  return geoRegionsCache;
}
let trackingCache = null;
function getTracking() {
  if (trackingCache) return trackingCache;
  try { trackingCache = require('./document-tracking'); } catch { trackingCache = null; }
  return trackingCache;
}
let weatherCache = null;
function getWeather() {
  if (weatherCache) return weatherCache;
  try { weatherCache = require('./document-weather'); } catch { weatherCache = null; }
  return weatherCache;
}
let scientificNotationCache = null;
function getScientificNotation() {
  if (scientificNotationCache) return scientificNotationCache;
  try { scientificNotationCache = require('./document-scientific-notation'); } catch { scientificNotationCache = null; }
  return scientificNotationCache;
}
let taxaCache = null;
function getTaxa() {
  if (taxaCache) return taxaCache;
  try { taxaCache = require('./document-taxa'); } catch { taxaCache = null; }
  return taxaCache;
}
let chemistryCache = null;
function getChemistry() {
  if (chemistryCache) return chemistryCache;
  try { chemistryCache = require('./document-chemistry'); } catch { chemistryCache = null; }
  return chemistryCache;
}
let fxRatesCache = null;
function getFxRates() {
  if (fxRatesCache) return fxRatesCache;
  try { fxRatesCache = require('./document-fx-rates'); } catch { fxRatesCache = null; }
  return fxRatesCache;
}
let ibanSwiftCache = null;
function getIbanSwift() {
  if (ibanSwiftCache) return ibanSwiftCache;
  try { ibanSwiftCache = require('./document-iban-swift'); } catch { ibanSwiftCache = null; }
  return ibanSwiftCache;
}
let licensePlatesCache = null;
function getLicensePlates() {
  if (licensePlatesCache) return licensePlatesCache;
  try { licensePlatesCache = require('./document-license-plates'); } catch { licensePlatesCache = null; }
  return licensePlatesCache;
}
let legalCitationsCache = null;
function getLegalCitations() {
  if (legalCitationsCache) return legalCitationsCache;
  try { legalCitationsCache = require('./document-legal-citations'); } catch { legalCitationsCache = null; }
  return legalCitationsCache;
}
let socialUrlsCache = null;
function getSocialUrls() {
  if (socialUrlsCache) return socialUrlsCache;
  try { socialUrlsCache = require('./document-social-urls'); } catch { socialUrlsCache = null; }
  return socialUrlsCache;
}
let geneProteinCache = null;
function getGeneProtein() {
  if (geneProteinCache) return geneProteinCache;
  try { geneProteinCache = require('./document-gene-protein'); } catch { geneProteinCache = null; }
  return geneProteinCache;
}
let currencySymbolsCache = null;
function getCurrencySymbols() {
  if (currencySymbolsCache) return currencySymbolsCache;
  try { currencySymbolsCache = require('./document-currency-symbols'); } catch { currencySymbolsCache = null; }
  return currencySymbolsCache;
}
let phoneCodesCache = null;
function getPhoneCodes() {
  if (phoneCodesCache) return phoneCodesCache;
  try { phoneCodesCache = require('./document-phone-codes'); } catch { phoneCodesCache = null; }
  return phoneCodesCache;
}
let postalCodesCache = null;
function getPostalCodes() {
  if (postalCodesCache) return postalCodesCache;
  try { postalCodesCache = require('./document-postal-codes'); } catch { postalCodesCache = null; }
  return postalCodesCache;
}
let addressesCache = null;
function getAddresses() {
  if (addressesCache) return addressesCache;
  try { addressesCache = require('./document-addresses'); } catch { addressesCache = null; }
  return addressesCache;
}
let mimeTypesCache = null;
function getMimeTypes() {
  if (mimeTypesCache) return mimeTypesCache;
  try { mimeTypesCache = require('./document-mime-types'); } catch { mimeTypesCache = null; }
  return mimeTypesCache;
}
let utmParamsCache = null;
function getUtmParams() {
  if (utmParamsCache) return utmParamsCache;
  try { utmParamsCache = require('./document-utm-params'); } catch { utmParamsCache = null; }
  return utmParamsCache;
}
let creditCardsCache = null;
function getCreditCards() {
  if (creditCardsCache) return creditCardsCache;
  try { creditCardsCache = require('./document-credit-cards'); } catch { creditCardsCache = null; }
  return creditCardsCache;
}
let ssnPiiCache = null;
function getSsnPii() {
  if (ssnPiiCache) return ssnPiiCache;
  try { ssnPiiCache = require('./document-ssn-pii'); } catch { ssnPiiCache = null; }
  return ssnPiiCache;
}
let apiKeysCache = null;
function getApiKeys() {
  if (apiKeysCache) return apiKeysCache;
  try { apiKeysCache = require('./document-api-keys'); } catch { apiKeysCache = null; }
  return apiKeysCache;
}
let httpMethodsCache = null;
function getHttpMethods() {
  if (httpMethodsCache) return httpMethodsCache;
  try { httpMethodsCache = require('./document-http-methods'); } catch { httpMethodsCache = null; }
  return httpMethodsCache;
}
let containerRefsCache = null;
function getContainerRefs() {
  if (containerRefsCache) return containerRefsCache;
  try { containerRefsCache = require('./document-container-refs'); } catch { containerRefsCache = null; }
  return containerRefsCache;
}
let k8sRefsCache = null;
function getK8sRefs() {
  if (k8sRefsCache) return k8sRefsCache;
  try { k8sRefsCache = require('./document-k8s-refs'); } catch { k8sRefsCache = null; }
  return k8sRefsCache;
}
let metricsCache = null;
function getMetrics() {
  if (metricsCache) return metricsCache;
  try { metricsCache = require('./document-metrics'); } catch { metricsCache = null; }
  return metricsCache;
}
let oauthScopesCache = null;
function getOauthScopes() {
  if (oauthScopesCache) return oauthScopesCache;
  try { oauthScopesCache = require('./document-oauth-scopes'); } catch { oauthScopesCache = null; }
  return oauthScopesCache;
}
let cspDirectivesCache = null;
function getCspDirectives() {
  if (cspDirectivesCache) return cspDirectivesCache;
  try { cspDirectivesCache = require('./document-csp-directives'); } catch { cspDirectivesCache = null; }
  return cspDirectivesCache;
}
let mathOperatorsCache = null;
function getMathOperators() {
  if (mathOperatorsCache) return mathOperatorsCache;
  try { mathOperatorsCache = require('./document-math-operators'); } catch { mathOperatorsCache = null; }
  return mathOperatorsCache;
}
let spdxComplexCache = null;
function getSpdxComplex() {
  if (spdxComplexCache) return spdxComplexCache;
  try { spdxComplexCache = require('./document-spdx-complex'); } catch { spdxComplexCache = null; }
  return spdxComplexCache;
}
let featureFlagsCache = null;
function getFeatureFlags() {
  if (featureFlagsCache) return featureFlagsCache;
  try { featureFlagsCache = require('./document-feature-flags'); } catch { featureFlagsCache = null; }
  return featureFlagsCache;
}
let cookieAttrsCache = null;
function getCookieAttrs() {
  if (cookieAttrsCache) return cookieAttrsCache;
  try { cookieAttrsCache = require('./document-cookie-attrs'); } catch { cookieAttrsCache = null; }
  return cookieAttrsCache;
}
let otelTraceCache = null;
function getOtelTrace() {
  if (otelTraceCache) return otelTraceCache;
  try { otelTraceCache = require('./document-otel-trace'); } catch { otelTraceCache = null; }
  return otelTraceCache;
}
let cloudArnsCache = null;
function getCloudArns() {
  if (cloudArnsCache) return cloudArnsCache;
  try { cloudArnsCache = require('./document-cloud-arns'); } catch { cloudArnsCache = null; }
  return cloudArnsCache;
}
let mlModelsCache = null;
function getMlModels() {
  if (mlModelsCache) return mlModelsCache;
  try { mlModelsCache = require('./document-ml-models'); } catch { mlModelsCache = null; }
  return mlModelsCache;
}
let dbConnStringsCache = null;
function getDbConnStrings() {
  if (dbConnStringsCache) return dbConnStringsCache;
  try { dbConnStringsCache = require('./document-db-conn-strings'); } catch { dbConnStringsCache = null; }
  return dbConnStringsCache;
}
let graphqlOpsCache = null;
function getGraphqlOps() {
  if (graphqlOpsCache) return graphqlOpsCache;
  try { graphqlOpsCache = require('./document-graphql-ops'); } catch { graphqlOpsCache = null; }
  return graphqlOpsCache;
}
let grpcRefsCache = null;
function getGrpcRefs() {
  if (grpcRefsCache) return grpcRefsCache;
  try { grpcRefsCache = require('./document-grpc-refs'); } catch { grpcRefsCache = null; }
  return grpcRefsCache;
}
let stackTracesCache = null;
function getStackTraces() {
  if (stackTracesCache) return stackTracesCache;
  try { stackTracesCache = require('./document-stack-traces'); } catch { stackTracesCache = null; }
  return stackTracesCache;
}
let envNamesCache = null;
function getEnvNames() {
  if (envNamesCache) return envNamesCache;
  try { envNamesCache = require('./document-env-names'); } catch { envNamesCache = null; }
  return envNamesCache;
}
let testBlocksCache = null;
function getTestBlocks() {
  if (testBlocksCache) return testBlocksCache;
  try { testBlocksCache = require('./document-test-blocks'); } catch { testBlocksCache = null; }
  return testBlocksCache;
}
let gitShasCache = null;
function getGitShas() {
  if (gitShasCache) return gitShasCache;
  try { gitShasCache = require('./document-git-shas'); } catch { gitShasCache = null; }
  return gitShasCache;
}
let cloudStorageCache = null;
function getCloudStorage() {
  if (cloudStorageCache) return cloudStorageCache;
  try { cloudStorageCache = require('./document-cloud-storage'); } catch { cloudStorageCache = null; }
  return cloudStorageCache;
}
let webVitalsCache = null;
function getWebVitals() {
  if (webVitalsCache) return webVitalsCache;
  try { webVitalsCache = require('./document-web-vitals'); } catch { webVitalsCache = null; }
  return webVitalsCache;
}
let ariaA11yCache = null;
function getAriaA11y() {
  if (ariaA11yCache) return ariaA11yCache;
  try { ariaA11yCache = require('./document-aria-a11y'); } catch { ariaA11yCache = null; }
  return ariaA11yCache;
}
let i18nKeysCache = null;
function getI18nKeys() {
  if (i18nKeysCache) return i18nKeysCache;
  try { i18nKeysCache = require('./document-i18n-keys'); } catch { i18nKeysCache = null; }
  return i18nKeysCache;
}
let ciBuildIdsCache = null;
function getCiBuildIds() {
  if (ciBuildIdsCache) return ciBuildIdsCache;
  try { ciBuildIdsCache = require('./document-ci-build-ids'); } catch { ciBuildIdsCache = null; }
  return ciBuildIdsCache;
}
let userAgentsCache = null;
function getUserAgents() {
  if (userAgentsCache) return userAgentsCache;
  try { userAgentsCache = require('./document-user-agents'); } catch { userAgentsCache = null; }
  return userAgentsCache;
}
let cidrRangesCache = null;
function getCidrRanges() {
  if (cidrRangesCache) return cidrRangesCache;
  try { cidrRangesCache = require('./document-cidr-ranges'); } catch { cidrRangesCache = null; }
  return cidrRangesCache;
}
let cacheHeadersCache = null;
function getCacheHeaders() {
  if (cacheHeadersCache) return cacheHeadersCache;
  try { cacheHeadersCache = require('./document-cache-headers'); } catch { cacheHeadersCache = null; }
  return cacheHeadersCache;
}
let githubRefsCache = null;
function getGithubRefs() {
  if (githubRefsCache) return githubRefsCache;
  try { githubRefsCache = require('./document-github-refs'); } catch { githubRefsCache = null; }
  return githubRefsCache;
}
let apmRefsCache = null;
function getApmRefs() {
  if (apmRefsCache) return apmRefsCache;
  try { apmRefsCache = require('./document-apm-refs'); } catch { apmRefsCache = null; }
  return apmRefsCache;
}
let attackPatternsCache = null;
function getAttackPatterns() {
  if (attackPatternsCache) return attackPatternsCache;
  try { attackPatternsCache = require('./document-attack-patterns'); } catch { attackPatternsCache = null; }
  return attackPatternsCache;
}
let webhookUrlsCache = null;
function getWebhookUrls() {
  if (webhookUrlsCache) return webhookUrlsCache;
  try { webhookUrlsCache = require('./document-webhook-urls'); } catch { webhookUrlsCache = null; }
  return webhookUrlsCache;
}
let sshFingerprintsCache = null;
function getSshFingerprints() {
  if (sshFingerprintsCache) return sshFingerprintsCache;
  try { sshFingerprintsCache = require('./document-ssh-fingerprints'); } catch { sshFingerprintsCache = null; }
  return sshFingerprintsCache;
}
let npmRefsCache = null;
function getNpmRefs() {
  if (npmRefsCache) return npmRefsCache;
  try { npmRefsCache = require('./document-npm-refs'); } catch { npmRefsCache = null; }
  return npmRefsCache;
}
let correlationIdsCache = null;
function getCorrelationIds() {
  if (correlationIdsCache) return correlationIdsCache;
  try { correlationIdsCache = require('./document-correlation-ids'); } catch { correlationIdsCache = null; }
  return correlationIdsCache;
}
let paymentIdsCache = null;
function getPaymentIds() {
  if (paymentIdsCache) return paymentIdsCache;
  try { paymentIdsCache = require('./document-payment-ids'); } catch { paymentIdsCache = null; }
  return paymentIdsCache;
}
let emailHeadersCache = null;
function getEmailHeaders() {
  if (emailHeadersCache) return emailHeadersCache;
  try { emailHeadersCache = require('./document-email-headers'); } catch { emailHeadersCache = null; }
  return emailHeadersCache;
}
let icalEventsCache = null;
function getIcalEvents() {
  if (icalEventsCache) return icalEventsCache;
  try { icalEventsCache = require('./document-ical-events'); } catch { icalEventsCache = null; }
  return icalEventsCache;
}
let frontmatterCache = null;
function getFrontmatter() {
  if (frontmatterCache) return frontmatterCache;
  try { frontmatterCache = require('./document-frontmatter'); } catch { frontmatterCache = null; }
  return frontmatterCache;
}
let pullQuotesCache = null;
function getPullQuotes() {
  if (pullQuotesCache) return pullQuotesCache;
  try { pullQuotesCache = require('./document-pull-quotes'); } catch { pullQuotesCache = null; }
  return pullQuotesCache;
}
let ghaStepsCache = null;
function getGhaSteps() {
  if (ghaStepsCache) return ghaStepsCache;
  try { ghaStepsCache = require('./document-gha-steps'); } catch { ghaStepsCache = null; }
  return ghaStepsCache;
}
let terraformRefsCache = null;
function getTerraformRefs() {
  if (terraformRefsCache) return terraformRefsCache;
  try { terraformRefsCache = require('./document-terraform-refs'); } catch { terraformRefsCache = null; }
  return terraformRefsCache;
}
let helmRefsCache = null;
function getHelmRefs() {
  if (helmRefsCache) return helmRefsCache;
  try { helmRefsCache = require('./document-helm-refs'); } catch { helmRefsCache = null; }
  return helmRefsCache;
}
let naturalSchedulesCache = null;
function getNaturalSchedules() {
  if (naturalSchedulesCache) return naturalSchedulesCache;
  try { naturalSchedulesCache = require('./document-natural-schedules'); } catch { naturalSchedulesCache = null; }
  return naturalSchedulesCache;
}
let chatPermalinksCache = null;
function getChatPermalinks() {
  if (chatPermalinksCache) return chatPermalinksCache;
  try { chatPermalinksCache = require('./document-chat-permalinks'); } catch { chatPermalinksCache = null; }
  return chatPermalinksCache;
}
let pmTicketsCache = null;
function getPmTickets() {
  if (pmTicketsCache) return pmTicketsCache;
  try { pmTicketsCache = require('./document-pm-tickets'); } catch { pmTicketsCache = null; }
  return pmTicketsCache;
}
let slaTargetsCache = null;
function getSlaTargets() {
  if (slaTargetsCache) return slaTargetsCache;
  try { slaTargetsCache = require('./document-sla-targets'); } catch { slaTargetsCache = null; }
  return slaTargetsCache;
}
let tldsCache = null;
function getTlds() {
  if (tldsCache) return tldsCache;
  try { tldsCache = require('./document-tlds'); } catch { tldsCache = null; }
  return tldsCache;
}
let stockTickersCache = null;
function getStockTickers() {
  if (stockTickersCache) return stockTickersCache;
  try { stockTickersCache = require('./document-stock-tickers'); } catch { stockTickersCache = null; }
  return stockTickersCache;
}
let hardwareSpecsCache = null;
function getHardwareSpecs() {
  if (hardwareSpecsCache) return hardwareSpecsCache;
  try { hardwareSpecsCache = require('./document-hardware-specs'); } catch { hardwareSpecsCache = null; }
  return hardwareSpecsCache;
}
let bandwidthUnitsCache = null;
function getBandwidthUnits() {
  if (bandwidthUnitsCache) return bandwidthUnitsCache;
  try { bandwidthUnitsCache = require('./document-bandwidth-units'); } catch { bandwidthUnitsCache = null; }
  return bandwidthUnitsCache;
}
let trackingNumbersCache = null;
function getTrackingNumbers() {
  if (trackingNumbersCache) return trackingNumbersCache;
  try { trackingNumbersCache = require('./document-tracking-numbers'); } catch { trackingNumbersCache = null; }
  return trackingNumbersCache;
}
let rateLimitHeadersCache = null;
function getRateLimitHeaders() {
  if (rateLimitHeadersCache) return rateLimitHeadersCache;
  try { rateLimitHeadersCache = require('./document-rate-limit-headers'); } catch { rateLimitHeadersCache = null; }
  return rateLimitHeadersCache;
}
let cryptoWalletsCache = null;
function getCryptoWallets() {
  if (cryptoWalletsCache) return cryptoWalletsCache;
  try { cryptoWalletsCache = require('./document-crypto-wallets'); } catch { cryptoWalletsCache = null; }
  return cryptoWalletsCache;
}
let cveIdsCache = null;
function getCveIds() {
  if (cveIdsCache) return cveIdsCache;
  try { cveIdsCache = require('./document-cve-ids'); } catch { cveIdsCache = null; }
  return cveIdsCache;
}
let mediaTimestampsCache = null;
function getMediaTimestamps() {
  if (mediaTimestampsCache) return mediaTimestampsCache;
  try { mediaTimestampsCache = require('./document-media-timestamps'); } catch { mediaTimestampsCache = null; }
  return mediaTimestampsCache;
}
let linuxSignalsCache = null;
function getLinuxSignals() {
  if (linuxSignalsCache) return linuxSignalsCache;
  try { linuxSignalsCache = require('./document-linux-signals'); } catch { linuxSignalsCache = null; }
  return linuxSignalsCache;
}
let exitCodesCache = null;
function getExitCodes() {
  if (exitCodesCache) return exitCodesCache;
  try { exitCodesCache = require('./document-exit-codes'); } catch { exitCodesCache = null; }
  return exitCodesCache;
}
let networkPortsCache = null;
function getNetworkPorts() {
  if (networkPortsCache) return networkPortsCache;
  try { networkPortsCache = require('./document-network-ports'); } catch { networkPortsCache = null; }
  return networkPortsCache;
}
let linuxDistrosCache = null;
function getLinuxDistros() {
  if (linuxDistrosCache) return linuxDistrosCache;
  try { linuxDistrosCache = require('./document-linux-distros'); } catch { linuxDistrosCache = null; }
  return linuxDistrosCache;
}
let lifecyclePhasesCache = null;
function getLifecyclePhases() {
  if (lifecyclePhasesCache) return lifecyclePhasesCache;
  try { lifecyclePhasesCache = require('./document-lifecycle-phases'); } catch { lifecyclePhasesCache = null; }
  return lifecyclePhasesCache;
}
let projectCodenamesCache = null;
function getProjectCodenames() {
  if (projectCodenamesCache) return projectCodenamesCache;
  try { projectCodenamesCache = require('./document-project-codenames'); } catch { projectCodenamesCache = null; }
  return projectCodenamesCache;
}
let riskLevelsCache = null;
function getRiskLevels() {
  if (riskLevelsCache) return riskLevelsCache;
  try { riskLevelsCache = require('./document-risk-levels'); } catch { riskLevelsCache = null; }
  return riskLevelsCache;
}
let saasMetricsCache = null;
function getSaasMetrics() {
  if (saasMetricsCache) return saasMetricsCache;
  try { saasMetricsCache = require('./document-saas-metrics'); } catch { saasMetricsCache = null; }
  return saasMetricsCache;
}
let recipeMeasurementsCache = null;
function getRecipeMeasurements() {
  if (recipeMeasurementsCache) return recipeMeasurementsCache;
  try { recipeMeasurementsCache = require('./document-recipe-measurements'); } catch { recipeMeasurementsCache = null; }
  return recipeMeasurementsCache;
}
let isoLangsCache = null;
function getIsoLangs() {
  if (isoLangsCache) return isoLangsCache;
  try { isoLangsCache = require('./document-iso-langs'); } catch { isoLangsCache = null; }
  return isoLangsCache;
}
let prReviewStatesCache = null;
function getPrReviewStates() {
  if (prReviewStatesCache) return prReviewStatesCache;
  try { prReviewStatesCache = require('./document-pr-review-states'); } catch { prReviewStatesCache = null; }
  return prReviewStatesCache;
}
let pricingTiersCache = null;
function getPricingTiers() {
  if (pricingTiersCache) return pricingTiersCache;
  try { pricingTiersCache = require('./document-pricing-tiers'); } catch { pricingTiersCache = null; }
  return pricingTiersCache;
}
let arxivIdsCache = null;
function getArxivIds() {
  if (arxivIdsCache) return arxivIdsCache;
  try { arxivIdsCache = require('./document-arxiv-ids'); } catch { arxivIdsCache = null; }
  return arxivIdsCache;
}
let doiIdsCache = null;
function getDoiIds() {
  if (doiIdsCache) return doiIdsCache;
  try { doiIdsCache = require('./document-doi-ids'); } catch { doiIdsCache = null; }
  return doiIdsCache;
}
let orcidIdsCache = null;
function getOrcidIds() {
  if (orcidIdsCache) return orcidIdsCache;
  try { orcidIdsCache = require('./document-orcid-ids'); } catch { orcidIdsCache = null; }
  return orcidIdsCache;
}
let wikiRefsCache = null;
function getWikiRefs() {
  if (wikiRefsCache) return wikiRefsCache;
  try { wikiRefsCache = require('./document-wiki-refs'); } catch { wikiRefsCache = null; }
  return wikiRefsCache;
}
let pubmedIdsCache = null;
function getPubmedIds() {
  if (pubmedIdsCache) return pubmedIdsCache;
  try { pubmedIdsCache = require('./document-pubmed-ids'); } catch { pubmedIdsCache = null; }
  return pubmedIdsCache;
}
let serviceAccountsCache = null;
function getServiceAccounts() {
  if (serviceAccountsCache) return serviceAccountsCache;
  try { serviceAccountsCache = require('./document-service-accounts'); } catch { serviceAccountsCache = null; }
  return serviceAccountsCache;
}
let vinNumbersCache = null;
function getVinNumbers() {
  if (vinNumbersCache) return vinNumbersCache;
  try { vinNumbersCache = require('./document-vin-numbers'); } catch { vinNumbersCache = null; }
  return vinNumbersCache;
}
let emojiShortcodesCache = null;
function getEmojiShortcodes() {
  if (emojiShortcodesCache) return emojiShortcodesCache;
  try { emojiShortcodesCache = require('./document-emoji-shortcodes'); } catch { emojiShortcodesCache = null; }
  return emojiShortcodesCache;
}
let bibtexEntriesCache = null;
function getBibtexEntries() {
  if (bibtexEntriesCache) return bibtexEntriesCache;
  try { bibtexEntriesCache = require('./document-bibtex-entries'); } catch { bibtexEntriesCache = null; }
  return bibtexEntriesCache;
}
let latexCommandsCache = null;
function getLatexCommands() {
  if (latexCommandsCache) return latexCommandsCache;
  try { latexCommandsCache = require('./document-latex-commands'); } catch { latexCommandsCache = null; }
  return latexCommandsCache;
}
let progLangsCache = null;
function getProgLangs() {
  if (progLangsCache) return progLangsCache;
  try { progLangsCache = require('./document-prog-langs'); } catch { progLangsCache = null; }
  return progLangsCache;
}
let complianceRefsCache = null;
function getComplianceRefs() {
  if (complianceRefsCache) return complianceRefsCache;
  try { complianceRefsCache = require('./document-compliance-refs'); } catch { complianceRefsCache = null; }
  return complianceRefsCache;
}
let tlsCiphersCache = null;
function getTlsCiphers() {
  if (tlsCiphersCache) return tlsCiphersCache;
  try { tlsCiphersCache = require('./document-tls-ciphers'); } catch { tlsCiphersCache = null; }
  return tlsCiphersCache;
}
let dnsRecordsCache = null;
function getDnsRecords() {
  if (dnsRecordsCache) return dnsRecordsCache;
  try { dnsRecordsCache = require('./document-dns-records'); } catch { dnsRecordsCache = null; }
  return dnsRecordsCache;
}
let emailAuthCache = null;
function getEmailAuth() {
  if (emailAuthCache) return emailAuthCache;
  try { emailAuthCache = require('./document-email-auth'); } catch { emailAuthCache = null; }
  return emailAuthCache;
}
let openapiKeysCache = null;
function getOpenapiKeys() {
  if (openapiKeysCache) return openapiKeysCache;
  try { openapiKeysCache = require('./document-openapi-keys'); } catch { openapiKeysCache = null; }
  return openapiKeysCache;
}
let kafkaRefsCache = null;
function getKafkaRefs() {
  if (kafkaRefsCache) return kafkaRefsCache;
  try { kafkaRefsCache = require('./document-kafka-refs'); } catch { kafkaRefsCache = null; }
  return kafkaRefsCache;
}
let ansiEscapesCache = null;
function getAnsiEscapes() {
  if (ansiEscapesCache) return ansiEscapesCache;
  try { ansiEscapesCache = require('./document-ansi-escapes'); } catch { ansiEscapesCache = null; }
  return ansiEscapesCache;
}
let sqlWindowsCache = null;
function getSqlWindows() {
  if (sqlWindowsCache) return sqlWindowsCache;
  try { sqlWindowsCache = require('./document-sql-windows'); } catch { sqlWindowsCache = null; }
  return sqlWindowsCache;
}
let websocketMarkersCache = null;
function getWebsocketMarkers() {
  if (websocketMarkersCache) return websocketMarkersCache;
  try { websocketMarkersCache = require('./document-websocket-markers'); } catch { websocketMarkersCache = null; }
  return websocketMarkersCache;
}
let isoDurationsCache = null;
function getIsoDurations() {
  if (isoDurationsCache) return isoDurationsCache;
  try { isoDurationsCache = require('./document-iso-durations'); } catch { isoDurationsCache = null; }
  return isoDurationsCache;
}
let browserSupportCache = null;
function getBrowserSupport() {
  if (browserSupportCache) return browserSupportCache;
  try { browserSupportCache = require('./document-browser-support'); } catch { browserSupportCache = null; }
  return browserSupportCache;
}
let numberBasesCache = null;
function getNumberBases() {
  if (numberBasesCache) return numberBasesCache;
  try { numberBasesCache = require('./document-number-bases'); } catch { numberBasesCache = null; }
  return numberBasesCache;
}
let dmsCoordsCache = null;
function getDmsCoords() {
  if (dmsCoordsCache) return dmsCoordsCache;
  try { dmsCoordsCache = require('./document-dms-coords'); } catch { dmsCoordsCache = null; }
  return dmsCoordsCache;
}
let containerRegistriesCache = null;
function getContainerRegistries() {
  if (containerRegistriesCache) return containerRegistriesCache;
  try { containerRegistriesCache = require('./document-container-registries'); } catch { containerRegistriesCache = null; }
  return containerRegistriesCache;
}
let wktGeometryCache = null;
function getWktGeometry() {
  if (wktGeometryCache) return wktGeometryCache;
  try { wktGeometryCache = require('./document-wkt-geometry'); } catch { wktGeometryCache = null; }
  return wktGeometryCache;
}
let mdRefLinksCache = null;
function getMdRefLinks() {
  if (mdRefLinksCache) return mdRefLinksCache;
  try { mdRefLinksCache = require('./document-md-ref-links'); } catch { mdRefLinksCache = null; }
  return mdRefLinksCache;
}
let botTokensCache = null;
function getBotTokens() {
  if (botTokensCache) return botTokensCache;
  try { botTokensCache = require('./document-bot-tokens'); } catch { botTokensCache = null; }
  return botTokensCache;
}
let cargoPackagesCache = null;
function getCargoPackages() {
  if (cargoPackagesCache) return cargoPackagesCache;
  try { cargoPackagesCache = require('./document-cargo-packages'); } catch { cargoPackagesCache = null; }
  return cargoPackagesCache;
}
let goModulesCache = null;
function getGoModules() {
  if (goModulesCache) return goModulesCache;
  try { goModulesCache = require('./document-go-modules'); } catch { goModulesCache = null; }
  return goModulesCache;
}
let mavenCoordsCache = null;
function getMavenCoords() {
  if (mavenCoordsCache) return mavenCoordsCache;
  try { mavenCoordsCache = require('./document-maven-coords'); } catch { mavenCoordsCache = null; }
  return mavenCoordsCache;
}
let pipReqsCache = null;
function getPipReqs() {
  if (pipReqsCache) return pipReqsCache;
  try { pipReqsCache = require('./document-pip-reqs'); } catch { pipReqsCache = null; }
  return pipReqsCache;
}
let composerPkgsCache = null;
function getComposerPkgs() {
  if (composerPkgsCache) return composerPkgsCache;
  try { composerPkgsCache = require('./document-composer-pkgs'); } catch { composerPkgsCache = null; }
  return composerPkgsCache;
}
let nugetPkgsCache = null;
function getNugetPkgs() {
  if (nugetPkgsCache) return nugetPkgsCache;
  try { nugetPkgsCache = require('./document-nuget-pkgs'); } catch { nugetPkgsCache = null; }
  return nugetPkgsCache;
}
let gemPkgsCache = null;
function getGemPkgs() {
  if (gemPkgsCache) return gemPkgsCache;
  try { gemPkgsCache = require('./document-gem-pkgs'); } catch { gemPkgsCache = null; }
  return gemPkgsCache;
}
let hexPkgsCache = null;
function getHexPkgs() {
  if (hexPkgsCache) return hexPkgsCache;
  try { hexPkgsCache = require('./document-hex-pkgs'); } catch { hexPkgsCache = null; }
  return hexPkgsCache;
}
let svgPathCmdsCache = null;
function getSvgPathCmds() {
  if (svgPathCmdsCache) return svgPathCmdsCache;
  try { svgPathCmdsCache = require('./document-svg-path-cmds'); } catch { svgPathCmdsCache = null; }
  return svgPathCmdsCache;
}
let geojsonCache = null;
function getGeojson() {
  if (geojsonCache) return geojsonCache;
  try { geojsonCache = require('./document-geojson'); } catch { geojsonCache = null; }
  return geojsonCache;
}
let pwaManifestCache = null;
function getPwaManifest() {
  if (pwaManifestCache) return pwaManifestCache;
  try { pwaManifestCache = require('./document-pwa-manifest'); } catch { pwaManifestCache = null; }
  return pwaManifestCache;
}
let permissionsApiCache = null;
function getPermissionsApi() {
  if (permissionsApiCache) return permissionsApiCache;
  try { permissionsApiCache = require('./document-permissions-api'); } catch { permissionsApiCache = null; }
  return permissionsApiCache;
}
let serverlessFnsCache = null;
function getServerlessFns() {
  if (serverlessFnsCache) return serverlessFnsCache;
  try { serverlessFnsCache = require('./document-serverless-fns'); } catch { serverlessFnsCache = null; }
  return serverlessFnsCache;
}
let dbMigrationsCache = null;
function getDbMigrations() {
  if (dbMigrationsCache) return dbMigrationsCache;
  try { dbMigrationsCache = require('./document-db-migrations'); } catch { dbMigrationsCache = null; }
  return dbMigrationsCache;
}
let eslintRulesCache = null;
function getEslintRules() {
  if (eslintRulesCache) return eslintRulesCache;
  try { eslintRulesCache = require('./document-eslint-rules'); } catch { eslintRulesCache = null; }
  return eslintRulesCache;
}
let buildToolsCache = null;
function getBuildTools() {
  if (buildToolsCache) return buildToolsCache;
  try { buildToolsCache = require('./document-build-tools'); } catch { buildToolsCache = null; }
  return buildToolsCache;
}
let jwtClaimsCache = null;
function getJwtClaims() {
  if (jwtClaimsCache) return jwtClaimsCache;
  try { jwtClaimsCache = require('./document-jwt-claims'); } catch { jwtClaimsCache = null; }
  return jwtClaimsCache;
}
let sriHashesCache = null;
function getSriHashes() {
  if (sriHashesCache) return sriHashesCache;
  try { sriHashesCache = require('./document-sri-hashes'); } catch { sriHashesCache = null; }
  return sriHashesCache;
}
let jsonSchemaCache = null;
function getJsonSchema() {
  if (jsonSchemaCache) return jsonSchemaCache;
  try { jsonSchemaCache = require('./document-json-schema'); } catch { jsonSchemaCache = null; }
  return jsonSchemaCache;
}
let prismaSchemaCache = null;
function getPrismaSchema() {
  if (prismaSchemaCache) return prismaSchemaCache;
  try { prismaSchemaCache = require('./document-prisma-schema'); } catch { prismaSchemaCache = null; }
  return prismaSchemaCache;
}
let graphqlFragmentsCache = null;
function getGraphqlFragments() {
  if (graphqlFragmentsCache) return graphqlFragmentsCache;
  try { graphqlFragmentsCache = require('./document-graphql-fragments'); } catch { graphqlFragmentsCache = null; }
  return graphqlFragmentsCache;
}
let cssVarsCache = null;
function getCssVars() {
  if (cssVarsCache) return cssVarsCache;
  try { cssVarsCache = require('./document-css-vars'); } catch { cssVarsCache = null; }
  return cssVarsCache;
}
let composeServicesCache = null;
function getComposeServices() {
  if (composeServicesCache) return composeServicesCache;
  try { composeServicesCache = require('./document-compose-services'); } catch { composeServicesCache = null; }
  return composeServicesCache;
}
let regexFlagsCache = null;
function getRegexFlags() {
  if (regexFlagsCache) return regexFlagsCache;
  try { regexFlagsCache = require('./document-regex-flags'); } catch { regexFlagsCache = null; }
  return regexFlagsCache;
}
let vueSfcCache = null;
function getVueSfc() {
  if (vueSfcCache) return vueSfcCache;
  try { vueSfcCache = require('./document-vue-sfc'); } catch { vueSfcCache = null; }
  return vueSfcCache;
}
let astroCache = null;
function getAstro() {
  if (astroCache) return astroCache;
  try { astroCache = require('./document-astro'); } catch { astroCache = null; }
  return astroCache;
}
let e2eTestsCache = null;
function getE2eTests() {
  if (e2eTestsCache) return e2eTestsCache;
  try { e2eTestsCache = require('./document-e2e-tests'); } catch { e2eTestsCache = null; }
  return e2eTestsCache;
}
let mswHandlersCache = null;
function getMswHandlers() {
  if (mswHandlersCache) return mswHandlersCache;
  try { mswHandlersCache = require('./document-msw-handlers'); } catch { mswHandlersCache = null; }
  return mswHandlersCache;
}
let ghWorkflowsCache = null;
function getGhWorkflows() {
  if (ghWorkflowsCache) return ghWorkflowsCache;
  try { ghWorkflowsCache = require('./document-gh-workflows'); } catch { ghWorkflowsCache = null; }
  return ghWorkflowsCache;
}
let jsonLdCache = null;
function getJsonLd() {
  if (jsonLdCache) return jsonLdCache;
  try { jsonLdCache = require('./document-json-ld'); } catch { jsonLdCache = null; }
  return jsonLdCache;
}
let tailwindCache = null;
function getTailwind() {
  if (tailwindCache) return tailwindCache;
  try { tailwindCache = require('./document-tailwind'); } catch { tailwindCache = null; }
  return tailwindCache;
}
let mongoAggCache = null;
function getMongoAgg() {
  if (mongoAggCache) return mongoAggCache;
  try { mongoAggCache = require('./document-mongo-agg'); } catch { mongoAggCache = null; }
  return mongoAggCache;
}
let helmCache = null;
function getHelm() {
  if (helmCache) return helmCache;
  try { helmCache = require('./document-helm'); } catch { helmCache = null; }
  return helmCache;
}
let vitestCache = null;
function getVitest() {
  if (vitestCache) return vitestCache;
  try { vitestCache = require('./document-vitest'); } catch { vitestCache = null; }
  return vitestCache;
}
let mjmlCache = null;
function getMjml() {
  if (mjmlCache) return mjmlCache;
  try { mjmlCache = require('./document-mjml'); } catch { mjmlCache = null; }
  return mjmlCache;
}
let stripeCache = null;
function getStripe() {
  if (stripeCache) return stripeCache;
  try { stripeCache = require('./document-stripe'); } catch { stripeCache = null; }
  return stripeCache;
}
let terraformVarsCache = null;
function getTerraformVars() {
  if (terraformVarsCache) return terraformVarsCache;
  try { terraformVarsCache = require('./document-terraform-vars'); } catch { terraformVarsCache = null; }
  return terraformVarsCache;
}
let openapiSecurityCache = null;
function getOpenapiSecurity() {
  if (openapiSecurityCache) return openapiSecurityCache;
  try { openapiSecurityCache = require('./document-openapi-security'); } catch { openapiSecurityCache = null; }
  return openapiSecurityCache;
}
let k8sResourcesCache = null;
function getK8sResources() {
  if (k8sResourcesCache) return k8sResourcesCache;
  try { k8sResourcesCache = require('./document-k8s-resources'); } catch { k8sResourcesCache = null; }
  return k8sResourcesCache;
}
let cssAnimCache = null;
function getCssAnim() {
  if (cssAnimCache) return cssAnimCache;
  try { cssAnimCache = require('./document-css-anim'); } catch { cssAnimCache = null; }
  return cssAnimCache;
}
let storybookCache = null;
function getStorybook() {
  if (storybookCache) return storybookCache;
  try { storybookCache = require('./document-storybook'); } catch { storybookCache = null; }
  return storybookCache;
}
let sentryCache = null;
function getSentry() {
  if (sentryCache) return sentryCache;
  try { sentryCache = require('./document-sentry'); } catch { sentryCache = null; }
  return sentryCache;
}
let natsCache = null;
function getNats() {
  if (natsCache) return natsCache;
  try { natsCache = require('./document-nats'); } catch { natsCache = null; }
  return natsCache;
}
let pkgJsonCache = null;
function getPkgJson() {
  if (pkgJsonCache) return pkgJsonCache;
  try { pkgJsonCache = require('./document-pkg-json'); } catch { pkgJsonCache = null; }
  return pkgJsonCache;
}
let redisCache = null;
function getRedis() {
  if (redisCache) return redisCache;
  try { redisCache = require('./document-redis'); } catch { redisCache = null; }
  return redisCache;
}
let nginxCache = null;
function getNginx() {
  if (nginxCache) return nginxCache;
  try { nginxCache = require('./document-nginx'); } catch { nginxCache = null; }
  return nginxCache;
}
let otelCache = null;
function getOtel() {
  if (otelCache) return otelCache;
  try { otelCache = require('./document-otel'); } catch { otelCache = null; }
  return otelCache;
}
let moduleFederationCache = null;
function getModuleFederation() {
  if (moduleFederationCache) return moduleFederationCache;
  try { moduleFederationCache = require('./document-module-federation'); } catch { moduleFederationCache = null; }
  return moduleFederationCache;
}

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
  // ── Extended catalogue (added v2026.5.x) ──────────────────────────
  // Source code / scripts pasted as text or attached as a code file.
  {
    type: 'source_code',
    weight: 4,
    mime: /(javascript|typescript|x-python|x-go|x-rust|x-java|x-csharp|x-c|x-c\+\+|x-php|x-ruby|x-swift|x-kotlin|x-shellscript|x-sh|x-sql)/i,
    name: /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|rs|go|java|cs|cpp|c|h|hpp|php|swift|kt|kts|sh|bash|zsh|sql|graphql|gql|scala|hs|elm|ml|lua|r)$/i,
    body: [
      /(^|\n)\s*(import\s+.+\s+from\s+["'][^"']+["']|const\s+\w+\s*=|export\s+(default\s+)?(function|class|const|interface|type)|require\(['"][^'"]+['"]\))/,
      /(^|\n)\s*(def\s+\w+\s*\(|class\s+\w+\s*[:(]|from\s+\w+\s+import|if __name__\s*==\s*['"]__main__['"])/,
      /(^|\n)\s*(public\s+(static\s+)?(class|interface|enum|void)|@Override\b|System\.out\.println)/,
      /(^|\n)\s*(fn\s+\w+\s*\(|let\s+(mut\s+)?\w+\s*[:=]|use\s+\w+::|impl\s+\w+|#\[derive\()/,
      /(^|\n)\s*(package\s+\w+\s*;|func\s+\w+\s*\(|type\s+\w+\s+struct\s*\{)/,
      /(^|\n)\s*(?:#include\s*<[^>]+>|namespace\s+\w+|template\s*<)/,
    ],
    bodyMin: 1,
  },
  // YAML / JSON / TOML / INI / Dockerfile / .env style configuration files.
  {
    type: 'configuration_file',
    weight: 4,
    mime: /(yaml|json|toml|ini|x-properties|x-dockerfile|x-shellscript)/i,
    name: /(\.(ya?ml|json|jsonc|toml|ini|cfg|conf|properties|env|dockerfile)|^Dockerfile$|docker-compose\.ya?ml$|tsconfig\.json$|package\.json$|requirements\.txt$|pyproject\.toml$|cargo\.toml$|gemfile$)/i,
    body: [
      /(^|\n)\s*[\w.-]+\s*:\s+\S/,
      /(^|\n)\s*\[[^\]]+\]\s*$/,
      /(^|\n)\s*[\w.-]+\s*=\s*\S/,
      /(^|\n)\s*FROM\s+\S+(:[\w.-]+)?/i,
      /(^|\n)\s*(image|version|services|environment|volumes|ports|networks|stages|jobs|steps):/i,
      /(^|\n)\s*"[^"]+"\s*:\s*("|\d|true|false|null|\{|\[)/,
    ],
    bodyMin: 2,
  },
  // Application logs, audit trails, or stack traces. We deliberately do
  // NOT match text/plain in the mime — that would catch every .txt file.
  // Detection relies on the filename extension or strong body signals.
  {
    type: 'log_file',
    weight: 4,
    mime: /x-log/i,
    name: /\.(log|out|err|trace|stacktrace)$/i,
    body: [
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/m,
      /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\b/i,
      /\bTraceback \(most recent call last\):/,
      /^\s*at\s+[\w.<>$]+\s*\([^)]+:\d+:\d+\)/m,
      /^\s+at\s+[\w$.]+\([\w$]+\.\w+:\d+\)/m,
      /\bcaused by:?\s+\w/i,
      /\b(?:status|http)\s*[:=]\s*[1-5]\d{2}\b/i,
    ],
    bodyMin: 2,
  },
  // Meeting / interview / call transcripts with explicit speaker labels.
  {
    type: 'meeting_transcript',
    weight: 3,
    name: /(transcript|transcripci[oó]n|minutes?|acta|reuni[oó]n|meeting|interview|entrevista|call)/i,
    body: [
      /^(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s+)?[A-ZÁÉÍÓÚÑ][\w\s]{0,30}:\s+/m,
      /\b(?:00|01|02):\d{2}:\d{2}\s+[-—]\s+/,
      /\b(speaker\s+\d+|hablante\s+\d+|moderator|moderador|host|presenter)\b/i,
      /\b(action\s+item|todo|next\s+steps?|agenda|minutes?|attendees?|asistentes?)\b/i,
      /\b(thank\s+you|gracias|let'?s\s+|let\s+us|next\s+slide|moving\s+on)\b/i,
    ],
    bodyMin: 2,
  },
  // Regulatory / compliance / policy / audit documents (GDPR, SOC 2, HIPAA, ISO).
  {
    type: 'regulatory_compliance',
    weight: 3,
    name: /(compliance|cumplimiento|regulato|normativ|policy|pol[ií]tica|gdpr|hipaa|sox|iso\s*\d|pci\s*dss|soc\s*\d)/i,
    body: [
      /\b(GDPR|HIPAA|SOC\s*[12]|ISO\s*\d{4,5}|PCI\s*DSS|CCPA|NIST|CIS\s+benchmark)\b/i,
      /\b(data\s+subject|titular|controller|processor|encargado|responsable)\b/i,
      /\b(audit(or)?\b|auditor[ií]a|attestation|assessment|evaluaci[oó]n)\b/i,
      /\b(control(s)?\s+\d+(\.\d+)?|requirement\s+\d+|requisito\s+\d+|salvaguarda)\b/i,
      /\b(risk\s+register|matriz\s+de\s+riesgos|treatment\s+plan|plan\s+de\s+tratamiento)\b/i,
    ],
    bodyMin: 2,
  },
  // Research / grant / project proposals (RFC, RFP, RFI, call for proposals).
  {
    type: 'research_proposal',
    weight: 3,
    name: /(proposal|propuesta|grant|beca|rfc|rfp|rfi|tender|licitaci[oó]n)/i,
    body: [
      /\b(problem\s+statement|planteamiento\s+del\s+problema|objectives?|objetivos?)\b/i,
      /\b(deliverables?|entregables?|milestones?|hitos?|timeline|cronograma)\b/i,
      /\b(budget|presupuesto|funding|financiaci[oó]n|cost(s)?|costos?)\b/i,
      /\b(team|equipo|principal\s+investigator|investigador\s+principal|ki|pm)\b/i,
      /\b(success\s+criteria|criterios\s+de\s+[ée]xito|expected\s+outcomes?|resultados\s+esperados)\b/i,
    ],
    bodyMin: 2,
  },
  {
    type: 'patent',
    weight: 4,
    name: /(patent|patente|utility[- _]?patent|invention|invenci[oó]n|uspto|wipo|epo|jpo|kipo)/i,
    body: [
      /\b(claims?|reivindicaci[oó]nes?)\s*[:\d]/i,
      /\b(background|antecedentes|prior\s+art|estado\s+(?:del|de\s+la)\s+arte|t[eé]cnica\s+anterior)\b/i,
      /\b(embodiment|realizaci[oó]n|preferred\s+embodiment|forma\s+de\s+realizaci[oó]n)\b/i,
      /\b(abstract|resumen|brief\s+description|breve\s+descripci[oó]n)\b/i,
      /\b(figure?\s+\d|fig\.?\s*\d|drawings?|dibujos?)\b/i,
      /\b(inventor|inventor(?:a|es|as)|applicant|solicitante)\b/i,
      /\b(patent\s+(?:no|number|n[uú]mero)|application\s+no|n[uú]mero\s+de\s+aplicaci[oó]n)\b/i,
    ],
    bodyMin: 3,
  },
  {
    type: 'employment_contract',
    weight: 4,
    name: /(employment|labor|laboral|trabajo|empleo|hire|hiring|onboarding|nda|non[- _]?compete|non[- _]?disclosure|severance|finiquito)/i,
    body: [
      /\b(salary|salario|sueldo|remuneration|remuneraci[oó]n|annual\s+compensation|compensaci[oó]n\s+anual)\b/i,
      /\b(position|cargo|puesto|job\s+title|t[ií]tulo|reports?\s+to|reporta\s+a)\b/i,
      /\b(probation(?:ary)?(?:\s+period)?|per[ií]odo\s+de\s+prueba)\b/i,
      /\b(vacation|holiday|paid\s+time\s+off|pto|vacaciones|d[ií]as\s+libres)\b/i,
      /\b(termination|t[eé]rmino|despido|renuncia|severance|finiquito|notice\s+period|preaviso)\b/i,
      /\b(non[- _]?compete|non[- _]?solicitation|confidential(?:idad|ity)|ip\s+assignment|cesi[oó]n\s+de\s+propiedad)\b/i,
      /\b(working\s+hours|jornada|horario\s+(?:laboral|de\s+trabajo))\b/i,
    ],
    bodyMin: 3,
  },
  {
    type: 'bank_statement',
    weight: 4,
    name: /(bank[- _]?statement|estado[- _]?de[- _]?cuenta|extracto[- _]?bancario|account[- _]?statement|cartilla)/i,
    body: [
      /\b(opening\s+balance|saldo\s+(?:inicial|anterior)|previous\s+balance)\b/i,
      /\b(closing\s+balance|saldo\s+(?:final|actual|al\s+corte))\b/i,
      /\b(account\s+(?:no|number)|n[uú]mero\s+de\s+cuenta|iban|swift|bic)\b/i,
      /\b(transaction|movimiento|deposit|dep[oó]sito|withdrawal|retiro|debit|d[eé]bito|credit|cr[eé]dito)\b/i,
      /\b(statement\s+period|per[ií]odo\s+del\s+estado|fecha\s+de\s+corte)\b/i,
      /\b(interest|inter[eé]s|fee|comisi[oó]n|overdraft|sobregiro)\b/i,
    ],
    bodyMin: 3,
  },
  {
    type: 'insurance_policy',
    weight: 4,
    name: /(insurance|seguro|p[oó]liza|policy|coverage|cobertura|aseguradora|insurer)/i,
    body: [
      /\b(premium|prima|deductible|deducible|coverage\s+amount|monto\s+(?:de|del)\s+cobertura)\b/i,
      /\b(insured|asegurado|beneficiary|beneficiari[oa]|policyholder|titular\s+de\s+(?:la|el)\s+p[oó]liza)\b/i,
      /\b(coverage|cobertura|inclusiones|inclusions|exclusions?|exclusiones)\b/i,
      /\b(claim|reclamaci[oó]n|siniestro|process|proceso\s+de\s+reclamaci[oó]n)\b/i,
      /\b(effective\s+date|fecha\s+(?:de\s+)?(?:inicio|vigencia)|expiration|vencimiento)\b/i,
      /\b(rider|endoso|amendment|enmienda|policy\s+(?:no|number)|n[uú]mero\s+de\s+p[oó]liza)\b/i,
    ],
    bodyMin: 3,
  },
  {
    type: 'incident_postmortem',
    weight: 4,
    name: /(postmortem|post[- _]?mortem|incident[- _]?(?:report|review)|outage|sev[- _]?[0-9]|incidente|rca|root[- _]?cause)/i,
    body: [
      /\b(timeline|cronolog[ií]a|sequence\s+of\s+events|secuencia\s+de\s+eventos)\b/i,
      /\b(root\s+cause|causa\s+(?:ra[ií]z|principal|fundamental)|rca)\b/i,
      /\b(impact|impacto|customer[- _]?impact|usuarios?\s+afectados|sla|sli|slo)\b/i,
      /\b(detection|detecci[oó]n|alert|alerta|on[- _]?call|guardia)\b/i,
      /\b(mitigation|mitigaci[oó]n|remediation|remediaci[oó]n|rollback|reversi[oó]n)\b/i,
      /\b(action\s+items?|elementos?\s+de\s+acci[oó]n|follow[- _]?ups?|seguimientos?)\b/i,
      /\b(5[\s-]?whys?|fishbone|ishikawa|why\s+\d|por\s+qu[eé])\b/i,
    ],
    bodyMin: 3,
  },
  {
    type: 'pitch_deck',
    weight: 4,
    name: /(pitch[- _]?deck|investor[- _]?deck|fundraising[- _]?deck|seed[- _]?deck|series[- _]?[a-z][- _]?deck|deck\s*(?:investor|seed|fundraise))/i,
    mime: /presentation|powerpoint|impress|keynote/i,
    body: [
      /\b(TAM|SAM|SOM|total\s+addressable\s+market|mercado\s+(?:total|objetivo))\b/i,
      /\b(traction|tracci[oó]n|MRR|ARR|MoM|YoY|growth\s+rate|tasa\s+de\s+crecimiento)\b/i,
      /\b(runway|burn\s+rate|tasa\s+de\s+(?:quema|gasto)|cash\s+on\s+hand|caja\s+disponible)\b/i,
      /\b(founders?|fundador(?:es|as)?|team|equipo|cap\s+table|tabla\s+de\s+capitalizaci[oó]n)\b/i,
      /\b(round|ronda|seed|series\s+[a-z]|pre-seed|valuation|valoraci[oó]n|raise|levantamiento)\b/i,
      /\b(go[- _]?to[- _]?market|GTM|product[- _]?market\s+fit|PMF|business\s+model|modelo\s+de\s+negocio)\b/i,
      /\b(competition|competencia|moat|ventaja\s+competitiva|differentiat\w+|diferenciaci[oó]n)\b/i,
    ],
    bodyMin: 3,
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

  source_code: `### SOURCE CODE ANALYSIS RECIPE
You are reading source code (a file, snippet, or pasted excerpt). Produce a senior-engineer review the author can act on. Cover:
1. **File identity** — language, file purpose (entry point / library module / test / config / migration / script), top-level exports.
2. **Public surface** — list every exported function, class, type, constant — signature + 1-line purpose. Markdown table.
3. **Dependencies** — imports / requires used, grouped by stdlib vs first-party vs third-party. Note any with known security or maintenance concerns.
4. **Control flow & complexity** — entry points, key branches, recursive/iterative structures. Flag functions >50 lines or with cyclomatic complexity >8 estimated by branch count.
5. **Type safety & correctness** — null-safety holes, missing exhaustive checks, unhandled promise rejections, swallowed errors, mutation of shared state, off-by-one, race conditions.
6. **Security review** — injection vectors (SQL/HTML/shell/path), unsafe deserialization, hard-coded secrets, weak crypto, missing authentication/authorization, unsafe \`eval\` / \`new Function\` / \`exec\`, insecure http calls, missing input validation, unsafe regex (catastrophic backtracking).
7. **Performance hotspots** — quadratic loops, unbounded recursion, missing memoization, sync I/O in hot path, allocations inside loops, redundant DB queries (N+1), missing indices implied by query patterns.
8. **Test coverage signal** — does the file have an obvious test counterpart? Is the code structured to be testable (pure functions, dependency injection)?
9. **Refactor opportunities** — duplication, deep nesting, large parameter lists, primitive obsession, god functions, circular deps, naming clarity. Prioritise top 5.
10. **Concrete patches** — for the top 3 issues, write the actual replacement code as a unified diff (\`\`\`diff fenced block\`\`\`). Include before/after.
Always quote line ranges or symbol names ("\`server.ts\` L120-145", "\`UserService.create\`"). End with a "Ship-readiness verdict": ready / needs review / needs rework + 1 sentence why.`,

  configuration_file: `### CONFIGURATION FILE ANALYSIS RECIPE
You are reading a configuration file (YAML / JSON / TOML / INI / Dockerfile / .env / docker-compose / etc.). Produce a DevOps-grade review. Cover:
1. **Config identity** — exact format, what tool/system it configures, version/schema if declarable.
2. **Top-level structure** — list every top-level key with 1-line purpose. Markdown table.
3. **Effective values** — for each setting, the literal value + any inferred default if absent. Highlight environment-variable interpolations (\`\${VAR}\`).
4. **Cross-section dependencies** — settings whose validity depends on another (port + service, secret + provider, network alias + reference).
5. **Security posture** — exposed ports, world-readable secrets, hard-coded credentials, weak TLS settings (TLS 1.0/1.1, ANY cipher), permissive CORS, debug-mode flags in production, default admin passwords, unrestricted SSH/management endpoints, missing health probes, image tags pinned to \`latest\`.
6. **Reliability / availability** — replica counts, restart policies, health/liveness/readiness probes, resource requests/limits, retry/backoff, graceful shutdown, log rotation.
7. **Cost & efficiency** — oversized resources, missing autoscaling, unbounded caches, log verbosity in production, large image sizes, unnecessary services/sidecars.
8. **Compliance & governance** — data residency hints (region pinning), audit logging, key rotation period, encryption-at-rest, encryption-in-transit, secret-management indirection (vault, AWS SM, KMS).
9. **Schema / lint issues** — invalid types, unknown keys (relative to known schemas), missing required fields, deprecated keys, inconsistent indentation, duplicate keys.
10. **Recommended diff** — present the top 5 fixes as a single \`\`\`diff fenced block\`\`\` patch the user can apply directly.
Cite each finding with the exact key path ("\`services.web.image\`", "\`spec.containers[0].resources\`"). End with a 1-line "Production-readiness rating" (🟢 ready / 🟡 needs hardening / 🔴 do not deploy) + 1 reason.`,

  log_file: `### LOG / STACK TRACE ANALYSIS RECIPE
You are reading a log file, audit trail, or stack trace. Produce an SRE-grade incident analysis. Cover:
1. **Log identity** — source system / framework hint (NGINX, syslog, Spring, Node winston, Python logging, custom JSON), time range, total lines, time-zone if visible.
2. **Severity distribution** — count of TRACE / DEBUG / INFO / WARN / ERROR / FATAL events. Markdown table.
3. **Error timeline** — chronological list of unique ERROR/FATAL events with timestamp, count, first/last seen, exemplary message. Coalesce duplicates.
4. **Stack-trace dissection** — for every distinct exception: exception class, message, top 3 frames in user code (skip framework noise), root cause hypothesis, likely fix.
5. **Slow / latency markers** — requests > 1s, GC pauses, DB queries > 200ms, retries, circuit-breaker openings.
6. **Correlation hints** — recurring trace IDs, request IDs, user IDs, IPs, hosts, pods, container restarts, deployment markers — group related events.
7. **Patterns & anomalies** — bursts of 5xx errors, ramp-up of timeouts, sudden silence (process crash), repeated auth failures (possible attack), connection pool exhaustion, OOM signatures, disk-full hints.
8. **Probable root cause** — single best hypothesis with the evidence chain (line numbers / timestamps that support it).
9. **Recommended next actions** — specific commands / dashboards / queries the on-call should run next (kubectl logs, metrics URL, jstack, /proc/, etc.).
10. **Mitigation patch (if root cause is in code)** — sketch the fix as a code change (\`\`\`diff\`\`\` block) with rationale.
Cite log lines by their original timestamp + an excerpt ("at 10:00:01Z: 'connection refused'"). Never speculate beyond what the log shows. End with a 1-line "Incident severity": SEV1/2/3 + 1 sentence justification.`,

  meeting_transcript: `### MEETING / INTERVIEW TRANSCRIPT ANALYSIS RECIPE
You are reading a transcript of a meeting, interview, call, or workshop. Produce a chief-of-staff-grade synthesis. Cover:
1. **Meeting metadata** — inferred title, date/time if visible, duration estimate, attendees (from speaker labels), facilitator/host.
2. **One-paragraph summary** — what was decided + why this meeting happened, in plain language.
3. **Topic timeline** — markdown table: Time/Span · Topic · Driver (who proposed) · Outcome (decided / parked / unresolved).
4. **Decisions reached** — bulleted list, each with the decision-maker and the trigger that confirmed it. Quote verbatim if a clean sentence exists.
5. **Action items table** — Owner · Action · Due date · Source quote ("[10:23] Speaker B said …"). Capture every commitment.
6. **Open questions / unresolved threads** — items raised but not closed; note who needs to follow up.
7. **Risks / concerns surfaced** — operational, financial, legal, people. One bullet per risk + who raised it.
8. **Tone & engagement read** — energetic / cautious / divided / aligned; flag tense moments with timestamps.
9. **Quotable insights** — 3-5 short verbatim quotes that capture key insights, each tagged with speaker + timestamp.
10. **Suggested follow-up email** — draft a concise post-meeting recap email (~120 words) the host could send today, in the meeting's language.
Cite every claim with [timestamp] + speaker name ("[14:02] Carla:"). Never paraphrase decisions or commitments — quote them verbatim. End with "If you read only one line: …" — the single most important takeaway.`,

  regulatory_compliance: `### REGULATORY / COMPLIANCE DOCUMENT ANALYSIS RECIPE
You are reading a compliance, audit, regulatory, or governance document (GDPR DPA, HIPAA BAA, SOC 2, ISO 27001 ISMS, PCI DSS RoC, internal policy). Produce an auditor-grade review. Cover:
1. **Document identity** — framework (GDPR / HIPAA / SOC 2 / ISO 27001 / PCI DSS / NIST CSF / CCPA / sector-specific), version, effective date, scope statement, owning function.
2. **Applicability** — entity / system / data classification covered, geographies, exclusions, third parties in scope.
3. **Control inventory** — markdown table: Control ID · Title · Implementation summary · Owner · Evidence reference · Status (implemented / partial / not implemented / N/A).
4. **Roles & responsibilities** — controller / processor / sub-processor / data subject (GDPR), covered entity / business associate (HIPAA), service organisation / user entity (SOC 2). Map to internal roles.
5. **Data flows & lawful basis** — categories of data, purpose, legal basis (consent / contract / legitimate interest / legal obligation), retention period, cross-border transfer mechanism (SCCs, adequacy decision).
6. **Risk treatment** — risks identified, risk rating, mitigation, residual risk acceptance, owner. Flag anything unmitigated.
7. **Gap analysis** — controls listed by the framework that are missing or weakly implemented in this document. Reference specific clause numbers ("ISO 27001 A.5.7", "GDPR Art. 32").
8. **Subject rights / data-subject procedures** — access / rectification / erasure / portability / objection / breach notification — verify each is documented with a SLA.
9. **Audit & evidence readiness** — what evidence would an auditor request, and which is referenced vs missing? List specific artefacts (policy doc, system config, training log, pen-test report).
10. **Remediation plan** — top 5 prioritised fixes with effort estimate, target date, and the control they close.
Quote every clause/article with its exact reference ("§3.2", "Art. 28(3)(a)", "AC-2(1)"). Use the document's language. End with "Audit verdict": Pass / Pass with observations / Conditional / Fail + 1-line justification.`,

  research_proposal: `### RESEARCH / GRANT / RFP PROPOSAL ANALYSIS RECIPE
You are reading a research proposal, grant application, RFP / RFI / RFQ response, or project pitch. Produce a reviewer-grade evaluation. Cover:
1. **Proposal identity** — title, funding body / customer, programme, submitter, requested amount/scope, deadline if visible.
2. **Problem statement** — what problem is being solved, why it matters now, who suffers without a solution. Quote the strongest framing line.
3. **State of the art** — prior work cited, gaps identified, differentiation. Note suspiciously thin literature reviews.
4. **Objectives & hypotheses** — list each objective + measurable success criterion. Flag vague or unfalsifiable goals.
5. **Methodology / approach** — design, data, tools, partners, ethical considerations, risk-mitigation plan.
6. **Deliverables & milestones** — markdown table: # · Deliverable · Owner · Due · Acceptance criterion. Verify total spans the project window.
7. **Team & capacity** — PI/lead, key personnel, FTE allocation, prior track record relevant to the work, sub-contractors.
8. **Budget plausibility** — major cost lines, % allocation (personnel / equipment / travel / overhead / sub-contracts), match-funding, value-for-money cues. Flag implausibly low or high numbers.
9. **Risks & assumptions** — explicit risk register? Plausibility of mitigations? Any risk you'd add that they missed?
10. **Reviewer scorecard** — markdown table: Criterion (Significance · Innovation · Approach · Team · Feasibility · Cost) · Score 1-5 · Justification. End with a final "Fund / Negotiate / Decline" recommendation + 1 sentence why.
Cite every claim with the section heading ("§Methods", "§Budget"). End with "Top 3 questions to ask the proposer before deciding." Use the proposal's language.`,

  patent: `### PATENT DOCUMENT ANALYSIS RECIPE
You are reading a patent application, granted patent, or utility filing. Produce a patent examiner-grade analysis. Cover:
1. **Bibliographic data** — application/publication number, kind code, filing date, priority date, applicant(s), inventor(s), assignee, jurisdiction (USPTO/EPO/WIPO/JPO/KIPO), IPC/CPC classifications.
2. **Title & abstract** — quote the title verbatim; restate the abstract in one technical sentence.
3. **Field & background** — what technical problem this addresses, and how the disclosed prior art frames it.
4. **Independent claims** — list claim 1 and every other independent claim. For each, decompose into preamble · transition (comprising/consisting) · numbered limitations. Quote the limitations verbatim.
5. **Dependent claims structure** — show which claims depend on which (use an indented tree). Group by feature.
6. **Embodiments & figures** — summarise each disclosed embodiment with the figure reference (FIG. 1, FIG. 2A …) and note which claim each maps to.
7. **Novelty & non-obviousness assessment** — based on the cited prior art only, what specifically is presented as new (35 U.S.C. §102) and inventive (§103). Flag any limitation that looks anticipated or obvious.
8. **Scope concerns** — overly broad functional language, means-plus-function risks (§112 ¶6), antecedent basis issues, indefinite terms.
9. **File-history hints** — any rejections, amendments, or examiner remarks visible. Note continuations / divisionals / CIPs if mentioned.
10. **Reviewer verdict** — one of: *Strong (broad and supported) · Moderate (defensible with narrowing) · Weak (likely unenforceable)*. Justify in 2–3 lines, naming the strongest and weakest claim.
Cite every claim by number ("Cl. 1", "Cl. 7"). Never paraphrase claim language. End with a 3-row freedom-to-operate hint: practitioners who should worry · why · suggested design-around angle.`,

  employment_contract: `### EMPLOYMENT CONTRACT ANALYSIS RECIPE
You are reading an employment, hire, severance, NDA, or non-compete agreement. Produce an HR-and-labor-law-grade review. Cover:
1. **Parties & roles** — employer (legal name + registry/tax ID) and employee (name, role, start date, work location, reporting line).
2. **Position & duties** — quoted job title, scope of duties, exclusivity / outside-activities clause, dedication regime (full-time / part-time / hours per week).
3. **Compensation** — base salary (amount + frequency + currency), variable comp (bonus / commission / equity), benefits (health, retirement, allowances), payment schedule, jurisdictional withholdings noted.
4. **Working time** — schedule, overtime rules, time tracking, remote/hybrid policy, on-call expectations.
5. **Leave & PTO** — vacation days, sick leave, parental leave, public holidays, carry-over rules.
6. **Probation & termination** — probation duration, notice periods (both sides), grounds for "for cause" termination, severance entitlements, final-pay rules.
7. **IP, confidentiality & restrictive covenants** — IP assignment scope (work-for-hire, pre-existing IP carve-out), confidentiality duration, non-compete (geographic + temporal scope + consideration), non-solicitation (employees vs customers).
8. **Compliance with applicable labor law** — flag clauses that are likely **unenforceable** under the contract's stated jurisdiction (e.g. uncompensated non-compete in California, > 1 year non-compete in most LATAM countries, illegal waivers of statutory rights, mandatory arbitration with class-action waivers where banned).
9. **Asymmetries & negotiation flags** — broad unilateral amendment clauses, "at-will" framing in non-at-will jurisdictions, automatic renewals, choice-of-law shopping, vague "additional duties as assigned".
10. **Negotiation suggestions** — 5 concrete edits with before/after wording (e.g. *"Reduce non-compete from 24 months to 12 months and limit scope to direct competitors in the same product line"*).
Cite each clause number ("Cl. 7.2", "§III.B"). Quote restrictive language verbatim in italics. End with a Risk matrix table: Clause · Risk level (🔴/🟡/🟢) · Recommended action.`,

  bank_statement: `### BANK STATEMENT ANALYSIS RECIPE
You are reading a bank or financial-account statement. Produce a forensic-accounting-grade analysis. Cover:
1. **Account identity** — institution, account holder, account number (mask all but last 4), currency, statement period (verbatim dates), prior balance, closing balance.
2. **Cash flow summary** — total inflows · total outflows · net change · average daily balance. Display in a 4-row markdown table.
3. **Inflow breakdown** — group deposits into categories (Salary / Transfer-in / Refund / Sale / Interest / Other) with count and total amount per category.
4. **Outflow breakdown** — group debits (Bills / Subscriptions / Cash withdrawals / Transfer-out / Card purchases / Fees / Loan payments / Other) with count and total per category. List recurring charges separately, noting the frequency.
5. **Top 10 transactions by absolute amount** — markdown table with Date · Description · Amount · Type (debit/credit) · Running balance after.
6. **Recurring & subscription analysis** — every charge that appears ≥ 2 times with similar amount → flag as recurring (Netflix, gym, insurance, loan, SaaS). Show monthly/annual run-rate.
7. **Fee audit** — sum of all bank fees, overdraft charges, foreign-transaction fees, ATM fees. Flag anything unusual for that institution.
8. **Anomalies & red flags** — suspicious round-number transfers, rapid in/out cycling, end-of-period reversals, manual adjustments, "miscellaneous" charges > 1% of period activity, missing days, balance reconciliation errors (opening + inflows - outflows ≠ closing).
9. **Liquidity & behaviour signal** — average days from inflow to outflow, minimum balance, days at or below zero, savings rate ((inflows − outflows) / inflows).
10. **Recommendations** — 3–5 concrete actions (cancel subscription X, refinance loan Y to save Z, switch to fee-free product, set up emergency fund).
Cite every amount with its statement page/row. Never invent dates or values. End with a 1-line health verdict: *"Cash flow is positive/balanced/strained because …"*.`,

  insurance_policy: `### INSURANCE POLICY ANALYSIS RECIPE
You are reading an insurance policy, certificate of coverage, or insurance contract. Produce an insurance-broker-grade review. Cover:
1. **Policy identity** — insurer (legal name + regulator), policy number, line of business (life / health / property / auto / liability / D&O / cyber / etc.), insured / policyholder, beneficiaries, effective period (verbatim dates).
2. **Premium & payment** — premium amount, frequency, grace period, late-payment consequences, premium financing terms if present.
3. **Coverage limits** — per-occurrence limit, aggregate limit, sub-limits, deductibles, self-insured retention, co-insurance percentages. Display as a markdown table.
4. **Insuring agreement** — quote the operative coverage clause verbatim. Translate into plain language.
5. **Definitions** — list and explain the 5–10 most important defined terms (Insured Event, Loss, Property, Bodily Injury, Occurrence, Claim, Retroactive Date, etc.). Definitions often constrain coverage more than exclusions.
6. **Exclusions** — list every exclusion. Group by type (intentional acts, war, terrorism, nuclear, pre-existing condition, named perils excluded, etc.). Mark which are standard vs aggressive.
7. **Conditions** — notice requirements (days to report a claim), cooperation duties, subrogation, other-insurance clauses, anti-fraud, examination under oath, audit rights.
8. **Claim process** — step-by-step, with named contacts, forms, time limits, dispute escalation paths.
9. **Coverage gaps & adequacy** — given typical exposures for an insured of this profile, what is missing or under-insured? (e.g. no business-interruption add-on on a property policy, retro date too recent, no extended reporting period on claims-made policy).
10. **Renewal / cancellation** — auto-renewal, notice period, mid-term cancellation rights, return-of-premium rules.
Quote every limit and exclusion verbatim. End with a Buyer scorecard table: Adequacy · Cost · Clarity · Claim-friendliness · Each 1–5 with a one-line rationale, and a final "Renew / Renegotiate / Replace" verdict.`,

  incident_postmortem: `### INCIDENT POSTMORTEM ANALYSIS RECIPE
You are reading an SRE / DevOps incident postmortem, outage report, or root-cause analysis. Produce a senior-on-call-engineer-grade review. Cover:
1. **Incident header** — title, severity (SEV-1/2/3), service(s) affected, start / detect / mitigate / resolve timestamps (UTC), total duration, MTTD, MTTM, MTTR.
2. **Impact** — customer impact (users affected, requests failed, revenue lost, SLA/SLO breach), internal impact (engineers paged, support tickets, comms required). Quantify wherever the document permits.
3. **Timeline** — reproduce the timeline as a markdown table: Time (UTC) · Actor · Event · Effect. Highlight the trigger event, detection event, mitigation event, full-resolution event.
4. **Trigger & root cause** — separate the immediate trigger from the underlying root cause. Walk a clean 5-whys ladder from symptom to root cause; quote the document where it provides the answer at each level.
5. **Contributing factors** — code defects, missing tests, infrastructure constraints, alert gaps, runbook gaps, deploy practices, capacity headroom, communication lapses.
6. **Detection quality** — did our monitors fire first or did customers report it? Time-to-page vs time-to-impact. Alert noise / fatigue assessment.
7. **Response quality** — was the on-call playbook followed? Where did the team improvise? Was incident command established? Comms cadence (status page, internal Slack, exec brief).
8. **Action items audit** — list every action item with: Owner · Type (prevention / detection / response / mitigation) · Priority · Due date. Flag duplicates from prior incidents (recurring root cause = systemic).
9. **Risk that this recurs** — given the action items, estimate residual risk (Low / Medium / High) with reasoning.
10. **Cross-team learnings** — what should other teams (SRE, platform, product, support) take away? Where should the runbook / playbook / on-call training be updated?
Cite timestamps and metric values verbatim (e.g. *"p99 latency spiked from 120 ms to 4.2 s at 14:32:18 UTC"*). End with a 1-row verdict: *"Postmortem quality: Strong / Adequate / Insufficient — because …"*.`,

  pitch_deck: `### INVESTOR PITCH DECK ANALYSIS RECIPE
You are reading a startup pitch deck (seed / Series A / B / growth). Produce a VC-partner-grade memo. Cover:
1. **Deck snapshot** — startup name, stage, sector, geography, deck date, slide count, key contact.
2. **Problem & opportunity** — what real, urgent, paid pain are they addressing? Who experiences it most acutely? Why now? Quote the problem framing.
3. **Solution** — what they actually build / sell. Distinguish product from feature. Demo evidence (screenshots, customer logos, case studies).
4. **Market sizing** — TAM / SAM / SOM with method shown (bottom-up vs top-down). Sanity-check the numbers against public sources and flag inflations.
5. **Business model** — pricing, revenue type (subscription / transaction / marketplace / ads / licensing), unit economics (CAC, LTV, payback period, gross margin), contract length.
6. **Traction** — MRR / ARR, growth rate (MoM / YoY), logos, retention (NDR / GRR), pipeline. Distinguish vanity from defensible metrics.
7. **Go-to-market & competition** — channels, sales motion (PLG / inside sales / partner-led), competitive landscape, moat / defensibility, switching costs.
8. **Team** — founders' backgrounds, prior exits, depth in the domain, gaps in the team (e.g. no GTM leader at Series A).
9. **The ask** — round size, valuation (pre/post), use of funds (% to engineering / GTM / runway extension), runway after this round, planned next milestones.
10. **Diligence checklist** — top 7 questions to validate (cohort retention, sales cycle, churn drivers, regulatory exposure, customer concentration, IP defensibility, hiring plan vs burn).
Quote every number verbatim with its source slide ("Slide 7: ARR = $1.2 M"). End with a 1-line investment leaning: *"Strong-lean-yes / Lean-yes / Pass — because …"* plus the 2 deal-breaker risks.`,

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

// ──────────────────────────────────────────────────────────────────────────
// Table column inference + summary stats
// ──────────────────────────────────────────────────────────────────────────
//
// Given a Prisma DocumentTable row, infer each column's data type and emit
// per-column summary statistics the model can quote without recomputing.
// Pure function, runs in <2 ms for typical 50-row previews.

const CURRENCY_HINT = /^\s*-?\s*(?:[$€£¥]|US\$|S\/\.?|R\$|MX\$|Bs\.?)\s?-?\d|^\s*-?\d+(?:[.,]\d+)?\s*(?:USD|EUR|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP|CAD|AUD)\b/i;
const PERCENT_HINT = /^\s*-?\d+(?:[.,]\d+)?\s*%\s*$/;
const DATE_HINT = /^\s*(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december))/i;
const BOOL_HINT = /^\s*(?:true|false|yes|no|s[ií]|n[oó]|verdadero|falso|1|0)\s*$/i;
const NUMERIC_PARSE = /^-?\s*\$?\s*(\d{1,3}(?:[,]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*[A-Z]{1,4})?\s*%?\s*$/;

function parseNumericCell(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!NUMERIC_PARSE.test(text)) return null;
  // Strip currency / percent / thousand separators, keep decimal point
  const cleaned = text
    .replace(/[$€£¥%]/g, '')
    .replace(/\s+/g, '')
    .replace(/^US|R|MX|Bs\.?$/i, '')
    .replace(/[A-Z]{1,4}$/i, '')
    .replace(/,/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function classifyColumnType(values) {
  const samples = values.filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).trim());
  if (samples.length === 0) return { type: 'empty', confidence: 0 };

  let date = 0;
  let bool = 0;
  let currency = 0;
  let percent = 0;
  let numeric = 0;
  for (const s of samples) {
    if (DATE_HINT.test(s)) date++;
    if (BOOL_HINT.test(s)) bool++;
    if (CURRENCY_HINT.test(s)) currency++;
    if (PERCENT_HINT.test(s)) percent++;
    if (parseNumericCell(s) != null) numeric++;
  }
  const n = samples.length;
  const ratio = (count) => count / n;

  // Priority: currency > percent > date > boolean > numeric > text
  if (ratio(currency) >= 0.6) return { type: 'currency', confidence: ratio(currency) };
  if (ratio(percent) >= 0.6) return { type: 'percent', confidence: ratio(percent) };
  if (ratio(date) >= 0.6) return { type: 'date', confidence: ratio(date) };
  if (ratio(bool) >= 0.6 && bool >= 2) return { type: 'boolean', confidence: ratio(bool) };
  if (ratio(numeric) >= 0.6) return { type: 'numeric', confidence: ratio(numeric) };
  return { type: 'text', confidence: 1 - Math.max(ratio(currency), ratio(percent), ratio(date), ratio(numeric)) };
}

function summariseNumericColumn(values) {
  const nums = values
    .map((v) => parseNumericCell(v))
    .filter((n) => n != null);
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((acc, x) => acc + x, 0);
  const mean = sum / nums.length;
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  return {
    count: nums.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    sum,
    mean,
    median,
  };
}

function summariseDateColumn(values) {
  const parsed = values
    .map((v) => {
      if (!v) return null;
      const t = Date.parse(String(v));
      return Number.isFinite(t) ? new Date(t) : null;
    })
    .filter((d) => d);
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => a.getTime() - b.getTime());
  return {
    count: parsed.length,
    earliest: parsed[0].toISOString().slice(0, 10),
    latest: parsed[parsed.length - 1].toISOString().slice(0, 10),
  };
}

function detectTotalsRow(columns, rows, colTypes) {
  if (rows.length < 3) return null;
  const lastRow = rows[rows.length - 1];
  if (!lastRow) return null;
  const lastCells = Array.isArray(lastRow) ? lastRow : columns.map((c) => lastRow?.[c] ?? '');
  const firstCell = String(lastCells[0] ?? '').trim().toLowerCase();
  // "Total", "Subtotal", "Grand Total", "TOTAL", "Suma", "Saldo final"
  const looksLikeTotalLabel = /^(?:total|subtotal|grand\s*total|gran\s*total|suma|sumatoria|saldo\s+(?:final|al\s+corte)|final\s+(?:total|balance))/i.test(firstCell);
  if (!looksLikeTotalLabel) {
    // Also check: in numeric columns, last value == sum of previous
    let numericMatches = 0;
    let numericCols = 0;
    for (let i = 0; i < columns.length; i++) {
      if (colTypes[i]?.type !== 'numeric' && colTypes[i]?.type !== 'currency') continue;
      numericCols++;
      const previous = rows.slice(0, -1)
        .map((r) => parseNumericCell(Array.isArray(r) ? r[i] : r?.[columns[i]]))
        .filter((n) => n != null);
      const claimedTotal = parseNumericCell(lastCells[i]);
      if (claimedTotal == null || previous.length === 0) continue;
      const sum = previous.reduce((acc, x) => acc + x, 0);
      // Allow 0.5% tolerance for rounding
      const diff = Math.abs(claimedTotal - sum);
      const tolerance = Math.max(0.01, Math.abs(sum) * 0.005);
      if (diff <= tolerance) numericMatches++;
    }
    // Need at least 60% of numeric columns to match for arithmetic-only detection
    if (numericCols >= 2 && numericMatches / numericCols >= 0.6) {
      return { rowIndex: rows.length - 1, basis: 'arithmetic', label: firstCell || null };
    }
    return null;
  }
  return { rowIndex: rows.length - 1, basis: 'label', label: firstCell };
}

/**
 * Produce a structured column-profile summary the chat block can append
 * under a table to help the model interpret numbers without re-reading
 * every row.
 *
 * @param {object} table — Prisma DocumentTable row with columns + preview
 * @returns {{ types: object[], totalsRow: object|null, columnSummaries: object[] }|null}
 */
function profileTableColumns(table) {
  if (!table) return null;
  const columns = Array.isArray(table.columns) ? table.columns : [];
  const preview = Array.isArray(table.preview) ? table.preview : (safeJsonValue(table.preview) || []);
  if (columns.length === 0 || preview.length === 0) return null;

  // Build column-wise value lists
  const columnValues = columns.map((col, i) =>
    preview.map((row) => Array.isArray(row) ? row[i] : row?.[col]),
  );

  const types = columnValues.map((vals) => classifyColumnType(vals));
  const totalsRow = detectTotalsRow(columns, preview, types);

  const columnSummaries = columns.map((col, i) => {
    const type = types[i]?.type;
    // Exclude the totals row from per-column stats (it inflates sum/max)
    const effectiveValues = totalsRow
      ? columnValues[i].filter((_, idx) => idx !== totalsRow.rowIndex)
      : columnValues[i];
    let summary = null;
    if (type === 'numeric' || type === 'currency' || type === 'percent') {
      summary = summariseNumericColumn(effectiveValues);
    } else if (type === 'date') {
      summary = summariseDateColumn(effectiveValues);
    }
    return { column: col, type, confidence: types[i]?.confidence, summary };
  });

  return { types, totalsRow, columnSummaries };
}

function formatTableProfileFooter(profile, table) {
  if (!profile) return '';
  const lines = [];
  // Compact type signature, e.g. "types: Date · Currency · Currency · Text"
  const typeSig = profile.types
    .map((t) => t.type)
    .map((t) => t === 'numeric' ? 'Numeric' : t === 'currency' ? 'Currency' : t === 'percent' ? 'Percent' : t === 'date' ? 'Date' : t === 'boolean' ? 'Boolean' : 'Text')
    .join(' · ');
  lines.push(`    _Column types:_ ${typeSig}`);

  // Compact per-column stats for numeric/currency columns
  const stat = [];
  for (const cs of profile.columnSummaries) {
    if (!cs.summary) continue;
    const col = String(cs.column).replace(/\|/g, '\\|');
    if (cs.type === 'numeric' || cs.type === 'currency' || cs.type === 'percent') {
      stat.push(`${col}: sum=${formatNumberShort(cs.summary.sum)}, mean=${formatNumberShort(cs.summary.mean)}, min=${formatNumberShort(cs.summary.min)}, max=${formatNumberShort(cs.summary.max)} (n=${cs.summary.count})`);
    } else if (cs.type === 'date') {
      stat.push(`${col}: ${cs.summary.earliest} → ${cs.summary.latest} (n=${cs.summary.count})`);
    }
  }
  if (stat.length > 0) lines.push(`    _Summary:_ ${stat.join(' · ')}`);

  if (profile.totalsRow) {
    const basis = profile.totalsRow.basis === 'label' ? 'labelled' : 'arithmetic-verified';
    lines.push(`    _Totals row detected (${basis}) at row ${profile.totalsRow.rowIndex + 1}._`);
  }

  void table;
  return lines.join('\n');
}

function formatNumberShort(n) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
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
      // Append column-profile footer (types + numeric summaries + totals)
      // so the model can quote stats without recomputing.
      const profile = profileTableColumns(t);
      const footer = formatTableProfileFooter(profile, t);
      if (footer) lines.push(footer);
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
  const insightsBlock = buildInsightsBlock(files);
  // Comparison only fires when 2+ files have extractable text. Glossary fires
  // for any file count. PII detector also fires for any file count and is the
  // most security-sensitive — surfaces upfront so the model gets a safety
  // frame before it sees the raw extracted text downstream.
  const comparisonBlock = buildComparisonBlock(files, profiles);
  const glossaryBlock = buildGlossaryBlock(files);
  const piiSafetyBlock = buildPiiSafetyBlock(files);
  const consistencyBlock = buildConsistencyBlock(files);
  const outlineBlock = buildOutlineBlock(files);
  const readabilityBlock = buildReadabilityBlock(files);
  const qualityBlock = buildQualityBlock(files, profiles);
  const evidenceMapBlock = buildEvidenceMapBlock(files);
  const deepAnalysisBlock = buildDeepAnalysisBlock(files);
  const quotesBlock = buildQuotesBlock(files);
  const numericCoherenceBlock = buildNumericCoherenceBlock(files);
  const temporalTimelineBlock = buildTemporalTimelineBlock(files);
  const actionDashboardBlock = buildActionDashboardBlock(files);
  const audienceToneBlock = buildAudienceToneBlock(files);
  const semanticGraphBlock = buildSemanticGraphBlock(files);
  const kpisBlock = buildKpisBlock(files);
  const riskRegisterBlock = buildRiskRegisterBlock(files);
  const factDensityBlock = buildFactDensityBlock(files);
  const relationshipsBlock = buildRelationshipsBlock(files);
  const sectionSimilarityBlock = buildSectionSimilarityBlock(files);
  const numericStatisticsBlock = buildNumericStatisticsBlock(files);
  const qualityGradeBlock = buildQualityGradeBlock(files);
  const titlesBlock = buildTitlesBlock(files);
  const tldrBlock = buildTldrBlock(files);
  const sentimentBlock = buildSentimentBlock(files);
  const keyPhrasesBlock = buildKeyPhrasesBlock(files);
  const obligationsBlock = buildObligationsBlock(files);
  const scopeExclusionsBlock = buildScopeExclusionsBlock(files);
  const stakeholderMapBlock = buildStakeholderMapBlock(files);
  const jurisdictionBlock = buildJurisdictionBlock(files);
  const definitionsBlock = buildDefinitionsBlock(files);
  const crossReferenceBlock = buildCrossReferenceBlock(files);
  const pricingBlock = buildPricingBlock(files);
  const metadataBlock = buildMetadataBlock(files);
  const complianceBlock = buildComplianceBlock(files);
  const warrantiesBlock = buildWarrantiesBlock(files);
  const disputeResolutionBlock = buildDisputeResolutionBlock(files);
  const indemnificationBlock = buildIndemnificationBlock(files);
  const acronymsBlock = buildAcronymsBlock(files);
  const temporalExpressionsBlock = buildTemporalExpressionsBlock(files);
  const crossNumericBlock = buildCrossNumericBlock(files);
  const signatureBlocksBlock = buildSignatureBlocksBlock(files);
  const qaPairsBlock = buildQaPairsBlock(files);
  const hypothesesBlock = buildHypothesesBlock(files);
  const recommendationsBlock = buildRecommendationsBlock(files);
  const assumptionsBlock = buildAssumptionsBlock(files);
  const conditionalClausesBlock = buildConditionalClausesBlock(files);
  const counterArgumentsBlock = buildCounterArgumentsBlock(files);
  const callsToActionBlock = buildCallsToActionBlock(files);
  const disclosuresBlock = buildDisclosuresBlock(files);
  const factVsOpinionBlock = buildFactVsOpinionBlock(files);
  const scenariosBlock = buildScenariosBlock(files);
  const benchmarksBlock = buildBenchmarksBlock(files);
  const goalsTargetsBlock = buildGoalsTargetsBlock(files);
  const slaTermsBlock = buildSLATermsBlock(files);
  const dataClassificationBlock = buildDataClassificationBlock(files);
  const approvalWorkflowBlock = buildApprovalWorkflowBlock(files);
  const executiveSummaryBlock = buildExecutiveSummaryBlock(files);
  const urlsBlock = buildUrlsBlock(files);
  const contactsBlock = buildContactsBlock(files);
  const footnotesBlock = buildFootnotesBlock(files);
  const tablesBlock = buildTablesBlock(files);
  const codeBlocksBlock = buildCodeBlocksBlock(files);
  const figureRefsBlock = buildFigureRefsBlock(files);
  const checklistsBlock = buildChecklistsBlock(files);
  const identifiersBlock = buildIdentifiersBlock(files);
  const bulletListsBlock = buildBulletListsBlock(files);
  const mermaidBlock = buildMermaidBlock(files);
  const prioritiesBlock = buildPrioritiesBlock(files);
  const ownershipBlock = buildOwnershipBlock(files);
  const timestampsBlock = buildTimestampsBlock(files);
  const statusBlock = buildStatusBlock(files);
  const acceptanceCriteriaBlock = buildAcceptanceCriteriaBlock(files);
  const apiEndpointsBlock = buildApiEndpointsBlock(files);
  const envVarsBlock = buildEnvVarsBlock(files);
  const sqlBlock = buildSqlBlock(files);
  const filePathsBlock = buildFilePathsBlock(files);
  const cronBlock = buildCronBlock(files);
  const licensesBlock = buildLicensesBlock(files);
  const dependenciesBlock = buildDependenciesBlock(files);
  const riskMatrixBlock = buildRiskMatrixBlock(files);
  const versionsBlock = buildVersionsBlock(files);
  const decisionRecordsBlock = buildDecisionRecordsBlock(files);
  const domainsBlock = buildDomainsBlock(files);
  const currencyBlock = buildCurrencyBlock(files);
  const percentagesBlock = buildPercentagesBlock(files);
  const citationsBlock = buildCitationsBlock(files);
  const colorsBlock = buildColorsBlock(files);
  const coordinatesBlock = buildCoordinatesBlock(files);
  const trademarkBlock = buildTrademarkBlock(files);
  const hashtagsBlock = buildHashtagsBlock(files);
  const sectionLabelsBlock = buildSectionLabelsBlock(files);
  const signoffsBlock = buildSignoffsBlock(files);
  const hashesBlock = buildHashesBlock(files);
  const couponsBlock = buildCouponsBlock(files);
  const fileSizesBlock = buildFileSizesBlock(files);
  const vcsRefsBlock = buildVcsRefsBlock(files);
  const standardsBlock = buildStandardsBlock(files);
  const networkBlock = buildNetworkBlock(files);
  const httpStatusBlock = buildHttpStatusBlock(files);
  const timezonesBlock = buildTimezonesBlock(files);
  const mathBlock = buildMathBlock(files);
  const booleanBlock = buildBooleanBlock(files);
  const tocBlock = buildTocBlock(files);
  const htmlAttrsBlock = buildHtmlAttrsBlock(files);
  const blockquotesBlock = buildBlockquotesBlock(files);
  const definitionListsBlock = buildDefinitionListsBlock(files);
  const todosBlock = buildTodosBlock(files);
  const imagesBlock = buildImagesBlock(files);
  const mediaBlock = buildMediaBlock(files);
  const languageRatioBlock = buildLanguageRatioBlock(files);
  const regexPatternsBlock = buildRegexPatternsBlock(files);
  const fileExtensionsBlock = buildFileExtensionsBlock(files);
  const codeDefsBlock = buildCodeDefsBlock(files);
  const tonePolarityBlock = buildTonePolarityBlock(files);
  const quantifiersBlock = buildQuantifiersBlock(files);
  const modalsBlock = buildModalsBlock(files);
  const negationBlock = buildNegationBlock(files);
  const readingTimeBlock = buildReadingTimeBlock(files);
  const attributionsBlock = buildAttributionsBlock(files);
  const comparativesBlock = buildComparativesBlock(files);
  const causalBlock = buildCausalBlock(files);
  const concessionBlock = buildConcessionBlock(files);
  const hedgingBlock = buildHedgingBlock(files);
  const intensifiersBlock = buildIntensifiersBlock(files);
  const reportingBlock = buildReportingBlock(files);
  const examplesBlock = buildExamplesBlock(files);
  const approximationsBlock = buildApproximationsBlock(files);
  const questionsBlock = buildQuestionsBlock(files);
  const imperativesBlock = buildImperativesBlock(files);
  const inTextDefinitionsBlock = buildInTextDefinitionsBlock(files);
  const fiscalYearBlock = buildFiscalYearBlock(files);
  const ratiosBlock = buildRatiosBlock(files);
  const ordinalsBlock = buildOrdinalsBlock(files);
  const geoRegionsBlock = buildGeoRegionsBlock(files);
  const trackingBlock = buildTrackingBlock(files);
  const weatherBlock = buildWeatherBlock(files);
  const scientificNotationBlock = buildScientificNotationBlock(files);
  const taxaBlock = buildTaxaBlock(files);
  const chemistryBlock = buildChemistryBlock(files);
  const fxRatesBlock = buildFxRatesBlock(files);
  const ibanSwiftBlock = buildIbanSwiftBlock(files);
  const licensePlatesBlock = buildLicensePlatesBlock(files);
  const legalCitationsBlock = buildLegalCitationsBlock(files);
  const socialUrlsBlock = buildSocialUrlsBlock(files);
  const geneProteinBlock = buildGeneProteinBlock(files);
  const currencySymbolsBlock = buildCurrencySymbolsBlock(files);
  const phoneCodesBlock = buildPhoneCodesBlock(files);
  const postalCodesBlock = buildPostalCodesBlock(files);
  const addressesBlock = buildAddressesBlock(files);
  const mimeTypesBlock = buildMimeTypesBlock(files);
  const utmParamsBlock = buildUtmParamsBlock(files);
  const creditCardsBlock = buildCreditCardsBlock(files);
  const ssnPiiBlock = buildSsnPiiBlock(files);
  const apiKeysBlock = buildApiKeysBlock(files);
  const httpMethodsBlock = buildHttpMethodsBlock(files);
  const containerRefsBlock = buildContainerRefsBlock(files);
  const k8sRefsBlock = buildK8sRefsBlock(files);
  const metricsBlock = buildMetricsBlock(files);
  const oauthScopesBlock = buildOauthScopesBlock(files);
  const cspDirectivesBlock = buildCspDirectivesBlock(files);
  const mathOperatorsBlock = buildMathOperatorsBlock(files);
  const spdxComplexBlock = buildSpdxComplexBlock(files);
  const featureFlagsBlock = buildFeatureFlagsBlock(files);
  const cookieAttrsBlock = buildCookieAttrsBlock(files);
  const otelTraceBlock = buildOtelTraceBlock(files);
  const cloudArnsBlock = buildCloudArnsBlock(files);
  const mlModelsBlock = buildMlModelsBlock(files);
  const dbConnStringsBlock = buildDbConnStringsBlock(files);
  const graphqlOpsBlock = buildGraphqlOpsBlock(files);
  const grpcRefsBlock = buildGrpcRefsBlock(files);
  const stackTracesBlock = buildStackTracesBlock(files);
  const envNamesBlock = buildEnvNamesBlock(files);
  const testBlocksBlock = buildTestBlocksBlock(files);
  const gitShasBlock = buildGitShasBlock(files);
  const cloudStorageBlock = buildCloudStorageBlock(files);
  const webVitalsBlock = buildWebVitalsBlock(files);
  const ariaA11yBlock = buildAriaA11yBlock(files);
  const i18nKeysBlock = buildI18nKeysBlock(files);
  const ciBuildIdsBlock = buildCiBuildIdsBlock(files);
  const userAgentsBlock = buildUserAgentsBlock(files);
  const cidrRangesBlock = buildCidrRangesBlock(files);
  const cacheHeadersBlock = buildCacheHeadersBlock(files);
  const githubRefsBlock = buildGithubRefsBlock(files);
  const apmRefsBlock = buildApmRefsBlock(files);
  const attackPatternsBlock = buildAttackPatternsBlock(files);
  const webhookUrlsBlock = buildWebhookUrlsBlock(files);
  const sshFingerprintsBlock = buildSshFingerprintsBlock(files);
  const npmRefsBlock = buildNpmRefsBlock(files);
  const correlationIdsBlock = buildCorrelationIdsBlock(files);
  const paymentIdsBlock = buildPaymentIdsBlock(files);
  const emailHeadersBlock = buildEmailHeadersBlock(files);
  const icalEventsBlock = buildIcalEventsBlock(files);
  const frontmatterBlock = buildFrontmatterBlock(files);
  const pullQuotesBlock = buildPullQuotesBlock(files);
  const ghaStepsBlock = buildGhaStepsBlock(files);
  const terraformRefsBlock = buildTerraformRefsBlock(files);
  const helmRefsBlock = buildHelmRefsBlock(files);
  const naturalSchedulesBlock = buildNaturalSchedulesBlock(files);
  const chatPermalinksBlock = buildChatPermalinksBlock(files);
  const pmTicketsBlock = buildPmTicketsBlock(files);
  const slaTargetsBlock = buildSlaTargetsBlock(files);
  const tldsBlock = buildTldsBlock(files);
  const stockTickersBlock = buildStockTickersBlock(files);
  const hardwareSpecsBlock = buildHardwareSpecsBlock(files);
  const bandwidthUnitsBlock = buildBandwidthUnitsBlock(files);
  const trackingNumbersBlock = buildTrackingNumbersBlock(files);
  const rateLimitHeadersBlock = buildRateLimitHeadersBlock(files);
  const cryptoWalletsBlock = buildCryptoWalletsBlock(files);
  const cveIdsBlock = buildCveIdsBlock(files);
  const mediaTimestampsBlock = buildMediaTimestampsBlock(files);
  const linuxSignalsBlock = buildLinuxSignalsBlock(files);
  const exitCodesBlock = buildExitCodesBlock(files);
  const networkPortsBlock = buildNetworkPortsBlock(files);
  const linuxDistrosBlock = buildLinuxDistrosBlock(files);
  const lifecyclePhasesBlock = buildLifecyclePhasesBlock(files);
  const projectCodenamesBlock = buildProjectCodenamesBlock(files);
  const riskLevelsBlock = buildRiskLevelsBlock(files);
  const saasMetricsBlock = buildSaasMetricsBlock(files);
  const recipeMeasurementsBlock = buildRecipeMeasurementsBlock(files);
  const isoLangsBlock = buildIsoLangsBlock(files);
  const prReviewStatesBlock = buildPrReviewStatesBlock(files);
  const pricingTiersBlock = buildPricingTiersBlock(files);
  const arxivIdsBlock = buildArxivIdsBlock(files);
  const doiIdsBlock = buildDoiIdsBlock(files);
  const orcidIdsBlock = buildOrcidIdsBlock(files);
  const wikiRefsBlock = buildWikiRefsBlock(files);
  const pubmedIdsBlock = buildPubmedIdsBlock(files);
  const serviceAccountsBlock = buildServiceAccountsBlock(files);
  const vinNumbersBlock = buildVinNumbersBlock(files);
  const emojiShortcodesBlock = buildEmojiShortcodesBlock(files);
  const bibtexEntriesBlock = buildBibtexEntriesBlock(files);
  const latexCommandsBlock = buildLatexCommandsBlock(files);
  const progLangsBlock = buildProgLangsBlock(files);
  const complianceRefsBlock = buildComplianceRefsBlock(files);
  const tlsCiphersBlock = buildTlsCiphersBlock(files);
  const dnsRecordsBlock = buildDnsRecordsBlock(files);
  const emailAuthBlock = buildEmailAuthBlock(files);
  const openapiKeysBlock = buildOpenapiKeysBlock(files);
  const kafkaRefsBlock = buildKafkaRefsBlock(files);
  const ansiEscapesBlock = buildAnsiEscapesBlock(files);
  const sqlWindowsBlock = buildSqlWindowsBlock(files);
  const websocketMarkersBlock = buildWebsocketMarkersBlock(files);
  const isoDurationsBlock = buildIsoDurationsBlock(files);
  const browserSupportBlock = buildBrowserSupportBlock(files);
  const numberBasesBlock = buildNumberBasesBlock(files);
  const dmsCoordsBlock = buildDmsCoordsBlock(files);
  const containerRegistriesBlock = buildContainerRegistriesBlock(files);
  const wktGeometryBlock = buildWktGeometryBlock(files);
  const mdRefLinksBlock = buildMdRefLinksBlock(files);
  const botTokensBlock = buildBotTokensBlock(files);
  const cargoPackagesBlock = buildCargoPackagesBlock(files);
  const goModulesBlock = buildGoModulesBlock(files);
  const mavenCoordsBlock = buildMavenCoordsBlock(files);
  const pipReqsBlock = buildPipReqsBlock(files);
  const composerPkgsBlock = buildComposerPkgsBlock(files);
  const nugetPkgsBlock = buildNugetPkgsBlock(files);
  const gemPkgsBlock = buildGemPkgsBlock(files);
  const hexPkgsBlock = buildHexPkgsBlock(files);
  const svgPathCmdsBlock = buildSvgPathCmdsBlock(files);
  const geojsonBlock = buildGeojsonBlock(files);
  const pwaManifestBlock = buildPwaManifestBlock(files);
  const permissionsApiBlock = buildPermissionsApiBlock(files);
  const serverlessFnsBlock = buildServerlessFnsBlock(files);
  const dbMigrationsBlock = buildDbMigrationsBlock(files);
  const eslintRulesBlock = buildEslintRulesBlock(files);
  const buildToolsBlock = buildBuildToolsBlock(files);
  const jwtClaimsBlock = buildJwtClaimsBlock(files);
  const sriHashesBlock = buildSriHashesBlock(files);
  const jsonSchemaBlock = buildJsonSchemaBlock(files);
  const prismaSchemaBlock = buildPrismaSchemaBlock(files);
  const graphqlFragmentsBlock = buildGraphqlFragmentsBlock(files);
  const cssVarsBlock = buildCssVarsBlock(files);
  const composeServicesBlock = buildComposeServicesBlock(files);
  const regexFlagsBlock = buildRegexFlagsBlock(files);
  const vueSfcBlock = buildVueSfcBlock(files);
  const astroBlock = buildAstroBlock(files);
  const e2eTestsBlock = buildE2eTestsBlock(files);
  const mswHandlersBlock = buildMswHandlersBlock(files);
  const ghWorkflowsBlock = buildGhWorkflowsBlock(files);
  const jsonLdBlock = buildJsonLdBlock(files);
  const tailwindBlock = buildTailwindBlock(files);
  const mongoAggBlock = buildMongoAggBlock(files);
  const helmBlock = buildHelmBlock(files);
  const vitestBlock = buildVitestBlock(files);
  const mjmlBlock = buildMjmlBlock(files);
  const stripeBlock = buildStripeBlock(files);
  const terraformVarsBlock = buildTerraformVarsBlock(files);
  const openapiSecurityBlock = buildOpenapiSecurityBlock(files);
  const k8sResourcesBlock = buildK8sResourcesBlock(files);
  const cssAnimBlock = buildCssAnimBlock(files);
  const storybookBlock = buildStorybookBlock(files);
  const sentryBlock = buildSentryBlock(files);
  const natsBlock = buildNatsBlock(files);
  const pkgJsonBlock = buildPkgJsonBlock(files);
  const redisBlock = buildRedisBlock(files);
  const nginxBlock = buildNginxBlock(files);
  const otelBlock = buildOtelBlock(files);
  const moduleFederationBlock = buildModuleFederationBlock(files);
  const discourseBlock = buildDiscourseBlock(files);
  const sectionRolesBlock = buildSectionRolesBlock(files);

  return {
    profileBlock,
    directiveBlock,
    insightsBlock,
    comparisonBlock,
    glossaryBlock,
    piiSafetyBlock,
    consistencyBlock,
    outlineBlock,
    readabilityBlock,
    qualityBlock,
    evidenceMapBlock,
    deepAnalysisBlock,
    quotesBlock,
    numericCoherenceBlock,
    temporalTimelineBlock,
    actionDashboardBlock,
    audienceToneBlock,
    semanticGraphBlock,
    kpisBlock,
    riskRegisterBlock,
    factDensityBlock,
    relationshipsBlock,
    sectionSimilarityBlock,
    numericStatisticsBlock,
    qualityGradeBlock,
    titlesBlock,
    tldrBlock,
    sentimentBlock,
    keyPhrasesBlock,
    obligationsBlock,
    scopeExclusionsBlock,
    stakeholderMapBlock,
    jurisdictionBlock,
    definitionsBlock,
    crossReferenceBlock,
    pricingBlock,
    metadataBlock,
    complianceBlock,
    warrantiesBlock,
    disputeResolutionBlock,
    indemnificationBlock,
    acronymsBlock,
    temporalExpressionsBlock,
    crossNumericBlock,
    signatureBlocksBlock,
    qaPairsBlock,
    hypothesesBlock,
    recommendationsBlock,
    assumptionsBlock,
    conditionalClausesBlock,
    counterArgumentsBlock,
    callsToActionBlock,
    disclosuresBlock,
    factVsOpinionBlock,
    scenariosBlock,
    benchmarksBlock,
    goalsTargetsBlock,
    slaTermsBlock,
    dataClassificationBlock,
    approvalWorkflowBlock,
    executiveSummaryBlock,
    urlsBlock,
    contactsBlock,
    footnotesBlock,
    tablesBlock,
    codeBlocksBlock,
    figureRefsBlock,
    checklistsBlock,
    identifiersBlock,
    bulletListsBlock,
    mermaidBlock,
    prioritiesBlock,
    ownershipBlock,
    timestampsBlock,
    statusBlock,
    acceptanceCriteriaBlock,
    apiEndpointsBlock,
    envVarsBlock,
    sqlBlock,
    filePathsBlock,
    cronBlock,
    licensesBlock,
    dependenciesBlock,
    riskMatrixBlock,
    versionsBlock,
    decisionRecordsBlock,
    domainsBlock,
    currencyBlock,
    percentagesBlock,
    citationsBlock,
    colorsBlock,
    coordinatesBlock,
    trademarkBlock,
    hashtagsBlock,
    sectionLabelsBlock,
    signoffsBlock,
    hashesBlock,
    couponsBlock,
    fileSizesBlock,
    vcsRefsBlock,
    standardsBlock,
    networkBlock,
    httpStatusBlock,
    timezonesBlock,
    mathBlock,
    booleanBlock,
    tocBlock,
    htmlAttrsBlock,
    blockquotesBlock,
    definitionListsBlock,
    todosBlock,
    imagesBlock,
    mediaBlock,
    languageRatioBlock,
    regexPatternsBlock,
    fileExtensionsBlock,
    codeDefsBlock,
    tonePolarityBlock,
    quantifiersBlock,
    modalsBlock,
    negationBlock,
    readingTimeBlock,
    attributionsBlock,
    comparativesBlock,
    causalBlock,
    concessionBlock,
    hedgingBlock,
    intensifiersBlock,
    reportingBlock,
    examplesBlock,
    approximationsBlock,
    questionsBlock,
    imperativesBlock,
    inTextDefinitionsBlock,
    fiscalYearBlock,
    ratiosBlock,
    ordinalsBlock,
    geoRegionsBlock,
    trackingBlock,
    weatherBlock,
    scientificNotationBlock,
    taxaBlock,
    chemistryBlock,
    fxRatesBlock,
    ibanSwiftBlock,
    licensePlatesBlock,
    legalCitationsBlock,
    socialUrlsBlock,
    geneProteinBlock,
    currencySymbolsBlock,
    phoneCodesBlock,
    postalCodesBlock,
    addressesBlock,
    mimeTypesBlock,
    utmParamsBlock,
    creditCardsBlock,
    ssnPiiBlock,
    apiKeysBlock,
    httpMethodsBlock,
    containerRefsBlock,
    k8sRefsBlock,
    metricsBlock,
    oauthScopesBlock,
    cspDirectivesBlock,
    mathOperatorsBlock,
    spdxComplexBlock,
    featureFlagsBlock,
    cookieAttrsBlock,
    otelTraceBlock,
    cloudArnsBlock,
    mlModelsBlock,
    dbConnStringsBlock,
    graphqlOpsBlock,
    grpcRefsBlock,
    stackTracesBlock,
    envNamesBlock,
    testBlocksBlock,
    gitShasBlock,
    cloudStorageBlock,
    webVitalsBlock,
    ariaA11yBlock,
    i18nKeysBlock,
    ciBuildIdsBlock,
    userAgentsBlock,
    cidrRangesBlock,
    cacheHeadersBlock,
    githubRefsBlock,
    apmRefsBlock,
    attackPatternsBlock,
    webhookUrlsBlock,
    sshFingerprintsBlock,
    npmRefsBlock,
    correlationIdsBlock,
    paymentIdsBlock,
    emailHeadersBlock,
    icalEventsBlock,
    frontmatterBlock,
    pullQuotesBlock,
    ghaStepsBlock,
    terraformRefsBlock,
    helmRefsBlock,
    naturalSchedulesBlock,
    chatPermalinksBlock,
    pmTicketsBlock,
    slaTargetsBlock,
    tldsBlock,
    stockTickersBlock,
    hardwareSpecsBlock,
    bandwidthUnitsBlock,
    trackingNumbersBlock,
    rateLimitHeadersBlock,
    cryptoWalletsBlock,
    cveIdsBlock,
    mediaTimestampsBlock,
    linuxSignalsBlock,
    exitCodesBlock,
    networkPortsBlock,
    linuxDistrosBlock,
    lifecyclePhasesBlock,
    projectCodenamesBlock,
    riskLevelsBlock,
    saasMetricsBlock,
    recipeMeasurementsBlock,
    isoLangsBlock,
    prReviewStatesBlock,
    pricingTiersBlock,
    arxivIdsBlock,
    doiIdsBlock,
    orcidIdsBlock,
    wikiRefsBlock,
    pubmedIdsBlock,
    serviceAccountsBlock,
    vinNumbersBlock,
    emojiShortcodesBlock,
    bibtexEntriesBlock,
    latexCommandsBlock,
    progLangsBlock,
    complianceRefsBlock,
    tlsCiphersBlock,
    dnsRecordsBlock,
    emailAuthBlock,
    openapiKeysBlock,
    kafkaRefsBlock,
    ansiEscapesBlock,
    sqlWindowsBlock,
    websocketMarkersBlock,
    isoDurationsBlock,
    browserSupportBlock,
    numberBasesBlock,
    dmsCoordsBlock,
    containerRegistriesBlock,
    wktGeometryBlock,
    mdRefLinksBlock,
    botTokensBlock,
    cargoPackagesBlock,
    goModulesBlock,
    mavenCoordsBlock,
    pipReqsBlock,
    composerPkgsBlock,
    nugetPkgsBlock,
    gemPkgsBlock,
    hexPkgsBlock,
    svgPathCmdsBlock,
    geojsonBlock,
    pwaManifestBlock,
    permissionsApiBlock,
    serverlessFnsBlock,
    dbMigrationsBlock,
    eslintRulesBlock,
    buildToolsBlock,
    jwtClaimsBlock,
    sriHashesBlock,
    jsonSchemaBlock,
    prismaSchemaBlock,
    graphqlFragmentsBlock,
    cssVarsBlock,
    composeServicesBlock,
    regexFlagsBlock,
    vueSfcBlock,
    astroBlock,
    e2eTestsBlock,
    mswHandlersBlock,
    ghWorkflowsBlock,
    jsonLdBlock,
    tailwindBlock,
    mongoAggBlock,
    helmBlock,
    vitestBlock,
    mjmlBlock,
    stripeBlock,
    terraformVarsBlock,
    openapiSecurityBlock,
    k8sResourcesBlock,
    cssAnimBlock,
    storybookBlock,
    sentryBlock,
    natsBlock,
    pkgJsonBlock,
    redisBlock,
    nginxBlock,
    otelBlock,
    moduleFederationBlock,
    discourseBlock,
    sectionRolesBlock,
    primaryDocType,
    perFileProfile: profiles.map((p) => ({
      fileId: p.fileId,
      type: p.classification.type,
      confidence: p.classification.confidence,
    })),
  };
}

/**
 * Analysis quality block — pairs the insights-engine output with each file's
 * professional classification and emits a coverage / breadth / coherence
 * scorecard. The chat consumes this so the model can self-calibrate ("I have
 * direct evidence for X but I'm at 38% coverage so Y is unverified"). Empty
 * string when the scorer module is unavailable or no file has text.
 */
function buildQualityBlock(files, profiles) {
  const scorer = getQualityScorer();
  const insightsEngine = getInsightsEngine();
  if (!scorer || typeof scorer.buildQualityForFiles !== 'function') return '';
  if (!insightsEngine || typeof insightsEngine.buildInsightsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files.filter((f) => f && typeof f === 'object') : [];
  if (list.length === 0) return '';
  const { perFile } = insightsEngine.buildInsightsForFiles(list);
  if (perFile.length === 0) return '';
  const classifications = (Array.isArray(profiles) ? profiles : []).map((p) => ({
    file: p.fileId || null,
    classification: p.classification,
  }));
  // Match per-file insights to classifications by index when fileId isn't
  // present — keeps single-file flows aligned even without DB hydration.
  const annotated = perFile.map((entry, idx) => {
    const cls = classifications[idx]?.classification || null;
    return { file: entry.file, classification: cls };
  });
  return scorer.buildQualityForFiles(perFile, annotated);
}

/**
 * Evidence map block - deterministic citeable snippets with page/sheet/slide
 * anchors. This gives the model a compact audit layer before it reads raw
 * extracted text.
 */
function buildEvidenceMapBlock(files) {
  const engine = getEvidenceMap();
  if (!engine || typeof engine.buildEvidenceMapForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildEvidenceMapForFiles(list);
  return engine.renderEvidenceMapBlock(report);
}

/**
 * Internal-consistency block — fires whenever the checker finds at least
 * one intra-document inconsistency (label/value conflict, total mismatch,
 * inverted date range, polar contradiction, percentage overflow, tense
 * conflict). Empty string when nothing fires.
 */
/**
 * Deep-analysis block — sentence-level claims, actions, decisions, open
 * questions and risks. Complementary to insights (entities/numbers) and
 * consistency (intra-doc contradictions). Empty when nothing extracted.
 */
function buildDeepAnalysisBlock(files) {
  const engine = getDeepAnalyzer();
  if (!engine || typeof engine.buildDeepAnalysisForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDeepAnalysisForFiles(list);
  return engine.renderDeepAnalysisBlock(report);
}

/**
 * Quotes & citations block — surfaces verbatim language and bibliographic
 * markers (parenthetical author-year, bracketed numerics, et-al, footnote
 * markers) so the model can answer literal-quote and source-trace
 * questions without paraphrasing. Empty when nothing is extracted.
 */
function buildQuotesBlock(files) {
  const engine = getQuoteExtractor();
  if (!engine || typeof engine.buildQuotesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildQuotesForFiles(list);
  return engine.renderQuotesBlock(report);
}

/**
 * Discourse map block — surfaces the argumentative connectives in reading
 * order so the model can navigate by argument flow (contrast / causation /
 * sequence / conclusion / exemplification / concession / emphasis).
 */
function buildDiscourseBlock(files) {
  const engine = getDiscourseMapper();
  if (!engine || typeof engine.buildDiscourseForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDiscourseForFiles(list);
  return engine.renderDiscourseBlock(report);
}

/**
 * Section roles block — maps each heading to a rhetorical role
 * (academic intro/method/results/discussion/conclusion or legal
 * preamble/clauses/annex/etc) so the model can route section-scoped
 * questions directly to the relevant span. Distinct from the outline,
 * which is purely a literal table of contents.
 */
function buildSectionRolesBlock(files) {
  const engine = getSectionClassifier();
  if (!engine || typeof engine.buildSectionsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSectionsForFiles(list);
  return engine.renderSectionsBlock(report);
}

/**
 * Numeric coherence block — positive math validation that pairs with the
 * consistency checker. Confirmations (sums that audit cleanly) ground the
 * model so it doesn't invent corrections; warnings/errors flag groups
 * that don't reconcile (percentages, growth deltas, currency mixing,
 * share totals, averages out of declared range).
 */
function buildNumericCoherenceBlock(files) {
  const engine = getNumericCoherence();
  if (!engine || typeof engine.buildCoherenceForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCoherenceForFiles(list);
  return engine.renderCoherenceBlock(report);
}

/**
 * Temporal timeline block — chronological ordering of dated events across
 * the attached document(s). Lets the model answer "what happened when",
 * "what is upcoming", "what is overdue" without re-scanning raw text.
 */
function buildTemporalTimelineBlock(files) {
  const engine = getTemporalTimeline();
  if (!engine || typeof engine.buildTimelineForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTimelineForFiles(list);
  return engine.renderTimelineBlock(report);
}

/**
 * Action dashboard block — priority-ordered operations punch list that
 * fuses deep-analyzer (actions/decisions/risks/open questions) with the
 * temporal-timeline (overdue/upcoming deadlines). Surfaces the working
 * "what's next" view above raw text so the model answers operations
 * questions ("what's overdue?", "what's pending?") from a single
 * authoritative summary instead of re-scanning per call.
 */
function buildActionDashboardBlock(files) {
  const engine = getActionDashboard();
  if (!engine || typeof engine.buildDashboardForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDashboardForFiles(list);
  return engine.renderDashboardBlock(report);
}

/**
 * Audience + tone block — two-axis classification of each file. The chat
 * uses this to mirror the source's register (executive vs academic vs
 * support) and tone (formal / persuasive / instructional / analytical /
 * conversational / urgent) instead of defaulting to a generic house
 * style. Flags mixed-register batches so multi-file uploads don't get
 * their analyses smudged together.
 */
function buildAudienceToneBlock(files) {
  const engine = getAudienceTone();
  if (!engine || typeof engine.buildAudienceToneForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildAudienceToneForFiles(list);
  return engine.renderAudienceToneBlock(report);
}

/**
 * Cross-document semantic graph block — entity-keyed view of the
 * attached batch. Lets the chat answer "what does each document say
 * about X?" and surface monetary conflicts when the same entity is
 * paired with different amounts across files. Only fires for 1+ file
 * but is most useful for multi-document analysis.
 */
function buildSemanticGraphBlock(files) {
  const engine = getSemanticGraph();
  if (!engine || typeof engine.buildGraphForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGraphForFiles(list);
  return engine.renderGraphBlock(report);
}

/**
 * KPI extractor block — quantitative metrics (label / value / period /
 * direction) pulled from the attached document(s). Routes the chat's
 * "what's the X metric?" / "show me the headline numbers" questions
 * directly to a citeable list instead of re-scanning text.
 */
function buildKpisBlock(files) {
  const engine = getKpiExtractor();
  if (!engine || typeof engine.buildKpisForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildKpisForFiles(list);
  return engine.renderKpisBlock(report);
}

/**
 * Risk register block — categorised, severity-scored risks across the
 * attached document(s). Differs from the deep-analyzer's "risk
 * sentences" bucket by tagging each entry with a category
 * (operational / legal / financial / technical / reputational) and a
 * severity (critical → low) plus a flag when the source itself
 * proposes a mitigation. Sits next to the KPI block so the model has
 * both axes (numbers + threats) before the cross-doc synthesis.
 */
function buildRiskRegisterBlock(files) {
  const engine = getRiskRegister();
  if (!engine || typeof engine.buildRegisterForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildRegisterForFiles(list);
  return engine.renderRegisterBlock(report);
}

/**
 * Fact-density block — ranks sections by verifiable-anchor density
 * (numbers / dates / monies / percents / entities / acronyms /
 * citations per KB). Lets the chat cite the densest sections first
 * when answering numeric or evidentiary questions instead of treating
 * every section uniformly.
 */
function buildFactDensityBlock(files) {
  const engine = getFactDensity();
  if (!engine || typeof engine.buildDensityForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDensityForFiles(list);
  return engine.renderDensityBlock(report);
}

/**
 * Document relationships block — pairwise classification (versions /
 * complementary / conflicting / unrelated). Fires only for 2+ files.
 * Returns empty when every pair is "unrelated" to avoid noise.
 */
function buildRelationshipsBlock(files) {
  const engine = getRelationshipClassifier();
  if (!engine || typeof engine.classifyRelationships !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length < 2) return '';
  const report = engine.classifyRelationships(list);
  return engine.renderRelationshipsBlock(report);
}

/**
 * Cross-document section similarity block — top section-to-section
 * matches between files by token-set Jaccard. Fires only for 2+ files
 * with enough body to split into sections. Lets the model anchor
 * comparison answers ("compare the scope clauses") on actual matching
 * sections instead of paraphrasing across files.
 */
function buildSectionSimilarityBlock(files) {
  const engine = getSectionSimilarity();
  if (!engine || typeof engine.buildSimilarityForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length < 2) return '';
  const report = engine.buildSimilarityForFiles(list);
  return engine.renderSimilarityBlock(report);
}

/**
 * Numeric statistics block — captures the SHAPE of distributions
 * (mean / median / std dev / variance / range / percentile / quartile
 * / skew / kurtosis / CI / p-value / correlation / effect size).
 * Different from the KPI extractor (operational metrics) — this
 * surfaces statistical claims the model can cite directly when the
 * user asks "what's the average / median / spread?".
 */
function buildNumericStatisticsBlock(files) {
  const engine = getNumericStatistics();
  if (!engine || typeof engine.buildStatisticsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildStatisticsForFiles(list);
  return engine.renderStatisticsBlock(report);
}

/**
 * Quality grade block — letter grade per document (A → F) over seven
 * weighted dimensions: structure, density, citations, clarity,
 * completeness, freshness, traceability. Lets the chat hint how much
 * weight a claim from each document deserves — a higher grade does
 * not mean the content is correct, only that it's well-structured,
 * sourced, and current.
 */
function buildQualityGradeBlock(files) {
  const engine = getQualityGrade();
  if (!engine || typeof engine.buildGradesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGradesForFiles(list);
  return engine.renderGradeBlock(report);
}

/**
 * Title block — canonical title detected per document. Heuristic
 * source ranking: markdown # → HTML <title>/<h1> → PDF first-line
 * → filename fallback. Lets the chat cite the document by its
 * human title rather than its filename.
 */
function buildTitlesBlock(files) {
  const engine = getTitleExtractor();
  if (!engine || typeof engine.buildTitlesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTitlesForFiles(list);
  return engine.renderTitlesBlock(report);
}

/**
 * TL;DR block — three-bullet deterministic executive summary per
 * document combining the most salient sentence (lede / fact anchor),
 * the top deep-analyzer claim, and the top actionable / decision /
 * risk. Bullets are verbatim sentences so the model can quote them.
 */
function buildTldrBlock(files) {
  const engine = getTldr();
  if (!engine || typeof engine.buildTldrForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTldrForFiles(list);
  return engine.renderTldrBlock(report);
}

/**
 * Sentiment block — per-section polarity surfaced from a positive vs
 * negative bilingual lexicon. Hedges + intensifiers amplify; negations
 * within ±3 tokens flip. Helps the model detect tone shifts inside a
 * single document (neutral intro → very-negative risks → positive
 * conclusion) instead of flattening everything to a single mood.
 */
function buildSentimentBlock(files) {
  const engine = getSentiment();
  if (!engine || typeof engine.buildSentimentForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSentimentForFiles(list);
  return engine.renderSentimentBlock(report);
}

/**
 * Key phrases block — TF × IDF-light keyphrase ranking across the
 * attached batch (single-file uploads degrade to TF only). Lets the
 * chat answer "what is this document about?" with the topical anchors
 * already weighted against the rest of the batch.
 */
function buildKeyPhrasesBlock(files) {
  const engine = getKeyPhrases();
  if (!engine || typeof engine.buildKeyPhrasesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildKeyPhrasesForFiles(list);
  return engine.renderKeyPhrasesBlock(report);
}

/**
 * Obligations block — binding clauses surfaced from contracts /
 * policies / SLAs. Different from the deep-analyzer's action bucket
 * (generic deliverables): this captures BINDING language with modal
 * verbs ("shall", "must", "deberá") + subject attribution + deadline
 * detection. Tags each clause as positive obligation or prohibition.
 */
function buildObligationsBlock(files) {
  const engine = getObligations();
  if (!engine || typeof engine.buildObligationsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildObligationsForFiles(list);
  return engine.renderObligationsBlock(report);
}

/**
 * Scope & exclusions block — sentences that explicitly state what is
 * COVERED vs what is EXCLUDED. Lets the chat answer "is X in scope?"
 * / "what's NOT included?" / "does this cover Y?" by quoting the
 * source boundary directly rather than inferring from prose.
 */
function buildScopeExclusionsBlock(files) {
  const engine = getScopeExclusions();
  if (!engine || typeof engine.buildScopeForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildScopeForFiles(list);
  return engine.renderScopeBlock(report);
}

/**
 * Stakeholder map block — role-based stakeholder counts grouped by
 * function (leadership / operations / customer / partner / investor
 * / regulator / workforce / legal). Helps the model know whose
 * interests dominate each document before answering "who is
 * affected?" / "who decides?".
 */
function buildStakeholderMapBlock(files) {
  const engine = getStakeholderMap();
  if (!engine || typeof engine.buildStakeholderMapForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildStakeholderMapForFiles(list);
  return engine.renderStakeholderBlock(report);
}

/**
 * Jurisdiction block — surfaces country/sub-national jurisdictions
 * mentioned, dominant currency, regulator references and any explicit
 * governing-law clauses. Lets the chat answer "which law applies?"
 * "which regulator oversees this?" without re-scanning raw text.
 */
function buildJurisdictionBlock(files) {
  const engine = getJurisdictionDetector();
  if (!engine || typeof engine.buildJurisdictionForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildJurisdictionForFiles(list);
  return engine.renderJurisdictionBlock(report);
}

/**
 * Definitions block — captures formal "X means Y" / "X se define como
 * Y" patterns the document itself emits. Sits next to the glossary so
 * the model has both vocabulary (terms it should know) and formal
 * definitions (what those terms mean here) before answering content
 * questions.
 */
function buildDefinitionsBlock(files) {
  const engine = getDefinitionsExtractor();
  if (!engine || typeof engine.buildDefinitionsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDefinitionsForFiles(list);
  return engine.renderDefinitionsBlock(report);
}

/**
 * Cross-reference block — internal pointers ("see Section 4.2",
 * "véase la Cláusula 3.1"). Lets the model follow clause chains
 * across the same document when answering "what does Section X
 * say?" without re-scanning.
 */
function buildCrossReferenceBlock(files) {
  const engine = getCrossReference();
  if (!engine || typeof engine.buildReferencesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildReferencesForFiles(list);
  return engine.renderReferencesBlock(report);
}

/**
 * Pricing block — monetary anchors with label / amount / currency /
 * cadence (per hour / monthly / annual / per user / one-time). Routes
 * "how much does X cost?" / "what's the rate?" questions to a
 * citeable list rather than re-scanning prose.
 */
function buildPricingBlock(files) {
  const engine = getPricingExtractor();
  if (!engine || typeof engine.buildPricingForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPricingForFiles(list);
  return engine.renderPricingBlock(report);
}

/**
 * Metadata block — authoring stamps the document itself emits
 * (version, effective / issued / revision dates, author / signer /
 * reference number). Lets the chat anchor its answer in the
 * document's stated provenance.
 */
function buildMetadataBlock(files) {
  const engine = getMetadataExtractor();
  if (!engine || typeof engine.buildMetadataForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMetadataForFiles(list);
  return engine.renderMetadataBlock(report);
}

/**
 * Compliance framework block — explicit mentions of regulated
 * standards (GDPR / HIPAA / ISO 27001 / SOC 2 / PCI-DSS / SOX / EU AI
 * Act / etc.) with a one-line summary so the model speaks to the
 * named framework specifically.
 */
function buildComplianceBlock(files) {
  const engine = getComplianceMatcher();
  if (!engine || typeof engine.buildComplianceForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildComplianceForFiles(list);
  return engine.renderComplianceBlock(report);
}

/**
 * Warranties block — express warranties / representations and
 * warranty disclaimers. Different from obligations: warranties are
 * STATEMENTS OF FACT a party is asserting, vs obligations which
 * compel future action. Helpful for risk allocation analysis.
 */
function buildWarrantiesBlock(files) {
  const engine = getWarrantiesExtractor();
  if (!engine || typeof engine.buildWarrantiesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildWarrantiesForFiles(list);
  return engine.renderWarrantiesBlock(report);
}

/**
 * Dispute resolution block — arbitration / mediation / litigation /
 * escalation / waiver clauses with seat / forum when present.
 * Completes the legal cluster (obligations + scope + warranties +
 * compliance + jurisdiction) by surfacing how disputes are handled.
 */
function buildDisputeResolutionBlock(files) {
  const engine = getDisputeResolution();
  if (!engine || typeof engine.buildDisputesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDisputesForFiles(list);
  return engine.renderDisputesBlock(report);
}

/**
 * Indemnification & liability block — captures clauses that allocate
 * financial responsibility (positive duty to indemnify, aggregate
 * liability caps, exclusions of consequential / indirect / punitive
 * damages). Lets the chat answer "who bears the cost if X goes
 * wrong?" with citeable clauses.
 */
function buildIndemnificationBlock(files) {
  const engine = getIndemnification();
  if (!engine || typeof engine.buildIndemnificationForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildIndemnificationForFiles(list);
  return engine.renderIndemnificationBlock(report);
}

/**
 * Acronyms block — acronym ↔ expanded-form mappings as DECLARED by
 * the document itself ("Acme Business Corporation (ABC)" etc.).
 * Overrides external dictionaries when the user asks "what does X
 * stand for?".
 */
function buildAcronymsBlock(files) {
  const engine = getAcronymExpansion();
  if (!engine || typeof engine.buildAcronymsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildAcronymsForFiles(list);
  return engine.renderAcronymsBlock(report);
}

/**
 * Temporal expressions block — RELATIVE time anchors (today / next
 * quarter / end of fiscal year / within the next 6 months /
 * dentro de N días). Complements the absolute-date timeline by
 * surfacing the soft time anchors documents lean on when speaking
 * about plans, forecasts and commitments.
 */
function buildTemporalExpressionsBlock(files) {
  const engine = getTemporalExpressions();
  if (!engine || typeof engine.buildExpressionsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildExpressionsForFiles(list);
  return engine.renderExpressionsBlock(report);
}

/**
 * Cross-file numeric comparison block — side-by-side leaderboard for
 * the same concept-tag (revenue / margin / churn / NPS / headcount /
 * uptime / etc.) across the attached files. Fires only when 2+
 * files share at least one concept with a captured value.
 */
function buildCrossNumericBlock(files) {
  const engine = getCrossNumeric();
  if (!engine || typeof engine.buildComparisonForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length < 2) return '';
  const report = engine.buildComparisonForFiles(list);
  return engine.renderComparisonBlock(report);
}

/**
 * Signature blocks — sign-off sections at the tail of each document
 * (Name / Title / Date / Company / Witness rows). Lets the chat
 * answer "who signed this and on behalf of whom?" with verbatim
 * lines instead of inference from prose.
 */
function buildSignatureBlocksBlock(files) {
  const engine = getSignatureBlock();
  if (!engine || typeof engine.buildSignaturesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSignaturesForFiles(list);
  return engine.renderSignaturesBlock(report);
}

/**
 * Q&A pairs block — explicit question + answer pairs from FAQs /
 * runbooks / knowledge-base articles. Lets the chat surface the
 * answer verbatim when the user's question semantically matches one
 * already in the source, rather than re-synthesising the answer.
 */
function buildQaPairsBlock(files) {
  const engine = getQaPairs();
  if (!engine || typeof engine.buildQaForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildQaForFiles(list);
  return engine.renderQaBlock(report);
}

/**
 * Hypotheses block — research hypotheses, null hypotheses, and
 * research questions stated by academic / scientific documents. Helps
 * the chat answer "what is the document testing?" with citeable
 * statements instead of synthesising from prose.
 */
function buildHypothesesBlock(files) {
  const engine = getHypotheses();
  if (!engine || typeof engine.buildHypothesesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildHypothesesForFiles(list);
  return engine.renderHypothesesBlock(report);
}

/**
 * Recommendations block — explicit "we recommend / suggest" sentences
 * the document proposes. Different from obligations (binding) and
 * deep-analyzer actions (generic): these are SUGGESTED courses of
 * action the author explicitly proposes.
 */
function buildRecommendationsBlock(files) {
  const engine = getRecommendations();
  if (!engine || typeof engine.buildRecommendationsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildRecommendationsForFiles(list);
  return engine.renderRecommendationsBlock(report);
}

/**
 * Assumptions block — "we assume / suponemos / under the assumption
 * that" sentences. Critical for auditing proposals, financial
 * models, risk assessments, and research. Surfaces the author's
 * mental model so the chat treats the document's claims as
 * conditional on these premises.
 */
function buildAssumptionsBlock(files) {
  const engine = getAssumptions();
  if (!engine || typeof engine.buildAssumptionsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildAssumptionsForFiles(list);
  return engine.renderAssumptionsBlock(report);
}

/**
 * Conditional clauses block — "if … then", "unless", "provided that",
 * "in the event of", "subject to", "failing which". Routes
 * "what happens if X?" questions to citeable trigger sentences.
 */
function buildConditionalClausesBlock(files) {
  const engine = getConditionalClauses();
  if (!engine || typeof engine.buildConditionalsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildConditionalsForFiles(list);
  return engine.renderConditionalsBlock(report);
}

/**
 * Counter-arguments block — sentences that introduce a contrasting
 * view, exception or caveat. Lets the chat answer "what are the
 * objections?" / "what's the counter-view?" with citeable sentences.
 */
function buildCounterArgumentsBlock(files) {
  const engine = getCounterArguments();
  if (!engine || typeof engine.buildCounterArgumentsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCounterArgumentsForFiles(list);
  return engine.renderCounterArgumentsBlock(report);
}

/**
 * Calls-to-action block — reader-directed imperatives (sign up /
 * subscribe / register / regístrate / suscríbete). Urgency tag set
 * when "now / today / limited time" qualifiers are present.
 */
function buildCallsToActionBlock(files) {
  const engine = getCallToAction();
  if (!engine || typeof engine.buildCTAsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCTAsForFiles(list);
  return engine.renderCTAsBlock(report);
}

/**
 * Required disclosures block — forward-looking statements, safe-
 * harbour notices, risk warnings, conflict-of-interest disclosures,
 * "not financial advice" caveats. Sits in the legal cluster so the
 * chat has the full set of disclaimers the document carries before
 * any cross-document synthesis.
 */
function buildDisclosuresBlock(files) {
  const engine = getDisclosures();
  if (!engine || typeof engine.buildDisclosuresForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDisclosuresForFiles(list);
  return engine.renderDisclosuresBlock(report);
}

/**
 * Fact vs opinion block — separates sentences into verifiable facts
 * (numbers / dates / entities / report-style verbs) vs subjective
 * opinions (hedges / believe / seems / parece / creemos). Helps the
 * chat distinguish "what's verifiable" from "what's the author's
 * view".
 */
function buildFactVsOpinionBlock(files) {
  const engine = getFactVsOpinion();
  if (!engine || typeof engine.buildClassificationForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildClassificationForFiles(list);
  return engine.renderClassificationBlock(report);
}

/**
 * Scenarios block — scenario-planning language (best / worst / base
 * case, sensitivity analyses, stress tests). Lets the chat answer
 * "what scenarios does the document model?" / "what's the worst
 * case?" with citeable trigger sentences.
 */
function buildScenariosBlock(files) {
  const engine = getScenarios();
  if (!engine || typeof engine.buildScenariosForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildScenariosForFiles(list);
  return engine.renderScenariosBlock(report);
}

/**
 * Benchmarks block — comparison / reference points ("vs competitor",
 * "industry average", "comparado con", "frente al promedio"). Lets
 * the chat answer "how does X compare to Y?" with citeable trigger
 * sentences.
 */
function buildBenchmarksBlock(files) {
  const engine = getBenchmarks();
  if (!engine || typeof engine.buildBenchmarksForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildBenchmarksForFiles(list);
  return engine.renderBenchmarksBlock(report);
}

/**
 * Goals & targets block — explicit objective / OKR / target / KR
 * statements. Different from action items (operational TODOs) and
 * recommendations (suggestions): these are aspirational commitments.
 */
function buildGoalsTargetsBlock(files) {
  const engine = getGoalsTargets();
  if (!engine || typeof engine.buildGoalsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGoalsForFiles(list);
  return engine.renderGoalsBlock(report);
}

/**
 * SLA terms block — service-level commitments (uptime / response /
 * resolution / credit policy / RPO / RTO). Lets the chat answer
 * "what's the uptime SLA?" / "what's the credit policy?" with
 * quantitative source sentences.
 */
function buildSLATermsBlock(files) {
  const engine = getSLATerms();
  if (!engine || typeof engine.buildSLATermsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSLATermsForFiles(list);
  return engine.renderSLATermsBlock(report);
}

/**
 * Data-classification block — document-level labels (Confidential /
 * Restricted / Public / Internal Use Only / PII / PHI / Trade Secret
 * / TLP Red/Amber/Green/White). Lets the chat respect the source's
 * handling policy when answering.
 */
function buildDataClassificationBlock(files) {
  const engine = getDataClassification();
  if (!engine || typeof engine.buildClassificationForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildClassificationForFiles(list);
  return engine.renderClassificationBlock(report);
}

/**
 * Approval-workflow block — Drafted by / Reviewed by / Approved by /
 * Released by / Signed by stamps with named people and nearest date.
 * Different from the signature-block detector (legal tail sign-off):
 * this surfaces workflow STAGES in change-control headers.
 */
function buildApprovalWorkflowBlock(files) {
  const engine = getApprovalWorkflow();
  if (!engine || typeof engine.buildApprovalsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildApprovalsForFiles(list);
  return engine.renderApprovalsBlock(report);
}

/**
 * Executive summary block — single-card per-file synthesis combining
 * title + grade + TL;DR + top KPI + top risk + top obligation. The
 * chat opens analytical answers with this block before diving into
 * per-axis detail.
 */
function buildExecutiveSummaryBlock(files) {
  const engine = getExecutiveSummary();
  if (!engine || typeof engine.buildExecutiveSummaryForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildExecutiveSummaryForFiles(list);
  return engine.renderExecutiveSummaryBlock(report);
}

/**
 * URLs & links block — HTTP(S) URLs + markdown links with anchor /
 * context. Lets the chat answer "what URLs does the document
 * reference?" with citeable verbatim links.
 */
function buildUrlsBlock(files) {
  const engine = getUrlExtractor();
  if (!engine || typeof engine.buildURLsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildURLsForFiles(list);
  return engine.renderURLsBlock(report);
}

/**
 * Contacts block — emails, phones, social handles, addresses. Both
 * raw + masked variants are shown so the chat can echo the masked
 * form when the user's question doesn't require the raw value.
 */
function buildContactsBlock(files) {
  const engine = getContactInfo();
  if (!engine || typeof engine.buildContactsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildContactsForFiles(list);
  return engine.renderContactsBlock(report);
}

/**
 * Footnotes block — markdown / numbered footnote definitions paired
 * with their markers. Routes "what does footnote N say?" to a
 * citeable marker→body table.
 */
function buildFootnotesBlock(files) {
  const engine = getFootnotes();
  if (!engine || typeof engine.buildFootnotesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildFootnotesForFiles(list);
  return engine.renderFootnotesBlock(report);
}

/**
 * Markdown tables block — surfaces embedded markdown tables with
 * caption + header + first N rows so the chat can quote "table N"
 * verbatim. Different from the evidence-map block which extracts
 * table previews from spreadsheet attachments via DB hydration.
 */
function buildTablesBlock(files) {
  const engine = getTables();
  if (!engine || typeof engine.buildTablesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTablesForFiles(list);
  return engine.renderTablesBlock(report);
}

/**
 * Code-blocks block — fenced code blocks (\`\`\`language) with a
 * 12-line preview. Useful for technical / SDK / runbook docs;
 * empty for prose-only files.
 */
function buildCodeBlocksBlock(files) {
  const engine = getCodeBlocks();
  if (!engine || typeof engine.buildCodeBlocksForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCodeBlocksForFiles(list);
  return engine.renderCodeBlocksBlock(report);
}

/**
 * Figure / table references block — Figure / Table / Chart /
 * Equation / Diagram / Appendix labels with caption when stated.
 * Different from cross-references (Section / Article pointers):
 * targets visual / artefact references with optional captions.
 */
function buildFigureRefsBlock(files) {
  const engine = getFigureRefs();
  if (!engine || typeof engine.buildFigureRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildFigureRefsForFiles(list);
  return engine.renderFigureRefsBlock(report);
}

/**
 * Checklists block — markdown checkbox items grouped under their
 * heading with done / pending / in-progress / unclear state. Routes
 * "what's still pending?" / "what's been done?" to source-marked
 * bullets instead of inference.
 */
function buildChecklistsBlock(files) {
  const engine = getChecklists();
  if (!engine || typeof engine.buildChecklistsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildChecklistsForFiles(list);
  return engine.renderChecklistsBlock(report);
}

/**
 * Identifiers block — standardised IDs (ISBN, DOI, arXiv, PMID,
 * ticker, CUSIP, CIK, ISIN, UUID, ARN, CVE, RFC). Routes "what's
 * the document ID?" to a citeable list.
 */
function buildIdentifiersBlock(files) {
  const engine = getIdentifiers();
  if (!engine || typeof engine.buildIdentifiersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildIdentifiersForFiles(list);
  return engine.renderIdentifiersBlock(report);
}

/**
 * Bullet lists block — markdown bullets / numbered lists grouped
 * under their heading. Surfaces source-structured lists verbatim
 * (skips checkbox items since those go in the checklists block).
 */
function buildBulletListsBlock(files) {
  const engine = getBulletLists();
  if (!engine || typeof engine.buildBulletListsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildBulletListsForFiles(list);
  return engine.renderBulletListsBlock(report);
}

/**
 * Mermaid diagrams block — surfaces fenced ```mermaid blocks with
 * diagram type classification (flowchart / sequence / class / state /
 * er / gantt / pie / journey / timeline / gitGraph / mindmap /
 * quadrant / sankey / requirement / c4) plus first-8-line preview.
 * Routes "what does the diagram show?" / "is there a flowchart?"
 * to a structured citeable preview.
 */
function buildMermaidBlock(files) {
  const engine = getMermaid();
  if (!engine || typeof engine.buildMermaidForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMermaidForFiles(list);
  return engine.renderMermaidBlock(report);
}

/**
 * Priorities block — surfaces priority/severity markers (P0–P4,
 * SEV-1..SEV-5, Critical/Major/Minor/Trivial/Blocker, Urgent,
 * Spanish equivalents, "Priority: X" labeled lines) with normalised
 * level (critical/high/medium/low/trivial) and citeable context.
 * Routes "what are the critical items?" to a structured citeable list.
 */
function buildPrioritiesBlock(files) {
  const engine = getPriority();
  if (!engine || typeof engine.buildPrioritiesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPrioritiesForFiles(list);
  return engine.renderPrioritiesBlock(report);
}

/**
 * Ownership block — per-document role attributions (Owner/DRI,
 * Assignee, Reporter, Author/Maintainer, Reviewer, Approver,
 * Stakeholder, Lead/Driver) including Spanish equivalents.
 * Routes "who owns this?" / "who's the DRI?" to a citeable list.
 */
function buildOwnershipBlock(files) {
  const engine = getOwnership();
  if (!engine || typeof engine.buildOwnershipForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildOwnershipForFiles(list);
  return engine.renderOwnershipBlock(report);
}

/**
 * Timestamps block — machine-format ISO 8601 datetimes + dates,
 * epoch s/ms, HTTP date format, ISO 8601 durations + human durations.
 * Different from temporal-timeline / temporal-expressions by
 * focusing on parseable timestamps useful for logs / runbooks /
 * SLAs. Routes "when did X happen?" / "how long is the SLA?" to
 * a structured citeable list.
 */
function buildTimestampsBlock(files) {
  const engine = getTimestamps();
  if (!engine || typeof engine.buildTimestampsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTimestampsForFiles(list);
  return engine.renderTimestampsBlock(report);
}

/**
 * Status / lifecycle block — Status / Stage / Lifecycle / State lines
 * plus inline [DRAFT] / (DEPRECATED) / SUPERSEDED: callouts. Normalised
 * into buckets (draft/review/approved/active/rejected/deprecated/archived/
 * pre-release). Routes "is this approved?" / "what's the status?" to
 * a citeable signal.
 */
function buildStatusBlock(files) {
  const engine = getStatus();
  if (!engine || typeof engine.buildStatusForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildStatusForFiles(list);
  return engine.renderStatusBlock(report);
}

/**
 * Acceptance criteria block — Gherkin scenarios (Scenario / Background
 * with Given–When–Then–And–But steps in English and Spanish) plus
 * labelled "Acceptance Criteria:" bullet lists. Routes "what are the
 * acceptance criteria?" / "what are the test scenarios?" to a citeable
 * structure.
 */
function buildAcceptanceCriteriaBlock(files) {
  const engine = getAcceptanceCriteria();
  if (!engine || typeof engine.buildAcceptanceCriteriaForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildAcceptanceCriteriaForFiles(list);
  return engine.renderAcceptanceCriteriaBlock(report);
}

/**
 * API endpoints block — HTTP method + path references surfaced from
 * inline mentions, markdown headers, OpenAPI paths blocks. Groups by
 * method, dedupes by canonical METHOD path. Routes "what endpoints
 * does this expose?" / "is there a POST /api/x?" to a citeable
 * inventory.
 */
function buildApiEndpointsBlock(files) {
  const engine = getApiEndpoints();
  if (!engine || typeof engine.buildApiEndpointsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildApiEndpointsForFiles(list);
  return engine.renderApiEndpointsBlock(report);
}

/**
 * Env vars block — SCREAMING_SNAKE_CASE tokens referenced as
 * environment variables / config flags (bare, prefixed via $/env/
 * process.env, or .env-style declarations). Stopword-filtered to
 * exclude common acronyms (HTTP / JSON / CVE / etc.). Routes
 * "what env vars does this need?" / "what config does it expect?"
 * to a citeable inventory.
 */
function buildEnvVarsBlock(files) {
  const engine = getEnvVars();
  if (!engine || typeof engine.buildEnvVarsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildEnvVarsForFiles(list);
  return engine.renderEnvVarsBlock(report);
}

/**
 * SQL block — classifies SQL statements detected in the document(s)
 * by kind (DDL / DML / DQL / DCL / TCL) with target table where
 * applicable. Routes "what tables does this touch?" / "is there a
 * DDL change?" to a citeable inventory.
 */
function buildSqlBlock(files) {
  const engine = getSql();
  if (!engine || typeof engine.buildSqlForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSqlForFiles(list);
  return engine.renderSqlBlock(report);
}

/**
 * File paths block — filesystem paths (POSIX absolute,
 * home-relative ~/, project-relative with known extension,
 * Windows absolute). Different from API endpoints and URLs.
 * Routes "what files does this reference?" to a citeable inventory.
 */
function buildFilePathsBlock(files) {
  const engine = getFilePaths();
  if (!engine || typeof engine.buildFilePathsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildFilePathsForFiles(list);
  return engine.renderFilePathsBlock(report);
}

/**
 * Cron block — 5/6/7-field cron expressions + named expressions
 * (@daily / @hourly / etc.) + K8s/YAML schedule: lines. Routes
 * "when does this run?" / "what's the schedule?" to a citeable list.
 */
function buildCronBlock(files) {
  const engine = getCron();
  if (!engine || typeof engine.buildCronForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCronForFiles(list);
  return engine.renderCronBlock(report);
}

/**
 * Licenses block — SPDX identifiers, SPDX-License-Identifier headers,
 * "Licensed under …" attributions, Copyright lines, "All Rights
 * Reserved" declarations. Routes "what license is this under?" /
 * "who holds the copyright?" to a citeable inventory.
 */
function buildLicensesBlock(files) {
  const engine = getLicenses();
  if (!engine || typeof engine.buildLicensesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildLicensesForFiles(list);
  return engine.renderLicensesBlock(report);
}

/**
 * Dependencies block — package declarations across npm/pip/cargo/
 * gomod/maven ecosystems with name + version. Routes "what
 * dependencies does this use?" / "what version of X?" to a citeable
 * inventory.
 */
function buildDependenciesBlock(files) {
  const engine = getDependencies();
  if (!engine || typeof engine.buildDependenciesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDependenciesForFiles(list);
  return engine.renderDependenciesBlock(report);
}

/**
 * Risk matrix block — likelihood/impact pairings and numeric risk
 * scores normalised to very-low/low/medium/high/critical. Routes
 * "what's the risk score?" / "what's the likelihood/impact?" to a
 * citeable matrix. Different from priority/severity (ticket-level).
 */
function buildRiskMatrixBlock(files) {
  const engine = getRiskMatrix();
  if (!engine || typeof engine.buildRiskMatrixForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildRiskMatrixForFiles(list);
  return engine.renderRiskMatrixBlock(report);
}

/**
 * Versions block — SemVer, labeled "Version: X.Y.Z" lines, release
 * headers, CalVer. Different from per-package dependencies by focusing
 * on document-level versioning. Routes "what version is this?" /
 * "what's the latest release?" to a citeable list.
 */
function buildVersionsBlock(files) {
  const engine = getVersions();
  if (!engine || typeof engine.buildVersionsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildVersionsForFiles(list);
  return engine.renderVersionsBlock(report);
}

/**
 * Decision records block — ADR-shaped fields (Decision / Context /
 * Consequences / Alternatives / Trade-offs / Rationale) in English
 * and Spanish. Routes "what's the decision?", "why was this decided?",
 * "what are the alternatives?" to a citeable record.
 */
function buildDecisionRecordsBlock(files) {
  const engine = getDecisionRecords();
  if (!engine || typeof engine.buildDecisionRecordsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDecisionRecordsForFiles(list);
  return engine.renderDecisionRecordsBlock(report);
}

/**
 * Domains block — bare domain names (no scheme, no path). Validated
 * against a curated TLD list. Different from URLs (scheme+path) and
 * emails. Routes "what domains does this reference?" to a citeable list.
 */
function buildDomainsBlock(files) {
  const engine = getDomains();
  if (!engine || typeof engine.buildDomainsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDomainsForFiles(list);
  return engine.renderDomainsBlock(report);
}

/**
 * Currency block — monetary amounts with currency tags (symbol-prefix,
 * ISO-suffix, ISO-prefix). Different from pricing (named tiers) and
 * numeric stats. Routes "what amount?" / "how much?" to a list.
 */
function buildCurrencyBlock(files) {
  const engine = getCurrency();
  if (!engine || typeof engine.buildCurrencyForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCurrencyForFiles(list);
  return engine.renderCurrencyBlock(report);
}

/**
 * Percentages block — numeric (12%, +15%), word-form (12 percent /
 * por ciento), percentage-points, basis-points. Routes "what's the
 * rate?" / "what percentage?" to a citeable inventory.
 */
function buildPercentagesBlock(files) {
  const engine = getPercentages();
  if (!engine || typeof engine.buildPercentagesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPercentagesForFiles(list);
  return engine.renderPercentagesBlock(report);
}

/**
 * Citations block — academic citation patterns (numeric, bracketed
 * author-year, parenthetical author-year, "et al." in-text) plus
 * detection of References/Bibliography section. Routes "what
 * references are cited?" / "is this peer-reviewed?" to a citeable
 * inventory.
 */
function buildCitationsBlock(files) {
  const engine = getCitations();
  if (!engine || typeof engine.buildCitationsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCitationsForFiles(list);
  return engine.renderCitationsBlock(report);
}

/**
 * Colors block — hex / RGB / HSL / Tailwind / named CSS colors.
 * Routes "what colors does this use?" / "what's the brand palette?"
 * to a citeable inventory.
 */
function buildColorsBlock(files) {
  const engine = getColors();
  if (!engine || typeof engine.buildColorsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildColorsForFiles(list);
  return engine.renderColorsBlock(report);
}

/**
 * Coordinates block — geographic coordinates (decimal lat/lng,
 * labeled latitude/longitude, DMS, Open Location Plus codes).
 * Validated against lat/lng ranges. Routes "where is this?" /
 * "what coordinates?" to a citeable list.
 */
function buildCoordinatesBlock(files) {
  const engine = getCoordinates();
  if (!engine || typeof engine.buildCoordinatesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCoordinatesForFiles(list);
  return engine.renderCoordinatesBlock(report);
}

/**
 * Trademark block — inline TM/®/℠/© symbols + attribution lines.
 * Routes "what trademarks / brand marks?" to a citeable list.
 */
function buildTrademarkBlock(files) {
  const engine = getTrademark();
  if (!engine || typeof engine.buildTrademarkForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTrademarkForFiles(list);
  return engine.renderTrademarkBlock(report);
}

/**
 * Hashtags block — social-style hashtags + handles (Twitter,
 * Bluesky, Fediverse). Routes "what hashtags?" / "who's mentioned?".
 */
function buildHashtagsBlock(files) {
  const engine = getHashtags();
  if (!engine || typeof engine.buildHashtagsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildHashtagsForFiles(list);
  return engine.renderHashtagsBlock(report);
}

/**
 * Section labels block — numbered references (Section / § /
 * Chapter / Article / Part / Annex / Appendix / Clause / Paragraph)
 * including Spanish equivalents. Routes "what's Section X?" / "what
 * does Article 5 say?" to a citeable inventory.
 */
function buildSectionLabelsBlock(files) {
  const engine = getSectionLabels();
  if (!engine || typeof engine.buildSectionLabelsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSectionLabelsForFiles(list);
  return engine.renderSectionLabelsBlock(report);
}

/**
 * Sign-offs block — letter/email closing salutations (Sincerely,
 * Regards, Cheers, Atentamente, Saludos cordiales, …) + following
 * name. Routes "who signed?" / "what's the closing?".
 */
function buildSignoffsBlock(files) {
  const engine = getSignoffs();
  if (!engine || typeof engine.buildSignoffsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSignoffsForFiles(list);
  return engine.renderSignoffsBlock(report);
}

/**
 * Hashes block — cryptographic hex digests classified by length
 * (MD5/SHA-1/SHA-256/SHA-512/BLAKE). Routes "what's the hash?".
 */
function buildHashesBlock(files) {
  const engine = getHashes();
  if (!engine || typeof engine.buildHashesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildHashesForFiles(list);
  return engine.renderHashesBlock(report);
}

/**
 * Coupons block — promo / discount / voucher codes (labeled and
 * use-phrase forms). Routes "what's the promo code?" / "what discount?".
 */
function buildCouponsBlock(files) {
  const engine = getCoupons();
  if (!engine || typeof engine.buildCouponsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCouponsForFiles(list);
  return engine.renderCouponsBlock(report);
}

/**
 * File sizes block — KB/MB/GB/TB plus IEC binary variants and
 * bandwidth units. Routes "how big?" / "capacity?" / "throughput?".
 */
function buildFileSizesBlock(files) {
  const engine = getFileSizes();
  if (!engine || typeof engine.buildFileSizesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildFileSizesForFiles(list);
  return engine.renderFileSizesBlock(report);
}

/**
 * VCS refs block — commit SHAs, PR / issue numbers, owner/repo,
 * branches, tags. Routes "what commit?" / "what PR?" / "what branch?".
 */
function buildVcsRefsBlock(files) {
  const engine = getVcsRefs();
  if (!engine || typeof engine.buildVcsRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildVcsRefsForFiles(list);
  return engine.renderVcsRefsBlock(report);
}

/**
 * Standards block — ISO / ANSI / IEEE / RFC / NIST / W3C / EN /
 * DIN / PCI-DSS / SOC 1-3 / compliance abbreviations. Routes
 * "what standards?" / "is this ISO 27001 compliant?".
 */
function buildStandardsBlock(files) {
  const engine = getStandards();
  if (!engine || typeof engine.buildStandardsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildStandardsForFiles(list);
  return engine.renderStandardsBlock(report);
}

/**
 * Network block — IPv4 / IPv6 (with CIDR), MAC, ports. Routes
 * "what IP / port / network?".
 */
function buildNetworkBlock(files) {
  const engine = getNetwork();
  if (!engine || typeof engine.buildNetworkForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildNetworkForFiles(list);
  return engine.renderNetworkBlock(report);
}

/**
 * HTTP status block — 1xx/2xx/3xx/4xx/5xx codes with semantic class.
 * Routes "what status?" / "4xx error?" to a citeable list.
 */
function buildHttpStatusBlock(files) {
  const engine = getHttpStatus();
  if (!engine || typeof engine.buildHttpStatusForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildHttpStatusForFiles(list);
  return engine.renderHttpStatusBlock(report);
}

/**
 * Timezones block — UTC/GMT offsets, named abbreviations, IANA IDs.
 * Routes "what time zone?" / "what's the offset?".
 */
function buildTimezonesBlock(files) {
  const engine = getTimezones();
  if (!engine || typeof engine.buildTimezonesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTimezonesForFiles(list);
  return engine.renderTimezonesBlock(report);
}

/**
 * Math block — LaTeX inline / display / environment math expressions.
 * Routes "what equation?" / "what math?".
 */
function buildMathBlock(files) {
  const engine = getMath();
  if (!engine || typeof engine.buildMathForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMathForFiles(list);
  return engine.renderMathBlock(report);
}

/**
 * Boolean block — labeled yes/no/true/false config / FAQ values
 * plus glyph forms (✓ / ✗ / ☑ / ☐). Routes "is X enabled?" /
 * "what's the answer?".
 */
function buildBooleanBlock(files) {
  const engine = getBoolean();
  if (!engine || typeof engine.buildBooleansForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildBooleansForFiles(list);
  return engine.renderBooleansBlock(report);
}

/**
 * TOC block — Table of Contents sections detected via explicit headers
 * (Contents / TOC / Índice / Sumario / Tabla de contenidos) followed by
 * indented or numbered items. Different from outline (heading-derived).
 */
function buildTocBlock(files) {
  const engine = getToc();
  if (!engine || typeof engine.buildTocForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTocForFiles(list);
  return engine.renderTocBlock(report);
}

/**
 * HTML attrs block — referenced HTML attributes (inline values,
 * labeled mentions, aria-* / data-* / on*). Filtered by curated
 * whitelist. Routes "what HTML attributes are used?".
 */
function buildHtmlAttrsBlock(files) {
  const engine = getHtmlAttrs();
  if (!engine || typeof engine.buildHtmlAttrsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildHtmlAttrsForFiles(list);
  return engine.renderHtmlAttrsBlock(report);
}

/**
 * Blockquotes block — markdown blockquotes with optional "— Author"
 * attribution. Different from inline quote extractor. Routes
 * "what's the quote?" / "any pull quotes?".
 */
function buildBlockquotesBlock(files) {
  const engine = getBlockquotes();
  if (!engine || typeof engine.buildBlockquotesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildBlockquotesForFiles(list);
  return engine.renderBlockquotesBlock(report);
}

/**
 * Definition lists block — term/definition pairs (Markdown DL syntax
 * and HTML dt/dd mentions). Different from glossary extractor by
 * surfacing arbitrary pairs in any section.
 */
function buildDefinitionListsBlock(files) {
  const engine = getDefinitionLists();
  if (!engine || typeof engine.buildDefinitionListsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDefinitionListsForFiles(list);
  return engine.renderDefinitionListsBlock(report);
}

/**
 * TODO markers block — TODO/FIXME/NOTE/HACK/XXX/WIP/BUG with severity
 * classification and Spanish equivalents. Routes "what's pending?"
 * / "what needs fixing?".
 */
function buildTodosBlock(files) {
  const engine = getTodos();
  if (!engine || typeof engine.buildTodosForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTodosForFiles(list);
  return engine.renderTodosBlock(report);
}

/**
 * Images block — markdown / HTML images + emoji shortcodes with
 * alt-text accessibility status. Routes "what images?".
 */
function buildImagesBlock(files) {
  const engine = getImages();
  if (!engine || typeof engine.buildImagesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildImagesForFiles(list);
  return engine.renderImagesBlock(report);
}

/**
 * Media block — audio/video filenames, HTML5 audio/video tags,
 * timecodes, episode markers. Routes "what audio/video?".
 */
function buildMediaBlock(files) {
  const engine = getMedia();
  if (!engine || typeof engine.buildMediaForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMediaForFiles(list);
  return engine.renderMediaBlock(report);
}

/**
 * Language ratio block — per-document stopword-frequency language mix
 * across 6 languages (en/es/pt/fr/it/de). Routes "what languages?".
 */
function buildLanguageRatioBlock(files) {
  const engine = getLanguageRatio();
  if (!engine || typeof engine.buildLanguageRatioForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildLanguageRatioForFiles(list);
  return engine.renderLanguageRatioBlock(report);
}

/**
 * Regex patterns block — JS/Python/backtick regex literals. Routes
 * "what regex?" / "show me the patterns".
 */
function buildRegexPatternsBlock(files) {
  const engine = getRegexPatterns();
  if (!engine || typeof engine.buildRegexPatternsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildRegexPatternsForFiles(list);
  return engine.renderRegexPatternsBlock(report);
}

/**
 * File extensions block — distribution of file extensions by category
 * (code/doc/data/image/archive/media/web/config/other). Routes
 * "what file types?".
 */
function buildFileExtensionsBlock(files) {
  const engine = getFileExtensions();
  if (!engine || typeof engine.buildFileExtensionsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildFileExtensionsForFiles(list);
  return engine.renderFileExtensionsBlock(report);
}

/**
 * Code definitions block — function/class/type definitions across
 * JS/TS/Python/Go/Rust. Routes "what functions/classes?".
 */
function buildCodeDefsBlock(files) {
  const engine = getCodeDefs();
  if (!engine || typeof engine.buildCodeDefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCodeDefsForFiles(list);
  return engine.renderCodeDefsBlock(report);
}

/**
 * Tone polarity block — per-document positive/negative/neutral/mixed
 * scoring from a curated lexicon. Routes "what's the tone?".
 */
function buildTonePolarityBlock(files) {
  const engine = getTonePolarity();
  if (!engine || typeof engine.buildTonePolarityForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTonePolarityForFiles(list);
  return engine.renderTonePolarityBlock(report);
}

/**
 * Quantifiers block — universal / existential / negative / cardinal
 * propositional quantifiers. Routes "what's the scope?".
 */
function buildQuantifiersBlock(files) {
  const engine = getQuantifiers();
  if (!engine || typeof engine.buildQuantifiersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildQuantifiersForFiles(list);
  return engine.renderQuantifiersBlock(report);
}

/**
 * Modals block — modal verbs classified by normativity (strong /
 * recommended / permitted / possibility / prohibited).
 */
function buildModalsBlock(files) {
  const engine = getModals();
  if (!engine || typeof engine.buildModalsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildModalsForFiles(list);
  return engine.renderModalsBlock(report);
}

/**
 * Negation block — negation density + double-neg patterns.
 */
function buildNegationBlock(files) {
  const engine = getNegation();
  if (!engine || typeof engine.buildNegationForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildNegationForFiles(list);
  return engine.renderNegationBlock(report);
}

/**
 * Reading time block — per-file word/char count + reading time
 * at three WPM bands.
 */
function buildReadingTimeBlock(files) {
  const engine = getReadingTime();
  if (!engine || typeof engine.buildReadingTimeForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildReadingTimeForFiles(list);
  return engine.renderReadingTimeBlock(report);
}

/** Attributions block — "According to X" / "Per X" / "Según X" source phrases. */
function buildAttributionsBlock(files) {
  const engine = getAttributions();
  if (!engine || typeof engine.buildAttributionsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildAttributionsForFiles(list);
  return engine.renderAttributionsBlock(report);
}

/** Comparatives block — magnitude / percent / multiplier / vs / Spanish. */
function buildComparativesBlock(files) {
  const engine = getComparatives();
  if (!engine || typeof engine.buildComparativesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildComparativesForFiles(list);
  return engine.renderComparativesBlock(report);
}

/** Causal block — because/due to/owing to + Spanish equivalents. */
function buildCausalBlock(files) {
  const engine = getCausal();
  if (!engine || typeof engine.buildCausalForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCausalForFiles(list);
  return engine.renderCausalBlock(report);
}

/** Concession block — although/however/sin embargo/no obstante connectives. */
function buildConcessionBlock(files) {
  const engine = getConcession();
  if (!engine || typeof engine.buildConcessionForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildConcessionForFiles(list);
  return engine.renderConcessionBlock(report);
}

/** Hedging block — epistemic softeners (perhaps/possibly/quizás). */
function buildHedgingBlock(files) {
  const engine = getHedging();
  if (!engine || typeof engine.buildHedgingForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildHedgingForFiles(list);
  return engine.renderHedgingBlock(report);
}

/** Intensifiers block — very/extremely/muy/extremadamente. */
function buildIntensifiersBlock(files) {
  const engine = getIntensifiers();
  if (!engine || typeof engine.buildIntensifiersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildIntensifiersForFiles(list);
  return engine.renderIntensifiersBlock(report);
}

/** Reporting block — said/stated/dijo/afirmó verbs. */
function buildReportingBlock(files) {
  const engine = getReporting();
  if (!engine || typeof engine.buildReportingForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildReportingForFiles(list);
  return engine.renderReportingBlock(report);
}

/** Examples block — for example/e.g./por ejemplo/es decir. */
function buildExamplesBlock(files) {
  const engine = getExamples();
  if (!engine || typeof engine.buildExamplesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildExamplesForFiles(list);
  return engine.renderExamplesBlock(report);
}

/** Approximations block — about/roughly/aproximadamente hedges around numbers. */
function buildApproximationsBlock(files) {
  const engine = getApproximations();
  if (!engine || typeof engine.buildApproximationsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildApproximationsForFiles(list);
  return engine.renderApproximationsBlock(report);
}

/** Questions block — interrogative sentences classified by kind. */
function buildQuestionsBlock(files) {
  const engine = getQuestions();
  if (!engine || typeof engine.buildQuestionsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildQuestionsForFiles(list);
  return engine.renderQuestionsBlock(report);
}

/** Imperatives block — commands/instructions via verb whitelist. */
function buildImperativesBlock(files) {
  const engine = getImperatives();
  if (!engine || typeof engine.buildImperativesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildImperativesForFiles(list);
  return engine.renderImperativesBlock(report);
}

/** In-text definitions block — "X is Y" / "X means Y" patterns. */
function buildInTextDefinitionsBlock(files) {
  const engine = getDefinitions();
  if (!engine || typeof engine.buildDefinitionsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDefinitionsForFiles(list);
  return engine.renderDefinitionsBlock(report);
}

/** Fiscal year block — FY24/Q1/quarter markers. */
function buildFiscalYearBlock(files) {
  const engine = getFiscalYear();
  if (!engine || typeof engine.buildFiscalYearForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildFiscalYearForFiles(list);
  return engine.renderFiscalYearBlock(report);
}

/** Ratios block — 3:1 / "3 to 1" / X per Y / fractions. */
function buildRatiosBlock(files) {
  const engine = getRatios();
  if (!engine || typeof engine.buildRatiosForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildRatiosForFiles(list);
  return engine.renderRatiosBlock(report);
}

/** Ordinals block — 1st/first/primero/1º position markers. */
function buildOrdinalsBlock(files) {
  const engine = getOrdinals();
  if (!engine || typeof engine.buildOrdinalsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildOrdinalsForFiles(list);
  return engine.renderOrdinalsBlock(report);
}

/** Geographic regions block — continents/groupings/ISO/countries. */
function buildGeoRegionsBlock(files) {
  const engine = getGeoRegions();
  if (!engine || typeof engine.buildGeoRegionsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGeoRegionsForFiles(list);
  return engine.renderGeoRegionsBlock(report);
}

/** Tracking block — UPS/FedEx/USPS/DHL parcel codes + labeled forms. */
function buildTrackingBlock(files) {
  const engine = getTracking();
  if (!engine || typeof engine.buildTrackingForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTrackingForFiles(list);
  return engine.renderTrackingBlock(report);
}

/** Weather block — temperature/precipitation/wind/humidity/climate terms. */
function buildWeatherBlock(files) {
  const engine = getWeather();
  if (!engine || typeof engine.buildWeatherForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildWeatherForFiles(list);
  return engine.renderWeatherBlock(report);
}

/** Scientific notation block — E-notation, ×10^, superscript power-of-ten. */
function buildScientificNotationBlock(files) {
  const engine = getScientificNotation();
  if (!engine || typeof engine.buildScientificNotationForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildScientificNotationForFiles(list);
  return engine.renderScientificNotationBlock(report);
}

/** Taxa block — Linnaean binomial nomenclature + family taxa. */
function buildTaxaBlock(files) {
  const engine = getTaxa();
  if (!engine || typeof engine.buildTaxaForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTaxaForFiles(list);
  return engine.renderTaxaBlock(report);
}

/** Chemistry block — molecular formulas + element names. */
function buildChemistryBlock(files) {
  const engine = getChemistry();
  if (!engine || typeof engine.buildChemistryForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildChemistryForFiles(list);
  return engine.renderChemistryBlock(report);
}

/** FX rates block — currency pair rates + equation + labeled. */
function buildFxRatesBlock(files) {
  const engine = getFxRates();
  if (!engine || typeof engine.buildFxRatesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildFxRatesForFiles(list);
  return engine.renderFxRatesBlock(report);
}

/** IBAN/SWIFT block — international banking codes. */
function buildIbanSwiftBlock(files) {
  const engine = getIbanSwift();
  if (!engine || typeof engine.buildIbanSwiftForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildIbanSwiftForFiles(list);
  return engine.renderIbanSwiftBlock(report);
}

/** License plates block — US/UK/MX/ES/labeled vehicle plates. */
function buildLicensePlatesBlock(files) {
  const engine = getLicensePlates();
  if (!engine || typeof engine.buildLicensePlatesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildLicensePlatesForFiles(list);
  return engine.renderLicensePlatesBlock(report);
}

/** Legal citations block — Smith v Jones / reporter / USC / CFR / Ley. */
function buildLegalCitationsBlock(files) {
  const engine = getLegalCitations();
  if (!engine || typeof engine.buildLegalCitationsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildLegalCitationsForFiles(list);
  return engine.renderLegalCitationsBlock(report);
}

/** Social URLs block — twitter/instagram/linkedin/github/youtube/tiktok handles. */
function buildSocialUrlsBlock(files) {
  const engine = getSocialUrls();
  if (!engine || typeof engine.buildSocialUrlsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSocialUrlsForFiles(list);
  return engine.renderSocialUrlsBlock(report);
}

/** Gene/protein block — HGNC genes + p-proteins + mRNA + ENST + UniProt + rsIDs. */
function buildGeneProteinBlock(files) {
  const engine = getGeneProtein();
  if (!engine || typeof engine.buildGeneProteinForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGeneProteinForFiles(list);
  return engine.renderGeneProteinBlock(report);
}

/** Currency symbols block — standalone €/$/£/¥/₹/₿ without amount. */
function buildCurrencySymbolsBlock(files) {
  const engine = getCurrencySymbols();
  if (!engine || typeof engine.buildCurrencySymbolsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCurrencySymbolsForFiles(list);
  return engine.renderCurrencySymbolsBlock(report);
}

/** Phone codes block — E.164 phone numbers with country resolution. */
function buildPhoneCodesBlock(files) {
  const engine = getPhoneCodes();
  if (!engine || typeof engine.buildPhoneCodesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPhoneCodesForFiles(list);
  return engine.renderPhoneCodesBlock(report);
}

/** Postal codes block — UK/CA/BR/JP/US/labeled postal codes. */
function buildPostalCodesBlock(files) {
  const engine = getPostalCodes();
  if (!engine || typeof engine.buildPostalCodesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPostalCodesForFiles(list);
  return engine.renderPostalCodesBlock(report);
}

/** Addresses block — street addresses (US/Spanish/PO Box/labeled). */
function buildAddressesBlock(files) {
  const engine = getAddresses();
  if (!engine || typeof engine.buildAddressesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildAddressesForFiles(list);
  return engine.renderAddressesBlock(report);
}

/** MIME types block — IANA Media-Type references. */
function buildMimeTypesBlock(files) {
  const engine = getMimeTypes();
  if (!engine || typeof engine.buildMimeTypesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMimeTypesForFiles(list);
  return engine.renderMimeTypesBlock(report);
}

/** UTM params block — utm_source/medium/campaign/term/content/id. */
function buildUtmParamsBlock(files) {
  const engine = getUtmParams();
  if (!engine || typeof engine.buildUtmParamsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildUtmParamsForFiles(list);
  return engine.renderUtmParamsBlock(report);
}

/** Credit cards block — masked Visa/MC/Amex/Discover/JCB/Diners. */
function buildCreditCardsBlock(files) {
  const engine = getCreditCards();
  if (!engine || typeof engine.buildCreditCardsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCreditCardsForFiles(list);
  return engine.renderCreditCardsBlock(report);
}

/** SSN-style PII block — masked US/MX/ES/CA/UK/BR national IDs. */
function buildSsnPiiBlock(files) {
  const engine = getSsnPii();
  if (!engine || typeof engine.buildSsnPiiForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSsnPiiForFiles(list);
  return engine.renderSsnPiiBlock(report);
}

/** API keys block — masked OpenAI/GitHub/AWS/Stripe/Slack/Bearer/JWT. */
function buildApiKeysBlock(files) {
  const engine = getApiKeys();
  if (!engine || typeof engine.buildApiKeysForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildApiKeysForFiles(list);
  return engine.renderApiKeysBlock(report);
}

/** HTTP methods census block — aggregate counts of GET/POST/PUT/PATCH/DELETE. */
function buildHttpMethodsBlock(files) {
  const engine = getHttpMethods();
  if (!engine || typeof engine.buildHttpMethodsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildHttpMethodsForFiles(list);
  return engine.renderHttpMethodsBlock(report);
}

/** Container refs block — registry/digest/plain image:tag references. */
function buildContainerRefsBlock(files) {
  const engine = getContainerRefs();
  if (!engine || typeof engine.buildContainerRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildContainerRefsForFiles(list);
  return engine.renderContainerRefsBlock(report);
}

/** K8s refs block — apiVersion/kind/namespace/kubectl command refs. */
function buildK8sRefsBlock(files) {
  const engine = getK8sRefs();
  if (!engine || typeof engine.buildK8sRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildK8sRefsForFiles(list);
  return engine.renderK8sRefsBlock(report);
}

/** Metrics block — Prometheus-style metric names with type classification. */
function buildMetricsBlock(files) {
  const engine = getMetrics();
  if (!engine || typeof engine.buildMetricsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMetricsForFiles(list);
  return engine.renderMetricsBlock(report);
}

function buildOauthScopesBlock(files) {
  const engine = getOauthScopes();
  if (!engine || typeof engine.buildOauthScopesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildOauthScopesForFiles(list);
  return engine.renderOauthScopesBlock(report);
}

function buildCspDirectivesBlock(files) {
  const engine = getCspDirectives();
  if (!engine || typeof engine.buildCspDirectivesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCspDirectivesForFiles(list);
  return engine.renderCspDirectivesBlock(report);
}

function buildMathOperatorsBlock(files) {
  const engine = getMathOperators();
  if (!engine || typeof engine.buildMathOperatorsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMathOperatorsForFiles(list);
  return engine.renderMathOperatorsBlock(report);
}

function buildSpdxComplexBlock(files) {
  const engine = getSpdxComplex();
  if (!engine || typeof engine.buildSpdxComplexForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSpdxComplexForFiles(list);
  return engine.renderSpdxComplexBlock(report);
}

function buildFeatureFlagsBlock(files) {
  const engine = getFeatureFlags();
  if (!engine || typeof engine.buildFeatureFlagsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildFeatureFlagsForFiles(list);
  return engine.renderFeatureFlagsBlock(report);
}

function buildCookieAttrsBlock(files) {
  const engine = getCookieAttrs();
  if (!engine || typeof engine.buildCookieAttrsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCookieAttrsForFiles(list);
  return engine.renderCookieAttrsBlock(report);
}

function buildOtelTraceBlock(files) {
  const engine = getOtelTrace();
  if (!engine || typeof engine.buildOtelTraceForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildOtelTraceForFiles(list);
  return engine.renderOtelTraceBlock(report);
}

function buildCloudArnsBlock(files) {
  const engine = getCloudArns();
  if (!engine || typeof engine.buildCloudArnsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCloudArnsForFiles(list);
  return engine.renderCloudArnsBlock(report);
}

function buildMlModelsBlock(files) {
  const engine = getMlModels();
  if (!engine || typeof engine.buildMlModelsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMlModelsForFiles(list);
  return engine.renderMlModelsBlock(report);
}

function buildDbConnStringsBlock(files) {
  const engine = getDbConnStrings();
  if (!engine || typeof engine.buildDbConnStringsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDbConnStringsForFiles(list);
  return engine.renderDbConnStringsBlock(report);
}

function buildGraphqlOpsBlock(files) {
  const engine = getGraphqlOps();
  if (!engine || typeof engine.buildGraphqlOpsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGraphqlOpsForFiles(list);
  return engine.renderGraphqlOpsBlock(report);
}

function buildGrpcRefsBlock(files) {
  const engine = getGrpcRefs();
  if (!engine || typeof engine.buildGrpcRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGrpcRefsForFiles(list);
  return engine.renderGrpcRefsBlock(report);
}

function buildStackTracesBlock(files) {
  const engine = getStackTraces();
  if (!engine || typeof engine.buildStackTracesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildStackTracesForFiles(list);
  return engine.renderStackTracesBlock(report);
}

function buildEnvNamesBlock(files) {
  const engine = getEnvNames();
  if (!engine || typeof engine.buildEnvNamesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildEnvNamesForFiles(list);
  return engine.renderEnvNamesBlock(report);
}

function buildTestBlocksBlock(files) {
  const engine = getTestBlocks();
  if (!engine || typeof engine.buildTestBlocksForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTestBlocksForFiles(list);
  return engine.renderTestBlocksBlock(report);
}

function buildGitShasBlock(files) {
  const engine = getGitShas();
  if (!engine || typeof engine.buildGitShasForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGitShasForFiles(list);
  return engine.renderGitShasBlock(report);
}

function buildCloudStorageBlock(files) {
  const engine = getCloudStorage();
  if (!engine || typeof engine.buildCloudStorageForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCloudStorageForFiles(list);
  return engine.renderCloudStorageBlock(report);
}

function buildWebVitalsBlock(files) {
  const engine = getWebVitals();
  if (!engine || typeof engine.buildWebVitalsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildWebVitalsForFiles(list);
  return engine.renderWebVitalsBlock(report);
}

function buildAriaA11yBlock(files) {
  const engine = getAriaA11y();
  if (!engine || typeof engine.buildAriaA11yForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildAriaA11yForFiles(list);
  return engine.renderAriaA11yBlock(report);
}

function buildI18nKeysBlock(files) {
  const engine = getI18nKeys();
  if (!engine || typeof engine.buildI18nKeysForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildI18nKeysForFiles(list);
  return engine.renderI18nKeysBlock(report);
}

function buildCiBuildIdsBlock(files) {
  const engine = getCiBuildIds();
  if (!engine || typeof engine.buildCiBuildIdsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCiBuildIdsForFiles(list);
  return engine.renderCiBuildIdsBlock(report);
}

function buildUserAgentsBlock(files) {
  const engine = getUserAgents();
  if (!engine || typeof engine.buildUserAgentsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildUserAgentsForFiles(list);
  return engine.renderUserAgentsBlock(report);
}

function buildCidrRangesBlock(files) {
  const engine = getCidrRanges();
  if (!engine || typeof engine.buildCidrRangesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCidrRangesForFiles(list);
  return engine.renderCidrRangesBlock(report);
}

function buildCacheHeadersBlock(files) {
  const engine = getCacheHeaders();
  if (!engine || typeof engine.buildCacheHeadersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCacheHeadersForFiles(list);
  return engine.renderCacheHeadersBlock(report);
}

function buildGithubRefsBlock(files) {
  const engine = getGithubRefs();
  if (!engine || typeof engine.buildGithubRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGithubRefsForFiles(list);
  return engine.renderGithubRefsBlock(report);
}

function buildApmRefsBlock(files) {
  const engine = getApmRefs();
  if (!engine || typeof engine.buildApmRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildApmRefsForFiles(list);
  return engine.renderApmRefsBlock(report);
}

function buildAttackPatternsBlock(files) {
  const engine = getAttackPatterns();
  if (!engine || typeof engine.buildAttackPatternsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildAttackPatternsForFiles(list);
  return engine.renderAttackPatternsBlock(report);
}

function buildWebhookUrlsBlock(files) {
  const engine = getWebhookUrls();
  if (!engine || typeof engine.buildWebhookUrlsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildWebhookUrlsForFiles(list);
  return engine.renderWebhookUrlsBlock(report);
}

function buildSshFingerprintsBlock(files) {
  const engine = getSshFingerprints();
  if (!engine || typeof engine.buildSshFingerprintsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSshFingerprintsForFiles(list);
  return engine.renderSshFingerprintsBlock(report);
}

function buildNpmRefsBlock(files) {
  const engine = getNpmRefs();
  if (!engine || typeof engine.buildNpmRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildNpmRefsForFiles(list);
  return engine.renderNpmRefsBlock(report);
}

function buildCorrelationIdsBlock(files) {
  const engine = getCorrelationIds();
  if (!engine || typeof engine.buildCorrelationIdsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCorrelationIdsForFiles(list);
  return engine.renderCorrelationIdsBlock(report);
}

function buildPaymentIdsBlock(files) {
  const engine = getPaymentIds();
  if (!engine || typeof engine.buildPaymentIdsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPaymentIdsForFiles(list);
  return engine.renderPaymentIdsBlock(report);
}

function buildEmailHeadersBlock(files) {
  const engine = getEmailHeaders();
  if (!engine || typeof engine.buildEmailHeadersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildEmailHeadersForFiles(list);
  return engine.renderEmailHeadersBlock(report);
}

function buildIcalEventsBlock(files) {
  const engine = getIcalEvents();
  if (!engine || typeof engine.buildIcalEventsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildIcalEventsForFiles(list);
  return engine.renderIcalEventsBlock(report);
}

function buildFrontmatterBlock(files) {
  const engine = getFrontmatter();
  if (!engine || typeof engine.buildFrontmatterForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildFrontmatterForFiles(list);
  return engine.renderFrontmatterBlock(report);
}

function buildPullQuotesBlock(files) {
  const engine = getPullQuotes();
  if (!engine || typeof engine.buildPullQuotesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPullQuotesForFiles(list);
  return engine.renderPullQuotesBlock(report);
}

function buildGhaStepsBlock(files) {
  const engine = getGhaSteps();
  if (!engine || typeof engine.buildGhaStepsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGhaStepsForFiles(list);
  return engine.renderGhaStepsBlock(report);
}

function buildTerraformRefsBlock(files) {
  const engine = getTerraformRefs();
  if (!engine || typeof engine.buildTerraformRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTerraformRefsForFiles(list);
  return engine.renderTerraformRefsBlock(report);
}

function buildHelmRefsBlock(files) {
  const engine = getHelmRefs();
  if (!engine || typeof engine.buildHelmRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildHelmRefsForFiles(list);
  return engine.renderHelmRefsBlock(report);
}

function buildNaturalSchedulesBlock(files) {
  const engine = getNaturalSchedules();
  if (!engine || typeof engine.buildNaturalSchedulesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildNaturalSchedulesForFiles(list);
  return engine.renderNaturalSchedulesBlock(report);
}

function buildChatPermalinksBlock(files) {
  const engine = getChatPermalinks();
  if (!engine || typeof engine.buildChatPermalinksForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildChatPermalinksForFiles(list);
  return engine.renderChatPermalinksBlock(report);
}

function buildPmTicketsBlock(files) {
  const engine = getPmTickets();
  if (!engine || typeof engine.buildPmTicketsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPmTicketsForFiles(list);
  return engine.renderPmTicketsBlock(report);
}

function buildSlaTargetsBlock(files) {
  const engine = getSlaTargets();
  if (!engine || typeof engine.buildSlaTargetsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSlaTargetsForFiles(list);
  return engine.renderSlaTargetsBlock(report);
}

function buildTldsBlock(files) {
  const engine = getTlds();
  if (!engine || typeof engine.buildTldsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTldsForFiles(list);
  return engine.renderTldsBlock(report);
}

function buildStockTickersBlock(files) {
  const engine = getStockTickers();
  if (!engine || typeof engine.buildStockTickersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildStockTickersForFiles(list);
  return engine.renderStockTickersBlock(report);
}

function buildHardwareSpecsBlock(files) {
  const engine = getHardwareSpecs();
  if (!engine || typeof engine.buildHardwareSpecsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildHardwareSpecsForFiles(list);
  return engine.renderHardwareSpecsBlock(report);
}

function buildBandwidthUnitsBlock(files) {
  const engine = getBandwidthUnits();
  if (!engine || typeof engine.buildBandwidthUnitsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildBandwidthUnitsForFiles(list);
  return engine.renderBandwidthUnitsBlock(report);
}

function buildTrackingNumbersBlock(files) {
  const engine = getTrackingNumbers();
  if (!engine || typeof engine.buildTrackingNumbersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTrackingNumbersForFiles(list);
  return engine.renderTrackingNumbersBlock(report);
}

function buildRateLimitHeadersBlock(files) {
  const engine = getRateLimitHeaders();
  if (!engine || typeof engine.buildRateLimitHeadersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildRateLimitHeadersForFiles(list);
  return engine.renderRateLimitHeadersBlock(report);
}

function buildCryptoWalletsBlock(files) {
  const engine = getCryptoWallets();
  if (!engine || typeof engine.buildCryptoWalletsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCryptoWalletsForFiles(list);
  return engine.renderCryptoWalletsBlock(report);
}

function buildCveIdsBlock(files) {
  const engine = getCveIds();
  if (!engine || typeof engine.buildCveIdsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCveIdsForFiles(list);
  return engine.renderCveIdsBlock(report);
}

function buildMediaTimestampsBlock(files) {
  const engine = getMediaTimestamps();
  if (!engine || typeof engine.buildMediaTimestampsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMediaTimestampsForFiles(list);
  return engine.renderMediaTimestampsBlock(report);
}

function buildLinuxSignalsBlock(files) {
  const engine = getLinuxSignals();
  if (!engine || typeof engine.buildLinuxSignalsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildLinuxSignalsForFiles(list);
  return engine.renderLinuxSignalsBlock(report);
}

function buildExitCodesBlock(files) {
  const engine = getExitCodes();
  if (!engine || typeof engine.buildExitCodesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildExitCodesForFiles(list);
  return engine.renderExitCodesBlock(report);
}

function buildNetworkPortsBlock(files) {
  const engine = getNetworkPorts();
  if (!engine || typeof engine.buildNetworkPortsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildNetworkPortsForFiles(list);
  return engine.renderNetworkPortsBlock(report);
}

function buildLinuxDistrosBlock(files) {
  const engine = getLinuxDistros();
  if (!engine || typeof engine.buildLinuxDistrosForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildLinuxDistrosForFiles(list);
  return engine.renderLinuxDistrosBlock(report);
}

function buildLifecyclePhasesBlock(files) {
  const engine = getLifecyclePhases();
  if (!engine || typeof engine.buildLifecyclePhasesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildLifecyclePhasesForFiles(list);
  return engine.renderLifecyclePhasesBlock(report);
}

function buildProjectCodenamesBlock(files) {
  const engine = getProjectCodenames();
  if (!engine || typeof engine.buildProjectCodenamesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildProjectCodenamesForFiles(list);
  return engine.renderProjectCodenamesBlock(report);
}

function buildRiskLevelsBlock(files) {
  const engine = getRiskLevels();
  if (!engine || typeof engine.buildRiskLevelsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildRiskLevelsForFiles(list);
  return engine.renderRiskLevelsBlock(report);
}

function buildSaasMetricsBlock(files) {
  const engine = getSaasMetrics();
  if (!engine || typeof engine.buildSaasMetricsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSaasMetricsForFiles(list);
  return engine.renderSaasMetricsBlock(report);
}

function buildRecipeMeasurementsBlock(files) {
  const engine = getRecipeMeasurements();
  if (!engine || typeof engine.buildRecipeMeasurementsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildRecipeMeasurementsForFiles(list);
  return engine.renderRecipeMeasurementsBlock(report);
}

function buildIsoLangsBlock(files) {
  const engine = getIsoLangs();
  if (!engine || typeof engine.buildIsoLangsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildIsoLangsForFiles(list);
  return engine.renderIsoLangsBlock(report);
}

function buildPrReviewStatesBlock(files) {
  const engine = getPrReviewStates();
  if (!engine || typeof engine.buildPrReviewStatesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPrReviewStatesForFiles(list);
  return engine.renderPrReviewStatesBlock(report);
}

function buildPricingTiersBlock(files) {
  const engine = getPricingTiers();
  if (!engine || typeof engine.buildPricingTiersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPricingTiersForFiles(list);
  return engine.renderPricingTiersBlock(report);
}

function buildArxivIdsBlock(files) {
  const engine = getArxivIds();
  if (!engine || typeof engine.buildArxivIdsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildArxivIdsForFiles(list);
  return engine.renderArxivIdsBlock(report);
}

function buildDoiIdsBlock(files) {
  const engine = getDoiIds();
  if (!engine || typeof engine.buildDoiIdsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDoiIdsForFiles(list);
  return engine.renderDoiIdsBlock(report);
}

function buildOrcidIdsBlock(files) {
  const engine = getOrcidIds();
  if (!engine || typeof engine.buildOrcidIdsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildOrcidIdsForFiles(list);
  return engine.renderOrcidIdsBlock(report);
}

function buildWikiRefsBlock(files) {
  const engine = getWikiRefs();
  if (!engine || typeof engine.buildWikiRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildWikiRefsForFiles(list);
  return engine.renderWikiRefsBlock(report);
}

function buildPubmedIdsBlock(files) {
  const engine = getPubmedIds();
  if (!engine || typeof engine.buildPubmedIdsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPubmedIdsForFiles(list);
  return engine.renderPubmedIdsBlock(report);
}

function buildServiceAccountsBlock(files) {
  const engine = getServiceAccounts();
  if (!engine || typeof engine.buildServiceAccountsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildServiceAccountsForFiles(list);
  return engine.renderServiceAccountsBlock(report);
}

function buildVinNumbersBlock(files) {
  const engine = getVinNumbers();
  if (!engine || typeof engine.buildVinNumbersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildVinNumbersForFiles(list);
  return engine.renderVinNumbersBlock(report);
}

function buildEmojiShortcodesBlock(files) {
  const engine = getEmojiShortcodes();
  if (!engine || typeof engine.buildEmojiShortcodesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildEmojiShortcodesForFiles(list);
  return engine.renderEmojiShortcodesBlock(report);
}

function buildBibtexEntriesBlock(files) {
  const engine = getBibtexEntries();
  if (!engine || typeof engine.buildBibtexEntriesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildBibtexEntriesForFiles(list);
  return engine.renderBibtexEntriesBlock(report);
}

function buildLatexCommandsBlock(files) {
  const engine = getLatexCommands();
  if (!engine || typeof engine.buildLatexCommandsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildLatexCommandsForFiles(list);
  return engine.renderLatexCommandsBlock(report);
}

function buildProgLangsBlock(files) {
  const engine = getProgLangs();
  if (!engine || typeof engine.buildProgLangsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildProgLangsForFiles(list);
  return engine.renderProgLangsBlock(report);
}

function buildComplianceRefsBlock(files) {
  const engine = getComplianceRefs();
  if (!engine || typeof engine.buildComplianceRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildComplianceRefsForFiles(list);
  return engine.renderComplianceRefsBlock(report);
}

function buildTlsCiphersBlock(files) {
  const engine = getTlsCiphers();
  if (!engine || typeof engine.buildTlsCiphersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTlsCiphersForFiles(list);
  return engine.renderTlsCiphersBlock(report);
}

function buildDnsRecordsBlock(files) {
  const engine = getDnsRecords();
  if (!engine || typeof engine.buildDnsRecordsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDnsRecordsForFiles(list);
  return engine.renderDnsRecordsBlock(report);
}

function buildEmailAuthBlock(files) {
  const engine = getEmailAuth();
  if (!engine || typeof engine.buildEmailAuthForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildEmailAuthForFiles(list);
  return engine.renderEmailAuthBlock(report);
}

function buildOpenapiKeysBlock(files) {
  const engine = getOpenapiKeys();
  if (!engine || typeof engine.buildOpenapiKeysForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildOpenapiKeysForFiles(list);
  return engine.renderOpenapiKeysBlock(report);
}

function buildKafkaRefsBlock(files) {
  const engine = getKafkaRefs();
  if (!engine || typeof engine.buildKafkaRefsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildKafkaRefsForFiles(list);
  return engine.renderKafkaRefsBlock(report);
}

function buildAnsiEscapesBlock(files) {
  const engine = getAnsiEscapes();
  if (!engine || typeof engine.buildAnsiEscapesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildAnsiEscapesForFiles(list);
  return engine.renderAnsiEscapesBlock(report);
}

function buildSqlWindowsBlock(files) {
  const engine = getSqlWindows();
  if (!engine || typeof engine.buildSqlWindowsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSqlWindowsForFiles(list);
  return engine.renderSqlWindowsBlock(report);
}

function buildWebsocketMarkersBlock(files) {
  const engine = getWebsocketMarkers();
  if (!engine || typeof engine.buildWebsocketMarkersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildWebsocketMarkersForFiles(list);
  return engine.renderWebsocketMarkersBlock(report);
}

function buildIsoDurationsBlock(files) {
  const engine = getIsoDurations();
  if (!engine || typeof engine.buildIsoDurationsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildIsoDurationsForFiles(list);
  return engine.renderIsoDurationsBlock(report);
}

function buildBrowserSupportBlock(files) {
  const engine = getBrowserSupport();
  if (!engine || typeof engine.buildBrowserSupportForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildBrowserSupportForFiles(list);
  return engine.renderBrowserSupportBlock(report);
}

function buildNumberBasesBlock(files) {
  const engine = getNumberBases();
  if (!engine || typeof engine.buildNumberBasesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildNumberBasesForFiles(list);
  return engine.renderNumberBasesBlock(report);
}

function buildDmsCoordsBlock(files) {
  const engine = getDmsCoords();
  if (!engine || typeof engine.buildDmsCoordsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDmsCoordsForFiles(list);
  return engine.renderDmsCoordsBlock(report);
}

function buildContainerRegistriesBlock(files) {
  const engine = getContainerRegistries();
  if (!engine || typeof engine.buildContainerRegistriesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildContainerRegistriesForFiles(list);
  return engine.renderContainerRegistriesBlock(report);
}

function buildWktGeometryBlock(files) {
  const engine = getWktGeometry();
  if (!engine || typeof engine.buildWktGeometryForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildWktGeometryForFiles(list);
  return engine.renderWktGeometryBlock(report);
}

function buildMdRefLinksBlock(files) {
  const engine = getMdRefLinks();
  if (!engine || typeof engine.buildMdRefLinksForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMdRefLinksForFiles(list);
  return engine.renderMdRefLinksBlock(report);
}

function buildBotTokensBlock(files) {
  const engine = getBotTokens();
  if (!engine || typeof engine.buildBotTokensForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildBotTokensForFiles(list);
  return engine.renderBotTokensBlock(report);
}

function buildCargoPackagesBlock(files) {
  const engine = getCargoPackages();
  if (!engine || typeof engine.buildCargoPackagesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCargoPackagesForFiles(list);
  return engine.renderCargoPackagesBlock(report);
}

function buildGoModulesBlock(files) {
  const engine = getGoModules();
  if (!engine || typeof engine.buildGoModulesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGoModulesForFiles(list);
  return engine.renderGoModulesBlock(report);
}

function buildMavenCoordsBlock(files) {
  const engine = getMavenCoords();
  if (!engine || typeof engine.buildMavenCoordsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMavenCoordsForFiles(list);
  return engine.renderMavenCoordsBlock(report);
}

function buildPipReqsBlock(files) {
  const engine = getPipReqs();
  if (!engine || typeof engine.buildPipReqsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPipReqsForFiles(list);
  return engine.renderPipReqsBlock(report);
}

function buildComposerPkgsBlock(files) {
  const engine = getComposerPkgs();
  if (!engine || typeof engine.buildComposerPkgsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildComposerPkgsForFiles(list);
  return engine.renderComposerPkgsBlock(report);
}

function buildNugetPkgsBlock(files) {
  const engine = getNugetPkgs();
  if (!engine || typeof engine.buildNugetPkgsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildNugetPkgsForFiles(list);
  return engine.renderNugetPkgsBlock(report);
}

function buildGemPkgsBlock(files) {
  const engine = getGemPkgs();
  if (!engine || typeof engine.buildGemPkgsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGemPkgsForFiles(list);
  return engine.renderGemPkgsBlock(report);
}

function buildHexPkgsBlock(files) {
  const engine = getHexPkgs();
  if (!engine || typeof engine.buildHexPkgsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildHexPkgsForFiles(list);
  return engine.renderHexPkgsBlock(report);
}

function buildSvgPathCmdsBlock(files) {
  const engine = getSvgPathCmds();
  if (!engine || typeof engine.buildSvgPathCmdsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSvgPathCmdsForFiles(list);
  return engine.renderSvgPathCmdsBlock(report);
}

function buildGeojsonBlock(files) {
  const engine = getGeojson();
  if (!engine || typeof engine.buildGeojsonForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGeojsonForFiles(list);
  return engine.renderGeojsonBlock(report);
}

function buildPwaManifestBlock(files) {
  const engine = getPwaManifest();
  if (!engine || typeof engine.buildPwaManifestForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPwaManifestForFiles(list);
  return engine.renderPwaManifestBlock(report);
}

function buildPermissionsApiBlock(files) {
  const engine = getPermissionsApi();
  if (!engine || typeof engine.buildPermissionsApiForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPermissionsApiForFiles(list);
  return engine.renderPermissionsApiBlock(report);
}

function buildServerlessFnsBlock(files) {
  const engine = getServerlessFns();
  if (!engine || typeof engine.buildServerlessFnsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildServerlessFnsForFiles(list);
  return engine.renderServerlessFnsBlock(report);
}

function buildDbMigrationsBlock(files) {
  const engine = getDbMigrations();
  if (!engine || typeof engine.buildDbMigrationsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildDbMigrationsForFiles(list);
  return engine.renderDbMigrationsBlock(report);
}

function buildEslintRulesBlock(files) {
  const engine = getEslintRules();
  if (!engine || typeof engine.buildEslintRulesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildEslintRulesForFiles(list);
  return engine.renderEslintRulesBlock(report);
}

function buildBuildToolsBlock(files) {
  const engine = getBuildTools();
  if (!engine || typeof engine.buildBuildToolsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildBuildToolsForFiles(list);
  return engine.renderBuildToolsBlock(report);
}

function buildJwtClaimsBlock(files) {
  const engine = getJwtClaims();
  if (!engine || typeof engine.buildJwtClaimsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildJwtClaimsForFiles(list);
  return engine.renderJwtClaimsBlock(report);
}

function buildSriHashesBlock(files) {
  const engine = getSriHashes();
  if (!engine || typeof engine.buildSriHashesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSriHashesForFiles(list);
  return engine.renderSriHashesBlock(report);
}

function buildJsonSchemaBlock(files) {
  const engine = getJsonSchema();
  if (!engine || typeof engine.buildJsonSchemaForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildJsonSchemaForFiles(list);
  return engine.renderJsonSchemaBlock(report);
}

function buildPrismaSchemaBlock(files) {
  const engine = getPrismaSchema();
  if (!engine || typeof engine.buildPrismaSchemaForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPrismaSchemaForFiles(list);
  return engine.renderPrismaSchemaBlock(report);
}

function buildGraphqlFragmentsBlock(files) {
  const engine = getGraphqlFragments();
  if (!engine || typeof engine.buildGraphqlFragmentsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGraphqlFragmentsForFiles(list);
  return engine.renderGraphqlFragmentsBlock(report);
}

function buildCssVarsBlock(files) {
  const engine = getCssVars();
  if (!engine || typeof engine.buildCssVarsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCssVarsForFiles(list);
  return engine.renderCssVarsBlock(report);
}

function buildComposeServicesBlock(files) {
  const engine = getComposeServices();
  if (!engine || typeof engine.buildComposeServicesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildComposeServicesForFiles(list);
  return engine.renderComposeServicesBlock(report);
}

function buildRegexFlagsBlock(files) {
  const engine = getRegexFlags();
  if (!engine || typeof engine.buildRegexFlagsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildRegexFlagsForFiles(list);
  return engine.renderRegexFlagsBlock(report);
}

function buildVueSfcBlock(files) {
  const engine = getVueSfc();
  if (!engine || typeof engine.buildVueSfcForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildVueSfcForFiles(list);
  return engine.renderVueSfcBlock(report);
}

function buildAstroBlock(files) {
  const engine = getAstro();
  if (!engine || typeof engine.buildAstroForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildAstroForFiles(list);
  return engine.renderAstroBlock(report);
}

function buildE2eTestsBlock(files) {
  const engine = getE2eTests();
  if (!engine || typeof engine.buildE2eTestsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildE2eTestsForFiles(list);
  return engine.renderE2eTestsBlock(report);
}

function buildMswHandlersBlock(files) {
  const engine = getMswHandlers();
  if (!engine || typeof engine.buildMswHandlersForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMswHandlersForFiles(list);
  return engine.renderMswHandlersBlock(report);
}

function buildGhWorkflowsBlock(files) {
  const engine = getGhWorkflows();
  if (!engine || typeof engine.buildGhWorkflowsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGhWorkflowsForFiles(list);
  return engine.renderGhWorkflowsBlock(report);
}

function buildJsonLdBlock(files) {
  const engine = getJsonLd();
  if (!engine || typeof engine.buildJsonLdForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildJsonLdForFiles(list);
  return engine.renderJsonLdBlock(report);
}

function buildTailwindBlock(files) {
  const engine = getTailwind();
  if (!engine || typeof engine.buildTailwindForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTailwindForFiles(list);
  return engine.renderTailwindBlock(report);
}

function buildMongoAggBlock(files) {
  const engine = getMongoAgg();
  if (!engine || typeof engine.buildMongoAggForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMongoAggForFiles(list);
  return engine.renderMongoAggBlock(report);
}

function buildHelmBlock(files) {
  const engine = getHelm();
  if (!engine || typeof engine.buildHelmForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildHelmForFiles(list);
  return engine.renderHelmBlock(report);
}

function buildVitestBlock(files) {
  const engine = getVitest();
  if (!engine || typeof engine.buildVitestForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildVitestForFiles(list);
  return engine.renderVitestBlock(report);
}

function buildMjmlBlock(files) {
  const engine = getMjml();
  if (!engine || typeof engine.buildMjmlForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildMjmlForFiles(list);
  return engine.renderMjmlBlock(report);
}

function buildStripeBlock(files) {
  const engine = getStripe();
  if (!engine || typeof engine.buildStripeForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildStripeForFiles(list);
  return engine.renderStripeBlock(report);
}

function buildTerraformVarsBlock(files) {
  const engine = getTerraformVars();
  if (!engine || typeof engine.buildTerraformVarsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildTerraformVarsForFiles(list);
  return engine.renderTerraformVarsBlock(report);
}

function buildOpenapiSecurityBlock(files) {
  const engine = getOpenapiSecurity();
  if (!engine || typeof engine.buildOpenapiSecurityForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildOpenapiSecurityForFiles(list);
  return engine.renderOpenapiSecurityBlock(report);
}

function buildK8sResourcesBlock(files) {
  const engine = getK8sResources();
  if (!engine || typeof engine.buildK8sResourcesForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildK8sResourcesForFiles(list);
  return engine.renderK8sResourcesBlock(report);
}

function buildCssAnimBlock(files) {
  const engine = getCssAnim();
  if (!engine || typeof engine.buildCssAnimForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildCssAnimForFiles(list);
  return engine.renderCssAnimBlock(report);
}

function buildStorybookBlock(files) {
  const engine = getStorybook();
  if (!engine || typeof engine.buildStorybookForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildStorybookForFiles(list);
  return engine.renderStorybookBlock(report);
}

function buildSentryBlock(files) {
  const engine = getSentry();
  if (!engine || typeof engine.buildSentryForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildSentryForFiles(list);
  return engine.renderSentryBlock(report);
}

function buildNatsBlock(files) {
  const engine = getNats();
  if (!engine || typeof engine.buildNatsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildNatsForFiles(list);
  return engine.renderNatsBlock(report);
}

function buildPkgJsonBlock(files) {
  const engine = getPkgJson();
  if (!engine || typeof engine.buildPkgJsonForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPkgJsonForFiles(list);
  return engine.renderPkgJsonBlock(report);
}

function buildRedisBlock(files) {
  const engine = getRedis();
  if (!engine || typeof engine.buildRedisForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildRedisForFiles(list);
  return engine.renderRedisBlock(report);
}

function buildNginxBlock(files) {
  const engine = getNginx();
  if (!engine || typeof engine.buildNginxForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildNginxForFiles(list);
  return engine.renderNginxBlock(report);
}

function buildOtelBlock(files) {
  const engine = getOtel();
  if (!engine || typeof engine.buildOtelForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildOtelForFiles(list);
  return engine.renderOtelBlock(report);
}

function buildModuleFederationBlock(files) {
  const engine = getModuleFederation();
  if (!engine || typeof engine.buildModuleFederationForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildModuleFederationForFiles(list);
  return engine.renderModuleFederationBlock(report);
}

function buildConsistencyBlock(files) {
  const engine = getConsistencyChecker();
  if (!engine || typeof engine.buildConsistencyForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildConsistencyForFiles(list);
  return engine.renderConsistencyBlock(report);
}

/**
 * Document outline block — emits the dominant file's table of contents so
 * the model can cite sections by number/title. Multi-file uploads get the
 * outline of the file with the most sections.
 */
function buildOutlineBlock(files) {
  const engine = getOutlineGenerator();
  if (!engine || typeof engine.buildOutlineForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const result = engine.buildOutlineForFiles(list);
  if (!result.primary) return '';
  return engine.renderOutlineBlock(result.primary.report, { fileLabel: result.primary.file });
}

/**
 * Readability block — surfaces the document's reading level and tone so
 * the model can mirror the register (or rewrite for plain language when
 * the source is too dense).
 */
function buildReadabilityBlock(files) {
  const engine = getReadabilityAnalyzer();
  if (!engine || typeof engine.buildReadabilityForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildReadabilityForFiles(list);
  return engine.renderReadabilityBlock(report);
}

/**
 * Cross-document comparison block — only emitted when ≥2 files have text.
 * Decorates each file with its classification so the comparison engine can
 * report kind coverage without re-running detectDocumentType.
 */
function buildComparisonBlock(files, profiles) {
  const engine = getComparisonEngine();
  if (!engine || typeof engine.compareDocuments !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length < 2) return '';
  const decorated = list.map((f, i) => ({ ...f, classification: profiles[i]?.classification || null }));
  const report = engine.compareDocuments(decorated);
  if (!report) return '';
  return engine.renderComparisonBlock(report);
}

/**
 * Domain glossary block — emitted whenever the glossary engine finds at
 * least one acronym, proper term or jargon entry across the file set.
 */
function buildGlossaryBlock(files) {
  const engine = getGlossaryEngine();
  if (!engine || typeof engine.buildGlossaryForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildGlossaryForFiles(list);
  return engine.renderGlossaryBlock(report);
}

/**
 * PII / sensitive-data safety block — emitted whenever any sensitive
 * identifier is detected across the file set. This is the most prompt-critical
 * block: it instructs the model to never echo PII verbatim and to flag
 * leaked credentials as immediate-rotation incidents.
 */
function buildPiiSafetyBlock(files) {
  const engine = getPiiEngine();
  if (!engine || typeof engine.buildPiiReportForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const report = engine.buildPiiReportForFiles(list);
  return engine.renderPiiSafetyBlock(report);
}

/**
 * Build the markdown EXTRACTED INSIGHTS block by running the insights
 * engine over the processed files. Returns an empty string when the engine
 * is unavailable or no files have extractable text — callers can splice it
 * unconditionally without checking.
 *
 * The block emphasises aggregate insights for multi-file uploads and falls
 * back to a single per-file report when only one file is present. The total
 * size is bounded by MAX_INSIGHTS_BLOCK_CHARS so the prompt stays compact.
 */
function buildInsightsBlock(files) {
  const engine = getInsightsEngine();
  if (!engine || typeof engine.buildInsightsForFiles !== 'function') return '';
  const list = Array.isArray(files) ? files.filter((f) => f && typeof f === 'object') : [];
  if (list.length === 0) return '';
  const { perFile, aggregate } = engine.buildInsightsForFiles(list);
  if (perFile.length === 0) return '';

  const sections = [];
  if (perFile.length === 1) {
    const only = perFile[0];
    sections.push(engine.renderInsightsBlock(only.report, {
      title: 'EXTRACTED INSIGHTS',
      fileLabel: only.file,
    }));
  } else {
    // Multi-file: aggregate first (cross-doc highlights), then a compact
    // per-file mini-summary for context.
    sections.push(engine.renderInsightsBlock(aggregate, {
      title: 'EXTRACTED INSIGHTS — AGGREGATE',
      fileLabel: `${perFile.length} files`,
    }));
    const perFileLines = ['### Per-file highlights'];
    for (const item of perFile) {
      const m = item.report.metrics;
      const persons = item.report.entities.persons.slice(0, 3).join(', ');
      const orgs = item.report.entities.organizations.slice(0, 3).join(', ');
      const money = item.report.numbers.money.slice(0, 3).join(', ');
      const summary = [
        `**${item.file}** — ${m.words.toLocaleString()} words · ~${m.readingMinutes} min`,
        persons ? `people: ${persons}` : null,
        orgs ? `orgs: ${orgs}` : null,
        money ? `money: ${money}` : null,
      ].filter(Boolean).join(' · ');
      perFileLines.push(`- ${summary}`);
    }
    sections.push(perFileLines.join('\n'));
  }

  let combined = sections.join('\n\n');
  if (combined.length > MAX_INSIGHTS_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_INSIGHTS_BLOCK_CHARS - 80)}\n\n[...insights block truncated to stay within token budget]`;
  }
  return combined;
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
  buildInsightsBlock,
  buildQualityBlock,
  buildEvidenceMapBlock,
  buildDeepAnalysisBlock,
  buildQuotesBlock,
  buildDiscourseBlock,
  buildSectionRolesBlock,
  buildNumericCoherenceBlock,
  buildTemporalTimelineBlock,
  buildActionDashboardBlock,
  buildAudienceToneBlock,
  buildSemanticGraphBlock,
  buildKpisBlock,
  buildRiskRegisterBlock,
  buildFactDensityBlock,
  buildRelationshipsBlock,
  buildSectionSimilarityBlock,
  buildNumericStatisticsBlock,
  buildQualityGradeBlock,
  buildTitlesBlock,
  buildTldrBlock,
  buildSentimentBlock,
  buildKeyPhrasesBlock,
  buildObligationsBlock,
  buildScopeExclusionsBlock,
  buildStakeholderMapBlock,
  buildJurisdictionBlock,
  buildDefinitionsBlock,
  buildCrossReferenceBlock,
  buildPricingBlock,
  buildMetadataBlock,
  buildComplianceBlock,
  buildWarrantiesBlock,
  buildDisputeResolutionBlock,
  buildIndemnificationBlock,
  buildAcronymsBlock,
  buildTemporalExpressionsBlock,
  buildCrossNumericBlock,
  buildSignatureBlocksBlock,
  buildQaPairsBlock,
  buildHypothesesBlock,
  buildRecommendationsBlock,
  buildAssumptionsBlock,
  buildConditionalClausesBlock,
  buildCounterArgumentsBlock,
  buildCallsToActionBlock,
  buildDisclosuresBlock,
  buildFactVsOpinionBlock,
  buildScenariosBlock,
  buildBenchmarksBlock,
  buildGoalsTargetsBlock,
  buildSLATermsBlock,
  buildDataClassificationBlock,
  buildApprovalWorkflowBlock,
  buildExecutiveSummaryBlock,
  buildUrlsBlock,
  buildContactsBlock,
  buildFootnotesBlock,
  buildTablesBlock,
  buildCodeBlocksBlock,
  buildFigureRefsBlock,
  buildChecklistsBlock,
  buildIdentifiersBlock,
  buildBulletListsBlock,
  buildMermaidBlock,
  buildPrioritiesBlock,
  buildOwnershipBlock,
  buildTimestampsBlock,
  buildStatusBlock,
  buildAcceptanceCriteriaBlock,
  buildApiEndpointsBlock,
  buildEnvVarsBlock,
  buildSqlBlock,
  buildFilePathsBlock,
  buildCronBlock,
  buildLicensesBlock,
  buildDependenciesBlock,
  buildRiskMatrixBlock,
  buildVersionsBlock,
  buildDecisionRecordsBlock,
  buildDomainsBlock,
  buildCurrencyBlock,
  buildPercentagesBlock,
  buildCitationsBlock,
  buildColorsBlock,
  buildCoordinatesBlock,
  buildTrademarkBlock,
  buildHashtagsBlock,
  buildSectionLabelsBlock,
  buildSignoffsBlock,
  buildHashesBlock,
  buildCouponsBlock,
  buildFileSizesBlock,
  buildVcsRefsBlock,
  buildStandardsBlock,
  buildNetworkBlock,
  buildHttpStatusBlock,
  buildTimezonesBlock,
  buildMathBlock,
  buildBooleanBlock,
  buildTocBlock,
  buildHtmlAttrsBlock,
  buildBlockquotesBlock,
  buildDefinitionListsBlock,
  buildTodosBlock,
  buildImagesBlock,
  buildMediaBlock,
  buildLanguageRatioBlock,
  buildRegexPatternsBlock,
  buildFileExtensionsBlock,
  buildCodeDefsBlock,
  buildTonePolarityBlock,
  buildQuantifiersBlock,
  buildModalsBlock,
  buildNegationBlock,
  buildReadingTimeBlock,
  buildAttributionsBlock,
  buildComparativesBlock,
  buildCausalBlock,
  buildConcessionBlock,
  buildHedgingBlock,
  buildIntensifiersBlock,
  buildReportingBlock,
  buildExamplesBlock,
  buildApproximationsBlock,
  buildQuestionsBlock,
  buildImperativesBlock,
  buildInTextDefinitionsBlock,
  buildFiscalYearBlock,
  buildRatiosBlock,
  buildOrdinalsBlock,
  buildGeoRegionsBlock,
  buildTrackingBlock,
  buildWeatherBlock,
  buildScientificNotationBlock,
  buildTaxaBlock,
  buildChemistryBlock,
  buildFxRatesBlock,
  buildIbanSwiftBlock,
  buildLicensePlatesBlock,
  buildLegalCitationsBlock,
  buildSocialUrlsBlock,
  buildGeneProteinBlock,
  buildCurrencySymbolsBlock,
  buildPhoneCodesBlock,
  buildPostalCodesBlock,
  buildAddressesBlock,
  buildMimeTypesBlock,
  buildUtmParamsBlock,
  buildCreditCardsBlock,
  buildSsnPiiBlock,
  buildApiKeysBlock,
  buildHttpMethodsBlock,
  buildContainerRefsBlock,
  buildK8sRefsBlock,
  buildMetricsBlock,
  buildOauthScopesBlock,
  buildCspDirectivesBlock,
  buildMathOperatorsBlock,
  buildSpdxComplexBlock,
  buildFeatureFlagsBlock,
  buildCookieAttrsBlock,
  buildOtelTraceBlock,
  buildCloudArnsBlock,
  buildMlModelsBlock,
  buildDbConnStringsBlock,
  buildGraphqlOpsBlock,
  buildGrpcRefsBlock,
  buildStackTracesBlock,
  buildEnvNamesBlock,
  buildTestBlocksBlock,
  buildGitShasBlock,
  buildCloudStorageBlock,
  buildWebVitalsBlock,
  buildAriaA11yBlock,
  buildI18nKeysBlock,
  buildCiBuildIdsBlock,
  buildUserAgentsBlock,
  buildCidrRangesBlock,
  buildCacheHeadersBlock,
  buildGithubRefsBlock,
  buildApmRefsBlock,
  buildAttackPatternsBlock,
  buildWebhookUrlsBlock,
  buildSshFingerprintsBlock,
  buildNpmRefsBlock,
  buildCorrelationIdsBlock,
  buildPaymentIdsBlock,
  buildEmailHeadersBlock,
  buildIcalEventsBlock,
  buildFrontmatterBlock,
  buildPullQuotesBlock,
  buildGhaStepsBlock,
  buildTerraformRefsBlock,
  buildHelmRefsBlock,
  buildNaturalSchedulesBlock,
  buildChatPermalinksBlock,
  buildPmTicketsBlock,
  buildSlaTargetsBlock,
  buildTldsBlock,
  buildStockTickersBlock,
  buildHardwareSpecsBlock,
  buildBandwidthUnitsBlock,
  buildTrackingNumbersBlock,
  buildRateLimitHeadersBlock,
  buildCryptoWalletsBlock,
  buildCveIdsBlock,
  buildMediaTimestampsBlock,
  buildLinuxSignalsBlock,
  buildExitCodesBlock,
  buildNetworkPortsBlock,
  buildLinuxDistrosBlock,
  buildLifecyclePhasesBlock,
  buildProjectCodenamesBlock,
  buildRiskLevelsBlock,
  buildSaasMetricsBlock,
  buildRecipeMeasurementsBlock,
  buildIsoLangsBlock,
  buildPrReviewStatesBlock,
  buildPricingTiersBlock,
  buildArxivIdsBlock,
  buildDoiIdsBlock,
  buildOrcidIdsBlock,
  buildWikiRefsBlock,
  buildPubmedIdsBlock,
  buildServiceAccountsBlock,
  buildVinNumbersBlock,
  buildEmojiShortcodesBlock,
  buildBibtexEntriesBlock,
  buildLatexCommandsBlock,
  buildProgLangsBlock,
  buildComplianceRefsBlock,
  buildTlsCiphersBlock,
  buildDnsRecordsBlock,
  buildEmailAuthBlock,
  buildOpenapiKeysBlock,
  buildKafkaRefsBlock,
  buildAnsiEscapesBlock,
  buildSqlWindowsBlock,
  buildWebsocketMarkersBlock,
  buildIsoDurationsBlock,
  buildBrowserSupportBlock,
  buildNumberBasesBlock,
  buildDmsCoordsBlock,
  buildContainerRegistriesBlock,
  buildWktGeometryBlock,
  buildMdRefLinksBlock,
  buildBotTokensBlock,
  buildCargoPackagesBlock,
  buildGoModulesBlock,
  buildMavenCoordsBlock,
  buildPipReqsBlock,
  buildComposerPkgsBlock,
  buildNugetPkgsBlock,
  buildGemPkgsBlock,
  buildHexPkgsBlock,
  buildSvgPathCmdsBlock,
  buildGeojsonBlock,
  buildPwaManifestBlock,
  buildPermissionsApiBlock,
  buildServerlessFnsBlock,
  buildDbMigrationsBlock,
  buildEslintRulesBlock,
  buildBuildToolsBlock,
  buildJwtClaimsBlock,
  buildSriHashesBlock,
  buildJsonSchemaBlock,
  buildPrismaSchemaBlock,
  buildGraphqlFragmentsBlock,
  buildCssVarsBlock,
  buildComposeServicesBlock,
  buildRegexFlagsBlock,
  buildVueSfcBlock,
  buildAstroBlock,
  buildE2eTestsBlock,
  buildMswHandlersBlock,
  buildGhWorkflowsBlock,
  buildJsonLdBlock,
  buildTailwindBlock,
  buildMongoAggBlock,
  buildHelmBlock,
  buildVitestBlock,
  buildMjmlBlock,
  buildStripeBlock,
  buildTerraformVarsBlock,
  buildOpenapiSecurityBlock,
  buildK8sResourcesBlock,
  buildCssAnimBlock,
  buildStorybookBlock,
  buildSentryBlock,
  buildNatsBlock,
  buildPkgJsonBlock,
  buildRedisBlock,
  buildNginxBlock,
  buildOtelBlock,
  buildModuleFederationBlock,
  loadAnalysesByFileId,
  pickPrimaryType,
  profileTableColumns,
  // Exposed for unit tests
  _internal: {
    TYPE_SIGNALS,
    DIRECTIVES,
    MIN_CONFIDENCE_SCORE,
    tableToMiniMarkdown,
    buildPerFileProfile,
    renderProfileBlock,
    renderDirectiveBlock,
    buildEvidenceMapBlock,
    profileTableColumns,
    classifyColumnType,
    parseNumericCell,
    detectTotalsRow,
    formatTableProfileFooter,
  },
};
