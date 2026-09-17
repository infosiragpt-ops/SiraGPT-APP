'use strict';

const {
  formatFalVideoDisplayName,
  getFalVideoModelDefinition,
  getVideoModelCapabilities,
  listFamilyVideoEndpoints,
  normalizeFalVideoId,
  videoModelFamilyKey,
} = require('../fal-video-model-catalog');

function isFaceCapableVideoModel(modelId) {
  return getVideoModelCapabilities(modelId).faceSafe === true;
}

function isTalkingHeadFallbackModel(modelId) {
  const caps = getVideoModelCapabilities(modelId);
  return Boolean(caps.faceSafe && caps.still && caps.userAudio && !caps.refVideo);
}

function isLikenessPolicyBlock(classified) {
  return classified && classified.code === 'fal_content_policy_violation';
}

function catalogIdForCapabilities(modelId) {
  const family = videoModelFamilyKey(modelId);
  const siblings = listFamilyVideoEndpoints(modelId);
  const textSibling = siblings.find((id) => (
    videoModelFamilyKey(id) === family && !/\/(image-to-video|reference-to-video)$/i.test(id)
  ));
  if (textSibling && getFalVideoModelDefinition(textSibling)) return textSibling;
  if (getFalVideoModelDefinition(modelId)) return normalizeFalVideoId(modelId);
  return siblings.find((id) => getFalVideoModelDefinition(id)) || normalizeFalVideoId(modelId);
}

function attachmentKeepScore(caps, { hasAudio = false, hasVideo = false } = {}) {
  if (!caps || !caps.still || !caps.faceSafe) return -1;
  if (caps.requiresAudio && !hasAudio) return -1;
  let score = 1;
  if (hasAudio && caps.userAudio) score += 2;
  if (hasVideo && caps.refVideo) score += 4;
  return score;
}

function collectEnabledFaceSafeCandidates(enabledCatalogNames = []) {
  const names = Array.isArray(enabledCatalogNames) ? enabledCatalogNames : [];
  const seen = new Set();
  const candidates = [];
  for (const name of names) {
    for (const id of listFamilyVideoEndpoints(name)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const caps = getVideoModelCapabilities(id);
      if (!caps.faceSafe || !caps.still) continue;
      candidates.push({ id, caps });
    }
  }
  return candidates;
}

function pickFaceCapableFallbackModel({
  currentEndpoint,
  enabledCatalogNames = [],
  alreadyFellBack = false,
  imageCount = 0,
  hasAudio = false,
  hasVideo = false,
} = {}) {
  if (alreadyFellBack) return null;
  if (Number(imageCount || 0) <= 0) return null;

  const needed = { hasAudio: Boolean(hasAudio), hasVideo: Boolean(hasVideo) };
  const candidates = collectEnabledFaceSafeCandidates(enabledCatalogNames);
  let best = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = attachmentKeepScore(candidate.caps, needed);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (!best || bestScore < 0) return null;

  const currentFamily = videoModelFamilyKey(currentEndpoint);
  if (currentFamily && currentFamily === videoModelFamilyKey(best.id)) return null;

  const catalogId = catalogIdForCapabilities(best.id);
  const definition = getFalVideoModelDefinition(catalogId);
  return {
    model: catalogId,
    displayName: definition && definition.displayName ? definition.displayName : formatFalVideoDisplayName(catalogId),
    reason: 'likeness_content_policy',
  };
}

function shouldFallbackLikeness({
  classified,
  currentEndpoint,
  enabledCatalogNames = [],
  alreadyFellBack = false,
  imageCount = 0,
  hasAudio = false,
  hasVideo = false,
} = {}) {
  if (!isLikenessPolicyBlock(classified)) return null;
  return pickFaceCapableFallbackModel({
    currentEndpoint,
    enabledCatalogNames,
    alreadyFellBack,
    imageCount,
    hasAudio,
    hasVideo,
  });
}

module.exports = {
  isFaceCapableVideoModel,
  isLikenessPolicyBlock,
  isTalkingHeadFallbackModel,
  pickFaceCapableFallbackModel,
  shouldFallbackLikeness,
  videoModelFamilyKey,
};
