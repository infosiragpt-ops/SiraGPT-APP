"use strict";

// Real noVNC -> WebSocket -> x11vnc -> X11 -> headful Chrome proof.
// The isolated Linux hard gate calls the SAME backend resize/restore actions
// as /agentes. Pixels and pointer coordinates are never mocked.
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { WebSocketServer, WebSocket } = require("ws");

const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
});
const stop = async child => {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  await ended;
};

const fixtureHtml = `<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Viewport RFB local</title><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}
.corner{position:fixed;width:24px;height:24px;border:0;padding:0}
#tl{left:0;top:0;background:#ff0000}#tr{right:0;top:0;background:#00ff00}
#bl{left:0;bottom:0;background:#0000ff}#br{right:0;bottom:0;background:#ffff00}
#save{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:180px;height:70px;background:#a020f0;color:white;border:0;font:18px sans-serif}
</style><button class="corner" id="tl" aria-label="Esquina izquierda superior"></button><button class="corner" id="tr" aria-label="Esquina derecha superior"></button><button class="corner" id="bl" aria-label="Esquina izquierda inferior"></button><button class="corner" id="br" aria-label="Esquina derecha inferior"></button><button id="save">Guardar prueba</button><output></output><script>
document.addEventListener('click',e=>{if(e.target.tagName==='BUTTON')document.querySelector('output').textContent=e.target.id+':'+innerWidth+'x'+innerHeight});
</script></html>`;

async function verifyLiveViewport({ page, resize, restore }) {
  assert.ok(process.env.CI && process.platform === "linux" && process.env.DISPLAY, "RFB proof requires the isolated Linux X11 gate");
  const previousUrl = page.url();
  const novncRoot = path.dirname(path.dirname(require.resolve("@novnc/novnc")));
  const connections = new Set();
  const sockets = new Set();
  let viewerBrowser, viewer, vnc;
  let vncLog = "";
  let setupError;
  let phase = "vnc_start";
  let expected = null;
  const reserve = net.createServer();
  await listen(reserve);
  const vncPort = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/fixture") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fixtureHtml);
    } else if (url.pathname === "/viewer") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><style>html,body,#screen{width:100%;height:100%;margin:0;overflow:hidden}</style><div id="screen"></div><script type="module">
import RFB from '/novnc/core/rfb.js';
const rfb=new RFB(document.querySelector('#screen'),'ws://'+location.host+'/rfb');
rfb.scaleViewport=true;rfb.clipViewport=false;rfb.resizeSession=false;rfb.showDotCursor=false;
rfb.addEventListener('connect',()=>window.rfbConnected=true);
rfb.addEventListener('disconnect',()=>window.rfbDisconnected=true);
window.rfb=rfb;
</script></html>`);
    } else if (/^\/novnc\/(?:core|vendor)\/[a-zA-Z0-9_./-]+\.js$/.test(url.pathname)) {
      const file = path.resolve(novncRoot, url.pathname.slice("/novnc/".length));
      if (!file.startsWith(novncRoot + path.sep)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, bytes) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "Content-Type": "text/javascript" }); res.end(bytes);
      });
    } else { res.writeHead(404).end(); }
  });
  const wsServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/rfb") { socket.destroy(); return; }
    wsServer.handleUpgrade(req, socket, head, ws => {
      connections.add(ws);
      const tcp = net.connect(vncPort, "127.0.0.1");
      sockets.add(tcp);
      ws.on("message", data => tcp.write(data));
      tcp.on("data", data => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
      tcp.on("error", () => ws.close());
      tcp.on("close", () => { sockets.delete(tcp); ws.close(); });
      ws.on("error", () => tcp.destroy());
      ws.on("close", () => { connections.delete(ws); tcp.destroy(); });
    });
  });
  try {
    await listen(server);
    vnc = spawn("x11vnc", ["-display", process.env.DISPLAY, "-rfbport", String(vncPort), "-listen", "127.0.0.1", "-forever", "-shared", "-nopw", "-xkb", "-ncache", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    vnc.on("error", error => { setupError = error; });
    vnc.stdout.on("data", data => { vncLog = (vncLog + data).slice(-4000); });
    vnc.stderr.on("data", data => { vncLog = (vncLog + data).slice(-4000); });
    const deadline = Date.now() + 8000;
    let ready = false;
    while (!ready && Date.now() < deadline && !setupError && vnc.exitCode === null) {
      ready = await new Promise(resolve => {
        const socket = net.connect(vncPort, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => { socket.destroy(); resolve(false); });
      });
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, `x11vnc fixture must start: ${setupError?.message || vncLog}`);
    phase = "fixture_open";
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    viewerBrowser = await chromium.launch({ headless: true });
    viewer = await viewerBrowser.newPage({ viewport: { width: 1000, height: 800 } });
    await viewer.goto(`http://127.0.0.1:${server.address().port}/viewer`);
    phase = "rfb_connect";
    await viewer.waitForFunction(() => window.rfbConnected === true);
    for (const dimensions of [{ width: 810, height: 640 }, { width: 430, height: 900 }]) {
      const { width, height } = dimensions;
      expected = dimensions;
      phase = "resize";
      const result = await resize(width, height);
      assert.equal(result.presentation, "embedded");
      assert.deepEqual(result.viewport, dimensions, "confirmed Chrome viewport must equal the visible frame");
      phase = "chrome_dimensions";
      await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, dimensions);
      await viewer.setViewportSize(dimensions);
      // The canvas buffer is the server framebuffer, independent of local CSS
      // scaling. Four native corner colors catch headers, cropping/letterboxes,
      // and missing NewFBSize support in the real RFB transport.
      phase = "framebuffer_corners";
      await viewer.waitForFunction(({ width, height }) => {
        const c = document.querySelector("canvas");
        if (!c || c.width !== width || c.height !== height) return false;
        const ctx = c.getContext("2d");
        const corners = [[6,6,[255,0,0]],[width-6,6,[0,255,0]],[6,height-6,[0,0,255]],[width-6,height-6,[255,255,0]]];
        return corners.every(([x,y,rgb]) => Array.from(ctx.getImageData(x,y,1,1).data).slice(0,3).every((v,i) => Math.abs(v-rgb[i]) < 5));
      }, dimensions, { timeout: 8000 });
      const canvas = viewer.locator("canvas");
      phase = "pointer_center";
      await canvas.click({ position: { x: width / 2, y: height / 2 } });
      await page.waitForFunction(expected => document.querySelector("output").textContent === expected, `save:${width}x${height}`, { timeout: 5000 });
      phase = "pointer_edge";
      await canvas.click({ position: { x: width - 10, y: height - 10 } });
      await page.waitForFunction(expected => document.querySelector("output").textContent === expected, `br:${width}x${height}`, { timeout: 5000 });
      await viewer.screenshot({ path: `/tmp/browser-gate-rfb-${width}x${height}.png` });
      console.log(`PASS real RFB viewport ${width}x${height}: exact framebuffer, four visible corners, center and edge input hit the actual Chrome page`);
    }
    phase = "restore";
    const restored = await restore();
    assert.equal(restored.presentation, "desktop");
    await viewer.waitForFunction(() => {
      const canvas = document.querySelector("canvas");
      return canvas?.width === 1920 && canvas?.height === 1080;
    }, null, { timeout: 8000 });
    const cdp = await page.context().newCDPSession(page);
    try {
      const { bounds } = await cdp.send("Browser.getWindowForTarget");
      assert.notEqual(bounds.windowState, "fullscreen", "leaving the panel restores actual Chrome window chrome");
    } finally { await cdp.detach(); }
    console.log("PASS real RFB restore: original 1920x1080 desktop framebuffer and normal browser window restored");
  } catch (error) {
    // Closed numeric diagnostics from THIS inert fixture only. No exception
    // message, URL, headers, request body, input values or raw stack is emitted
    // into GitHub annotations. These can be reviewed without CI log access.
    const chrome = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, focused: document.hasFocus() })).catch(() => null);
    const framebuffer = viewer ? await viewer.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return null;
      const ctx = canvas.getContext("2d");
      const width = canvas.width, height = canvas.height;
      const corners = width > 12 && height > 12 && ctx ? [[6,6],[width-6,6],[6,height-6],[width-6,height-6]].map(([x,y]) => Array.from(ctx.getImageData(x,y,1,1).data).slice(0,3)) : [];
      return { width, height, corners, connected: window.rfbConnected === true, disconnected: window.rfbDisconnected === true };
    }).catch(() => null) : null;
    console.error("::error title=Isolated RFB proof failed::" + JSON.stringify({ phase, expected, chrome, framebuffer }));
    await viewer?.screenshot({ path: "/tmp/browser-gate-rfb-failed.png" }).catch(() => {});
    throw error;
  } finally {
    // Always undo the feature's presentation before taking down its test VNC.
    await restore().catch(() => {});
    await viewerBrowser?.close();
    for (const ws of connections) ws.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => wsServer.close(resolve));
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await stop(vnc);
    await page.goto(previousUrl).catch(() => {});
  }
}
module.exports = { verifyLiveViewport };
