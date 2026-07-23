'use strict';

const http = require('node:http');
const { RunscSandboxError } = require('./runsc-sandbox-controller-utils');

const API_PREFIX = '/v1.47';

class DockerApiError extends RunscSandboxError {
  constructor(message, { statusCode = 0, body = null, code = 'docker_api_error' } = {}) {
    const publicStatus = code === 'exec_timeout' ? 408
      : code === 'exec_output_limit' ? 413
        : statusCode === 404 ? 404 : 502;
    super(code, message, { status: publicStatus, details: body });
    this.name = 'DockerApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

function encodeSegment(value) {
  return encodeURIComponent(String(value || ''));
}

function decodeDockerStream(buffer, maxOutputBytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { stdout: '', stderr: '' };
  const stdout = [];
  const stderr = [];
  let offset = 0;
  let framed = true;
  let total = 0;

  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    if (![0, 1, 2].includes(stream) || length < 0 || offset + 8 + length > buffer.length) {
      framed = false;
      break;
    }
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    total += chunk.length;
    if (total > maxOutputBytes) throw new DockerApiError('sandbox exec output exceeded the configured limit', {
      code: 'exec_output_limit', statusCode: 413,
    });
    (stream === 2 ? stderr : stdout).push(chunk);
    offset += 8 + length;
  }

  if (!framed || offset !== buffer.length) {
    if (buffer.length > maxOutputBytes) throw new DockerApiError('sandbox exec output exceeded the configured limit', {
      code: 'exec_output_limit', statusCode: 413,
    });
    return { stdout: buffer.toString('utf8'), stderr: '' };
  }
  return {
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

class DockerApi {
  constructor({ socketPath = '/var/run/docker.sock', requestTimeoutMs = 30_000, maxBodyBytes = 4 * 1024 * 1024 } = {}) {
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxBodyBytes = maxBodyBytes;
  }

  request(method, path, body, { timeoutMs = this.requestTimeoutMs, maxBytes = this.maxBodyBytes, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        socketPath: this.socketPath,
        method,
        path: `${API_PREFIX}${path}`,
        headers: payload ? {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
        } : undefined,
      });
      const timer = setTimeout(() => {
        req.destroy(new DockerApiError(`Docker API request timed out: ${method} ${path}`, {
          code: 'docker_api_timeout', statusCode: 504,
        }));
      }, timeoutMs);
      req.on('response', (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy(new DockerApiError('Docker API response exceeded the configured limit', {
              code: 'docker_response_limit', statusCode: 413,
            }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          clearTimeout(timer);
          const responseBody = Buffer.concat(chunks);
          let parsed = null;
          if (!raw && responseBody.length) {
            try { parsed = JSON.parse(responseBody.toString('utf8')); } catch { parsed = responseBody.toString('utf8'); }
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new DockerApiError(
              (parsed && parsed.message) || `Docker API ${method} ${path} returned ${res.statusCode}`,
              { statusCode: res.statusCode, body: parsed },
            ));
            return;
          }
          resolve(raw ? responseBody : parsed);
        });
      });
      req.on('error', (error) => {
        clearTimeout(timer);
        reject(error instanceof DockerApiError ? error : new DockerApiError(`Docker API unavailable: ${error.message}`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  ping() {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, method: 'GET', path: '/_ping' });
      const timer = setTimeout(() => req.destroy(new Error('Docker ping timed out')), 3000);
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode === 200 && Buffer.concat(chunks).toString('utf8').trim() === 'OK') resolve(true);
          else reject(new DockerApiError('Docker daemon ping failed', { statusCode: res.statusCode }));
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  info() { return this.request('GET', '/info'); }
  inspectImage(id) { return this.request('GET', `/images/${encodeSegment(id)}/json`); }
  createVolume(body) { return this.request('POST', '/volumes/create', body); }
  inspectVolume(name) { return this.request('GET', `/volumes/${encodeSegment(name)}`); }
  removeVolume(name) { return this.request('DELETE', `/volumes/${encodeSegment(name)}?force=true`); }
  listVolumes(filters) {
    return this.request('GET', `/volumes?filters=${encodeURIComponent(JSON.stringify(filters || {}))}`)
      .then((result) => result?.Volumes || []);
  }
  createNetwork(body) { return this.request('POST', '/networks/create', body); }
  inspectNetwork(id) { return this.request('GET', `/networks/${encodeSegment(id)}?verbose=true`); }
  removeNetwork(id) { return this.request('DELETE', `/networks/${encodeSegment(id)}`); }
  listNetworks(filters) {
    return this.request('GET', `/networks?filters=${encodeURIComponent(JSON.stringify(filters || {}))}`);
  }
  createContainer(name, body) {
    return this.request('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
  }
  inspectContainer(id) { return this.request('GET', `/containers/${encodeSegment(id)}/json`); }
  listContainers(filters) {
    return this.request('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters || {}))}`);
  }
  startContainer(id) { return this.request('POST', `/containers/${encodeSegment(id)}/start`); }
  stopContainer(id, seconds = 10) {
    return this.request('POST', `/containers/${encodeSegment(id)}/stop?t=${Math.max(0, Math.min(30, seconds))}`);
  }
  killContainer(id, signal = 'SIGKILL') {
    return this.request('POST', `/containers/${encodeSegment(id)}/kill?signal=${encodeURIComponent(signal)}`);
  }
  removeContainer(id) { return this.request('DELETE', `/containers/${encodeSegment(id)}?force=true&v=false`); }
  createExec(containerId, body) {
    return this.request('POST', `/containers/${encodeSegment(containerId)}/exec`, body);
  }
  inspectExec(execId) { return this.request('GET', `/exec/${encodeSegment(execId)}/json`); }

  async runExec(containerId, argv, { timeoutMs, maxOutputBytes }) {
    const created = await this.createExec(containerId, {
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: false,
      Tty: false,
      Cmd: argv,
      User: '10001:10001',
      WorkingDir: '/workspace',
      Env: ['HOME=/home/sandbox', 'TMPDIR=/tmp', 'XDG_CACHE_HOME=/cache'],
      Privileged: false,
    });
    if (!created?.Id) throw new DockerApiError('Docker did not return an exec id');

    let timer;
    let timedOut = false;
    let killPromise = null;
    const outputPromise = this.request('POST', `/exec/${encodeSegment(created.Id)}/start`, {
      Detach: false,
      Tty: false,
    }, { timeoutMs: timeoutMs + 5000, maxBytes: maxOutputBytes + 64 * 1024, raw: true });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        killPromise = this.killContainer(containerId).catch(() => {});
        reject(new DockerApiError('sandbox command exceeded its time budget', {
          code: 'exec_timeout', statusCode: 408,
        }));
      }, timeoutMs);
    });

    let raw;
    try {
      raw = await Promise.race([outputPromise, timeoutPromise]);
      const result = decodeDockerStream(raw, maxOutputBytes);
      const inspected = await this.inspectExec(created.Id);
      return {
        exitCode: Number.isInteger(inspected?.ExitCode) ? inspected.ExitCode : 1,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      const outputExceeded = error?.code === 'docker_response_limit' || error?.code === 'exec_output_limit';
      if ((timedOut || outputExceeded) && !killPromise) {
        killPromise = this.killContainer(containerId).catch(() => {});
      }
      if (killPromise) await killPromise;
      if (outputExceeded && error?.code !== 'exec_output_limit') {
        throw new DockerApiError('sandbox exec output exceeded the configured limit', {
          code: 'exec_output_limit', statusCode: 413,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (timedOut || killPromise) outputPromise.catch(() => {});
    }
  }
}

function isDockerNotFound(error) {
  return error instanceof DockerApiError && error.statusCode === 404;
}

module.exports = {
  DockerApi,
  DockerApiError,
  decodeDockerStream,
  isDockerNotFound,
};
