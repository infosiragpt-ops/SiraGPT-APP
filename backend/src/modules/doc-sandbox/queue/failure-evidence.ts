import { DocSandboxError } from '../types/errors';

export interface FailureEvidenceMetadata {
  readonly kind: string;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
}
export type FailureEvidenceMode = Readonly<{ kind: 'single' } | { kind: 'preservation'; groups: number }>;

const MAX_PER_GROUP = 1001;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_GROUP_BYTES = 16 * 1024 * 1024;

/** Metadata admission only: callers verify bytes/hashes and storage ownership.
 * The mode is selected by the worker, never inferred from the number of uploads.
 * Preservation may retain only the reports completed before a later child failed. */
export function validateFailureEvidence(artifacts: readonly FailureEvidenceMetadata[], mode: FailureEvidenceMode): void {
  const reject = (): never => { throw new DocSandboxError('E_VALIDATION', 422); };
  if (!mode || typeof mode !== 'object' || (mode.kind !== 'single' && mode.kind !== 'preservation')) reject();
  const groups = mode.kind === 'single' ? 1 : mode.groups;
  if (!Number.isSafeInteger(groups) || groups < 1 || groups > 10 || !Array.isArray(artifacts)
    || artifacts.length > groups * MAX_PER_GROUP) reject();
  const names = new Set<string>();
  const counts = Array<number>(groups).fill(0);
  const bytes = Array<number>(groups).fill(0);
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object' || typeof artifact.filename !== 'string'
      || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > MAX_ARTIFACT_BYTES) reject();
    let filename = artifact.filename;
    let group = 0;
    if (mode.kind === 'preservation') {
      const match = /^input-([0-9])-(.+)$/.exec(filename) ?? reject();
      group = Number(match[1]);
      filename = match[2]!;
      if (group >= groups) reject();
    }
    if (!/^(?:text-diff\.json|(?:before|after)-(?:notes-)?\d+\.png)$/.test(filename)) reject();
    const kind = filename === 'text-diff.json' ? 'text_diff'
      : filename.startsWith('before-') ? 'thumbnail_before' : 'thumbnail_after';
    const mime = kind === 'text_diff' ? 'application/json' : 'image/png';
    if (artifact.kind !== kind || artifact.mime !== mime || names.has(artifact.filename)) reject();
    names.add(artifact.filename);
    counts[group] = counts[group]! + 1;
    bytes[group] = bytes[group]! + artifact.size;
    if (counts[group]! > MAX_PER_GROUP || bytes[group]! > MAX_GROUP_BYTES) reject();
  }
}
