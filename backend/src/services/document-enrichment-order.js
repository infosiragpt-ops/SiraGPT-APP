'use strict';

/**
 * Reading order of the professional document-analyzer blocks in the chat
 * prompt (routes/ai.js → POST /generate). The prompt joins every non-empty
 * block in this order, and the block-budget post-pass keeps the same order
 * when it has to drop blocks to fit the soft cap. Each entry carries the
 * reason for its position.
 */
const ENRICHMENT_BLOCK_ORDER = Object.freeze([
  // PII safety frame goes FIRST so the model reads "do not echo
  // these" before any other context — defence in depth even if a
  // later instruction tries to override it.
  'piiSafetyBlock',
  // Profile establishes the file's identity and structural metadata.
  'profileBlock',
  // Outline = navigation map; helps the model locate topics by section.
  'outlineBlock',
  // Glossary primes the vocabulary BEFORE the model sees facts —
  // anchors acronyms and proper terms so insights don't get
  // paraphrased away.
  'glossaryBlock',
  // Readability tells the model how to mirror the source's tone.
  'readabilityBlock',
  // Insights = pre-extracted facts (entities, dates, numbers, risks).
  'insightsBlock',
  // Evidence map = citeable anchors by page/sheet/slide. Keep it
  // before consistency/comparison so later synthesis stays grounded.
  'evidenceMapBlock',
  // Consistency check flags intra-document contradictions before
  // the model commits to a position based on a single mention.
  'consistencyBlock',
  // Numeric coherence pairs with consistency: positive math
  // validation (sums that audit cleanly) plus the soft signals
  // the strict checker doesn't emit — percentage groups that
  // almost-sum-to-100, growth-rate arithmetic, currency mixing,
  // share splits, average vs declared range. Sits right after
  // consistency so the model reads "what's wrong" then "what
  // adds up" before moving to cross-doc synthesis.
  'numericCoherenceBlock',
  // Temporal timeline = chronological ordering of dated events
  // with each anchor sentence. Sits before comparison so the
  // model has a time axis when synthesising across documents
  // ("doc A says X happened in Q1, doc B says Y was due Q2").
  'temporalTimelineBlock',
  // Operations dashboard fuses deep-analyzer + temporal-timeline
  // into a single priority-ordered punch list (overdue →
  // upcoming → open questions → dateless actions → risks →
  // recent decisions). Sits AFTER the timeline (so the chrono
  // axis is established) and BEFORE comparison so the model
  // sees the working "what's next" view before doing
  // cross-document synthesis.
  'actionDashboardBlock',
  // Audience + tone classification — register the writer is
  // using. Sits AFTER the operations dashboard (factual punch
  // list comes first) and BEFORE cross-document comparison
  // so the model knows whether documents share a register
  // before it synthesises across them.
  'audienceToneBlock',
  // Cross-document semantic graph = entity-keyed view across
  // all files. Sits BEFORE the cross-document comparison
  // block (which is summary-level) so the model has the raw
  // entity-mention map to ground its synthesis. Surfaces
  // monetary conflicts when the same entity is paired with
  // different amounts across files.
  'semanticGraphBlock',
  // KPI extractor = quantitative headline metrics with their
  // period / trend / source sentence. Sits AFTER the entity
  // graph (so the model has the entity ↔ doc map) and BEFORE
  // cross-doc comparison so the synthesis can lean on the
  // KPI list when it answers headline-number questions.
  'kpisBlock',
  // Risk register = categorised, severity-scored threats with
  // mitigation flags. Sits next to the KPIs (numbers + risks
  // are the two operational axes) and BEFORE cross-doc
  // comparison so the synthesis can lean on the severity-
  // sorted register when answering "what should we worry
  // about?".
  'riskRegisterBlock',
  // Fact-density map = sections ranked by verifiable-anchor
  // density. Sits AFTER the operational axes (KPIs + risks)
  // and BEFORE cross-doc comparison so the model knows
  // WHERE the densest evidence lives before deciding which
  // section to cite.
  'factDensityBlock',
  // Document relationships = pairwise classification
  // (versions / complementary / conflicting / unrelated).
  // Sits BEFORE cross-doc comparison so the model knows
  // which pairs deserve side-by-side analysis vs which to
  // analyse independently.
  'relationshipsBlock',
  // Section similarity = top section-to-section matches across
  // files. Sits BEFORE the comparison block so the model has
  // matching sections anchored by their titles when it
  // synthesises differences ("compare the scope clauses").
  'sectionSimilarityBlock',
  // Numeric statistics = distribution-shape language
  // (mean / median / std dev / percentile / CI / p-value).
  // Sits next to KPIs in spirit but lives later in the
  // sequence so the model has KPIs + relationships first
  // and treats this block as the statistical-claim register.
  'numericStatisticsBlock',
  // Quality grade = compact letter grade per document over
  // seven weighted dimensions. Sits BEFORE the comparison
  // block so the model has the "weight by source quality"
  // calibration before synthesising across files.
  'qualityGradeBlock',
  // Titles map = canonical title detected per file. Sits at
  // the END of the per-file metadata layer so the model can
  // cite each document by its human title rather than its
  // filename for the rest of the answer.
  'titlesBlock',
  // TL;DR = 3-bullet executive summary per file. Sits right
  // after the titles block so the model can open analytical
  // answers by quoting the bullets verbatim under each
  // document's title.
  'tldrBlock',
  // Sentiment = per-section polarity. Sits next to the TL;DR
  // so the model has the rhetorical contour (positive lede,
  // negative risk section, positive close) when it mirrors
  // the source's tone in the answer.
  'sentimentBlock',
  // Key phrases = TF×IDF-light topical anchors. Sits BEFORE
  // the comparison block so the model has each document's
  // topical fingerprint when it synthesises across files.
  'keyPhrasesBlock',
  // Obligations = binding clauses ("shall", "must", "deberá")
  // with subject attribution + deadlines. Sits BEFORE the
  // cross-doc comparison so the model has each party's
  // commitments anchored when synthesising across files.
  'obligationsBlock',
  // Scope & exclusions = explicit "covers X" / "excludes Y"
  // statements. Sits next to obligations so the model has
  // the boundary frame ("what's in / out") before any
  // cross-document synthesis.
  'scopeExclusionsBlock',
  // Stakeholder map = role-based stakeholders by group
  // (leadership / operations / customer / partner / etc.).
  // Sits next to obligations + scope so the model has the
  // "who" frame before any cross-document synthesis.
  'stakeholderMapBlock',
  // Jurisdiction = country / currency / regulator /
  // governing-law signals. Sits next to obligations /
  // scope / stakeholders so the model has the legal frame
  // ready before any cross-document synthesis.
  'jurisdictionBlock',
  // Definitions = formal "X means Y" patterns. Sits next to
  // jurisdiction / obligations / scope because legal-style
  // docs lean on definitions; the chat needs them to anchor
  // every later quote in the document's constrained sense.
  'definitionsBlock',
  // Cross-references = internal pointers (Section 4.2, Annex
  // A). Sits next to definitions so the model can follow
  // chained clauses inside the document, not just guess at
  // their targets.
  'crossReferenceBlock',
  // Pricing & fees = labelled monetary anchors with cadence.
  // Sits next to the obligations / scope cluster because the
  // chat needs the commercial register (price + period)
  // anchored before answering "how much does X cost?".
  'pricingBlock',
  // Metadata = document-stamped version / dates / author /
  // signer. Sits next to titles + grade so the model has the
  // provenance frame before quoting body text.
  'metadataBlock',
  // Compliance frameworks = regulated standards mentioned
  // (GDPR / HIPAA / ISO 27001 / SOC 2 / PCI-DSS / SOX, etc.)
  // with a short summary. Sits next to jurisdiction so the
  // model has the full regulatory frame ready.
  'complianceBlock',
  // Warranties = statements of fact a party asserts (vs
  // obligations which compel future action). Sits in the
  // legal cluster so the model has the full risk-allocation
  // frame before answering "what does each party warrant?".
  'warrantiesBlock',
  // Dispute resolution = mechanism + seat / forum. Completes
  // the legal cluster so the model knows how disagreements
  // get resolved before any cross-document synthesis.
  'disputeResolutionBlock',
  // Indemnification + liability allocation = who pays when
  // things go wrong. Closes the legal cluster (obligations
  // + warranties + dispute resolution + indemnification)
  // before any cross-document synthesis.
  'indemnificationBlock',
  // Acronym expansions = document-stated mappings. Pair-wise
  // with glossary so the model has both (a) the terms it
  // should expect to encounter and (b) the document's own
  // expansions when those are present.
  'acronymsBlock',
  // Temporal expressions = relative time anchors. Sits next
  // to the absolute-date timeline so the model has both
  // hard dates AND soft horizons (next quarter, end of
  // year, dentro de 6 meses) when answering planning
  // questions.
  'temporalExpressionsBlock',
  // Cross-file numeric comparison = leaderboard for shared
  // concept-tags across files (only fires for 2+ files).
  // Sits before the high-level comparison block so the
  // model has the head-to-head number table before its
  // narrative synthesis.
  'crossNumericBlock',
  // Signature blocks = tail sign-off sections. Sits near the
  // metadata block so the model has both the document's
  // declared provenance (version + author at the top) AND
  // the formal sign-off rows at the tail.
  'signatureBlocksBlock',
  // Q&A pairs = FAQ / runbook question→answer mappings.
  // When the user's question matches one already in the
  // source, the chat answers from the verbatim pair rather
  // than re-synthesising.
  'qaPairsBlock',
  // Hypotheses = research / null hypotheses + research
  // questions. Useful for academic / scientific docs;
  // empty for non-research files.
  'hypothesesBlock',
  // Recommendations = "we recommend / suggest / advise"
  // sentences. Sits alongside the operational dashboard so
  // suggested actions appear next to binding obligations.
  'recommendationsBlock',
  // Assumptions = explicit author premises. Critical for
  // auditability — the chat must condition claims on these.
  'assumptionsBlock',
  // Conditional clauses = if/then logic the document declares.
  // Lets the chat answer "what happens if X?" with citeable
  // trigger sentences rather than inference from prose.
  'conditionalClausesBlock',
  // Counter-arguments = sentences that introduce contrast /
  // objections / caveats. Sits next to discourse so the chat
  // has both the main argument and its self-stated objections.
  'counterArgumentsBlock',
  // Calls-to-action = reader-directed imperatives. Useful
  // mostly for marketing / sales docs; empty otherwise.
  'callsToActionBlock',
  // Required disclosures = forward-looking / safe-harbour /
  // risk-warning / conflict-of-interest / not-financial-
  // advice caveats. Completes the regulated-doc cluster.
  'disclosuresBlock',
  // Fact vs opinion = binary classifier per sentence so the
  // chat can distinguish "verifiable" from "author's view".
  'factVsOpinionBlock',
  // Scenarios = best / worst / base case + sensitivity.
  // Useful for finance / strategy docs.
  'scenariosBlock',
  // Benchmarks = "vs X" / "industry average" / "compared
  // to". Lets the chat answer "how does X compare?" with
  // citeable trigger sentences.
  'benchmarksBlock',
  // Goals & targets = explicit objectives / OKRs / targets.
  // Sits next to recommendations / actions so the chat
  // distinguishes aspirations from operational TODOs.
  'goalsTargetsBlock',
  // SLA terms = quantitative service commitments (uptime /
  // response / resolution / credit / RPO / RTO). Sits in
  // the operational cluster so the chat has the firm
  // numerical commitments ready.
  'slaTermsBlock',
  // Data classification = document-level handling labels.
  // The chat respects them when deciding how to surface or
  // echo information.
  'dataClassificationBlock',
  // Approval workflow = drafted / reviewed / approved /
  // released / signed stamps with names + dates. Useful
  // for change-control questions.
  'approvalWorkflowBlock',
  // Executive summary = per-file single-card synthesis
  // (title + grade + TL;DR + top KPI + top risk + top
  // obligation). Sits at the END of the per-file block
  // sequence so the model can use it as a stable opener
  // for analytical answers.
  'executiveSummaryBlock',
  // URLs & links = HTTP(S) hyperlinks with anchor /
  // context. Useful for any document that references
  // external resources.
  'urlsBlock',
  // Contacts = emails / phones / socials / addresses with
  // both raw + masked variants. The chat respects the
  // document's data-classification label when echoing.
  'contactsBlock',
  // Footnotes = marker → body pairs. Lets the chat answer
  // "what does footnote N say?" by quoting the body
  // verbatim instead of synthesising.
  'footnotesBlock',
  // Embedded tables = caption + header + first N rows of
  // markdown tables found in the body. Lets the chat quote
  // "table 3" verbatim instead of summarising.
  'tablesBlock',
  // Code blocks = fenced ```language … ``` with snippet
  // preview. Useful for technical / SDK / runbook docs.
  'codeBlocksBlock',
  // Figure / table refs = visual-artefact pointers with
  // caption. Routes "what does Figure N show?" to a
  // citeable list.
  'figureRefsBlock',
  // Checklists = markdown checkbox items with state. Lets
  // the chat answer "what's pending?" from source-marked
  // bullets instead of inference.
  'checklistsBlock',
  // Identifiers = ISBN / DOI / arXiv / ticker / CVE / etc.
  // Lets the chat anchor on the source's stated IDs.
  'identifiersBlock',
  // Bullet lists = markdown bullet / numbered lists grouped
  // under their heading. Surfaces source-structured lists.
  'bulletListsBlock',
  // Mermaid diagrams = fenced ```mermaid blocks with type
  // classification + preview. Routes "what does the diagram
  // show?" to a structured citeable preview.
  'mermaidBlock',
  // Priorities/severity tags = P0..P4, SEV-1..SEV-5, Blocker/
  // Critical/Major/Minor/Trivial, Urgent, Spanish equivalents.
  // Routes "what are the critical items?" to a citeable list.
  'prioritiesBlock',
  // Ownership/DRI = Owner / Assignee / Reviewer / Approver /
  // Stakeholder lines. Routes "who owns this?" to a citeable
  // list (RACI/DACI/RFC conventions).
  'ownershipBlock',
  // Timestamps & durations = ISO 8601 datetimes, epoch s/ms,
  // HTTP date format, ISO 8601 + human durations. Routes
  // "when did X happen?" / "what's the SLA?" to a citeable list.
  'timestampsBlock',
  // Status / lifecycle = Status: Draft/Approved/Deprecated/etc.,
  // inline [DRAFT] / (DEPRECATED) callouts, Spanish equivalents.
  // Routes "is this approved?" / "what's the status?" to a signal.
  'statusBlock',
  // Acceptance criteria = Gherkin scenarios (Given-When-Then in
  // English + Spanish) + labelled AC bullet lists. Routes
  // "what are the acceptance criteria?" to citeable structure.
  'acceptanceCriteriaBlock',
  // API endpoints = HTTP method + path references (inline,
  // markdown headers, OpenAPI paths blocks). Routes
  // "what endpoints does this expose?" to a citeable inventory.
  'apiEndpointsBlock',
  // Env vars / config flags = SCREAMING_SNAKE_CASE tokens
  // referenced as env vars (bare, $/env/process.env prefixed,
  // .env declarations). Routes "what env vars does this need?".
  'envVarsBlock',
  // SQL statements = DDL/DML/DQL/DCL/TCL classification with
  // target tables. Routes "what tables does this touch?" /
  // "is there a DDL change?" to a citeable inventory.
  'sqlBlock',
  // File paths = POSIX/home/project/Windows path references.
  // Routes "what files does this reference?" to a citeable list.
  'filePathsBlock',
  // Cron / scheduling = 5/6/7-field cron + named expressions
  // (@daily/@hourly/etc.) + K8s schedule: lines.
  'cronBlock',
  // Licenses / copyright = SPDX IDs, SPDX header, "Licensed
  // under …", Copyright lines, All Rights Reserved.
  'licensesBlock',
  // Dependencies = npm/pip/cargo/gomod/maven packages with
  // versions. Routes "what dependencies does this use?".
  'dependenciesBlock',
  // Risk matrix = formal Likelihood × Impact pairings +
  // Risk Score lines (English + Spanish). Routes "what's
  // the risk score?" to a citeable matrix.
  'riskMatrixBlock',
  // Versions / releases = SemVer + labeled lines + release
  // headers + CalVer. Routes "what version is this?".
  'versionsBlock',
  // Decision records (ADR) = Decision / Context / Consequences
  // / Alternatives / Trade-offs / Rationale. Routes "what's
  // the decision?" / "why?" / "alternatives?".
  'decisionRecordsBlock',
  // Domains = bare domain names. Routes "what domains does
  // this reference?" to a citeable list.
  'domainsBlock',
  // Currency amounts = monetary amounts with currency tags
  // (symbol-prefix, ISO-suffix, ISO-prefix). Routes "what
  // amount?" / "how much?" to a citeable list.
  'currencyBlock',
  // Percentages = numeric (12%, +15%), word form (12 percent
  // / por ciento), pp/bps. Routes "what's the rate?".
  'percentagesBlock',
  // Citations = academic citations (numeric, bracketed
  // author-year, parenthetical, et al. in-text) +
  // References section. Routes "what's cited?".
  'citationsBlock',
  // Colors = hex/RGB/HSL/Tailwind/named CSS colors.
  // Routes "what colors / palette?".
  'colorsBlock',
  // Coordinates = decimal lat/lng, DMS, Plus codes.
  // Routes "where is this?" / "what coordinates?".
  'coordinatesBlock',
  // Trademark = inline TM/®/℠/© + attributions.
  'trademarkBlock',
  // Hashtags / handles = social-style #tag and @user references.
  'hashtagsBlock',
  // Section labels = Section / § / Chapter / Article / Part /
  // Annex / Appendix / Clause references with Spanish equivs.
  // Routes "what's Section X?" / "what does Article 5 say?".
  'sectionLabelsBlock',
  // Sign-offs = letter/email closings + name. Routes "who signed?".
  'signoffsBlock',
  // Hashes = MD5/SHA/BLAKE hex digests. Routes "what's the hash?".
  'hashesBlock',
  // Coupons = promo/discount/voucher codes. Routes "promo code?".
  'couponsBlock',
  // File sizes = KB/MB/GB/TB/PB + binary IEC + bandwidth.
  'fileSizesBlock',
  // VCS refs = commit SHAs, PR/issue #, repo, branches, tags.
  'vcsRefsBlock',
  // Standards = ISO / ANSI / IEEE / RFC / NIST / W3C / EN /
  // DIN / PCI-DSS / SOC / compliance abbreviations.
  'standardsBlock',
  // Network = IPv4 / IPv6 (with CIDR) / MAC / ports.
  'networkBlock',
  // HTTP status codes = 1xx-5xx classes. Routes "what status?".
  'httpStatusBlock',
  // Time zones = UTC/GMT offsets, named TZs, IANA IDs.
  'timezonesBlock',
  // Math = LaTeX inline / display / environment expressions.
  'mathBlock',
  // Boolean = labeled yes/no/true/false + glyph values.
  'booleanBlock',
  // TOC = explicit Table-of-Contents sections.
  'tocBlock',
  // HTML attrs = referenced HTML attributes + aria/data.
  'htmlAttrsBlock',
  // Blockquotes = markdown > quotes + attributions.
  'blockquotesBlock',
  // Definition lists = term/definition pairs (Markdown DL / dt-dd).
  'definitionListsBlock',
  // TODOs = TODO/FIXME/NOTE/HACK/XXX/WIP/BUG markers.
  'todosBlock',
  // Images = markdown / HTML images + emoji + a11y status.
  'imagesBlock',
  // Media = audio/video filenames + timecodes + episode markers.
  'mediaBlock',
  // Language ratio = per-doc multi-language mix.
  'languageRatioBlock',
  // Regex patterns = inline regex literals (JS/Py/backtick).
  'regexPatternsBlock',
  // File extensions = distribution by category.
  'fileExtensionsBlock',
  // Code defs = function/class/type definitions.
  'codeDefsBlock',
  // Tone polarity = positive/negative/neutral/mixed scoring.
  'tonePolarityBlock',
  // Quantifiers = universal/existential/negative/cardinal scope.
  'quantifiersBlock',
  // Modals = strong/recommended/permitted/possibility/prohibited.
  'modalsBlock',
  // Negation = density + double-negation patterns.
  'negationBlock',
  // Reading time = per-file word count + time bands.
  'readingTimeBlock',
  // Attributions = "According to X" / "Según X" source phrases.
  'attributionsBlock',
  // Comparatives = magnitude/percent/multiplier/vs phrases.
  'comparativesBlock',
  // Causal = because/due to/debido a markers.
  'causalBlock',
  // Concession = however/although/sin embargo markers.
  'concessionBlock',
  // Hedging = perhaps/possibly/quizás softeners.
  'hedgingBlock',
  // Intensifiers = very/extremely/muy/extremadamente adverbs.
  'intensifiersBlock',
  // Reporting verbs = said/stated/dijo/afirmó.
  'reportingBlock',
  // Examples = for example/e.g./por ejemplo/es decir.
  'examplesBlock',
  // Approximations = about/roughly/aproximadamente hedges.
  'approximationsBlock',
  // Questions = interrogative sentences classified by kind.
  'questionsBlock',
  // Imperatives = commands/instructions (verb whitelist).
  'imperativesBlock',
  // In-text definitions = inline "X is Y" / "X means Y" patterns
  // (distinct from glossary definitions extractor).
  'inTextDefinitionsBlock',
  // Fiscal year = FY24/Q1/quarter markers.
  'fiscalYearBlock',
  // Ratios = 3:1 / "3 to 1" / X per Y / fractions.
  'ratiosBlock',
  // Ordinals = 1st/first/primero/1º ranking markers.
  'ordinalsBlock',
  // Geo regions = continents/groupings/ISO/countries.
  'geoRegionsBlock',
  // Tracking = UPS/FedEx/USPS/DHL parcel codes.
  'trackingBlock',
  // Weather = temperature/precipitation/wind/humidity/climate.
  'weatherBlock',
  // Scientific notation = E-notation, ×10^, superscript pow-of-ten.
  'scientificNotationBlock',
  // Taxa = Linnaean binomial nomenclature.
  'taxaBlock',
  // Chemistry = molecular formulas + element names.
  'chemistryBlock',
  // FX rates = currency pair exchange rates.
  'fxRatesBlock',
  // IBAN/SWIFT = international banking codes.
  'ibanSwiftBlock',
  // License plates = US/UK/MX/ES/labeled vehicle plates.
  'licensePlatesBlock',
  // Legal citations = case names + reporters + statutes.
  'legalCitationsBlock',
  // Social URLs = twitter/instagram/linkedin/github handles.
  'socialUrlsBlock',
  // Gene/protein symbols = HGNC + p-proteins + mRNA + ENST.
  'geneProteinBlock',
  // Currency symbols standalone = €/$/£/¥/₹/₿ branding.
  'currencySymbolsBlock',
  // Phone codes = E.164 + country resolution.
  'phoneCodesBlock',
  // Postal codes = UK/CA/BR/JP/US/labeled.
  'postalCodesBlock',
  // Addresses = street lines (US/Spanish/PO Box).
  'addressesBlock',
  // MIME types = IANA Media-Type references.
  'mimeTypesBlock',
  // UTM params = utm_source/medium/campaign URL tracking.
  'utmParamsBlock',
  // Credit cards (MASKED) = Visa/MC/Amex/Discover/JCB/Diners with Luhn.
  'creditCardsBlock',
  // SSN-style PII (MASKED) = US SSN / MX CURP / ES DNI / CA SIN / UK NINO / BR CPF.
  'ssnPiiBlock',
  // API keys (MASKED) = OpenAI/GitHub/AWS/Stripe/Slack/Bearer/JWT.
  'apiKeysBlock',
  // HTTP methods census = aggregate counts of GET/POST/PUT/etc.
  'httpMethodsBlock',
  // Container refs = Docker / OCI image references.
  'containerRefsBlock',
  // K8s refs = apiVersion / kind / namespace / kubectl.
  'k8sRefsBlock',
  // Metrics = Prometheus-style metric names with type.
  'metricsBlock',
  // OAuth scopes census = read:user, users:read, Google URL, OIDC.
  'oauthScopesBlock',
  // CSP directives = default-src/script-src/frame-ancestors values.
  'cspDirectivesBlock',
  // Math operators = ≠ ≤ ≥ ∈ ∀ ∃ → ⇒ etc. Unicode symbols.
  'mathOperatorsBlock',
  // SPDX complex = "MIT OR Apache-2.0", "Apache-2.0 WITH LLVM-exception".
  'spdxComplexBlock',
  // Feature flag keys (LaunchDarkly / GrowthBook / Split / Unleash / PostHog / hooks).
  'featureFlagsBlock',
  // Set-Cookie attributes (HttpOnly, Secure, SameSite, Max-Age, Partitioned).
  'cookieAttrsBlock',
  // OpenTelemetry trace / span IDs (W3C / GCP / AWS X-Ray / B3) — MASKED.
  'otelTraceBlock',
  // Cloud resource IDs (AWS ARN / GCP / Azure) — account IDs MASKED.
  'cloudArnsBlock',
  // AI / ML model identifiers (OpenAI, Anthropic, Google, Meta, Mistral, DeepSeek, Qwen).
  'mlModelsBlock',
  // Database connection strings (postgres/mysql/mongodb/redis) — passwords MASKED.
  'dbConnStringsBlock',
  // GraphQL operations: query / mutation / subscription / fragment names.
  'graphqlOpsBlock',
  // gRPC / protobuf references: package / service / rpc / wire paths.
  'grpcRefsBlock',
  // Stack-trace frames (JS / Python / Java / Go / Ruby) — error provenance.
  'stackTracesBlock',
  // Deployment environment labels (prod/staging/dev/qa/sandbox/uat).
  'envNamesBlock',
  // Test framework blocks: describe/it/test/before/after, pytest, JUnit, go-test.
  'testBlocksBlock',
  // Git commit SHAs — short (7-12) / medium / full (40).
  'gitShasBlock',
  // Cloud storage paths: s3:// / gs:// / abfs:// / wasb:// / hdfs://.
  'cloudStorageBlock',
  // Core Web Vitals (LCP / FID / INP / CLS / TTFB / FCP / TBT) with bucket classification.
  'webVitalsBlock',
  // ARIA / a11y markers: role / aria-* / alt / tabindex.
  'ariaA11yBlock',
  // I18n keys: t() / I18n.t() / $t() / formatMessage / translate pipe.
  'i18nKeysBlock',
  // CI/CD build IDs (GHA / Jenkins / CircleCI / GitLab / Buildkite / Azure).
  'ciBuildIdsBlock',
  // User-Agent strings classified browser/mobile/bot/library.
  'userAgentsBlock',
  // CIDR network ranges classified private/public/loopback/multicast.
  'cidrRangesBlock',
  // HTTP cache headers (Cache-Control, ETag, Last-Modified, Expires, Pragma, Vary, Age).
  'cacheHeadersBlock',
  // GitHub references: owner/repo#N, GH-N, repo URLs, issue/PR URLs, @mentions.
  'githubRefsBlock',
  // APM / observability tool refs (Sentry / Datadog / New Relic / Honeycomb / Bugsnag / Rollbar / PagerDuty).
  'apmRefsBlock',
  // Attack pattern signatures (SQLi / XSS / LFI / cmdi / SSRF / Log4Shell / SSTI) for defensive triage.
  'attackPatternsBlock',
  // Webhook URLs (Slack/Discord/Teams/GitHub/generic) — tokens MASKED.
  'webhookUrlsBlock',
  // SSH key fingerprints (SHA256 / MD5) and key blobs — MASKED.
  'sshFingerprintsBlock',
  // NPM package references (versioned, JSON deps, protocols, require/import).
  'npmRefsBlock',
  // Request correlation IDs (X-Request-Id / CF-Ray / X-Amzn-RequestId etc) — MASKED.
  'correlationIdsBlock',
  // Payment object IDs (Stripe pi_/ch_/sub_/cus_/in_, PayPal PAY-, Square sq0_) — secrets MASKED.
  'paymentIdsBlock',
  // Email headers (From / To / Cc / Subject / Date / Message-Id / X-Mailer) — addresses masked.
  'emailHeadersBlock',
  // iCal VEVENT blocks: SUMMARY / DTSTART / DTEND / LOCATION / ATTENDEE / RRULE.
  'icalEventsBlock',
  // Markdown / TOML / JSON frontmatter — top-level metadata keys.
  'frontmatterBlock',
  // Pull quote attributions (dash, parenthetical, "said X").
  'pullQuotesBlock',
  // GitHub Actions step refs: uses: action@ref with official/community/local/docker classification.
  'ghaStepsBlock',
  // Terraform / HCL refs: resource, data, module, variable, output, cross-refs.
  'terraformRefsBlock',
  // Helm chart refs: install/upgrade commands, repo add, chart field, Chart.yaml name+version.
  'helmRefsBlock',
  // Natural-language schedules ("every Monday at 9am", "every 15 minutes", "daily", "biweekly").
  'naturalSchedulesBlock',
  // Chat platform permalinks (Slack/Discord/Notion/Teams/Telegram).
  'chatPermalinksBlock',
  // PM ticket IDs (Jira/Linear/Asana/Monday/Trello/ClickUp/Shortcut) — with reserved-word filter.
  'pmTicketsBlock',
  // SLA / SLO targets: uptime %, p99 latency, error rate, throughput, RPO/RTO.
  'slaTargetsBlock',
  // TLD census (generic/sponsored/new-gtld/country/other).
  'tldsBlock',
  // Stock tickers ($AAPL / NYSE:TSLA / ISIN US0378331005) + contextual "shares of X".
  'stockTickersBlock',
  // Hardware specs (cores / CPU brand / RAM / storage / GPU / network / arch).
  'hardwareSpecsBlock',
  // Bandwidth & volume units (Gbps / PB / rps / events per day).
  'bandwidthUnitsBlock',
  // Shipping tracking numbers (UPS / Amazon / USPS / DHL / FedEx / Canada Post) — MASKED.
  'trackingNumbersBlock',
  // Rate-limit headers (X-RateLimit-Limit/Remaining/Reset, Retry-After, RFC 8030 RateLimit).
  'rateLimitHeadersBlock',
  // Crypto wallet addresses (BTC / ETH / SOL / ENS / TRON) — MASKED first-6…last-4.
  'cryptoWalletsBlock',
  // Security / vulnerability IDs (CVE / CWE / GHSA / OSV / RHSA / DSA / CAPEC / CVSS).
  'cveIdsBlock',
  // Media timestamps (HH:MM:SS bracketed/parenthesised + SRT/VTT ranges).
  'mediaTimestampsBlock',
  // Linux signals (SIGTERM/SIGKILL/SIGINT/SIGSEGV via name, kill -N, "signal: N").
  'linuxSignalsBlock',
  // Shell exit codes with standard descriptions (130 SIGINT, 137 SIGKILL, 143 SIGTERM, etc).
  'exitCodesBlock',
  // Network ports (well-known services: ssh/http/https/postgres/redis/k8s-api/etc).
  'networkPortsBlock',
  // Linux distros (Ubuntu/Debian/Alpine/RHEL/Rocky/AlmaLinux/Fedora/Amazon Linux with version).
  'linuxDistrosBlock',
  // Lifecycle phases (alpha/beta/RC/GA/deprecated/EOL/sunset) — bare + version-attached.
  'lifecyclePhasesBlock',
  // Project / operation codenames (Project Apollo, Operation Nightfall, codename Phoenix).
  'projectCodenamesBlock',
  // Risk / severity levels (Critical/High/Medium/Low/Info + P0..P4 + Sev0..Sev5).
  'riskLevelsBlock',
  // SaaS / business metrics (ARR/MRR/CAC/LTV/churn/NRR/DAU/MAU/NPS/D7 retention).
  'saasMetricsBlock',
  // Recipe measurements (cup/tbsp/tsp/g/oz/lb + °F/°C + gas mark + cook time).
  'recipeMeasurementsBlock',
  // ISO language tags / BCP-47 (en-US / es-MX / zh-Hans-CN with script).
  'isoLangsBlock',
  // PR review states (LGTM, requested changes, dismissed, nit, FYI, +1/-1).
  'prReviewStatesBlock',
  // Pricing tiers (Free/Pro/Business/Enterprise + billing cadence + trial periods).
  'pricingTiersBlock',
  // arXiv preprint IDs (new YYMM.NNNNN, old subject/NNNNNNN, URL + version suffix).
  'arxivIdsBlock',
  // DOI identifiers (10.NNNN/... bare, labeled, URL, dx.doi.org legacy).
  'doiIdsBlock',
  // Research author IDs (ORCID, ResearcherID, Scopus, Google Scholar).
  'orcidIdsBlock',
  // Wikipedia / Wikidata / MediaWiki [[link]] / DBPedia references.
  'wikiRefsBlock',
  // NIH / NCBI biomedical IDs (PMID / PMC / NM_/NP_ accessions / NCT trials / dbSNP rs).
  'pubmedIdsBlock',
  // Cloud service accounts (GCP iam.gserviceaccount.com, GitHub Apps[bot], Azure AD SPs) — MASKED.
  'serviceAccountsBlock',
  // Vehicle Identification Numbers (VINs) — MASKED first-3 (WMI) + last-4 only.
  'vinNumbersBlock',
  // Emoji shortcodes + unicode emojis with sentiment classification.
  'emojiShortcodesBlock',
  // BibTeX / BibLaTeX bibliographic entries (article/book/inproceedings/etc).
  'bibtexEntriesBlock',
  // LaTeX commands: \section / \cite / \ref / environments / packages / math mode.
  'latexCommandsBlock',
  // Programming languages with version (30+ langs across compiled/scripting/jvm/etc).
  'progLangsBlock',
  // Compliance frameworks (GDPR / HIPAA / PCI DSS / SOC 2 / FedRAMP / NIST CSF / EU AI Act / etc).
  'complianceRefsBlock',
  // TLS cipher suites (TLS 1.3 / modern / legacy / weak classification).
  'tlsCiphersBlock',
  // DNS records (A/AAAA/CNAME/MX/TXT/SOA/NS/SRV/CAA/PTR with zone-file + prose).
  'dnsRecordsBlock',
  // Email auth (SPF / DKIM / DMARC / BIMI) — DKIM keys MASKED.
  'emailAuthBlock',
  // OpenAPI / Swagger spec keys (version / paths / operationIds / $ref schemas / security).
  'openapiKeysBlock',
  // Kafka references (topic / consumer-group / partition / offset / kafka-* commands / bootstrap.servers).
  'kafkaRefsBlock',
  // ANSI escape codes (SGR colors/styles, CSI cursor, OSC) — decoded.
  'ansiEscapesBlock',
  // SQL window functions + CTEs + analytical aggregates + frame specs.
  'sqlWindowsBlock',
  // WebSocket markers (ws/wss URLs, Sec-WebSocket-* headers, opcodes, subprotocols).
  'websocketMarkersBlock',
  // ISO 8601 durations (PT1H30M, P3DT12H, P1Y6M) with seconds computation.
  'isoDurationsBlock',
  // Browser support matrix (Chrome/Firefox/Safari/Edge/iOS/Android version requirements).
  'browserSupportBlock',
  // Number bases: 0x hex / 0b binary / 0o octal / 0NNN legacy / 1e8 exp.
  'numberBasesBlock',
  // DMS / DDM geographic coordinates + UTM / MGRS military grids.
  'dmsCoordsBlock',
  // Container registries (GCR / GAR / ECR / GHCR / Docker Hub / Quay / ACR) with digests MASKED.
  'containerRegistriesBlock',
  // WKT geometry literals (POINT / LINESTRING / POLYGON / MULTI* / GEOMETRYCOLLECTION).
  'wktGeometryBlock',
  // Markdown reference-style link defs + footnotes + in-text usage.
  'mdRefLinksBlock',
  // Messenger bot API tokens (Telegram / Slack / Discord) — ALWAYS MASKED.
  'botTokensBlock',
  // Cargo (Rust) packages: inline/table/Cargo.lock with workspace/git/path source.
  'cargoPackagesBlock',
  // Go modules: module/require/replace/retract/import + pseudo-version detection.
  'goModulesBlock',
  // Maven/Gradle coordinates: GAV strings, pom.xml, Gradle string/map deps, Maven Central URLs.
  'mavenCoordsBlock',
  // Python pip requirements: exact/min/max/compatible/exclude + markers + extras + VCS + editable.
  'pipReqsBlock',
  // PHP Composer packages (vendor/package with caret/tilde/exact constraints + lock).
  'composerPkgsBlock',
  // .NET NuGet packages (PackageReference / packages.config / dotnet add / paket).
  'nugetPkgsBlock',
  // Ruby gems (Gemfile / gemspec / Gemfile.lock with pessimistic ~&gt; constraints).
  'gemPkgsBlock',
  // Elixir Hex packages (mix.exs inline + table form with git/path/github sources).
  'hexPkgsBlock',
  // SVG path d="..." commands with decoded names (moveto / lineto / cubic-bezier / arc / etc).
  'svgPathCmdsBlock',
  // GeoJSON structure markers (type: Feature/Point/Polygon/etc + coordinates/properties/bbox/crs).
  'geojsonBlock',
  // PWA Web App Manifest fields (name / display / start_url / theme_color / icons / service worker).
  'pwaManifestBlock',
  // Browser Permissions / capability APIs (geolocation / media / clipboard / bluetooth / USB / wake lock).
  'permissionsApiBlock',
  // Serverless function entries (AWS Lambda / GCF / Cloud Run / Azure Functions / Cloudflare Workers / Vercel api routes).
  'serverlessFnsBlock',
  // DB migration filenames (Flyway / Rails / Knex / Django / Goose / Alembic / Prisma / Sqitch).
  'dbMigrationsBlock',
  // ESLint / Biome / Prettier rule references (disable directives, rule configs, severity).
  'eslintRulesBlock',
  // Build / bundler tool references (webpack / vite / rollup / esbuild / parcel / turbopack / swc / babel / tsc).
  'buildToolsBlock',
  // JWT claims (iss / sub / aud / exp / scope / roles / email + OIDC profile claims, values masked).
  'jwtClaimsBlock',
  // SRI hashes (integrity="sha256-/sha384-/sha512-..." on script/link tags, hashes masked).
  'sriHashesBlock',
  // JSON Schema keywords ($schema / type / required / oneOf / properties / items / format).
  'jsonSchemaBlock',
  // Prisma schema constructs (model / enum / datasource / generator / @id / @unique / @relation).
  'prismaSchemaBlock',
  // GraphQL fragments / spreads / directives / type system (fragment X on Y, ...spread, @include, type/interface/enum).
  'graphqlFragmentsBlock',
  // CSS custom properties (--var declarations, var() references, @property at-rule).
  'cssVarsBlock',
  // Docker Compose service definitions (services / image / ports / depends_on / healthcheck / build).
  'composeServicesBlock',
  // Regex literal patterns + flag analysis (g/i/m/s/u/y/d) + feature detection (lookaround / named groups).
  'regexFlagsBlock',
  // Vue SFC structure (template/script/style/i18n blocks, setup, scoped, composition API, defineProps/Emits, v-* directives).
  'vueSfcBlock',
  // Astro components (frontmatter fences, Astro.props/url, getStaticPaths, client:* directives, slots, getCollection).
  'astroBlock',
  // E2E test framework calls (Cypress cy.X / Playwright page.X / WebdriverIO browser.X / describe/it/beforeEach).
  'e2eTestsBlock',
  // MSW mock handlers (rest.X v1 / http.X v2 / graphql.X / setupServer/Worker / HttpResponse / ctx.json).
  'mswHandlersBlock',
  // GitHub Actions workflow constructs (jobs / runs-on / uses / secrets-masked / permissions / concurrency / cancel-in-progress).
  'ghWorkflowsBlock',
  // JSON-LD structured data (@context / @type / @id / @graph + schema.org properties).
  'jsonLdBlock',
  // Tailwind CSS utility classes (spacing/color/layout/typography/responsive prefixes/variants).
  'tailwindBlock',
  // MongoDB operators (stages $match/$group/$lookup, accumulators $sum/$avg, query $gte/$or, methods .aggregate/.find).
  'mongoAggBlock',
  // Helm chart constructs (image.repository, replicaCount, resources, .Values.X templates, .Chart.X, .Release.X).
  'helmBlock',
  // Vitest / Jest test framework (describe/test/it + matchers + mocks + snapshot detection + framework classifier).
  'vitestBlock',
  // MJML email template (mj-section/column/text/button/image + href/src/font + style block counts).
  'mjmlBlock',
  // Stripe API objects (customer/pi/charge/sub/price IDs MASKED, stripe.X resources, methods, webhook event names).
  'stripeBlock',
  // Terraform / HCL constructs (variable/output/resource/data/module/locals + var.X / module.X refs + meta-args + required_providers).
  'terraformVarsBlock',
  // OpenAPI security schemes (http bearer/basic, apiKey in:header/cookie, oauth2 flows + scopes, openIdConnect).
  'openapiSecurityBlock',
  // Kubernetes manifests (apiVersion/kind whitelisted, metadata.name/namespace, spec.replicas, image, ports, resource limits).
  'k8sResourcesBlock',
  // CSS animations & at-rules (@keyframes, animation/transition shorthand, timing functions, @media/@supports/@container).
  'cssAnimBlock',
  // Storybook CSF (default meta + title/component + story exports + args/argTypes/parameters/decorators/play + @storybook imports).
  'storybookBlock',
  // Sentry SDK (init/captureException/captureMessage/addBreadcrumb/setTag/setUser, integrations, levels, DSN-masked).
  'sentryBlock',
  // NATS / JetStream (publish/subscribe/request, subjects with wildcards, stream names, durable consumers, policies, headers).
  'natsBlock',
  // package.json structure (meta, scripts with masked bodies, dep counts + samples, engines, workspaces).
  'pkgJsonBlock',
  // Redis commands by category (string/hash/list/set/zset/stream/pubsub/script/server/pipeline + channels).
  'redisBlock',
  // Nginx config (server blocks, location, upstream, listen, proxy_pass, SSL, routing, rate limits, logs).
  'nginxBlock',
  // OpenTelemetry (trace.getTracer, span ops, SpanKind/SpanStatus, semantic attrs, meters, propagators, instrumentations).
  'otelBlock',
  // Webpack Module Federation (ModuleFederationPlugin, remotes, exposes, shared, shareScope, __webpack_init_sharing__).
  'moduleFederationBlock',
  // Drizzle ORM (pgTable/mysqlTable/sqliteTable + column types + constraints + relations + db.select/insert/update/delete + indexes).
  'drizzleBlock',
  // Twilio API (SIDs MASKED by prefix type, twilio.X resources, methods, TwiML verbs, X-Twilio-Signature).
  'twilioBlock',
  // AWS SDK v3 (Client/Command classes, send(), @aws-sdk/* imports, regions, ARNs with account masking, presigned URLs).
  'awsSdkBlock',
  // OAuth 2.0 / OIDC flows (grant_type/response_type, PKCE, redirect_uri, client_id MASKED, scopes, endpoints, errors).
  'oauthFlowsBlock',
  // GraphQL clients (Apollo/urql/Relay/graphql-request, useQuery/useMutation hooks, gql tagged templates classified by op).
  'gqlClientsBlock',
  // Webhook signature verification (Stripe/GitHub/Slack/Twilio/Shopify/Discord headers + HMAC primitives + timingSafeEqual).
  'webhookSigsBlock',
  // BullMQ / Bull job queues (Queue/Worker/QueueEvents/FlowProducer, job ops, options, event listeners, cron).
  'bullmqBlock',
  // Web Crypto API (crypto.subtle ops, algorithms AES-GCM/ECDSA/RSA-OAEP, hashes, curves, key formats/usages).
  'webCryptoBlock',
  // Cross-document synthesis only fires for ≥2 files; sits next to
  // insights so the model sees aggregate truth before per-file detail.
  'comparisonBlock',
  // Quality assurance scorecard — coverage / breadth / coherence
  // of the extractor pipeline. Sits before the directive so the
  // model self-calibrates ("I'm at 38% coverage, here's what I
  // have evidence for") instead of hallucinating completeness.
  'qualityBlock',
  // Deep analysis = sentence-level claims/actions/decisions/risks.
  // Sits AFTER quality (so the model sees coverage caveat first)
  // and BEFORE the directive (so the model has concrete semantic
  // anchors when it commits to the recipe).
  'deepAnalysisBlock',
  // Quotes & citations — verbatim language + bibliographic
  // markers. Sits AFTER the deep-analysis (claims are
  // paraphrasable summaries; quotes are literal) and BEFORE
  // the directive so the model can route literal-quote and
  // source-trace questions to this block directly.
  'quotesBlock',
  // Discourse map = argumentative scaffolding (contrast,
  // causation, sequence, conclusion). Sits BEFORE the
  // directive so the model can route "what's the argument"
  // / "where's the conclusion" navigation questions to this
  // block instead of re-scanning the raw text.
  'discourseBlock',
  // Section roles = rhetorical map of headings (intro,
  // method, results, conclusion / preamble, obligations,
  // termination). Sits right before the directive so the
  // model has the schema-level anchor (academic vs legal)
  // when it commits to a recipe.
  'sectionRolesBlock',
  // Directive = recipe the model should follow when answering.
  'directiveBlock',
]);

module.exports = { ENRICHMENT_BLOCK_ORDER };
