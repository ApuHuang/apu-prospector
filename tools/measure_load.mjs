// 量 APU Prospector 開啟、拖曳、切換「IFN / 塵埃」時的載圖時間（docs/load-speed.md 的數字就是用這個量的）。
// 需要 Node 22 以上（內建 WebSocket）和 Google Chrome，不用裝任何套件。
//
//   node tools/measure_load.mjs http://localhost:8765/ --runs 4
//   node tools/measure_load.mjs https://apuhuang.github.io/apu-prospector/ --runs 3 --warm --out result.json
//   --quick 只量開啟，不做拖曳和 IFN
//
// 每一輪開一個全新設定檔的無頭 Chrome（冷快取）；--warm 時同一個設定檔先載一次、關掉 Chrome 再量（熱快取）。
// 時間都是毫秒，從 HTML 請求開始算：
//   aladinJs  aladin.js 下載完        firstTile  第一張底圖切圖下載完（不含 Allsky）
//   ui        「載入天圖中…」消失      view       起始畫面的切圖到齊（不含 Allsky；1.2 秒內沒有新的切圖請求）
// 拖曳：起始畫面到齊後連續移動 4 次，每次量從第一個新請求到切圖到齊。IFN：按預設組合後量 IRIS 切圖到齊。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME || {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
}[process.platform] || "google-chrome";
const argv = process.argv.slice(2);
const url = argv.find((a) => /^https?:/.test(a)) || "http://localhost:8765/";
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const runs = +opt("--runs", 1);
const warm = argv.includes("--warm");
const quick = argv.includes("--quick");
const outJson = opt("--out", null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isTile = (u) => /\/Norder\d+\/Dir\d+\/Npix\d+\./.test(u);
const isBase = (u) => /DSS|Mellinger|Pan-STARRS/.test(u);
const MOVES = [[333.0, 58.5, 0], [338.0, 60.0, 0], [338.0, 60.0, 6], [312.8, 44.5, 8]];

async function launch(profile, port) {
  const proc = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--window-size=1400,900", "--no-first-run", "--no-default-browser-check", "--enable-unsafe-swiftshader", "about:blank",
  ], { stdio: "ignore" });
  for (let i = 0; i < 150; i++) {
    try {
      return { proc, ws: (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl };
    } catch {
      await sleep(100);
    }
  }
  proc.kill();
  throw new Error(`Chrome 沒有啟動：${CHROME}`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  return {
    ready: new Promise((r) => { ws.onopen = r; }),
    send(method, params = {}, sessionId) {
      const m = { id: ++id, method, params, sessionId };
      ws.send(JSON.stringify(m));
      return new Promise((resolve, reject) => pending.set(m.id, { resolve, reject }));
    },
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

async function oneRun(profile, port, measure) {
  const { proc, ws } = await launch(profile, port);
  const c = connect(ws);
  await c.ready;
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (m, p) => c.send(m, p, sessionId);
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  const reqs = new Map();
  let t0 = null;
  c.on(({ method, params: p, sessionId: sid }) => {
    if (sid !== sessionId) return;
    const r = reqs.get(p.requestId);
    if (method === "Network.requestWillBeSent") {
      if (t0 === null && p.type === "Document") t0 = p.timestamp;
      reqs.set(p.requestId, { id: p.requestId, url: p.request.url, start: p.timestamp, startWall: Date.now() });
    } else if (!r) {
      // 不是這一頁的請求
    } else if (method === "Network.responseReceived") {
      r.cache = r.cache || p.response.fromDiskCache || p.response.fromMemoryCache;
      r.conn = p.response.connectionId;
    } else if (method === "Network.requestServedFromCache") {
      r.cache = true;
    } else if (method === "Network.loadingFinished") {
      Object.assign(r, { end: p.timestamp, bytes: p.encodedDataLength });
    } else if (method === "Network.loadingFailed") {
      Object.assign(r, { end: p.timestamp, failed: p.errorText });
    }
  });
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const rel = (ts) => (Number.isFinite(ts) ? Math.round((ts - t0) * 1000) : null);
  const lastEnd = (arr) => Math.max(...arr.filter((r) => r.end !== undefined).map((r) => r.end));
  const host = (r) => new URL(r.url).host.split(".")[0];

  // 等符合條件的請求全部結束，而且 quietMs 內沒有新的
  async function settle(filter, quietMs, maxMs) {
    const w0 = Date.now();
    while (Date.now() - w0 < maxMs) {
      await sleep(200);
      const all = [...reqs.values()].filter(filter);
      if (all.length && all.every((r) => r.end !== undefined) && Date.now() - Math.max(...all.map((r) => r.startWall)) >= quietMs) {
        return { all, timeout: false };
      }
    }
    return { all: [...reqs.values()].filter(filter), timeout: true };
  }

  await send("Page.navigate", { url });
  const wall0 = Date.now();
  let ui = null;
  while (Date.now() - wall0 < 60000) {
    if (await evalJs("!!document.querySelector('#loading.hidden')").catch(() => false)) {
      ui = Date.now() - wall0;
      break;
    }
    await sleep(40);
  }
  const view = await settle((r) => isTile(r.url), 1200, 40000);
  const list = () => [...reqs.values()].filter((r) => !/^(data|blob):/.test(r.url));
  const baseTiles = list().filter((r) => isTile(r.url) && isBase(r.url) && r.end && !r.failed);
  const result = {
    aladinJs: rel(list().find((r) => /aladin\.js/.test(r.url))?.end),
    firstTile: rel(Math.min(...baseTiles.map((r) => r.end))),
    ui,
    view: view.timeout ? null : rel(lastEnd(view.all)),
  };

  const steps = [];
  if (measure && await evalJs("!!window.prospector?.aladin")) {
    const step = async (name, action, filter, maxMs) => {
      const before = new Set(reqs.keys());
      const w = Date.now();
      await evalJs(action);
      await sleep(300);
      const st = await settle((r) => !before.has(r.id) && r.startWall >= w && filter(r), 1200, maxMs);
      const first = Math.min(...[...reqs.values()].filter((r) => !before.has(r.id)).map((r) => r.start));
      const ok = st.all.filter((r) => !r.failed);
      steps.push({
        name,
        ms: st.timeout || !ok.length ? null : Math.round((lastEnd(ok) - first) * 1000),
        tiles: st.all.length,
        kb: Math.round(st.all.reduce((a, r) => a + (r.bytes || 0), 0) / 1024),
        cached: st.all.filter((r) => r.cache).length,
        hosts: [...new Set(st.all.map(host))].join(","),
      });
      await sleep(300);
    };
    await sleep(500);
    for (const [ra, dec, fov] of MOVES) {
      await step(`${ra},${dec}${fov ? `/${fov}°` : ""}`,
        `(() => { const a = window.prospector.aladin; ${fov ? `a.setFoV(${fov});` : ""} a.gotoRaDec(${ra}, ${dec}); return 1 })()`,
        (r) => isTile(r.url), 30000);
    }
    await step("IFN",
      "(() => { [...document.querySelectorAll('#presets button')].find((b) => b.textContent.includes('IFN')).click(); return 1 })()",
      (r) => isTile(r.url) && /IRIS/.test(r.url), 40000);
  }
  result.mb = +(list().reduce((a, r) => a + (r.bytes || 0), 0) / 1048576).toFixed(1);
  const dump = list().map((r) => ({ url: r.url, start: rel(r.start), end: rel(r.end), bytes: r.bytes, cache: !!r.cache, conn: r.conn, failed: r.failed }));
  c.close();
  proc.kill();
  await sleep(600);
  return { result, steps, requests: dump };
}

const all = [];
let port = 9400 + Math.floor(Math.random() * 400);
for (let i = 0; i < runs; i++) {
  const profile = mkdtempSync(join(tmpdir(), "apu-measure-"));
  try {
    if (warm) await oneRun(profile, port++, false);
    const r = await oneRun(profile, port++, !quick);
    all.push(r);
    const steps = r.steps.map((s) => `${s.name} ${s.ms ?? "逾時"}ms/${s.tiles}張${s.cached ? `(快取${s.cached})` : ""}[${s.hosts}]`).join("  ");
    console.log(`#${i + 1} ${JSON.stringify(r.result)}  ${steps}`);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
if (outJson) writeFileSync(outJson, JSON.stringify(all, null, 1));
