// 天文計算：低精度公式（Meeus / Astronomical Almanac），精度約 0.1°，規劃拍攝夠用。
// 座標一律用 J2000 度，未做歲差修正（2026 年約差 0.35°）。

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const SYNODIC = 29.530588853;
const NEW_MOON_REF = 2451550.1; // 2000-01-06 新月

export const sinD = (d) => Math.sin(d * D2R);
export const cosD = (d) => Math.cos(d * D2R);
export const norm360 = (d) => ((d % 360) + 360) % 360;

export function julianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

export function gmst(jd) {
  const t = (jd - 2451545) / 36525;
  return norm360(280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t);
}

// 方位角由北往東量
export function altAz(ra, dec, lat, lst) {
  const ha = (lst - ra) * D2R;
  const d = dec * D2R;
  const p = lat * D2R;
  const sinAlt = Math.sin(d) * Math.sin(p) + Math.cos(d) * Math.cos(p) * Math.cos(ha);
  const alt = Math.asin(sinAlt);
  const az = Math.atan2(-Math.sin(ha) * Math.cos(d), Math.sin(d) * Math.cos(p) - Math.cos(d) * Math.sin(p) * Math.cos(ha));
  return { alt: alt * R2D, az: norm360(az * R2D) };
}

export function sunRaDec(jd) {
  const n = jd - 2451545;
  const L = 280.46 + 0.9856474 * n;
  const g = 357.528 + 0.9856003 * n;
  const lam = L + 1.915 * sinD(g) + 0.02 * sinD(2 * g);
  const eps = 23.439 - 0.0000004 * n;
  return {
    ra: norm360(Math.atan2(cosD(eps) * sinD(lam), cosD(lam)) * R2D),
    dec: Math.asin(sinD(eps) * sinD(lam)) * R2D,
  };
}

export function moonRaDec(jd) {
  const t = (jd - 2451545) / 36525;
  const lam = 218.32 + 481267.881 * t
    + 6.29 * sinD(135.0 + 477198.87 * t) - 1.27 * sinD(259.3 - 413335.36 * t)
    + 0.66 * sinD(235.7 + 890534.22 * t) + 0.21 * sinD(269.9 + 954397.74 * t)
    - 0.19 * sinD(357.5 + 35999.05 * t) - 0.11 * sinD(186.5 + 966404.03 * t);
  const bet = 5.13 * sinD(93.3 + 483202.02 * t) + 0.28 * sinD(228.2 + 960400.89 * t)
    - 0.28 * sinD(318.3 + 6003.15 * t) - 0.17 * sinD(217.6 - 407332.21 * t);
  const par = 0.9508 + 0.0518 * cosD(135.0 + 477198.87 * t) + 0.0095 * cosD(259.3 - 413335.36 * t)
    + 0.0078 * cosD(235.7 + 890534.22 * t) + 0.0028 * cosD(269.9 + 954397.74 * t);
  const eps = 23.439;
  const x = cosD(bet) * cosD(lam);
  const y = cosD(eps) * cosD(bet) * sinD(lam) - sinD(eps) * sinD(bet);
  const z = sinD(eps) * cosD(bet) * sinD(lam) + cosD(eps) * sinD(bet);
  return { ra: norm360(Math.atan2(y, x) * R2D), dec: Math.asin(z) * R2D, parallax: par };
}

export function separation(ra1, dec1, ra2, dec2) {
  const c = sinD(dec1) * sinD(dec2) + cosD(dec1) * cosD(dec2) * cosD(ra1 - ra2);
  return Math.acos(Math.min(1, Math.max(-1, c))) * R2D;
}

export function moonIllumination(jd) {
  const s = sunRaDec(jd);
  const m = moonRaDec(jd);
  const elong = separation(s.ra, s.dec, m.ra, m.dec);
  return (1 - cosD(elong)) / 2;
}

// 用平均朔望月估算，誤差約半天
export function daysFromFullMoon(jd) {
  const age = ((jd - NEW_MOON_REF) % SYNODIC + SYNODIC) % SYNODIC;
  return Math.abs(age - SYNODIC / 2);
}

export function equatorialToGalactic(ra, dec) {
  // J2000 → 銀道座標（IAU 1958 定義）
  const raGP = 192.85948, decGP = 27.12825, lNCP = 122.93192;
  const sinB = sinD(dec) * sinD(decGP) + cosD(dec) * cosD(decGP) * cosD(ra - raGP);
  const b = Math.asin(sinB) * R2D;
  const y = cosD(dec) * sinD(ra - raGP);
  const x = sinD(dec) * cosD(decGP) - cosD(dec) * sinD(decGP) * cosD(ra - raGP);
  return { l: norm360(lNCP - Math.atan2(y, x) * R2D), b };
}

// 依方位角回傳最低可拍仰角；from > to 的區段跨過正北（例如 315°→45°）
export function horizonLimit(az, horizon) {
  for (const seg of horizon.segments) {
    const inside = seg.from <= seg.to ? az >= seg.from && az < seg.to : az >= seg.from || az < seg.to;
    if (inside) return seg.minAlt;
  }
  return horizon.defaultAlt;
}

function horizonFloor(horizon) {
  return Math.min(horizon.defaultAlt, ...horizon.segments.map((s) => s.minAlt));
}

// 以「指定日期當地中午 → 隔天中午」為一晚，每 stepMin 分鐘取樣
export function buildNight(site, dateStr, stepMin = 5) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const noonUtc = Date.UTC(y, mo - 1, d, 12) - site.tzHours * 3600000;
  const samples = [];
  for (let i = 0; i <= (24 * 60) / stepMin; i++) {
    const date = new Date(noonUtc + i * stepMin * 60000);
    const jd = julianDate(date);
    const lst = norm360(gmst(jd) + site.lon);
    const sun = sunRaDec(jd);
    const sunAlt = altAz(sun.ra, sun.dec, site.lat, lst).alt;
    const moon = moonRaDec(jd);
    const mh = altAz(moon.ra, moon.dec, site.lat, lst);
    const moonAlt = mh.alt - moon.parallax * cosD(mh.alt); // 地平視差
    samples.push({ date, jd, lst, sunAlt, moonAlt, moon, dark: sunAlt < -18 });
  }
  const dark = samples.filter((s) => s.dark);
  const mid = dark.length ? dark[Math.floor(dark.length / 2)] : samples[samples.length >> 1];
  return {
    samples,
    stepMin,
    darkStart: dark.length ? dark[0].date : null,
    darkEnd: dark.length ? dark[dark.length - 1].date : null,
    darkHours: (dark.length * stepMin) / 60,
    moonIllum: moonIllumination(mid.jd),
    moonAtMidnight: mid.moon,
    daysFromFull: daysFromFullMoon(mid.jd),
  };
}

// 目標在這一晚的可拍時段（暗夜 + 過地平線遮蔽）
export function targetVisibility(ra, dec, site, night, horizon) {
  const track = [];
  let usable = 0, moonUp = 0;
  const windows = [];
  let cur = null;
  for (const s of night.samples) {
    const h = altAz(ra, dec, site.lat, s.lst);
    const ok = s.dark && h.alt >= horizonLimit(h.az, horizon);
    track.push({ date: s.date, alt: h.alt, az: h.az, ok });
    if (ok) {
      usable++;
      if (s.moonAlt > 0) moonUp++;
      if (!cur) cur = { start: s.date, end: s.date };
      cur.end = s.date;
    } else if (cur) {
      windows.push(cur);
      cur = null;
    }
  }
  if (cur) windows.push(cur);
  const m = night.moonAtMidnight;
  return {
    track,
    windows,
    hours: (usable * night.stepMin) / 60,
    moonUpHours: (moonUp * night.stepMin) / 60,
    moonSep: separation(ra, dec, m.ra, m.dec),
  };
}

// 大量目標只算時數，用在「探勘」清單
export function usableHoursFast(ra, dec, site, night, horizon) {
  const sp = sinD(site.lat), cp = cosD(site.lat);
  const sd = sinD(dec), cd = cosD(dec);
  const floor = horizonFloor(horizon);
  let n = 0;
  for (const s of night.samples) {
    if (!s.dark) continue;
    const ha = (s.lst - ra) * D2R;
    const ch = Math.cos(ha);
    const sinAlt = sd * sp + cd * cp * ch;
    const alt = Math.asin(sinAlt) * R2D;
    if (alt < floor) continue; // 低於所有遮蔽門檻，不用算方位角
    const az = norm360(Math.atan2(-Math.sin(ha) * cd, sd * cp - cd * sp * ch) * R2D);
    if (alt >= horizonLimit(az, horizon)) n++;
  }
  return (n * night.stepMin) / 60;
}

// 切平面（gnomonic）→ 天球。xi 往東、eta 往北，單位度
export function tangentToSky(ra0, dec0, xi, eta) {
  const x = xi * D2R, y = eta * D2R;
  const d0 = dec0 * D2R;
  const denom = Math.cos(d0) - y * Math.sin(d0);
  const ra = ra0 + Math.atan2(x, denom) * R2D;
  const dec = Math.atan2(Math.sin(d0) + y * Math.cos(d0), Math.sqrt(x * x + denom * denom)) * R2D;
  return [norm360(ra), dec];
}

// 畫面座標（x 往右、y 往上，度）經位置角旋轉到切平面。PA 由北往東量（NINA「Position Angle (East)」）
export function frameToTangent(x, y, pa) {
  const s = sinD(pa), c = cosD(pa);
  return { xi: -x * c + y * s, eta: x * s + y * c };
}

// 單一感光元件視野（度）
export function sensorFov(rig) {
  const w = 2 * Math.atan(rig.sensorW / (2 * rig.focal)) * R2D;
  const h = 2 * Math.atan(rig.sensorH / (2 * rig.focal)) * R2D;
  return { w, h };
}

// 馬賽克每一格的中心與四角
export function mosaicPanels(ra0, dec0, rig, pa, cols, rows, overlap) {
  const { w, h } = sensorFov(rig);
  const stepX = w * (1 - overlap), stepY = h * (1 - overlap);
  const panels = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = (c - (cols - 1) / 2) * stepX;
      const cy = ((rows - 1) / 2 - r) * stepY;
      const corners = [[-w / 2, h / 2], [w / 2, h / 2], [w / 2, -h / 2], [-w / 2, -h / 2]].map(([dx, dy]) => {
        const t = frameToTangent(cx + dx, cy + dy, pa);
        return tangentToSky(ra0, dec0, t.xi, t.eta);
      });
      const toSky = (fx, fy) => {
        const t = frameToTangent(fx, fy, pa);
        return tangentToSky(ra0, dec0, t.xi, t.eta);
      };
      // 上緣中央的小三角形，標示影像「上方」
      const a = Math.min(w, h) * 0.07;
      panels.push({
        row: r + 1,
        col: c + 1,
        center: toSky(cx, cy),
        corners,
        top: [toSky(cx - a, cy + h / 2), toSky(cx, cy + h / 2 + a), toSky(cx + a, cy + h / 2)],
      });
    }
  }
  return { panels, w, h, totalW: w + (cols - 1) * stepX, totalH: h + (rows - 1) * stepY };
}

export function formatRA(deg, sep = ":") {
  let s = norm360(deg) / 15 * 3600;
  s = Math.round(s * 10) / 10;
  if (s >= 86400) s -= 86400;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s - h * 3600 - m * 60;
  return `${String(h).padStart(2, "0")}${sep}${String(m).padStart(2, "0")}${sep}${sec.toFixed(1).padStart(4, "0")}`;
}

export function formatDec(deg, sep = ":") {
  const sign = deg < 0 ? "-" : "+";
  let s = Math.round(Math.abs(deg) * 3600);
  const d = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${sign}${String(d).padStart(2, "0")}${sep}${String(m).padStart(2, "0")}${sep}${String(sec).padStart(2, "0")}`;
}

export function formatTime(date, tzHours) {
  const d = new Date(date.getTime() + tzHours * 3600000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
