const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const PizZip = require('pizzip');

test('document-service invokes pandoc without a shell and confines generated docs to a safe user directory', async () => {
  const childProcess = require('child_process');
  const originalExecSync = childProcess.execSync;
  const originalExecFile = childProcess.execFile;
  const resolved = require.resolve('../src/services/document-service');
  const previousModule = require.cache[resolved];
  const calls = [];
  const maliciousUserId = 'tenant";touch /tmp/siragpt-pandoc-pwned;"';
  const safeUserId = maliciousUserId.replace(/[^a-zA-Z0-9_.-]/g, '_');

  childProcess.execSync = () => Buffer.from('pandoc 3');
  childProcess.execFile = (file, args, _options, callback) => {
    calls.push({ file, args });
    const outputPath = args[args.indexOf('-o') + 1];
    const zip = new PizZip();
    zip.file('word/document.xml', '<w:document><w:body><w:tbl><w:tblPr></w:tblPr><w:tr><w:tc><w:tcPr></w:tcPr><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
    fs.writeFileSync(outputPath, zip.generate({ type: 'nodebuffer' }));
    callback(null, '', '');
  };
  delete require.cache[resolved];

  try {
    const { createDocument } = require('../src/services/document-service');
    const created = await createDocument(maliciousUserId, 'report";touch pwned;".docx', '# Report');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'pandoc');
    assert.ok(Array.isArray(calls[0].args));
    assert.ok(created.filePath.includes(safeUserId));
    assert.equal(fs.existsSync('/tmp/siragpt-pandoc-pwned'), false);
  } finally {
    childProcess.execSync = originalExecSync;
    childProcess.execFile = originalExecFile;
    if (previousModule) require.cache[resolved] = previousModule;
    else delete require.cache[resolved];
    await fsp.rm(path.join(__dirname, '../uploads/documents', safeUserId), { recursive: true, force: true });
    await fsp.rm('/tmp/siragpt-pandoc-pwned', { force: true });
  }
});
