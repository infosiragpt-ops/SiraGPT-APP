function groupMimeTypes(files = []) {
  const buckets = {};
  for (const file of files) {
    const type = String(file.mimeType || 'application/octet-stream').split('/')[0] || 'other';
    buckets[type] = (buckets[type] || 0) + 1;
  }
  return buckets;
}

function textCoverage(files = []) {
  if (!files.length) return { extracted: 0, total: 0, percent: 0 };
  const extracted = files.filter(file => String(file.extractedText || '').trim().length > 0).length;
  return {
    extracted,
    total: files.length,
    percent: Math.round((extracted / files.length) * 100),
  };
}

function buildProjectContextManifest(project) {
  const files = Array.isArray(project?.files) ? project.files : [];
  const chats = Array.isArray(project?.chats) ? project.chats : [];
  const memories = Array.isArray(project?.memories) ? project.memories : [];
  const documents = Array.isArray(project?.documents) ? project.documents : [];
  const counts = project?._count || {};
  const fileCount = Number.isFinite(counts.files) ? counts.files : files.length;
  const chatCount = Number.isFinite(counts.chats) ? counts.chats : chats.length;
  const memoryCount = Number.isFinite(counts.memories) ? counts.memories : memories.length;
  const documentCount = Number.isFinite(counts.documents) ? counts.documents : documents.length;
  const coverage = textCoverage(files);

  return {
    projectId: project?.id || null,
    name: project?.name || '',
    isolation: 'project_scoped',
    hasInstructions: Boolean(String(project?.instructions || '').trim()),
    counts: {
      files: fileCount,
      chats: chatCount,
      memories: memoryCount,
      documents: documentCount,
    },
    fileTypes: groupMimeTypes(files),
    textCoverage: coverage,
    updatedAt: project?.updatedAt || null,
    status: {
      knowledgeReady: fileCount === 0 || coverage.extracted > 0,
      instructionsReady: Boolean(String(project?.instructions || '').trim()),
      conversationsReady: chatCount > 0,
      memoryReady: memoryCount > 0,
    },
  };
}

function buildProjectPromptHeader(project) {
  const manifest = buildProjectContextManifest(project);
  const counts = manifest.counts;

  return [
    `## PROJECT WORKSPACE MANIFEST`,
    `Scope: project_scoped`,
    `Name: ${manifest.name || 'Untitled project'}`,
    `Context inventory: ${counts.files} file(s), ${counts.documents} document(s), ${counts.chats} project chat(s), ${counts.memories} memory fact(s).`,
    `Isolation rule: use only this project's instructions, files, memory and this chat history as persistent project context. Do not import facts from other projects or unrelated chats unless the user explicitly provides them in this conversation.`,
    `Grounding rule: when project files or memories conflict with general model knowledge, prefer the project context. If the answer requires missing project material, state the gap clearly before proceeding.`,
  ].join('\n');
}

module.exports = {
  buildProjectContextManifest,
  buildProjectPromptHeader,
};
