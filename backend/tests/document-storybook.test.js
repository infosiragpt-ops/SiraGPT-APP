'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-storybook');
const { extractStorybook, buildStorybookForFiles, renderStorybookBlock, _internal } = engine;
const { isStorybookLike } = _internal;

const SB_FIXTURE = `import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
  title: 'UI/Button',
  component: Button,
  parameters: {
    layout: 'centered',
  },
  args: {
    onClick: fn(),
    label: 'Click me',
  },
  argTypes: {
    variant: { control: 'select', options: ['primary', 'secondary'] },
  },
  decorators: [
    (Story) => <ThemeProvider>{Story()}</ThemeProvider>,
  ],
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {
  args: { variant: 'primary' },
};

export const Secondary: Story = {
  args: { variant: 'secondary' },
};

export const WithPlay: Story = {
  args: { label: 'Submit' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button'));
  },
};
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractStorybook('').total, 0);
  assert.equal(extractStorybook(null).total, 0);
});

test('non-Storybook text returns empty', () => {
  const r = extractStorybook('Just regular code without storybook');
  assert.equal(r.total, 0);
});

test('isStorybookLike heuristic', () => {
  assert.ok(isStorybookLike('import { Meta } from "@storybook/react"'));
  assert.ok(isStorybookLike('export const X: Story = {}'));
  assert.ok(!isStorybookLike('plain text'));
});

test('detects default export meta', () => {
  const r = extractStorybook(SB_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'meta'));
});

test('detects title field', () => {
  const r = extractStorybook(SB_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'title' && e.name === 'UI/Button'));
});

test('detects component reference', () => {
  const r = extractStorybook(SB_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'component' && e.name === 'Button'));
});

test('detects story exports', () => {
  const r = extractStorybook(SB_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'story' && e.name === 'Primary'));
  assert.ok(r.entries.some((e) => e.kind === 'story' && e.name === 'Secondary'));
  assert.ok(r.entries.some((e) => e.kind === 'story' && e.name === 'WithPlay'));
});

test('counts args / argTypes / parameters / decorators blocks', () => {
  const r = extractStorybook(SB_FIXTURE);
  assert.ok(r.totals.args >= 1);
  assert.ok(r.totals.argTypes >= 1);
  assert.ok(r.totals.parameters >= 1);
  assert.ok(r.totals.decorators >= 1);
});

test('detects play function', () => {
  const r = extractStorybook(SB_FIXTURE);
  assert.ok(r.totals.play >= 1);
});

test('detects @storybook/X imports', () => {
  const r = extractStorybook(SB_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'sbImport' && e.name === '@storybook/react'));
  assert.ok(r.entries.some((e) => e.kind === 'sbImport' && e.name === '@storybook/test'));
});

test('dedupes identical story exports', () => {
  const r = extractStorybook('export const X: Story = {}; export const X: Story = {};');
  assert.equal(r.entries.filter((e) => e.kind === 'story' && e.name === 'X').length, 1);
});

test('caps entries per file', () => {
  let text = `import { Meta } from '@storybook/react';\n`;
  for (let i = 0; i < 30; i++) text += `export const S${i}: Story = {};\n`;
  const r = extractStorybook(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractStorybook(SB_FIXTURE);
  assert.ok(r.totals.story >= 3);
  assert.ok(r.totals.sbImport >= 1);
});

test('buildStorybookForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.stories.tsx', extractedText: SB_FIXTURE },
    { name: 'b.stories.tsx', extractedText: 'import { Meta } from "@storybook/react"; export const X: Story = {};' },
  ];
  const r = buildStorybookForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderStorybookBlock returns markdown when entries exist', () => {
  const files = [{ name: 'Button.stories.tsx', extractedText: SB_FIXTURE }];
  const r = buildStorybookForFiles(files);
  const md = renderStorybookBlock(r);
  assert.match(md, /^## STORYBOOK/);
});

test('renderStorybookBlock empty when nothing surfaces', () => {
  assert.equal(renderStorybookBlock({ perFile: [] }), '');
  assert.equal(renderStorybookBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildStorybookForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: SB_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
