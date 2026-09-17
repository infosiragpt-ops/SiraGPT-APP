'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skillsRegistry = require('../src/services/skills-registry');
const {
  FOLDER_CAPABILITY_MAP,
  UPSTREAM_TO_SIRAGPT_SKILLS,
  UPSTREAM_REFERENCE_ONLY_SKILLS,
  parseSkillMarkdown,
  loadInstructionSkills,
  buildOpenClawIntegrationMap,
  recommendAdaptedPlaybooks,
} = require('../src/services/agents/openclaw-playbook-bridge');

test('parseSkillMarkdown reads simple frontmatter and body', () => {
  const parsed = parseSkillMarkdown('---\nname: demo\ndescription: Demo skill\n---\n# Body\nText');
  assert.equal(parsed.frontmatter.name, 'demo');
  assert.equal(parsed.frontmatter.description, 'Demo skill');
  assert.match(parsed.body, /# Body/);
});

test('loadInstructionSkills lists SKILL.md folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-skill-'));
  fs.mkdirSync(path.join(dir, 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha\n---\n# Alpha\n');

  const skills = loadInstructionSkills(dir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, 'alpha');
  assert.equal(skills[0].description, 'Alpha');
});

test('folder capability map covers major OpenClaw source areas', () => {
  const folders = new Set(FOLDER_CAPABILITY_MAP.map((entry) => entry.openclaw));
  for (const expected of ['.agents', '.claude', '.github', 'changelog/fragments', 'examples', 'extensions', 'git-hooks', 'patches', 'security', 'src', 'test', 'ui', 'root-config']) {
    assert.ok(folders.has(expected), `expected folder map for ${expected}`);
  }
});

test('upstream skills map to active SiraGPT playbooks', () => {
  assert.deepEqual(UPSTREAM_TO_SIRAGPT_SKILLS['agent-transcript'], ['agent-transcript-lite']);
  assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS['openclaw-testing'].includes('qa-smoke-testing'));
  assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS['channel-message-flows'].includes('channel-connector-hardening'));
  assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS['verify-release'].includes('quality-gates'));
  assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS['openclaw-changelog-update'].includes('technical-docs'));
  assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS['auto-qa'].includes('e2e-proof-recorder'));
  assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS['claw-score'].includes('agent-capability-matrix'));
  assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS['openclaw-ci-limits'].includes('ci-orchestrator'));
  assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS['openclaw-live-updater'].includes('release-maintainer'));
  assert.ok(UPSTREAM_REFERENCE_ONLY_SKILLS.includes('discord-user-post'));
});

test('buildOpenClawIntegrationMap reports copied upstream and rewritten SiraGPT skills', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const matrix = buildOpenClawIntegrationMap({ repoRoot });

  assert.equal(matrix.source.license, 'MIT');
  assert.ok(matrix.counts.upstreamSkills >= 30, 'OpenClaw snapshot should include copied skills');
  assert.ok(matrix.counts.siraSkills >= 20, 'SiraGPT should include active rewritten skills');
  assert.ok(matrix.counts.coverage.covered >= 20, 'most upstream skills should have SiraGPT coverage');
  assert.ok(matrix.skills.some((skill) => skill.upstream === 'openclaw-debugging' && skill.availableSkills.includes('runtime-debugging')));
});

test('recommendAdaptedPlaybooks returns SiraGPT-native skills for OpenClaw-flavored requests', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const recs = recommendAdaptedPlaybooks('copiar openclaw skills con licencia y adaptar carpetas agentes', { repoRoot });
  const adapted = new Set(recs.flatMap((rec) => rec.adaptedSkills));

  assert.ok(adapted.has('openclaw-import-audit'));
  assert.ok(adapted.has('repo-folder-integration') || adapted.has('agent-capability-matrix'));
});

test('buildOpenClawIntegrationMap can audit a live external root without activating code', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-live-audit-'));
  fs.mkdirSync(path.join(dir, '.agents', 'skills', 'verify-release'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'weather'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', 'skills', 'verify-release', 'SKILL.md'), '---\nname: verify-release\ndescription: Verify release gates\n---\n# Verify\n');
  fs.writeFileSync(path.join(dir, 'skills', 'weather', 'SKILL.md'), '---\nname: weather\ndescription: Weather skill\n---\n# Weather\n');
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {};\n');

  const matrix = buildOpenClawIntegrationMap({
    repoRoot,
    upstreamRepoRoot: dir,
    upstreamCommit: 'testsha',
  });

  assert.equal(matrix.source.snapshot, 'external-reference-only');
  assert.equal(matrix.source.audit_root, dir);
  assert.equal(matrix.source.commit, 'testsha');
  assert.equal(matrix.counts.upstreamSkills, 1);
  assert.equal(matrix.counts.upstreamPublicSkills, 1);
  assert.equal(matrix.counts.publicSkillCoverage.covered, 1);
  assert.ok(matrix.skills.some((skill) => skill.upstream === 'verify-release' && skill.availableSkills.includes('quality-gates')));
  assert.ok(matrix.public_skills.some((skill) => skill.upstream === 'weather' && skill.status === 'covered'));
  assert.ok(matrix.folders.some((folder) => folder.openclaw === 'src' && folder.upstream_file_count === 1));
});

test('buildOpenClawIntegrationMap audits an exact Git tree without checkout materialization', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-git-map-'));
  fs.mkdirSync(path.join(dir, '.agents', 'skills', 'auto-qa'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.agents', 'skills', 'discord-user-post'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'weather'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'future-surface'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', 'skills', 'auto-qa', 'SKILL.md'), '---\nname: auto-qa\ndescription: Autonomous QA\n---\n# Auto QA\n');
  fs.writeFileSync(path.join(dir, '.agents', 'skills', 'discord-user-post', 'SKILL.md'), '---\nname: discord-user-post\ndescription: Direct user post\n---\n# User post\n');
  fs.writeFileSync(path.join(dir, 'skills', 'weather', 'SKILL.md'), '---\nname: weather\ndescription: Weather skill\n---\n# Weather\n');
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(dir, 'future-surface', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT License\n');

  const childProcess = require('child_process');
  childProcess.execFileSync('git', ['init', '-q', dir]);
  childProcess.execFileSync('git', ['-C', dir, 'config', 'user.email', 'audit@example.invalid']);
  childProcess.execFileSync('git', ['-C', dir, 'config', 'user.name', 'Audit Test']);
  childProcess.execFileSync('git', ['-C', dir, 'add', '.']);
  childProcess.execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'fixture']);
  const commit = childProcess.execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  fs.rmSync(path.join(dir, '.agents'), { recursive: true });
  fs.rmSync(path.join(dir, 'skills'), { recursive: true });
  fs.rmSync(path.join(dir, 'src'), { recursive: true });
  fs.rmSync(path.join(dir, 'future-surface'), { recursive: true });

  const matrix = buildOpenClawIntegrationMap({
    repoRoot,
    upstreamRepoRoot: dir,
    upstreamCommit: commit,
    requireGitTree: true,
  });

  assert.equal(matrix.source.commit, commit);
  assert.equal(matrix.source.inventory_mode, 'git_tree');
  assert.equal(matrix.source.tracked_files, 6);
  assert.equal(matrix.source.inventory_coverage_percent, 100);
  assert.equal(matrix.counts.upstreamSkills, 2);
  assert.equal(matrix.counts.upstreamPublicSkills, 1);
  assert.equal(matrix.counts.unmappedFolders, 1);
  assert.ok(matrix.skills.some((skill) => skill.upstream === 'auto-qa' && skill.status === 'covered'));
  assert.ok(matrix.skills.some((skill) => skill.upstream === 'discord-user-post' && skill.status === 'reference-only'));
  assert.ok(matrix.public_skills.some((skill) => skill.upstream === 'weather' && skill.status === 'covered'));
  assert.ok(matrix.folders.some((folder) => folder.openclaw === 'src' && folder.upstream_file_count === 1));
  assert.ok(matrix.folders.some((folder) => folder.openclaw === 'future-surface' && folder.status === 'unknown'));
});

test('recommendAdaptedPlaybooks includes native public capabilities', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-public-recommend-'));
  fs.mkdirSync(path.join(dir, '.agents', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'summarize'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'summarize', 'SKILL.md'), '---\nname: summarize\ndescription: Summarize URLs and files\n---\n# Summarize\n');
  const matrix = buildOpenClawIntegrationMap({ repoRoot, upstreamRepoRoot: dir });
  const recs = recommendAdaptedPlaybooks('summarize este archivo', { matrix });
  assert.ok(recs.some((rec) => rec.upstream === 'summarize' && rec.adaptedSkills.includes('summarize')));
});

test('legacy skill registry exposes OpenClaw playbook import for runtime recommendation', () => {
  const skill = skillsRegistry.getSkill('openclaw_playbook_import');
  assert.ok(skill);
  assert.equal(skill.label, 'OpenClaw Native Rewrite + Adaptation');
  assert.ok(skill.tools.includes('skill_manifest_map'));
  assert.ok(skill.tools.includes('upstream_reference_audit'));

  const recs = skillsRegistry.recommendSkills('openclaw agent skills import', {
    userClearance: 'enterprise',
    limit: 5,
  });
  assert.ok(recs.some((candidate) => candidate.id === 'openclaw_playbook_import'));
});
