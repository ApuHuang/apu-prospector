"""從 VizieR 下載暗星雲目錄，轉成 APU Prospector 用的 data/catalogs.json。

用法：python tools/build_catalogs.py

每筆資料格式：[名稱, RA(J2000 度), Dec(J2000 度), 半徑(角分), 別名, 備註, Hα(R), 100µm(MJy/sr)]

Hα 與 100µm 是用 CDS hips2fits 抓一張全天 CAR 投影圖，再取目標範圍內的平均值。
"""
import csv
import hashlib
import io
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

import numpy as np

VIZIER = "https://vizier.cds.unistra.fr/viz-bin/asu-tsv"
MIN_DEC = -50.0  # 台灣看不到更南的天區，直接丟掉
OUT = Path(__file__).resolve().parent.parent / "data" / "catalogs.json"
HIPS2FITS = "https://alasky.cds.unistra.fr/hips-image-services/hips2fits"
ALLSKY_W, ALLSKY_H = 2400, 1200  # 0.15°/px，和 Finkbeiner（6′）、IRIS（4.3′）的解析度相當
CACHE = Path(__file__).resolve().parent / ".cache"  # 下載快取，刪掉就會重新抓


def download(url, timeout, validate):
    """CDS 偶爾會回空白或逾時，重試幾次；成功的結果存進快取。"""
    CACHE.mkdir(exist_ok=True)
    path = CACHE / hashlib.sha1(url.encode()).hexdigest()
    if path.exists():
        return path.read_bytes()
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                data = resp.read()
            if validate(data):
                path.write_bytes(data)
                return data
            last = "回傳內容不完整"
        except Exception as e:  # 網路或伺服器暫時錯誤
            last = e
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"下載失敗：{url}（{last}）")


def has_rows(data):
    lines = [ln for ln in data.decode("utf-8", errors="replace").splitlines() if ln and not ln.startswith("#")]
    return len(lines) > 3


def fetch(source, columns, coords=True, _retry=False):
    params = {
        "-source": source,
        "-out": ",".join(columns),
        "-oc.form": "d",
        "-out.max": "unlimited",
    }
    if coords:
        params["-out.add"] = "_RAJ,_DEJ"
    url = VIZIER + "?" + urllib.parse.urlencode(params)
    text = download(url, 180, has_rows).decode("utf-8", errors="replace")
    lines = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    # 表頭後面接單位列與分隔線
    header, rows = lines[0].split("\t"), lines[3:]
    out = []
    for row in csv.reader(io.StringIO("\n".join(rows)), delimiter="\t"):
        rec = {h: v.strip() for h, v in zip(header, row)}
        if coords and (not rec.get("_RAJ2000") or not rec.get("_DEJ2000")):
            continue
        out.append(rec)
    if not out:
        # 快取到的是壞資料：清掉重抓一次
        (CACHE / hashlib.sha1(url.encode()).hexdigest()).unlink(missing_ok=True)
        if not _retry:
            return fetch(source, columns, coords, _retry=True)
        raise RuntimeError(f"{source} 沒有資料")
    return out


def num(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def row(name, rec, radius_arcmin, alias="", note=""):
    ra, dec = float(rec["_RAJ2000"]), float(rec["_DEJ2000"])
    if dec < MIN_DEC:
        return None
    r = round(max(radius_arcmin or 0.5, 0.5), 2)
    return [name, round(ra, 4), round(dec, 4), r, alias, note]


def build_sh2():
    form = {"1": "圓形", "2": "橢圓", "3": "不規則"}
    struct = {"1": "無定形", "2": "明顯", "3": "絲狀"}
    out = []
    for r in fetch("VII/20", ["Sh2", "Diam", "Form", "Struct", "Bright"]):
        note = f"亮度 {r['Bright']}/3（3 最亮）・{form.get(r['Form'], '')}・{struct.get(r['Struct'], '')}"
        out.append(row(f"Sh2-{int(r['Sh2'])}", r, num(r["Diam"], 1) / 2, note=note))
    return out


def build_lbn():
    out = []
    for r in fetch("VII/9", ["Seq", "Diam1", "Diam2", "Bright", "Name"]):
        d1, d2 = num(r["Diam1"], 1), num(r["Diam2"], None) or num(r["Diam1"], 1)
        alias = r["Name"].replace("S ", "Sh2-") if r["Name"].startswith("S ") else r["Name"]
        out.append(row(f"LBN {int(r['Seq'])}", r, math.sqrt(d1 * d2) / 2, alias,
                       f"亮度 {r['Bright']}/6（1 最亮）"))
    return out


def build_ldn():
    out = []
    for r in fetch("VII/7A", ["LDN", "Area", "Opacity", "Barn"]):
        if not r["LDN"]:
            continue
        area = num(r["Area"], 0.0003)
        radius = math.sqrt(area / math.pi) * 60
        alias = f"B {r['Barn']}" if r["Barn"] else ""
        out.append(row(f"LDN {int(r['LDN'])}", r, radius, alias,
                       f"不透明度 {r['Opacity']}/6（6 最暗）"))
    return out


def build_vdb():
    out = []
    for r in fetch("VII/21", ["VdB", "HD", "Type", "SurfBr", "BRadMax"]):
        alias = f"HD {r['HD']}" if r["HD"] else ""
        out.append(row(f"vdB {int(r['VdB'])}", r, num(r["BRadMax"], 1), alias,
                       f"反射星雲・類型 {r['Type']}・表面亮度 {r['SurfBr']}"))
    return out


def build_barnard():
    out = []
    for r in fetch("VII/220A", ["Barn", "Diam"]):
        out.append(row(f"B {r['Barn'].strip()}", r, num(r["Diam"], 2) / 2, note="暗星雲"))
    return out


def build_ced():
    out = []
    for r in fetch("VII/231", ["Ced", "m_Ced", "Name", "Dim1", "Dim2"]):
        d1 = num(r["Dim1"], 2)
        d2 = num(r["Dim2"], None) or d1
        out.append(row(f"Ced {int(r['Ced'])}{r['m_Ced']}", r, math.sqrt(d1 * d2) / 2,
                       r["Name"], "亮瀰漫星雲"))
    return out


def build_rcw():
    out = []
    for r in fetch("VII/216", ["RCW", "MajAxis", "MinAxis", "IDs"]):
        a = num(r["MajAxis"], 2)
        b = num(r["MinAxis"], None) or a
        out.append(row(f"RCW {int(r['RCW'])}", r, math.sqrt(a * b) / 2, r["IDs"], "Hα 發射區"))
    return out


def build_wise():
    cls = {"K": "已知 HII 區", "G": "HII 區群", "C": "候選 HII 區", "Q": "無電波候選"}
    out = []
    for r in fetch("J/ApJS/212/1/wisecat", ["WISE", "Cl", "Rad", "HIIName"]):
        out.append(row(f"WISE {r['WISE']}", r, num(r["Rad"], 30) / 60, r["HIIName"],
                       cls.get(r["Cl"], r["Cl"])))
    return out


def build_pne():
    sizes = {}
    for r in fetch("V/84/diam", ["PNG", "oDiam"], coords=False):
        d = num(r.get("oDiam"))
        if d:
            sizes[r["PNG"]] = max(d, sizes.get(r["PNG"], 0))
    out = []
    for r in fetch("V/84/main", ["PNG", "Name", "Idents"]):
        d = sizes.get(r["PNG"])
        if not d or d < 20:  # 太小的行星狀星雲對短焦沒有意義
            continue
        tidy = lambda t: " ".join(t.replace("- ", "-").split())
        alias = ", ".join(tidy(x) for x in r["Idents"].split(",")[:3] if x.strip())
        out.append(row(tidy(r["Name"]), r, d / 120, alias, f"PN G{r['PNG']}・直徑 {d:.0f}\""))
    return out


class AllSky:
    """hips2fits 全天 CAR 圖，用來量每個目標範圍內的平均值。"""

    def __init__(self, hips, valid_min=None):
        params = {
            "hips": hips, "width": ALLSKY_W, "height": ALLSKY_H, "fov": 360, "projection": "CAR",
            "ra": 180, "dec": 0, "coordsys": "icrs", "format": "fits",
        }
        url = HIPS2FITS + "?" + urllib.parse.urlencode(params)
        t0 = time.time()
        raw = download(url, 900, lambda d: d.startswith(b"SIMPLE") and len(d) >= ALLSKY_W * ALLSKY_H * 4)
        print(f"  {hips}：{len(raw) / 1e6:.1f} MB，{time.time() - t0:.0f} 秒", file=sys.stderr)
        header, offset = {}, 0
        while True:
            block = raw[offset:offset + 2880].decode("latin1")
            offset += 2880
            cards = [block[i:i + 80] for i in range(0, 2880, 80)]
            for c in cards:
                if c[8:10] == "= ":
                    header[c[:8].strip()] = c[10:].split("/")[0].strip().strip("'").strip()
            if any(c.startswith("END") for c in cards):
                break
        nx, ny = int(header["NAXIS1"]), int(header["NAXIS2"])
        assert header["BITPIX"] == "-32", header["BITPIX"]
        self.data = np.frombuffer(raw[offset:offset + nx * ny * 4], dtype=">f4").astype(np.float64).reshape(ny, nx)
        if valid_min is not None:
            # IRIS 的無資料區是 -32768，內插後會污染旁邊一圈像素，一起排除
            bad = ~(self.data >= valid_min)
            grown = bad.copy()
            for axis in (0, 1):
                for shift in (-1, 1):
                    grown |= np.roll(bad, shift, axis=axis)
            self.data[grown] = np.nan
        self.nx, self.ny = nx, ny
        self.crpix1, self.crpix2 = float(header["CRPIX1"]), float(header["CRPIX2"])
        self.crval1, self.crval2 = float(header["CRVAL1"]), float(header["CRVAL2"])
        self.cdelt1, self.cdelt2 = float(header["CDELT1"]), float(header["CDELT2"])

    def mean(self, ra, dec, radius_deg):
        dra = (ra - self.crval1 + 180) % 360 - 180
        i0 = self.crpix1 - 1 + dra / self.cdelt1
        j0 = self.crpix2 - 1 + (dec - self.crval2) / self.cdelt2
        ri = max(radius_deg / abs(self.cdelt1) / max(math.cos(math.radians(dec)), 0.05), 0.5)
        rj = max(radius_deg / abs(self.cdelt2), 0.5)
        jj = np.arange(max(0, int(j0 - rj)), min(self.ny, int(j0 + rj) + 2))
        ii = np.arange(int(i0 - ri), int(i0 + ri) + 2)
        if len(jj) == 0:
            return None
        sub = self.data[np.ix_(jj, ii % self.nx)]
        mask = ((ii[None, :] - i0) / ri) ** 2 + ((jj[:, None] - j0) / rj) ** 2 <= 1.0
        vals = sub[mask] if mask.any() else sub.ravel()
        vals = vals[np.isfinite(vals)]
        return round(float(vals.mean()), 1) if vals.size else None


CATALOGS = [
    ("sh2", "Sharpless (Sh2)", "VII/20", "#ff6b6b", build_sh2),
    ("lbn", "Lynds 亮星雲 (LBN)", "VII/9", "#ffa94d", build_lbn),
    ("ced", "Cederblad (Ced)", "VII/231", "#ffd43b", build_ced),
    ("rcw", "RCW", "VII/216", "#f783ac", build_rcw),
    ("wise", "WISE HII 區", "J/ApJS/212/1", "#e599f7", build_wise),
    ("vdb", "van den Bergh 反射 (vdB)", "VII/21", "#74c0fc", build_vdb),
    ("ldn", "Lynds 暗星雲 (LDN)", "VII/7A", "#a9e34b", build_ldn),
    ("barnard", "Barnard 暗星雲 (B)", "VII/220A", "#69db7c", build_barnard),
    ("pne", "行星狀星雲 (≥20\")", "V/84", "#63e6be", build_pne),
]


def main():
    print("下載全天 Hα 與 100µm 圖…", file=sys.stderr)
    halpha = AllSky("CDS/P/Finkbeiner")
    dust = AllSky("ov-gso/P/IRIS/4", valid_min=-10)
    result = {"generated": date.today().isoformat(), "catalogs": {}}
    for key, label, src, color, fn in CATALOGS:
        rows = [r for r in fn() if r]
        for r in rows:
            radius = r[3] / 60
            r.extend([halpha.mean(r[1], r[2], radius), dust.mean(r[1], r[2], radius)])
        print(f"{key:8s} {len(rows):5d} 筆", file=sys.stderr)
        result["catalogs"][key] = {"label": label, "source": f"VizieR {src}", "color": color, "rows": rows}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"寫入 {OUT}（{OUT.stat().st_size / 1024:.0f} KB）", file=sys.stderr)


if __name__ == "__main__":
    main()
