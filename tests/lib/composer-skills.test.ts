import { describe, expect, it } from "vitest"

import {
  BUILTIN_COMPOSER_SKILLS,
  filterSkills,
  MAX_COMPOSER_SKILLS,
  toggleSkillSelection,
} from "@/lib/chat/use-composer-skills"

const [docx, pptx, xlsx, pdf] = BUILTIN_COMPOSER_SKILLS

describe("composer skills", () => {
  it("toggles a skill on and off", () => {
    const on = toggleSkillSelection([], docx)
    expect(on.map((s) => s.name)).toEqual(["docx"])
    expect(toggleSkillSelection(on, docx)).toEqual([])
  })

  it("keeps at most three skills, dropping the oldest", () => {
    let picked = [docx, pptx, xlsx]
    picked = toggleSkillSelection(picked, pdf)
    expect(picked).toHaveLength(MAX_COMPOSER_SKILLS)
    expect(picked.map((s) => s.name)).toEqual(["pptx", "xlsx", "pdf"])
  })

  it("filters by name, title or description, case-insensitively", () => {
    expect(filterSkills(BUILTIN_COMPOSER_SKILLS, "power").map((s) => s.name)).toEqual(["pptx"])
    expect(filterSkills(BUILTIN_COMPOSER_SKILLS, "XLSX").map((s) => s.name)).toEqual(["xlsx"])
    expect(filterSkills(BUILTIN_COMPOSER_SKILLS, "  ")).toHaveLength(BUILTIN_COMPOSER_SKILLS.length)
  })
})
