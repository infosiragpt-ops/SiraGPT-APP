#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { redactString } = require('../src/utils/secret-redactor');

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on('line', (line) => {
  process.stdout.write(`${redactString(line, { maxLen: 2_000 })}\n`);
});
