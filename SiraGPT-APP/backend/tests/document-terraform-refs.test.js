'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-terraform-refs');
const { extractTerraformRefs, buildTerraformRefsForFiles, renderTerraformRefsBlock } = engine;

const HCL = `
resource "aws_instance" "web" {
  ami = data.aws_ami.ubuntu.id
  instance_type = var.instance_type
}

data "aws_ami" "ubuntu" {
  owners = ["099720109477"]
}

module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
}

variable "region" {
  default = "us-east-1"
}

output "url" {
  value = module.vpc.public_url
}
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractTerraformRefs('').total, 0);
  assert.equal(extractTerraformRefs(null).total, 0);
});

test('detects resource declaration', () => {
  const r = extractTerraformRefs(HCL);
  assert.ok(r.entries.some((e) => e.kind === 'resource' && /aws_instance\.web/.test(e.fqn)));
});

test('detects data source', () => {
  const r = extractTerraformRefs(HCL);
  assert.ok(r.entries.some((e) => e.kind === 'data' && /aws_ami\.ubuntu/.test(e.fqn)));
});

test('detects module declaration', () => {
  const r = extractTerraformRefs(HCL);
  assert.ok(r.entries.some((e) => e.kind === 'module' && e.name === 'vpc'));
});

test('detects variable declaration', () => {
  const r = extractTerraformRefs(HCL);
  assert.ok(r.entries.some((e) => e.kind === 'variable' && e.name === 'region'));
});

test('detects output declaration', () => {
  const r = extractTerraformRefs(HCL);
  assert.ok(r.entries.some((e) => e.kind === 'output' && e.name === 'url'));
});

test('detects var.X reference', () => {
  const r = extractTerraformRefs('value = var.region');
  assert.ok(r.entries.some((e) => e.kind === 'ref' && /var\.region/.test(e.fqn)));
});

test('detects module.X.Y reference', () => {
  const r = extractTerraformRefs('value = module.vpc.public_url');
  assert.ok(r.entries.some((e) => e.kind === 'ref' && /module\.vpc/.test(e.fqn)));
});

test('detects data.X.Y reference', () => {
  const r = extractTerraformRefs('ami = data.aws_ami.ubuntu.id');
  assert.ok(r.entries.some((e) => e.kind === 'ref' && /data\.aws_ami/.test(e.fqn)));
});

test('dedupes identical declarations', () => {
  const r = extractTerraformRefs('module "vpc" { } module "vpc" { }');
  assert.equal(r.entries.filter((e) => e.kind === 'module' && e.name === 'vpc').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `module "mod${i}" { source = "x" }\n`;
  const r = extractTerraformRefs(text);
  assert.ok(r.entries.length <= 20);
});

test('counts totals by kind', () => {
  const r = extractTerraformRefs(HCL);
  assert.ok(r.totals.resource >= 1);
  assert.ok(r.totals.data >= 1);
  assert.ok(r.totals.module >= 1);
  assert.ok(r.totals.variable >= 1);
  assert.ok(r.totals.output >= 1);
});

test('buildTerraformRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.tf', extractedText: 'module "vpc" { }' },
    { name: 'b.tf', extractedText: 'variable "region" { }' },
  ];
  const r = buildTerraformRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTerraformRefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'main.tf', extractedText: HCL }];
  const r = buildTerraformRefsForFiles(files);
  const md = renderTerraformRefsBlock(r);
  assert.match(md, /^## TERRAFORM/);
});

test('renderTerraformRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderTerraformRefsBlock({ perFile: [] }), '');
  assert.equal(renderTerraformRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTerraformRefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'module "vpc" { }' },
  ]);
  assert.equal(r.perFile.length, 1);
});
