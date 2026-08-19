'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-terraform-vars');
const { extractTerraformVars, buildTerraformVarsForFiles, renderTerraformVarsBlock, _internal } = engine;
const { isTerraformLike } = _internal;

const TF_FIXTURE = `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
    }
  }
  backend "s3" {
    bucket = "my-tf-state"
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "instance_count" {
  type    = number
  default = 3
}

locals {
  common_tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

data "aws_caller_identity" "current" {}

resource "aws_instance" "web" {
  count         = var.instance_count
  ami           = data.aws_caller_identity.current.account_id
  instance_type = "t3.micro"
  tags          = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  for_each = toset(["a", "b"])
}

output "instance_id" {
  value = aws_instance.web.id
}

output "vpc_id" {
  value = module.vpc.vpc_id
}`;

test('empty / non-string tolerated', () => {
  assert.equal(extractTerraformVars('').total, 0);
  assert.equal(extractTerraformVars(null).total, 0);
});

test('non-Terraform text returns empty', () => {
  const r = extractTerraformVars('Just regular text without HCL markers');
  assert.equal(r.total, 0);
});

test('isTerraformLike heuristic', () => {
  assert.ok(isTerraformLike('variable "x" {}'));
  assert.ok(isTerraformLike('var.region'));
  assert.ok(!isTerraformLike('plain text'));
});

test('detects variable blocks', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'variable' && e.name === 'region'));
  assert.ok(r.entries.some((e) => e.kind === 'variable' && e.name === 'instance_count'));
});

test('detects output blocks', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'output' && e.name === 'instance_id'));
  assert.ok(r.entries.some((e) => e.kind === 'output' && e.name === 'vpc_id'));
});

test('detects resource blocks', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'resource' && e.name === 'aws_instance.web'));
});

test('detects data blocks', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'data' && e.name === 'aws_caller_identity.current'));
});

test('detects module blocks', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'module' && e.name === 'vpc'));
});

test('counts locals blocks', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.totals.locals >= 1);
});

test('detects var.X references', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'varRef' && e.name === 'var.instance_count'));
});

test('detects local.X references', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'localRef' && e.name === 'local.common_tags'));
});

test('detects data.X.Y references', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'dataRef' && /aws_caller_identity\.current/.test(e.name)));
});

test('detects module.X references', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'moduleRef' && e.name === 'module.vpc'));
});

test('detects meta-arguments count / for_each / lifecycle', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'metaArg' && e.name === 'count'));
  assert.ok(r.entries.some((e) => e.kind === 'metaArg' && e.name === 'for_each'));
  assert.ok(r.entries.some((e) => e.kind === 'metaArg' && e.name === 'lifecycle'));
});

test('detects backend block', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'backend' && e.name === 's3'));
});

test('detects required_providers', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'requiredProvider' && e.name === 'aws'));
});

test('dedupes identical resources', () => {
  const r = extractTerraformVars('resource "aws_s3_bucket" "x" {} resource "aws_s3_bucket" "x" {}');
  assert.equal(r.entries.filter((e) => e.kind === 'resource' && e.name === 'aws_s3_bucket.x').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `variable "v${i}" {} `;
  const r = extractTerraformVars(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractTerraformVars(TF_FIXTURE);
  assert.ok(r.totals.variable >= 2);
  assert.ok(r.totals.resource >= 1);
  assert.ok(r.totals.output >= 2);
});

test('buildTerraformVarsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.tf', extractedText: 'variable "x" {} resource "r" "n" {}' },
    { name: 'b.tf', extractedText: 'output "y" { value = var.x }' },
  ];
  const r = buildTerraformVarsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTerraformVarsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'main.tf', extractedText: TF_FIXTURE }];
  const r = buildTerraformVarsForFiles(files);
  const md = renderTerraformVarsBlock(r);
  assert.match(md, /^## TERRAFORM/);
});

test('renderTerraformVarsBlock empty when nothing surfaces', () => {
  assert.equal(renderTerraformVarsBlock({ perFile: [] }), '');
  assert.equal(renderTerraformVarsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTerraformVarsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: TF_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
