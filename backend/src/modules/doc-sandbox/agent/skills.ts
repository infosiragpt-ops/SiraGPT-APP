/** Hosted skills only. No source-available document skill code is vendored here. */
export type HostedSkillId = 'docx' | 'pdf' | 'pptx' | 'xlsx';
export interface HostedSkill {
  type: 'anthropic';
  skill_id: HostedSkillId;
  version: string;
}

export function hostedSkillsForFormats(
  formats: readonly string[],
  versions: Readonly<Partial<Record<HostedSkillId, string>>>,
): HostedSkill[] {
  const ids = new Set<HostedSkillId>();
  for (const format of formats) {
    if (format === 'docx' || format === 'xlsx' || format === 'pptx' || format === 'pdf') ids.add(format);
    else if (!['txt', 'md', 'csv', 'json', 'html'].includes(format)) {
      throw new Error('DOC_ENGINE_FORMAT_UNSUPPORTED');
    }
  }
  return [...ids].sort().map((skill_id) => {
    const version = versions[skill_id];
    if (!version || version === 'latest' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(version)) {
      throw new Error('DOC_ENGINE_SKILL_VERSION_REQUIRED');
    }
    return { type: 'anthropic', skill_id, version };
  });
}
