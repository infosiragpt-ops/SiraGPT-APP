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
} from "./api"

export { useAgentesCodingHealth } from "./health"
export {
  buildFileTree,
  languageFromPath,
  applyMapHints,
  type FileTreeNode,
} from "./file-tree"
