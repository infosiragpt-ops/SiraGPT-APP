'use strict';

/**
 * CrewAI Python bridge — optional Python subprocess adapter.
 *
 * When SIRAGPT_MULTI_AGENT_FRAMEWORK=crewai and the `crewai` Python
 * package is installed, this bridge delegates multi-agent workflows
 * to CrewAI (github.com/crewAIInc/crewAI) via a JSON-RPC-style
 * subprocess protocol.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CREWAI_SCRIPT = process.env.CREWAI_BRIDGE_SCRIPT || path.join(__dirname, '..', '..', '..', '..', 'infra', 'crewai', 'bridge.py');

function crewaiAvailable() {
  return new Promise((resolve) => {
    execFile('python3', ['-c', 'import crewai; print(crewai.__version__)'], { timeout: 8000 }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

function isCrewAIEnabled(env = process.env) {
  return env.SIRAGPT_MULTI_AGENT_FRAMEWORK === 'crewai';
}

async function runCrewAIWorkflow({ agents = [], task, mode = 'sequential' } = {}) {
  if (!agents.length) throw new Error('CrewAI workflow requires at least one agent');

  const input = JSON.stringify({ agents, task, mode });
  const inputFile = path.join(os.tmpdir(), `crewai-input-${Date.now()}.json`);
  const outputFile = path.join(os.tmpdir(), `crewai-output-${Date.now()}.json`);
  fs.writeFileSync(inputFile, input);

  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [CREWAI_SCRIPT, '--input', inputFile, '--output', outputFile],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
      (err) => {
        try {
          if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
          if (fs.existsSync(outputFile)) {
            const result = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
            fs.unlinkSync(outputFile);
            if (err) return resolve({ error: err.message, partial: result });
            return resolve(result);
          }
          if (err) return reject(err);
          resolve({ error: 'No output from CrewAI bridge' });
        } catch (parseErr) {
          if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
          if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
          reject(parseErr);
        }
      },
    );
  });
}

function createCrewAIBridge({ env = process.env } = {}) {
  const enabled = isCrewAIEnabled(env);
  return {
    enabled,
    available: crewaiAvailable,
    run: runCrewAIWorkflow,
    status() {
      return { framework: 'crewai', enabled, bridgeScript: CREWAI_SCRIPT };
    },
  };
}

module.exports = { createCrewAIBridge, crewaiAvailable, isCrewAIEnabled, runCrewAIWorkflow };
