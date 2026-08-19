'use strict';

const path = require('path');

// Lazy-require the AWS SDK so this module loads even when the optional
// @aws-sdk/* deps aren't installed (e.g. fresh checkouts before `npm i`,
// or runtimes where R2 is intentionally not configured). Mirrors the
// document-* analyzer "lazy require" pattern in CLAUDE.md.
let _sdkCache = null;
function loadSdk() {
  if (_sdkCache) return _sdkCache;
  // eslint-disable-next-line global-require
  const s3 = require('@aws-sdk/client-s3');
  // eslint-disable-next-line global-require
  const signer = require('@aws-sdk/s3-request-presigner');
  _sdkCache = {
    S3Client: s3.S3Client,
    PutObjectCommand: s3.PutObjectCommand,
    GetObjectCommand: s3.GetObjectCommand,
    HeadObjectCommand: s3.HeadObjectCommand,
    DeleteObjectCommand: s3.DeleteObjectCommand,
    getSignedUrl: signer.getSignedUrl,
  };
  return _sdkCache;
}

function bucketName(env = process.env) {
  return env.R2_BUCKET_NAME || env.R2_BUCKET;
}

function enabled(env = process.env) {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && bucketName(env));
}

function createR2Client(env = process.env) {
  if (!enabled(env)) return null;
  const { S3Client } = loadSdk();
  const endpoint = env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: env.R2_REGION || 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

function safeKey({ userId = 'anon', fileName = 'artifact.bin', prefix = 'artifacts' } = {}) {
  const base = path.basename(fileName).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'artifact.bin';
  return `${prefix}/${String(userId).replace(/[^A-Za-z0-9_-]/g, '_')}/${Date.now()}-${base}`;
}

function createR2ArtifactStorage({ env = process.env, client = createR2Client(env) } = {}) {
  const bucket = bucketName(env);
  const expiresIn = Number.parseInt(env.R2_PRESIGNED_URL_TTL_SECONDS || '900', 10);
  return {
    enabled: Boolean(client && bucket),
    async put({ key, body, contentType, metadata }) {
      if (!client || !bucket) throw new Error('R2 storage is not configured');
      const { PutObjectCommand } = loadSdk();
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, Metadata: metadata }));
      return { key, bucket };
    },
    async signedGetUrl(key, ttl = expiresIn) {
      if (!client || !bucket) throw new Error('R2 storage is not configured');
      const { GetObjectCommand, getSignedUrl } = loadSdk();
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttl });
    },
    // Raw object fetch. `range` is an HTTP byte-range string ("bytes=0-1023")
    // forwarded straight to R2 so callers can stream video range requests
    // without pulling the whole object. Returns the AWS GetObject response:
    // { Body (Node Readable), ContentLength, ContentType, ContentRange, ... }.
    async getObject(key, { range } = {}) {
      if (!client || !bucket) throw new Error('R2 storage is not configured');
      const { GetObjectCommand } = loadSdk();
      return client.send(new GetObjectCommand({ Bucket: bucket, Key: key, ...(range ? { Range: range } : {}) }));
    },
    // Cheap metadata probe (size / content-type) used to decide whether an
    // object exists in R2 and to build range responses. Throws on 404.
    async head(key) {
      if (!client || !bucket) throw new Error('R2 storage is not configured');
      const { HeadObjectCommand } = loadSdk();
      return client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    },
    async signedPutUrl({ key, contentType, ttl = expiresIn }) {
      if (!client || !bucket) throw new Error('R2 storage is not configured');
      const { PutObjectCommand, getSignedUrl } = loadSdk();
      return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: ttl });
    },
    async delete(key) {
      if (!client || !bucket) throw new Error('R2 storage is not configured');
      const { DeleteObjectCommand } = loadSdk();
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return { key, deleted: true };
    },
  };
}

module.exports = { bucketName, createR2ArtifactStorage, createR2Client, enabled, safeKey };
