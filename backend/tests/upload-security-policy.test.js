const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isDeclaredUploadAllowed,
  shouldForceDownload,
  isOfficeTemporaryLockFile,
  mimeMatchesExtension,
  resolveUploadLimits,
  validateUploadPolicy,
  isMediaMime,
  DEFAULT_MAX_MEDIA_UPLOAD_MB,
} = require('../src/services/upload-security-policy');

test('upload policy accepts extension fallback for octet-stream browser uploads', () => {
  assert.equal(isDeclaredUploadAllowed({
    originalname: 'report.pdf',
    mimetype: 'application/octet-stream',
  }), true);

  const result = validateUploadPolicy({
    originalName: 'report.pdf',
    declaredMime: 'application/octet-stream',
    detectedMime: 'application/pdf',
    detectionSource: 'magic-bytes',
    size: 1024,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'application/pdf');
});

test('upload policy canonicalizes xlsx browser/zip uploads for extraction', () => {
  const zipDetected = validateUploadPolicy({
    originalName: 'base_sucesion_intestada_seleccionados.xlsx',
    declaredMime: 'application/octet-stream',
    detectedMime: 'application/zip',
    detectionSource: 'magic-bytes',
    size: 2048,
  });

  assert.equal(zipDetected.ok, true);
  assert.equal(zipDetected.detectedMime, 'application/zip');
  assert.equal(zipDetected.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  const noMagic = validateUploadPolicy({
    originalName: 'base_sucesion_intestada_seleccionados.xlsx',
    declaredMime: 'application/octet-stream',
    detectedMime: 'application/octet-stream',
    detectionSource: 'fallback',
    size: 2048,
  });

  assert.equal(noMagic.ok, true);
  assert.equal(noMagic.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('upload policy accepts harmless repeated dots in basename', () => {
  const result = validateUploadPolicy({
    originalName: 'Captura de pantalla 2026-01-01 a la(s) 5.20.33 p. m..png',
    declaredMime: 'image/png',
    detectedMime: 'image/png',
    detectionSource: 'magic-bytes',
    size: 1024,
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'accepted');
});

test('upload policy still rejects path traversal style names', () => {
  const result = validateUploadPolicy({
    originalName: '../report.pdf',
    declaredMime: 'application/pdf',
    detectedMime: 'application/pdf',
    detectionSource: 'magic-bytes',
    size: 1024,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_filename');
});

test('upload policy rejects Microsoft Office temporary lock files with a clear message', () => {
  assert.equal(isOfficeTemporaryLockFile('~$2 267 Formato para el proyecto de tesis.docx'), true);
  assert.equal(isOfficeTemporaryLockFile('2 267 Formato para el proyecto de tesis.docx'), false);

  const result = validateUploadPolicy({
    originalName: '~$2 267 Formato para el proyecto de tesis.docx',
    declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    detectedMime: 'application/octet-stream',
    detectionSource: 'fallback',
    size: 162,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'office_temp_lock_file');
  assert.match(result.message, /temporal de Microsoft Office/);
  assert.match(result.message, /documento original/);
});

test('upload policy rejects mismatched extension and magic bytes', () => {
  const result = validateUploadPolicy({
    originalName: 'renamed.docx',
    declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    detectedMime: 'application/pdf',
    detectionSource: 'magic-bytes',
    size: 1024,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'extension_mime_mismatch');
  assert.equal(result.detectedMime, 'application/pdf');
});

test('upload policy rejects a Windows binary disguised under a known text extension', () => {
  const result = validateUploadPolicy({
    originalName: 'payload.txt',
    declaredMime: 'text/plain',
    detectedMime: 'application/x-msdownload',
    detectionSource: 'magic-bytes',
    size: 1024,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'extension_mime_mismatch');
  assert.equal(result.detectedMime, 'application/x-msdownload');
});

test('upload policy accepts ANY format: unknown extensions, code, archives, binaries, no extension', () => {
  const cases = [
    ['dataset.parquet', 'application/octet-stream', 'application/octet-stream', 'fallback'],
    ['model.safetensors', '', '', 'fallback'],
    ['Dockerfile', '', '', 'fallback'],
    ['notes.org', 'text/plain', 'text/plain', 'fallback'],
    ['design.psd', 'image/vnd.adobe.photoshop', 'image/vnd.adobe.photoshop', 'magic-bytes'],
    ['archive.7z', 'application/x-7z-compressed', 'application/x-7z-compressed', 'magic-bytes'],
    ['drawing.dwg', 'application/acad', 'application/acad', 'fallback'],
    ['db.sqlite', 'application/vnd.sqlite3', 'application/vnd.sqlite3', 'magic-bytes'],
    ['app.py', 'text/x-python', 'text/x-python', 'fallback'],
    ['bundle.js', 'application/javascript', 'application/javascript', 'fallback'],
    ['deploy.sh', 'application/x-sh', 'application/x-sh', 'fallback'],
    ['setup.exe', 'application/x-msdownload', 'application/x-msdownload', 'magic-bytes'],
  ];
  for (const [originalName, declaredMime, detectedMime, detectionSource] of cases) {
    const result = validateUploadPolicy({ originalName, declaredMime, detectedMime, detectionSource, size: 2048 });
    assert.equal(result.ok, true, `${originalName} must be accepted (${result.code}: ${result.message || ''})`);
    assert.equal(result.code, 'accepted');
    assert.ok(result.mimeType, `${originalName} must carry a mimeType`);
  }
  assert.equal(
    validateUploadPolicy({ originalName: 'model.safetensors', declaredMime: '', detectedMime: '', detectionSource: 'fallback', size: 10 }).mimeType,
    'application/octet-stream',
    'type-less uploads normalise to octet-stream',
  );
});

test('upload policy classifies executables and active content so they are served as downloads', () => {
  const exe = validateUploadPolicy({
    originalName: 'setup.exe', declaredMime: 'application/x-msdownload', detectedMime: 'application/x-msdownload', detectionSource: 'magic-bytes', size: 10,
  });
  assert.equal(exe.executable, true);
  assert.equal(exe.forceDownload, true);
  assert.equal(exe.knownType, false);

  const script = validateUploadPolicy({
    originalName: 'deploy.sh', declaredMime: 'text/plain', detectedMime: 'text/plain', detectionSource: 'fallback', size: 10,
  });
  assert.equal(script.executable, true, 'shell scripts are flagged by extension even when declared as text');
  assert.equal(script.forceDownload, true);

  const disguised = validateUploadPolicy({
    originalName: 'firmware.bin', declaredMime: 'application/octet-stream', detectedMime: 'application/x-elf', detectionSource: 'magic-bytes', size: 10,
  });
  assert.equal(disguised.ok, true);
  assert.equal(disguised.executable, true, 'magic bytes flag native binaries regardless of the name');

  const page = validateUploadPolicy({
    originalName: 'landing.html', declaredMime: 'text/html', detectedMime: 'text/html', detectionSource: 'fallback', size: 10,
  });
  assert.equal(page.executable, false);
  assert.equal(page.activeContent, true);
  assert.equal(page.forceDownload, true);
  assert.equal(page.knownType, true);

  const pdf = validateUploadPolicy({
    originalName: 'report.pdf', declaredMime: 'application/pdf', detectedMime: 'application/pdf', detectionSource: 'magic-bytes', size: 10,
  });
  assert.equal(pdf.executable, false);
  assert.equal(pdf.activeContent, false);
  assert.equal(pdf.forceDownload, false);
  assert.equal(pdf.knownType, true);
});

test('shouldForceDownload flags executables, scripts and HTML/SVG/XML but not documents or media', () => {
  for (const filename of ['setup.exe', 'run.sh', 'tool.py', 'app.jar', 'page.html', 'logo.svg', 'feed.xml', 'a/b/nested.bat', 'x.cmd', 'lib.dll']) {
    assert.equal(shouldForceDownload({ filename }), true, `${filename} must be forced as attachment`);
  }
  for (const filename of ['report.pdf', 'deck.pptx', 'photo.jpg', 'clip.mp4', 'song.mp3', 'sheet.xlsx', 'notes.txt', 'data.csv', 'dataset.parquet', 'README']) {
    assert.equal(shouldForceDownload({ filename }), false, `${filename} must stay inline`);
  }
  assert.equal(shouldForceDownload({ filename: 'firmware.bin', mimeType: 'application/x-msdownload' }), true, 'mime hint wins when the extension is neutral');
});

test('multer pre-gate accepts every declared type and only rejects unsafe basenames', () => {
  assert.equal(isDeclaredUploadAllowed({ originalname: 'weird.xyz', mimetype: 'application/x-unknown' }), true);
  assert.equal(isDeclaredUploadAllowed({ originalname: 'setup.exe', mimetype: 'application/x-msdownload' }), true);
  assert.equal(isDeclaredUploadAllowed({ originalname: 'Makefile', mimetype: '' }), true);
  assert.equal(isDeclaredUploadAllowed({ originalname: '../../etc/passwd', mimetype: 'text/plain' }), false);
  assert.equal(isDeclaredUploadAllowed({ originalname: 'bad|name.txt', mimetype: 'text/plain' }), false);
  assert.equal(isDeclaredUploadAllowed({ originalname: 'nul\u0000byte.txt', mimetype: 'text/plain' }), false);
});

test('upload policy keeps text-ish extension fallbacks usable', () => {
  const result = validateUploadPolicy({
    originalName: 'dataset.csv',
    declaredMime: 'text/plain',
    detectedMime: 'text/plain',
    detectionSource: 'fallback',
    size: 1024,
  });

  assert.equal(result.ok, true);
  // A CSV the browser declared as text/plain is stored as text/csv so the
  // table parser (not the prose reader) handles it.
  assert.equal(result.mimeType, 'text/csv');
  assert.equal(mimeMatchesExtension('text/plain', 'csv'), true);
});

test('upload policy accepts legacy binary .xls spreadsheets for Office workflows', () => {
  const result = validateUploadPolicy({
    originalName: 'legacy.xls',
    declaredMime: 'application/vnd.ms-excel',
    detectedMime: 'application/vnd.ms-excel',
    detectionSource: 'fallback',
    size: 1024,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'application/vnd.ms-excel');
});

test('upload limits default to a bounded commercial ceiling unless explicitly overridden', () => {
  const limits = resolveUploadLimits({});
  assert.equal(limits.fileSize, 1024 * 1024 * 1024);
  assert.equal(limits.files, 1000);

  const tooLarge = validateUploadPolicy({
    originalName: 'large.pdf',
    declaredMime: 'application/pdf',
    detectedMime: 'application/pdf',
    detectionSource: 'magic-bytes',
    size: limits.fileSize + 1,
    env: {},
  });

  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, 'file_too_large');
});

test('upload limits honour deployment env caps', () => {
  const limits = resolveUploadLimits({ MAX_FILE_SIZE: '25', MAX_UPLOAD_FILES: '3' });
  assert.equal(limits.fileSize, 25 * 1024 * 1024);
  assert.equal(limits.files, 3);
});

test('an SVG reported as generic XML is accepted (still active-content sanitized)', () => {
  // Some detectors report an SVG as application/xml; the ext→mime map only had
  // image/svg+xml, so a legit .svg got an extension_mime_mismatch.
  const r = validateUploadPolicy({ originalName: 'logo.svg', declaredMime: 'application/xml', detectedMime: 'application/xml', detectionSource: 'magic-bytes', size: 1000 });
  assert.equal(r.ok, true, r.code);
  // The native image/svg+xml form still works too.
  const native = validateUploadPolicy({ originalName: 'logo.svg', declaredMime: 'image/svg+xml', size: 1000 });
  assert.equal(native.ok, true, native.code);
});

test('audio/video get their own cap (10 GB default) while documents get 1 GB', () => {
  const limits = resolveUploadLimits({});
  assert.equal(limits.fileSize, 1024 * 1024 * 1024);
  assert.equal(limits.mediaFileSize, DEFAULT_MAX_MEDIA_UPLOAD_MB * 1024 * 1024);
  assert.equal(resolveUploadLimits({ MAX_MEDIA_FILE_MB: '512' }).mediaFileSize, 512 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_MEDIA_UPLOAD_MB, 10240, 'one 10-hour recording (several GB) fits the default media cap');
  assert.equal(resolveUploadLimits({ MAX_FILE_SIZE: '20480' }).mediaFileSize, 20480 * 1024 * 1024, 'an explicit global cap above the media default wins');
  assert.equal(isMediaMime('video/mp4'), true);
  assert.equal(isMediaMime('audio/mpeg; codecs=1'), true);
  assert.equal(isMediaMime('application/pdf'), false);

  const bigVideo = validateUploadPolicy({
    originalName: 'clase.mp4', declaredMime: 'video/mp4', detectedMime: 'video/mp4', detectionSource: 'magic-bytes', size: 900 * 1024 * 1024,
  });
  assert.equal(bigVideo.ok, true, JSON.stringify(bigVideo));
  const bigPdf = validateUploadPolicy({
    originalName: 'libro.pdf', declaredMime: 'application/pdf', detectedMime: 'application/pdf', detectionSource: 'magic-bytes', size: 900 * 1024 * 1024,
  });
  assert.equal(bigPdf.ok, true, 'a 900 MB PDF fits the 1 GB document cap');
  const hugePdf = validateUploadPolicy({
    originalName: 'libro.pdf', declaredMime: 'application/pdf', detectedMime: 'application/pdf', detectionSource: 'magic-bytes', size: 1100 * 1024 * 1024,
  });
  assert.equal(hugePdf.ok, false);
  assert.equal(hugePdf.code, 'file_too_large');
  const hugeVideo = validateUploadPolicy({
    originalName: 'clase.mp4', declaredMime: 'video/mp4', detectedMime: 'video/mp4', detectionSource: 'magic-bytes', size: 11 * 1024 * 1024 * 1024,
  });
  assert.equal(hugeVideo.code, 'file_too_large');
  assert.match(hugeVideo.message, /10240 MB/);
  const tenHourLecture = validateUploadPolicy({
    originalName: 'clase-10h.mkv', declaredMime: 'video/x-matroska', detectedMime: 'video/matroska', detectionSource: 'magic-bytes', size: 6 * 1024 * 1024 * 1024,
  });
  assert.equal(tenHourLecture.ok, true, JSON.stringify(tenHourLecture));
  assert.equal(tenHourLecture.mimeType, 'video/x-matroska');
});

test('every audio format keeps its own identity (magic bytes measured with real ffmpeg output)', () => {
  // [file, declared by browser, detected by file-type 22, expected stored mime]
  const cases = [
    ['voz.m4a', 'audio/x-m4a', 'audio/x-m4a', 'audio/x-m4a'],
    ['voz.m4a', '', 'audio/x-m4a', 'audio/x-m4a'],
    ['audiolibro.m4b', '', 'audio/x-m4a', 'audio/x-m4a'],
    ['nota.mp4', 'audio/mp4', 'video/mp4', 'audio/mp4'],
    ['clase.mp4', 'video/mp4', 'video/mp4', 'video/mp4'],
    ['grabacion.webm', 'audio/webm', 'video/webm', 'audio/webm'],
    ['grabacion.weba', '', 'video/webm', 'audio/webm'],
    ['musica.mka', '', 'video/matroska', 'audio/x-matroska'],
    ['pelicula.mkv', '', 'video/matroska', 'video/x-matroska'],
    ['ptt.opus', 'audio/opus', 'audio/ogg', 'audio/ogg'],
    ['ptt.ogg', '', 'audio/ogg', 'audio/ogg'],
    ['iphone.caf', '', null, 'audio/x-caf'],
    ['iphone.caf', 'application/octet-stream', null, 'audio/x-caf'],
    ['llamada.amr', '', null, 'audio/amr'],
    ['radio.wma', 'audio/x-ms-wma', 'audio/x-ms-asf', 'audio/x-ms-wma'],
    ['radio.wma', '', 'audio/x-ms-asf', 'audio/x-ms-wma'],
    ['estudio.flac', '', 'audio/flac', 'audio/flac'],
    ['estudio.aiff', 'audio/aiff', 'audio/aiff', 'audio/aiff'],
    ['master.wav', '', 'audio/wav', 'audio/wav'],
    ['podcast.mp3', '', 'audio/mpeg', 'audio/mpeg'],
    ['voz.aac', '', 'audio/aac', 'audio/aac'],
    ['cine.ac3', '', 'audio/vnd.dolby.dd-raw', 'audio/vnd.dolby.dd-raw'],
    ['movil.3gp', 'audio/3gpp', 'video/3gpp', 'audio/3gpp'],
    // Real ffmpeg MPEG-TS: file-type has no signature, detectMime's own
    // transport-stream sniff reports it as magic video/mp2t.
    ['clase.ts', '', 'video/mp2t', 'video/mp2t'],
  ];
  for (const [originalName, declaredMime, detected, expected] of cases) {
    const result = validateUploadPolicy({
      originalName, declaredMime, detectedMime: detected || declaredMime,
      detectionSource: detected ? 'magic-bytes' : 'fallback', size: 5 * 1024 * 1024,
    });
    assert.equal(result.ok, true, `${originalName}: ${JSON.stringify(result)}`);
    assert.equal(result.mimeType, expected, `${originalName} (${declaredMime || 'sin tipo'})`);
    assert.ok(isMediaMime(result.mimeType), `${originalName} must stay transcribable media`);
  }
  // A 1 GB CAF with no browser MIME still gets the media cap, not 100 MB.
  const bigCaf = validateUploadPolicy({ originalName: 'larga.caf', declaredMime: '', detectedMime: '', detectionSource: 'fallback', size: 1024 * 1024 * 1024 });
  assert.equal(bigCaf.ok, true, JSON.stringify(bigCaf));
});

test('legacy Office / Outlook files inside an OLE2 container are accepted and routed by extension', () => {
  // file-type 22 names the container (application/x-cfb) for every OLE2 file.
  const cases = [
    ['informe.doc', 'application/msword'],
    ['plantilla.dot', 'application/msword'],
    ['cuentas.xls', 'application/vnd.ms-excel'],
    ['clase.ppt', 'application/vnd.ms-powerpoint'],
    ['diapositivas.pps', 'application/vnd.ms-powerpoint'],
    ['correo.msg', 'application/vnd.ms-outlook'],
    ['plano.vsd', 'application/vnd.visio'],
  ];
  for (const [name, expected] of cases) {
    const r = validateUploadPolicy({ originalName: name, declaredMime: 'application/octet-stream', detectedMime: 'application/x-cfb', detectionSource: 'magic-bytes', size: 4096 });
    assert.equal(r.ok, true, `${name}: ${r.code}`);
    assert.equal(r.mimeType, expected, name);
  }
});

test('same-family variants pass the integrity check; cross-family disguises still fail', () => {
  const accepted = [
    ['animacion.png', 'image/apng'],
    ['foto.heic', 'image/heic-sequence'],
    ['audio.mp4', 'audio/x-m4a'],
    ['video.mpg', 'video/MP2P'],
    ['libro.epub', 'application/zip'],
    ['texto.odt', 'application/zip'],
    ['pelicula.ogg', 'video/ogg'],
  ];
  for (const [name, detected] of accepted) {
    const r = validateUploadPolicy({ originalName: name, declaredMime: '', detectedMime: detected, detectionSource: 'magic-bytes', size: 4096 });
    assert.equal(r.ok, true, `${name} (${detected}): ${r.code}`);
  }
  const rejected = [
    ['renamed.docx', 'application/pdf'],
    ['factura.pdf', 'application/x-msdownload'],
    ['foto.png', 'application/x-msdownload'],
    ['informe.doc', 'application/pdf'],
    ['audio.mp3', 'application/x-elf'],
  ];
  for (const [name, detected] of rejected) {
    const r = validateUploadPolicy({ originalName: name, declaredMime: '', detectedMime: detected, detectionSource: 'magic-bytes', size: 4096 });
    assert.equal(r.code, 'extension_mime_mismatch', name);
  }
});

test('text formats declared as octet-stream keep their real type (email, calendar, subtitles, svg)', () => {
  const cases = [
    ['mensaje.eml', 'message/rfc822'],
    ['agenda.ics', 'text/calendar'],
    ['contacto.vcf', 'text/vcard'],
    ['subtitulos.srt', 'application/x-subrip'],
    ['subtitulos.vtt', 'text/vtt'],
    ['logo.svg', 'image/svg+xml'],
    ['notas.md', 'text/markdown'],
  ];
  for (const [name, expected] of cases) {
    const r = validateUploadPolicy({ originalName: name, declaredMime: 'application/octet-stream', detectedMime: 'application/octet-stream', detectionSource: 'fallback', size: 100 });
    assert.equal(r.ok, true, name);
    assert.equal(r.mimeType, expected, name);
  }
  // Active content stays a forced download even when the browser said octet-stream.
  const svg = validateUploadPolicy({ originalName: 'logo.svg', declaredMime: 'application/octet-stream', size: 100 });
  assert.equal(svg.forceDownload, true);
});

test('.ts / .mts / .cts are TypeScript unless the bytes are an MPEG transport stream', () => {
  const {
    looksLikeMpegTransportStream,
  } = require('../src/services/upload-security-policy');
  for (const declared of ['video/mp2t', 'application/octet-stream', '', 'text/plain']) {
    const r = validateUploadPolicy({ originalName: 'app.ts', declaredMime: declared, detectedMime: declared, detectionSource: 'fallback', size: 2048 });
    assert.equal(r.ok, true);
    assert.equal(r.mimeType, 'text/x-typescript', `declared ${declared || '(none)'}`);
    assert.equal(isMediaMime(r.mimeType), false);
  }
  const video = validateUploadPolicy({ originalName: 'grabacion.ts', declaredMime: 'video/mp2t', detectedMime: 'video/mp2t', detectionSource: 'magic-bytes', size: 2048 });
  assert.equal(video.mimeType, 'video/mp2t');

  const ts = Buffer.alloc(188 * 4);
  for (let i = 0; i < 4; i += 1) ts[i * 188] = 0x47;
  assert.equal(looksLikeMpegTransportStream(ts), true);
  const m2ts = Buffer.alloc(192 * 3);
  for (let i = 0; i < 3; i += 1) m2ts[4 + i * 192] = 0x47;
  assert.equal(looksLikeMpegTransportStream(m2ts), true);
  const code = Buffer.from('import { x } from "./y";\n'.repeat(40));
  assert.equal(looksLikeMpegTransportStream(code), false);
  assert.equal(looksLikeMpegTransportStream(Buffer.from('G')), false);
});
