'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { uploadDir } = require('../src/services/hosting/ftp-transport');

test('FTP directory parsing rejects a hostile long line without blocking the process', () => {
  // Exercise the public parser used by Client.list(), including parser selection
  // by the last valid line. A child process bounds the vulnerable implementation.
  const script = `
    const { parseList } = require(process.argv[1]);
    const invalid = '-rw-r--r-- 1 ' + 'a '.repeat(65536) + '!';
    const valid = '-rw-r--r-- 1 owner group 42 Jan 1 2020 index.html';
    const files = parseList(invalid + '\\r\\n' + valid + '\\r\\n');
    process.stdout.write(JSON.stringify(files.map(file => ({
      name: file.name, size: file.size, user: file.user, group: file.group, isFile: file.isFile,
    }))));
  `;
  const result = spawnSync(process.execPath, ['-e', script, require.resolve('basic-ftp')], {
    encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'malformed listing must finish within the isolated CPU budget');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { name: 'index.html', size: 42, user: 'owner', group: 'group', isFile: true },
  ]);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('hosting uploads and cleans a directory through the real FTP client', { timeout: 10000 }, async (t) => {
  const localDir = await mkdtemp(path.join(tmpdir(), 'sira-ftp-security-'));
  const content = Buffer.from('<h1>Prueba de publicación: bicicletas</h1>\n', 'utf8');
  await writeFile(path.join(localDir, 'index.html'), content);
  const sockets = new Set();
  const servers = new Set();
  const uploads = new Map();
  const removed = [];
  const commands = [];
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([...servers].map(closeServer));
    await rm(localDir, { recursive: true, force: true });
  });
  const server = net.createServer((socket) => {
    track(socket);
    socket.setEncoding('utf8');
    socket.write('220 Loopback FTP test ready\r\n');
    let buffer = '';
    let currentDirectory = '/';
    let dataConnection;
    let sequence = Promise.resolve();
    async function command(line) {
      const separator = line.indexOf(' ');
      const verb = (separator < 0 ? line : line.slice(0, separator)).toUpperCase();
      const argument = separator < 0 ? '' : line.slice(separator + 1);
      commands.push(verb);
      if (verb === 'USER') return socket.write('331 Password required\r\n');
      if (verb === 'PASS') return socket.write('230 Logged in\r\n');
      if (verb === 'FEAT') return socket.write('211 No extensions\r\n');
      if (verb === 'PWD') return socket.write(`257 "${currentDirectory}"\r\n`);
      if (verb === 'CWD') {
        currentDirectory = path.posix.resolve(currentDirectory, argument);
        return socket.write('250 Directory changed\r\n');
      }
      if (verb === 'MKD') return socket.write(`257 "${argument}" created\r\n`);
      if (verb === 'EPSV') {
        let accept;
        dataConnection = new Promise((resolve) => { accept = resolve; });
        const dataServer = net.createServer((dataSocket) => accept(track(dataSocket)));
        servers.add(dataServer);
        const port = await listen(dataServer);
        return socket.write(`229 Entering extended passive mode (|||${port}|)\r\n`);
      }
      if (verb === 'LIST') {
        const data = await dataConnection;
        socket.write('150 Opening listing\r\n');
        data.end('-rw-r--r-- 1 owner group 7 Jan 1 2020 old.txt\r\n', () => {
          socket.write('226 Listing complete\r\n');
        });
        return;
      }
      if (verb === 'DELE') {
        removed.push(argument);
        return socket.write('250 File removed\r\n');
      }
      if (verb === 'STOR') {
        const data = await dataConnection;
        const chunks = [];
        data.on('data', (chunk) => chunks.push(chunk));
        data.on('end', () => {
          uploads.set(path.posix.join(currentDirectory, argument), Buffer.concat(chunks));
          data.end();
          socket.write('226 Upload complete\r\n');
        });
        return socket.write('150 Opening upload\r\n');
      }
      if (verb === 'QUIT') return socket.end('221 Goodbye\r\n');
      if (['TYPE', 'STRU', 'OPTS'].includes(verb)) return socket.write('200 Accepted\r\n');
      socket.write('502 Unsupported command\r\n');
    }
    socket.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        sequence = sequence.then(() => command(line)).catch(() => socket.destroy());
      }
    });
  });
  servers.add(server);
  const port = await listen(server);
  const result = await uploadDir({
    protocol: 'ftp', host: '127.0.0.1', port,
    username: 'fixture-user', password: 'fixture-password',
    localDir, remoteDir: '/public_html', cleanSlate: true,
  });
  assert.deepEqual(result, { ok: true, remoteDir: '/public_html' });
  assert.deepEqual(removed, ['old.txt']);
  assert.deepEqual(uploads.get('/public_html/index.html'), content);
  assert.equal(uploads.size, 1);
  assert.ok(commands.includes('LIST'), 'cleaning must parse a real server listing');
  assert.ok(commands.includes('STOR'), 'upload must transfer the local file over the data socket');
});
