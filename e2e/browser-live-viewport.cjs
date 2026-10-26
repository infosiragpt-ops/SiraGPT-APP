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

const fixtureHtml = `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Viewport RFB local</title><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}
.corner{position:fixed;width:24px;height:24px;border:0;padding:0}
#tl{left:0;top:0;background:#ff0000}#tr{right:0;top:0;background:#00ff00}
#bl{left:0;bottom:0;background:#0000ff}#br{right:0;bottom:0;background:#ffff00}
#save{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:180px;height:70px;background:#a020f0;color:white;border:0;font:18px sans-serif}
#benchmark{display:none;position:fixed;inset:0;background:#f8fafc;font:16px Arial,sans-serif;color:#172554}
body.benchmark #benchmark{display:block}
#benchmark h1{font-size:22px;margin:22px 210px 20px 100px}
#bench-action{position:absolute;right:24px;top:16px;width:160px;height:48px;border:0;border-radius:8px;background:#172554;color:white;font:16px Arial}
#bench-status,#bench-scroll-status{position:absolute;top:24px;width:24px;height:24px;background:#7c3aed}
#bench-status{left:24px}#bench-scroll-status{left:60px;background:#172554}
#bench-scroll-end{position:absolute;left:24px;top:60px;width:24px;height:12px;background:#f8fafc}
#bench-scroll{position:absolute;left:24px;right:24px;top:88px;bottom:24px;overflow:auto;background:white;border:1px solid #cbd5e1;scroll-behavior:auto}
#bench-hero{height:200px;position:relative;padding:16px;box-sizing:border-box}
#bench-hero p{max-width:50%;line-height:1.6}#bench-image{position:absolute;right:16px;top:16px;width:320px;height:160px}
.bench-row{height:88px;box-sizing:border-box;padding:18px 24px;border-top:1px solid #cbd5e1;background:#f1f5f9}
.bench-row:nth-child(even){background:white}.bench-row strong{display:block;margin-bottom:8px}
</style><button class="corner" id="tl" aria-label="Esquina izquierda superior"></button><button class="corner" id="tr" aria-label="Esquina derecha superior"></button><button class="corner" id="bl" aria-label="Esquina izquierda inferior"></button><button class="corner" id="br" aria-label="Esquina derecha inferior"></button><button id="save">Guardar prueba</button><output></output><section id="benchmark"><span id="bench-status"></span><span id="bench-scroll-status"></span><span id="bench-scroll-end"></span><h1>Navegador · prueba de contenido</h1><button id="bench-action">Actualizar 0</button><div id="bench-scroll"><div id="bench-hero"><strong>Resultados de búsqueda</strong><p>Una página local con texto, imagen y desplazamiento. Cada acción debe llegar al navegador y aparecer en la pantalla remota.</p><img id="bench-image" alt="Ilustración determinista de prueba"></div><div id="bench-rows"></div></div></section><script>
document.addEventListener('click',e=>{if(e.target.tagName==='BUTTON')document.querySelector('output').textContent=e.target.id+':'+innerWidth+'x'+innerHeight});
const palette=['#7c3aed','#16a34a','#2563eb','#db2777'];
let benchmarkCount=0;
const scroll=document.querySelector('#bench-scroll');
for(let i=0;i<18;i++){
  const row=document.createElement('article');row.className='bench-row';
  const title=document.createElement('strong');title.textContent='Resultado '+(i+1)+' · Documentación de prueba';
  const text=document.createElement('span');text.textContent='Contenido local reproducible para comprobar lectura, entrada y desplazamiento.';
  row.append(title,text);document.querySelector('#bench-rows').append(row);
}
const picture=document.createElement('canvas');picture.width=320;picture.height=160;
const pixels=picture.getContext('2d');
for(let y=0;y<160;y+=4)for(let x=0;x<320;x+=4){
  pixels.fillStyle='rgb('+((x*3+y)%256)+','+((x+y*2)%256)+','+((x*2+y*3)%256)+')';pixels.fillRect(x,y,4,4);
}
pixels.fillStyle='#ffffff';pixels.fillRect(24,24,116,48);pixels.fillStyle='#172554';pixels.font='bold 22px Arial';pixels.fillText('IMAGEN',32,56);
document.querySelector('#bench-image').src=picture.toDataURL('image/png');
document.querySelector('#bench-action').addEventListener('click',()=>{
  benchmarkCount++;document.querySelector('#bench-action').textContent='Actualizar '+benchmarkCount;
  document.querySelector('#bench-status').style.background=palette[benchmarkCount%palette.length];
});
let scrolling=false;
const scrollWaiters=new Set();
scroll.addEventListener('scroll',()=>{
  scrolling=true;
  document.querySelector('#bench-scroll-status').style.background=scroll.scrollTop>0?'#f59e0b':'#172554';
  document.querySelector('#bench-scroll-end').style.background='#f8fafc';
});
scroll.addEventListener('scrollend',()=>{
  scrolling=false;
  document.querySelector('#bench-scroll-end').style.background=scroll.scrollTop>0?'#0f766e':'#f8fafc';
  for(const resolve of scrollWaiters)resolve();
  scrollWaiters.clear();
});
// Observe the rendered fixture without a CDP client retaining emulation.
const fixtureControl=new WebSocket('ws://'+location.host+'/fixture-control');
fixtureControl.addEventListener('message',async event=>{
  const request=JSON.parse(event.data);
  if(!['snapshot','benchmarkReset','benchmarkSettled'].includes(request.type)||!Number.isSafeInteger(request.id))return;
  if(request.type==='benchmarkReset'){
    document.body.classList.add('benchmark');benchmarkCount=0;scroll.scrollTop=0;
    document.querySelector('#bench-action').textContent='Actualizar 0';
    document.querySelector('#bench-status').style.background=palette[0];
    document.querySelector('#bench-scroll-status').style.background='#172554';
    document.querySelector('#bench-scroll-end').style.background='#f8fafc';
  }
  // Two animation frames can still be inside a native smooth scroll. Resetting
  // then races its compositor and leaves a nonzero offset in the next sample.
  if(request.type==='benchmarkSettled'&&scrolling)await new Promise(resolve=>scrollWaiters.add(resolve));
  requestAnimationFrame(()=>requestAnimationFrame(()=>fixtureControl.send(JSON.stringify({
    id:request.id,viewport:{width:innerWidth,height:innerHeight},
    output:document.querySelector('output').textContent,focused:document.hasFocus(),
    benchmark:{count:benchmarkCount,scrollTop:scroll.scrollTop,
      imageReady:document.querySelector('#bench-image').complete&&document.querySelector('#bench-image').naturalWidth===320,
      heading:document.querySelector('#bench-hero strong').textContent,rows:document.querySelector('#bench-rows').children.length}
  }))));
});
</script></html>`;

async function verifyLiveViewport({ previousUrl, withPage, navigate, state, resize, restore }) {
  assert.ok(process.env.CI && process.platform === "linux" && process.env.DISPLAY, "RFB proof requires the isolated Linux X11 gate");
  const novncRoot = path.dirname(path.dirname(require.resolve("@novnc/novnc")));
  const connections = new Set();
  const sockets = new Set();
  const rfbTransfers = new Map();
  let viewerBrowser, viewer, vnc, fixtureControl;
  let nextSnapshot = 0;
  const fixtureReady = Promise.withResolvers();
  async function fixtureSnapshot(timeoutMs = 5000, type = "snapshot") {
    let timer;
    try {
      await Promise.race([fixtureReady.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture_control_not_ready")), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(fixtureControl.readyState, WebSocket.OPEN, "the real page must keep its fixture control channel open");
    const id = ++nextSnapshot;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout); fixtureControl.off("message", message); fixtureControl.off("close", closed);
      };
      const closed = () => { cleanup(); reject(new Error("fixture_control_closed")); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error("fixture_snapshot_timeout")); }, timeoutMs);
      const message = raw => {
        let value;
        try { value = JSON.parse(raw); } catch { cleanup(); reject(new Error("fixture_snapshot_invalid")); return; }
        // Every read is acknowledged after its request and two actual page
        // animation frames. A cached resize notification cannot satisfy it.
        if (value.id !== id) return;
        cleanup();
        if (!Number.isInteger(value.viewport?.width) || !Number.isInteger(value.viewport?.height)
          || typeof value.output !== "string" || typeof value.focused !== "boolean") {
          reject(new Error("fixture_snapshot_invalid")); return;
        }
        resolve(value);
      };
      fixtureControl.on("message", message); fixtureControl.once("close", closed);
      fixtureControl.send(JSON.stringify({ type, id }));
    });
  }
  async function expectFixtureOutput(output) {
    const deadline = Date.now() + 5000;
    let snapshot;
    do {
      snapshot = await fixtureSnapshot(Math.max(1, deadline - Date.now()));
      if (snapshot.output === output) return;
    } while (Date.now() < deadline);
    assert.equal(snapshot.output, output, "RFB input must reach the actual fixture target");
  }
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
      const profile = url.searchParams.get("profile");
      const benchmarkProfile = /^9-[012]$/.test(profile || "");
      const profileSetup = benchmarkProfile ? `rfb.qualityLevel=9;rfb.compressionLevel=${Number(profile.slice(-1))};` : "";
      const rfbPath = benchmarkProfile ? `/rfb?profile=${profile}` : "/rfb";
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><style>html,body,#screen{width:100%;height:100%;margin:0;overflow:hidden}</style><div id="screen"></div><script type="module">
import RFB from '/novnc/core/rfb.js';
const rfb=new RFB(document.querySelector('#screen'),'ws://'+location.host+'${rfbPath}');
${profileSetup}
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
    if (req.url === "/fixture-control") {
      wsServer.handleUpgrade(req, socket, head, ws => {
        assert.ok(!fixtureControl, "only the isolated native fixture owns this control channel");
        fixtureControl = ws; connections.add(ws);
        ws.on("error", () => ws.close());
        ws.on("close", () => connections.delete(ws));
        fixtureReady.resolve();
      });
      return;
    }
    const upgradeUrl = new URL(req.url, "http://127.0.0.1");
    if (upgradeUrl.pathname !== "/rfb") { socket.destroy(); return; }
    wsServer.handleUpgrade(req, socket, head, ws => {
      connections.add(ws);
      const profile = upgradeUrl.searchParams.get("profile") || "viewport";
      const transfer = { serverBytes: 0, clientBytes: 0 };
      rfbTransfers.set(profile, transfer);
      const tcp = net.connect(vncPort, "127.0.0.1");
      sockets.add(tcp);
      ws.on("message", data => { transfer.clientBytes += data.length; tcp.write(data); });
      tcp.on("data", data => { transfer.serverBytes += data.length; if (ws.readyState === WebSocket.OPEN) ws.send(data); });
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
    await navigate(`http://127.0.0.1:${server.address().port}/fixture`);
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
      // The action has returned and every test observer is disconnected. A
      // second backend request must report the real persisted dimensions, not
      // the temporary metrics visible only inside the resize request.
      phase = "independent_state";
      const persisted = await state();
      assert.equal(persisted.presentation, "embedded");
      assert.deepEqual(persisted.viewport, dimensions, "viewport must survive the completed resize and a separate state request");
      phase = "chrome_dimensions";
      const actual = await fixtureSnapshot();
      assert.deepEqual(actual.viewport, dimensions, "the rendered page must retain viewport after every request disconnects");
      // This report came from the page after painting, with no CDP observer.
      // Pixel and pointer proof also runs without a test CDP client.
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
      await expectFixtureOutput(`save:${width}x${height}`);
      phase = "pointer_edge";
      await canvas.click({ position: { x: width - 10, y: height - 10 } });
      await expectFixtureOutput(`br:${width}x${height}`);
      await viewer.screenshot({ path: `/tmp/browser-gate-rfb-${width}x${height}.png` });
      console.log(`PASS real RFB viewport ${width}x${height}: independent requests, disconnected observers, exact framebuffer, four corners, center and edge input`);
    }
    // Same native page, viewport, image and RFB inputs for each profile.
    // Fresh viewer connections isolate per-client compression dictionaries.
    // This is a measured comparison, not a speedup gate on a shared runner.
    phase = "rfb_benchmark_setup";
    const dimensions = { width: 1000, height: 800 };
    expected = dimensions;
    await resize(dimensions.width, dimensions.height);
    await viewer.close();
    const benchmarkResults = [];
    const benchmarkRounds = 5;
    const benchmarkStartedAt = Date.now();
    // Rotate which profile runs first to expose order/warmup effects.
    // No warmup sample is discarded; all runs and their order are reported.
    const marker = (rgb, point = { x: 36, y: 36 }, timeout = 8000) => viewer.waitForFunction(({ rgb, point }) => {
      const canvas = document.querySelector("canvas");
      if (!canvas || canvas.width !== 1000 || canvas.height !== 800) return false;
      const actual = canvas.getContext("2d").getImageData(point.x, point.y, 1, 1).data;
      return rgb.every((channel, i) => Math.abs(actual[i] - channel) < 24);
    }, { rgb, point }, { timeout });
    async function measurePaint(type, rgb, point, act) {
      await viewer.evaluate(({ type, rgb, point }) => {
        window.paintMeasurement = null;
        window.addEventListener(type, () => {
          const start = performance.now();
          const inspect = () => {
            const canvas = document.querySelector("canvas");
            const actual = canvas.getContext("2d").getImageData(point.x, point.y, 1, 1).data;
            if (rgb.every((channel, i) => Math.abs(actual[i] - channel) < 24)) {
              window.paintMeasurement = performance.now() - start;
            } else if (performance.now() - start < 8000) requestAnimationFrame(inspect);
          };
          requestAnimationFrame(inspect);
        }, { capture: true, once: true });
      }, { type, rgb, point });
      await act();
      await viewer.waitForFunction(() => Number.isFinite(window.paintMeasurement), null, { timeout: 8500 });
      return Math.round(await viewer.evaluate(() => window.paintMeasurement) * 100) / 100;
    }
    for (let round = 1; round <= benchmarkRounds; round++) {
      const offset = (round - 1) % 3;
      const order = [0, 1, 2].map((_, index) => (index + offset) % 3);
      for (const compression of order) {
        const profile = `9-${compression}`;
        phase = `rfb_benchmark_${profile}_round_${round}`;
        const capture = round === 1 ? profile : `${profile}-round-${round}`;
        const initial = await fixtureSnapshot(5000, "benchmarkReset");
        assert.deepEqual(initial.viewport, dimensions);
        assert.deepEqual(initial.benchmark, { count: 0, scrollTop: 0, imageReady: true,
          heading: "Resultados de búsqueda", rows: 18 });
        viewer = await viewerBrowser.newPage({ viewport: dimensions });
        await viewer.goto(`http://127.0.0.1:${server.address().port}/viewer?profile=${profile}`);
        await viewer.waitForFunction(() => window.rfbConnected === true);
        assert.deepEqual(await viewer.evaluate(() => [window.rfb.qualityLevel, window.rfb.compressionLevel]), [9, compression]);
        await marker([124, 58, 237]);
        // Inspect received pixels, not the native page DOM: both dense text and
        // the deterministic raster image must actually cross the RFB channel.
        await viewer.waitForFunction(() => {
          const canvas = document.querySelector("canvas");
          if (!canvas || canvas.width !== 1000 || canvas.height !== 800) return false;
          const ctx = canvas.getContext("2d");
          const text = ctx.getImageData(40, 105, 450, 170).data;
          let dark = 0;
          for (let i = 0; i < text.length; i += 4) if (text[i] < 100 && text[i + 1] < 100 && text[i + 2] < 150) dark++;
          const image = ctx.getImageData(642, 106, 310, 150).data;
          const colors = new Set();
          for (let i = 0; i < image.length; i += 64) colors.add([image[i] >> 5, image[i + 1] >> 5, image[i + 2] >> 5].join(","));
          return dark > 300 && colors.size > 60;
        }, null, { timeout: 8000 });
        await viewer.screenshot({ path: `/tmp/browser-gate-rfb-profile-${capture}-initial.png` });
        const actionBytesStart = rfbTransfers.get(profile).serverBytes;
        const clickToPaintMs = [];
        for (const rgb of [[22, 163, 74], [37, 99, 235], [219, 39, 119]]) {
          clickToPaintMs.push(await measurePaint("pointerdown", rgb, { x: 36, y: 36 },
            () => viewer.locator("canvas").click({ position: { x: 896, y: 40 } })));
          const snapshot = await fixtureSnapshot();
          assert.equal(snapshot.benchmark.count, clickToPaintMs.length, "click must update the real page once");
        }
        await viewer.mouse.move(500, 500);
        const scrollToPaintMs = await measurePaint("wheel", [245, 158, 11], { x: 72, y: 36 },
          () => viewer.mouse.wheel(0, 420));
        // Preserve first-paint latency above, but finish this gesture before
        // measuring total bytes or closing/resetting the next connection.
        // The second marker proves that scrollend itself reached the viewer.
        const scrollDeadline = Date.now() + 5000;
        const final = await fixtureSnapshot(5000, "benchmarkSettled");
        await marker([15, 118, 110], { x: 36, y: 66 }, Math.max(1, scrollDeadline - Date.now()));
        assert.ok(final.benchmark.scrollTop > 0, "RFB wheel must scroll the native content");
        assert.equal(final.benchmark.count, 3);
        await viewer.screenshot({ path: `/tmp/browser-gate-rfb-profile-${capture}-scrolled.png` });
        const transfer = rfbTransfers.get(profile);
        assert.ok(transfer.serverBytes > actionBytesStart && transfer.clientBytes > 0, "both RFB directions must carry real bytes");
        benchmarkResults.push({ round, order: order.indexOf(compression) + 1, quality: 9, compression, viewport: dimensions,
          serverBytes: transfer.serverBytes, clientBytes: transfer.clientBytes,
          actionServerBytes: transfer.serverBytes - actionBytesStart,
          clickToPaintMs, scrollToPaintMs, clicksConfirmed: final.benchmark.count,
          scrollConfirmed: final.benchmark.scrollTop > 0, textAndImagePixelsConfirmed: true });
        await viewer.close();
        viewer = null;
      }
    }
    const distribution = values => {
      assert.ok(values.length > 0 && values.every(Number.isFinite), "measurements must be finite");
      const sorted = values.slice().sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      return { count: sorted.length, median: Math.round(median * 100) / 100,
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
    };
    const profiles = [0, 1, 2].map(compression => {
      const samples = benchmarkResults.filter(sample => sample.compression === compression);
      assert.equal(samples.length, benchmarkRounds, "every profile must finish all five rounds");
      return { quality: 9, compression, samples, summary: {
        clickToPaintMs: distribution(samples.flatMap(sample => sample.clickToPaintMs)),
        scrollToPaintMs: distribution(samples.map(sample => sample.scrollToPaintMs)),
        serverBytes: distribution(samples.map(sample => sample.serverBytes)),
        clientBytes: distribution(samples.map(sample => sample.clientBytes)),
        actionServerBytes: distribution(samples.map(sample => sample.actionServerBytes)),
      } };
    });
    const pairedScrollDeltaMs = profiles.slice(1).flatMap(profile =>
      Array.from({ length: benchmarkRounds }, (_, index) => {
        const baseline = profiles[0].samples[index], candidate = profile.samples[index];
        assert.equal(baseline.round, candidate.round);
        return { compression: profile.compression, round: baseline.round,
          candidateMinusBaseline: Math.round((candidate.scrollToPaintMs - baseline.scrollToPaintMs) * 100) / 100 };
      }));
    const report = { schemaVersion: 3, transport: "noVNC-WebSocket-x11vnc-X11-Chrome",
      workload: "same local text, raster image, three clicks and one scroll",
      latencyOrigin: "viewer input event to first matching received framebuffer pixel",
      transferBoundary: "after native scrollend and its matching received framebuffer pixel; not comparable to schema 2 first-paint byte totals",
      roundsPerProfile: benchmarkRounds, elapsedMs: Date.now() - benchmarkStartedAt,
      sampling: "five rounds; fresh connection each sample; order rotates 0,1,2 then 1,2,0 then 2,0,1; all samples retained",
      percentile: "nearest-rank p95; median averages the middle pair for even sample counts",
      thresholds: "content and input correctness only; no minimum speedup", profiles, pairedScrollDeltaMs };
    // CI logs retain all measurements even when success artifacts are not
    // uploaded; /tmp captures are also available for a failed gate's evidence.
    fs.writeFileSync("/tmp/browser-gate-rfb-metrics.json", JSON.stringify(report, null, 2) + "\n");
    console.log("PASS real RFB profile comparison " + JSON.stringify(report));
    // Keep the original restore/framebuffer assertions on a live connection.
    viewer = await viewerBrowser.newPage({ viewport: dimensions });
    await viewer.goto(`http://127.0.0.1:${server.address().port}/viewer`);
    await viewer.waitForFunction(() => window.rfbConnected === true);
    phase = "restore";
    const restored = await restore();
    assert.equal(restored.presentation, "desktop");
    await viewer.waitForFunction(() => {
      const canvas = document.querySelector("canvas");
      return canvas?.width === 1920 && canvas?.height === 1080;
    }, null, { timeout: 8000 });
    const restoredState = await state();
    assert.equal(restoredState.presentation, "desktop", "restore survives a separate request too");
    await withPage(async page => {
      const cdp = await page.context().newCDPSession(page);
      try {
        const { bounds } = await cdp.send("Browser.getWindowForTarget");
        assert.notEqual(bounds.windowState, "fullscreen", "leaving the panel restores actual Chrome window chrome");
      } finally { await cdp.detach(); }
    });
    console.log("PASS real RFB restore: original 1920x1080 desktop framebuffer and normal browser window restored");
  } catch (error) {
    // Closed numeric diagnostics from THIS inert fixture only. No exception
    // message, URL, headers, request body, input values or raw stack is emitted
    // into GitHub annotations. These can be reviewed without CI log access.
    const chrome = fixtureControl?.readyState === WebSocket.OPEN ? await fixtureSnapshot().then(snapshot => ({
      ...snapshot.viewport, focused: snapshot.focused,
      benchmark: snapshot.benchmark ? {
        count: snapshot.benchmark.count, scrollTop: snapshot.benchmark.scrollTop,
        imageReady: snapshot.benchmark.imageReady, rows: snapshot.benchmark.rows,
      } : null,
    })).catch(() => null) : null;
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
    await navigate(previousUrl).catch(() => {});
  }
}
module.exports = { verifyLiveViewport };
