export {
  agentesCodingApi,
  createAgentesCodingApi,
  parseHealthEnabled,
  shouldMountAgentesCodingIde,
  AgentesCodingApiError,
  type AgentesCodingHealth,
  type CodingSession,
  type CodingFileEntry,
  type CodingExecResult,
  type CodingRepoMapHint,
  type CodingRepoMap,
  type CodingStructMatch,
  type CodingStructDiff,
  type CodingStructPreview,
  type CodingStructApply,
} from "./api"

export { useAgentesCodingHealth } from "./health"
export {
  buildFileTree,
  languageFromPath,
  applyMapHints,
  type FileTreeNode,
} from "./file-tree"
