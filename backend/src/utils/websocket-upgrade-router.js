'use strict';

function requestPath(request) {
  const rawUrl = String(request?.url || '');
  const queryIndex = rawUrl.indexOf('?');
  return queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
}

function attachWebSocketPath(server, webSocketServer, path) {
  if (!server || typeof server.on !== 'function') throw new TypeError('server is required');
  if (!webSocketServer || typeof webSocketServer.handleUpgrade !== 'function') {
    throw new TypeError('webSocketServer is required');
  }
  if (!path || path[0] !== '/') throw new TypeError('path must be absolute');

  let detached = false;
  const onUpgrade = (request, socket, head) => {
    if (requestPath(request) !== path || socket.destroyed) return;
    webSocketServer.handleUpgrade(request, socket, head, (socketClient) => {
      webSocketServer.emit('connection', socketClient, request);
    });
  };
  const detach = () => {
    if (detached) return;
    detached = true;
    server.off('upgrade', onUpgrade);
    server.off('close', detach);
  };

  server.on('upgrade', onUpgrade);
  server.once('close', detach);
  return detach;
}

module.exports = {
  requestPath,
  attachWebSocketPath,
};
