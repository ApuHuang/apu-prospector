import A from "https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js";
import * as astro from "./astro.js";
import { fetchCutout, sampleAt, pixelOffsets } from "./fits.js";
import { setControlsHidden } from "./panels.js";
import {
  DEFAULT_SITE, DEFAULT_HORIZON, BASE_SURVEYS, OVERLAYS, PRESETS, CAMERAS, DEFAULT_RIGS, DEFAULT_VIEW,
} from "./config.js";

const STORE_KEY = "apu-prospector-v1";
const LABEL_FOV = 12; // 視野小於這個角度才顯示目錄名稱
const MAX_SHAPES = 1500;

const $ = (s) => document.querySelector(s);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const fmt1 = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

// ---------- 狀態 ----------

function readState() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
  } catch {
    saved = {};
  }
  const preset = PRESETS.emission;
  const layers = {};
  for (const o of OVERLAYS) {
    const s = saved.layers?.[o.key];
    layers[o.key] = {
      enabled: s?.enabled ?? o.key in preset.layers,
      opacity: s?.opacity ?? o.opacity,
      min: s?.min ?? o.min,
      max: s?.max ?? o.max,
      stretch: s?.stretch ?? o.stretch,
      open: false,
    };
  }
  const rigs = Array.isArray(saved.rigs) && saved.rigs.length === DEFAULT_RIGS.length
    ? saved.rigs.map((r, i) => ({ ...DEFAULT_RIGS[i], ...r }))
    : structuredClone(DEFAULT_RIGS);
  return {
    base: saved.base || preset.base,
    layers,
    catalogs: saved.catalogs || Object.fromEntries(preset.catalogs.map((k) => [k, true])),
    minSize: saved.minSize ?? 0,
    showLabels: saved.showLabels ?? true,
    rigs,
    site: { ...DEFAULT_SITE, ...saved.site },
    horizon: saved.horizon || structuredClone(DEFAULT_HORIZON),
    targetName: saved.targetName || "Prospector",
    locked: !!saved.locked,
    frameCenter: saved.frameCenter || [DEFAULT_VIEW.ra, DEFAULT_VIEW.dec],
    view: saved.view || { ...DEFAULT_VIEW },
    signalRig: saved.signalRig || "A",
    prospectRig: saved.prospectRig || "A",
    redMode: !!saved.redMode,
  };
}

const state = readState();

const save = debounce(() => {
  const layers = Object.fromEntries(Object.entries(state.layers).map(([k, v]) => {
    const { open, ...rest } = v;
    return [k, rest];
  }));
  const data = {
    base: state.base, layers, catalogs: state.catalogs, minSize: state.minSize, showLabels: state.showLabels,
    rigs: state.rigs, site: state.site, horizon: state.horizon, targetName: state.targetName, locked: state.locked,
    frameCenter: state.frameCenter, view: state.view, signalRig: state.signalRig,
    prospectRig: state.prospectRig, redMode: state.redMode,
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    // 無痕模式等情況存不了，不影響使用
  }
}, 400);

let aladin;
const layerObjs = new Map(); // overlay key → Aladin image layer
const catObjs = {}; // catalog key → { catalog, shapes, rows }
let catalogData = null;
let searchIndex = new Map();
let fovOverlay;
let night = null;

// ---------- 啟動 ----------

async function main() {
  $("#site-name").textContent = state.site.name;
  document.body.classList.toggle("red-mode", state.redMode);
  try {
    await A.init;
  } catch (e) {
    $("#loading").textContent = `無法啟動天圖（需要支援 WebGL2 的瀏覽器）：${e}`;
    return;
  }
  aladin = A.aladin("#aladin", {
    survey: state.base,
    fov: state.view.fov,
    cooFrame: "ICRS",
    showReticle: false,
    showLayersControl: false,
    showFullscreenControl: false,
    showProjectionControl: false,
    showCooGridControl: true,
    showSimbadPointerControl: true,
    showContextMenu: true,
    showFrame: false,
    backgroundColor: "rgb(11, 14, 20)",
  });
  aladin.addColormap("prospector-ha", ["#000000", "#2a0000", "#7a0a00", "#d42a10", "#ff7a50", "#ffd8c4"]);
  aladin.addColormap("prospector-dust", ["#000000", "#0b1a2e", "#1f4a7a", "#4f8fc0", "#a8d4f0", "#ffffff"]);
  aladin.gotoRaDec(state.view.ra, state.view.dec);
  window.prospector = { aladin, state, layerObjs }; // 方便在主控台除錯

  for (const o of OVERLAYS) applyOverlay(o.key);

  try {
    const res = await fetch("data/catalogs.json");
    catalogData = await res.json();
    buildCatalogs();
  } catch (e) {
    $("#search-msg").textContent = `目錄載入失敗：${e}`;
    $("#search-msg").classList.add("err");
  }

  fovOverlay = A.graphicOverlay({ name: "構圖框", lineWidth: 2 });
  aladin.addOverlay(fovOverlay);

  aladin.on("positionChanged", onViewChange);
  aladin.on("zoomChanged", onViewChange);
  aladin.on("resizeChanged", scheduleHeavy); // 藏起控制區、轉向後，讀值用的切圖要重抓
  aladin.on("mouseMove", onMouseMove);
  aladin.on("objectClicked", onObjectClicked);

  buildLayerUI();
  buildCatalogUI();
  buildRigUI();
  buildVisibilityUI();
  buildProspectUI();
  wireMisc();

  if (state.locked) $("#lock-frame").checked = true;
  else state.frameCenter = aladin.getRaDec();
  drawFrames();
  updateCenterBox();
  refreshHeavy();
  $("#loading").classList.add("hidden");
}

// ---------- 圖層 ----------

function overlayDef(key) {
  return OVERLAYS.find((o) => o.key === key);
}

function applyOverlay(key) {
  const o = overlayDef(key);
  const st = state.layers[key];
  let layer = layerObjs.get(key);
  if (!st.enabled) {
    if (layer) {
      aladin.removeImageLayer(key);
      layerObjs.delete(key);
    }
    return;
  }
  if (!layer) {
    const hips = A.HiPS(o.hips, {
      name: o.label,
      imgFormat: o.fmt,
      colormap: o.cmap,
      stretch: st.stretch,
      minCut: st.min,
      maxCut: st.max,
      opacity: st.opacity,
      additive: true,
    });
    layer = aladin.setOverlayImageLayer(hips, key);
    layerObjs.set(key, layer);
  } else {
    layer.setOpacity(st.opacity);
    layer.setCuts(st.min, st.max);
    layer.setColormap(o.cmap, { stretch: st.stretch });
  }
}

function applyPreset(name) {
  const p = PRESETS[name];
  state.base = p.base;
  aladin.setBaseImageLayer(p.base);
  for (const o of OVERLAYS) {
    const st = state.layers[o.key];
    st.enabled = o.key in p.layers;
    if (st.enabled) st.opacity = p.layers[o.key];
    applyOverlay(o.key);
  }
  for (const key of Object.keys(catObjs)) state.catalogs[key] = p.catalogs.includes(key);
  refreshCatalogVisibility();
  buildLayerUI();
  buildCatalogUI();
  save();
  refreshHeavy();
}

function buildLayerUI() {
  const presets = $("#presets");
  presets.replaceChildren(...Object.entries(PRESETS).map(([k, p]) =>
    el("button", { class: "small", onclick: () => applyPreset(k) }, p.label)));

  const base = $("#base-survey");
  base.replaceChildren(...BASE_SURVEYS.map((s) => el("option", { value: s.id, selected: s.id === state.base }, s.label)));
  base.onchange = () => {
    state.base = base.value;
    aladin.setBaseImageLayer(state.base);
    save();
  };

  const list = $("#overlay-list");
  list.replaceChildren();
  let group = null;
  for (const o of OVERLAYS) {
    if (o.group !== group) {
      group = o.group;
      list.append(el("div", { class: "overlay-group" }, group));
    }
    const st = state.layers[o.key];
    const row = el("div", { class: `overlay${st.open ? " open" : ""}` });
    const opacity = el("input", {
      type: "range", min: 0, max: 1, step: 0.05, value: st.opacity, title: "不透明度",
      oninput: () => {
        st.opacity = +opacity.value;
        if (st.enabled) layerObjs.get(o.key)?.setOpacity(st.opacity);
        save();
      },
    });
    const head = el("div", { class: "overlay-head" },
      el("label", {},
        el("input", {
          type: "checkbox", checked: st.enabled,
          onchange: (e) => {
            st.enabled = e.target.checked;
            applyOverlay(o.key);
            save();
            refreshHeavy();
          },
        }),
        o.label),
      opacity,
      el("button", {
        class: "ghost small", title: "調整", onclick: () => {
          st.open = !st.open;
          row.classList.toggle("open", st.open);
        },
      }, "⚙"));
    const num = (field) => el("input", {
      type: "number", step: "any", value: st[field],
      onchange: (e) => {
        st[field] = +e.target.value;
        applyOverlay(o.key);
        save();
      },
    });
    const detail = el("div", { class: "overlay-detail" },
      el("p", { class: "hint" }, o.note),
      el("div", { class: "row" },
        el("label", { class: "field" }, "拉伸",
          el("select", {
            onchange: (e) => {
              st.stretch = e.target.value;
              applyOverlay(o.key);
              save();
            },
          }, ...["linear", "sqrt", "log", "asinh", "pow2"].map((s) => el("option", { value: s, selected: s === st.stretch }, s)))),
        el("label", { class: "field" }, `下限${o.unit ? `（${o.unit}）` : ""}`, num("min")),
        el("label", { class: "field" }, `上限${o.unit ? `（${o.unit}）` : ""}`, num("max"))));
    row.append(head, detail);
    list.append(row);
  }
}

// FITS 圖層才讀得到物理量
function fitsLayers() {
  return OVERLAYS.filter((o) => o.fmt === "fits" && state.layers[o.key].enabled);
}

const shortLabel = (o) => o.label.split("（")[0];
const isValid = (o, v) => v !== null && Number.isFinite(v) && (o.validMin === undefined || v >= o.validMin);

// ---------- 目錄 ----------

function normalizeName(s) {
  return s.toLowerCase().replace(/[\s\-_]/g, "");
}

function buildCatalogs() {
  const aliases = [];
  for (const [key, c] of Object.entries(catalogData.catalogs)) {
    const catalog = A.catalog({
      name: c.label,
      color: c.color,
      sourceSize: 5,
      shape: "circle",
      displayLabel: true,
      labelColumn: "name",
      labelColor: c.color,
      labelFont: "11px sans-serif",
    });
    aladin.addCatalog(catalog);
    const shapes = A.graphicOverlay({ name: `${c.label} 範圍`, color: c.color, lineWidth: 1.2 });
    aladin.addOverlay(shapes);
    catObjs[key] = { catalog, shapes, rows: c.rows, def: c };
    for (const r of c.rows) {
      const hit = { key, row: r };
      const n = normalizeName(r[0]);
      if (!searchIndex.has(n)) searchIndex.set(n, hit);
      if (key === "wise") searchIndex.set(normalizeName(r[0].replace(/^WISE /, "")), hit);
      for (const a of String(r[4]).split(/[;,]/)) {
        const an = normalizeName(a);
        if (an.length >= 3 && /[a-z]/.test(an)) aliases.push([an, hit]);
      }
    }
  }
  // 別名放最後，避免蓋掉正式編號
  for (const [an, hit] of aliases) if (!searchIndex.has(an)) searchIndex.set(an, hit);
  refreshCatalogSources();
  refreshCatalogVisibility();
}

function rowPassesSize(r) {
  return r[3] * 2 >= state.minSize;
}

function rowToData(key, r) {
  return { name: r[0], ra: r[1], dec: r[2], r: r[3], alias: r[4], note: r[5], ha: r[6] ?? null, ir: r[7] ?? null, cat: key };
}

const fmtVal = (v) => (v === null || v === undefined ? "—" : fmt1(v));

function refreshCatalogSources() {
  for (const [key, c] of Object.entries(catObjs)) {
    c.catalog.removeAll();
    const sources = c.rows.filter(rowPassesSize).map((r) => A.source(r[1], r[2], rowToData(key, r)));
    c.catalog.addSources(sources);
  }
}

function refreshCatalogVisibility() {
  for (const [key, c] of Object.entries(catObjs)) {
    if (state.catalogs[key]) {
      c.catalog.show();
      c.shapes.show();
    } else {
      c.catalog.hide();
      c.shapes.hide();
    }
  }
  updateShapes();
}

// 只畫畫面內、夠大的範圍圈
function updateShapes() {
  if (!aladin || !catalogData) return;
  const [cra, cdec] = aladin.getRaDec();
  const [fx, fy] = aladin.getFov();
  const radius = Math.hypot(fx, fy) / 2;
  const pxPerDeg = $("#aladin").clientWidth / fx;
  const showLabels = state.showLabels && Math.min(fx, fy) < LABEL_FOV;
  for (const [key, c] of Object.entries(catObjs)) {
    c.shapes.removeAll();
    c.catalog.displayLabel = showLabels;
    c.catalog.reportChange?.();
    if (!state.catalogs[key]) continue;
    const shapes = [];
    for (const r of c.rows) {
      const rDeg = r[3] / 60;
      if (rDeg * pxPerDeg < 4 || !rowPassesSize(r)) continue;
      if (astro.separation(cra, cdec, r[1], r[2]) > radius + rDeg) continue;
      shapes.push(A.circle(r[1], r[2], rDeg, { color: c.def.color, lineWidth: 1.2 }));
      if (shapes.length >= MAX_SHAPES) break;
    }
    if (typeof c.shapes.addFootprints === "function") c.shapes.addFootprints(shapes);
    else shapes.forEach((s) => c.shapes.add(s));
  }
}

function buildCatalogUI() {
  const list = $("#catalog-list");
  if (!catalogData) return;
  list.replaceChildren(...Object.entries(catalogData.catalogs).map(([key, c]) =>
    el("label", { title: c.source },
      el("input", {
        type: "checkbox", checked: !!state.catalogs[key],
        onchange: (e) => {
          state.catalogs[key] = e.target.checked;
          refreshCatalogVisibility();
          save();
        },
      }),
      el("span", { class: "swatch", style: `background:${c.color}` }),
      c.label,
      el("span", { class: "count" }, c.rows.length))));
  const minSize = $("#min-size");
  minSize.value = state.minSize;
  $("#min-size-val").textContent = `${state.minSize}′`;
  minSize.oninput = () => {
    $("#min-size-val").textContent = `${minSize.value}′`;
  };
  minSize.onchange = () => {
    state.minSize = +minSize.value;
    refreshCatalogSources();
    updateShapes();
    save();
  };
  const labels = $("#show-labels");
  labels.checked = state.showLabels;
  labels.onchange = () => {
    state.showLabels = labels.checked;
    updateShapes();
    save();
  };
}

let lastClick = 0;
function onObjectClicked(obj) {
  if (!obj || !obj.data || !obj.data.cat) return;
  const now = performance.now();
  if (now - lastClick < 80) return; // 同一次點擊可能回報多個重疊目標
  lastClick = now;
  showInfo(obj.data);
}

function showInfo(d) {
  const info = $("#info");
  const rig = state.rigs.find((r) => r.id === state.prospectRig) || state.rigs[0];
  const { w, h } = astro.sensorFov(rig);
  const diam = d.r * 2;
  const ratio = diam / (Math.min(w, h) * 60);
  const gal = astro.equatorialToGalactic(d.ra, d.dec);
  const hours = night ? astro.usableHoursFast(d.ra, d.dec, state.site, night, state.horizon) : null;
  info.replaceChildren(...[
    el("button", { class: "ghost small close", onclick: () => info.classList.add("hidden") }, "✕"),
    el("h3", {}, d.name),
    d.alias ? el("p", {}, `別名：${d.alias}`) : null,
    el("p", {}, d.note),
    el("p", {}, `大小：約 ${fmt1(diam)}′（佔 ${rig.name} 短邊 ${Math.round(ratio * 100)}%）`),
    el("p", {}, `RA ${astro.formatRA(d.ra)}・Dec ${astro.formatDec(d.dec)}・b ${gal.b.toFixed(1)}°`),
    d.ha !== null || d.ir !== null
      ? el("p", {}, `範圍內平均：Hα ${fmtVal(d.ha)} R・100µm ${fmtVal(d.ir)} MJy/sr`)
      : null,
    hours !== null ? el("p", {}, `今晚可拍 ${hours.toFixed(1)} 小時`) : null,
    el("div", { class: "row" },
      el("button", { onclick: () => frameObject(d) }, "以此為構圖中心")),
  ].filter(Boolean));
  info.classList.remove("hidden");
}

function frameObject(d) {
  state.targetName = d.name;
  $("#target-name").value = d.name;
  // 視野要同時裝得下目標和最大的構圖框
  const frames = state.rigs.filter((r) => r.enabled).map((r) => {
    const m = astro.mosaicPanels(0, 0, r, r.pa, r.cols, r.rows, r.overlap);
    return Math.hypot(m.totalW, m.totalH);
  });
  goTo(d.ra, d.dec, Math.max((d.r * 2) / 60 * 2.2, ...frames.map((f) => f * 1.25), 1));
  save();
}

// ---------- 構圖框 ----------

function frameCenter() {
  return state.frameCenter;
}

function drawFrames() {
  if (!fovOverlay) return;
  fovOverlay.removeAll();
  const [ra0, dec0] = frameCenter();
  for (const rig of state.rigs) {
    if (!rig.enabled) continue;
    const m = astro.mosaicPanels(ra0, dec0, rig, rig.pa, rig.cols, rig.rows, rig.overlap);
    for (const p of m.panels) {
      fovOverlay.add(A.polygon(p.corners, { color: rig.color, lineWidth: 2 }));
      fovOverlay.add(A.polygon(p.top, { color: rig.color, lineWidth: 2, fillColor: rig.color }));
    }
  }
}

function updateCenterBox() {
  const [ra, dec] = frameCenter();
  const g = astro.equatorialToGalactic(ra, dec);
  $("#center-coords").textContent = `${astro.formatRA(ra)}  ${astro.formatDec(dec)}`;
  $("#center-gal").textContent = `l ${g.l.toFixed(2)}°  b ${g.b.toFixed(2)}°`;
}

function goTo(ra, dec, fov) {
  if (fov) aladin.setFoV(fov);
  aladin.gotoRaDec(ra, dec);
  state.frameCenter = [ra, dec];
  drawFrames();
  updateCenterBox();
  refreshHeavy();
}

function onViewChange() {
  if (!state.locked) {
    state.frameCenter = aladin.getRaDec();
    drawFrames();
    updateCenterBox();
  }
  scheduleHeavy();
}

function refreshHeavy() {
  updateShapes();
  updateSignal();
  updateViewCutouts();
  updateVisibility();
  const [ra, dec] = aladin.getRaDec();
  state.view = { ra, dec, fov: aladin.getFov()[0] };
  save();
}

const scheduleHeavy = debounce(refreshHeavy, 300);

function rigStatsText(rig) {
  const { w, h } = astro.sensorFov(rig);
  const scale = rig.pixelUm ? (206.265 * rig.pixelUm) / rig.focal : null;
  const m = astro.mosaicPanels(0, 0, rig, 0, rig.cols, rig.rows, rig.overlap);
  let s = `視野 ${w.toFixed(2)}° × ${h.toFixed(2)}°（${(w * 60).toFixed(0)}′ × ${(h * 60).toFixed(0)}′）`;
  if (scale) s += `・${scale.toFixed(2)}″/px`;
  if (rig.cols * rig.rows > 1) s += `\n馬賽克 ${rig.cols}×${rig.rows}，總範圍 ${m.totalW.toFixed(2)}° × ${m.totalH.toFixed(2)}°`;
  return s;
}

function buildRigUI() {
  const list = $("#rig-list");
  list.replaceChildren();
  for (const rig of state.rigs) {
    const stats = el("div", { class: "rig-stats", style: "white-space:pre-line" }, rigStatsText(rig));
    const changed = () => {
      stats.textContent = rigStatsText(rig);
      drawFrames();
      scheduleHeavy();
      save();
    };
    const numField = (label, key, opts = {}) => {
      const scale = opts.scale || 1;
      const input = el("input", {
        type: "number", step: opts.step || "any", min: opts.min, max: opts.max,
        value: +(rig[key] * scale).toFixed(4),
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isFinite(v)) return;
          rig[key] = v / scale;
          if (opts.after) opts.after(v);
          changed();
        },
      });
      return { node: el("label", { class: `field ${opts.span || ""}` }, label, input), input };
    };
    const sensorW = numField("感光寬 mm", "sensorW", { step: 0.01 });
    const sensorH = numField("感光高 mm", "sensorH", { step: 0.01 });
    const pixel = numField("像素 µm", "pixelUm", { step: 0.01 });
    const camera = el("select", {
      onchange: (e) => {
        const c = CAMERAS.find((x) => x[0] === e.target.value);
        rig.camera = e.target.value;
        if (c) {
          [rig.sensorW, rig.sensorH, rig.pixelUm] = [c[1], c[2], c[5]];
          sensorW.input.value = c[1];
          sensorH.input.value = c[2];
          pixel.input.value = c[5];
        }
        changed();
      },
    }, el("option", { value: "custom" }, "自訂"), ...CAMERAS.map((c) => el("option", { value: c[0], selected: c[0] === rig.camera }, c[0])));
    const markCustom = () => {
      rig.camera = "custom";
      camera.value = "custom";
    };
    for (const f of [sensorW, sensorH, pixel]) f.input.addEventListener("input", markCustom);

    const paSlider = el("input", { type: "range", min: 0, max: 360, step: 1, value: rig.pa });
    const pa = numField("位置角 PA°", "pa", { step: 0.1, after: (v) => { paSlider.value = v; } });
    paSlider.oninput = () => {
      rig.pa = +paSlider.value;
      pa.input.value = rig.pa;
      changed();
    };
    const card = el("div", { class: "rig", style: `--rig-color:${rig.color}` },
      el("div", { class: "rig-head" },
        el("input", {
          type: "checkbox", checked: rig.enabled, title: "顯示這支鏡筒",
          onchange: (e) => {
            rig.enabled = e.target.checked;
            changed();
          },
        }),
        el("input", {
          type: "text", value: rig.name,
          oninput: (e) => {
            rig.name = e.target.value;
            fillRigSelects();
            save();
          },
        }),
        el("input", {
          type: "color", value: rig.color, title: "框線顏色",
          oninput: (e) => {
            rig.color = e.target.value;
            card.style.setProperty("--rig-color", rig.color);
            changed();
          },
        })),
      el("div", { class: "rig-grid" },
        numField("焦距 mm", "focal", { step: 1, min: 1 }).node,
        el("label", { class: "field span2" }, "相機", camera),
        sensorW.node, sensorH.node, pixel.node,
        pa.node,
        el("label", { class: "field span2" }, "旋轉", paSlider),
        numField("馬賽克 欄", "cols", { step: 1, min: 1, max: 10 }).node,
        numField("馬賽克 列", "rows", { step: 1, min: 1, max: 10 }).node,
        numField("重疊 %", "overlap", { step: 1, min: 0, max: 60, scale: 100 }).node),
      stats,
      el("div", { class: "rig-actions" },
        el("button", {
          class: "small", onclick: () => {
            rig.pa = (rig.pa + 90) % 360;
            pa.input.value = rig.pa;
            paSlider.value = rig.pa;
            changed();
          },
        }, "轉 90°"),
        el("button", { class: "small", onclick: () => exportNina(rig) }, "匯出 NINA CSV"),
        el("button", { class: "small", onclick: () => copyCoords(rig) }, "複製座標")));
    list.append(card);
  }
  fillRigSelects();
}

function fillRigSelects() {
  for (const [sel, key] of [["#signal-rig", "signalRig"], ["#prospect-rig", "prospectRig"]]) {
    const node = $(sel);
    node.replaceChildren(...state.rigs.map((r) => el("option", { value: r.id, selected: r.id === state[key] }, `${r.id}：${r.name}`)));
    node.onchange = () => {
      state[key] = node.value;
      if (key === "signalRig") updateSignal();
      save();
    };
  }
}

function panelRows(rig) {
  const [ra0, dec0] = frameCenter();
  const m = astro.mosaicPanels(ra0, dec0, rig, rig.pa, rig.cols, rig.rows, rig.overlap);
  const name = (state.targetName || "Target").trim();
  return m.panels.map((p, i) => ({
    pane: m.panels.length === 1 ? name : `${name} Panel ${i + 1}`,
    ra: p.center[0],
    dec: p.center[1],
    pa: astro.norm360(rig.pa),
    row: p.row,
    col: p.col,
  }));
}

const csvCell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

// NINA 簡易序列「匯入目標」吃 Telescopius 馬賽克格式：Pane, RA, DEC, Position Angle (East)
async function exportNina(rig) {
  const lines = ["Pane,RA,DEC,Position Angle (East)"];
  for (const p of panelRows(rig)) {
    lines.push([csvCell(p.pane), astro.formatRA(p.ra), astro.formatDec(p.dec), p.pa.toFixed(2)].join(","));
  }
  const text = lines.join("\r\n") + "\r\n";
  const safe = `${state.targetName}_${rig.name}`.replace(/[\\/:*?"<>|\s]+/g, "_");
  if (window.pywebview?.api?.save_text) {
    // 下載版的獨立視窗擋下載，改用系統的「另存新檔」
    const msg = $("#search-msg");
    try {
      const path = await window.pywebview.api.save_text(`${safe}.csv`, text);
      if (path) {
        msg.textContent = `已存到 ${path}`;
        msg.classList.remove("err");
      }
    } catch (e) {
      msg.textContent = `存檔失敗：${e.message || e}`;
      msg.classList.add("err");
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  el("a", { href: url, download: `${safe}.csv` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copyCoords(rig) {
  const text = panelRows(rig).map((p) =>
    `${p.pane}\tRA ${astro.formatRA(p.ra, " ")}\tDec ${astro.formatDec(p.dec, " ")}\tPA ${p.pa.toFixed(1)}°`).join("\n");
  const msg = $("#search-msg");
  try {
    await navigator.clipboard.writeText(text);
    msg.textContent = `已複製 ${rig.name} 的座標`;
    msg.classList.remove("err");
  } catch {
    msg.textContent = "瀏覽器不允許複製，請改用匯出 CSV";
    msg.classList.add("err");
  }
}

// ---------- 框內訊號 ----------

let signalAbort = null;

// 向 hips2fits 要一張涵蓋整個構圖框（含馬賽克）的方形切圖，只統計框內的像素
async function updateSignal() {
  const out = $("#signal-out");
  if (!aladin) return;
  if (!$("[data-panel=signal]").open) return; // 收起來時不抓切圖，省流量；展開時再算
  const rig = state.rigs.find((r) => r.id === state.signalRig);
  const layers = fitsLayers();
  if (!rig || !layers.length) {
    out.textContent = "請先開啟 Hα 或塵埃圖層。";
    return;
  }
  const [ra0, dec0] = frameCenter();
  const m = astro.mosaicPanels(ra0, dec0, rig, rig.pa, rig.cols, rig.rows, rig.overlap);
  const fov = Math.hypot(m.totalW, m.totalH) * 1.02;
  const N = 72;
  signalAbort?.abort();
  const ctrl = new AbortController();
  signalAbort = ctrl;
  out.textContent = "向 CDS hips2fits 取資料中…";
  const s = astro.sinD(rig.pa), c = astro.cosD(rig.pa);
  const rows = [];
  await Promise.all(layers.map(async (o, idx) => {
    try {
      const cut = await fetchCutout(o.hips, { ra: ra0, dec: dec0, fov, width: N, height: N }, ctrl.signal);
      const vals = [];
      for (const p of pixelOffsets(cut)) {
        // 切平面 → 構圖框座標（frameToTangent 的反轉）
        const x = -p.xi * c + p.eta * s;
        const y = p.xi * s + p.eta * c;
        if (Math.abs(x) <= m.totalW / 2 && Math.abs(y) <= m.totalH / 2 && isValid(o, p.v)) vals.push(p.v);
      }
      vals.sort((a, b) => a - b);
      if (!vals.length) {
        rows[idx] = [shortLabel(o), "無資料", "", "", ""];
        return;
      }
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const q = (pp) => vals[Math.min(vals.length - 1, Math.floor(pp * vals.length))];
      rows[idx] = [shortLabel(o), fmt1(mean), fmt1(q(0.5)), fmt1(q(0.9)), fmt1(vals[vals.length - 1])];
    } catch (e) {
      if (e.name !== "AbortError") rows[idx] = [shortLabel(o), "讀取失敗", "", "", ""];
    }
  }));
  if (ctrl.signal.aborted) return;
  out.replaceChildren(
    el("table", {},
      el("tr", {}, ...["圖層", "平均", "中位", "P90", "最高"].map((h) => el("th", {}, h))),
      ...rows.filter(Boolean).map((r) => el("tr", {}, ...r.map((cell) => el("td", {}, cell))))),
    el("p", { class: "hint", style: "margin-top:6px" },
      `單位：${layers.map((o) => `${shortLabel(o)} ${o.unit || "原始值"}`).join("、")}。` +
      `${rig.name} 框（${m.totalW.toFixed(2)}° × ${m.totalH.toFixed(2)}°），圖層本身解析度約 2–6′。`));
}

// ---------- 滑鼠讀值 ----------

// 每次畫面停下來，替每個 FITS 圖層抓一張涵蓋目前畫面的低解析切圖，滑鼠移動時直接查表
const viewCuts = new Map();
let viewAbort = null;

async function updateViewCutouts() {
  viewAbort?.abort();
  const ctrl = new AbortController();
  viewAbort = ctrl;
  viewCuts.clear();
  showCenterReadout();
  const [fx, fy] = aladin.getFov();
  if (fx > 120) return; // 視野太大時不讀值
  const [ra, dec] = aladin.getRaDec();
  const W = $("#aladin").clientWidth, H = $("#aladin").clientHeight;
  const width = 200, height = Math.max(40, Math.min(400, Math.round((200 * H) / W)));
  await Promise.all(fitsLayers().map(async (o) => {
    try {
      const cut = await fetchCutout(o.hips, { ra, dec, fov: Math.max(fx, fy), width, height, projection: "SIN" }, ctrl.signal);
      if (!ctrl.signal.aborted) viewCuts.set(o.key, cut);
    } catch {
      // 讀不到就不顯示該圖層的數值
    }
  }));
}

function readoutText(ra, dec) {
  const g = astro.equatorialToGalactic(ra, dec);
  const parts = [`${astro.formatRA(ra)} ${astro.formatDec(dec)}`, `b ${g.b.toFixed(1)}°`];
  for (const o of fitsLayers()) {
    const cut = viewCuts.get(o.key);
    const v = cut ? sampleAt(cut, ra, dec) : null;
    const text = !cut ? "…" : isValid(o, v) ? `${fmt1(v)} ${o.unit}` : "無資料";
    parts.push(`${shortLabel(o)} ${text}`);
  }
  return parts.join("・");
}

let pendingMove = null;
function onMouseMove(e) {
  pendingMove = e;
  if (onMouseMove.raf) return;
  onMouseMove.raf = requestAnimationFrame(() => {
    onMouseMove.raf = null;
    const ev = pendingMove;
    const valid = ev && ev.ra !== null && ev.ra !== undefined;
    $("#readout").textContent = valid ? readoutText(ev.ra, ev.dec) : "";
  });
}

// 手機、平板沒有游標，Aladin 拖曳中也不送 mouseMove，改成固定顯示構圖框中心的值
const NO_HOVER = matchMedia("(hover: none)").matches;

function showCenterReadout() {
  if (!NO_HOVER) return;
  const [ra, dec] = frameCenter();
  $("#readout").textContent = `框中心 ${readoutText(ra, dec)}`;
}

// 手機、平板：點一下天圖就藏起控制區（叫回來用右上角的按鈕）。
// 拖曳、雙指縮放、雙擊放大、長按選單、Aladin 自己的按鈕、點到目錄目標都不算。
function wireTapToHide() {
  if (!NO_HOVER) return;
  const box = $("#aladin");
  let start = null;
  let timer = null;
  box.addEventListener("pointerdown", (e) => {
    const second = timer !== null; // 上一下還在等：這是雙擊放大，兩下都不算
    clearTimeout(timer);
    timer = null;
    start = !second && e.isPrimary && e.target.tagName === "CANVAS" ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
  });
  box.addEventListener("pointerup", (e) => {
    const s = start;
    start = null;
    if (!s || !e.isPrimary) return;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10 || e.timeStamp - s.t > 500) return;
    const tapAt = performance.now();
    // 等 Aladin 處理完這一下：點到目標會更新 lastClick，那是要看目標資訊
    timer = setTimeout(() => {
      timer = null;
      if (lastClick < tapAt) setControlsHidden(true);
    }, 300);
  });
  box.addEventListener("pointercancel", () => {
    start = null;
  });
}

// ---------- 可見度 ----------

function defaultNightDate() {
  const now = new Date(Date.now() + state.site.tzHours * 3600000);
  if (now.getUTCHours() < 12) now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}

function buildVisibilityUI() {
  const date = $("#night-date");
  date.value = defaultNightDate();
  date.onchange = () => {
    computeNight(date.value);
    updateVisibility();
  };
  buildSiteUI();
  buildHorizonUI();
  computeNight(date.value);
}

// 地點、時區、滿月規則改了以後：重算整晚，清掉舊的探勘結果
function siteChanged() {
  save();
  renderSiteLine();
  computeNight($("#night-date").value);
  updateVisibility();
  $("#prospect-out").replaceChildren();
}

function renderSiteLine() {
  const s = state.site;
  const ns = s.lat >= 0 ? "N" : "S", ew = s.lon >= 0 ? "E" : "W";
  const tz = `UTC${s.tzHours >= 0 ? "+" : "−"}${Math.abs(s.tzHours)}`;
  $("#site-name").textContent = s.name || "未命名地點";
  $("#site-line").textContent =
    `${Math.abs(s.lat).toFixed(4)}°${ns}, ${Math.abs(s.lon).toFixed(4)}°${ew}・${tz}・` +
    (s.moonDays > 0 ? `滿月前後 ${s.moonDays} 天不拍` : "不檢查滿月");
}

function buildSiteUI() {
  const s = state.site;
  const msg = el("p", { class: "hint", style: "margin:6px 0 0" });
  const field = (label, key, attrs, span) => el("label", { class: `field ${span ? "span2" : ""}` }, label,
    el("input", {
      ...attrs,
      value: s[key],
      onchange: (e) => {
        const t = e.target;
        if (attrs.type === "number") {
          const v = parseFloat(t.value);
          if (!Number.isFinite(v) || v < +attrs.min || v > +attrs.max) {
            msg.textContent = `${label} 要在 ${attrs.min} 到 ${attrs.max} 之間`;
            t.value = s[key];
            return;
          }
          s[key] = v;
        } else {
          s[key] = t.value.trim();
        }
        msg.textContent = "";
        siteChanged();
      },
    }));
  const useHere = el("button", {
    class: "small",
    onclick: () => {
      if (!navigator.geolocation) {
        msg.textContent = "這個瀏覽器不支援定位，請手動輸入經緯度。";
        return;
      }
      msg.textContent = "定位中…";
      navigator.geolocation.getCurrentPosition((pos) => {
        s.lat = +pos.coords.latitude.toFixed(5);
        s.lon = +pos.coords.longitude.toFixed(5);
        s.tzHours = -new Date().getTimezoneOffset() / 60;
        s.name = "目前位置";
        msg.textContent = "已改用目前位置，時區取自電腦設定。";
        buildSiteUI();
        siteChanged();
      }, (err) => {
        msg.textContent = `定位失敗（${err.message || err.code}），請手動輸入經緯度，或確認 Windows 的定位服務已開啟。`;
      }, { timeout: 15000 });
    },
  }, "使用目前位置");
  const reset = el("button", {
    class: "small",
    onclick: () => {
      state.site = { ...DEFAULT_SITE };
      buildSiteUI();
      siteChanged();
    },
  }, "還原預設");
  $("#site-edit").replaceChildren(
    el("div", { class: "site-grid" },
      field("名稱", "name", { type: "text", maxLength: 40 }, true),
      field("緯度（北正南負）", "lat", { type: "number", step: "any", min: -90, max: 90 }),
      field("經度（東正西負）", "lon", { type: "number", step: "any", min: -180, max: 180 }),
      field("時區（UTC±小時）", "tzHours", { type: "number", step: 0.25, min: -12, max: 14 }),
      field("滿月前後幾天不拍", "moonDays", { type: "number", step: 1, min: 0, max: 14 })),
    el("p", { class: "hint", style: "margin:6px 0 0" }, "台灣是 +8；有日光節約時間的地區請填當晚實際使用的時區。滿月規則填 0 就不檢查。"),
    el("div", { class: "row", style: "margin-top:6px" }, useHere, reset),
    msg);
  renderSiteLine();
}

function buildHorizonUI() {
  const h = state.horizon;
  const changed = () => {
    save();
    updateVisibility();
    $("#prospect-out").replaceChildren();
  };
  const num = (obj, key, min, max) => el("input", {
    type: "number", min, max, step: 1, value: obj[key],
    onchange: (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) {
        e.target.value = obj[key];
        return;
      }
      obj[key] = Math.min(max, Math.max(min, v));
      e.target.value = obj[key];
      changed();
    },
  });
  const rows = h.segments.map((seg, i) => el("div", { class: "seg-row" },
    "方位", num(seg, "from", 0, 360), "→", num(seg, "to", 0, 360), "°",
    el("span", { class: "grow" }), "需 ≥", num(seg, "minAlt", 0, 90), "°",
    el("button", {
      class: "ghost small", title: "刪除這段",
      onclick: () => {
        h.segments.splice(i, 1);
        buildHorizonUI();
        changed();
      },
    }, "✕")));
  $("#horizon-edit").replaceChildren(
    ...rows,
    el("div", { class: "seg-row" }, "其他方向", el("span", { class: "grow" }), "需 ≥", num(h, "defaultAlt", 0, 90), "°",
      el("span", { style: "width:26px" })),
    el("div", { class: "row", style: "margin-top:4px" },
      el("button", {
        class: "small",
        onclick: () => {
          h.segments.push({ from: 0, to: 90, minAlt: h.defaultAlt });
          buildHorizonUI();
          changed();
        },
      }, "新增一段"),
      el("button", {
        class: "small",
        onclick: () => {
          state.horizon = structuredClone(DEFAULT_HORIZON);
          buildHorizonUI();
          changed();
        },
      }, "還原預設")));
}

function nearFullMoon() {
  return state.site.moonDays > 0 && night.daysFromFull <= state.site.moonDays;
}

function computeNight(dateStr) {
  night = astro.buildNight(state.site, dateStr);
  const tz = state.site.tzHours;
  const n = night;
  const badge = state.site.moonDays > 0
    ? el("span", { class: `badge ${nearFullMoon() ? "warn" : "ok"}` },
      nearFullMoon() ? `滿月前後 ${state.site.moonDays} 天內，依規則不拍` : "月相可拍")
    : null;
  $("#night-summary").replaceChildren(
    el("div", {}, n.darkStart
      ? `天文暗夜 ${astro.formatTime(n.darkStart, tz)}–${astro.formatTime(n.darkEnd, tz)}（${n.darkHours.toFixed(1)} 小時）`
      : "這天沒有天文暗夜（太陽整晚沒有低於 −18°）"),
    el("div", {}, `月照 ${Math.round(n.moonIllum * 100)}%・距滿月約 ${n.daysFromFull.toFixed(1)} 天 `, badge));
}

function updateVisibility() {
  if (!night) return;
  const [ra, dec] = frameCenter();
  const vis = astro.targetVisibility(ra, dec, state.site, night, state.horizon);
  renderChart(vis);
  const tz = state.site.tzHours;
  const win = vis.windows.map((w) => `${astro.formatTime(w.start, tz)}–${astro.formatTime(w.end, tz)}`).join("、");
  $("#vis-summary").replaceChildren(
    el("div", {}, el("b", {}, `構圖中心可拍 ${vis.hours.toFixed(1)} 小時`), win ? `：${win}` : "（今晚不會進入可拍範圍）"),
    el("div", {}, `月亮與目標相距 ${vis.moonSep.toFixed(0)}°，可拍時段中月亮在地平線上 ${vis.moonUpHours.toFixed(1)} 小時`));
}

function renderChart(vis) {
  const W = 340, H = 150, L = 24, R = 6, T = 8, B = 20;
  const samples = night.samples;
  const t0 = (night.darkStart || samples[0].date).getTime() - 5400000;
  const t1 = (night.darkEnd || samples[samples.length - 1].date).getTime() + 5400000;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (alt) => T + ((90 - Math.max(0, Math.min(90, alt))) / 90) * (H - T - B);
  const inRange = (d) => d.getTime() >= t0 && d.getTime() <= t1;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const add = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
    return n;
  };
  add("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "#0f1420" });
  if (night.darkStart) {
    add("rect", {
      x: x(night.darkStart.getTime()), y: T, width: x(night.darkEnd.getTime()) - x(night.darkStart.getTime()),
      height: H - T - B, fill: "#1b2540",
    });
  }
  for (const a of [30, 60]) {
    add("line", { x1: L, x2: W - R, y1: y(a), y2: y(a), stroke: "#273046", "stroke-width": 1 });
  }
  for (const a of [0, 30, 60, 90]) {
    const t = add("text", { x: L - 4, y: y(a) + 3, "text-anchor": "end", fill: "#8b95ab", "font-size": 9 });
    t.textContent = `${a}°`;
  }
  const tz = state.site.tzHours * 3600000;
  const firstHour = Math.ceil((t0 + tz) / 3600000) * 3600000 - tz;
  for (let t = firstHour; t <= t1; t += 3600000) {
    const hour = new Date(t + tz).getUTCHours();
    add("line", { x1: x(t), x2: x(t), y1: H - B, y2: H - B + 3, stroke: "#8b95ab" });
    if (hour % 2 === 0) {
      const lbl = add("text", { x: x(t), y: H - 6, "text-anchor": "middle", fill: "#8b95ab", "font-size": 9 });
      lbl.textContent = String(hour).padStart(2, "0");
    }
  }
  const pts = (arr, f) => arr.map((p) => `${x(p.date.getTime()).toFixed(1)},${y(f(p)).toFixed(1)}`).join(" ");
  const track = vis.track.filter((p) => inRange(p.date));
  const moon = samples.filter((s) => inRange(s.date));
  add("polyline", { points: pts(moon, (s) => s.moonAlt), fill: "none", stroke: "#c9c3a6", "stroke-width": 1, "stroke-dasharray": "2 3", opacity: 0.7 });
  add("polyline", {
    points: pts(track, (p) => astro.horizonLimit(p.az, state.horizon)),
    fill: "none", stroke: "#ffa94d", "stroke-width": 1, "stroke-dasharray": "4 3",
  });
  add("polyline", { points: pts(track, (p) => p.alt), fill: "none", stroke: "#5c6680", "stroke-width": 1.5 });
  let seg = [];
  const flush = () => {
    if (seg.length > 1) add("polyline", { points: pts(seg, (p) => p.alt), fill: "none", stroke: "#69db7c", "stroke-width": 3 });
    seg = [];
  };
  for (const p of track) {
    if (p.ok) seg.push(p);
    else flush();
  }
  flush();
  const legend = el("div", { class: "hint", style: "margin-top:2px" },
    "綠：可拍・灰：目標仰角・橙虛線：遮蔽門檻・淡黃：月亮・深藍底：天文暗夜");
  $("#vis-chart").replaceChildren(svg, legend);
}

// ---------- 探勘 ----------

function buildProspectUI() {
  $("#btn-prospect").onclick = runProspect;
}

function runProspect() {
  const out = $("#prospect-out");
  if (!catalogData || !night) return;
  const rig = state.rigs.find((r) => r.id === $("#prospect-rig").value) || state.rigs[0];
  const { w, h } = astro.sensorFov(rig);
  const m = astro.mosaicPanels(0, 0, rig, 0, rig.cols, rig.rows, rig.overlap);
  const shortSide = Math.min(m.totalW, m.totalH) * 60;
  const [fmin, fmax] = $("#prospect-fit").value.split("-").map(Number);
  const minHours = +$("#prospect-hours").value || 0;
  const minHa = +$("#prospect-ha").value || 0;
  const bSel = +$("#prospect-b").value;
  const sortBy = $("#prospect-sort").value;
  const hits = [];
  for (const [key, c] of Object.entries(catObjs)) {
    if (!state.catalogs[key]) continue;
    for (const r of c.rows) {
      if (!rowPassesSize(r)) continue;
      const ratio = (r[3] * 2) / shortSide;
      if (ratio < fmin || ratio > fmax) continue;
      if (minHa > 0 && !(r[6] >= minHa)) continue;
      if (bSel !== 0) {
        const b = Math.abs(astro.equatorialToGalactic(r[1], r[2]).b);
        if (bSel > 0 ? b < bSel : b > -bSel) continue;
      }
      const hours = astro.usableHoursFast(r[1], r[2], state.site, night, state.horizon);
      if (hours < minHours) continue;
      hits.push({ key, r, hours, ratio });
    }
  }
  const sortKey = {
    hours: (h) => h.hours,
    ha: (h) => h.r[6] ?? -1,
    ir: (h) => h.r[7] ?? -1,
    size: (h) => h.r[3],
  }[sortBy];
  hits.sort((a, b) => sortKey(b) - sortKey(a) || b.hours - a.hours);
  const top = hits.slice(0, 200);
  out.replaceChildren(
    el("p", { class: "hint" },
      `符合 ${hits.length} 個${hits.length > top.length ? `，列出前 ${top.length} 個` : ""}（${rig.name}，框短邊 ${shortSide.toFixed(0)}′，${state.site.name}）。`,
      nearFullMoon() ? el("span", { class: "badge warn" }, `今晚在滿月前後 ${state.site.moonDays} 天內`) : null),
    el("table", {},
      el("tr", {}, ...["目標", "時數", "大小", "Hα R", "100µm", "備註"].map((h) => el("th", {}, h))),
      ...top.map(({ key, r, hours, ratio }) => el("tr", {
        class: "hit",
        title: [r[4], r[5]].filter(Boolean).join("\n"),
        onclick: () => {
          const d = rowToData(key, r);
          frameObject(d);
          showInfo(d);
        },
      },
      el("td", {}, el("span", { class: "swatch", style: `background:${catObjs[key].def.color};display:inline-block;margin-right:4px` }), r[0]),
      el("td", {}, hours.toFixed(1)),
      el("td", {}, `${fmt1(r[3] * 2)}′`, el("br"), el("span", { class: "hint" }, `${Math.round(ratio * 100)}%`)),
      el("td", {}, fmtVal(r[6])),
      el("td", {}, fmtVal(r[7])),
      el("td", { class: "note-cell" }, r[4] || r[5])))));
}

// ---------- 搜尋與其他 ----------

function parseCoords(q) {
  const nums = q.match(/[+-]?\d+(?:\.\d+)?/g);
  if (!nums) return null;
  if (nums.length === 2 && /^[\s\d.+\-,]+$/.test(q)) {
    return [parseFloat(nums[0]), parseFloat(nums[1])];
  }
  if (nums.length === 6 && !/[a-z]{2,}/i.test(q.replace(/[hmsd]/gi, ""))) {
    const [h, m, s, d, dm, ds] = nums.map(parseFloat);
    const ra = (h + m / 60 + s / 3600) * 15;
    const sign = nums[3].startsWith("-") ? -1 : 1;
    const dec = sign * (Math.abs(d) + dm / 60 + ds / 3600);
    return [ra, dec];
  }
  return null;
}

function search(q) {
  const msg = $("#search-msg");
  msg.classList.remove("err");
  q = q.trim();
  if (!q) return;
  const coords = parseCoords(q);
  if (coords && coords[0] >= 0 && coords[0] < 360 && Math.abs(coords[1]) <= 90) {
    goTo(coords[0], coords[1]);
    msg.textContent = `已前往 ${astro.formatRA(coords[0])} ${astro.formatDec(coords[1])}`;
    return;
  }
  let n = normalizeName(q).replace(/^sh2?(?=\d)/, "sh2");
  const hit = searchIndex.get(n) || searchIndex.get(normalizeName(q));
  if (hit) {
    const d = rowToData(hit.key, hit.row);
    frameObject(d);
    showInfo(d);
    msg.textContent = `${d.name}（${catalogData.catalogs[hit.key].label}）`;
    return;
  }
  msg.textContent = "目錄裡沒有，改用 Sesame 名稱解析…";
  aladin.gotoObject(q, {
    success: () => {
      const [ra, dec] = aladin.getRaDec();
      state.targetName = q;
      $("#target-name").value = q;
      goTo(ra, dec);
      msg.textContent = `已前往 ${q}`;
    },
    error: () => {
      msg.textContent = `找不到「${q}」`;
      msg.classList.add("err");
    },
  });
}

function wireMisc() {
  wireTapToHide();
  $("#search").onsubmit = (e) => {
    e.preventDefault();
    search($("#search-input").value);
  };
  $("#target-name").value = state.targetName;
  $("#target-name").oninput = (e) => {
    state.targetName = e.target.value;
    save();
  };
  $("#lock-frame").onchange = (e) => {
    state.locked = e.target.checked;
    if (!state.locked) {
      aladin.gotoRaDec(...state.frameCenter);
    }
    save();
  };
  $("#btn-recenter").onclick = () => aladin.gotoRaDec(...state.frameCenter);
  $("[data-panel=signal]").addEventListener("toggle", (e) => {
    if (e.target.open) updateSignal();
  });
  $("#btn-red").onclick = () => {
    state.redMode = !state.redMode;
    document.body.classList.toggle("red-mode", state.redMode);
    save();
  };
}

main();
