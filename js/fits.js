// 透過 CDS hips2fits 取得 HiPS 的 FITS 切圖，讀出真正的物理量（Rayleigh、MJy/sr…）。
// Aladin Lite 3.8 的 readPixel 在這裡拿不到值，所以改用伺服器端切圖。

const ENDPOINT = "https://alasky.cds.unistra.fr/hips-image-services/hips2fits";
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const cache = new Map();
const CACHE_MAX = 40;

export async function fetchCutout(hips, { ra, dec, fov, width, height, projection = "TAN" }, signal) {
  const params = new URLSearchParams({
    hips, ra: ra.toFixed(5), dec: dec.toFixed(5), fov: fov.toFixed(5),
    width: String(width), height: String(height), projection, coordsys: "icrs", format: "fits",
  });
  const url = `${ENDPOINT}?${params}`;
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`hips2fits HTTP ${res.status}`);
  const cut = parseFits(await res.arrayBuffer());
  cache.set(url, cut);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return cut;
}

export function parseFits(buf) {
  const bytes = new Uint8Array(buf);
  const header = {};
  let offset = 0;
  let done = false;
  while (!done && offset < bytes.length) {
    for (let i = 0; i < 36; i++) {
      const start = offset + i * 80;
      const card = String.fromCharCode(...bytes.subarray(start, start + 80));
      const key = card.slice(0, 8).trim();
      if (key === "END") {
        done = true;
        break;
      }
      if (card[8] !== "=") continue;
      let raw = card.slice(10).trim();
      if (raw.startsWith("'")) {
        header[key] = raw.slice(1, raw.indexOf("'", 1)).trim();
      } else {
        raw = raw.split("/")[0].trim();
        header[key] = raw === "T" ? true : raw === "F" ? false : Number(raw);
      }
    }
    offset += 2880;
  }
  const nx = header.NAXIS1, ny = header.NAXIS2, bitpix = header.BITPIX;
  const bscale = header.BSCALE ?? 1, bzero = header.BZERO ?? 0;
  const view = new DataView(buf, offset);
  const size = Math.abs(bitpix) / 8;
  const data = new Float64Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) {
    if ((k + 1) * size > view.byteLength) {
      data[k] = NaN;
      continue;
    }
    let v;
    switch (bitpix) {
      case -32: v = view.getFloat32(k * size); break;
      case -64: v = view.getFloat64(k * size); break;
      case 16: v = view.getInt16(k * size); break;
      case 32: v = view.getInt32(k * size); break;
      default: v = view.getUint8(k * size);
    }
    if (bitpix > 0 && header.BLANK !== undefined && v === header.BLANK) v = NaN;
    data[k] = v * bscale + bzero;
  }
  return { header, nx, ny, data, wcs: makeWcs(header) };
}

function makeWcs(h) {
  let cd;
  if (h.CD1_1 !== undefined) {
    cd = [[h.CD1_1, h.CD1_2 ?? 0], [h.CD2_1 ?? 0, h.CD2_2]];
  } else {
    const pc = [[h.PC1_1 ?? 1, h.PC1_2 ?? 0], [h.PC2_1 ?? 0, h.PC2_2 ?? 1]];
    cd = [[h.CDELT1 * pc[0][0], h.CDELT1 * pc[0][1]], [h.CDELT2 * pc[1][0], h.CDELT2 * pc[1][1]]];
  }
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  const inv = [[cd[1][1] / det, -cd[0][1] / det], [-cd[1][0] / det, cd[0][0] / det]];
  return {
    ra0: h.CRVAL1, dec0: h.CRVAL2, crpix1: h.CRPIX1, crpix2: h.CRPIX2,
    cd, inv, proj: String(h.CTYPE1 || "").slice(-3),
  };
}

// 天球 → 中間座標（度，往東為正）
function project(wcs, ra, dec) {
  const d = dec * D2R, d0 = wcs.dec0 * D2R, da = (ra - wcs.ra0) * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
  if (cosc <= 0) return null;
  let xi = Math.cos(d) * Math.sin(da);
  let eta = Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da);
  if (wcs.proj === "TAN") {
    xi /= cosc;
    eta /= cosc;
  }
  return [xi * R2D, eta * R2D];
}

// FITS 像素（0 起算，j 由下往上）
export function worldToPixel(cut, ra, dec) {
  const p = project(cut.wcs, ra, dec);
  if (!p) return null;
  const { inv, crpix1, crpix2 } = cut.wcs;
  return [crpix1 - 1 + inv[0][0] * p[0] + inv[0][1] * p[1], crpix2 - 1 + inv[1][0] * p[0] + inv[1][1] * p[1]];
}

export function sampleAt(cut, ra, dec) {
  const px = worldToPixel(cut, ra, dec);
  if (!px) return null;
  const i = Math.round(px[0]), j = Math.round(px[1]);
  if (i < 0 || j < 0 || i >= cut.nx || j >= cut.ny) return null;
  const v = cut.data[j * cut.nx + i];
  return Number.isFinite(v) ? v : null;
}

// 每個像素在切平面上的位移（度），切圖中心就是切平面中心
export function pixelOffsets(cut) {
  const { cd, crpix1, crpix2 } = cut.wcs;
  const out = [];
  for (let j = 0; j < cut.ny; j++) {
    for (let i = 0; i < cut.nx; i++) {
      const dx = i + 1 - crpix1, dy = j + 1 - crpix2;
      out.push({ xi: cd[0][0] * dx + cd[0][1] * dy, eta: cd[1][0] * dx + cd[1][1] * dy, v: cut.data[j * cut.nx + i] });
    }
  }
  return out;
}
