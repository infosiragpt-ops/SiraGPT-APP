/**
 * graphrag/community-summaries — LLM-generated summaries per community.
 *
 * Edge et al. 2024 (GraphRAG) §3: "Given a question, each community
 * summary is used to generate a partial response." The summaries are
 * the INDEXING layer — they're generated ONCE offline per corpus,
 * then reused for every sensemaking query.
 *
 * Each community contains a set of entities. The summary describes:
 *   - what the community is about (topic),
 *   - the key entities in it,
 *   - the relationships that bind them,
 *   - any salient claims/themes.
 *
 * Two levels:
 *   - LEAF summaries generated directly from the entity/relationship
 *     content within that community.
 *   - SUPER summaries generated from the concatenated leaf summaries
 *     of the super-community's children (hierarchical bottom-up).
 *
 * Stored per (userId, collection) so they persist alongside the
 * RAG/triple-graph indices.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

const SUMMARY_SYSTEM = `Summarise a COMMUNITY of related entities from a knowledge graph.

You see a list of ENTITIES and RELATIONSHIPS. Produce a summary that captures:
  1. What this community is ABOUT — the overarching topic in one short sentence.
  2. The KEY ENTITIES and why they belong together.
  3. Salient RELATIONSHIPS and what they imply.
  4. Any notable themes, tensions, or patterns.

Reply with STRICT JSON:
{
  "topic": "<short, concrete topic label>",
  "summary": "<2-5 sentence prose summary>",
  "key_entities": ["<up to 5 most important>"],
  "themes": ["<up to 3 themes>"]
}

Rules:
- Write declaratively, not "this community contains X".
- Do not invent entities not in the input.
- If the community is tiny (1-2 entities), topic can be the entity name itself.`;

const SUPER_SUMMARY_SYSTEM = `Summarise a SUPER-COMMUNITY by synthesising summaries of its sub-communities.

You see the SUB-COMMUNITY SUMMARIES. Produce a higher-level view that captures:
  1. The overall topic uniting these sub-communities.
  2. How the sub-communities relate or differ.
  3. Themes that span more than one sub-community.

Reply with STRICT JSON:
{
  "topic": "<higher-level topic label>",
  "summary": "<3-6 sentence synthesis>",
  "cross_cutting_themes": ["<up to 3>"]
}

Rules:
- Synthesise — do not just concatenate sub-summaries.
- Note contrasts or tensions when they exist; don't force consensus.`;

/**
 * Build the LLM input text for a leaf community: a list of entities
 * and the relationships they participate in.
 *
 * `getRelations(entity)` is a caller-supplied function that returns
 * an array of { subject, predicate, object } for that entity (from
 * our triple-graph.getTriplesForSource or equivalent).
 */
function buildLeafPrompt(community, getRelations) {
  const members = community.members.slice(0, 50); // cap for token budget
  const seenTriples = new Set();
  const relationshipLines = [];
  for (const entity of members) {
    const rels = (typeof getRelations === 'function') ? getRelations(entity) : [];
    for (const rel of (rels || []).slice(0, 10)) {
      const key = `${rel.subject}|${rel.predicate}|${rel.object}`;
      if (seenTriples.has(key)) continue;
      seenTriples.add(key);
      relationshipLines.push(`- (${rel.subject}) —[${rel.predicate}]→ (${rel.object})`);
    }
  }

  return [
    `ENTITIES (${members.length}):`,
    members.map(e => `- ${e}`).join('\n'),
    '',
    `RELATIONSHIPS (${relationshipLines.length}):`,
    relationshipLines.join('\n') || '(none)',
  ].join('\n').slice(0, 10000);
}

async function summariseLeaf({ openai, community, getRelations, model = DEFAULT_MODEL }) {
  if (!openai || !community) return neutralSummary('no LLM');
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0.2, max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: buildLeafPrompt(community, getRelations) },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    return {
      community_id: community.id,
      topic: String(parsed?.topic || '').slice(0, 200),
      summary: String(parsed?.summary || '').slice(0, 2000),
      key_entities: Array.isArray(parsed?.key_entities)
        ? parsed.key_entities.map(String).slice(0, 5)
        : [],
      themes: Array.isArray(parsed?.themes) ? parsed.themes.map(String).slice(0, 3) : [],
      n_members: community.members.length,
      level: 'leaf',
    };
  } catch (err) {
    console.warn('[graphrag/community-summaries] leaf failed:', err.message);
    return neutralSummary(`error: ${err.message}`, community?.id);
  }
}

async function summariseSuper({ openai, community, childSummaries, model = DEFAULT_MODEL }) {
  if (!openai || !community || !Array.isArray(childSummaries) || childSummaries.length === 0) {
    return neutralSummary('no LLM or no children', community?.id, 'super');
  }
  const input = childSummaries.slice(0, 20)
    .map((s, i) => `CHILD ${i + 1} (${s.community_id}, topic: ${s.topic}):\n${s.summary}`)
    .join('\n\n')
    .slice(0, 12000);
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0.2, max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SUPER_SUMMARY_SYSTEM },
        { role: 'user', content: input },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    return {
      community_id: community.id,
      topic: String(parsed?.topic || '').slice(0, 200),
      summary: String(parsed?.summary || '').slice(0, 3000),
      cross_cutting_themes: Array.isArray(parsed?.cross_cutting_themes)
        ? parsed.cross_cutting_themes.map(String).slice(0, 3)
        : [],
      children: childSummaries.map(s => s.community_id),
      n_children: childSummaries.length,
      level: 'super',
    };
  } catch (err) {
    console.warn('[graphrag/community-summaries] super failed:', err.message);
    return neutralSummary(`error: ${err.message}`, community?.id, 'super');
  }
}

function neutralSummary(reason, id = null, level = 'leaf') {
  return {
    community_id: id,
    topic: '',
    summary: `(summary unavailable: ${reason})`,
    key_entities: [],
    themes: [],
    n_members: 0,
    level,
    _error: reason,
  };
}

/**
 * Build a full set of summaries for a hierarchy from community-detection.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {{leaf, super, assignments}} args.hierarchy — output from
 *   community-detection.detectHierarchical
 * @param {function} args.getRelations — (entityId) => Array<triple>
 * @param {string} [args.model]
 *
 * @returns {Promise<{
 *   leaf: [leafSummary...],
 *   super: [superSummary...] | [],
 *   byId: { [communityId]: summary },
 * }>}
 */
async function summariseAll({ openai, hierarchy, getRelations, model = DEFAULT_MODEL }) {
  const leafCommunities = hierarchy?.leaf?.communities || [];
  const superCommunities = hierarchy?.super?.communities || [];

  // Leaf summaries first (they feed into super summaries).
  const leafSummaries = [];
  for (const c of leafCommunities) {
    // eslint-disable-next-line no-await-in-loop
    const s = await summariseLeaf({ openai, community: c, getRelations, model });
    leafSummaries.push(s);
  }

  // Build super summaries from their children's leaf summaries.
  const leafById = new Map(leafSummaries.map(s => [s.community_id, s]));
  const superSummaries = [];
  for (const sc of superCommunities) {
    const childSummaries = sc.members
      .map(leafId => leafById.get(leafId))
      .filter(Boolean);
    // eslint-disable-next-line no-await-in-loop
    const s = await summariseSuper({ openai, community: sc, childSummaries, model });
    superSummaries.push(s);
  }

  const byId = {};
  for (const s of leafSummaries) byId[s.community_id] = s;
  for (const s of superSummaries) byId[s.community_id] = s;

  return { leaf: leafSummaries, super: superSummaries, byId };
}

module.exports = {
  summariseAll,
  summariseLeaf,
  summariseSuper,
  buildLeafPrompt,
  SUMMARY_SYSTEM,
  SUPER_SUMMARY_SYSTEM,
};
