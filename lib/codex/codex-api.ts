// codex/codex-api — stable typed facade for the Codex Agent V2 backend.
// Domain implementations live in ./api/*; all existing exports remain available
// from this module so callers do not need to migrate.

import { checkpointsCodexApi } from "./api/checkpoints"
import { companyCodexApi } from "./api/company"
import { companyAssociationsCodexApi } from "./api/company-associations"
import { coreCodexApi } from "./api/core"
import { projectsCodexApi } from "./api/projects"
import { publicationCodexApi } from "./api/publication"
import { runsCodexApi } from "./api/runs"
import { swarmsCodexApi } from "./api/swarms"

export { codexErrorCode, codexIdentityIssue } from "./api/core"

export * from "./api/types"

export const codexApi = {
  ...coreCodexApi,
  ...companyAssociationsCodexApi,
  ...projectsCodexApi,
  ...companyCodexApi,
  ...swarmsCodexApi,
  ...runsCodexApi,
  ...checkpointsCodexApi,
  ...publicationCodexApi,
} as const
