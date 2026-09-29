'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function invalid(reason) { throw new Error(reason); }
function readPcmWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE'
    || buffer.readUInt32LE(4) !== buffer.length - 8) invalid('wav_container_invalid');
  let format; let data;
  for (let offset = 12; offset < buffer.length;) {
    if (offset + 8 > buffer.length) invalid('wav_chunk_truncated');
    const size = buffer.readUInt32LE(offset + 4); const end = offset + 8 + size;
    if (end > buffer.length) invalid('wav_chunk_truncated');
    const kind = buffer.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ') { if (format) invalid('wav_format_duplicate'); format = buffer.subarray(offset + 8, end); }
    if (kind === 'data') { if (data) invalid('wav_data_duplicate'); data = buffer.subarray(offset + 8, end); }
    offset = end + (size % 2);
    if (offset > buffer.length) invalid('wav_padding_truncated');
  }
  if (!format || format.length < 16 || !data?.length) invalid('wav_data_missing');
  const codec = format.readUInt16LE(0);
  if (![1, 3].includes(codec)) return null; // Compressed WAV requires the existing media reader.
  const channels = format.readUInt16LE(2); const sampleRate = format.readUInt32LE(4);
  const byteRate = format.readUInt32LE(8); const blockAlign = format.readUInt16LE(12); const bits = format.readUInt16LE(14);
  if (channels < 1 || channels > 32 || sampleRate < 1 || sampleRate > 384000
    || !(codec === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bits)
    || blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign || data.length % blockAlign !== 0) invalid('wav_pcm_invalid');
  return { channels, sampleRate, bitsPerSample: bits, sampleCount: data.length / blockAlign, durationSeconds: data.length / byteRate };
}

async function readIco(buffer) {
  if (buffer.length < 22 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) invalid('ico_header_invalid');
  const count = buffer.readUInt16LE(4); const directoryEnd = 6 + count * 16;
  if (!count || count > 256 || directoryEnd > buffer.length) invalid('ico_directory_invalid');
  const ranges = []; const sizes = [];
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const width = buffer[entry] || 256; const height = buffer[entry + 1] || 256;
    const length = buffer.readUInt32LE(entry + 8); const offset = buffer.readUInt32LE(entry + 12);
    if (!length || offset < directoryEnd || offset + length > buffer.length
      || ranges.some(([start, end]) => offset < end && offset + length > start)) invalid('ico_image_bounds_invalid');
    ranges.push([offset, offset + length]);
    const image = buffer.subarray(offset, offset + length);
    if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      const decoder = require('sharp')(image, { failOn: 'warning', limitInputPixels: 65536 });
      const meta = await decoder.metadata();
      if (meta.width !== width || meta.height !== height) invalid('ico_size_mismatch');
      await decoder.stats();
    } else {
      if (image.length < 40) invalid('ico_bitmap_truncated');
      const headerSize = image.readUInt32LE(0); const bits = image.readUInt16LE(14); const compression = image.readUInt32LE(16);
      if (![40, 108, 124].includes(headerSize) || headerSize > image.length || image.readInt32LE(4) !== width
        || image.readInt32LE(8) !== height * 2 || image.readUInt16LE(12) !== 1
        || ![1, 4, 8, 16, 24, 32].includes(bits) || ![0, 3].includes(compression)
        || (compression === 3 && ![16, 32].includes(bits))) invalid('ico_bitmap_invalid');
      const colors = image.readUInt32LE(32) || (bits <= 8 ? 2 ** bits : 0);
      if (colors > 256) invalid('ico_palette_invalid');
      const masks = compression === 3 && headerSize === 40 ? 12 : 0;
      const xorBytes = Math.ceil(width * bits / 32) * 4 * height;
      const andBytes = Math.ceil(width / 32) * 4 * height;
      if (headerSize + masks + colors * 4 + xorBytes + andBytes > image.length) invalid('ico_bitmap_pixels_truncated');
    }
    sizes.push({ width, height });
  }
  return { imageCount: count, sizes };
}

async function readMedia(format, buffer) {
  if (format === 'wav') { const pcm = readPcmWav(buffer); if (pcm) return pcm; }
  const detected = await (await import('file-type')).fileTypeFromBuffer(buffer);
  if (detected?.ext !== format) invalid('media_format_mismatch');
  const { runProcess } = require('./media-inspection-runtime');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-media-verify-'));
  try {
    const file = path.join(directory, `artifact.${format}`);
    await fs.writeFile(file, buffer);
    const result = await runProcess(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file,pipe', '-read_intervals', '%+3', '-count_packets',
      '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,nb_read_packets,width,height,sample_rate,channels',
      '-of', 'json', file,
    ], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    const probe = JSON.parse(result.stdout.toString('utf8'));
    const streams = (Array.isArray(probe.streams) ? probe.streams : []).filter((stream) => ['audio', 'video'].includes(stream.codec_type)
      && stream.codec_name && stream.codec_name !== 'unknown' && Number(stream.nb_read_packets) > 0);
    const containers = String(probe.format?.format_name || '').split(',');
    const expected = { mp3: ['mp3'], wav: ['wav'], mp4: ['mov', 'mp4'], webm: ['matroska', 'webm'] }[format];
    if (!streams.length || !containers.some((container) => expected.includes(container))) invalid('media_stream_unreadable');
    if (streams.some((stream) => stream.codec_type === 'video' && (!(Number(stream.width) > 0) || !(Number(stream.height) > 0)
      || Number(stream.width) * Number(stream.height) > 40_000_000))) invalid('media_video_dimensions_invalid');
    // Packet headers alone can survive a corrupt payload. Decode a bounded
    // sample with the existing media runtime before marking media readable.
    await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe', '-threads', '1',
      '-i', file, '-t', '3', '-map', '0:a?', '-map', '0:v?', '-f', 'null', '-',
    ], { timeoutMs: 12_000, maxOutputBytes: 64 * 1024 });
    return { container: containers[0], streams: streams.map(({ codec_type, codec_name }) => ({ kind: codec_type, codec: codec_name })), readbackSeconds: 3 };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
module.exports = { readPcmWav, readIco, readMedia };
