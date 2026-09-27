'use strict';

// Exercise the actual /agentes create_document + verify_artifact tools with
// two independent downloadable files. This is run in CI and in the final
// backend image, where pyreadstat must be present in the sandbox interpreter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-spss-artifacts-'));
process.env.AGENT_ARTIFACT_DIR = artifactDir;
const objectStorage = require('../src/services/object-storage');
const { INTERNAL } = require('../src/services/agents/task-tools');
const { resolveReadOnlyGeneratedArtifactFollowup } = require('../src/services/agents/generated-artifact-followup');

const data = [
  'columns = [f"P{i:02d}" for i in range(1, 21)]',
  'values = [[row * 100 + i for i in range(1, 21)] for row in range(20)]',
];

async function createAndVerify(filename, python, expectedFormat, events) {
  const result = await INTERNAL.createDocument.execute({ filename, python }, {
    userId: 'spss-runtime-smoke',
    chatId: 'spss-excel-pair',
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.ok, true, `${filename}: ${result.error || JSON.stringify(result.validation)}`);
  assert.equal(result.format, expectedFormat);
  assert.ok(result.artifactId);
  const verification = await INTERNAL.verifyArtifact.execute({ artifactId: result.artifactId }, {
    userId: 'spss-runtime-smoke',
    onEvent: (event) => events.push(event),
  });
  assert.equal(verification.ok, true, `${filename}: ${verification.error || 'verification failed'}`);
  return { result, verification };
}

(async () => {
  const events = [];
  const sav = await createAndVerify('muestra-20x20.sav', [
    'import os, pandas as pd, pyreadstat',
    ...data,
    'frame = pd.DataFrame(values, columns=columns)',
    'pyreadstat.write_sav(frame, os.environ["OUT_PATH"], column_labels={name: f"Pregunta {i}" for i, name in enumerate(columns, 1)})',
  ].join('\n'), 'sav', events);
  assert.equal(sav.verification.rowCount, 20);
  assert.equal(sav.verification.columnCount, 20);
  assert.deepEqual(sav.verification.columns, Array.from({ length: 20 }, (_, index) => `P${String(index + 1).padStart(2, '0')}`));

  const excel = await createAndVerify('muestra-20x20.xlsx', [
    'import os',
    'from openpyxl import Workbook',
    'from openpyxl.styles import Font, PatternFill',
    ...data,
    'workbook = Workbook()',
    'sheet = workbook.active',
    'sheet.title = "Muestra"',
    'sheet.append(columns)',
    'for row in values: sheet.append(row)',
    'sheet.freeze_panes = "A2"',
    'sheet.auto_filter.ref = sheet.dimensions',
    'for cell in sheet[1]:',
    '    cell.font = Font(color="FFFFFF", bold=True)',
    '    cell.fill = PatternFill("solid", fgColor="0F172A")',
    'for letter in "ABCDEFGHIJKLMNOPQRST": sheet.column_dimensions[letter].width = 14',
    'workbook.save(os.environ["OUT_PATH"])',
  ].join('\n'), 'xlsx', events);
  assert.notEqual(sav.result.artifactId, excel.result.artifactId);
  assert.ok(excel.verification.sheets?.some((sheet) => sheet.name === 'Muestra' && sheet.rows === 21 && sheet.columns === 20));
  assert.equal(events.filter((event) => event.type === 'file_artifact').length, 2);

  // Simulate production R2 offload: the sidecars and DB rows remain, but the
  // original VM paths disappear. A follow-up with files:[] must recover both
  // files from the same delivery, then pyreadstat/openpyxl must compare bytes.
  const saved = [excel.result, sav.result];
  const binaries = new Map();
  for (const artifact of saved) {
    const metadataPath = INTERNAL.metadataPathFor(artifact.artifactId);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const binaryPath = path.join(artifactDir, metadata.storedRelPath);
    binaries.set(artifact.artifactId, {
      bytes: fs.readFileSync(binaryPath),
      format: artifact.format,
    });
    metadata.storageRef = `mock://${artifact.artifactId}`;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    fs.rmSync(binaryPath);
  }
  objectStorage.toLocalTemp = async (ref) => {
    const id = String(ref).split('/').at(-1);
    const binary = binaries.get(id);
    if (!binary) throw new Error('missing offloaded artifact');
    // Match objectStorage.toLocalTemp, which retains the binary extension.
    const destination = path.join(artifactDir, `hydrated-${id}.${binary.format}`);
    fs.writeFileSync(destination, binary.bytes);
    return { path: destination, cleanup: async () => fs.rmSync(destination, { force: true }) };
  };
  const records = saved.map((artifact, index) => ({
    id: artifact.artifactId,
    filename: artifact.filename,
    format: artifact.format,
    taskId: 'same-generation-turn',
    createdAt: new Date(Date.now() - index * 1000),
  }));
  const prisma = { generatedArtifact: { findMany: async ({ where }) => {
    assert.deepEqual(where, { userId: 'spss-runtime-smoke', chatId: 'spss-excel-pair' });
    return records;
  } } };
  const refs = await resolveReadOnlyGeneratedArtifactFollowup(prisma, {
    userId: 'spss-runtime-smoke',
    chatId: 'spss-excel-pair',
    providedFileIds: [],
    goal: 'Sin crear ni modificar: abre y compara el SAV y el Excel que acabas de entregar; verifica los 400 valores.',
  });
  assert.equal(refs.length, 2);
  const comparisonSource = [
      'import json, pyreadstat',
      'from openpyxl import load_workbook',
      'files = list(ARTIFACT_FILES.values())',
      'sav_path = next(item["path"] for item in files if item["filename"].endswith(".sav"))',
      'xlsx_path = next(item["path"] for item in files if item["filename"].endswith(".xlsx"))',
      'frame, metadata = pyreadstat.read_sav(sav_path)',
      'book = load_workbook(xlsx_path, read_only=True, data_only=True)',
      'sheet = book["Muestra"]',
      'headers = [cell.value for cell in sheet[1]]',
      'values = list(sheet.iter_rows(min_row=2, values_only=True))',
      'mismatches = sum(frame.iloc[row, col] != values[row][headers.index(name)] for row in range(20) for col, name in enumerate(frame.columns))',
      'result = {"savShape": list(frame.shape), "excelShape": [len(values), len(headers)], "mismatches": int(mismatches), "labelCount": sum(bool(label) for label in metadata.column_labels)}',
      'book.close()',
      'print(json.dumps(result))',
    ].join('\n');
  const compared = await INTERNAL.pythonExec.execute({
    timeoutMs: 30000,
    source: comparisonSource,
  }, {
    userId: 'spss-runtime-smoke',
    chatId: 'spss-excel-pair',
    generatedArtifactRefs: refs,
  });
  assert.equal(compared.ok, true, compared.stderr || compared.error);
  assert.deepEqual(JSON.parse(compared.stdout.trim().split('\n').at(-1)), {
    savShape: [20, 20], excelShape: [20, 20], mismatches: 0, labelCount: 20,
  });
  // The real /agentes route enters agentic-chat-stream, not /api/agent/task.
  // Reopen the same saved delivery with files:[] through that chat runner and
  // prove its first model-selected tool sees both R2-hydrated binaries.
  const cards = saved.map((artifact) => ({ id: artifact.artifactId, filename: artifact.filename }));
  const chatPrisma = {
    generatedArtifact: { findMany: async () => [] },
    chat: { findFirst: async ({ where }) => where.userId === 'spss-runtime-smoke' && where.id === 'spss-excel-pair' ? { id: where.id } : null },
    message: { findMany: async () => [{
      id: 'delivery-message',
      content: '```agent-task-state\n' + JSON.stringify({ artifacts: cards, done: true }) + '\n```\n\nArchivos listos.',
    }] },
  };
  const response = new PassThrough();
  response.on('data', () => {});
  response.flushHeaders = () => {};
  response.setHeader = () => {};
  let firstToolChoice = null;
  let calls = 0;
  const selectedModel = { chat: { completions: { create: async (args) => {
    if (calls++ === 0) {
      firstToolChoice = args.tool_choice;
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
        id: 'compare-pair', type: 'function', function: { name: 'python_exec', arguments: JSON.stringify({ source: comparisonSource, timeoutMs: 30000 }) },
      }] } }] };
    }
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
      id: 'finish', type: 'function', function: { name: 'finalize', arguments: JSON.stringify({ answer: 'Comparé las 20 preguntas en los 20 registros: 400 de 400 valores coinciden.', confidence: 'high' }) },
    }] } }] };
  } } } };
  const chatRun = await require('../src/services/agentic-chat-stream').runAgenticChat({
    openai: selectedModel,
    model: 'grok-4.7', provider: 'xAI',
    userQuery: 'Abre el SAV y Excel que acabas de generar y compara los 400 valores',
    history: [], res: response, maxSteps: 3,
    selection: { decision: { intent: 'data_analysis' }, signals: { hasFiles: false } },
    toolContext: { userId: 'spss-runtime-smoke', chatId: 'spss-excel-pair', fileIds: [], prisma: chatPrisma },
  });
  assert.equal(firstToolChoice?.function?.name, 'python_exec');
  const chatRead = chatRun.steps.find((step) => step.actions?.some((action) => action.tool === 'python_exec'));
  const chatOutput = chatRead?.actions?.find((action) => action.tool === 'python_exec')?.observation;
  assert.equal(chatOutput?.ok, true, chatOutput?.stderr || 'chat did not read both files');
  assert.deepEqual(JSON.parse(chatOutput.stdout.trim().split('\n').at(-1)), {
    savShape: [20, 20], excelShape: [20, 20], mismatches: 0, labelCount: 20,
  });
  assert.match(chatRun.finalAnswer, /400 de 400 valores coinciden/);
  process.stdout.write('create_document + normal-chat follow-up: R2-hydrated SAV/XLSX 20 x 20 and 400 values verified\n');
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}).finally(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
